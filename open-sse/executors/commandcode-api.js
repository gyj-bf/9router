// open-sse/executors/commandcode-api.js
//
// CommandCodeApiExecutor — core executor for the `commandcode-api` (cmca) provider.
//
// Extends BaseExecutor and orchestrates:
//   1. Anti-detection header building (machine-id, project-slug, traceparent, CLI version, …)
//   2. Session lifecycle (ensureSessionActive before request, recordActivity after)
//   3. NDJSON → OpenAI SSE response wrapping (with zero-output guard)
//
// Upstream returns AI SDK v5 NDJSON (one JSON event per line, no `data:` prefix).
// We translate each event to an OpenAI chat.completion.chunk and emit it as SSE so
// both the streaming and non-streaming (forced SSE → JSON) downstream handlers in
// 9router can consume it without further format translation.

import { randomUUID, createHash } from "crypto";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { commandCodeApiToOpenAIResponse } from "../translator/response/commandcode-api-to-openai.js";
import { SSE_DONE } from "../utils/sseConstants.js";
import { debug, warn } from "@/sse/utils/logger.js";
import {
  LOG_TAG, CONTENT_TYPE_HEADER, ACCEPT_HEADER, CLI_ENVIRONMENT, USER_AGENT,
  DEFAULT_CLI_VERSION,
} from "../config/cmcApiConstants.js";
import { generateTraceparent, getFingerprint } from "../services/cmcApiFingerprint.js";
import { getCachedVersion } from "../services/cmcApiVersionTracker.js";
import { ensureSessionActive, recordActivity } from "../services/cmcApiSessionManager.js";

/**
 * Resolve a stable connection ID from the request options.
 * Falls back to a hash of the API key when no explicit ID is available.
 *
 * @param {object} opts - The execute() options object.
 * @param {object} [credentials] - The resolved credentials object.
 * @returns {string}
 */
function resolveConnectionId(opts, credentials) {
  const explicit =
    opts?.connectionId ||
    credentials?.connectionId ||
    credentials?.id ||
    credentials?.email ||
    credentials?.name;
  if (explicit) return String(explicit);

  const token = credentials?.apiKey || credentials?.accessToken;
  if (token) {
    return "key-" + createHash("sha256").update(String(token)).digest("hex").slice(0, 16);
  }
  return "cmca-default";
}

/**
 * Safely resolve the fingerprint for the current credentials.
 * Never throws — falls back to a minimal synthetic fingerprint on failure.
 *
 * @param {object} credentials
 * @returns {object} - The fingerprint object ({ machineId, projectSlug, … }).
 */
function safeGetFingerprint(credentials) {
  try {
    const result = getFingerprint(credentials?.providerSpecificData);
    // getFingerprint returns { fingerprint, updated }; unwrap.
    return result?.fingerprint || result || {
      machineId: "m" + randomUUID().replace(/-/g, "").slice(0, 32),
      projectSlug: "unknown-project",
    };
  } catch (err) {
    warn(LOG_TAG, `Fingerprint generation failed, using fallback: ${err.message}`);
    return {
      machineId: "m" + randomUUID().replace(/-/g, "").slice(0, 32),
      projectSlug: "unknown-project",
    };
  }
}

/**
 * Safely resolve the cached CLI version.
 * Never throws — falls back to a default version string on failure.
 *
 * @returns {string}
 */
function safeGetCachedVersion() {
  try {
    return getCachedVersion() || DEFAULT_CLI_VERSION;
  } catch (err) {
    warn(LOG_TAG, `Version tracker failed, using fallback: ${err.message}`);
    return DEFAULT_CLI_VERSION;
  }
}

/**
 * CommandCodeApiExecutor — talks to https://api.commandcode.ai/alpha/generate
 *
 * Auth: Bearer <user_xxx> API key (stored as the connection's apiKey).
 *
 * Unlike the plain CommandCodeExecutor, this variant emits the FULL anti-detection
 * header set expected by CommandCode's API when masquerading as the official CLI:
 *   x-command-code-version, x-cli-environment, x-session-id, x-machine-id,
 *   x-project-slug, traceparent, User-Agent.
 *
 * It also manages a per-connection session lifecycle (start → activity → idle-end)
 * so upstream sees a realistic CLI session rather than a stream of disconnected
 * one-shot requests.
 */
export class CommandCodeApiExecutor extends BaseExecutor {
  constructor() {
    super("commandcode-api", PROVIDERS["commandcode-api"]);
  }

  transformRequest(model, body, stream, credentials) {
    body.stream = true;
    return body;
  }

  buildHeaders(credentials, stream = true) {
    const token = credentials?.apiKey || credentials?.accessToken;
    const fingerprint = safeGetFingerprint(credentials);
    const version = safeGetCachedVersion();

    const headers = {
      "Content-Type": CONTENT_TYPE_HEADER,
      "Accept": stream ? ACCEPT_HEADER : "application/json",
      "Authorization": token ? `Bearer ${token}` : undefined,
      "x-command-code-version": version,
      "x-cli-environment": CLI_ENVIRONMENT,
      "x-session-id": randomUUID(),
      "x-machine-id": fingerprint.machineId,
      "x-project-slug": fingerprint.projectSlug,
      "traceparent": generateTraceparent(),
      "User-Agent": USER_AGENT,
    };
    // Remove undefined headers (e.g. Authorization when no token)
    Object.keys(headers).forEach(k => headers[k] === undefined && delete headers[k]);
    return headers;
  }

