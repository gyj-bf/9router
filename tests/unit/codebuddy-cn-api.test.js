/**
 * Unit tests for open-sse/executors/codebuddyCnApi.js
 *
 * Tests cover:
 *  - cleanMessages()          — Anthropic → OpenAI message conversion
 *  - sanitizeToolSchemas()    — $ref resolution, $defs stripping, defaults
 *  - injectReasoning()        — reasoning_effort injection / stripping
 *  - applyMaxTokensDefault()  — model max output defaults
 *  - buildHeaders()           — fresh UUIDs, User-Agent format
 *  - transformRequest()       — force stream, temperature default
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ───────────────────────────────────────────────────────────────────

// Mock DefaultExecutor so super.transformRequest is a passthrough
vi.mock("open-sse/executors/default.js", () => {
  class DefaultExecutor {
    constructor(provider) {
      this.provider = provider;
    }
    transformRequest(_model, body) {
      // Passthrough — return a shallow copy so the subclass can mutate safely
      return { ...body };
    }
  }
  return { DefaultExecutor };
});

// Mock proxyFetch to avoid proxy-agent imports
vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

// Mock logger
vi.mock("@/sse/utils/logger.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

import { CodebuddyCnApiExecutor } from "open-sse/executors/codebuddyCnApi.js";
import {
  buildDefaultHeaders,
  CODEBUDDY_CN_API_CHAT_URL,
  CODEBUDDY_CN_API_MODEL_CONFIG_MAP,
  NEUTRAL_SYSTEM_PROMPT,
  AGENT_PROMPT_LENGTH_THRESHOLD,
  DEFAULT_CLI_VERSION,
  DEFAULT_REASONING_EFFORT,
  getUserAgent,
} from "@/lib/codebuddy-cn-api/constants.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeExecutor() {
  return new CodebuddyCnApiExecutor();
}

/** Run transformRequest with sensible defaults, return the transformed body */
function transform(body, model = "glm-5.2", overrides = {}) {
  const ex = makeExecutor();
  return ex.transformRequest(model, body, true, { apiKey: "test-key" }, overrides);
}

// ─── buildHeaders ────────────────────────────────────────────────────────────

describe("buildHeaders", () => {
  it("returns correct User-Agent format", () => {
    const ex = makeExecutor();
    const headers = ex.buildHeaders({ apiKey: "my-key" });
    expect(headers["User-Agent"]).toBe(`CLI/${DEFAULT_CLI_VERSION} CodeBuddy/${DEFAULT_CLI_VERSION}`);
  });

  it("sets Bearer authorization from apiKey", () => {
    const ex = makeExecutor();
    const headers = ex.buildHeaders({ apiKey: "secret-123" });
    expect(headers["Authorization"]).toBe("Bearer secret-123");
  });

  it("falls back to accessToken when apiKey absent", () => {
    const ex = makeExecutor();
    const headers = ex.buildHeaders({ accessToken: "oauth-token" });
    expect(headers["Authorization"]).toBe("Bearer oauth-token");
  });

  it("generates fresh UUIDs per call (X-Conversation-ID, X-Request-ID)", () => {
    const ex = makeExecutor();
    const h1 = ex.buildHeaders({ apiKey: "k" });
    const h2 = ex.buildHeaders({ apiKey: "k" });
    expect(h1["X-Conversation-ID"]).not.toBe(h2["X-Conversation-ID"]);
    expect(h1["X-Request-ID"]).not.toBe(h2["X-Request-ID"]);
  });

  it("X-Request-ID has no dashes (32 hex chars)", () => {
    const ex = makeExecutor();
    const headers = ex.buildHeaders({ apiKey: "k" });
    expect(headers["X-Request-ID"]).toMatch(/^[0-9a-f]{32}$/);
  });

  it("includes required CodeBuddy headers", () => {
    const ex = makeExecutor();
    const headers = ex.buildHeaders({ apiKey: "k" });
    expect(headers["X-Product"]).toBe("SaaS");
    expect(headers["X-IDE-Type"]).toBe("CLI");
    expect(headers["X-IDE-Name"]).toBe("CLI");
    expect(headers["X-Domain"]).toBe("copilot.tencent.com");
    expect(headers["x-requested-with"]).toBe("XMLHttpRequest");
    expect(headers["x-codebuddy-request"]).toBe("1");
    expect(headers["Content-Type"]).toBe("application/json");
  });
});

