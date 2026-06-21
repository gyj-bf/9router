/**
 * Unit tests for open-sse/services/sanitizer.js
 *
 * Tests cover:
 *  - Regex rule application (billing header, identity patterns, CLI references)
 *  - Exact string replacement (Claude Code mention, feedback line)
 *  - Multi-message sanitization (system, user, assistant messages)
 *  - Tool description sanitization
 *  - Array content blocks (text + image + tool_result)
 *  - Disabled rules are skipped
 *  - Provider filtering (rules with provider="all" vs specific)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ───────────────────────────────────────────────────────────────────

// vi.hoisted() ensures the mock fn is available inside the hoisted vi.mock factory
const mockGetSanitizerRulesByProvider = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db/repos/sanitizerRulesRepo.js", () => ({
  getSanitizerRulesByProvider: mockGetSanitizerRulesByProvider,
}));

vi.mock("@/sse/utils/logger.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

import {
  loadSanitizerCache,
  getSanitizerRules,
  applySanitizerFilters,
} from "open-sse/services/sanitizer.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Seed the sanitizer cache with test rules via the mocked DB repo */
async function seedRules(rules) {
  mockGetSanitizerRulesByProvider.mockResolvedValue(rules);
  await loadSanitizerCache();
}

/** Shorthand: create a regex rule */
function regexRule(pattern, replacement = "", opts = {}) {
  return {
    id: `r-${Math.random().toString(36).slice(2, 8)}`,
    type: "regex",
    pattern,
    replacement,
    enabled: true,
    provider: "all",
    ...opts,
  };
}

/** Shorthand: create an exact rule */
function exactRule(pattern, replacement = "", opts = {}) {
  return {
    id: `e-${Math.random().toString(36).slice(2, 8)}`,
    type: "exact",
    pattern,
    replacement,
    enabled: true,
    provider: "all",
    ...opts,
  };
}

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeEach(async () => {
  vi.clearAllMocks();
  // Reset cache to empty before each test
  mockGetSanitizerRulesByProvider.mockResolvedValue([]);
  await loadSanitizerCache();
});

// ─── Regex rule application ─────────────────────────────────────────────────

describe("regex rule application", () => {
  it("strips billing header patterns from message content", async () => {
    await seedRules([
      regexRule("x-billing-[^:]+:\\s*[^\\n]+", ""),
    ]);

    const body = {
      messages: [
        { role: "user", content: "Hello\nx-billing-quota: 50000\nPlease help." },
      ],
    };
    const result = applySanitizerFilters(body, "codebuddy-cn-api");
    expect(result.messages[0].content).toBe("Hello\n\nPlease help.");
  });

  it("replaces identity patterns (case-insensitive)", async () => {
    await seedRules([
      regexRule("Claude (?:Code|CLI)", "AI Assistant"),
    ]);

    const body = {
      messages: [
        { role: "user", content: "I am using Claude Code and claude cli together." },
      ],
    };
    const result = applySanitizerFilters(body, "codebuddy-cn-api");
    expect(result.messages[0].content).toBe(
      "I am using AI Assistant and AI Assistant together."
    );
  });

  it("strips CLI version references", async () => {
    await seedRules([
      regexRule("claude-code[/\\\\]v?\\d+\\.\\d+\\.\\d+", "code-tool"),
    ]);

    const body = {
      messages: [
        { role: "user", content: "Running claude-code/v2.109.0 on my machine" },
      ],
    };
    const result = applySanitizerFilters(body, "codebuddy-cn-api");
    expect(result.messages[0].content).toBe("Running code-tool on my machine");
  });

  it("applies multiple regex rules in order", async () => {
    await seedRules([
      regexRule("foo", "bar"),
      regexRule("bar", "baz"),
    ]);

    const body = {
      messages: [{ role: "user", content: "foo and bar" }],
    };
    const result = applySanitizerFilters(body, "codebuddy-cn-api");
    // "foo" → "bar", then "bar" → "baz" (both original and converted)
    expect(result.messages[0].content).toBe("baz and baz");
  });

  it("uses replacement string when provided", async () => {
    await seedRules([
      regexRule("secret-\\w+", "[REDACTED]"),
    ]);

    const body = {
      messages: [
        { role: "user", content: "My key is secret-abc123 please help" },
      ],
    };
    const result = applySanitizerFilters(body, "codebuddy-cn-api");
    expect(result.messages[0].content).toBe("My key is [REDACTED] please help");
  });
});

// ─── Exact string replacement ───────────────────────────────────────────────

