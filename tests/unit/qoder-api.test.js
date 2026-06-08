import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

vi.mock("../../src/lib/qoder/encoding.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    qoderEncodeBody: vi.fn(actual.qoderEncodeBody),
  };
});

vi.mock("../../src/lib/qoder/cosy.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    buildCosyHeaders: vi.fn(actual.buildCosyHeaders),
  };
});

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { qoderEncodeBody } from "../../src/lib/qoder/encoding.js";
import { buildCosyHeaders } from "../../src/lib/qoder/cosy.js";
import {
  exchangeQoderApiToken,
  isQoderApiSessionValid,
  redactQoderApiSession,
} from "../../src/lib/qoder/apiSession.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";
import { formatCampaignEndDate } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

describe("qoder-api session helper", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-02T00:00:00.000Z"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("exchanges an API key / Personal Access Token for a normalized Qoder session", async () => {
    const upstreamSession = {
      name: "User",
      id: "user-123",
      userType: "personal_standard",
      securityOauthToken: "security-token-123",
      refreshToken: "refresh-token-123",
      expireTime: Date.now() + 60_000,
      email: "user@example.com",
      plan: "pro",
    };
    proxyAwareFetch.mockResolvedValueOnce(new Response(JSON.stringify(upstreamSession), { status: 200, headers: { "content-type": "application/json" } }));

    const session = await exchangeQoderApiToken("pat-secret", {
      machineId: "machine-1",
      machineToken: "machine-token-1",
      machineType: "linux",
    });

    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(proxyAwareFetch.mock.calls[0][0]).toBe("https://center.qoder.sh/algo/api/v3/user/jobToken?Encode=1");
    const request = proxyAwareFetch.mock.calls[0][1];
    const expectedInnerPayload = JSON.stringify({
      personalToken: "pat-secret",
      securityOauthToken: "",
      refreshToken: "",
      needRefresh: false,
      authInfo: {},
    });
    const expectedOuterPayload = JSON.stringify({ payload: expectedInnerPayload, encodeVersion: "1" });
    expect(request.body).toBe(qoderEncodeBody(Buffer.from(expectedOuterPayload, "utf8")));
    expect(request.headers).toMatchObject({
      "cosy-machinetoken": "machine-token-1",
      "cosy-machinetype": "linux",
      "login-version": "v2",
      appcode: "cosy",
      accept: "application/json",
      "accept-encoding": "identity",
      "cosy-version": "0.1.43",
      "cosy-clienttype": "5",
      date: "Tue, 02 Jun 2026 00:00:00 GMT",
      "content-type": "application/json",
      "cosy-machineid": "machine-1",
      "user-agent": "Go-http-client/2.0",
    });
    expect(request.headers.signature).toMatch(/^[a-f0-9]{32}$/);
    expect(session).toEqual({
      userId: "user-123",
      name: "User",
      userType: "personal_standard",
      securityOauthToken: "security-token-123",
      refreshToken: "refresh-token-123",
      email: "user@example.com",
      plan: "pro",
      raw: upstreamSession,
      expiresAt: Date.now() + 60_000,
      machineId: "machine-1",
      machineToken: "machine-token-1",
      machineType: "linux",
    });
  });

  it("rejects missing token before calling Qoder", async () => {
    await expect(exchangeQoderApiToken("", { machineId: "m", machineToken: "t", machineType: "linux" }))
      .rejects.toThrow("Qoder API credential is required");
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("reports token exchange failures without leaking the token", async () => {
    proxyAwareFetch.mockResolvedValueOnce(new Response("upstream body with pat-secret", { status: 401 }));

    await expect(exchangeQoderApiToken("pat-secret", { machineId: "m", machineToken: "t", machineType: "linux" }))
      .rejects.toThrow("Qoder API token exchange failed with status 401");
  });

  it("passes proxyOptions through to proxyAwareFetch", async () => {
    const proxyOptions = { enabled: true, url: "http://proxy:8080" };
    proxyAwareFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      id: "user-123",
      securityOauthToken: "token-123",
      expireTime: Date.now() + 60_000,
    }), { status: 200, headers: { "content-type": "application/json" } }));

    await exchangeQoderApiToken("pat-secret", { machineId: "m", machineToken: "t", machineType: "linux" }, proxyOptions);

    expect(proxyAwareFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      proxyOptions
    );
  });

  it("validates sessions with a refresh margin", () => {
    expect(isQoderApiSessionValid({ userId: "u1", securityOauthToken: "tok", expiresAt: Date.now() + 120_000 })).toBe(true);
    expect(isQoderApiSessionValid({ userId: "u1", securityOauthToken: "tok", expiresAt: Date.now() + 10_000 })).toBe(false);
    expect(isQoderApiSessionValid(null)).toBe(false);
  });

  it("rejects sessions missing userId or securityOauthToken", () => {
    expect(isQoderApiSessionValid({ expiresAt: Date.now() + 120_000 })).toBe(false);
    expect(isQoderApiSessionValid({ userId: "", securityOauthToken: "tok", expiresAt: Date.now() + 120_000 })).toBe(false);
    expect(isQoderApiSessionValid({ userId: "u1", securityOauthToken: "", expiresAt: Date.now() + 120_000 })).toBe(false);
    expect(isQoderApiSessionValid({ userId: "u1", expiresAt: Date.now() + 120_000 })).toBe(false);
  });

  it("redacts sensitive Qoder session fields", () => {
    expect(redactQoderApiSession({
      userId: "user-123",
      securityOauthToken: "secret",
      refreshToken: "refresh",
      machineToken: "machine-secret",
    })).toEqual({
      userId: "user-123",
      securityOauthToken: "[REDACTED]",
      refreshToken: "[REDACTED]",
      machineToken: "[REDACTED]",
    });
  });
});

import { QoderApiExecutor, buildQoderApiPayload } from "../../open-sse/executors/qoderApi.js";