// ─── buildUrl ────────────────────────────────────────────────────────────────

describe("buildUrl", () => {
  it("returns the CodeBuddy CN API chat URL", () => {
    const ex = makeExecutor();
    expect(ex.buildUrl()).toBe(CODEBUDDY_CN_API_CHAT_URL);
    expect(ex.buildUrl()).toBe("https://copilot.tencent.com/v2/chat/completions");
  });
});

// ─── cleanMessages (via transformRequest) ────────────────────────────────────

describe("cleanMessages — tool_use → tool_calls conversion", () => {
  it("converts Anthropic tool_use blocks to OpenAI tool_calls", () => {
    const body = {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me check that." },
            {
              type: "tool_use",
              id: "toolu_abc123",
              name: "read_file",
              input: { path: "/src/index.js" },
            },
          ],
        },
      ],
    };
    const result = transform(body);
    const msg = result.messages[0];
    expect(msg.content).toBe("Let me check that.");
    expect(msg.tool_calls).toHaveLength(1);
    expect(msg.tool_calls[0]).toEqual({
      id: "toolu_abc123",
      type: "function",
      function: {
        name: "read_file",
        arguments: JSON.stringify({ path: "/src/index.js" }),
      },
    });
  });

  it("sets content to null when only tool_use blocks (no text)", () => {
    const body = {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "t1", name: "bash", input: { cmd: "ls" } },
          ],
        },
      ],
    };
    const result = transform(body);
    expect(result.messages[0].content).toBeNull();
    expect(result.messages[0].tool_calls).toHaveLength(1);
  });

  it("handles multiple tool_use blocks in one message", () => {
    const body = {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "t1", name: "read", input: {} },
            { type: "tool_use", id: "t2", name: "write", input: { data: "x" } },
          ],
        },
      ],
    };
    const result = transform(body);
    expect(result.messages[0].tool_calls).toHaveLength(2);
    expect(result.messages[0].tool_calls[0].id).toBe("t1");
    expect(result.messages[0].tool_calls[1].id).toBe("t2");
  });
});

describe("cleanMessages — tool_result → tool role", () => {
  it("converts Anthropic tool_result to OpenAI tool role messages", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_abc123",
              content: "file contents here",
            },
          ],
        },
      ],
    };
    const result = transform(body);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toEqual({
      role: "tool",
      tool_call_id: "toolu_abc123",
      content: "file contents here",
    });
  });

  it("JSON-stringifies non-string tool_result content", () => {
    const nested = [{ type: "text", text: "nested output" }];
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: nested },
          ],
        },
      ],
    };
    const result = transform(body);
    expect(result.messages[0].content).toBe(JSON.stringify(nested));
  });

  it("emits one message per tool_result when multiple present", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "result1" },
            { type: "tool_result", tool_use_id: "t2", content: "result2" },
          ],
        },
      ],
    };
    const result = transform(body);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].role).toBe("tool");
    expect(result.messages[0].tool_call_id).toBe("t1");
    expect(result.messages[1].role).toBe("tool");
    expect(result.messages[1].tool_call_id).toBe("t2");
  });

  it("keeps non-tool_result blocks when mixed with tool_results", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "res" },
            { type: "text", text: "extra context" },
          ],
        },
      ],
    };
    const result = transform(body);
    // tool_result → tool message, plus the remaining text block
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].role).toBe("tool");
    expect(result.messages[1].role).toBe("user");
    expect(result.messages[1].content).toBe("extra context");
  });
});

