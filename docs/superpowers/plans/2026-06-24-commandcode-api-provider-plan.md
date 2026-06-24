# Implementation Plan: commandcode-api (cmca) Provider

**Spec:** `docs/superpowers/specs/2026-06-24-commandcode-api-provider-design.md`
**Branch:** `feat/commandcode-api-provider`
**Reference:** [commandcode-proxy](https://github.com/MAXeaglet/commandcode-proxy) — reverse-engineering project that informed all anti-detection logic.
**Approach:** TDD — write tests first, then implementation, then wire up.

## Architecture Refresher

The new provider follows 9router's existing pattern:
1. **Constants module** (`config/cmcApiConstants.js`) — all hardcoded values in one place for easy maintenance
2. **Registry entry** (`registry/commandcode-api.js`) — provider metadata, model list, transport config
3. **Executor** (`executors/commandcode-api.js`) — builds headers with anti-detection, sends request upstream, wraps NDJSON response
4. **Translators** — request (`openai-to-commandcode-api.js`) and response (`commandcode-api-to-openai.js`)
5. **Services** — fingerprint (`cmcApiFingerprint.js`), version tracker (`cmcApiVersionTracker.js`), session manager (`cmcApiSessionManager.js`)

The existing `commandcode` provider (id: `commandcode`, alias: `cmc`) remains untouched. The new provider is id: `commandcode-api`, alias: `cmca`, format: `commandcodeapi`.

**Logger:** Uses `src/sse/utils/logger.js` — `debug(tag, message, data)`, `info(tag, message, data)`, `warn(tag, message, data)`, `error(tag, message, data)`. Log tag: `"CMC API"`.

## Task 1: Create constants module + format constant

### 1a: Constants module

**File:** `open-sse/config/cmcApiConstants.js`

```js
// open-sse/config/cmcApiConstants.js
// All hardcoded values for the commandcode-api (cmca) provider in one place.
// Update values here for future maintenance — no hunting through multiple files.

// ── CLI Version Tracking ──
export const DEFAULT_CLI_VERSION = "0.40.5";
export const NPM_REGISTRY_URL = "https://registry.npmjs.org/command-code/latest";
export const VERSION_CACHE_TTL_MS = parseInt(process.env.CMC_API_VERSION_CACHE_TTL_MS || "7200000", 10); // 2 hours

// ── Session Lifecycle ──
export const SESSION_IDLE_TIMEOUT_MS = parseInt(process.env.CMC_API_SESSION_IDLE_TIMEOUT_MS || "300000", 10); // 5 minutes
export const SESSION_START_TIMEOUT_MS = parseInt(process.env.CMC_API_SESSION_START_TIMEOUT_MS || "10000", 10); // 10s

// ── Fingerprint ──
export const PROJECT_SLUG_TTL_MS = parseInt(process.env.CMC_API_PROJECT_SLUG_TTL_MS || "86400000", 10); // 24 hours

// ── Static Header Values ──
export const CLI_ENVIRONMENT = "cli";
export const USER_AGENT = "node";
export const ACCEPT_HEADER = "text/event-stream";
export const CONTENT_TYPE_HEADER = "application/json";

// ── Logging ──
export const LOG_TAG = "CMC API";

// ── API ──
export const CC_API_BASE_URL = "https://api.commandcode.ai/alpha/generate";

// ── Token Limits ──
export const MAX_TOKENS_CAP = 64000;
export const DEFAULT_MAX_TOKENS = 16384;
export const DEFAULT_TEMPERATURE = 0.3;

// ── Default System Prompt ──
export const DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant that helps with software engineering tasks.";

// ── Fake Config Defaults ──
export const FAKE_GIT_BRANCH = "main";
export const FAKE_GIT_REPO = true;
export const FAKE_WORKING_DIR_PREFIX = "/home/user";

// ── Reasoning Effort Mapping ──
// OpenAI reasoning_effort → CC API does not have a direct equivalent,
// but we pass it through in case the API starts supporting it.
// "none" is stripped (no reasoning).
export const REASONING_EFFORT_VALUES = ["none", "low", "medium", "high"];

// ── Curated Word Lists for Project Slug ──
export const ADJECTIVES = [
  "crimson", "azure", "amber", "cobalt", "emerald", "violet", "golden", "silver",
  "scarlet", "indigo", "coral", "jade", "onyx", "ruby", "sapphire", "topaz",
  "misty", "lunar", "solar", "arctic", "tropical", "desert", "coastal", "alpine",
  "rapid", "silent", "vivid", "cosmic", "electric", "magnetic", "quantum", "stellar",
];

export const NOUNS = [
  "ferret", "mountain", "theory", "logic", "engine", "cipher", "phoenix", "raven",
  "badger", "falcon", "harbor", "meadow", "canyon", "forest", "glacier", "river",
  "oracle", "beacon", "compass", "anchor", "spark", "vertex", "horizon", "summit",
  "protocol", "sentry", "catalyst", "momentum", "cascade", "echo", "prism", "vector",
  "matrix", "lattice", "nexus", "kernel", "delta", "lambda", "sigma", "omega",
];
```

### 1b: Format constant

**File:** `open-sse/translator/formats.js`

Add `COMMANDCODE_API` to the `FORMATS` object after `COMMANDCODE`:

```js
COMMANDCODE_API: "commandcodeapi"
```

**Test:** `node -e "import('./open-sse/translator/formats.js').then(m => console.assert(m.FORMATS.COMMANDCODE_API === 'commandcodeapi'))"`

**Commit:** `feat(cmca): add constants module and COMMANDCODE_API format`

---

## Task 2: Create fingerprint service

**File:** `open-sse/services/cmcApiFingerprint.js`
**Test file:** `tests/unit/cmcApiFingerprint.test.js`

### 2a: Write tests first

**Test cases:**
- `generateMachineId()` → returns string starting with `m` followed by 32 hex chars
- `generateMachineId()` → generates different values on subsequent calls
- `generateProjectSlug()` → returns kebab-case string of 2-4 words from curated word lists
- `generateProjectSlug()` → generates different slugs on subsequent calls
- `generateTraceparent()` → returns W3C format `00-<32hex>-<16hex>-01`
- `generateTraceparent()` → generates different values per call
- `createFingerprint(credentials)` → returns `{ machineId, projectSlug, projectSlugUpdatedAt, createdAt }`
- `createFingerprint(credentials)` → different API keys produce different fingerprints
- `shouldRotateProjectSlug(fingerprint)` → returns `false` if age < `PROJECT_SLUG_TTL_MS`
- `shouldRotateProjectSlug(fingerprint)` → returns `true` if age >= `PROJECT_SLUG_TTL_MS`
- `getFingerprint(credentials, existingData)` → returns existing fingerprint if present and fresh
- `getFingerprint(credentials, existingData)` → creates new fingerprint if `existingData.cmcApi` is missing
- `getFingerprint(credentials, existingData)` → rotates project slug if expired

**Commit:** `test(cmca): add fingerprint service tests`

### 2b: Implement fingerprint service

```js
// open-sse/services/cmcApiFingerprint.js
import { randomBytes, randomUUID } from "crypto";
import {
  ADJECTIVES, NOUNS, PROJECT_SLUG_TTL_MS,
} from "../config/cmcApiConstants.js";

export function generateMachineId() {
  return "m" + randomBytes(16).toString("hex"); // m + 32 hex chars
}

export function generateProjectSlug() {
  const parts = [
    ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)],
    NOUNS[Math.floor(Math.random() * NOUNS.length)],
  ];
  // 50% chance of a third word for variety
  if (Math.random() > 0.5) {
    parts.push(NOUNS[Math.floor(Math.random() * NOUNS.length)]);
  }
  return parts.join("-");
}

export function generateTraceparent() {
  const traceId = randomBytes(16).toString("hex");   // 32 hex
  const spanId = randomBytes(8).toString("hex");     // 16 hex
  return `00-${traceId}-${spanId}-01`;
}

export function createFingerprint() {
  const now = Date.now();
  return {
    machineId: generateMachineId(),
    projectSlug: generateProjectSlug(),
    projectSlugUpdatedAt: now,
    createdAt: now,
  };
}

export function shouldRotateProjectSlug(fingerprint) {
  if (!fingerprint?.projectSlugUpdatedAt) return true;
  return (Date.now() - fingerprint.projectSlugUpdatedAt) >= PROJECT_SLUG_TTL_MS;
}

export function getFingerprint(credentials, existingData) {
  const existing = existingData?.cmcApi;
  if (existing?.machineId) {
    // Rotate project slug if expired
    if (shouldRotateProjectSlug(existing)) {
      existing.projectSlug = generateProjectSlug();
      existing.projectSlugUpdatedAt = Date.now();
    }
    return existing;
  }
  return createFingerprint();
}
```

**Commit:** `feat(cmca): implement fingerprint service`

---

## Task 3: Create version tracker service

**File:** `open-sse/services/cmcApiVersionTracker.js`
**Test file:** `tests/unit/cmcApiVersionTracker.test.js`

### 3a: Write tests first

**Test cases:**
- `getLatestVersion()` → fetches from npm registry and returns version string
- `getLatestVersion()` → returns cached version on second call without fetching
- `getLatestVersion()` → falls back to `DEFAULT_CLI_VERSION` ("0.40.5") when npm fetch fails
- `getLatestVersion()` → falls back to cached version when npm returns invalid JSON
- Cache expires after `VERSION_CACHE_TTL_MS` (2 hours) and re-fetches

**Commit:** `test(cmca): add version tracker tests`

### 3b: Implement version tracker

```js
// open-sse/services/cmcApiVersionTracker.js
import { debug } from "@/sse/utils/logger.js";
import {
  DEFAULT_CLI_VERSION, NPM_REGISTRY_URL, VERSION_CACHE_TTL_MS, LOG_TAG,
} from "../config/cmcApiConstants.js";

let cache = null; // { version, fetchedAt }

export async function getLatestVersion() {
  const now = Date.now();
  if (cache && (now - cache.fetchedAt) < VERSION_CACHE_TTL_MS) {
    debug(LOG_TAG, `CLI version (cached): ${cache.version}`);
    return cache.version;
  }

  try {
    const res = await fetch(NPM_REGISTRY_URL, {
      signal: AbortSignal.timeout(5000),
      headers: { "Accept": "application/json" },
    });
    if (!res.ok) throw new Error(`npm responded ${res.status}`);
    const data = await res.json();
    const version = data.version;
    if (typeof version !== "string" || !version) throw new Error("no version field");
    cache = { version, fetchedAt: now };
    debug(LOG_TAG, `CLI version (fetched): ${version}`);
    return version;
  } catch (err) {
    debug(LOG_TAG, `npm fetch failed, using fallback: ${err.message}`);
    if (cache) return cache.version;          // stale cache better than hardcoded
    return DEFAULT_CLI_VERSION;                // last resort: "0.40.5"
  }
}
```

**Commit:** `feat(cmca): implement version tracker service`

---

## Task 4: Create session manager service

**File:** `open-sse/services/cmcApiSessionManager.js`
**Test file:** `tests/unit/cmcApiSessionManager.test.js`

Manages per-connection session lifecycle. Session idle timeout: 5 minutes.

### 4a: Write tests first

**Test cases:**
- `ensureSessionActive(connectionId, fingerprint, version, apiKey)` → sends session-start on first call for a connection
- `ensureSessionActive(...)` → does NOT send session-start on second call (session already ACTIVE)
- `ensureSessionActive(...)` → fail-open: if session-start returns 4xx, no error thrown
- `recordActivity(connectionId)` → updates `lastActivity` timestamp
- `endSession(connectionId, fingerprint, version, apiKey)` → sends session-end and clears session state
- `endSession(...)` → fail-open: if session-end fetch throws, no error thrown
- `endSession(...)` → no-op if no active session
- Session is automatically ended after `SESSION_IDLE_TIMEOUT_MS` (5min) of inactivity
- Different connections have independent session states

**Commit:** `test(cmca): add session manager tests`

### 4b: Implement session manager

```js
// open-sse/services/cmcApiSessionManager.js
import { randomUUID } from "crypto";
import { debug } from "@/sse/utils/logger.js";
import {
  LOG_TAG, CC_API_BASE_URL,
  SESSION_IDLE_TIMEOUT_MS, SESSION_START_TIMEOUT_MS,
  USER_AGENT, CLI_ENVIRONMENT, CONTENT_TYPE_HEADER,
  FAKE_GIT_BRANCH, FAKE_GIT_REPO, FAKE_WORKING_DIR_PREFIX,
} from "../config/cmcApiConstants.js";
import { generateTraceparent } from "./cmcApiFingerprint.js";

// In-memory session state: Map<connectionId, { sessionId, threadId, state, lastActivity, startPromise }>
const sessions = new Map();

// Idle timeout sweeper
let sweeperInterval = null;
function ensureSweeper() {
  if (sweeperInterval) return;
  sweeperInterval = setInterval(() => {
    const now = Date.now();
    for (const [connId, session] of sessions) {
      if (session.state === "ACTIVE" && (now - session.lastActivity) > SESSION_IDLE_TIMEOUT_MS) {
        debug(LOG_TAG, `Session for ${connId} idle for ${SESSION_IDLE_TIMEOUT_MS / 60000}min, ending`);
        endSession(connId).catch(() => {});
      }
    }
  }, SESSION_IDLE_TIMEOUT_MS / 2); // Check every ~2.5 minutes
  sweeperInterval.unref?.();
}

function buildLifecycleHeaders(apiKey, version, fingerprint) {
  return {
    "Content-Type": CONTENT_TYPE_HEADER,
    "Authorization": `Bearer ${apiKey}`,
    "Accept": "text/event-stream",
    "x-command-code-version": version,
    "x-cli-environment": CLI_ENVIRONMENT,
    "x-session-id": randomUUID(),
    "x-machine-id": fingerprint.machineId,
    "x-project-slug": fingerprint.projectSlug,
    "traceparent": generateTraceparent(),
    "User-Agent": USER_AGENT,
  };
}

function buildLifecycleBody(fingerprint, event, threadId) {
  return {
    threadId: threadId || randomUUID(),
    event,
    sessionId: randomUUID(),
    machineId: fingerprint.machineId,
    projectSlug: fingerprint.projectSlug,
    config: {
      workingDir: `${FAKE_WORKING_DIR_PREFIX}/${fingerprint.projectSlug}`,
      date: new Date().toISOString().slice(0, 10),
      environment: process.platform,
      structure: [],
      isGitRepo: FAKE_GIT_REPO,
      currentBranch: FAKE_GIT_BRANCH,
      mainBranch: FAKE_GIT_BRANCH,
      gitStatus: "",
      recentCommits: [],
    },
  };
}

export async function ensureSessionActive(connectionId, fingerprint, version, apiKey) {
  ensureSweeper();
  const existing = sessions.get(connectionId);
  if (existing?.state === "ACTIVE") {
    existing.lastActivity = Date.now();
    return;
  }

  const threadId = randomUUID();
  const body = buildLifecycleBody(fingerprint, "session-start", threadId);
  const headers = buildLifecycleHeaders(apiKey, version, fingerprint);

  const session = {
    sessionId: body.sessionId,
    threadId,
    state: "STARTING",
    lastActivity: Date.now(),
    startPromise: null,
  };
  sessions.set(connectionId, session);

  // Non-blocking: fire session-start, fail-open
  session.startPromise = (async () => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), SESSION_START_TIMEOUT_MS);
      const res = await fetch(CC_API_BASE_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) {
        debug(LOG_TAG, `session-start returned ${res.status}, proceeding anyway`);
      }
    } catch (err) {
      debug(LOG_TAG, `session-start failed: ${err.message}, proceeding anyway`);
    }
    // Mark ACTIVE regardless of success (fail-open)
    const s = sessions.get(connectionId);
    if (s) s.state = "ACTIVE";
  })();

  // Don't await — non-blocking
  return session.startPromise.catch(() => {});
}

export function recordActivity(connectionId) {
  const session = sessions.get(connectionId);
  if (session) session.lastActivity = Date.now();
}

export async function endSession(connectionId, fingerprint, version, apiKey) {
  const session = sessions.get(connectionId);
  if (!session) return;

  const body = buildLifecycleBody(fingerprint, "session-end", session.threadId);
  body.sessionId = session.sessionId; // same session
  const headers = buildLifecycleHeaders(apiKey, version, fingerprint);

  try {
    await fetch(CC_API_BASE_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    debug(LOG_TAG, `session-end failed: ${err.message}, ignoring`);
  }
  sessions.delete(connectionId);
}

// For testing
export function _clearSessions() { sessions.clear(); }
```

**Commit:** `feat(cmca): implement session manager service`

---

## Task 5: Create request translator

**File:** `open-sse/translator/request/openai-to-commandcode-api.js`
**Test file:** `tests/unit/openai-to-commandcode-api.test.js`

### 5a: Write tests first

**Test cases:**
- Basic message conversion: OpenAI messages → CC-API params.messages (content blocks format)
- System message extraction: system messages → `params.system` string (not in messages[])
- Tool conversion: OpenAI `tools[]` → CC-API `params.tools[]` (Anthropic-style `{name, description, input_schema}`)
- Tool call conversion: assistant `tool_calls` → `{type:"tool-call", toolCallId, toolName, input}`
- Tool result conversion: `tool` role messages → `{type:"tool-result", toolCallId, toolName, output}`
- **Image block pass-through**: `image_url` with data URI → `{type:"image", source:{type:"base64", media_type, data}}`
- **Image block pass-through**: `image_url` with HTTP URL → `{type:"image", source:{type:"url", url}}`
- **Image block**: non-data-URI, non-HTTP → `{type:"text", text:"[image omitted]"}`
- **File block pass-through**: `file` type with file data → passed through
- **reasoning_effort**: `body.reasoning_effort` → `params.reasoning_effort` (pass-through, "none" stripped)
- **max_tokens capping**: `body.max_tokens > MAX_TOKENS_CAP` → capped to `MAX_TOKENS_CAP`
- **max_tokens default**: missing `max_tokens` → `DEFAULT_MAX_TOKENS`
- **temperature**: `body.temperature` passed through, default `DEFAULT_TEMPERATURE`
- **tool_choice mapping**: `"auto"` → `"auto"`, `"required"` → `"any"`, `{type:"function",function:{name:"x"}}` → `{type:"tool",name:"x"}`
- **parallel_tool_calls**: `body.parallel_tool_calls` → `params.parallel_tool_calls` (pass-through)
- **Default system prompt**: when no system message provided → `params.system = DEFAULT_SYSTEM_PROMPT`
- **Body envelope**: output has `threadId`, `memory`, `config`, `params`
- **Config enrichment**: `config.workingDir` uses fake project slug, `config.isGitRepo = true`
- All hardcoded values come from `cmcApiConstants.js`

**Commit:** `test(cmca): add request translator tests`

### 5b: Implement request translator

```js
// open-sse/translator/request/openai-to-commandcode-api.js
import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { randomUUID } from "crypto";
import { ROLE, OPENAI_BLOCK } from "../schema/index.js";
import { parseDataUri } from "../concerns/image.js";
import {
  DEFAULT_MAX_TOKENS, MAX_TOKENS_CAP, DEFAULT_TEMPERATURE,
  DEFAULT_SYSTEM_PROMPT,
  FAKE_GIT_BRANCH, FAKE_GIT_REPO, FAKE_WORKING_DIR_PREFIX,
} from "../../config/cmcApiConstants.js";

function flattenText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map(p => typeof p === "string" ? p : (p?.text ?? ""))
      .join("\n");
  }
  return String(content);
}

function safeParseJson(s) {
  if (s == null) return {};
  if (typeof s !== "string") return s;
  try { return JSON.parse(s); } catch { return {}; }
}

function toContentBlocks(content) {
  if (content == null) return [{ type: "text", text: "" }];
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) {
    const blocks = [];
    for (const part of content) {
      if (typeof part === "string") {
        blocks.push({ type: "text", text: part });
      } else if (part && typeof part === "object") {
        // Text blocks
        if (part.type === "text" && typeof part.text === "string") {
          blocks.push({ type: "text", text: part.text });
        }
        // Image blocks — pass through (multimodal support)
        else if (part.type === "image_url" || part.type === "image") {
          const url = part.image_url?.url || part.url || part.source?.url;
          if (url) {
            const parsed = parseDataUri(url);
            if (parsed) {
              blocks.push({
                type: "image",
                source: { type: "base64", media_type: parsed.mimeType, data: parsed.base64 },
              });
            } else if (url.startsWith("http://") || url.startsWith("https://")) {
              blocks.push({ type: "image", source: { type: "url", url } });
            } else {
              blocks.push({ type: "text", text: "[image omitted]" });
            }
          }
        }
        // File blocks — pass through
        else if (part.type === "file" && part.file) {
          blocks.push({ type: "file", file: part.file });
        }
        // Fallback: extract text if available
        else if (typeof part.text === "string") {
          blocks.push({ type: "text", text: part.text });
        }
      }
    }
    return blocks.length ? blocks : [{ type: "text", text: "" }];
  }
  return [{ type: "text", text: String(content) }];
}

function convertMessages(openaiMessages) {
  const messages = [];
  let system = null;

  for (const msg of openaiMessages) {
    if (msg.role === "system") {
      system = flattenText(msg.content);
      continue;
    }
    if (msg.role === "tool" || msg.role === "function") {
      messages.push({
        role: "user",
        content: [{
          type: "tool-result",
          toolCallId: msg.tool_call_id || "unknown",
          toolName: msg.name || "unknown",
          output: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? ""),
        }],
      });
      continue;
    }
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
      const content = [];
      const textParts = typeof msg.content === "string" ? [msg.content] : [];
      if (Array.isArray(msg.content)) {
        for (const p of msg.content) {
          if (typeof p === "string") textParts.push(p);
          else if (p?.type === "text") textParts.push(p.text);
          else if (p?.type === "tool_use") {
            content.push({
              type: "tool-call",
              toolCallId: p.id,
              toolName: p.name,
              input: p.input ?? safeParseJson(p.input),
            });
          }
        }
      }
      for (const tc of msg.tool_calls) {
        if (tc.type === "function" || tc.function) {
          content.push({
            type: "tool-call",
            toolCallId: tc.id,
            toolName: tc.function?.name || tc.name || "unknown",
            input: safeParseJson(tc.function?.arguments || tc.input),
          });
        }
      }
      if (textParts.length) {
        content.unshift({ type: "text", text: textParts.join("\n") });
      }
      messages.push({ role: "assistant", content });
      continue;
    }
    // Regular user/assistant messages
    messages.push({
      role: msg.role === "assistant" ? "assistant" : "user",
      content: toContentBlocks(msg.content),
    });
  }

  return { messages, system };
}

function convertTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return null;
  return tools.map(tool => {
    const td = tool.function || tool;
    return {
      name: td.name,
      description: td.description || "",
      input_schema: td.parameters || td.input_schema || { type: "object", properties: {}, required: [] },
    };
  });
}

function convertToolChoice(tc) {
  if (!tc) return undefined;
  if (typeof tc === "string") {
    // "auto" → "auto", "required" → "any", "none" → "none"
    if (tc === "required") return "any";
    return tc;
  }
  if (tc.type === "function" && tc.function?.name) {
    return { type: "tool", name: tc.function.name };
  }
  if (tc.type === "tool" && tc.name) {
    return { type: "tool", name: tc.name };
  }
  return "auto";
}

export function openaiToCommandCodeApiRequest(model, body, stream) {
  const { messages, system } = convertMessages(body.messages);
  const params = {
    model,
    messages,
    stream: stream !== false,
    max_tokens: Math.min(body.max_tokens ?? body.max_output_tokens ?? DEFAULT_MAX_TOKENS, MAX_TOKENS_CAP),
    temperature: body.temperature ?? DEFAULT_TEMPERATURE,
  };

  // System prompt — use provided or default
  params.system = system || DEFAULT_SYSTEM_PROMPT;

  const tools = convertTools(body.tools);
  if (tools) params.tools = tools;

  // tool_choice mapping
  const tc = convertToolChoice(body.tool_choice);
  if (tc) params.tool_choice = tc;

  // parallel_tool_calls pass-through
  if (body.parallel_tool_calls != null) params.parallel_tool_calls = body.parallel_tool_calls;

  // reasoning_effort pass-through (strip "none")
  if (body.reasoning_effort && body.reasoning_effort !== "none") {
    params.reasoning_effort = body.reasoning_effort;
  }

  if (body.top_p != null) params.top_p = body.top_p;

  const today = new Date().toISOString().slice(0, 10);

  return {
    threadId: randomUUID(),
    memory: "",
    config: {
      workingDir: `${FAKE_WORKING_DIR_PREFIX}/${body._cmcApiProjectSlug || "project"}`,
      date: today,
      environment: process.platform,
      structure: [],
      isGitRepo: FAKE_GIT_REPO,
      currentBranch: FAKE_GIT_BRANCH,
      mainBranch: FAKE_GIT_BRANCH,
      gitStatus: "",
      recentCommits: [],
    },
    params,
  };
}

register(FORMATS.OPENAI, FORMATS.COMMANDCODE_API, openaiToCommandCodeApiRequest, null);
```

**Commit:** `feat(cmca): implement request translator with image/file/multimodal support`

---

## Task 6: Create response translator

**File:** `open-sse/translator/response/commandcode-api-to-openai.js`
**Test file:** `tests/unit/commandcode-api-to-openai.test.js`

### 6a: Write tests first

**Test cases:**
- `text-delta` event → emits OpenAI chunk with `delta.content`
- `reasoning-delta` event → emits OpenAI chunk with reasoning delta
- `tool-call` event → emits OpenAI chunk with `delta.tool_calls`
- `tool-input-delta` event → emits OpenAI chunk with tool call argument delta
- `finish` event → emits final chunk with `finish_reason: "stop"` + usage
- `error` event → emits error chunk with message + `finish_reason: "stop"`
- **Zero-output guard**: if `finish` event arrives with no content chunks emitted, emit an error chunk
- All other event types (`start`, `start-step`, `text-start`, etc.) → ignored (no chunks)
- State tracking: `responseId`, `created`, `model`, `chunkIndex` maintained correctly
- Pass-through: already-OpenAI chunk objects pass through unchanged

**Commit:** `test(cmca): add response translator tests`

### 6b: Implement response translator

```js
// open-sse/translator/response/commandcode-api-to-openai.js
import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { OPENAI_FINISH } from "../schema/index.js";
import { buildChunk } from "../concerns/chunk.js";
import { toOpenAIUsage } from "../concerns/usage.js";
import { reasoningDelta } from "../concerns/reasoning.js";
import { fallbackToolCallId } from "../concerns/toolCall.js";
import { toOpenAIFinish } from "../concerns/finishReason.js";
import {
  LOG_TAG,
} from "../../config/cmcApiConstants.js";
import { debug } from "@/sse/utils/logger.js";

function ensureState(state, model) {
  if (!state.responseId) {
    state.responseId = `chatcmpl-${Date.now()}`;
    state.created = Math.floor(Date.now() / 1000);
    state.model = state.model || model || "commandcode-api";
    state.chunkIndex = 0;
    state.toolIndex = 0;
    state.toolIndexById = new Map();
    state.openTools = new Set();
    state.openText = false;
    state.finishReason = null;
    state.usage = null;
    state.hasContent = false; // zero-output guard
  }
}

function makeChunk(state, delta, finishReason = null) {
  return buildChunk(
    { id: state.responseId, created: state.created, model: state.model },
    delta,
    finishReason
  );
}

const mapFinishReason = (reason) => toOpenAIFinish(reason, "commandcode-api");

export function commandCodeApiToOpenAIResponse(chunk, state) {
  if (!chunk) return null;

  // Already-OpenAI chunk: pass through
  if (chunk && typeof chunk === "object" && chunk.object === "chat.completion.chunk") {
    return chunk;
  }

  let event = chunk;
  if (typeof chunk === "string") {
    const line = chunk.trim();
    if (!line) return null;
    try { event = JSON.parse(line); } catch { return null; }
  }

  ensureState(state, event.model);
  const out = [];

  switch (event.type) {
    case "text-delta": {
      state.hasContent = true;
      out.push(makeChunk(state, { content: event.text || "" }));
      break;
    }
    case "reasoning-delta": {
      state.hasContent = true;
      out.push(reasoningDelta(state, event.text || "", makeChunk));
      break;
    }
    case "tool-input-delta": {
      const idx = state.toolIndexById.get(event.id);
      if (idx !== undefined) {
        out.push(makeChunk(state, {
          tool_calls: [{ index: idx, function: { arguments: event.delta || "" } }],
        }));
      }
      break;
    }
    case "tool-call": {
      state.hasContent = true;
      const toolCallId = event.toolCallId || fallbackToolCallId(state);
      const idx = state.toolIndex;
      state.toolIndexById.set(event.id || toolCallId, idx);
      state.toolIndex++;
      out.push(makeChunk(state, {
        tool_calls: [{
          index: idx,
          id: toolCallId,
          type: "function",
          function: {
            name: event.toolName || "unknown",
            arguments: typeof event.input === "string" ? event.input : JSON.stringify(event.input ?? {}),
          },
        }],
      }));
      break;
    }
    case "finish": {
      let finishReason = mapFinishReason(event.finishReason) || OPENAI_FINISH.STOP;

      // Zero-output guard: if no content was emitted, send an error message
      if (!state.hasContent) {
        debug(LOG_TAG, "Zero-output detected — emitting fallback error chunk");
        out.push(makeChunk(state, { content: "[No response received from CommandCode API]" }));
      }

      const finalChunk = makeChunk(state, {}, finishReason);
      const totalUsage = event.totalUsage || state.usage;
      const usage = toOpenAIUsage(totalUsage, "commandcode-api");
      if (usage) finalChunk.usage = usage;
      out.push(finalChunk);
      break;
    }
    case "error": {
      state.finishReason = OPENAI_FINISH.STOP;
      const errVal = event.error ?? event.message ?? "unknown";
      const errStr = typeof errVal === "string" ? errVal : JSON.stringify(errVal);
      out.push(makeChunk(state, { content: `\n\n[CommandCode API error: ${errStr}]` }));
      out.push(makeChunk(state, {}, OPENAI_FINISH.STOP));
      break;
    }
    default:
      break;
  }

  return out.length ? out : null;
}

register(FORMATS.COMMANDCODE_API, FORMATS.OPENAI, null, commandCodeApiToOpenAIResponse);
```

**Commit:** `feat(cmca): implement response translator with zero-output guard`

---

## Task 7: Create registry entry + provider logo

**File:** `open-sse/providers/registry/commandcode-api.js`
**Logo:** `public/providers/commandcode-api.png` (copy from `commandcode.png`)

```js
// open-sse/providers/registry/commandcode-api.js
export default {
  id: "commandcode-api",
  priority: 902,
  alias: "cmca",
  aliases: ["commandcode-api"],
  uiAlias: "cmca",
  display: {
    name: "Command Code API",
    icon: "smart_toy",
    color: "#1a1a2e",
    textIcon: "CC",
    website: "https://commandcode.ai",
    notice: {
      text: "Use your CommandCode CLI API key (starts with user_...). This provider includes enhanced anti-detection (fingerprinting, CLI version tracking, session lifecycle) for account safety. Reference: github.com/MAXeaglet/commandcode-proxy",
      apiKeyUrl: "https://commandcode.ai/studio",
    },
  },
  category: "apikey",
  transport: {
    baseUrl: "https://api.commandcode.ai/alpha/generate",
    format: "commandcodeapi",
    forceStream: true,
    // No static headers — executor builds them dynamically with anti-detection
  },
  models: [
    // Same model list as commandcode-proxy (25+ models)
    { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash" },
    { id: "moonshotai/Kimi-K2.6", name: "Kimi K2.6" },
    { id: "moonshotai/Kimi-K2.5", name: "Kimi K2.5" },
    { id: "zai-org/GLM-5.1", name: "GLM 5.1" },
    { id: "zai-org/GLM-5", name: "GLM 5" },
    { id: "MiniMaxAI/MiniMax-M2.7", name: "MiniMax M2.7" },
    { id: "MiniMaxAI/MiniMax-M2.5", name: "MiniMax M2.5" },
    { id: "Qwen/Qwen3.6-Max-Preview", name: "Qwen 3.6 Max Preview" },
    { id: "Qwen/Qwen3.6-Plus", name: "Qwen 3.6 Plus" },
    { id: "stepfun/Step-3.5-Flash", name: "Step 3.5 Flash" },
    // Additional models from commandcode-proxy:
    { id: "Anthropic/Claude-Sonnet-4.5", name: "Claude Sonnet 4.5" },
    { id: "Anthropic/Claude-Opus-4.5", name: "Claude Opus 4.5" },
    { id: "OpenAI/GPT-5.5", name: "GPT 5.5" },
    { id: "OpenAI/o4-pro", name: "o4 Pro" },
    { id: "google/gemini-3-pro", name: "Gemini 3 Pro" },
    { id: "google/gemini-3-flash", name: "Gemini 3 Flash" },
    { id: "Xiaomi/MiMo-2", name: "MiMo 2" },
  ],
  features: {
    usage: true,
  },
};
```

**Logo:** Copy `public/providers/commandcode.png` → `public/providers/commandcode-api.png`

```bash
cp public/providers/commandcode.png public/providers/commandcode-api.png
```

**Commit:** `feat(cmca): add registry entry and provider logo`

---

## Task 8: Create executor

**File:** `open-sse/executors/commandcode-api.js`

```js
// open-sse/executors/commandcode-api.js
import { randomUUID } from "crypto";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { commandCodeApiToOpenAIResponse } from "../translator/response/commandcode-api-to-openai.js";
import { SSE_DONE } from "../utils/sseConstants.js";
import { debug } from "@/sse/utils/logger.js";
import {
  LOG_TAG, CC_API_BASE_URL,
  CLI_ENVIRONMENT, USER_AGENT, ACCEPT_HEADER, CONTENT_TYPE_HEADER,
} from "../config/cmcApiConstants.js";
import { getFingerprint, generateTraceparent } from "../services/cmcApiFingerprint.js";
import { getLatestVersion } from "../services/cmcApiVersionTracker.js";
import { ensureSessionActive, recordActivity } from "../services/cmcApiSessionManager.js";

export class CommandCodeApiExecutor extends BaseExecutor {
  constructor() {
    super("commandcode-api", PROVIDERS["commandcode-api"]);
  }

  transformRequest(model, body, stream, credentials) {
    body.stream = true;
    // Inject project slug for config enrichment in translator
    const fp = getFingerprint(credentials, credentials?.providerSpecificData);
    body._cmcApiProjectSlug = fp.projectSlug;
    // Store fingerprint back to credentials for executor use
    credentials._cmcApiFingerprint = fp;
    return body;
  }

  buildHeaders(credentials, stream = true) {
    const fp = credentials?._cmcApiFingerprint || {};
    const version = credentials?._cmcApiVersion || "0.40.5";

    const headers = {
      "Content-Type": CONTENT_TYPE_HEADER,
      "Authorization": `Bearer ${credentials?.apiKey || credentials?.accessToken || ""}`,
      "Accept": ACCEPT_HEADER,
      "x-command-code-version": version,
      "x-cli-environment": CLI_ENVIRONMENT,
      "x-session-id": randomUUID(),
      "x-machine-id": fp.machineId || "",
      "x-project-slug": fp.projectSlug || "",
      "traceparent": generateTraceparent(),
      "User-Agent": USER_AGENT,
    };

    if (stream) headers["Accept"] = ACCEPT_HEADER;
    return headers;
  }

  async execute(opts) {
    const { credentials, model } = opts;

    // 1. Get fingerprint (persistent per connection)
    const fingerprint = getFingerprint(credentials, credentials?.providerSpecificData);
    credentials._cmcApiFingerprint = fingerprint;

    // 2. Get latest CLI version
    const version = await getLatestVersion();
    credentials._cmcApiVersion = version;

    // 3. Ensure session is active (non-blocking, fail-open)
    const connectionId = credentials?.connectionId || credentials?.id || "default";
    ensureSessionActive(connectionId, fingerprint, version, credentials?.apiKey).catch(() => {});

    // 4. Execute the actual request via BaseExecutor
    const result = await super.execute(opts);

    // 5. Record activity for session TTL
    recordActivity(connectionId);

    // 6. Wrap NDJSON response as OpenAI SSE
    if (!result?.response?.ok || !result.response.body) {
      debug(LOG_TAG, `Upstream returned ${result?.response?.status || "no response"}`);
      return result;
    }

    result.response = wrapNdjsonAsOpenAISse(result.response, model);
    return result;
  }
}

function wrapNdjsonAsOpenAISse(originalResponse, model) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const state = { model };

  const emitChunks = (chunks, controller) => {
    if (!chunks) return;
    const list = Array.isArray(chunks) ? chunks : [chunks];
    for (const c of list) {
      if (c == null) continue;
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
        emitChunks(commandCodeApiToOpenAIResponse(trimmed, state), controller);
      }
    },
    flush(controller) {
      const trimmed = buffer.trim();
      if (trimmed) {
        emitChunks(commandCodeApiToOpenAIResponse(trimmed, state), controller);
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
```

**Commit:** `feat(cmca): implement executor with anti-detection orchestration`

---

## Task 9: Wire up — registry, executors, translators, validate route

### 9a: Regenerate registry index

**File:** `open-sse/providers/registry/index.js`

Add import for `commandcode-api.js` (alphabetical order, after `commandcode.js`):

```js
import p21 from "./commandcode.js";
import p22 from "./commandcode-api.js";   // NEW
import p23 from "./coqui.js";             // was p22
// ... renumber all subsequent imports
```

Add `p22` to the exported array.

### 9b: Register executor

**File:** `open-sse/executors/index.js`

```js
import { CommandCodeApiExecutor } from "./commandcode-api.js";
// ...
const executors = {
  // ...
  commandcode: new CommandCodeExecutor(),
  "commandcode-api": new CommandCodeApiExecutor(),   // NEW
  // ...
};
```

### 9c: Import translators

**File:** `open-sse/translator/index.js`

Add at the bottom with other translator imports:

```js
import "./request/openai-to-commandcode-api.js";
import "./response/commandcode-api-to-openai.js";
```

### 9d: Add validation for commandcode-api

**File:** `src/app/api/providers/validate/route.js`

Add a case for `commandcode-api` in the provider validation switch (same pattern as `commandcode`):

```js
case "commandcode-api": {
  // Same validation as commandcode: send a minimal request
  const cfg = PROVIDERS["commandcode-api"];
  const defaultModel = getDefaultModel("commandcode-api") || "deepseek/deepseek-v4-pro";
  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${apiKey}`,
    "x-cli-environment": "cli",
  };
  const res = await fetch(cfg.baseUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      threadId: crypto.randomUUID(),
      memory: "",
      config: { workingDir: "/tmp", date: new Date().toISOString().slice(0,10), environment: "linux", structure: [], isGitRepo: false, currentBranch: "", mainBranch: "", gitStatus: "", recentCommits: [] },
      params: { model: defaultModel, messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }], stream: true, max_tokens: 1, temperature: 0.3, system: "ping" },
    }),
    signal: AbortSignal.timeout(10000),
  });
  isValid = res.status !== 401 && res.status !== 403;
  break;
}
```

**Commit:** `feat(cmca): wire up registry, executor, translators, and validation`

---

## Task 10: Integration test

**File:** `tests/unit/commandcode-api-executor.test.js`

Test the full executor flow with a mocked upstream:

- Mock `fetch` to return NDJSON response
- Verify executor builds all 10 anti-detection headers
- Verify NDJSON is correctly translated to OpenAI SSE chunks
- Verify session-start is called on first request
- Verify `recordActivity` is called after request
- Verify zero-output guard emits fallback on empty response

**Commit:** `test(cmca): add executor integration tests`

---

## Task 11: Golden header tests

**File:** `tests/translator/golden-url-header.test.js` (extend existing)

Add test case for `commandcode-api`:
- Verify all 10 anti-detection headers are present
- Verify `x-command-code-version` is a valid semver string
- Verify `x-machine-id` matches `m` + 32 hex format
- Verify `x-project-slug` is kebab-case
- Verify `traceparent` matches W3C format
- Verify `User-Agent` is `node`

**Commit:** `test(cmca): add golden header tests`

---

## Task 12: Smoke test and final verification

1. Run the full test suite: `npm test`
2. Start 9router locally and add a `commandcode-api` provider with a real API key
3. Send a test chat completion request through the 9router API
4. Verify the response streams correctly
5. Verify the existing `commandcode` provider still works unchanged
6. Check 9router dashboard shows the new provider in the provider list with logo
7. Test multi-account: add a second API key, verify independent fingerprints
8. Test image input: send a request with an image_url block, verify it passes through

**Commit:** `docs(cmca): mark implementation complete`

---

## Dependency Order

```
Task 1 (constants + format)        ← no dependencies
Task 2 (fingerprint service)       ← depends on Task 1 (constants)
Task 3 (version tracker service)   ← depends on Task 1 (constants)
Task 4 (session manager service)   ← depends on Tasks 1, 2 (constants, fingerprint types)
Task 5 (request translator)        ← depends on Task 1 (format + constants)
Task 6 (response translator)       ← depends on Task 1 (format + constants)
Task 7 (registry entry + logo)     ← no dependencies
Task 8 (executor)                  ← depends on Tasks 1, 2, 3, 4, 6
Task 9 (wire up)                   ← depends on Tasks 1, 5, 6, 7, 8
Task 10 (integration test)         ← depends on Task 9
Task 11 (golden header test)       ← depends on Task 9
Task 12 (smoke test)               ← depends on Tasks 10, 11
```

Tasks 1, 7 can be done in parallel. Tasks 2, 3 can be done in parallel after Task 1. Tasks 5, 6 can be done in parallel after Task 1. Task 4 depends on Tasks 1, 2. Task 8 depends on 1, 2, 3, 4, 6. Task 9 wires everything together.

## Key References

| File | Purpose |
|------|---------|
| `open-sse/executors/commandcode.js` | Template for the new executor |
| `open-sse/executors/base.js` | Base class to extend |
| `open-sse/translator/request/openai-to-commandcode.js` | Template for request translator |
| `open-sse/translator/response/commandcode-to-openai.js` | Template for response translator |
| `open-sse/providers/registry/commandcode.js` | Template for registry entry |
| `open-sse/translator/formats.js` | Where to add format constant |
| `open-sse/translator/schema/blocks.js` | Block type constants (IMAGE_URL, IMAGE, FILE, etc.) |
| `open-sse/translator/concerns/image.js` | Image parsing utilities (parseDataUri) |
| `open-sse/config/runtimeConfig.js` | DEFAULT_MAX_TOKENS reference |
| `src/sse/utils/logger.js` | Logger utility (debug, info, warn, error) |
| `open-sse/executors/index.js` | Where to register executor |
| `open-sse/translator/index.js` | Where to import translators |
| `open-sse/providers/registry/index.js` | Auto-generated registry (regenerate) |
| `open-sse/AGENTS.md` | Architecture guide and pitfalls |
| [commandcode-proxy](https://github.com/MAXeaglet/commandcode-proxy) | Reference project for anti-detection logic |