describe("qoder-api executor request mapping", () => {
  it("builds a Qoder payload hoisting system messages, preserving multi-turn history, tools, and tool results", () => {
    const body = {
      model: "qoder-api/lite",
      stream: true,
      messages: [
        { role: "system", content: "You are concise." },
        { role: "user", content: "Call the tool." },
        { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{\"q\":\"x\"}" } }] },
        { role: "tool", tool_call_id: "call_1", content: "result" },
        { role: "user", content: [{ type: "text", text: "Continue." }] },
      ],
      tools: [{ type: "function", function: { name: "lookup", description: "Lookup", parameters: { type: "object", properties: { q: { type: "string" } } } } }],
    };

    const payload = buildQoderApiPayload(body, {
      modelKey: "lite",
      modelConfig: { key: "lite", source: "system" },
      userId: "user-123",
    });

    expect(payload.model_config.key).toBe("lite");
    expect(payload.model_config.format).toBe("openai");
    expect(payload.model_config.max_input_tokens).toBe(180000);
    expect(payload.stream).toBe(true);
    expect(payload.session_type).toBe("qodercli");
    expect(payload.agent_id).toBe("agent_common");
    expect(payload.task_id).toBe("common");
    expect(payload.chat_task).toBe("FREE_INPUT");
    expect(payload.source).toBe(1);
    expect(payload.version).toBe("3");
    expect(payload.business).toMatchObject({ product: "cli", type: "agent", stage: "start" });
    expect(payload.chat_context.extra.modelConfig).toEqual({ key: "lite", is_reasoning: false });
    expect(payload.parameters.max_tokens).toBe(32768);
    expect(payload.tools).toEqual(body.tools);
    expect(payload.system).toBe("You are concise.");
    expect(payload.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "user"]);
    expect(payload.messages[3].content).toBe("Continue.");
    expect(payload.chat_context.text.text).toBe("Continue.");
  });

  it("builds qmodel_latest with qoder2api routing fields and full model config defaults", () => {
    const payload = buildQoderApiPayload({
      model: "qda/qmodel_latest",
      stream: false,
      max_tokens: 1234,
      messages: [{ role: "user", content: "Hello" }],
    }, {
      modelKey: "qmodel_latest",
      modelConfig: QoderApiExecutor.getModelConfig("qmodel_latest"),
      userId: "user-123",
      userType: "personal_standard",
    });

    expect(payload.model_config).toMatchObject({
      key: "qmodel_latest",
      display_name: "Qwen 3.7 Max",
      format: "openai",
      source: "system",
      max_input_tokens: 180000,
    });
    expect(payload).toMatchObject({
      stream: true,
      session_type: "qodercli",
      agent_id: "agent_common",
      task_id: "common",
      chat_task: "FREE_INPUT",
      aliyun_user_type: "personal_standard",
      source: 1,
      version: "3",
      is_reply: true,
      is_retry: false,
    });
    expect(payload.request_set_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(payload.chat_record_id).toBe(payload.request_id);
    expect(payload.parameters.max_tokens).toBe(1234);
  });

  it("strips qoder-api and qda prefixes from model ids", () => {
    expect(QoderApiExecutor.normalizeModelKey("qoder-api/lite")).toBe("lite");
    expect(QoderApiExecutor.normalizeModelKey("qda/auto")).toBe("auto");
    expect(QoderApiExecutor.normalizeModelKey("lite")).toBe("lite");
  });

  it("hoists multiple system messages into top-level system field", () => {
    const body = {
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Hello" },
        { role: "system", content: "Be concise." },
        { role: "assistant", content: "Hi!" },
      ],
    };

    const payload = buildQoderApiPayload(body, {
      modelKey: "lite",
      modelConfig: { key: "lite", source: "system" },
      userId: "user-123",
    });

    expect(payload.system).toBe("You are helpful.\n\nBe concise.");
    expect(payload.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("handles empty system messages gracefully", () => {
    const body = {
      messages: [
        { role: "system", content: "" },
        { role: "user", content: "Hello" },
      ],
    };

    const payload = buildQoderApiPayload(body, {
      modelKey: "lite",
      modelConfig: { key: "lite", source: "system" },
      userId: "user-123",
    });

    expect(payload.system).toBe("");
    expect(payload.messages.map((m) => m.role)).toEqual(["user"]);
  });

  it("handles messages with no system messages", () => {
    const body = {
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi!" },
      ],
    };

    const payload = buildQoderApiPayload(body, {
      modelKey: "lite",
      modelConfig: { key: "lite", source: "system" },
      userId: "user-123",
    });

    expect(payload.system).toBe("");
    expect(payload.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });
});

describe("qoder-api reasoning mode", () => {
  const baseParams = {
    modelKey: "qmodel_latest",
    modelConfig: {
      display_name: "Qwen 3.7 Max",
      model: "qwen3-max-latest",
      format: "openai",
      is_vl: false,
      is_reasoning: false,
      source: "system",
      max_input_tokens: 180000,
    },
    userId: "test-user-id",
    userType: "personal_standard",
  };

  it("detects reasoning_effort parameter and enables reasoning mode", () => {
    const body = {
      messages: [{ role: "user", content: "Think step by step" }],
      reasoning_effort: "high",
    };

    const payload = buildQoderApiPayload(body, baseParams);

    expect(payload.model_config.is_reasoning).toBe(true);
    expect(payload.chat_context.extra.modelConfig.is_reasoning).toBe(true);
  });

  it("detects reasoning.effort nested parameter", () => {
    const body = {
      messages: [{ role: "user", content: "Think step by step" }],
      reasoning: { effort: "medium" },
    };

    const payload = buildQoderApiPayload(body, baseParams);

    expect(payload.model_config.is_reasoning).toBe(true);
  });

  it("detects thinking.type enabled parameter", () => {
    const body = {
      messages: [{ role: "user", content: "Think step by step" }],
      thinking: { type: "enabled" },
    };

    const payload = buildQoderApiPayload(body, baseParams);

    expect(payload.model_config.is_reasoning).toBe(true);
  });

  it("detects enable_thinking parameter", () => {
    const body = {
      messages: [{ role: "user", content: "Think step by step" }],
      enable_thinking: true,
    };

    const payload = buildQoderApiPayload(body, baseParams);

    expect(payload.model_config.is_reasoning).toBe(true);
  });

  it("respects reasoning_effort: none to disable reasoning", () => {
    const reasoningModelParams = {
      ...baseParams,
      modelConfig: {
        ...baseParams.modelConfig,
        is_reasoning: true,
      },
    };

    const body = {
      messages: [{ role: "user", content: "Quick answer" }],
      reasoning_effort: "none",
    };

    const payload = buildQoderApiPayload(body, reasoningModelParams);

    expect(payload.model_config.is_reasoning).toBe(false);
  });

  it("respects thinking.type: disabled to disable reasoning", () => {
    const reasoningModelParams = {
      ...baseParams,
      modelConfig: {
        ...baseParams.modelConfig,
        is_reasoning: true,
      },
    };

    const body = {
      messages: [{ role: "user", content: "Quick answer" }],
      thinking: { type: "disabled" },
    };

    const payload = buildQoderApiPayload(body, reasoningModelParams);

    expect(payload.model_config.is_reasoning).toBe(false);
  });

  it("uses model config default when no reasoning parameters present", () => {
    const reasoningModelParams = {
      ...baseParams,
      modelConfig: {
        ...baseParams.modelConfig,
        is_reasoning: true,
      },
    };

    const body = {
      messages: [{ role: "user", content: "Hello" }],
    };

    const payload = buildQoderApiPayload(body, reasoningModelParams);

    expect(payload.model_config.is_reasoning).toBe(true);
  });

  it("injects reasoning_content placeholder on assistant messages when reasoning is active", () => {
    const reasoningModelParams = {
      ...baseParams,
      modelConfig: {
        ...baseParams.modelConfig,
        is_reasoning: true,
      },
    };

    const body = {
      messages: [
        { role: "user", content: "Question" },
        { role: "assistant", content: "Answer" },
        { role: "user", content: "Follow up" },
      ],
    };

    const payload = buildQoderApiPayload(body, reasoningModelParams);

    expect(payload.messages[1].role).toBe("assistant");
    expect(payload.messages[1].reasoning_content).toBe(" ");
  });

  it("preserves existing reasoning_content on assistant messages", () => {
    const reasoningModelParams = {
      ...baseParams,
      modelConfig: {
        ...baseParams.modelConfig,
        is_reasoning: true,
      },
    };

    const body = {
      messages: [
        { role: "user", content: "Question" },
        { role: "assistant", content: "Answer", reasoning_content: "My reasoning..." },
        { role: "user", content: "Follow up" },
      ],
    };

    const payload = buildQoderApiPayload(body, reasoningModelParams);

    expect(payload.messages[1].reasoning_content).toBe("My reasoning...");
  });

  it("does not inject reasoning_content when reasoning is disabled", () => {
    const body = {
      messages: [
        { role: "user", content: "Question" },
        { role: "assistant", content: "Answer" },
        { role: "user", content: "Follow up" },
      ],
    };

    const payload = buildQoderApiPayload(body, baseParams);

    expect(payload.messages[1].reasoning_content).toBeUndefined();
  });

  it("sanitizes tool_choice to auto when reasoning is active and tool_choice is required", () => {
    const reasoningModelParams = {
      ...baseParams,
      modelConfig: {
        ...baseParams.modelConfig,
        is_reasoning: true,
      },
    };

    const body = {
      messages: [{ role: "user", content: "Use a tool" }],
      tool_choice: "required",
      tools: [{ type: "function", function: { name: "lookup" } }],
    };

    const payload = buildQoderApiPayload(body, reasoningModelParams);

    expect(payload.tool_choice).toBe("auto");
  });

  it("sanitizes tool_choice object to auto when reasoning is active", () => {
    const reasoningModelParams = {
      ...baseParams,
      modelConfig: {
        ...baseParams.modelConfig,
        is_reasoning: true,
      },
    };

    const body = {
      messages: [{ role: "user", content: "Use a tool" }],
      tool_choice: { type: "function", function: { name: "lookup" } },
      tools: [{ type: "function", function: { name: "lookup" } }],
    };

    const payload = buildQoderApiPayload(body, reasoningModelParams);

    expect(payload.tool_choice).toBe("auto");
  });

  it("preserves tool_choice auto when reasoning is active", () => {
    const reasoningModelParams = {
      ...baseParams,
      modelConfig: {
        ...baseParams.modelConfig,
        is_reasoning: true,
      },
    };

    const body = {
      messages: [{ role: "user", content: "Use a tool" }],
      tool_choice: "auto",
      tools: [{ type: "function", function: { name: "lookup" } }],
    };

    const payload = buildQoderApiPayload(body, reasoningModelParams);

    expect(payload.tool_choice).toBe("auto");
  });

  it("preserves tool_choice none when reasoning is active", () => {
    const reasoningModelParams = {
      ...baseParams,
      modelConfig: {
        ...baseParams.modelConfig,
        is_reasoning: true,
      },
    };

    const body = {
      messages: [{ role: "user", content: "No tools" }],
      tool_choice: "none",
    };

    const payload = buildQoderApiPayload(body, reasoningModelParams);

    expect(payload.tool_choice).toBe("none");
  });

  it("does not sanitize tool_choice when reasoning is disabled", () => {
    const body = {
      messages: [{ role: "user", content: "Use a tool" }],
      tool_choice: "required",
      tools: [{ type: "function", function: { name: "lookup" } }],
    };

    const payload = buildQoderApiPayload(body, baseParams);

    expect(payload.tool_choice).toBe("required");
  });

  it("handles conflicting reasoning signals (enable wins over disable)", () => {
    const body = {
      messages: [{ role: "user", content: "Think" }],
      reasoning_effort: "high",
      thinking: { type: "disabled" },
    };

    const payload = buildQoderApiPayload(body, baseParams);

    expect(payload.model_config.is_reasoning).toBe(true);
  });

  it("accepts reasoning_effort: low", () => {
    const body = {
      messages: [{ role: "user", content: "Think briefly" }],
      reasoning_effort: "low",
    };

    const payload = buildQoderApiPayload(body, baseParams);

    expect(payload.model_config.is_reasoning).toBe(true);
  });

  it("accepts reasoning_effort: medium", () => {
    const body = {
      messages: [{ role: "user", content: "Think moderately" }],
      reasoning_effort: "medium",
    };

    const payload = buildQoderApiPayload(body, baseParams);

    expect(payload.model_config.is_reasoning).toBe(true);
  });

  it("does not inject reasoning_content on user messages", () => {
    const reasoningModelParams = {
      ...baseParams,
      modelConfig: {
        ...baseParams.modelConfig,
        is_reasoning: true,
      },
    };

    const body = {
      messages: [
        { role: "user", content: "Question 1" },
        { role: "assistant", content: "Answer 1" },
        { role: "user", content: "Question 2" },
      ],
    };

    const payload = buildQoderApiPayload(body, reasoningModelParams);

    expect(payload.messages[0].reasoning_content).toBeUndefined();
    expect(payload.messages[1].reasoning_content).toBe(" ");
    expect(payload.messages[2].reasoning_content).toBeUndefined();
  });

  it("injects reasoning_content on multiple assistant messages", () => {
    const reasoningModelParams = {
      ...baseParams,
      modelConfig: {
        ...baseParams.modelConfig,
        is_reasoning: true,
      },
    };

    const body = {
      messages: [
        { role: "user", content: "Q1" },
        { role: "assistant", content: "A1" },
        { role: "user", content: "Q2" },
        { role: "assistant", content: "A2" },
        { role: "user", content: "Q3" },
      ],
    };

    const payload = buildQoderApiPayload(body, reasoningModelParams);

    expect(payload.messages[1].reasoning_content).toBe(" ");
    expect(payload.messages[3].reasoning_content).toBe(" ");
  });

  it("preserves empty string reasoning_content", () => {
    const reasoningModelParams = {
      ...baseParams,
      modelConfig: {
        ...baseParams.modelConfig,
        is_reasoning: true,
      },
    };

    const body = {
      messages: [
        { role: "user", content: "Q" },
        { role: "assistant", content: "A", reasoning_content: "" },
        { role: "user", content: "Follow up" },
      ],
    };

    const payload = buildQoderApiPayload(body, reasoningModelParams);

    expect(payload.messages[1].reasoning_content).toBe(" ");
  });

  it("preserves null reasoning_content as undefined", () => {
    const reasoningModelParams = {
      ...baseParams,
      modelConfig: {
        ...baseParams.modelConfig,
        is_reasoning: true,
      },
    };

    const body = {
      messages: [
        { role: "user", content: "Q" },
        { role: "assistant", content: "A", reasoning_content: null },
        { role: "user", content: "Follow up" },
      ],
    };

    const payload = buildQoderApiPayload(body, reasoningModelParams);

    expect(payload.messages[1].reasoning_content).toBe(" ");
  });

  it("works with reasoning and images together", () => {
    const reasoningModelParams = {
      ...baseParams,
      modelConfig: {
        ...baseParams.modelConfig,
        is_reasoning: true,
      },
    };

    const body = {
      messages: [
        { role: "user", content: "Analyze this" },
        {
          role: "assistant",
          content: "Analysis",
        },
        {
          role: "user",
          content: [
            { type: "text", text: "What about this?" },
            { type: "image_url", image_url: { url: "https://example.com/img.jpg" } },
          ],
        },
      ],
    };

    const payload = buildQoderApiPayload(body, reasoningModelParams);

    expect(payload.model_config.is_reasoning).toBe(true);
    expect(payload.model_config.is_vl).toBe(true);
    expect(payload.messages[1].reasoning_content).toBe(" ");
    expect(payload.image_urls).toEqual(["https://example.com/img.jpg"]);
  });

  it("works with reasoning and tools together", () => {
    const reasoningModelParams = {
      ...baseParams,
      modelConfig: {
        ...baseParams.modelConfig,
        is_reasoning: true,
      },
    };

    const body = {
      messages: [
        { role: "user", content: "Use a tool" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "lookup", arguments: "{}" },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "result" },
        { role: "user", content: "Thanks" },
      ],
      tools: [{ type: "function", function: { name: "lookup" } }],
      tool_choice: "auto",
    };

    const payload = buildQoderApiPayload(body, reasoningModelParams);

    expect(payload.model_config.is_reasoning).toBe(true);
    expect(payload.messages[1].reasoning_content).toBe(" ");
    expect(payload.messages[1].tool_calls).toBeDefined();
    expect(payload.tools).toHaveLength(1);
    expect(payload.tool_choice).toBe("auto");
  });

  it("integrates system hoisting with reasoning mode", () => {
    const reasoningModelParams = {
      ...baseParams,
      modelConfig: {
        ...baseParams.modelConfig,
        is_reasoning: true,
      },
    };

    const body = {
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Question" },
        { role: "assistant", content: "Answer" },
        { role: "user", content: "Follow up" },
      ],
      reasoning_effort: "high",
    };

    const payload = buildQoderApiPayload(body, reasoningModelParams);

    expect(payload.system).toBe("You are helpful.");
    expect(payload.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(payload.model_config.is_reasoning).toBe(true);
    expect(payload.messages[1].reasoning_content).toBe(" ");
  });

  it("handles system message with array content", () => {
    const body = {
      messages: [
        {
          role: "system",
          content: [
            { type: "text", text: "Be helpful" },
            { type: "text", text: "and concise" },
          ],
        },
        { role: "user", content: "Hello" },
      ],
    };

    const payload = buildQoderApiPayload(body, baseParams);

    expect(payload.system).toBe("Be helpful\nand concise");
    expect(payload.messages.map((m) => m.role)).toEqual(["user"]);
  });

  it("handles reasoning with nested reasoning object containing extra properties", () => {
    const body = {
      messages: [{ role: "user", content: "Think" }],
      reasoning: {
        effort: "high",
        budget_tokens: 10000,
        summary: "auto",
      },
    };

    const payload = buildQoderApiPayload(body, baseParams);

    expect(payload.model_config.is_reasoning).toBe(true);
  });

  it("handles enable_thinking: false to disable reasoning", () => {
    const reasoningModelParams = {
      ...baseParams,
      modelConfig: {
        ...baseParams.modelConfig,
        is_reasoning: true,
      },
    };

    const body = {
      messages: [{ role: "user", content: "Quick" }],
      enable_thinking: false,
    };

    const payload = buildQoderApiPayload(body, reasoningModelParams);

    expect(payload.model_config.is_reasoning).toBe(false);
  });

  it("handles reasoning.effort: none to disable reasoning", () => {
    const reasoningModelParams = {
      ...baseParams,
      modelConfig: {
        ...baseParams.modelConfig,
        is_reasoning: true,
      },
    };

    const body = {
      messages: [{ role: "user", content: "Quick" }],
      reasoning: { effort: "none" },
    };

    const payload = buildQoderApiPayload(body, reasoningModelParams);

    expect(payload.model_config.is_reasoning).toBe(false);
  });

  it("does not inject reasoning_content on tool messages", () => {
    const reasoningModelParams = {
      ...baseParams,
      modelConfig: {
        ...baseParams.modelConfig,
        is_reasoning: true,
      },
    };

    const body = {
      messages: [
        { role: "user", content: "Use tool" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "result" },
        { role: "user", content: "Thanks" },
      ],
    };

    const payload = buildQoderApiPayload(body, reasoningModelParams);

    expect(payload.messages[1].reasoning_content).toBe(" ");
    expect(payload.messages[2].reasoning_content).toBeUndefined();
  });

  it("handles all messages being system messages", () => {
    const body = {
      messages: [
        { role: "system", content: "System 1" },
        { role: "system", content: "System 2" },
      ],
    };

    const payload = buildQoderApiPayload(body, baseParams);

    expect(payload.system).toBe("System 1\n\nSystem 2");
    expect(payload.messages).toEqual([]);
  });

  it("preserves tool_calls when injecting reasoning_content", () => {
    const reasoningModelParams = {
      ...baseParams,
      modelConfig: {
        ...baseParams.modelConfig,
        is_reasoning: true,
      },
    };

    const toolCalls = [
      {
        id: "call_1",
        type: "function",
        function: { name: "lookup", arguments: '{"q":"test"}' },
      },
    ];

    const body = {
      messages: [
        { role: "user", content: "Use tool" },
        { role: "assistant", content: "", tool_calls: toolCalls },
        { role: "user", content: "Continue" },
      ],
    };

    const payload = buildQoderApiPayload(body, reasoningModelParams);

    expect(payload.messages[1].reasoning_content).toBe(" ");
    expect(payload.messages[1].tool_calls).toEqual(toolCalls);
    expect(payload.messages[1].content).toBe("");
  });
});