describe("cleanMessages — image block conversion", () => {
  it("converts base64 image blocks to OpenAI image_url format", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What is this?" },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "iVBORw0KGgo=",
              },
            },
          ],
        },
      ],
    };
    const result = transform(body);
    const content = result.messages[0].content;
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: "text", text: "What is this?" });
    expect(content[1]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,iVBORw0KGgo=" },
    });
  });

  it("converts URL image blocks to OpenAI image_url format", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "url", url: "https://example.com/img.png" },
            },
          ],
        },
      ],
    };
    const result = transform(body);
    const content = result.messages[0].content;
    // Single-image array stays as array (not collapsed since it's image, not text)
    expect(content[0]).toEqual({
      type: "image_url",
      image_url: { url: "https://example.com/img.png" },
    });
  });
});

describe("cleanMessages — text-only array collapse", () => {
  it("collapses text-only content arrays to a single string", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Hello" },
            { type: "text", text: "World" },
          ],
        },
      ],
    };
    const result = transform(body);
    expect(result.messages[0].content).toBe("Hello\nWorld");
  });

  it("does not collapse arrays containing non-text blocks", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Look:" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/jpeg", data: "abc" },
            },
          ],
        },
      ],
    };
    const result = transform(body);
    expect(Array.isArray(result.messages[0].content)).toBe(true);
  });
});

describe("cleanMessages — agent prompt detection", () => {
  it("replaces system prompts exceeding length threshold with neutral prompt", () => {
    const longPrompt = "x".repeat(AGENT_PROMPT_LENGTH_THRESHOLD + 1);
    const body = {
      messages: [{ role: "system", content: longPrompt }],
    };
    const result = transform(body);
    expect(result.messages[0].content).toBe(NEUTRAL_SYSTEM_PROMPT);
  });

  it("replaces system prompts matching agent patterns (Claude CLI)", () => {
    const body = {
      messages: [
        { role: "system", content: "You are Claude, the official CLI agent for Anthropic." },
      ],
    };
    const result = transform(body);
    expect(result.messages[0].content).toBe(NEUTRAL_SYSTEM_PROMPT);
  });

  it("replaces system prompts matching 'you are cursor' pattern", () => {
    const body = {
      messages: [
        { role: "system", content: "You are Cursor, an AI coding assistant." },
      ],
    };
    const result = transform(body);
    expect(result.messages[0].content).toBe(NEUTRAL_SYSTEM_PROMPT);
  });

  it("replaces system prompts matching 'AI coding agent' pattern", () => {
    const body = {
      messages: [
        { role: "system", content: "You are an AI coding agent that helps users." },
      ],
    };
    const result = transform(body);
    expect(result.messages[0].content).toBe(NEUTRAL_SYSTEM_PROMPT);
  });

  it("replaces system prompts matching cc_entrypoint", () => {
    const body = {
      messages: [
        { role: "system", content: "cc_entrypoint: initialize the session" },
      ],
    };
    const result = transform(body);
    expect(result.messages[0].content).toBe(NEUTRAL_SYSTEM_PROMPT);
  });

  it("preserves short system prompts without agent patterns", () => {
    const body = {
      messages: [
        { role: "system", content: "Be concise and helpful." },
      ],
    };
    const result = transform(body);
    expect(result.messages[0].content).toBe("Be concise and helpful.");
  });

  it("does not modify non-system messages even if long", () => {
    const longUser = "x".repeat(AGENT_PROMPT_LENGTH_THRESHOLD + 1);
    const body = {
      messages: [{ role: "user", content: longUser }],
    };
    const result = transform(body);
    expect(result.messages[0].content).toBe(longUser);
  });
});

// ─── sanitizeToolSchemas (via transformRequest) ─────────────────────────────