  async execute(opts) {
    const credentials = opts?.credentials;
    const connectionId = resolveConnectionId(opts, credentials);
    const fingerprint = safeGetFingerprint(credentials);
    const version = safeGetCachedVersion();
    const apiKey = credentials?.apiKey || credentials?.accessToken;

    // ── Session start (fail-open) ──
    // We attempt to mark the session active before the request so upstream sees
    // a realistic session-start → generate sequence. Failures here MUST NOT block
    // the actual generation request.
    try {
      await ensureSessionActive(connectionId, fingerprint, version, apiKey);
    } catch (err) {
      warn(LOG_TAG, `ensureSessionActive failed for ${connectionId} (fail-open): ${err.message}`);
    }

    // ── Execute the upstream request via BaseExecutor ──
    const result = await super.execute(opts);
    if (!result?.response?.ok || !result.response.body) {
      // Still record activity attempt, then bail.
      try { recordActivity(connectionId); } catch { /* ignore */ }
      return result;
    }

    // ── Wrap NDJSON response as OpenAI SSE ──
    result.response = wrapNdjsonAsOpenAISse(result.response, opts.model, {
      connectionId,
      onFirstChunk: () => {
        try { recordActivity(connectionId); } catch { /* ignore */ }
      },
    });
    return result;
  }
}

/**
 * Wrap an NDJSON upstream response as an OpenAI-compatible SSE stream.
 *
 * Mirrors the pattern in commandcode.js but:
 *   - Uses commandCodeApiToOpenAIResponse (API variant) for translation.
 *   - Includes a zero-output guard: if the stream ends without emitting any
 *     content chunks and without a finish reason, emit an error chunk so the
 *     downstream client sees a visible failure rather than a silent empty stream.
 *   - Invokes onFirstChunk callback to record session activity.
 *
 * @param {Response} originalResponse - The upstream fetch Response.
 * @param {string} model - The model name for chunk metadata.
 * @param {object} [hooks] - Optional hooks { connectionId, onFirstChunk }.
 * @returns {Response}
 */
function wrapNdjsonAsOpenAISse(originalResponse, model, hooks = {}) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const state = { model };
  let activityRecorded = false;

  const emitChunks = (chunks, controller) => {
    if (!chunks) return;
    const list = Array.isArray(chunks) ? chunks : [chunks];
    for (const c of list) {
      if (c == null) continue;
      if (!activityRecorded) {
        activityRecorded = true;
        try { hooks.onFirstChunk?.(); } catch { /* ignore */ }
      }
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(c)}\n\n`));
    }
  };

  const transform = new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        // Translate AI SDK v5 NDJSON line to one or more OpenAI chunks
        try {
          emitChunks(commandCodeApiToOpenAIResponse(trimmed, state), controller);
        } catch (err) {
          debug(LOG_TAG, `NDJSON translate error for line, skipping: ${err.message}`);
        }
      }
    },
    flush(controller) {
      const trimmed = buffer.trim();
      if (trimmed) {
        try {
          emitChunks(commandCodeApiToOpenAIResponse(trimmed, state), controller);
        } catch (err) {
          debug(LOG_TAG, `NDJSON translate error in flush, skipping: ${err.message}`);
        }
      }

      // ── Zero-output guard ──
      // If we never emitted a content chunk AND never saw a finish reason,
      // the upstream returned an empty / non-content response. Emit a visible
      // error chunk so the client doesn't see a silent success.
      if (state.chunkIndex === 0 && !state.finishReason) {
        debug(LOG_TAG, `Zero-output guard triggered for ${hooks.connectionId || "unknown"} — emitting error chunk`);
        const errorChunk = {
          id: state.responseId || `chatcmpl-${Date.now()}`,
          object: "chat.completion.chunk",
          created: state.created || Math.floor(Date.now() / 1000),
          model: state.model || model || "commandcode-api",
          choices: [{
            index: 0,
            delta: { content: "[CommandCode API: empty response received]" },
            finish_reason: null,
          }],
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorChunk)}\n\n`));

        // Follow with a stop chunk so clients close cleanly.
        const stopChunk = {
          id: errorChunk.id,
          object: "chat.completion.chunk",
          created: errorChunk.created,
          model: errorChunk.model,
          choices: [{
            index: 0,
            delta: {},
            finish_reason: "stop",
          }],
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(stopChunk)}\n\n`));
      }

      controller.enqueue(encoder.encode(SSE_DONE));
    },
  });

  const newBody = originalResponse.body.pipeThrough(transform);
  return new Response(newBody, {
    status: originalResponse.status,
    statusText: originalResponse.statusText,
    headers: originalResponse.headers,
  });
}

export default CommandCodeApiExecutor;