describe("exact string replacement", () => {
  it("replaces exact Claude Code mentions", async () => {
    await seedRules([
      exactRule("Claude Code", "AI Tool"),
    ]);

    const body = {
      messages: [
        { role: "user", content: "I use Claude Code for development." },
      ],
    };
    const result = applySanitizerFilters(body, "codebuddy-cn-api");
    expect(result.messages[0].content).toBe("I use AI Tool for development.");
  });

  it("replaces all occurrences of exact pattern", async () => {
    await seedRules([
      exactRule("Claude Code", "AI Tool"),
    ]);

    const body = {
      messages: [
        { role: "user", content: "Claude Code is great. Claude Code helps me code." },
      ],
    };
    const result = applySanitizerFilters(body, "codebuddy-cn-api");
    expect(result.messages[0].content).toBe("AI Tool is great. AI Tool helps me code.");
  });

  it("replaces feedback line exactly", async () => {
    await seedRules([
      exactRule(
        "This response was generated by Claude Code CLI.",
        "This response was generated by an AI assistant."
      ),
    ]);

    const body = {
      messages: [
        {
          role: "assistant",
          content: "Here is the code.\n\nThis response was generated by Claude Code CLI.",
        },
      ],
    };
    const result = applySanitizerFilters(body, "codebuddy-cn-api");
    expect(result.messages[0].content).toContain("AI assistant.");
    expect(result.messages[0].content).not.toContain("Claude Code CLI");
  });

  it("removes text when replacement is empty", async () => {
    await seedRules([
      exactRule("REMOVE_ME", ""),
    ]);

    const body = {
      messages: [
        { role: "user", content: "Keep this REMOVE_ME and this" },
      ],
    };
    const result = applySanitizerFilters(body, "codebuddy-cn-api");
    expect(result.messages[0].content).toBe("Keep this  and this");
  });
});

// ─── Multi-message sanitization ──────────────────────────────────────────────

describe("multi-message sanitization", () => {
  it("sanitizes system, user, and assistant messages", async () => {
    await seedRules([
      exactRule("Claude Code", "AI Tool"),
      regexRule("secret-\\w+", "[REDACTED]"),
    ]);

    const body = {
      messages: [
        { role: "system", content: "You are Claude Code assistant." },
        { role: "user", content: "My key is secret-xyz123" },
        { role: "assistant", content: "Claude Code processed your request." },
      ],
    };
    const result = applySanitizerFilters(body, "codebuddy-cn-api");
    expect(result.messages[0].content).toBe("You are AI Tool assistant.");
    expect(result.messages[1].content).toBe("My key is [REDACTED]");
    expect(result.messages[2].content).toBe("AI Tool processed your request.");
  });

  it("handles empty messages array", async () => {
    await seedRules([exactRule("foo", "bar")]);
    const body = { messages: [] };
    const result = applySanitizerFilters(body, "codebuddy-cn-api");
    expect(result.messages).toEqual([]);
  });

  it("returns body unchanged when no messages property", async () => {
    await seedRules([exactRule("foo", "bar")]);
    const body = { model: "test" };
    const result = applySanitizerFilters(body, "codebuddy-cn-api");
    expect(result).toEqual({ model: "test" });
  });

  it("returns body when body is null/undefined", () => {
    expect(applySanitizerFilters(null, "codebuddy-cn-api")).toBeNull();
    expect(applySanitizerFilters(undefined, "codebuddy-cn-api")).toBeUndefined();
  });
});

// ─── Tool description sanitization ───────────────────────────────────────────

describe("tool description sanitization", () => {
  it("sanitizes tool function descriptions", async () => {
    await seedRules([
      exactRule("Claude Code", "AI Tool"),
    ]);

    const body = {
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          function: {
            name: "bash",
            description: "Run commands in Claude Code terminal",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
    };
    const result = applySanitizerFilters(body, "codebuddy-cn-api");
    expect(result.tools[0].function.description).toBe(
      "Run commands in AI Tool terminal"
    );
  });

  it("does not modify tool names or parameters", async () => {
    await seedRules([
      exactRule("bash", "shell"),
    ]);

    const body = {
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          function: {
            name: "bash",
            description: "Run bash commands",
            parameters: { type: "object", properties: { cmd: { type: "string" } } },
          },
        },
      ],
    };
    const result = applySanitizerFilters(body, "codebuddy-cn-api");
    // Only description is sanitized, not name or parameters
    expect(result.tools[0].function.name).toBe("bash");
    expect(result.tools[0].function.description).toBe("Run shell commands");
  });

  it("skips tools without descriptions", async () => {
    await seedRules([exactRule("foo", "bar")]);

    const body = {
      messages: [{ role: "user", content: "hi" }],
      tools: [{ function: { name: "fn", parameters: {} } }],
    };
    const result = applySanitizerFilters(body, "codebuddy-cn-api");
    expect(result.tools[0].function.description).toBeUndefined();
  });

  it("handles body with tools but no messages gracefully", async () => {
    await seedRules([exactRule("foo", "bar")]);
    const body = {
      tools: [
        { function: { name: "fn", description: "foo tool" } },
      ],
    };
    // No messages property → returns body unchanged (early return)
    const result = applySanitizerFilters(body, "codebuddy-cn-api");
    expect(result).toEqual(body);
  });
});