describe("sanitizeToolSchemas — $ref resolution", () => {
  it("resolves $ref references using $defs", () => {
    const body = {
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          function: {
            name: "create_issue",
            parameters: {
              type: "object",
              $defs: {
                label: { type: "string", enum: ["bug", "feature"] },
              },
              properties: {
                title: { type: "string" },
                label: { $ref: "#/$defs/label" },
              },
            },
          },
        },
      ],
    };
    const result = transform(body);
    const params = result.tools[0].function.parameters;
    expect(params.properties.label).toEqual({ type: "string", enum: ["bug", "feature"] });
  });

  it("resolves $ref using definitions (alternate key)", () => {
    const body = {
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          function: {
            name: "test",
            parameters: {
              type: "object",
              definitions: {
                status: { type: "string" },
              },
              properties: {
                s: { $ref: "#/definitions/status" },
              },
            },
          },
        },
      ],
    };
    const result = transform(body);
    expect(result.tools[0].function.parameters.properties.s).toEqual({ type: "string" });
  });
});

describe("sanitizeToolSchemas — strip meta keys", () => {
  it("strips $schema, $id, $comment, $defs from output", () => {
    const body = {
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          function: {
            name: "fn",
            parameters: {
              $schema: "http://json-schema.org/draft-07/schema#",
              $id: "https://example.com/schema",
              $comment: "internal note",
              $defs: { foo: { type: "string" } },
              type: "object",
              properties: { name: { type: "string" } },
            },
          },
        },
      ],
    };
    const result = transform(body);
    const params = result.tools[0].function.parameters;
    expect(params.$schema).toBeUndefined();
    expect(params.$id).toBeUndefined();
    expect(params.$comment).toBeUndefined();
    expect(params.$defs).toBeUndefined();
    expect(params.type).toBe("object");
    expect(params.properties.name).toEqual({ type: "string" });
  });
});

describe("sanitizeToolSchemas — defaults", () => {
  it("ensures type: 'object' when missing", () => {
    const body = {
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          function: {
            name: "fn",
            parameters: {
              properties: { x: { type: "number" } },
            },
          },
        },
      ],
    };
    const result = transform(body);
    expect(result.tools[0].function.parameters.type).toBe("object");
  });

  it("ensures properties: {} when missing", () => {
    const body = {
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          function: {
            name: "fn",
            parameters: { type: "object" },
          },
        },
      ],
    };
    const result = transform(body);
    expect(result.tools[0].function.parameters.properties).toEqual({});
  });

  it("skips tools without function.parameters", () => {
    const body = {
      messages: [{ role: "user", content: "hi" }],
      tools: [{ function: { name: "fn" } }],
    };
    const result = transform(body);
    expect(result.tools[0].function.parameters).toBeUndefined();
  });
});

// ─── injectReasoning (via transformRequest) ──────────────────────────────────

describe("injectReasoning", () => {
  it("defaults reasoning_effort to 'high' when not specified by client", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    const result = transform(body);
    expect(result.reasoning_effort).toBe("high");
    expect(result.reasoning_summary).toBeUndefined();
  });

  it("preserves explicit reasoning_effort value", () => {
    const body = {
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "low",
    };
    const result = transform(body);
    expect(result.reasoning_effort).toBe("low");
    expect(result.reasoning_summary).toBeUndefined();
  });

  it("strips reasoning when effort is 'none'", () => {
    const body = {
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "none",
    };
    const result = transform(body);
    expect(result.reasoning_effort).toBeUndefined();
  });

  it("strips reasoning when effort is 'off'", () => {
    const body = {
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "off",
    };
    const result = transform(body);
    expect(result.reasoning_effort).toBeUndefined();
  });

  it("converts Anthropic thinking.type=enabled to reasoning_effort=high", () => {
    const body = {
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "enabled", budget_tokens: 10000 },
    };
    const result = transform(body);
    expect(result.reasoning_effort).toBe(DEFAULT_REASONING_EFFORT);
    expect(result.thinking).toBeUndefined();
  });

  it("always cleans up Anthropic thinking params", () => {
    const body = {
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "disabled" },
    };
    const result = transform(body);
    expect(result.thinking).toBeUndefined();
  });

  it("reads effort from body.reasoning.effort", () => {
    const body = {
      messages: [{ role: "user", content: "hi" }],
      reasoning: { effort: "high" },
    };
    const result = transform(body);
    expect(result.reasoning_effort).toBe("high");
    expect(result.reasoning).toBeUndefined();
  });
});

