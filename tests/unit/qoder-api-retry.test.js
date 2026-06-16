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
import { QoderApiExecutor, wrapQoderApiSSE } from "../../open-sse/executors/qoderApi.js";
import {
  QODER_MAX_RETRIES,
  QODER_RETRYABLE_STATUSES,
  QODER_CONNECT_TIMEOUT_MS,
  QODER_PEEK_TIMEOUT_MS,
  QODER_PEEK_BUFFER_CAP,
  QODER_SESSION_TIMEOUT_MS,
  QODER_TEST_TIMEOUT_MS,
  QODER_STALL_TIMEOUT_MS,
  QODER_REQUEST_TIMEOUT_MS,
  QODER_MODEL_CONFIG_MAP,
  QODER_MODEL_MAP,
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

      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.advanceTimersByTimeAsync(4_000);

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

      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.advanceTimersByTimeAsync(4_000);

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

      // Backoffs: 1s, 2s, 4s
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.advanceTimersByTimeAsync(4_000);

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

      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.advanceTimersByTimeAsync(4_000);

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

  it("uses exponential backoff: 1s, 2s, 4s between retries", async () => {
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

    await vi.advanceTimersByTimeAsync(999);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(3_999);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(4);

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
  it("QODER_MAX_RETRIES is 3", () => {
    expect(QODER_MAX_RETRIES).toBe(3);
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