describe("qoder-api max_completion_tokens parameter", () => {
  const baseParams = {
    modelKey: "qmodel_latest",
    modelConfig: {
      display_name: "Qwen 3.7 Max",
      model: "qwen3-max-latest",
      format: "openai",
      is_vl: false,
      is_reasoning: false,
      source: "system",
      max_input_tokens: 180000,
    },
    userId: "test-user-id",
    userType: "personal_standard",
  };

  it("uses max_completion_tokens when max_tokens is not present", () => {
    const body = {
      messages: [{ role: "user", content: "Hello" }],
      max_completion_tokens: 2048,
    };

    const payload = buildQoderApiPayload(body, baseParams);

    expect(payload.parameters.max_tokens).toBe(2048);
  });

  it("prefers max_tokens over max_completion_tokens when both present", () => {
    const body = {
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 4096,
      max_completion_tokens: 2048,
    };

    const payload = buildQoderApiPayload(body, baseParams);

    expect(payload.parameters.max_tokens).toBe(4096);
  });

  it("uses default when neither max_tokens nor max_completion_tokens present", () => {
    const body = {
      messages: [{ role: "user", content: "Hello" }],
    };

    const payload = buildQoderApiPayload(body, baseParams);

    expect(payload.parameters.max_tokens).toBe(32768);
  });

  it("accepts max_completion_tokens: 0", () => {
    const body = {
      messages: [{ role: "user", content: "Hello" }],
      max_completion_tokens: 0,
    };

    const payload = buildQoderApiPayload(body, baseParams);

    expect(payload.parameters.max_tokens).toBe(32768);
  });
});