// ─── Array content blocks ───────────────────────────────────────────────────

describe("array content blocks", () => {
  it("sanitizes text blocks within array content", async () => {
    await seedRules([
      exactRule("Claude Code", "AI Tool"),
    ]);

    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Using Claude Code for this task" },
            { type: "image", source: { type: "url", url: "https://example.com/img.png" } },
          ],
        },
      ],
    };
    const result = applySanitizerFilters(body, "codebuddy-cn-api");
    expect(result.messages[0].content[0].text).toBe("Using AI Tool for this task");
    // Image block untouched
    expect(result.messages[0].content[1].type).toBe("image");
  });

  it("sanitizes nested text in tool_result blocks", async () => {
    await seedRules([
      exactRule("Claude Code", "AI Tool"),
    ]);

    const body = {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: "Output from Claude Code terminal",
            },
          ],
        },
      ],
    };
    const result = applySanitizerFilters(body, "codebuddy-cn-api");
    expect(result.messages[0].content[0].content).toBe("Output from AI Tool terminal");
  });

  it("sanitizes nested array content inside tool_result", async () => {
    await seedRules([
      exactRule("secret-key", "[REDACTED]"),
    ]);

    const body = {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: [
                { type: "text", text: "The secret-key is exposed" },
                { type: "image", source: { type: "url", url: "https://img.com/x.png" } },
              ],
            },
          ],
        },
      ],
    };
    const result = applySanitizerFilters(body, "codebuddy-cn-api");
    const toolResult = result.messages[0].content[0];
    expect(toolResult.content[0].text).toBe("The [REDACTED] is exposed");
    // Image untouched
    expect(toolResult.content[1].type).toBe("image");
  });

  it("handles mixed text + image + tool_result in one message", async () => {
    await seedRules([
      exactRule("Claude Code", "AI Tool"),
    ]);

    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Claude Code screenshot:" },
            { type: "image", source: { type: "url", url: "https://example.com/ss.png" } },
            { type: "tool_result", tool_use_id: "t1", content: "Claude Code output" },
          ],
        },
      ],
    };
    const result = applySanitizerFilters(body, "codebuddy-cn-api");
    const blocks = result.messages[0].content;
    expect(blocks[0].text).toBe("AI Tool screenshot:");
    expect(blocks[1].type).toBe("image"); // untouched
    expect(blocks[2].content).toBe("AI Tool output");
  });
});

// ─── Disabled rules are skipped ──────────────────────────────────────────────

describe("disabled rules", () => {
  it("skips disabled regex rules", async () => {
    await seedRules([
      regexRule("secret", "REDACTED", { enabled: false }),
    ]);

    const body = {
      messages: [{ role: "user", content: "my secret data" }],
    };
    const result = applySanitizerFilters(body, "codebuddy-cn-api");
    expect(result.messages[0].content).toBe("my secret data");
  });

  it("skips disabled exact rules", async () => {
    await seedRules([
      exactRule("Claude Code", "AI Tool", { enabled: false }),
    ]);

    const body = {
      messages: [{ role: "user", content: "Using Claude Code" }],
    };
    const result = applySanitizerFilters(body, "codebuddy-cn-api");
    expect(result.messages[0].content).toBe("Using Claude Code");
  });

  it("applies only enabled rules from a mixed set", async () => {
    await seedRules([
      exactRule("foo", "FOO", { enabled: true }),
      exactRule("bar", "BAR", { enabled: false }),
      regexRule("baz", "BAZ", { enabled: true }),
    ]);

    const body = {
      messages: [{ role: "user", content: "foo bar baz" }],
    };
    const result = applySanitizerFilters(body, "codebuddy-cn-api");
    expect(result.messages[0].content).toBe("FOO bar BAZ");
  });
});

// ─── Provider filtering ─────────────────────────────────────────────────────

