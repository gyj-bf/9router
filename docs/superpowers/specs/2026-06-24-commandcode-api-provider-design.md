# Design Spec: commandcode-api Provider (cmca)

**Date:** 2026-06-24
**Status:** Draft (pending user review)
**Branch:** `feat/commandcode-api-provider`
**Reference:** [commandcode-proxy](https://github.com/MAXeaglet/commandcode-proxy) — reverse-engineering project that informed all anti-detection logic in this spec.

## 1. Problem Statement

The existing `commandcode` provider in 9router (id: `commandcode`, alias: `cmc`) sends minimal anti-detection headers — only `x-command-code-version: 0.25.7` (hardcoded), `x-cli-environment: cli`, and a per-request `x-session-id` (random UUID). Upstream issue [#1528](https://github.com/decolua/9router/issues/1528) documents that CommandCode has tightened detection, resulting in bans and restrictions for users of the existing provider.

The [commandcode-proxy](https://github.com/MAXeaglet/commandcode-proxy) project reverse-engineers the real CommandCode CLI (`command-code` npm package) and implements sophisticated anti-detection: dynamic CLI version tracking, fake device fingerprints, session/project slug spoofing, W3C traceparent headers, and lifecycle event simulation.

This spec defines a new, independent provider `commandcode-api` (alias: `cmca`) that ports all commandcode-proxy anti-detection logic into 9router's native provider system. The existing `commandcode` provider remains untouched and operational.

## 2. Goals

1. **Full anti-detection parity with commandcode-proxy** — every header, body field, and lifecycle behavior the proxy implements
2. **Complete independence from the existing `commandcode` provider** — separate registry entry, executor, translators, and format ID
3. **Multi-account support** — each API key (connection) gets its own persistent fingerprint and session state
4. **Minimal fingerprint surface** — realistic, stable, per-account identity that mimics a real CLI session
5. **No changes to 9router's connection management** — leverage existing `providerConnections` table, round-robin/fill-first selection, and fallback system
6. **Image/File input support** — pass through image and file content blocks to the CC API instead of stripping them
7. **Graceful failure handling** — zero-output guard, fail-open lifecycle events, graceful error messages
8. **Complete field envelope** — all OpenAI request fields mapped: `reasoning_effort`, `max_tokens` capping, `temperature`, `tool_choice`, `parallel_tool_calls`

## 3. Non-Goals

- Modifying or removing the existing `commandcode` provider
- Supporting non-chat endpoints in the initial implementation (embeddings, TTS, STT, etc.)
- Building a standalone proxy server (this integrates into 9router's provider system)
- Automatic API key rotation or creation

## 4. Architecture

### 4.1 Approach: Standalone Executor with Integrated Anti-Detection

The provider follows 9router's existing provider pattern (registry → executor → translator) with all anti-detection logic encapsulated in dedicated service modules.

```
Client (Claude/Codex/Cursor/etc.)
  │ POST /v1/chat/completions
  ▼
9router chat handler (src/sse/handlers/chat.js)
  │ resolve provider "commandcode-api" → get connection(s)
  │ get/create fingerprint for this connection (cmcApiFingerprint.js)
  │ check session state → send session-start if needed (cmcApiSessionManager.js)
  │ translateRequest: openai → commandcodeapi (openai-to-commandcode-api.js)
  │   enriches body with: threadId, config, project slug, fake git data
  │   maps: reasoning_effort, tool_choice, parallel_tool_calls, image blocks
  │ executor.buildHeaders() with anti-detection headers (commandcode-api.js)
  │ executor.execute() → POST https://api.commandcode.ai/alpha/generate
  │ NDJSON response → translateResponse: commandcodeapi → openai
  │   zero-output guard: if no content chunks, emit error chunk
  │ stream OpenAI chunks back to client
  │ update session activity timestamp
  ▼
Client receives OpenAI-format SSE stream
```

### 4.2 File Structure

```
open-sse/
  config/
    cmcApiConstants.js               ← NEW: All hardcoded constants in one module

  providers/registry/
    commandcode-api.js              ← NEW: Provider definition

  executors/
    commandcode-api.js              ← NEW: CommandCodeApiExecutor (extends BaseExecutor)

  translator/
    request/
      openai-to-commandcode-api.js  ← NEW: OpenAI → CC-API request translator
    response/
      commandcode-api-to-openai.js  ← NEW: CC-API → OpenAI response translator

  services/
    cmcApiFingerprint.js            ← NEW: Fingerprint generation & persistence
    cmcApiVersionTracker.js         ← NEW: CLI version tracking from npm
    cmcApiSessionManager.js         ← NEW: Session lifecycle manager

  providers/registry/index.js       ← REGENERATE (auto-generated)
  executors/index.js                ← MODIFY: Register new executor
  translator/index.js               ← MODIFY: Import new translators
  translator/formats.js             ← MODIFY: Add COMMANDCODE_API format

src/
  sse/utils/logger.js               ← EXISTING: Use debug/info/warn/error from here
  app/api/providers/validate/
    route.js                        ← MODIFY: Add validation for commandcode-api

public/providers/
  commandcode-api.png               ← NEW: Provider logo image

tests/
  unit/
    cmcApiFingerprint.test.js       ← NEW
    cmcApiVersionTracker.test.js    ← NEW
    cmcApiSessionManager.test.js    ← NEW
    openai-to-commandcode-api.test.js   ← NEW
    commandcode-api-to-openai.test.js   ← NEW
```

### 4.3 Component Responsibilities

| Component | Responsibility | Dependencies |
|-----------|---------------|--------------|
| `config/cmcApiConstants.js` | All hardcoded constants: TTLs, defaults, word lists, header values, log tag, max_tokens cap | None |
| `registry/commandcode-api.js` | Provider metadata: id, alias, display, transport config, model list | None |
| `executors/commandcode-api.js` | Orchestrates request execution: builds headers (with anti-detection), sends request upstream, wraps NDJSON response as OpenAI SSE, zero-output guard | `cmcApiFingerprint`, `cmcApiVersionTracker`, `cmcApiSessionManager`, `cmcApiConstants`, `BaseExecutor`, `logger.js` |
| `translator/request/openai-to-commandcode-api.js` | Converts OpenAI chat completion body → CC-API body schema; enriches with `threadId`, `config`, anti-detection fields; maps `reasoning_effort`, `tool_choice`, `parallel_tool_calls`; passes through image blocks | `translator/index.js` (register), `schema/`, `cmcApiConstants` |
| `translator/response/commandcode-api-to-openai.js` | Converts CC-API NDJSON stream events → OpenAI chat.completion.chunk SSE; zero-output guard | `translator/index.js` (register), `concerns/`, `cmcApiConstants` |
| `services/cmcApiFingerprint.js` | Generates and persists per-connection fingerprints: machine ID, project slug, traceparent | `cmcApiConstants`, `logger.js` |
| `services/cmcApiVersionTracker.js` | Fetches latest `command-code` npm version, caches with TTL, falls back on failure | `cmcApiConstants`, `logger.js`, `proxyAwareFetch` |
| `services/cmcApiSessionManager.js` | Manages per-connection session lifecycle: session-start/session-end events, idle timeout | `cmcApiFingerprint`, `cmcApiVersionTracker`, `cmcApiConstants`, `logger.js` |

## 5. Anti-Detection Design

### 5.1 Constants Module (`cmcApiConstants.js`)

All hardcoded values live in one module for easy maintenance. If a value needs to change in the future (e.g., CLI version fallback, TTLs, log tag, max_tokens cap), you update it in one place.

```js
// open-sse/config/cmcApiConstants.js

// ── Log Tag ──
export const LOG_TAG = "CMC API";

// ── CLI Version Tracking ──
export const DEFAULT_CLI_VERSION = "0.40.5";
export const NPM_REGISTRY_URL = "https://registry.npmjs.org/command-code/latest";
export const VERSION_CACHE_TTL_MS = parseInt(process.env.CMC_API_VERSION_CACHE_TTL_MS || "7200000", 10); // 2 hours

// ── Session Lifecycle ──
export const SESSION_IDLE_TIMEOUT_MS = parseInt(process.env.CMC_API_SESSION_IDLE_TIMEOUT_MS || "300000", 10); // 5 minutes
export const SESSION_START_TIMEOUT_MS = parseInt(process.env.CMC_API_SESSION_START_TIMEOUT_MS || "10000", 10); // 10 seconds

// ── Fingerprint ──
export const PROJECT_SLUG_TTL_MS = parseInt(process.env.CMC_API_PROJECT_SLUG_TTL_MS || "86400000", 10); // 24 hours

// ── Static Header Values ──
export const CLI_ENVIRONMENT = "cli";
export const USER_AGENT = "node";
export const ACCEPT_HEADER = "text/event-stream";
export const CONTENT_TYPE_HEADER = "application/json";

// ── Request Body Defaults ──
export const DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant that helps with software engineering tasks.";
export const DEFAULT_TEMPERATURE = 0.3;
export const DEFAULT_MAX_TOKENS = 16384;
export const MAX_TOKENS_CAP = 64000; // CC API max — requests above this are capped

// ── Fake Config ──
export const FAKE_GIT_BRANCH = "main";
export const FAKE_GIT_REPO = true;
export const FAKE_WORKING_DIR_PREFIX = "/home/user";

// ── CC API URL ──
export const CC_API_BASE_URL = "https://api.commandcode.ai/alpha/generate";

// ── Word Lists for Project Slug Generation ──
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

### 5.2 Fingerprint System (`cmcApiFingerprint.js`)

Each API key (connection) gets a stable, persistent identity that mimics a real CLI installation.

#### 5.2.1 Machine ID

- **Format:** `m` + 32 lowercase hex characters (e.g., `m3a7f2b1c9e8d4a6f0b2c5e7d1a3f9b4`)
- **Generation:** `crypto.randomBytes(16).toString('hex')` prefixed with `m`
- **Persistence:** Stored in connection `data.cmcApi.machineId`
- **Lifecycle:** Generated once per connection, never changes (real CLI machine ID is stable)

#### 5.2.2 Project Slug

- **Format:** kebab-case, 2-4 words from curated word lists (e.g., `crimson-ferret-theory`, `azure-mountain-logic`)
- **Generation:** Random selection from `ADJECTIVES` list + `NOUNS` list + optional third word
- **Word lists:** Curated to look like real project names — no generic terms like "test" or "project"
- **Persistence:** Stored in connection `data.cmcApi.projectSlug`
- **Lifecycle:** Rotates every `PROJECT_SLUG_TTL_MS` (default: 24 hours) to avoid pattern detection without being erratic

#### 5.2.3 Traceparent (W3C Distributed Tracing)

- **Format:** `00-<32-hex trace-id>-<16-hex span-id>-<2-hex flags>`
  - Example: `00-a1b2c3d4e5f6789012345678abcdef01-b8e4e98753a04e6c-01`
- **Generation:** Per-request, random trace-id (16 bytes hex) + random span-id (8 bytes hex) + flags `01` (sampled)
- **Purpose:** Real CLI sends W3C traceparent headers; absence is a detection signal

#### 5.2.4 Fingerprint Data Schema

Stored in `providerConnections.data` JSON under `cmcApi` namespace:

```json
{
  "apiKey": "user_xxx",
  "cmcApi": {
    "machineId": "m3a7f2b1c9e8d4a6f0b2c5e7d1a3f9b4",
    "projectSlug": "crimson-ferret-theory",
    "projectSlugUpdatedAt": "2026-06-24T10:30:00Z",
    "cliVersion": "0.40.5",
    "cliVersionFetchedAt": "2026-06-24T10:00:00Z"
  }
}
```

#### 5.2.5 API

```js
// Get or create a fingerprint for a connection
export function getOrCreateFingerprint(credentials) → { machineId, projectSlug, projectSlugUpdatedAt, cliVersion, cliVersionFetchedAt }

// Generate a W3C traceparent string
export function generateTraceparent() → string

// Rotate the project slug if it's older than PROJECT_SLUG_TTL_MS
export function maybeRotateProjectSlug(fingerprint) → fingerprint (possibly updated)
```

### 5.3 CLI Version Tracking (`cmcApiVersionTracker.js`)

Ensures the `x-command-code-version` header always matches the latest published npm version.

#### 5.3.1 Flow

1. Check in-memory cache (Map with TTL)
2. If cache expired or empty → fetch `NPM_REGISTRY_URL`
3. Parse `version` from JSON response
4. Cache for `VERSION_CACHE_TTL_MS` (default: **2 hours**)
5. If npm unreachable → fall back to `DEFAULT_CLI_VERSION` (`"0.40.5"`)
6. Return version string

#### 5.3.2 Cache Structure

```js
// In-memory cache (per process lifetime)
{ version: "0.40.5", fetchedAt: 1719234567890 }
```

#### 5.3.3 API

```js
export async function getCliVersion() → Promise<string>
```

### 5.4 Session Lifecycle Manager (`cmcApiSessionManager.js`)

Simulates a real CLI session by sending lifecycle events to the CommandCode API.

#### 5.4.1 Session States

```
IDLE → (first request) → send session-start → ACTIVE → (idle timeout 5min) → send session-end → IDLE
```

#### 5.4.2 Session-Start Event

Sent as a separate `POST /alpha/generate` call before the first actual chat completion for a connection:

```json
{
  "threadId": "<uuid-v4>",
  "event": "session-start",
  "sessionId": "<uuid-v4>",
  "machineId": "m3a7f2b1c9e8d4a6f0b2c5e7d1a3f9b4",
  "projectSlug": "crimson-ferret-theory",
  "config": {
    "workingDir": "/home/user/crimson-ferret-theory",
    "date": "2026-06-24",
    "environment": "linux",
    "structure": [],
    "isGitRepo": true,
    "currentBranch": "main",
    "mainBranch": "main",
    "gitStatus": "",
    "recentCommits": []
  }
}
```

Headers: Same anti-detection headers as a chat request (section 5.5).

#### 5.4.3 Session-End Event

Sent on idle timeout:

```json
{
  "threadId": "<same uuid as session-start>",
  "event": "session-end",
  "sessionId": "<same uuid>",
  "machineId": "m3a7f2b1c9e8d4a6f0b2c5e7d1a3f9b4"
}
```

#### 5.4.4 Configuration

| Setting | Default | Env Var |
|---------|---------|---------|
| Session idle timeout | 300,000 ms (**5 minutes**) | `CMC_API_SESSION_IDLE_TIMEOUT_MS` |
| Session-start timeout | 10,000 ms | `CMC_API_SESSION_START_TIMEOUT_MS` |
| CLI version cache TTL | 7,200,000 ms (**2 hours**) | `CMC_API_VERSION_CACHE_TTL_MS` |
| Project slug TTL | 86,400,000 ms (24 hours) | `CMC_API_PROJECT_SLUG_TTL_MS` |

#### 5.4.5 In-Memory State

```js
// Per-process Map keyed by connectionId
Map<connectionId, {
  sessionId: string,       // UUID v4
  threadId: string,        // UUID v4 (for session-start/end)
  state: "IDLE" | "ACTIVE",
  lastActivity: number,    // epoch ms
  startPromise: Promise|null,  // in-flight session-start
}>
```

#### 5.4.6 Error Handling

Lifecycle events are **fail-open** — all errors are caught and logged via `logger.js`:
- If session-start fails (network error, 4xx, 5xx): `warn(LOG_TAG, ...)` and proceed with chat completion
- If session-end fails: `warn(LOG_TAG, ...)` and ignore (session expires server-side)
- Session-start runs asynchronously and does not block the first chat request beyond `SESSION_START_TIMEOUT_MS` (10s); if it hasn't completed, the chat request proceeds anyway

#### 5.4.7 API

```js
// Called before each chat request. Sends session-start if needed.
export async function ensureSessionActive(connectionId, fingerprint, version, apiKey) → Promise<void>

// Called after each chat request. Updates activity timestamp.
export function recordActivity(connectionId) → void

// Called on idle timeout or shutdown. Sends session-end.
export async function endSession(connectionId, fingerprint, version, apiKey) → Promise<void>
```

### 5.5 Header Building

The executor builds the full anti-detection header set on every request:

| Header | Value | Source |
|--------|-------|--------|
| `Authorization` | `Bearer user_xxx` | Connection API key |
| `Content-Type` | `application/json` | `CONTENT_TYPE_HEADER` constant |
| `Accept` | `text/event-stream` | `ACCEPT_HEADER` constant (forced stream) |
| `x-command-code-version` | `0.40.5` (dynamic) | `cmcApiVersionTracker` |
| `x-cli-environment` | `cli` | `CLI_ENVIRONMENT` constant |
| `x-session-id` | `<uuid-v4>` | Per-request `crypto.randomUUID()` |
| `x-machine-id` | `m3a7f2b1...` | `cmcApiFingerprint` (persistent per connection) |
| `x-project-slug` | `crimson-ferret-theory` | `cmcApiFingerprint` (persistent per connection, rotates daily) |
| `traceparent` | `00-<32hex>-<16hex>-01` | `cmcApiFingerprint.generateTraceparent()` (per-request) |
| `User-Agent` | `node` | `USER_AGENT` constant (matches Node.js CLI runtime) |

### 5.6 Request Body Enrichment & Field Mapping

The `openai-to-commandcode-api.js` translator produces the CC-API body schema with full field mapping:

#### 5.6.1 Body Schema

```json
{
  "threadId": "<uuid-v4>",
  "memory": "",
  "config": {
    "workingDir": "/home/user/crimson-ferret-theory",
    "date": "2026-06-24",
    "environment": "linux",
    "structure": [],
    "isGitRepo": true,
    "currentBranch": "main",
    "mainBranch": "main",
    "gitStatus": "",
    "recentCommits": []
  },
  "params": {
    "model": "deepseek/deepseek-v4-pro",
    "messages": [
      { "role": "user", "content": [{ "type": "text", "text": "Hello" }] }
    ],
    "stream": true,
    "max_tokens": 16384,
    "temperature": 0.3,
    "system": "You are a helpful assistant that helps with software engineering tasks.",
    "tools": [
      { "name": "bash", "description": "...", "input_schema": {...} }
    ],
    "top_p": 0.9,
    "reasoning_effort": "high",
    "tool_choice": "auto",
    "parallel_tool_calls": true
  }
}
```

#### 5.6.2 Field Mapping

| OpenAI Field | CC-API Field | Mapping Rule |
|-------------|-------------|--------------|
| `messages` | `params.messages` | Convert to content blocks (see 5.6.3) |
| `model` | `params.model` | Pass-through |
| `stream` | `params.stream` | Always `true` (forced) |
| `max_tokens` / `max_output_tokens` | `params.max_tokens` | Cap at `MAX_TOKENS_CAP` (64000); default `DEFAULT_MAX_TOKENS` (16384) |
| `temperature` | `params.temperature` | Pass-through; default `DEFAULT_TEMPERATURE` (0.3) |
| `system` messages | `params.system` | Extract from `messages[role=system]`; default `DEFAULT_SYSTEM_PROMPT` |
| `tools` | `params.tools` | Convert to Anthropic-style `{name, description, input_schema}` |
| `tool_choice` | `params.tool_choice` | Map: `"auto"`→`"auto"`, `"required"`→`"any"`, `"none"`→`"none"`, `{type:"function",function:{name}}`→`{type:"tool",tool_name:name}` |
| `parallel_tool_calls` | `params.parallel_tool_calls` | Pass-through boolean |
| `reasoning_effort` | `params.reasoning_effort` | Pass-through (`"none"` / `"low"` / `"medium"` / `"high"`); strip if `"none"` |
| `top_p` | `params.top_p` | Pass-through |
| `stop` | (omitted) | CC API doesn't support stop sequences |

#### 5.6.3 Image/File Content Blocks (Multimodal)

Unlike the existing `commandcode` translator which replaces images with `[image omitted]`, the new translator **passes through image blocks** to enable vision-capable models:

| OpenAI Block | CC-API Block | Mapping |
|-------------|-------------|---------|
| `{type:"text", text:"..."}` | `{type:"text", text:"..."}` | Pass-through |
| `{type:"image_url", image_url:{url:"data:image/png;base64,..."}}` | `{type:"image", source:{type:"base64", media_type:"image/png", data:"..."}}` | Parse data URI, extract mime + base64 |
| `{type:"image_url", image_url:{url:"https://..."}}` | `{type:"image", source:{type:"url", url:"https://..."}}` | Pass URL through |
| `{type:"image", ...}` | `{type:"image", source:{...}}` | Map from OpenAI image format |
| `{type:"file", file:{filename:"...", file_data:"data:application/pdf;base64,..."}}` | `{type:"file", source:{type:"base64", media_type:"application/pdf", data:"..."}}` | Parse data URI, extract mime + base64 |

Uses `parseDataUri()` from `open-sse/translator/concerns/image.js` for data URI parsing.

#### 5.6.4 Config Enrichment

The `config` object is populated from the connection's fingerprint data:
- `config.workingDir`: `FAKE_WORKING_DIR_PREFIX + "/" + projectSlug` (e.g., `/home/user/crimson-ferret-theory`)
- `config.isGitRepo`: `FAKE_GIT_REPO` (`true` — most real CLI sessions are in git repos)
- `config.currentBranch` and `config.mainBranch`: `FAKE_GIT_BRANCH` (`"main"`)
- `config.date`: Current date in ISO format (`YYYY-MM-DD`)
- `config.environment`: `process.platform` (matches real CLI behavior)

### 5.7 Response Translation & Zero-Output Guard

The CC-API upstream returns AI SDK v5 NDJSON. The response translator handles the same event types as the existing `commandcode-to-openai.js`:

| Event Type | Action |
|-----------|--------|
| `start` | Ignore (metadata only) |
| `start-step` | Ignore (metadata only) |
| `reasoning-start` | Ignore (metadata only) |
| `reasoning-delta` | Emit reasoning delta as OpenAI chunk |
| `reasoning-end` | Ignore (metadata only) |
| `text-start` | Initialize text state |
| `text-delta` | Emit content delta as OpenAI chunk |
| `text-end` | Ignore (metadata only) |
| `tool-input-start` | Initialize tool call state |
| `tool-input-delta` | Accumulate tool input JSON |
| `tool-input-end` | Ignore (metadata only) |
| `tool-call` | Emit tool call as OpenAI chunk |
| `finish-step` | Capture usage/finish reason |
| `finish` | Emit final chunk with finish reason + usage |
| `error` | Emit error message as content chunk + stop |

#### Zero-Output Guard

If the entire NDJSON stream produces **zero content chunks** (no `text-delta`, no `tool-call`, no `error` events), the translator emits a fallback error chunk:

```json
{
  "choices": [{
    "delta": { "content": "[CMC API: empty response from upstream]" },
    "finish_reason": "stop"
  }]
}
```

This prevents the client from hanging on an empty stream and provides a visible error message.

## 6. Multi-Account Support

9router already has robust multi-account support via the `providerConnections` table. The new provider leverages this **with zero changes to the connection management system**.

### 6.1 How Multi-Account Works

1. User adds multiple API keys (connections) to the `commandcode-api` provider
2. Each connection gets its own persistent fingerprint (machine ID, project slug)
3. 9router's existing round-robin/fill-first selection rotates across connections
4. Each connection has its own session lifecycle (independent session-start/session-end)
5. If one account gets rate-limited (429), 9router's existing fallback kicks in → next connection

### 6.2 Connection Data Schema

Stored in `providerConnections.data` JSON:
```json
{
  "apiKey": "user_abc123...",
  "cmcApi": {
    "machineId": "m3a7f2b1c9e8d4a6f0b2c5e7d1a3f9b4",
    "projectSlug": "crimson-ferret-theory",
    "projectSlugUpdatedAt": "2026-06-24T10:30:00Z",
    "cliVersion": "0.40.5",
    "cliVersionFetchedAt": "2026-06-24T10:00:00Z"
  }
}
```

### 6.3 What Doesn't Change

- `connectionsRepo.js` — already stores arbitrary JSON in `data`
- `accountFallback.js` — already handles per-connection retry/fallback
- `providerStore.js` — already manages multiple connections per provider
- Dashboard UI — already supports adding multiple API keys per provider

## 7. Registry Entry

The provider definition in `commandcode-api.js`:

```js
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
      text: "Use your CommandCode CLI API key (starts with user_...). Enhanced anti-detection for account safety.",
      apiKeyUrl: "https://commandcode.ai/studio",
    },
  },
  category: "apikey",
  transport: {
    baseUrl: "https://api.commandcode.ai/alpha/generate",
    format: "commandcodeapi",
    forceStream: true,
    // No static headers here — executor builds them dynamically
  },
  models: [
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
    { id: "anthropic/claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    { id: "anthropic/claude-opus-4-6", name: "Claude Opus 4.6" },
    { id: "openai/gpt-5", name: "GPT-5" },
    { id: "openai/o4-pro", name: "o4 Pro" },
    { id: "google/gemini-3-flash", name: "Gemini 3 Flash" },
    { id: "google/gemini-3-pro", name: "Gemini 3 Pro" },
    { id: "xiaomi/MiMo-7B-RL", name: "MiMo 7B RL" },
  ],
  features: {
    usage: true,
  },
};
```

**Provider logo:** Place `commandcode-api.png` in `public/providers/`. The 9router UI loads provider logos from `/providers/{provider.id}.png`. Copy from `commandcode.png` as a starting point.

## 8. Error Handling

| Scenario | Behavior | Logger |
|----------|----------|--------|
| npm version fetch fails | Use cached version, or `DEFAULT_CLI_VERSION` (`0.40.5`) fallback | `warn(LOG_TAG, "npm version fetch failed, using fallback", { error })` |
| Session-start event fails | Log warning, proceed with chat completion (fail-open) | `warn(LOG_TAG, "session-start failed", { error })` |
| Session-end event fails | Log warning, ignore (session expires server-side) | `warn(LOG_TAG, "session-end failed", { error })` |
| Fingerprint generation fails | Generate new fingerprint on next request | `error(LOG_TAG, "fingerprint generation failed", { error })` |
| Upstream 429 (rate limit) | Standard 9router fallback to next connection/account | `warn(LOG_TAG, "rate limited, falling back")` |
| Upstream 403 (banned) | Mark connection as inactive, fallback to next connection | `error(LOG_TAG, "banned (403), marking inactive")` |
| NDJSON parse error in response | Skip malformed line, continue streaming | `warn(LOG_TAG, "NDJSON parse error, skipping line")` |
| Empty response (zero chunks) | Emit fallback error chunk (zero-output guard) | `warn(LOG_TAG, "empty response from upstream")` |
| Image block parsing fails | Replace with text block `"[image parse error]"` | `warn(LOG_TAG, "image block parse failed")` |

All logging uses `debug`, `info`, `warn`, `error` from `src/sse/utils/logger.js` with tag `CMC API`.

## 9. Logging

Uses the existing `src/sse/utils/logger.js` module:

```js
import { debug, info, warn, error } from "@/sse/utils/logger.js";

debug("CMC API", "Building headers", { version: "0.40.5" });
info("CMC API", "Session started", { connectionId: "abc" });
warn("CMC API", "Session-start failed, proceeding", { error: "network" });
error("CMC API", "Upstream banned (403)", { connectionId: "abc" });
```

The log tag is `CMC API` (defined as `LOG_TAG` in `cmcApiConstants.js`).

## 10. Implementation Phases

### Phase 1: Core Infrastructure (Tasks 1-4)
- Format constant
- Constants module
- Fingerprint service
- Version tracker service
- Session manager service

### Phase 2: Translators (Tasks 5-6)
- Request translator with full field mapping
- Response translator with zero-output guard

### Phase 3: Provider Registration (Tasks 7-8)
- Registry entry
- Executor

### Phase 4: Wiring & Integration (Tasks 9-11)
- Wire up all index files
- Integration tests
- Golden header tests

### Phase 5: Final Verification (Task 12)
- Smoke test
- Existing provider regression test

## 11. Testing Plan

### 11.1 Unit Tests

| Test File | What It Covers |
|-----------|---------------|
| `tests/unit/cmcApiFingerprint.test.js` | Machine ID format, project slug format, traceparent format, persistence |
| `tests/unit/cmcApiVersionTracker.test.js` | npm fetch mock, cache TTL (2hr), fallback to `0.40.5` |
| `tests/unit/cmcApiSessionManager.test.js` | Session lifecycle, 5min idle timeout, fail-open behavior |
| `tests/unit/openai-to-commandcode-api.test.js` | Request translation, body enrichment, image/file pass-through, field mapping |
| `tests/unit/commandcode-api-to-openai.test.js` | NDJSON response parsing, all event types, zero-output guard |

### 11.2 Integration Tests

| Test | What It Covers |
|------|---------------|
| Full executor flow with mocked upstream | End-to-end: fingerprint → session-start → translate → execute → translate response |
| Multi-account rotation | Per-account fingerprints, independent sessions |

### 11.3 Golden Header Tests

Extend `tests/translator/golden-url-header.test.js`:
- Verify all 10 anti-detection headers are present
- Verify `x-command-code-version` is a valid semver string
- Verify `x-machine-id` matches `m` + 32 hex format
- Verify `x-project-slug` is kebab-case
- Verify `traceparent` matches W3C format
- Verify `User-Agent` is `node`

## 12. File Manifest

### 12.1 New Files

| File | Purpose |
|------|---------|
| `open-sse/config/cmcApiConstants.js` | All constants (TTLs, defaults, word lists, header values, log tag, max_tokens cap) |
| `open-sse/providers/registry/commandcode-api.js` | Registry entry |
| `open-sse/executors/commandcode-api.js` | Executor with anti-detection |
| `open-sse/translator/request/openai-to-commandcode-api.js` | Request translator |
| `open-sse/translator/response/commandcode-api-to-openai.js` | Response translator |
| `open-sse/services/cmcApiFingerprint.js` | Fingerprint service |
| `open-sse/services/cmcApiVersionTracker.js` | Version tracker service |
| `open-sse/services/cmcApiSessionManager.js` | Session manager service |
| `public/providers/commandcode-api.png` | Provider logo |
| `tests/unit/cmcApiFingerprint.test.js` | Fingerprint tests |
| `tests/unit/cmcApiVersionTracker.test.js` | Version tracker tests |
| `tests/unit/cmcApiSessionManager.test.js` | Session manager tests |
| `tests/unit/openai-to-commandcode-api.test.js` | Request translator tests |
| `tests/unit/commandcode-api-to-openai.test.js` | Response translator tests |

### 12.2 Modified Files

| File | Change |
|------|--------|
| `open-sse/translator/formats.js` | Add `COMMANDCODE_API: "commandcodeapi"` |
| `open-sse/providers/registry/index.js` | Regenerate (auto-generated import) |
| `open-sse/executors/index.js` | Import + register `CommandCodeApiExecutor` |
| `open-sse/translator/index.js` | Import new translators |
| `src/app/api/providers/validate/route.js` | Add validation for `commandcode-api` |

## 13. Design Decisions

The following decisions were made during design review.

1. **Model list — static baseline, fail gracefully on unavailable models.** The static model list in Section 7 includes all models from commandcode-proxy. If the CC API returns an error for a specific model, standard 9router error handling applies. A `modelsFetcher` can be added in a future iteration.

2. **Session-start — non-blocking with 10s timeout, fail-open.** The first chat request sends session-start asynchronously. The chat request proceeds immediately without waiting for session-start to complete. If session-start hasn't completed within 10 seconds, it is abandoned. Rationale: session-start is an anti-detection nicety, not a prerequisite.

3. **User-Agent — `node` (static).** The real `command-code` CLI runs on Node.js and its `User-Agent` header is set by the Node.js runtime as `node`. Using `node` is the simplest value that matches a Node.js CLI runtime without over-specifying a version.

4. **Image/File input — pass-through, not strip.** Unlike the existing `commandcode` translator which replaces images with `[image omitted]`, the new translator converts OpenAI image blocks to CC-API format and passes them through. This enables vision-capable models on the CC API to process images. File blocks (PDFs, documents) are also passed through.

5. **Constants in one module.** All hardcoded values (CLI version fallback, TTLs, header values, log tag, word lists, max_tokens cap, default system prompt) live in `cmcApiConstants.js`. This makes future maintenance trivial — update a value in one place instead of hunting through multiple files.

6. **Session TTL 5 minutes.** The session idle timeout is 5 minutes (300,000 ms). Real CLI sessions are short-lived interactions — a developer sends a request, gets a response, and may not send another for a few minutes. A 5-minute timeout means session-start/session-end events happen naturally around bursts of activity.

7. **Zero-output guard.** If the upstream returns an empty NDJSON stream (zero content chunks), the translator emits a fallback error chunk `[CMC API: empty response from upstream]` with `finish_reason: "stop"`. This prevents the client from hanging on an empty stream.

8. **Logger — `src/sse/utils/logger.js`.** Uses `debug`, `info`, `warn`, `error` functions from the existing logger module with tag `CMC API`. The logger handles formatting, timestamps, and data serialization.

9. **Default system prompt — software engineering focused.** The default system prompt is `"You are a helpful assistant that helps with software engineering tasks."` (not the generic `"You are a helpful assistant."`). This matches the CC CLI's purpose as a coding agent.

10. **max_tokens capping.** The `max_tokens` value is capped at `MAX_TOKENS_CAP` (64,000) to prevent CC API rejections. If the client sends a higher value, it's silently capped. If no value is provided, the default is `DEFAULT_MAX_TOKENS` (16,384).

11. **No `x-cmd-zdr` header.** The `x-cmd-zdr: 1` (Zero Data Retention) header was considered but is **not** part of commandcode-proxy. Adding headers that don't exist in the real CLI would create a new detection signal, defeating the anti-detection purpose. Only headers confirmed to exist in commandcode-proxy are sent.