import { existsSync } from "fs";
import { QODER_CHAT_URL_ENCODED } from "../../src/lib/qoder/constants.js";
import { wrapQoderApiSSE } from "../../open-sse/executors/qoderApi.js";

async function readStreamText(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let output = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    output += decoder.decode(value, { stream: true });
  }
  output += decoder.decode();
  return output;
}

describe("qoder-api executor network flow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-02T00:00:00.000Z"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("exchanges the token, encodes/signs the request, and posts to Qoder SSE endpoint", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({
        name: "User",
        id: "user-123",
        userType: "personal_standard",
        securityOauthToken: "security-token-123",
        refreshToken: "refresh-token-123",
        expireTime: Date.now() + 60_000,
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }));

    const executor = new QoderApiExecutor();
    const onCredentialsRefreshed = vi.fn();
    const credentials = { apiKey: "pat-secret", providerSpecificData: {} };
    const result = await executor.execute({
      model: "qoder-api/lite",
      body: { model: "qoder-api/lite", messages: [{ role: "user", content: "hello" }], stream: true },
      credentials,
      provider: "qoder-api",
      onCredentialsRefreshed,
    });

    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
    expect(proxyAwareFetch.mock.calls[1][0]).toBe(QODER_CHAT_URL_ENCODED);
    const request = proxyAwareFetch.mock.calls[1][1];
    expect(request.method).toBe("POST");
    expect(request.headers.Authorization).toMatch(/^Bearer COSY\./);
    const persistedSession = credentials.providerSpecificData.qoderApiSession;
    expect(request.headers["Cosy-Machinetoken"]).toBe(persistedSession.machineToken);
    expect(request.headers["Cosy-Machinetoken"]).not.toBe(persistedSession.machineId);
    expect(request.headers["Cosy-Machinetype"]).toBe(persistedSession.machineType);
    expect(request.headers["Accept-Encoding"]).toBe("identity");
    expect(request.headers.Accept).toBe("text/event-stream");
    expect(request.headers["X-Model-Key"]).toBe("lite");
    expect(result.response.status).toBe(200);
    expect(result.transformedBody.model_config.key).toBe("lite");
    expect(credentials.providerSpecificData.qoderApiSession.userId).toBe("user-123");
    expect(onCredentialsRefreshed).toHaveBeenCalledWith({
      apiKey: "pat-secret",
      providerSpecificData: {
        qoderApiSession: expect.objectContaining({ userId: "user-123" }),
      },
    });
  });
});

import { getExecutor } from "../../open-sse/executors/index.js";
import { parseModel } from "../../open-sse/services/model.js";
import { PROVIDERS } from "../../open-sse/config/providers.js";

import { APIKEY_PROVIDERS, FREE_PROVIDERS } from "../../src/shared/constants/providers.js";
import { PROVIDER_MODELS } from "../../open-sse/config/providerModels.js";
import { getOutputAliasesForProvider } from "../../src/app/api/v1/models/route.js";

describe("qoder-api dashboard metadata", () => {
  it("exposes Qoder API as an API-key provider and keeps built-in Qoder separate", () => {
    expect(APIKEY_PROVIDERS["qoder-api"]).toBeDefined();
    expect(APIKEY_PROVIDERS["qoder-api"].name).toBe("Qoder API");
    expect(APIKEY_PROVIDERS["qoder-api"].alias).toBe("qda");
    expect(APIKEY_PROVIDERS["qoder-api"].name).not.toMatch(/PAT/i);
    expect(FREE_PROVIDERS.qoder).toBeDefined();
    expect(APIKEY_PROVIDERS["qoder-api"].icon).toBe(FREE_PROVIDERS.qoder.icon);
    expect(APIKEY_PROVIDERS["qoder-api"].color).toBe(FREE_PROVIDERS.qoder.color);
    expect(APIKEY_PROVIDERS["qoder-api"].notice.apiKeyUrl).toBe("https://qoder.com/account/integrations");
    expect(existsSync("../public/providers/qoder.png")).toBe(true);
    expect(existsSync("../public/providers/qoder-api.png")).toBe(true);
    expect(FREE_PROVIDERS.qoder.alias).toBe("qd");
  });

  it("has static qoder-api models with the requested English labels", () => {
    const models = PROVIDER_MODELS.qda || [];
    const byId = new Map(models.map((model) => [model.id, model.name]));
    expect(byId.get("lite")).toBe("Free tier");
    expect(byId.get("qmodel_latest")).toBe("Qwen 3.7 Max");
    expect(byId.get("ultimate")).toBe("Highest tier");
    expect([...byId.values()].join(" ")).not.toMatch(/undisclosed model/i);
  });

  it("exposes both canonical qoder-api and qda aliases for /v1/models", () => {
    expect(getOutputAliasesForProvider("qoder-api", "qda", "qda")).toEqual(["qda", "qoder-api"]);
    expect(getOutputAliasesForProvider("qoder", "qd", "qd")).toEqual(["qd"]);
  });
});

describe("qoder-api provider registration", () => {
  it("registers qoder-api without replacing qoder", () => {
    expect(PROVIDERS["qoder-api"]).toBeDefined();
    expect(PROVIDERS.qoder).toBeDefined();
    expect(getExecutor("qoder-api")).toBeInstanceOf(QoderApiExecutor);
    expect(getExecutor("qoder")).not.toBeInstanceOf(QoderApiExecutor);
  });

  it("resolves qda alias to qoder-api and keeps qd alias for qoder", () => {
    expect(parseModel("qda/lite")).toMatchObject({ provider: "qoder-api", model: "lite" });
    expect(parseModel("qoder-api/lite")).toMatchObject({ provider: "qoder-api", model: "lite" });
    expect(parseModel("qd/lite")).toMatchObject({ provider: "qoder", model: "lite" });
  });
});

describe("qoder-api SSE unwrap", () => {
  it("unwraps Qoder envelope body into OpenAI SSE and emits one DONE", async () => {
    const encoder = new TextEncoder();
    const inner = JSON.stringify({ id: "chatcmpl-1", choices: [{ delta: { content: "hello" }, index: 0 }] });
    const upstream = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ statusCodeValue: 200, body: inner })}\n\n`));
        controller.close();
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } });

    const wrapped = wrapQoderApiSSE(upstream, "qoder-api/lite");
    const text = await readStreamText(wrapped);

    expect(text).toContain(`data: ${inner}\n\n`);
    expect(text.match(/data: \[DONE\]/g)).toHaveLength(1);
  });

  it("passes non-ok responses through unchanged", () => {
    const upstream = new Response("bad", { status: 401 });
    const wrapped = wrapQoderApiSSE(upstream, "qoder-api/lite");
    expect(wrapped).toBe(upstream);
  });

  it("forwards streaming tool_call deltas before upstream closes", async () => {
    const encoder = new TextEncoder();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const innerTool = JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: "{\"q\"" } }] } }] });
    const upstream = new Response(new ReadableStream({
      async start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ statusCodeValue: 200, body: innerTool })}\n\n`));
        await gate;
        controller.close();
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } });

    const wrapped = wrapQoderApiSSE(upstream, "qoder-api/lite");
    const reader = wrapped.body.getReader();
    const first = await reader.read();
    const firstText = new TextDecoder().decode(first.value);
    release();

    expect(first.done).toBe(false);
    expect(firstText).toContain("tool_calls");
    await reader.cancel();
  });

  it("handles one Qoder envelope split across byte chunks", async () => {
    const encoder = new TextEncoder();
    const inner = JSON.stringify({ choices: [{ index: 0, delta: { content: "split" } }] });
    const frame = `data: ${JSON.stringify({ statusCodeValue: 200, body: inner })}\n\n`;
    const upstream = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(frame.slice(0, 12)));
        controller.enqueue(encoder.encode(frame.slice(12)));
        controller.close();
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } });

    const text = await readStreamText(wrapQoderApiSSE(upstream, "qoder-api/lite"));
    expect(text).toContain("split");
    expect(text.match(/data: \[DONE\]/g)).toHaveLength(1);
  });
});

