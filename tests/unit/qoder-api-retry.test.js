import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

vi.mock("../../src/lib/qoder/encoding.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, qoderEncodeBody: vi.fn(actual.qoderEncodeBody) };
});

vi.mock("../../src/lib/qoder/cosy.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, buildCosyHeaders: vi.fn(actual.buildCosyHeaders) };
});

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { QoderApiExecutor, buildQoderApiPayload, wrapQoderApiSSE } from "../../open-sse/executors/qoderApi.js";
import {
  QODER_MAX_RETRIES,
  QODER_RETRY_BASE_DELAY_MS,
  QODER_RETRY_MAX_DELAY_MS,
  QODER_RETRYABLE_STATUSES,
  QODER_RETRY_JITTER,
  QODER_CONNECT_TIMEOUT_MS,
  QODER_PEEK_TIMEOUT_MS,
  QODER_PEEK_BUFFER_CAP,
  QODER_SESSION_TIMEOUT_MS,
  QODER_TEST_TIMEOUT_MS,
  QODER_STALL_TIMEOUT_MS,
  QODER_REQUEST_TIMEOUT_MS,
  QODER_MODEL_CONFIG_MAP,
  QODER_MODEL_MAP,
  QODER_USER_AGENT,
  QODER_DEFAULTS,
  QODER_DEFAULT_REASONING_EFFORT,
  QODER_DEFAULT_MAX_THINKING_TOKENS,
  QODER_BUSINESS_NAME_MAX_LENGTH,
} from "../../src/lib/qoder/constants.js";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Read all text from a ReadableStream response. */
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