// ─── applyMaxTokensDefault (via transformRequest) ───────────────────────────

describe("applyMaxTokensDefault", () => {
  it("sets model max output when not specified by client", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    const result = transform(body, "glm-5.2");
    const expected = CODEBUDDY_CN_API_MODEL_CONFIG_MAP.get("glm-5.2").maxOutput;
    expect(result.max_tokens).toBe(expected);
  });

  it("preserves client-specified max_tokens", () => {
    const body = {
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1024,
    };
    const result = transform(body, "glm-5.2");
    expect(result.max_tokens).toBe(1024);
  });

  it("preserves client-specified max_completion_tokens", () => {
    const body = {
      messages: [{ role: "user", content: "hi" }],
      max_completion_tokens: 2048,
    };
    const result = transform(body, "glm-5.2");
    expect(result.max_completion_tokens).toBe(2048);
    // max_tokens should NOT be set since max_completion_tokens was present
    expect(result.max_tokens).toBeUndefined();
  });

  it("does not set max_tokens for unknown models", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    const result = transform(body, "nonexistent-model");
    expect(result.max_tokens).toBeUndefined();
  });
});

// ─── transformRequest — force stream + temperature ───────────────────────────

describe("transformRequest — stream and temperature", () => {
  it("forces stream=true regardless of input", () => {
    const body = {
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    };
    const result = transform(body);
    expect(result.stream).toBe(true);
  });

  it("defaults temperature to 0.1 when not specified", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    const result = transform(body);
    expect(result.temperature).toBe(0.1);
  });

  it("preserves client-specified temperature", () => {
    const body = {
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.7,
    };
    const result = transform(body);
    expect(result.temperature).toBe(0.7);
  });

  it("preserves temperature=0 when explicitly set", () => {
    const body = {
      messages: [{ role: "user", content: "hi" }],
      temperature: 0,
    };
    const result = transform(body);
    expect(result.temperature).toBe(0);
  });
});

// ─── Constants sanity checks ────────────────────────────────────────────────

describe("constants", () => {
  it("getUserAgent returns correct format", () => {
    expect(getUserAgent()).toBe(`CLI/${DEFAULT_CLI_VERSION} CodeBuddy/${DEFAULT_CLI_VERSION}`);
  });

  it("buildDefaultHeaders includes all required headers", () => {
    const h = buildDefaultHeaders("test-key");
    expect(h.Authorization).toBe("Bearer test-key");
    expect(h["Content-Type"]).toBe("application/json");
    expect(h["User-Agent"]).toContain("CodeBuddy/");
    expect(h["X-Conversation-ID"]).toBeTruthy();
    expect(h["X-Request-ID"]).toBeTruthy();
  });

  it("model config map has entries for all declared models", () => {
    expect(CODEBUDDY_CN_API_MODEL_CONFIG_MAP.size).toBeGreaterThan(0);
    expect(CODEBUDDY_CN_API_MODEL_CONFIG_MAP.has("glm-5.2")).toBe(true);
    expect(CODEBUDDY_CN_API_MODEL_CONFIG_MAP.has("deepseek-r1")).toBe(true);
    expect(CODEBUDDY_CN_API_MODEL_CONFIG_MAP.has("kimi-k2.5")).toBe(true);
  });
});