describe("qoder-api image input handling", () => {
  const baseParams = {
    modelKey: "qmodel_latest",
    modelConfig: {
      display_name: "Qwen 3.7 Max",
      model: "qwen3-max-latest",
      format: "openai",
      is_vl: false,
      is_reasoning: false,
      source: "system",
      max_input_tokens: 180000,
    },
    userId: "test-user-id",
    userType: "personal_standard",
  };

  describe("single image", () => {
    it("extracts single image URL from user message", () => {
      const body = {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What is in this image?" },
              { type: "image_url", image_url: { url: "https://example.com/image.jpg" } },
            ],
          },
        ],
      };

      const payload = buildQoderApiPayload(body, baseParams);

      expect(payload.image_urls).toEqual(["https://example.com/image.jpg"]);
      expect(payload.chat_context.imageUrls).toEqual(["https://example.com/image.jpg"]);
      expect(payload.model_config.is_vl).toBe(true);
    });

    it("extracts single base64 image", () => {
      const base64Data = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
      const body = {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Analyze this" },
              { type: "image_url", image_url: { url: base64Data } },
            ],
          },
        ],
      };

      const payload = buildQoderApiPayload(body, baseParams);

      expect(payload.image_urls).toEqual([base64Data]);
      expect(payload.model_config.is_vl).toBe(true);
    });
  });

  describe("multiple images", () => {
    it("extracts multiple images from single message", () => {
      const body = {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Compare these images" },
              { type: "image_url", image_url: { url: "https://example.com/img1.jpg" } },
              { type: "image_url", image_url: { url: "https://example.com/img2.jpg" } },
              { type: "image_url", image_url: { url: "https://example.com/img3.jpg" } },
            ],
          },
        ],
      };

      const payload = buildQoderApiPayload(body, baseParams);

      expect(payload.image_urls).toHaveLength(3);
      expect(payload.image_urls).toEqual([
        "https://example.com/img1.jpg",
        "https://example.com/img2.jpg",
        "https://example.com/img3.jpg",
      ]);
      expect(payload.model_config.is_vl).toBe(true);
    });

    it("extracts images from multiple messages", () => {
      const body = {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "First image" },
              { type: "image_url", image_url: { url: "https://example.com/img1.jpg" } },
            ],
          },
          {
            role: "assistant",
            content: "I see the first image",
          },
          {
            role: "user",
            content: [
              { type: "text", text: "Second image" },
              { type: "image_url", image_url: { url: "https://example.com/img2.jpg" } },
            ],
          },
        ],
      };

      const payload = buildQoderApiPayload(body, baseParams);

      expect(payload.image_urls).toHaveLength(2);
      expect(payload.image_urls).toEqual([
        "https://example.com/img1.jpg",
        "https://example.com/img2.jpg",
      ]);
    });
  });

  describe("message format", () => {
    it("formats user message with text only", () => {
      const body = {
        messages: [
          {
            role: "user",
            content: "Hello world",
          },
        ],
      };

      const payload = buildQoderApiPayload(body, baseParams);

      expect(payload.messages[0]).toEqual({
        role: "user",
        content: "Hello world",
        contents: [{ type: "text", text: "Hello world" }],
      });
      expect(payload.image_urls).toBeNull();
      expect(payload.model_config.is_vl).toBe(false);
    });

    it("formats user message with images using contents array", () => {
      const body = {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What is this?" },
              { type: "image_url", image_url: { url: "https://example.com/img.jpg" } },
            ],
          },
        ],
      };

      const payload = buildQoderApiPayload(body, baseParams);

      expect(payload.messages[0].content).toBe("What is this?");
      expect(payload.messages[0].contents).toEqual([
        { type: "text", text: "What is this?" },
        { type: "image_url", image_url: { url: "https://example.com/img.jpg" } },
      ]);
    });

    it("handles image-only message (no text)", () => {
      const body = {
        messages: [
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: "https://example.com/img.jpg" } },
            ],
          },
        ],
      };

      const payload = buildQoderApiPayload(body, baseParams);

      expect(payload.messages[0].content).toBe("");
      expect(payload.messages[0].contents).toEqual([
        { type: "image_url", image_url: { url: "https://example.com/img.jpg" } },
      ]);
      expect(payload.image_urls).toEqual(["https://example.com/img.jpg"]);
    });
  });

  describe("edge cases", () => {
    it("handles empty image_url object", () => {
      const body = {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Test" },
              { type: "image_url", image_url: {} },
            ],
          },
        ],
      };

      const payload = buildQoderApiPayload(body, baseParams);

      expect(payload.image_urls).toBeNull();
      expect(payload.model_config.is_vl).toBe(false);
    });

    it("handles null image_url", () => {
      const body = {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Test" },
              { type: "image_url", image_url: null },
            ],
          },
        ],
      };

      const payload = buildQoderApiPayload(body, baseParams);

      expect(payload.image_urls).toBeNull();
    });

    it("handles mixed valid and invalid images", () => {
      const body = {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Test" },
              { type: "image_url", image_url: { url: "https://example.com/valid.jpg" } },
              { type: "image_url", image_url: { url: "" } },
              { type: "image_url", image_url: null },
              { type: "image_url", image_url: { url: "https://example.com/valid2.jpg" } },
            ],
          },
        ],
      };

      const payload = buildQoderApiPayload(body, baseParams);

      expect(payload.image_urls).toEqual([
        "https://example.com/valid.jpg",
        "https://example.com/valid2.jpg",
      ]);
    });

    it("does not set is_vl when no images present", () => {
      const body = {
        messages: [
          {
            role: "user",
            content: "Just text, no images",
          },
        ],
      };

      const payload = buildQoderApiPayload(body, baseParams);

      expect(payload.model_config.is_vl).toBe(false);
      expect(payload.image_urls).toBeNull();
      expect(payload.chat_context.imageUrls).toBeNull();
    });

    it("preserves is_vl from model config when images present", () => {
      const paramsWithVL = {
        ...baseParams,
        modelConfig: {
          ...baseParams.modelConfig,
          is_vl: true,
        },
      };

      const body = {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Test" },
              { type: "image_url", image_url: { url: "https://example.com/img.jpg" } },
            ],
          },
        ],
      };

      const payload = buildQoderApiPayload(body, paramsWithVL);

      expect(payload.model_config.is_vl).toBe(true);
    });

    it("handles flat image_url format (string instead of object)", () => {
      const body = {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Test" },
              { type: "image_url", image_url: "https://example.com/flat.jpg" },
            ],
          },
        ],
      };

      const payload = buildQoderApiPayload(body, baseParams);

      expect(payload.image_urls).toEqual(["https://example.com/flat.jpg"]);
      expect(payload.model_config.is_vl).toBe(true);
    });

    it("trims whitespace from image URLs", () => {
      const body = {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Test" },
              { type: "image_url", image_url: { url: "  https://example.com/img.jpg  " } },
            ],
          },
        ],
      };

      const payload = buildQoderApiPayload(body, baseParams);

      expect(payload.image_urls).toEqual(["https://example.com/img.jpg"]);
    });

    it("handles empty content array", () => {
      const body = {
        messages: [
          {
            role: "user",
            content: [],
          },
        ],
      };

      const payload = buildQoderApiPayload(body, baseParams);

      expect(payload.messages[0].content).toBe("");
      expect(payload.messages[0].contents).toEqual([]);
      expect(payload.image_urls).toBeNull();
    });

    it("handles content array with only text parts", () => {
      const body = {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "First" },
              { type: "text", text: "Second" },
            ],
          },
        ],
      };

      const payload = buildQoderApiPayload(body, baseParams);

      expect(payload.messages[0].content).toBe("First\nSecond");
      expect(payload.messages[0].contents).toEqual([
        { type: "text", text: "First\nSecond" },
      ]);
      expect(payload.image_urls).toBeNull();
    });

    it("handles very long base64 image data", () => {
      const longBase64 = "data:image/png;base64," + "A".repeat(10000);
      const body = {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Test" },
              { type: "image_url", image_url: { url: longBase64 } },
            ],
          },
        ],
      };

      const payload = buildQoderApiPayload(body, baseParams);

      expect(payload.image_urls).toEqual([longBase64]);
      expect(payload.model_config.is_vl).toBe(true);
    });

    it("extracts images from non-user messages as well", () => {
      const body = {
        messages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "Here is an image" },
              { type: "image_url", image_url: { url: "https://example.com/assistant.jpg" } },
            ],
          },
        ],
      };

      const payload = buildQoderApiPayload(body, baseParams);

      expect(payload.image_urls).toEqual(["https://example.com/assistant.jpg"]);
      expect(payload.model_config.is_vl).toBe(true);
    });

    it("handles multiple text and image parts in same message", () => {
      const body = {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "First text" },
              { type: "image_url", image_url: { url: "https://example.com/img1.jpg" } },
              { type: "text", text: "Second text" },
              { type: "image_url", image_url: { url: "https://example.com/img2.jpg" } },
            ],
          },
        ],
      };

      const payload = buildQoderApiPayload(body, baseParams);

      expect(payload.messages[0].content).toBe("First text\nSecond text");
      expect(payload.messages[0].contents).toEqual([
        { type: "text", text: "First text\nSecond text" },
        { type: "image_url", image_url: { url: "https://example.com/img1.jpg" } },
        { type: "image_url", image_url: { url: "https://example.com/img2.jpg" } },
      ]);
      expect(payload.image_urls).toEqual([
        "https://example.com/img1.jpg",
        "https://example.com/img2.jpg",
      ]);
    });
  });

  describe("integration with other features", () => {
    it("works with temperature parameter", () => {
      const body = {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Analyze" },
              { type: "image_url", image_url: { url: "https://example.com/img.jpg" } },
            ],
          },
        ],
        temperature: 0.7,
      };

      const payload = buildQoderApiPayload(body, baseParams);

      expect(payload.parameters.temperature).toBe(0.7);
      expect(payload.image_urls).toEqual(["https://example.com/img.jpg"]);
    });

    it("works with max_tokens parameter", () => {
      const body = {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Analyze" },
              { type: "image_url", image_url: { url: "https://example.com/img.jpg" } },
            ],
          },
        ],
        max_tokens: 4096,
      };

      const payload = buildQoderApiPayload(body, baseParams);

      expect(payload.parameters.max_tokens).toBe(4096);
      expect(payload.image_urls).toEqual(["https://example.com/img.jpg"]);
    });

    it("works with tools", () => {
      const body = {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Use tool on this image" },
              { type: "image_url", image_url: { url: "https://example.com/img.jpg" } },
            ],
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "analyze_image",
              description: "Analyze an image",
            },
          },
        ],
      };

      const payload = buildQoderApiPayload(body, baseParams);

      expect(payload.tools).toHaveLength(1);
      expect(payload.image_urls).toEqual(["https://example.com/img.jpg"]);
    });
  });
});