/** Build an SSE upstream response with a single Qoder envelope. */
function makeSSEEnvelope(statusCodeValue, body) {
  const encoder = new TextEncoder();
  const frame = `data: ${JSON.stringify({ statusCodeValue, body })}\n\n`;
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

/** Build a 3-level nested queue error body (outer → message → inner message). */
function buildQueueBody3Level(queueData) {
  const innerMsg = JSON.stringify(queueData);
  const middleMsg = JSON.stringify({ message: innerMsg, code: "MIDDLE_CODE" });
  return JSON.stringify({ message: middleMsg, code: "OUTER_CODE" });
}

/** Build a 2-level nested queue error body (outer → message). */
function buildQueueBody2Level(queueData) {
  const middleMsg = JSON.stringify(queueData);
  return JSON.stringify({ message: middleMsg, code: "OUTER_CODE" });
}

/** Create credentials with a valid cached session (skips token exchange). */
function makeCredentials() {
  return {
    apiKey: "test-key",
    providerSpecificData: {
      qoderApiSession: {
        userId: "user-123",
        securityOauthToken: "token-123",
        name: "Test",
        email: "test@test.com",
        machineId: "m-1",
        machineToken: "mt-1",
        machineType: "linux",
        expiresAt: Date.now() + 3_600_000,
      },
    },
  };
}

const EXECUTE_ARGS = {
  model: "qoder-api/lite",
  body: { model: "qoder-api/lite", messages: [{ role: "user", content: "hello" }], stream: true },
  provider: "qoder-api",
};

// ═══════════════════════════════════════════════════════════════════════════
// 1. parseQueueError (tested through wrapQoderApiSSE)
// ═══════════════════════════════════════════════════════════════════════════

describe("parseQueueError (via wrapQoderApiSSE)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-02T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("positive: 3-level nested JSON with queue data", () => {
    it("parses isQueued=true from 3-level nesting and emits queue error chunk", async () => {
      const queueData = {
        isQueued: true,
        serviceAvailable: false,
        code: "QUEUE_FULL",
        modelKey: "qmodel_latest",
        queueCount: 42,
        queueType: "priority",
        waitTime: 180,
      };
      const innerBody = buildQueueBody3Level(queueData);
      const upstream = makeSSEEnvelope(503, innerBody);

      const wrapped = wrapQoderApiSSE(upstream, "qda/qmodel_latest");
      const text = await readStreamText(wrapped);

      expect(text).toContain("[Queue:");
      expect(text).toContain("qmodel_latest");
      expect(text).toContain("priority");
      expect(text).toContain("42 ahead");
      expect(text).toContain("~3min wait"); // ceil(180/60) = 3
      expect(text).toMatch(/data: \[DONE\]/);
    });

    it("parses serviceAvailable=false from 3-level nesting", async () => {
      const queueData = {
        serviceAvailable: false,
        modelKey: "lite",
        queueCount: 5,
        queueType: "standard",
        waitTime: 60,
      };
      const innerBody = buildQueueBody3Level(queueData);
      const upstream = makeSSEEnvelope(503, innerBody);

      const text = await readStreamText(wrapQoderApiSSE(upstream));
      expect(text).toContain("[Queue:");
      expect(text).toContain("standard");
      expect(text).toContain("5 ahead");
    });
  });

  describe("positive: 2-level nested JSON (fallback path)", () => {
    it("parses isQueued=true from 2-level nesting", async () => {
      const queueData = {
        isQueued: true,
        serviceAvailable: false,
        code: "QUEUED",
        modelKey: "ultimate",
        queueCount: 10,
        queueType: "free",
        waitTime: 300,
      };
      const innerBody = buildQueueBody2Level(queueData);
      const upstream = makeSSEEnvelope(503, innerBody);

      const text = await readStreamText(wrapQoderApiSSE(upstream));
      expect(text).toContain("[Queue:");
      expect(text).toContain("ultimate");
      expect(text).toContain("free");
      expect(text).toContain("10 ahead");
      expect(text).toContain("~5min wait"); // ceil(300/60) = 5
    });

    it("parses serviceAvailable=false from 2-level nesting", async () => {
      const queueData = {
        serviceAvailable: false,
        modelKey: "lite",
        queueCount: 0,
        queueType: "standard",
        waitTime: 0,
      };
      const innerBody = buildQueueBody2Level(queueData);
      const upstream = makeSSEEnvelope(503, innerBody);

      const text = await readStreamText(wrapQoderApiSSE(upstream));
      expect(text).toContain("[Queue:");
    });
  });

  describe("negative: null/empty/undefined input", () => {
    it("returns generic error for empty body string", async () => {
      const upstream = makeSSEEnvelope(503, "");
      const text = await readStreamText(wrapQoderApiSSE(upstream));

      expect(text).toContain("[Upstream provider error (code 503)]");
      expect(text).not.toContain("[Queue:");
    });

    it("returns generic error when body is not valid JSON", async () => {
      const upstream = makeSSEEnvelope(503, "not-json-at-all");
      const text = await readStreamText(wrapQoderApiSSE(upstream));

      expect(text).toContain("[Upstream provider error (code 503)]");
      expect(text).not.toContain("[Queue:");
    });
  });

  describe("negative: non-queue error JSON", () => {
    it("returns generic error for normal error JSON without queue fields", async () => {
      const innerBody = JSON.stringify({
        message: JSON.stringify({ error: "rate_limited", retry_after: 30 }),
      });
      const upstream = makeSSEEnvelope(429, innerBody);
      const text = await readStreamText(wrapQoderApiSSE(upstream));

      expect(text).toContain("[Upstream provider error (code 429)]");
      expect(text).not.toContain("[Queue:");
    });

    it("returns generic error when isQueued is false", async () => {
      const queueData = { isQueued: false, serviceAvailable: true };
      const innerBody = buildQueueBody2Level(queueData);
      const upstream = makeSSEEnvelope(503, innerBody);

      const text = await readStreamText(wrapQoderApiSSE(upstream));
      expect(text).toContain("[Upstream provider error (code 503)]");
      expect(text).not.toContain("[Queue:");
    });
  });

  describe("negative: malformed JSON", () => {
    it("returns generic error when outer JSON is valid but message is malformed", async () => {
      const innerBody = JSON.stringify({ message: "{broken json" });
      const upstream = makeSSEEnvelope(503, innerBody);
      const text = await readStreamText(wrapQoderApiSSE(upstream));

      expect(text).toContain("[Upstream provider error (code 503)]");
      expect(text).not.toContain("[Queue:");
    });

    it("returns generic error when 2nd level is valid but 3rd level is malformed", async () => {
      const innerBody = JSON.stringify({
        message: JSON.stringify({ message: "{not-valid-json" }),
      });
      const upstream = makeSSEEnvelope(503, innerBody);
      const text = await readStreamText(wrapQoderApiSSE(upstream));

      expect(text).toContain("[Upstream provider error (code 503)]");
      expect(text).not.toContain("[Queue:");
    });
  });

  describe("edge: missing optional fields", () => {
    it("defaults queueCount to 0 and queueType to 'unknown' when missing", async () => {
      const queueData = { isQueued: true };
      const innerBody = buildQueueBody2Level(queueData);
      const upstream = makeSSEEnvelope(503, innerBody);

      const text = await readStreamText(wrapQoderApiSSE(upstream));
      expect(text).toContain("[Queue:");
      expect(text).toContain("unknown");
      expect(text).toContain("0 ahead");
      expect(text).toContain("unpredictable wait");
    });

    it("defaults waitTime to 0 when missing", async () => {
      const queueData = { isQueued: true, queueCount: 3, queueType: "vip" };
      const innerBody = buildQueueBody2Level(queueData);
      const upstream = makeSSEEnvelope(503, innerBody);

      const text = await readStreamText(wrapQoderApiSSE(upstream));
      expect(text).toContain("unpredictable wait");
    });

    it("falls back to model parameter when modelKey is missing", async () => {
      const queueData = { isQueued: true, queueCount: 1, queueType: "std" };
      const innerBody = buildQueueBody2Level(queueData);
      const upstream = makeSSEEnvelope(503, innerBody);

      const text = await readStreamText(wrapQoderApiSSE(upstream, "qda/auto"));
      expect(text).toContain("[Queue:");
      expect(text).toContain("qda/auto");
    });
  });

  describe("edge: extra nested levels", () => {
    it("returns generic error when queue data is buried too deep (4 levels)", async () => {
      const deepData = JSON.stringify({ isQueued: true, queueCount: 99 });
      const level3 = JSON.stringify({ message: deepData });
      const level2 = JSON.stringify({ message: level3 });
      const innerBody = JSON.stringify({ message: level2 });

      const upstream = makeSSEEnvelope(503, innerBody);
      const text = await readStreamText(wrapQoderApiSSE(upstream));

      expect(text).toContain("[Upstream provider error (code 503)]");
      expect(text).not.toContain("[Queue:");
    });
  });

  describe("edge: message field is not a string", () => {
    it("returns null when outer.message is an object (not string)", async () => {
      const innerBody = JSON.stringify({ message: { nested: true }, code: "X" });
      const upstream = makeSSEEnvelope(503, innerBody);
      const text = await readStreamText(wrapQoderApiSSE(upstream));

      expect(text).toContain("[Upstream provider error (code 503)]");
      expect(text).not.toContain("[Queue:");
    });
  });

  describe("edge: body field fallback", () => {
    it("uses outer.body when outer.message is missing", async () => {
      const queueData = { isQueued: true, queueCount: 7, queueType: "fallback" };
      const innerBody = JSON.stringify({ body: JSON.stringify(queueData), code: "OUTER" });
      const upstream = makeSSEEnvelope(503, innerBody);

      const text = await readStreamText(wrapQoderApiSSE(upstream));
      expect(text).toContain("[Queue:");
      expect(text).toContain("fallback");
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Retry logic in execute()
// ═══════════════════════════════════════════════════════════════════════════

describe("qoder-api retry logic", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-02T00:00:00.000Z"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("positive: first attempt succeeds (no retry)", () => {
    it("returns 200 on first successful attempt without retrying", async () => {
      proxyAwareFetch.mockResolvedValueOnce(
        new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }),
      );

      const executor = new QoderApiExecutor();
      const resultPromise = executor.execute({
        ...EXECUTE_ARGS,
        credentials: makeCredentials(),
      });
      // advanceTimersByTimeAsync(0) flushes fake-timer microtasks (connect-timeout setTimeout)
      await vi.advanceTimersByTimeAsync(0);
      const result = await resultPromise;

      expect(result.response.status).toBe(200);
      // Only 1 call (no token exchange because session is cached)
      expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("positive: first attempt 504, second attempt succeeds", () => {
    it("retries on 504 and succeeds on second attempt", async () => {
      proxyAwareFetch
        .mockResolvedValueOnce(new Response("Gateway Timeout", { status: 504, statusText: "Gateway Timeout" }))
        .mockResolvedValueOnce(
          new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }),
        );

      const executor = new QoderApiExecutor();
      const resultPromise = executor.execute({
        ...EXECUTE_ARGS,
        credentials: makeCredentials(),
      });

      // Advance past 1s backoff
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await resultPromise;

      expect(result.response.status).toBe(200);
      expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe("positive: all retries fail with 504 → returns 502", () => {
    it("exhausts all retries and returns 502", async () => {
      for (let i = 0; i <= QODER_MAX_RETRIES; i++) {
        proxyAwareFetch.mockResolvedValueOnce(
          new Response("Gateway Timeout", { status: 504, statusText: "Gateway Timeout" }),
        );
      }

      const executor = new QoderApiExecutor();
      const resultPromise = executor.execute({
        ...EXECUTE_ARGS,
        credentials: makeCredentials(),
      });

      await vi.advanceTimersByTimeAsync(550);
      await vi.advanceTimersByTimeAsync(1_100);
      await vi.advanceTimersByTimeAsync(2_200);
      await vi.advanceTimersByTimeAsync(3_300);
      await vi.advanceTimersByTimeAsync(3_300);

      const result = await resultPromise;

      expect(result.response.status).toBe(502);
      const body = await result.response.json();
      expect(body.error.type).toBe("upstream_error");
      expect(body.error.message).toContain("504");
      expect(proxyAwareFetch).toHaveBeenCalledTimes(QODER_MAX_RETRIES + 1);
    });
  });

  describe("positive: network error on first attempt, succeeds on retry", () => {
    it("retries after network error and succeeds", async () => {
      proxyAwareFetch
        .mockRejectedValueOnce(new Error("ECONNRESET"))
        .mockResolvedValueOnce(
          new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }),
        );

      const executor = new QoderApiExecutor();
      const resultPromise = executor.execute({
        ...EXECUTE_ARGS,
        credentials: makeCredentials(),
      });

      await vi.advanceTimersByTimeAsync(1_000);
      const result = await resultPromise;

      expect(result.response.status).toBe(200);
      expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe("positive: all network errors → returns 502", () => {
    it("exhausts retries with network errors and returns 502", async () => {
      for (let i = 0; i <= QODER_MAX_RETRIES; i++) {
        proxyAwareFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      }

      const executor = new QoderApiExecutor();
      const resultPromise = executor.execute({
        ...EXECUTE_ARGS,
        credentials: makeCredentials(),
      });

      await vi.advanceTimersByTimeAsync(550);
      await vi.advanceTimersByTimeAsync(1_100);
      await vi.advanceTimersByTimeAsync(2_200);
      await vi.advanceTimersByTimeAsync(3_300);
      await vi.advanceTimersByTimeAsync(3_300);

      const result = await resultPromise;

      expect(result.response.status).toBe(502);
      const body = await result.response.json();
      expect(body.error.type).toBe("upstream_error");
      expect(proxyAwareFetch).toHaveBeenCalledTimes(QODER_MAX_RETRIES + 1);
    });
  });

  describe("negative: 400 error → no retry, immediate return", () => {
    it("does not retry on 400 Bad Request", async () => {
      proxyAwareFetch.mockResolvedValueOnce(
        new Response("Bad Request", { status: 400, statusText: "Bad Request" }),
      );

      const executor = new QoderApiExecutor();
      const resultPromise = executor.execute({
        ...EXECUTE_ARGS,
        credentials: makeCredentials(),
      });
      await vi.advanceTimersByTimeAsync(0);
      const result = await resultPromise;

      expect(result.response.status).toBe(400);
      expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("negative: 401 error → no retry, immediate return", () => {
    it("does not retry on 401 Unauthorized", async () => {
      proxyAwareFetch.mockResolvedValueOnce(
        new Response("Unauthorized", { status: 401, statusText: "Unauthorized" }),
      );

      const executor = new QoderApiExecutor();
      const resultPromise = executor.execute({
        ...EXECUTE_ARGS,
        credentials: makeCredentials(),
      });
      await vi.advanceTimersByTimeAsync(0);
      const result = await resultPromise;

      expect(result.response.status).toBe(401);
      expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("negative: 403 error → no retry, immediate return", () => {
    it("does not retry on 403 Forbidden", async () => {
      proxyAwareFetch.mockResolvedValueOnce(
        new Response("Forbidden", { status: 403, statusText: "Forbidden" }),
      );

      const executor = new QoderApiExecutor();
      const resultPromise = executor.execute({
        ...EXECUTE_ARGS,
        credentials: makeCredentials(),
      });
      await vi.advanceTimersByTimeAsync(0);
      const result = await resultPromise;

      expect(result.response.status).toBe(403);
      expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("edge: retries on 502", () => {
    it("retries on 502 Bad Gateway", async () => {
      proxyAwareFetch
        .mockResolvedValueOnce(new Response("Bad Gateway", { status: 502, statusText: "Bad Gateway" }))
        .mockResolvedValueOnce(
          new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }),
        );

      const executor = new QoderApiExecutor();
      const resultPromise = executor.execute({
        ...EXECUTE_ARGS,
        credentials: makeCredentials(),
      });

      await vi.advanceTimersByTimeAsync(1_000);
      const result = await resultPromise;

      expect(result.response.status).toBe(200);
      expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe("edge: retries on 503", () => {
    it("retries on 503 Service Unavailable", async () => {
      proxyAwareFetch
        .mockResolvedValueOnce(new Response("Service Unavailable", { status: 503, statusText: "Service Unavailable" }))
        .mockResolvedValueOnce(
          new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }),
        );

      const executor = new QoderApiExecutor();
      const resultPromise = executor.execute({
        ...EXECUTE_ARGS,
        credentials: makeCredentials(),
      });

      await vi.advanceTimersByTimeAsync(1_000);
      const result = await resultPromise;

      expect(result.response.status).toBe(200);
      expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe("edge: mixed retryable errors across attempts", () => {
    it("retries through 504 → network error → 502 → success", async () => {
      proxyAwareFetch
        .mockResolvedValueOnce(new Response("Gateway Timeout", { status: 504, statusText: "Gateway Timeout" }))
        .mockRejectedValueOnce(new Error("ECONNRESET"))
        .mockResolvedValueOnce(new Response("Bad Gateway", { status: 502, statusText: "Bad Gateway" }))
        .mockResolvedValueOnce(
          new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }),
        );

      const executor = new QoderApiExecutor();
      const resultPromise = executor.execute({
        ...EXECUTE_ARGS,
        credentials: makeCredentials(),
      });

      // Backoffs: ~500-550ms, ~1000-1100ms, ~2000-2200ms
      await vi.advanceTimersByTimeAsync(550);
      await vi.advanceTimersByTimeAsync(1_100);
      await vi.advanceTimersByTimeAsync(2_200);

      const result = await resultPromise;
      expect(result.response.status).toBe(200);
      expect(proxyAwareFetch).toHaveBeenCalledTimes(4);
    });
  });

  describe("edge: last retry attempt returns non-retryable error", () => {
    it("returns the non-retryable error on the last attempt", async () => {
      // First 3 attempts: 504 (retryable), last attempt: 400 (non-retryable)
      proxyAwareFetch
        .mockResolvedValueOnce(new Response("Gateway Timeout", { status: 504 }))
        .mockResolvedValueOnce(new Response("Gateway Timeout", { status: 504 }))
        .mockResolvedValueOnce(new Response("Gateway Timeout", { status: 504 }))
        .mockResolvedValueOnce(new Response("Bad Request", { status: 400, statusText: "Bad Request" }));

      const executor = new QoderApiExecutor();
      const resultPromise = executor.execute({
        ...EXECUTE_ARGS,
        credentials: makeCredentials(),
      });

      await vi.advanceTimersByTimeAsync(550);
      await vi.advanceTimersByTimeAsync(1_100);
      await vi.advanceTimersByTimeAsync(2_200);

      const result = await resultPromise;
      expect(result.response.status).toBe(400);
      expect(proxyAwareFetch).toHaveBeenCalledTimes(4);
    });
  });

  describe("edge: 500 is NOT retryable", () => {
    it("does not retry on 500 Internal Server Error", async () => {
      proxyAwareFetch.mockResolvedValueOnce(
        new Response("Internal Server Error", { status: 500, statusText: "Internal Server Error" }),
      );

      const executor = new QoderApiExecutor();
      const resultPromise = executor.execute({
        ...EXECUTE_ARGS,
        credentials: makeCredentials(),
      });
      await vi.advanceTimersByTimeAsync(0);
      const result = await resultPromise;

      expect(result.response.status).toBe(502);
      expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Backoff timing
// ═══════════════════════════════════════════════════════════════════════════

describe("qoder-api backoff timing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-02T00:00:00.000Z"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("uses exponential backoff with jitter: ~500ms, ~1000ms, ~2000ms, ~3000ms, ~3000ms between retries", async () => {
    for (let i = 0; i <= QODER_MAX_RETRIES; i++) {
      proxyAwareFetch.mockResolvedValueOnce(
        new Response("Gateway Timeout", { status: 504, statusText: "Gateway Timeout" }),
      );
    }

    const executor = new QoderApiExecutor();
    const resultPromise = executor.execute({
      ...EXECUTE_ARGS,
      credentials: makeCredentials(),
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(550);
    await vi.advanceTimersByTimeAsync(0);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1_100);
    await vi.advanceTimersByTimeAsync(0);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(2_200);
    await vi.advanceTimersByTimeAsync(0);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(4);

    await vi.advanceTimersByTimeAsync(3_300);
    await vi.advanceTimersByTimeAsync(0);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(5);

    await vi.advanceTimersByTimeAsync(3_300);
    await vi.advanceTimersByTimeAsync(0);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(6);

    const result = await resultPromise;
    expect(result.response.status).toBe(502);
  });

  it("does not backoff before the first attempt", async () => {
    proxyAwareFetch.mockResolvedValueOnce(
      new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }),
    );

    const executor = new QoderApiExecutor();
    const resultPromise = executor.execute({
      ...EXECUTE_ARGS,
      credentials: makeCredentials(),
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);

    const result = await resultPromise;
    expect(result.response.status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Signal passthrough
// ═══════════════════════════════════════════════════════════════════════════

describe("qoder-api signal passthrough", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes signal to proxyAwareFetch", async () => {
    proxyAwareFetch.mockResolvedValueOnce(
      new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }),
    );

    const clientCtrl = new AbortController();
    const executor = new QoderApiExecutor();
    const result = await executor.execute({
      ...EXECUTE_ARGS,
      credentials: makeCredentials(),
      signal: clientCtrl.signal,
    });

    expect(result.response.status).toBe(200);
    const fetchOptions = proxyAwareFetch.mock.calls[0][1];
    expect(fetchOptions.signal).toBeDefined();
    expect(fetchOptions.signal).toBeInstanceOf(AbortSignal);
  });

  it("creates a signal even when no client signal is provided", async () => {
    proxyAwareFetch.mockResolvedValueOnce(
      new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }),
    );

    const executor = new QoderApiExecutor();
    await executor.execute({
      ...EXECUTE_ARGS,
      credentials: makeCredentials(),
    });

    const fetchOptions = proxyAwareFetch.mock.calls[0][1];
    expect(fetchOptions.signal).toBeDefined();
    expect(fetchOptions.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns 499 when client abort signal fires during fetch", async () => {
    const clientCtrl = new AbortController();

    proxyAwareFetch.mockImplementationOnce((_url, opts) => {
      return new Promise((_resolve, reject) => {
        if (opts.signal.aborted) {
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          reject(err);
          return;
        }
        opts.signal.addEventListener("abort", () => {
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });

    const executor = new QoderApiExecutor();
    const resultPromise = executor.execute({
      ...EXECUTE_ARGS,
      credentials: makeCredentials(),
      signal: clientCtrl.signal,
    });

    await new Promise(resolve => setTimeout(resolve, 10));
    clientCtrl.abort();

    const result = await resultPromise;
    expect(result.response.status).toBe(499);
    const body = await result.response.json();
    expect(body.error.code).toBe("aborted");
    expect(body.error.type).toBe("client_error");
  });

  it("returns 499 when client aborts during backoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-02T00:00:00.000Z"));

    const clientCtrl = new AbortController();

    proxyAwareFetch.mockResolvedValueOnce(
      new Response("Gateway Timeout", { status: 504, statusText: "Gateway Timeout" }),
    );

    const executor = new QoderApiExecutor();
    const resultPromise = executor.execute({
      ...EXECUTE_ARGS,
      credentials: makeCredentials(),
      signal: clientCtrl.signal,
    });

    await vi.advanceTimersByTimeAsync(500);
    clientCtrl.abort();
    await vi.advanceTimersByTimeAsync(600);

    const result = await resultPromise;
    expect(result.response.status).toBe(499);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it("AbortSignal.any combines client signal + connect timeout", async () => {
    proxyAwareFetch.mockResolvedValueOnce(
      new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }),
    );

    const clientCtrl = new AbortController();
    const executor = new QoderApiExecutor();
    await executor.execute({
      ...EXECUTE_ARGS,
      credentials: makeCredentials(),
      signal: clientCtrl.signal,
    });

    const fetchOptions = proxyAwareFetch.mock.calls[0][1];
    expect(fetchOptions.signal).toBeInstanceOf(AbortSignal);
    expect(fetchOptions.signal).not.toBe(clientCtrl.signal);
  });

  it("uses connect timeout signal only when no client signal provided", async () => {
    proxyAwareFetch.mockResolvedValueOnce(
      new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }),
    );

    const executor = new QoderApiExecutor();
    await executor.execute({
      ...EXECUTE_ARGS,
      credentials: makeCredentials(),
    });

    const fetchOptions = proxyAwareFetch.mock.calls[0][1];
    expect(fetchOptions.signal).toBeInstanceOf(AbortSignal);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Constants validation
// ═══════════════════════════════════════════════════════════════════════════

describe("qoder-api retry constants", () => {
  it("QODER_MAX_RETRIES is 5", () => {
    expect(QODER_MAX_RETRIES).toBe(5);
  });

  it("QODER_RETRYABLE_STATUSES contains 502, 503, 504", () => {
    expect(QODER_RETRYABLE_STATUSES).toBeInstanceOf(Set);
    expect(QODER_RETRYABLE_STATUSES.has(502)).toBe(true);
    expect(QODER_RETRYABLE_STATUSES.has(503)).toBe(true);
    expect(QODER_RETRYABLE_STATUSES.has(504)).toBe(true);
    expect(QODER_RETRYABLE_STATUSES.size).toBe(3);
  });

  it("QODER_RETRYABLE_STATUSES does NOT contain 400, 401, 403, 500", () => {
    expect(QODER_RETRYABLE_STATUSES.has(400)).toBe(false);
    expect(QODER_RETRYABLE_STATUSES.has(401)).toBe(false);
    expect(QODER_RETRYABLE_STATUSES.has(403)).toBe(false);
    expect(QODER_RETRYABLE_STATUSES.has(500)).toBe(false);
  });

  it("QODER_CONNECT_TIMEOUT_MS is 30 seconds", () => {
    expect(QODER_CONNECT_TIMEOUT_MS).toBe(30_000);
  });

  it("QODER_PEEK_TIMEOUT_MS is 10 seconds", () => {
    expect(QODER_PEEK_TIMEOUT_MS).toBe(10_000);
  });

  it("QODER_PEEK_BUFFER_CAP is 64KB", () => {
    expect(QODER_PEEK_BUFFER_CAP).toBe(65_536);
  });

  it("QODER_SESSION_TIMEOUT_MS is 15 seconds", () => {
    expect(QODER_SESSION_TIMEOUT_MS).toBe(15_000);
  });

  it("QODER_TEST_TIMEOUT_MS is 15 seconds", () => {
    expect(QODER_TEST_TIMEOUT_MS).toBe(15_000);
  });

  it("QODER_STALL_TIMEOUT_MS is 60 seconds", () => {
    expect(QODER_STALL_TIMEOUT_MS).toBe(60_000);
  });

  it("QODER_REQUEST_TIMEOUT_MS is 120 seconds", () => {
    expect(QODER_REQUEST_TIMEOUT_MS).toBe(120_000);
  });

  it("QODER_RETRY_JITTER is 0.1 (10%)", () => {
    expect(QODER_RETRY_JITTER).toBe(0.1);
  });

  it("DEFAULT_REASONING_EFFORT is 'max'", () => {
    expect(QODER_DEFAULT_REASONING_EFFORT).toBe("max");
  });

  it("DEFAULT_MAX_THINKING_TOKENS is 49153", () => {
    expect(QODER_DEFAULT_MAX_THINKING_TOKENS).toBe(49153);
  });

  it("QODER_BUSINESS_NAME_MAX_LENGTH is 100", () => {
    expect(QODER_BUSINESS_NAME_MAX_LENGTH).toBe(100);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. peekFirstFrame — queue error detection before streaming
// ═══════════════════════════════════════════════════════════════════════════

describe("qoder-api peekFirstFrame (queue error → fallback)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-02T00:00:00.000Z"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function makeStreamingResponse(frames) {
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream({
        start(controller) {
          for (const frame of frames) {
            controller.enqueue(encoder.encode(frame));
          }
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  }

  it("returns 503 when first frame is a queue error → triggers account fallback", async () => {
    const queueData = {
      isQueued: true,
      serviceAvailable: false,
      modelKey: "qmodel_latest",
      queueCount: 56,
      queueType: "slow",
      waitTime: 18254,
    };
    const innerBody = buildQueueBody3Level(queueData);
    const sseFrame = `data: ${JSON.stringify({ statusCodeValue: 403, body: innerBody })}\n\n`;

    proxyAwareFetch.mockResolvedValueOnce(makeStreamingResponse([sseFrame]));

    const executor = new QoderApiExecutor();
    const resultPromise = executor.execute({
      ...EXECUTE_ARGS,
      credentials: makeCredentials(),
    });
    await vi.advanceTimersByTimeAsync(0);
    const result = await resultPromise;

    expect(result.response.status).toBe(503);
    const body = await result.response.json();
    expect(body.error.message).toContain("queued");
    expect(body.error.message).toContain("56 ahead");
    expect(body.error.code).toBe("service_unavailable");
  });

  it("returns 502 when first frame is a non-queue upstream error", async () => {
    const errorBody = JSON.stringify({ error: "internal_error" });
    const sseFrame = `data: ${JSON.stringify({ statusCodeValue: 500, body: errorBody })}\n\n`;

    proxyAwareFetch.mockResolvedValueOnce(makeStreamingResponse([sseFrame]));

    const executor = new QoderApiExecutor();
    const resultPromise = executor.execute({
      ...EXECUTE_ARGS,
      credentials: makeCredentials(),
    });
    await vi.advanceTimersByTimeAsync(0);
    const result = await resultPromise;

    expect(result.response.status).toBe(502);
    const body = await result.response.json();
    expect(body.error.message).toContain("500");
  });

  it("passes through normal first frame to wrapQoderApiSSE", async () => {
    const normalChunk = JSON.stringify({ choices: [{ delta: { content: "Hello" }, finish_reason: null }] });
    const sseFrame = `data: ${JSON.stringify({ statusCodeValue: 200, body: normalChunk })}\n\ndata: [DONE]\n\n`;

    proxyAwareFetch.mockResolvedValueOnce(makeStreamingResponse([sseFrame]));

    const executor = new QoderApiExecutor();
    const resultPromise = executor.execute({
      ...EXECUTE_ARGS,
      credentials: makeCredentials(),
    });
    await vi.advanceTimersByTimeAsync(0);
    const result = await resultPromise;

    expect(result.response.status).toBe(200);
  });

  it("queue error with 2-level nesting also triggers fallback", async () => {
    const queueData = { isQueued: true, queueCount: 10, queueType: "fast", waitTime: 60 };
    const innerBody = buildQueueBody2Level(queueData);
    const sseFrame = `data: ${JSON.stringify({ statusCodeValue: 403, body: innerBody })}\n\n`;

    proxyAwareFetch.mockResolvedValueOnce(makeStreamingResponse([sseFrame]));

    const executor = new QoderApiExecutor();
    const resultPromise = executor.execute({
      ...EXECUTE_ARGS,
      credentials: makeCredentials(),
    });
    await vi.advanceTimersByTimeAsync(0);
    const result = await resultPromise;

    expect(result.response.status).toBe(503);
    const body = await result.response.json();
    expect(body.error.message).toContain("10 ahead");
  });

  it("does not leak timers when peek succeeds", async () => {
    const normalChunk = JSON.stringify({ choices: [{ delta: { content: "Hi" }, finish_reason: null }] });
    const sseFrame = `data: ${JSON.stringify({ statusCodeValue: 200, body: normalChunk })}\n\ndata: [DONE]\n\n`;

    proxyAwareFetch.mockResolvedValueOnce(makeStreamingResponse([sseFrame]));

    const executor = new QoderApiExecutor();
    const resultPromise = executor.execute({
      ...EXECUTE_ARGS,
      credentials: makeCredentials(),
    });
    await vi.advanceTimersByTimeAsync(0);
    const result = await resultPromise;

    expect(result.response.status).toBe(200);
    await vi.advanceTimersByTimeAsync(QODER_PEEK_TIMEOUT_MS + 1000);

    vi.useRealTimers();
  });
});

// ─── QODER_MODEL_CONFIG_MAP validation ─────────────────────────────────────

describe("QODER_MODEL_CONFIG_MAP validation", () => {
  it("contains all models from QODER_MODEL_MAP", () => {
    for (const key of Object.keys(QODER_MODEL_MAP)) {
      expect(QODER_MODEL_CONFIG_MAP).toHaveProperty(key);
    }
  });

  it("all configs have required fields", () => {
    for (const [key, config] of Object.entries(QODER_MODEL_CONFIG_MAP)) {
      expect(config).toHaveProperty("display_name");
      expect(config).toHaveProperty("is_reasoning");
      expect(config).toHaveProperty("is_vl");
      expect(config).toHaveProperty("format");
      expect(config).toHaveProperty("source");
      expect(config).toHaveProperty("max_input_tokens");
      expect(typeof config.display_name).toBe("string");
      expect(typeof config.is_reasoning).toBe("boolean");
      expect(typeof config.is_vl).toBe("boolean");
      expect(config.max_input_tokens).toBeGreaterThan(0);
    }
  });

  it("reasoning models are correctly marked", () => {
    expect(QODER_MODEL_CONFIG_MAP.dmodel.is_reasoning).toBe(true);
    expect(QODER_MODEL_CONFIG_MAP.dfmodel.is_reasoning).toBe(true);
    expect(QODER_MODEL_CONFIG_MAP.gm51model.is_reasoning).toBe(true);
    expect(QODER_MODEL_CONFIG_MAP.qmodel_latest.is_reasoning).toBe(false);
    expect(QODER_MODEL_CONFIG_MAP.kmodel.is_reasoning).toBe(false);
  });

  it("display names are up to date", () => {
    expect(QODER_MODEL_CONFIG_MAP.dfmodel.display_name).toBe("DeepSeek-V4-Flash");
    expect(QODER_MODEL_CONFIG_MAP.dmodel.display_name).toBe("DeepSeek-V4-Pro");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Reactive model-not-enabled detection (via peekFirstFrame)
// ═══════════════════════════════════════════════════════════════════════════

describe("qoder-api reactive model-not-enabled detection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-02T00:00:00.000Z"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function makeStreamingResponse(frames) {
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream({
        start(controller) {
          for (const frame of frames) {
            controller.enqueue(encoder.encode(frame));
          }
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  }

  it("returns 403 when model is not enabled (reactive)", async () => {
    const errorBody = JSON.stringify({ code: "model_not_enabled", message: "Model 'ultimate' is not enabled for this account" });
    const sseFrame = `data: ${JSON.stringify({ statusCodeValue: 403, body: errorBody })}\n\n`;

    proxyAwareFetch.mockResolvedValueOnce(makeStreamingResponse([sseFrame]));

    const executor = new QoderApiExecutor();
    const resultPromise = executor.execute({
      ...EXECUTE_ARGS,
      model: "qoder-api/ultimate",
      body: { model: "qoder-api/ultimate", messages: [{ role: "user", content: "hello" }], stream: true },
      credentials: makeCredentials(),
    });
    await vi.advanceTimersByTimeAsync(0);
    const result = await resultPromise;

    expect(result.response.status).toBe(403);
    const body = await result.response.json();
    expect(body.error.type).toBe("model_not_enabled");
    expect(body.error.message).toContain("not enabled");
    expect(body.error.message).toContain("qmodel_latest");
  });

  it("returns 403 for 403 with 'not available for' pattern", async () => {
    const errorBody = JSON.stringify({ message: "This model is not available for your plan tier" });
    const sseFrame = `data: ${JSON.stringify({ statusCodeValue: 403, body: errorBody })}\n\n`;

    proxyAwareFetch.mockResolvedValueOnce(makeStreamingResponse([sseFrame]));

    const executor = new QoderApiExecutor();
    const resultPromise = executor.execute({
      ...EXECUTE_ARGS,
      credentials: makeCredentials(),
    });
    await vi.advanceTimersByTimeAsync(0);
    const result = await resultPromise;

    expect(result.response.status).toBe(403);
    const body = await result.response.json();
    expect(body.error.type).toBe("model_not_enabled");
  });

  it("returns generic 502 for non-model 403 errors", async () => {
    const errorBody = JSON.stringify({ message: "Forbidden access" });
    const sseFrame = `data: ${JSON.stringify({ statusCodeValue: 403, body: errorBody })}\n\n`;

    proxyAwareFetch.mockResolvedValueOnce(makeStreamingResponse([sseFrame]));

    const executor = new QoderApiExecutor();
    const resultPromise = executor.execute({
      ...EXECUTE_ARGS,
      credentials: makeCredentials(),
    });
    await vi.advanceTimersByTimeAsync(0);
    const result = await resultPromise;

    expect(result.response.status).toBe(502);
  });

  it("403 model-not-enabled takes priority over queue error (both patterns present)", async () => {
    const queueMsg = JSON.stringify({ isQueued: true, queueCount: 10, queueType: "slow", waitTime: 600 });
    const errorBody = JSON.stringify({ code: "model_not_enabled", message: queueMsg });
    const sseFrame = `data: ${JSON.stringify({ statusCodeValue: 403, body: errorBody })}\n\n`;

    proxyAwareFetch.mockResolvedValueOnce(makeStreamingResponse([sseFrame]));

    const executor = new QoderApiExecutor();
    const resultPromise = executor.execute({
      ...EXECUTE_ARGS,
      credentials: makeCredentials(),
    });
    await vi.advanceTimersByTimeAsync(0);
    const result = await resultPromise;

    expect(result.response.status).toBe(403);
    const body = await result.response.json();
    expect(body.error.type).toBe("model_not_enabled");
  });

  it("403 with queue error (isQueued: true) is NOT detected as model-not-enabled", async () => {
    const queueData = { isQueued: true, serviceAvailable: false, queueCount: 10, queueType: "fast", waitTime: 60 };
    const innerBody = buildQueueBody2Level(queueData);
    const sseFrame = `data: ${JSON.stringify({ statusCodeValue: 403, body: innerBody })}\n\n`;

    proxyAwareFetch.mockResolvedValueOnce(makeStreamingResponse([sseFrame]));

    const executor = new QoderApiExecutor();
    const resultPromise = executor.execute({
      ...EXECUTE_ARGS,
      credentials: makeCredentials(),
    });
    await vi.advanceTimersByTimeAsync(0);
    const result = await resultPromise;

    expect(result.response.status).toBe(503);
    const body = await result.response.json();
    expect(body.error.code).toBe("service_unavailable");
    expect(body.error.message).toContain("queued");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. parseModelNotEnabledError edge cases (via wrapQoderApiSSE)
// ═══════════════════════════════════════════════════════════════════════════

describe("parseModelNotEnabledError edge cases (via wrapQoderApiSSE)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-02T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns null for empty body → generic error, not model-not-enabled", async () => {
    const upstream = makeSSEEnvelope(403, "");
    const text = await readStreamText(wrapQoderApiSSE(upstream));

    expect(text).toContain("[Upstream provider error (code 403)]");
    expect(text).not.toContain("Model not enabled for this account");
  });

  it("returns null for non-JSON body → generic error", async () => {
    const upstream = makeSSEEnvelope(403, "this is not json at all");
    const text = await readStreamText(wrapQoderApiSSE(upstream));

    expect(text).toContain("[Upstream provider error (code 403)]");
    expect(text).not.toContain("Model not enabled for this account");
  });

  it("403 with generic 'Forbidden' message does NOT match model-not-enabled", async () => {
    const errorBody = JSON.stringify({ message: "Forbidden" });
    const upstream = makeSSEEnvelope(403, errorBody);
    const text = await readStreamText(wrapQoderApiSSE(upstream));

    expect(text).toContain("[Upstream provider error (code 403)]");
    expect(text).not.toContain("Model not enabled for this account");
    expect(text).not.toContain("[Queue:");
  });

  it("403 with 'not enabled' in nested error.message matches", async () => {
    const errorBody = JSON.stringify({ error: { message: "This model is not enabled for your account" } });
    const upstream = makeSSEEnvelope(403, errorBody);
    const text = await readStreamText(wrapQoderApiSSE(upstream));

    expect(text).toContain("Model not enabled for this account");
    expect(text).toContain("qmodel_latest");
    expect(text).toMatch(/data: \[DONE\]/);
  });

  it("403 with 'UPGRADE your plan' (uppercase) matches (case-insensitive)", async () => {
    const errorBody = JSON.stringify({ message: "UPGRADE your plan to access this model" });
    const upstream = makeSSEEnvelope(403, errorBody);
    const text = await readStreamText(wrapQoderApiSSE(upstream));

    expect(text).toContain("Model not enabled for this account");
    expect(text).toMatch(/data: \[DONE\]/);
  });

  it("403 with code 'model_not_enabled' but empty message matches", async () => {
    const errorBody = JSON.stringify({ code: "model_not_enabled", message: "" });
    const upstream = makeSSEEnvelope(403, errorBody);
    const text = await readStreamText(wrapQoderApiSSE(upstream));

    expect(text).toContain("Model not enabled for this account");
    expect(text).toMatch(/data: \[DONE\]/);
  });

  it("500 status with 'not enabled' message does NOT match (only 403)", async () => {
    const errorBody = JSON.stringify({ message: "Model is not enabled for this account" });
    const upstream = makeSSEEnvelope(500, errorBody);
    const text = await readStreamText(wrapQoderApiSSE(upstream));

    expect(text).toContain("[Upstream provider error (code 500)]");
    expect(text).not.toContain("Model not enabled for this account");
  });

  it("mid-stream 403 model-not-enabled emits error chunk after normal content", async () => {
    const normalBody = JSON.stringify({ choices: [{ delta: { content: "Hello" }, finish_reason: null }] });
    const errorBody = JSON.stringify({ code: "model_not_enabled", message: "Model not enabled" });

    const normalFrame = `data: ${JSON.stringify({ statusCodeValue: 200, body: normalBody })}\n\n`;
    const errorFrame = `data: ${JSON.stringify({ statusCodeValue: 403, body: errorBody })}\n\n`;

    const encoder = new TextEncoder();
    const upstream = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(normalFrame));
          controller.enqueue(encoder.encode(errorFrame));
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );

    const text = await readStreamText(wrapQoderApiSSE(upstream, "qoder-api/ultimate"));

    expect(text).toContain("Hello");
    expect(text).toContain("Model not enabled for this account");
    expect(text).toContain("qmodel_latest");
    expect(text).toMatch(/data: \[DONE\]/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. buildQoderApiPayload — reasoning_effort & max_thinking_tokens
// ═══════════════════════════════════════════════════════════════════════════

describe("buildQoderApiPayload — reasoning & parameter passthrough", () => {
  const baseArgs = {
    modelKey: "qmodel_latest",
    modelConfig: { ...QODER_MODEL_CONFIG_MAP.qmodel_latest, is_reasoning: true },
    userId: "user-test",
  };

  describe("positive: reasoning_effort passthrough for all valid values", () => {
    for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
      it(`passes reasoning_effort="${effort}" through to payload parameters`, () => {
        const body = {
          messages: [{ role: "user", content: "hello" }],
          reasoning_effort: effort,
        };
        const payload = buildQoderApiPayload(body, baseArgs);
        expect(payload.parameters.reasoning_effort).toBe(effort);
      });
    }

    it("passes reasoning_effort='none' through to payload parameters", () => {
      const body = {
        messages: [{ role: "user", content: "hello" }],
        reasoning_effort: "none",
      };
      const payload = buildQoderApiPayload(body, baseArgs);
      expect(payload.parameters.reasoning_effort).toBe("none");
    });
  });

  describe("positive: max_thinking_tokens passthrough", () => {
    it("passes explicit max_thinking_tokens to payload parameters", () => {
      const body = {
        messages: [{ role: "user", content: "hello" }],
        max_thinking_tokens: 8192,
      };
      const payload = buildQoderApiPayload(body, baseArgs);
      expect(payload.parameters.max_thinking_tokens).toBe(8192);
    });

    it("passes large max_thinking_tokens value", () => {
      const body = {
        messages: [{ role: "user", content: "hello" }],
        max_thinking_tokens: 100000,
      };
      const payload = buildQoderApiPayload(body, baseArgs);
      expect(payload.parameters.max_thinking_tokens).toBe(100000);
    });
  });

  describe("positive: default reasoning_effort is 'max' when not specified", () => {
    it("defaults reasoning_effort to 'max' when body has no reasoning_effort", () => {
      const body = { messages: [{ role: "user", content: "hello" }] };
      const payload = buildQoderApiPayload(body, baseArgs);
      expect(payload.parameters.reasoning_effort).toBe("max");
      expect(payload.parameters.reasoning_effort).toBe(QODER_DEFAULT_REASONING_EFFORT);
    });

    it("defaults reasoning_effort to 'max' when body.reasoning_effort is undefined", () => {
      const body = { messages: [{ role: "user", content: "hello" }], reasoning_effort: undefined };
      const payload = buildQoderApiPayload(body, baseArgs);
      expect(payload.parameters.reasoning_effort).toBe("max");
    });

    it("passes empty string reasoning_effort through (?? does not treat '' as falsy)", () => {
      const body = { messages: [{ role: "user", content: "hello" }], reasoning_effort: "" };
      const payload = buildQoderApiPayload(body, baseArgs);
      expect(payload.parameters.reasoning_effort).toBe("");
    });
  });

  describe("positive: default max_thinking_tokens is 49153 when not specified", () => {
    it("defaults max_thinking_tokens to 49153 when body has no max_thinking_tokens", () => {
      const body = { messages: [{ role: "user", content: "hello" }] };
      const payload = buildQoderApiPayload(body, baseArgs);
      expect(payload.parameters.max_thinking_tokens).toBe(49153);
      expect(payload.parameters.max_thinking_tokens).toBe(QODER_DEFAULT_MAX_THINKING_TOKENS);
    });

    it("defaults max_thinking_tokens to 49153 when body.max_thinking_tokens is undefined", () => {
      const body = { messages: [{ role: "user", content: "hello" }], max_thinking_tokens: undefined };
      const payload = buildQoderApiPayload(body, baseArgs);
      expect(payload.parameters.max_thinking_tokens).toBe(49153);
    });

    it("passes max_thinking_tokens 0 through (?? does not treat 0 as falsy)", () => {
      const body = { messages: [{ role: "user", content: "hello" }], max_thinking_tokens: 0 };
      const payload = buildQoderApiPayload(body, baseArgs);
      expect(payload.parameters.max_thinking_tokens).toBe(0);
    });
  });

  describe("positive: business name truncation at exactly 100 chars", () => {
    it("does NOT truncate prompt at exactly 100 characters", () => {
      const prompt100 = "a".repeat(100);
      const body = { messages: [{ role: "user", content: prompt100 }] };
      const payload = buildQoderApiPayload(body, baseArgs);
      expect(payload.business.name).toBe(prompt100);
      expect(payload.business.name.length).toBe(100);
    });

    it("truncates prompt at 101 characters to exactly 100", () => {
      const prompt101 = "a".repeat(101);
      const body = { messages: [{ role: "user", content: prompt101 }] };
      const payload = buildQoderApiPayload(body, baseArgs);
      expect(payload.business.name.length).toBe(100);
      expect(payload.business.name).toBe("a".repeat(100));
    });

    it("truncates very long prompt to QODER_BUSINESS_NAME_MAX_LENGTH", () => {
      const longPrompt = "x".repeat(5000);
      const body = { messages: [{ role: "user", content: longPrompt }] };
      const payload = buildQoderApiPayload(body, baseArgs);
      expect(payload.business.name.length).toBe(QODER_BUSINESS_NAME_MAX_LENGTH);
    });

    it("keeps short prompt unchanged", () => {
      const body = { messages: [{ role: "user", content: "hi" }] };
      const payload = buildQoderApiPayload(body, baseArgs);
      expect(payload.business.name).toBe("hi");
    });
  });

  describe("positive: aliyun_user_type is always empty string", () => {
    it("sets aliyun_user_type to empty string regardless of input", () => {
      const body = { messages: [{ role: "user", content: "hello" }] };
      const payload = buildQoderApiPayload(body, baseArgs);
      expect(payload.aliyun_user_type).toBe("");
    });

    it("sets aliyun_user_type to empty string even when userId suggests enterprise", () => {
      const body = { messages: [{ role: "user", content: "hello" }] };
      const payload = buildQoderApiPayload(body, { ...baseArgs, userId: "enterprise-user" });
      expect(payload.aliyun_user_type).toBe("");
    });
  });

  describe("negative: empty messages array", () => {
    it("builds payload with empty messages array without throwing", () => {
      const body = { messages: [] };
      const payload = buildQoderApiPayload(body, baseArgs);
      expect(payload.messages).toEqual([]);
      expect(payload.business.name).toBe("");
    });

    it("builds payload when messages key is missing", () => {
      const body = {};
      const payload = buildQoderApiPayload(body, baseArgs);
      expect(payload.messages).toEqual([]);
    });

    it("builds payload when messages is not an array", () => {
      const body = { messages: "not-an-array" };
      const payload = buildQoderApiPayload(body, baseArgs);
      expect(payload.messages).toEqual([]);
    });
  });

  describe("edge: payload structure validation", () => {
    it("always sets stream to true", () => {
      const body = { messages: [{ role: "user", content: "hello" }], stream: false };
      const payload = buildQoderApiPayload(body, baseArgs);
      expect(payload.stream).toBe(true);
    });

    it("sets business.version to '1.0.22'", () => {
      const body = { messages: [{ role: "user", content: "hello" }] };
      const payload = buildQoderApiPayload(body, baseArgs);
      expect(payload.business.version).toBe("1.0.22");
    });

    it("sets session_type to 'qodercli'", () => {
      const body = { messages: [{ role: "user", content: "hello" }] };
      const payload = buildQoderApiPayload(body, baseArgs);
      expect(payload.session_type).toBe("qodercli");
    });

    it("includes user_id from args", () => {
      const body = { messages: [{ role: "user", content: "hello" }] };
      const payload = buildQoderApiPayload(body, baseArgs);
      expect(payload.user_id).toBe("user-test");
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. Negative tests — invalid credentials & session failures
// ═══════════════════════════════════════════════════════════════════════════

describe("qoder-api negative: invalid credentials & session failures", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-02T00:00:00.000Z"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns 401 when credentials have no apiKey", async () => {
    const executor = new QoderApiExecutor();
    const resultPromise = executor.execute({
      ...EXECUTE_ARGS,
      credentials: { providerSpecificData: {} },
    });
    await vi.advanceTimersByTimeAsync(0);
    const result = await resultPromise;

    expect(result.response.status).toBe(401);
    const body = await result.response.json();
    expect(body.error.type).toBe("authentication_error");
    expect(body.error.code).toBe("auth_failed");
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("returns 401 when credentials is null", async () => {
    const executor = new QoderApiExecutor();
    const resultPromise = executor.execute({
      ...EXECUTE_ARGS,
      credentials: null,
    });
    await vi.advanceTimersByTimeAsync(0);
    const result = await resultPromise;

    expect(result.response.status).toBe(401);
    const body = await result.response.json();
    expect(body.error.type).toBe("authentication_error");
  });

  it("returns 401 when credentials is undefined", async () => {
    const executor = new QoderApiExecutor();
    const resultPromise = executor.execute({
      ...EXECUTE_ARGS,
      credentials: undefined,
    });
    await vi.advanceTimersByTimeAsync(0);
    const result = await resultPromise;

    expect(result.response.status).toBe(401);
  });

  it("returns 401 when session exchange fails (expired session + fetch error)", async () => {
    const expiredCredentials = {
      apiKey: "test-key",
      providerSpecificData: {
        qoderApiSession: {
          userId: "user-123",
          securityOauthToken: "expired-token",
          expiresAt: Date.now() - 1000,
        },
      },
    };

    proxyAwareFetch.mockRejectedValueOnce(new Error("Network error during token exchange"));

    const executor = new QoderApiExecutor();
    const resultPromise = executor.execute({
      ...EXECUTE_ARGS,
      credentials: expiredCredentials,
    });
    await vi.advanceTimersByTimeAsync(QODER_SESSION_TIMEOUT_MS + 1000);
    const result = await resultPromise;

    expect(result.response.status).toBe(401);
    const body = await result.response.json();
    expect(body.error.type).toBe("authentication_error");
    expect(body.error.code).toBe("auth_failed");
  });

  it("returns 401 when apiKey is empty string", async () => {
    const executor = new QoderApiExecutor();
    const resultPromise = executor.execute({
      ...EXECUTE_ARGS,
      credentials: { apiKey: "", providerSpecificData: {} },
    });
    await vi.advanceTimersByTimeAsync(0);
    const result = await resultPromise;

    expect(result.response.status).toBe(401);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 11. Additional edge cases — 403 model-not-enabled variants
// ═══════════════════════════════════════════════════════════════════════════

describe("qoder-api 403 model-not-enabled additional edge cases", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-02T00:00:00.000Z"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function makeStreamingResponse(frames) {
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream({
        start(controller) {
          for (const frame of frames) {
            controller.enqueue(encoder.encode(frame));
          }
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  }

  it("403 with lowercase 'upgrade' in message → model_not_enabled", async () => {
    const errorBody = JSON.stringify({ message: "Please upgrade your plan to access this model" });
    const sseFrame = `data: ${JSON.stringify({ statusCodeValue: 403, body: errorBody })}\n\n`;

    proxyAwareFetch.mockResolvedValueOnce(makeStreamingResponse([sseFrame]));

    const executor = new QoderApiExecutor();
    const resultPromise = executor.execute({
      ...EXECUTE_ARGS,
      credentials: makeCredentials(),
    });
    await vi.advanceTimersByTimeAsync(0);
    const result = await resultPromise;

    expect(result.response.status).toBe(403);
    const body = await result.response.json();
    expect(body.error.type).toBe("model_not_enabled");
  });

  it("403 with mixed case 'UpGrAdE' in message → model_not_enabled", async () => {
    const errorBody = JSON.stringify({ message: "UpGrAdE your subscription" });
    const sseFrame = `data: ${JSON.stringify({ statusCodeValue: 403, body: errorBody })}\n\n`;

    proxyAwareFetch.mockResolvedValueOnce(makeStreamingResponse([sseFrame]));

    const executor = new QoderApiExecutor();
    const resultPromise = executor.execute({
      ...EXECUTE_ARGS,
      credentials: makeCredentials(),
    });
    await vi.advanceTimersByTimeAsync(0);
    const result = await resultPromise;

    expect(result.response.status).toBe(403);
    const body = await result.response.json();
    expect(body.error.type).toBe("model_not_enabled");
  });

  it("403 with nested error.message containing 'not enabled' → model_not_enabled (via execute)", async () => {
    const errorBody = JSON.stringify({ error: { message: "This model is not enabled for your tier" } });
    const sseFrame = `data: ${JSON.stringify({ statusCodeValue: 403, body: errorBody })}\n\n`;

    proxyAwareFetch.mockResolvedValueOnce(makeStreamingResponse([sseFrame]));

    const executor = new QoderApiExecutor();
    const resultPromise = executor.execute({
      ...EXECUTE_ARGS,
      credentials: makeCredentials(),
    });
    await vi.advanceTimersByTimeAsync(0);
    const result = await resultPromise;

    expect(result.response.status).toBe(403);
    const body = await result.response.json();
    expect(body.error.type).toBe("model_not_enabled");
  });

  it("403 with code 'model_not_enabled' but empty message → model_not_enabled (via execute)", async () => {
    const errorBody = JSON.stringify({ code: "model_not_enabled", message: "" });
    const sseFrame = `data: ${JSON.stringify({ statusCodeValue: 403, body: errorBody })}\n\n`;

    proxyAwareFetch.mockResolvedValueOnce(makeStreamingResponse([sseFrame]));

    const executor = new QoderApiExecutor();
    const resultPromise = executor.execute({
      ...EXECUTE_ARGS,
      credentials: makeCredentials(),
    });
    await vi.advanceTimersByTimeAsync(0);
    const result = await resultPromise;

    expect(result.response.status).toBe(403);
    const body = await result.response.json();
    expect(body.error.type).toBe("model_not_enabled");
  });

  it("500 with 'not enabled' message → does NOT match model_not_enabled (only 403)", async () => {
    const errorBody = JSON.stringify({ message: "Model is not enabled for this account" });
    const sseFrame = `data: ${JSON.stringify({ statusCodeValue: 500, body: errorBody })}\n\n`;

    proxyAwareFetch.mockResolvedValueOnce(makeStreamingResponse([sseFrame]));

    const executor = new QoderApiExecutor();
    const resultPromise = executor.execute({
      ...EXECUTE_ARGS,
      credentials: makeCredentials(),
    });
    await vi.advanceTimersByTimeAsync(0);
    const result = await resultPromise;

    expect(result.response.status).toBe(502);
    const body = await result.response.json();
    expect(body.error.type).toBe("upstream_error");
    expect(body.error.type).not.toBe("model_not_enabled");
  });

  it("queue error + model-not-enabled in same body → model-not-enabled wins (priority via execute)", async () => {
    const queueMsg = JSON.stringify({ isQueued: true, queueCount: 10, queueType: "slow", waitTime: 600 });
    const errorBody = JSON.stringify({ code: "model_not_enabled", message: queueMsg });
    const sseFrame = `data: ${JSON.stringify({ statusCodeValue: 403, body: errorBody })}\n\n`;

    proxyAwareFetch.mockResolvedValueOnce(makeStreamingResponse([sseFrame]));

    const executor = new QoderApiExecutor();
    const resultPromise = executor.execute({
      ...EXECUTE_ARGS,
      credentials: makeCredentials(),
    });
    await vi.advanceTimersByTimeAsync(0);
    const result = await resultPromise;

    expect(result.response.status).toBe(403);
    const body = await result.response.json();
    expect(body.error.type).toBe("model_not_enabled");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 12. Peek buffer overflow edge case
// ═══════════════════════════════════════════════════════════════════════════

describe("qoder-api peek buffer overflow (>64KB)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-02T00:00:00.000Z"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("passes through when first chunk exceeds QODER_PEEK_BUFFER_CAP without error detection", async () => {
    const oversizedData = "x".repeat(QODER_PEEK_BUFFER_CAP + 1024);
    const normalChunk = JSON.stringify({ choices: [{ delta: { content: oversizedData }, finish_reason: null }] });
    const sseFrame = `data: ${JSON.stringify({ statusCodeValue: 200, body: normalChunk })}\n\ndata: [DONE]\n\n`;

    const encoder = new TextEncoder();
    const oversizedResponse = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(sseFrame));
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );

    proxyAwareFetch.mockResolvedValueOnce(oversizedResponse);

    const executor = new QoderApiExecutor();
    const resultPromise = executor.execute({
      ...EXECUTE_ARGS,
      credentials: makeCredentials(),
    });
    await vi.advanceTimersByTimeAsync(0);
    const result = await resultPromise;

    expect(result.response.status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 13. Client abort during first attempt (no retry needed)
// ═══════════════════════════════════════════════════════════════════════════

describe("qoder-api client abort during first attempt", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-02T00:00:00.000Z"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns 499 immediately when client aborts during first fetch (no retry)", async () => {
    const clientCtrl = new AbortController();

    proxyAwareFetch.mockImplementationOnce((_url, opts) => {
      return new Promise((_resolve, reject) => {
        if (opts.signal.aborted) {
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          reject(err);
          return;
        }
        opts.signal.addEventListener("abort", () => {
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });

    const executor = new QoderApiExecutor();
    const resultPromise = executor.execute({
      ...EXECUTE_ARGS,
      credentials: makeCredentials(),
      signal: clientCtrl.signal,
    });

    await vi.advanceTimersByTimeAsync(0);
    clientCtrl.abort();

    const result = await resultPromise;
    expect(result.response.status).toBe(499);
    const body = await result.response.json();
    expect(body.error.code).toBe("aborted");
    expect(body.error.type).toBe("client_error");
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 14. All 6 attempts fail with network errors (exhaustive)
// ═══════════════════════════════════════════════════════════════════════════

describe("qoder-api all 6 attempts (initial + 5 retries) fail with network errors", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-02T00:00:00.000Z"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("makes exactly 6 fetch calls (1 initial + 5 retries) and returns 502", async () => {
    for (let i = 0; i <= QODER_MAX_RETRIES; i++) {
      proxyAwareFetch.mockRejectedValueOnce(new Error("ENOTFOUND api3.qoder.sh"));
    }

    const executor = new QoderApiExecutor();
    const resultPromise = executor.execute({
      ...EXECUTE_ARGS,
      credentials: makeCredentials(),
    });

    await vi.advanceTimersByTimeAsync(550);
    await vi.advanceTimersByTimeAsync(1_100);
    await vi.advanceTimersByTimeAsync(2_200);
    await vi.advanceTimersByTimeAsync(3_300);
    await vi.advanceTimersByTimeAsync(3_300);

    const result = await resultPromise;

    expect(result.response.status).toBe(502);
    const body = await result.response.json();
    expect(body.error.type).toBe("upstream_error");
    expect(proxyAwareFetch).toHaveBeenCalledTimes(6);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(QODER_MAX_RETRIES + 1);
  });

  it("returns error message containing the network error info", async () => {
    for (let i = 0; i <= QODER_MAX_RETRIES; i++) {
      proxyAwareFetch.mockRejectedValueOnce(new Error("ETIMEDOUT"));
    }

    const executor = new QoderApiExecutor();
    const resultPromise = executor.execute({
      ...EXECUTE_ARGS,
      credentials: makeCredentials(),
    });

    await vi.advanceTimersByTimeAsync(550);
    await vi.advanceTimersByTimeAsync(1_100);
    await vi.advanceTimersByTimeAsync(2_200);
    await vi.advanceTimersByTimeAsync(3_300);
    await vi.advanceTimersByTimeAsync(3_300);

    const result = await resultPromise;
    expect(result.response.status).toBe(502);
    const body = await result.response.json();
    expect(body.error.message).toBeDefined();
    expect(typeof body.error.message).toBe("string");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 15. Additional constants validation
// ═══════════════════════════════════════════════════════════════════════════

describe("qoder-api additional constants validation", () => {
  it("QODER_USER_AGENT is 'qoder/1.0.22'", () => {
    expect(QODER_USER_AGENT).toBe("qoder/1.0.22");
  });

  it("QODER_DEFAULTS.cosyVersion is '1.0.22'", () => {
    expect(QODER_DEFAULTS.cosyVersion).toBe("1.0.22");
  });

  it("QODER_DEFAULTS is frozen (immutable)", () => {
    expect(Object.isFrozen(QODER_DEFAULTS)).toBe(true);
  });

  it("QODER_DEFAULTS has expected keys", () => {
    expect(QODER_DEFAULTS).toHaveProperty("region");
    expect(QODER_DEFAULTS).toHaveProperty("cosyVersion");
    expect(QODER_DEFAULTS).toHaveProperty("mitmBypassQoder");
    expect(QODER_DEFAULTS).toHaveProperty("mitmBypassExtraHosts");
  });

  it("QODER_RETRY_BASE_DELAY_MS is 500", () => {
    expect(QODER_RETRY_BASE_DELAY_MS).toBe(500);
  });

  it("QODER_RETRY_MAX_DELAY_MS is 3000", () => {
    expect(QODER_RETRY_MAX_DELAY_MS).toBe(3000);
  });

  it("QODER_USER_AGENT matches QODER_DEFAULTS.cosyVersion pattern", () => {
    expect(QODER_USER_AGENT).toContain(QODER_DEFAULTS.cosyVersion);
  });

  it("backoff formula: base delay never exceeds QODER_RETRY_MAX_DELAY_MS for attempts 1-5", () => {
    for (let attempt = 1; attempt <= QODER_MAX_RETRIES; attempt++) {
      const baseDelay = Math.min(QODER_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1), QODER_RETRY_MAX_DELAY_MS);
      expect(baseDelay).toBeLessThanOrEqual(QODER_RETRY_MAX_DELAY_MS);
      expect(baseDelay).toBeGreaterThan(0);
    }
  });

  it("backoff formula: attempt 4 and 5 are capped at QODER_RETRY_MAX_DELAY_MS", () => {
    // attempt 4: min(500 * 2^3, 3000) = min(4000, 3000) = 3000
    const delay4 = Math.min(QODER_RETRY_BASE_DELAY_MS * Math.pow(2, 3), QODER_RETRY_MAX_DELAY_MS);
    expect(delay4).toBe(QODER_RETRY_MAX_DELAY_MS);

    // attempt 5: min(500 * 2^4, 3000) = min(8000, 3000) = 3000
    const delay5 = Math.min(QODER_RETRY_BASE_DELAY_MS * Math.pow(2, 4), QODER_RETRY_MAX_DELAY_MS);
    expect(delay5).toBe(QODER_RETRY_MAX_DELAY_MS);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 16. Provider capabilities (vision / reasoning) for qoder-api and qoder
// ═══════════════════════════════════════════════════════════════════════════

describe("qoder provider capabilities (getCapabilitiesForModel)", () => {
  describe("positive: specific model capability lookups for qoder-api", () => {
    it("qmodel_latest returns vision: true", () => {
      const caps = getCapabilitiesForModel("qoder-api", "qmodel_latest");
      expect(caps.vision).toBe(true);
    });

    it("dmodel returns vision: true and reasoning: true", () => {
      const caps = getCapabilitiesForModel("qoder-api", "dmodel");
      expect(caps.vision).toBe(true);
      expect(caps.reasoning).toBe(true);
    });

    it("ultimate returns vision: true and reasoning: true", () => {
      const caps = getCapabilitiesForModel("qoder-api", "ultimate");
      expect(caps.vision).toBe(true);
      expect(caps.reasoning).toBe(true);
    });

    it("lite returns vision: true", () => {
      const caps = getCapabilitiesForModel("qoder-api", "lite");
      expect(caps.vision).toBe(true);
    });
  });

  describe("positive: qoder provider mirrors qoder-api capabilities", () => {
    it("qoder/qmodel_latest returns vision: true (same as qoder-api)", () => {
      const caps = getCapabilitiesForModel("qoder", "qmodel_latest");
      expect(caps.vision).toBe(true);
    });
  });

  describe("positive: all 12 qoder models have vision: true", () => {
    const allModels = [
      "auto", "ultimate", "performance", "efficient", "lite",
      "qmodel_latest", "qmodel", "gm51model", "kmodel",
      "dmodel", "dfmodel", "mmodel",
    ];

    for (const model of allModels) {
      it(`qoder-api/${model} has vision: true`, () => {
        const caps = getCapabilitiesForModel("qoder-api", model);
        expect(caps.vision).toBe(true);
      });
    }
  });

  describe("positive: reasoning models have reasoning: true", () => {
    const reasoningModels = ["ultimate", "dmodel", "dfmodel", "gm51model"];

    for (const model of reasoningModels) {
      it(`qoder-api/${model} has reasoning: true`, () => {
        const caps = getCapabilitiesForModel("qoder-api", model);
        expect(caps.reasoning).toBe(true);
      });
    }
  });

  describe("negative: non-reasoning models have reasoning: false", () => {
    const nonReasoningModels = [
      "auto", "performance", "efficient", "lite",
      "qmodel_latest", "qmodel", "kmodel", "mmodel",
    ];

    for (const model of nonReasoningModels) {
      it(`qoder-api/${model} has reasoning: false`, () => {
        const caps = getCapabilitiesForModel("qoder-api", model);
        expect(caps.reasoning).toBe(false);
      });
    }
  });
});