describe("provider filtering", () => {
  it("applies rules with provider='all' to any provider", async () => {
    await seedRules([
      exactRule("secret", "REDACTED", { provider: "all" }),
    ]);

    const body = {
      messages: [{ role: "user", content: "my secret" }],
    };
    const result = applySanitizerFilters(body, "codebuddy-cn-api");
    expect(result.messages[0].content).toBe("my REDACTED");
  });

  it("applies rules matching the specific provider", async () => {
    await seedRules([
      exactRule("secret", "REDACTED", { provider: "codebuddy-cn-api" }),
    ]);

    const body = {
      messages: [{ role: "user", content: "my secret" }],
    };
    const result = applySanitizerFilters(body, "codebuddy-cn-api");
    expect(result.messages[0].content).toBe("my REDACTED");
  });

  it("skips rules for a different provider", async () => {
    await seedRules([
      exactRule("secret", "REDACTED", { provider: "other-provider" }),
    ]);

    const body = {
      messages: [{ role: "user", content: "my secret" }],
    };
    const result = applySanitizerFilters(body, "codebuddy-cn-api");
    expect(result.messages[0].content).toBe("my secret");
  });

  it("mixes provider='all' and provider-specific rules", async () => {
    await seedRules([
      exactRule("foo", "FOO", { provider: "all" }),
      exactRule("bar", "BAR", { provider: "codebuddy-cn-api" }),
      exactRule("baz", "BAZ", { provider: "other-provider" }),
    ]);

    const body = {
      messages: [{ role: "user", content: "foo bar baz" }],
    };
    const result = applySanitizerFilters(body, "codebuddy-cn-api");
    expect(result.messages[0].content).toBe("FOO BAR baz");
  });
});

// ─── Cache behavior ─────────────────────────────────────────────────────────

describe("cache behavior", () => {
  it("getSanitizerRules returns loaded cache", async () => {
    const rules = [exactRule("test", "TEST")];
    await seedRules(rules);
    const cached = getSanitizerRules();
    expect(cached).toHaveLength(1);
    expect(cached[0].pattern).toBe("test");
  });

  it("returns empty body unchanged when cache is empty", async () => {
    // Cache is empty (beforeEach resets it)
    const body = {
      messages: [{ role: "user", content: "Claude Code secret" }],
    };
    const result = applySanitizerFilters(body, "codebuddy-cn-api");
    expect(result.messages[0].content).toBe("Claude Code secret");
  });

  it("reloads cache when loadSanitizerCache is called again", async () => {
    await seedRules([exactRule("old", "OLD")]);
    let result = applySanitizerFilters(
      { messages: [{ role: "user", content: "old value" }] },
      "codebuddy-cn-api"
    );
    expect(result.messages[0].content).toBe("OLD value");

    // Reload with new rules
    await seedRules([exactRule("new", "NEW")]);
    result = applySanitizerFilters(
      { messages: [{ role: "user", content: "new value" }] },
      "codebuddy-cn-api"
    );
    expect(result.messages[0].content).toBe("NEW value");

    // Old rule no longer applies
    result = applySanitizerFilters(
      { messages: [{ role: "user", content: "old value" }] },
      "codebuddy-cn-api"
    );
    expect(result.messages[0].content).toBe("old value");
  });

  it("handles DB load failure gracefully", async () => {
    mockGetSanitizerRulesByProvider.mockRejectedValue(new Error("DB connection failed"));
    await loadSanitizerCache();
    // Cache should be empty (or unchanged), no crash
    const rules = getSanitizerRules();
    expect(Array.isArray(rules)).toBe(true);
  });
});

// ─── Edge cases ─────────────────────────────────────────────────────────────

describe("edge cases", () => {
  it("handles null/undefined content gracefully", async () => {
    await seedRules([exactRule("foo", "bar")]);

    const body = {
      messages: [
        { role: "user", content: null },
        { role: "assistant", content: undefined },
      ],
    };
    const result = applySanitizerFilters(body, "codebuddy-cn-api");
    expect(result.messages[0].content).toBeNull();
    expect(result.messages[1].content).toBeUndefined();
  });

  it("handles non-string, non-array content (number)", async () => {
    await seedRules([exactRule("foo", "bar")]);

    const body = {
      messages: [{ role: "user", content: 42 }],
    };
    const result = applySanitizerFilters(body, "codebuddy-cn-api");
    expect(result.messages[0].content).toBe(42);
  });

  it("handles empty string content", async () => {
    await seedRules([exactRule("foo", "bar")]);

    const body = {
      messages: [{ role: "user", content: "" }],
    };
    const result = applySanitizerFilters(body, "codebuddy-cn-api");
    expect(result.messages[0].content).toBe("");
  });

  it("handles text blocks with null text", async () => {
    await seedRules([exactRule("foo", "bar")]);

    const body = {
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: null }],
        },
      ],
    };
    const result = applySanitizerFilters(body, "codebuddy-cn-api");
    expect(result.messages[0].content[0].text).toBeNull();
  });
});