describe("qoder-api temperature parameter", () => {
  const baseParams = {
    modelKey: "qmodel_latest",
    modelConfig: {
      display_name: "Qwen 3.7 Max",
      model: "qwen3-max-latest",
      format: "openai",
      is_vl: false,
      is_reasoning: false,
      source: "system",
      max_input_tokens: 180000,
    },
    userId: "test-user-id",
    userType: "personal_standard",
  };

  it("uses default temperature 0.1 when not specified", () => {
    const body = {
      messages: [{ role: "user", content: "Hello" }],
    };

    const payload = buildQoderApiPayload(body, baseParams);

    expect(payload.parameters.temperature).toBe(0.1);
  });

  it("uses custom temperature when specified", () => {
    const body = {
      messages: [{ role: "user", content: "Hello" }],
      temperature: 0.7,
    };

    const payload = buildQoderApiPayload(body, baseParams);

    expect(payload.parameters.temperature).toBe(0.7);
  });

  it("accepts temperature 0.0", () => {
    const body = {
      messages: [{ role: "user", content: "Hello" }],
      temperature: 0.0,
    };

    const payload = buildQoderApiPayload(body, baseParams);

    expect(payload.parameters.temperature).toBe(0.0);
  });

  it("accepts temperature 1.0", () => {
    const body = {
      messages: [{ role: "user", content: "Hello" }],
      temperature: 1.0,
    };

    const payload = buildQoderApiPayload(body, baseParams);

    expect(payload.parameters.temperature).toBe(1.0);
  });
});

describe("qoder-api Cosy headers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-02T00:00:00.000Z"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("sends Cosy-Version 2.11.2 in chat request headers", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({
        name: "User",
        id: "user-123",
        userType: "personal_standard",
        securityOauthToken: "security-token-123",
        refreshToken: "refresh-token-123",
        expireTime: Date.now() + 60_000,
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }));

    const executor = new QoderApiExecutor();
    const credentials = { apiKey: "pat-secret", providerSpecificData: {} };
    await executor.execute({
      model: "qoder-api/lite",
      body: { model: "qoder-api/lite", messages: [{ role: "user", content: "hello" }], stream: true },
      credentials,
      provider: "qoder-api",
    });

    const chatRequest = proxyAwareFetch.mock.calls[1][1];
    expect(chatRequest.headers["Cosy-Version"]).toBe("2.11.2");
  });

  it("sends random Cosy-Machineos from valid platform list", async () => {
    const validPlatforms = [
      "x86_64_windows",
      "arm64_windows",
      "x86_64_darwin",
      "arm64_darwin",
      "x86_64_linux",
      "arm64_linux",
    ];

    proxyAwareFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({
        name: "User",
        id: "user-123",
        userType: "personal_standard",
        securityOauthToken: "security-token-123",
        refreshToken: "refresh-token-123",
        expireTime: Date.now() + 60_000,
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }));

    const executor = new QoderApiExecutor();
    const credentials = { apiKey: "pat-secret", providerSpecificData: {} };
    await executor.execute({
      model: "qoder-api/lite",
      body: { model: "qoder-api/lite", messages: [{ role: "user", content: "hello" }], stream: true },
      credentials,
      provider: "qoder-api",
    });

    const chatRequest = proxyAwareFetch.mock.calls[1][1];
    const machineOs = chatRequest.headers["Cosy-Machineos"];
    expect(validPlatforms).toContain(machineOs);
  });

  it("varies Cosy-Machineos across multiple requests", async () => {
    const platforms = new Set();

    for (let i = 0; i < 10; i++) {
      proxyAwareFetch
        .mockResolvedValueOnce(new Response(JSON.stringify({
          name: "User",
          id: "user-123",
          userType: "personal_standard",
          securityOauthToken: "security-token-123",
          refreshToken: "refresh-token-123",
          expireTime: Date.now() + 60_000,
        }), { status: 200, headers: { "content-type": "application/json" } }))
        .mockResolvedValueOnce(new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }));

      const executor = new QoderApiExecutor();
      const credentials = { apiKey: "pat-secret", providerSpecificData: {} };
      await executor.execute({
        model: "qoder-api/lite",
        body: { model: "qoder-api/lite", messages: [{ role: "user", content: "hello" }], stream: true },
        credentials,
        provider: "qoder-api",
      });

      const chatRequest = proxyAwareFetch.mock.calls[i * 2 + 1][1];
      platforms.add(chatRequest.headers["Cosy-Machineos"]);
    }

    expect(platforms.size).toBeGreaterThan(1);
  });
});

