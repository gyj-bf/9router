import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { qoderEncodeBody } from "../../src/lib/qoder/encoding.js";
import {
  exchangeQoderApiToken,
  isQoderApiSessionValid,
  redactQoderApiSession,
} from "../../src/lib/qoder/apiSession.js";

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
    expect(isQoderApiSessionValid({ expiresAt: Date.now() + 120_000 })).toBe(true);
    expect(isQoderApiSessionValid({ expiresAt: Date.now() + 10_000 })).toBe(false);
    expect(isQoderApiSessionValid(null)).toBe(false);
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
  it("builds a Qoder payload preserving system messages, multi-turn history, tools, and tool results", () => {
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
    expect(payload.messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "tool", "user"]);
    expect(payload.messages[4].content).toBe("Continue.");
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