describe("qoder-api error handling and logging", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-02T00:00:00.000Z"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("ensureSession error handling", () => {
    it("throws error when API key is missing", async () => {
      const executor = new QoderApiExecutor();
      const credentials = {};

      await expect(executor.ensureSession(credentials))
        .rejects.toThrow("Qoder API key is required");
    });

    it("throws error when API key is null", async () => {
      const executor = new QoderApiExecutor();
      const credentials = { apiKey: null };

      await expect(executor.ensureSession(credentials))
        .rejects.toThrow("Qoder API key is required");
    });

    it("returns cached session when valid", async () => {
      const executor = new QoderApiExecutor();
      const cachedSession = {
        userId: "user-123",
        securityOauthToken: "token-123",
        expiresAt: Date.now() + 3600000,
      };
      const credentials = {
        apiKey: "test-key",
        providerSpecificData: {
          qoderApiSession: cachedSession,
        },
      };

      const session = await executor.ensureSession(credentials);

      expect(session).toBe(cachedSession);
      expect(proxyAwareFetch).not.toHaveBeenCalled();
    });

    it("exchanges token when cached session is expired", async () => {
      const executor = new QoderApiExecutor();
      const expiredSession = {
        userId: "user-123",
        securityOauthToken: "token-123",
        expiresAt: Date.now() - 1000,
      };
      const credentials = {
        apiKey: "test-key",
        providerSpecificData: {
          qoderApiSession: expiredSession,
        },
      };

      proxyAwareFetch.mockResolvedValueOnce(new Response(JSON.stringify({
        id: "user-456",
        securityOauthToken: "new-token",
        expireTime: Date.now() + 60_000,
      }), { status: 200, headers: { "content-type": "application/json" } }));

      const session = await executor.ensureSession(credentials);

      expect(session.userId).toBe("user-456");
      expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("execute error handling", () => {
    it("returns 401 when session initialization fails", async () => {
      const executor = new QoderApiExecutor();
      const credentials = {};

      const result = await executor.execute({
        model: "qoder-api/lite",
        body: { messages: [{ role: "user", content: "test" }] },
        credentials,
        provider: "qoder-api",
      });

      expect(result.response.status).toBe(401);
      const errorBody = await result.response.json();
      expect(errorBody.error.type).toBe("authentication_error");
      expect(errorBody.error.message).toBe("Authentication failed. Please check your API key");
    });

    it("returns 500 when body encoding fails", async () => {
      qoderEncodeBody.mockImplementationOnce(() => {
        throw new Error("encoding boom");
      });

      const executor = new QoderApiExecutor();
      const credentials = {
        apiKey: "test-key",
        providerSpecificData: {
          qoderApiSession: {
            userId: "user-123",
            securityOauthToken: "token-123",
            expiresAt: Date.now() + 3600000,
          },
        },
      };

      const result = await executor.execute({
        model: "qoder-api/lite",
        body: { messages: [{ role: "user", content: "test" }] },
        credentials,
        provider: "qoder-api",
      });

      expect(result.response.status).toBe(500);
      const errorBody = await result.response.json();
      expect(errorBody.error.type).toBe("server_error");
      expect(errorBody.error.message).toBe("Internal processing error");

      qoderEncodeBody.mockRestore();
    });

    it("returns 502 when Qoder API returns 5xx status", async () => {
      proxyAwareFetch
        .mockResolvedValueOnce(new Response(JSON.stringify({
          id: "user-123",
          securityOauthToken: "token-123",
          expireTime: Date.now() + 60_000,
        }), { status: 200, headers: { "content-type": "application/json" } }))
        .mockResolvedValueOnce(new Response("Internal Server Error", { 
          status: 500, 
          statusText: "Internal Server Error" 
        }));

      const executor = new QoderApiExecutor();
      const credentials = { apiKey: "test-key", providerSpecificData: {} };

      const result = await executor.execute({
        model: "qoder-api/lite",
        body: { messages: [{ role: "user", content: "test" }] },
        credentials,
        provider: "qoder-api",
      });

      expect(result.response.status).toBe(502);
      const errorBody = await result.response.json();
      expect(errorBody.error.type).toBe("upstream_error");
      expect(errorBody.error.message).toBe("Upstream provider returned 500");
    });

    it("returns 503 when network request fails", async () => {
      proxyAwareFetch
        .mockResolvedValueOnce(new Response(JSON.stringify({
          id: "user-123",
          securityOauthToken: "token-123",
          expireTime: Date.now() + 60_000,
        }), { status: 200, headers: { "content-type": "application/json" } }))
        .mockRejectedValueOnce(new Error("Network error"));

      const executor = new QoderApiExecutor();
      const credentials = { apiKey: "test-key", providerSpecificData: {} };

      const result = await executor.execute({
        model: "qoder-api/lite",
        body: { messages: [{ role: "user", content: "test" }] },
        credentials,
        provider: "qoder-api",
      });

      expect(result.response.status).toBe(503);
      const errorBody = await result.response.json();
      expect(errorBody.error.type).toBe("server_error");
      expect(errorBody.error.message).toBe("Upstream service unavailable");
    });

    it("returns 401 when COSY header building fails", async () => {
      buildCosyHeaders.mockImplementationOnce(() => {
        throw new Error("cosy signing boom");
      });

      const executor = new QoderApiExecutor();
      const credentials = { 
        apiKey: "test-key", 
        providerSpecificData: {
          qoderApiSession: {
            userId: "user-123",
            securityOauthToken: "token-123",
            expiresAt: Date.now() + 3600000,
          },
        }
      };

      const body = { messages: [{ role: "user", content: "test" }] };

      const result = await executor.execute({
        model: "qoder-api/lite",
        body,
        credentials,
        provider: "qoder-api",
      });

      expect(result.response.status).toBe(401);
      const errorBody = await result.response.json();
      expect(errorBody.error.type).toBe("authentication_error");
      expect(errorBody.error.message).toBe("Authentication failed");

      buildCosyHeaders.mockRestore();
    });
  });

  describe("logging behavior", () => {
    it("does not log info or debug level messages on success", async () => {
      const logger = await import("../../src/sse/utils/logger.js");
      const infoSpy = vi.spyOn(logger, "info");
      const debugSpy = vi.spyOn(logger, "debug");

      proxyAwareFetch
        .mockResolvedValueOnce(new Response(JSON.stringify({
          id: "user-123",
          securityOauthToken: "token-123",
          expireTime: Date.now() + 60_000,
        }), { status: 200, headers: { "content-type": "application/json" } }))
        .mockResolvedValueOnce(new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }));

      const executor = new QoderApiExecutor();
      const credentials = { apiKey: "test-key", providerSpecificData: {} };

      await executor.execute({
        model: "qoder-api/lite",
        body: { messages: [{ role: "user", content: "test" }] },
        credentials,
        provider: "qoder-api",
      });

      expect(infoSpy).not.toHaveBeenCalled();
      expect(debugSpy).not.toHaveBeenCalled();

      infoSpy.mockRestore();
      debugSpy.mockRestore();
    });

    it("logs error when session initialization fails", async () => {
      const logger = await import("../../src/sse/utils/logger.js");
      const errorSpy = vi.spyOn(logger, "error");

      const executor = new QoderApiExecutor();
      const credentials = {};

      await executor.execute({
        model: "qoder-api/lite",
        body: { messages: [{ role: "user", content: "test" }] },
        credentials,
        provider: "qoder-api",
      });

      expect(errorSpy).toHaveBeenCalledWith(
        "Qoder API",
        "Session initialization failed",
        expect.objectContaining({
          requestId: expect.any(String),
          error: expect.any(String),
        })
      );

      errorSpy.mockRestore();
    });

    it("logs error when Qoder API returns non-OK status", async () => {
      const logger = await import("../../src/sse/utils/logger.js");
      const errorSpy = vi.spyOn(logger, "error");

      proxyAwareFetch
        .mockResolvedValueOnce(new Response(JSON.stringify({
          id: "user-123",
          securityOauthToken: "token-123",
          expireTime: Date.now() + 60_000,
        }), { status: 200, headers: { "content-type": "application/json" } }))
        .mockResolvedValueOnce(new Response("Error", { 
          status: 500, 
          statusText: "Internal Server Error" 
        }));

      const executor = new QoderApiExecutor();
      const credentials = { apiKey: "test-key", providerSpecificData: {} };

      await executor.execute({
        model: "qoder-api/lite",
        body: { messages: [{ role: "user", content: "test" }] },
        credentials,
        provider: "qoder-api",
      });

      expect(errorSpy).toHaveBeenCalledWith(
        "Qoder API",
        "Upstream error response",
        expect.objectContaining({
          requestId: expect.any(String),
          status: 500,
          statusText: "Internal Server Error",
        })
      );

      errorSpy.mockRestore();
    });

    it("returns 503 when network request fails", async () => {
      const logger = await import("../../src/sse/utils/logger.js");
      const errorSpy = vi.spyOn(logger, "error");

      proxyAwareFetch
        .mockResolvedValueOnce(new Response(JSON.stringify({
          id: "user-123",
          securityOauthToken: "token-123",
          expireTime: Date.now() + 60_000,
        }), { status: 200, headers: { "content-type": "application/json" } }))
        .mockRejectedValueOnce(new Error("Network error"));

      const executor = new QoderApiExecutor();
      const credentials = { apiKey: "test-key", providerSpecificData: {} };

      const result = await executor.execute({
        model: "qoder-api/lite",
        body: { messages: [{ role: "user", content: "test" }] },
        credentials,
        provider: "qoder-api",
      });

      expect(result.response.status).toBe(503);
      const errorBody = await result.response.json();
      expect(errorBody.error.message).toBe("Upstream service unavailable");
      expect(errorBody.error.type).toBe("server_error");
      expect(errorBody.error.code).toBe("network_error");

      expect(errorSpy).toHaveBeenCalledWith(
        "Qoder API",
        "Network request failed",
        expect.objectContaining({
          requestId: expect.any(String),
          error: "Network error",
          stack: expect.any(String),
        })
      );

      errorSpy.mockRestore();
    });

    it("logs error when body encoding fails", async () => {
      const logger = await import("../../src/sse/utils/logger.js");
      const errorSpy = vi.spyOn(logger, "error");

      qoderEncodeBody.mockImplementationOnce(() => {
        throw new Error("encoding boom");
      });

      const executor = new QoderApiExecutor();
      const credentials = {
        apiKey: "test-key",
        providerSpecificData: {
          qoderApiSession: {
            userId: "user-123",
            securityOauthToken: "token-123",
            expiresAt: Date.now() + 3600000,
          },
        },
      };

      await executor.execute({
        model: "qoder-api/lite",
        body: { messages: [{ role: "user", content: "test" }] },
        credentials,
        provider: "qoder-api",
      });

      expect(errorSpy).toHaveBeenCalledWith(
        "Qoder API",
        "Failed to encode request body",
        expect.objectContaining({
          requestId: expect.any(String),
          error: expect.any(String),
          stack: expect.any(String),
        })
      );

      errorSpy.mockRestore();
      qoderEncodeBody.mockRestore();
    });
  });
});

// ── Quota Tracker: getUsageForProvider("qoder-api") ────────────────────────

const VALID_QUOTA_SESSION = {
  userId: "user-123",
  securityOauthToken: "oauth-token-abc",
  name: "Test User",
  email: "test@example.com",
  machineId: "machine-1",
  machineToken: "machine-token-1",
  machineType: "linux",
  expiresAt: Date.now() + 3600_000,
};

const ACTIVITY_RESPONSE = {
  code: 0,
  msg: "ok",
  data: {
    activities: [
      {
        type: "MODEL_FREE_QUOTA",
        activityId: "qwen3.7max_200_free_invoke",
        modelName: "Qwen3.7-Max Free Calls",
        modelKeys: ["qmodel_latest"],
        limit: 200,
        used: 2,
        remaining: 198,
        resetAt: 1780848000000,
        eligible: true,
        activityEndAt: 1788192000000,
      },
    ],
    queryAt: 1780845256899,
  },
};

const CREDITS_RESPONSE = {
  userQuota: { total: 500, used: 152, remaining: 348, unit: "credits" },
  orgResourcePackage: { total: 0, used: 0, remaining: 0 },
  expiresAt: 1788192000000,
};

function makeQoderApiConnection(overrides = {}) {
  return {
    provider: "qoder-api",
    apiKey: "pt-test-token",
    providerSpecificData: { qoderApiSession: { ...VALID_QUOTA_SESSION } },
    ...overrides,
  };
}

describe("qoder-api quota tracker (getUsageForProvider)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reuses cached session when valid and fetches both endpoints", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(new Response(JSON.stringify(ACTIVITY_RESPONSE), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(CREDITS_RESPONSE), { status: 200, headers: { "content-type": "application/json" } }));

    const result = await getUsageForProvider(makeQoderApiConnection());

    expect(result.quotas).toBeDefined();
    expect(result.quotas["Qwen3.7-Max Free Calls"]).toEqual({
      used: 2,
      total: 200,
      remaining: 198,
      unit: "requests",
      resetAt: new Date(1780848000000).toISOString(),
      modelKeys: ["qmodel_latest"],
      activityEndAt: new Date(1788192000000).toISOString(),
    });
    expect(result.quotas["Credits (Personal)"]).toEqual({
      used: 152,
      total: 500,
      remaining: 348,
      unit: "credits",
      resetAt: new Date(1788192000000).toISOString(),
    });
  });

  it("filters out non-MODEL_FREE_QUOTA and ineligible activities", async () => {
    const mixed = {
      code: 0,
      data: {
        activities: [
          { type: "PROMO_BANNER", title: "Some promo" },
          ACTIVITY_RESPONSE.data.activities[0],
          { type: "MODEL_FREE_QUOTA", eligible: false, modelName: "Ineligible", limit: 100 },
        ],
        queryAt: Date.now(),
      },
    };
    proxyAwareFetch
      .mockResolvedValueOnce(new Response(JSON.stringify(mixed), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(CREDITS_RESPONSE), { status: 200, headers: { "content-type": "application/json" } }));

    const result = await getUsageForProvider(makeQoderApiConnection());

    expect(result.quotas["Qwen3.7-Max Free Calls"]).toBeDefined();
    expect(result.quotas["Ineligible"]).toBeUndefined();
  });

  it("skips organization credits when total is 0", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(new Response(JSON.stringify(ACTIVITY_RESPONSE), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(CREDITS_RESPONSE), { status: 200, headers: { "content-type": "application/json" } }));

    const result = await getUsageForProvider(makeQoderApiConnection());

    expect(result.quotas["Credits (Personal)"]).toBeDefined();
    expect(result.quotas["Credits (Organization)"]).toBeUndefined();
  });

  it("includes organization credits when total > 0", async () => {
    const creditsWithOrg = {
      ...CREDITS_RESPONSE,
      orgResourcePackage: { total: 1000, used: 200, remaining: 800, unit: "credits" },
    };
    proxyAwareFetch
      .mockResolvedValueOnce(new Response(JSON.stringify(ACTIVITY_RESPONSE), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(creditsWithOrg), { status: 200, headers: { "content-type": "application/json" } }));

    const result = await getUsageForProvider(makeQoderApiConnection());

    expect(result.quotas["Credits (Organization)"]).toEqual({
      used: 200,
      total: 1000,
      remaining: 800,
      unit: "credits",
      resetAt: new Date(1788192000000).toISOString(),
    });
  });

  it("returns activity quotas even when credits endpoint fails", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(new Response(JSON.stringify(ACTIVITY_RESPONSE), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response("forbidden", { status: 403 }));

    const result = await getUsageForProvider(makeQoderApiConnection());

    expect(result.quotas["Qwen3.7-Max Free Calls"]).toBeDefined();
    expect(result.quotas["Credits (Personal)"]).toBeUndefined();
  });

  it("returns credits even when activity endpoint fails", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(new Response("error", { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(CREDITS_RESPONSE), { status: 200, headers: { "content-type": "application/json" } }));

    const result = await getUsageForProvider(makeQoderApiConnection());

    expect(result.quotas["Credits (Personal)"]).toBeDefined();
    expect(result.quotas["Qwen3.7-Max Free Calls"]).toBeUndefined();
  });

  it("returns error message when both endpoints fail", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(new Response("error", { status: 500 }))
      .mockResolvedValueOnce(new Response("error", { status: 500 }));

    const result = await getUsageForProvider(makeQoderApiConnection());

    expect(result.message).toBeDefined();
    expect(result.quotas).toBeUndefined();
  });

  it("returns error when no API key provided", async () => {
    const result = await getUsageForProvider({
      provider: "qoder-api",
      apiKey: null,
      providerSpecificData: {},
    });

    expect(result.message).toContain("no API key");
  });

  it("calls activity endpoint with COSY headers and credits with Bearer", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(new Response(JSON.stringify(ACTIVITY_RESPONSE), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(CREDITS_RESPONSE), { status: 200, headers: { "content-type": "application/json" } }));

    await getUsageForProvider(makeQoderApiConnection());

    expect(buildCosyHeaders).toHaveBeenCalledWith(
      "",
      expect.stringContaining("/algo/api/v2/activity"),
      expect.objectContaining({ userId: "user-123", authToken: "oauth-token-abc" }),
    );

    const creditsCall = proxyAwareFetch.mock.calls[1];
    expect(creditsCall[0]).toContain("quota/usage");
    expect(creditsCall[1].headers.Authorization).toBe("Bearer oauth-token-abc");
  });
});

// ── formatCampaignEndDate ──────────────────────────────────────────────────

describe("formatCampaignEndDate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns null for null/undefined/empty input", () => {
    expect(formatCampaignEndDate(null)).toBeNull();
    expect(formatCampaignEndDate(undefined)).toBeNull();
    expect(formatCampaignEndDate("")).toBeNull();
  });

  it("returns null for invalid date strings", () => {
    expect(formatCampaignEndDate("not-a-date")).toBeNull();
    expect(formatCampaignEndDate("abc123")).toBeNull();
    expect(formatCampaignEndDate("////")).toBeNull();
  });

  it("returns expired for past dates", () => {
    const result = formatCampaignEndDate("2026-06-01T00:00:00.000Z");
    expect(result).toEqual({ label: "Ended", expired: true });
  });

  it("returns urgent label when within 7 days", () => {
    const result = formatCampaignEndDate("2026-06-18T12:00:00.000Z");
    expect(result.expired).toBe(false);
    expect(result.urgent).toBe(true);
    expect(result.label).toContain("left");
    expect(result.label).toContain("Jun 18, 2026");
  });

  it("returns plain date when more than 7 days away", () => {
    const result = formatCampaignEndDate("2026-07-15T12:00:00.000Z");
    expect(result.expired).toBe(false);
    expect(result.urgent).toBe(false);
    expect(result.label).toBe("Jul 15, 2026");
  });

  it("treats exactly now as expired", () => {
    const result = formatCampaignEndDate("2026-06-15T12:00:00.000Z");
    expect(result.expired).toBe(true);
  });
});
