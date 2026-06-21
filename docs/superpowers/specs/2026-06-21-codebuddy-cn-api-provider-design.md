# CodeBuddy CN API Provider — Design Spec

**Date:** 2026-06-21
**Branch:** `feat/codebuddy-cn-api-provider` (from `master`)
**Status:** Approved

## Overview

Add a custom CodeBuddy CN API provider (`codebuddy-cn-api`) to 9Router that coexists alongside the upstream `codebuddy-cn` provider. This provider targets the China version (`copilot.tencent.com`) with API key authentication, PUDIDIL-style request sanitization, and comprehensive feature support ported from the [etteum-pool](https://github.com/priyo000/etteum-pool) reference project.

## Architecture

**Approach:** Pipeline-Integrated Sanitizer + Focused Executor (Approach A)

```
Client (OpenCode, Claude Code, Cursor...)
  | POST /v1/chat/completions (OpenAI format)
  | model: "cbca/glm-5.2"
  v
chatCore.js Pipeline
  1. Format detection (openai)
  2. Modality stripping (vision caps)
  3. Request translation (openai->openai passthrough)
  4. RTK compression (if enabled)
  5. Caveman/Ponytail (if enabled)
  6. Sanitizer Filter (if provider has features.sanitizer: true)
     -> Strip identity markers, billing headers, CLI fingerprints
     -> DB-backed rules, hot-reloadable, cached in memory
  7. Executor dispatch -> CodebuddyCnApiExecutor
     v
CodebuddyCnApiExecutor
  - cleanMessages(): Anthropic->OpenAI tool/image conversion
  - sanitizeToolSchemas(): Strip $ref/$defs, inline resolve
  - detectAndReplaceAgentPrompt(): Strip CLI system prompts
  - buildHeaders(): Latest CodeBuddy identity + per-request fingerprint
  - injectReasoning(): reasoning_effort (default: max) + reasoning_summary
  - proxyAwareFetch(): Proxy + MITM bypass support
  - No executor-level retry (9Router account fallback handles resilience)
     v
Tencent CodeBuddy Gateway
  POST https://copilot.tencent.com/v2/chat/completions
  Auth: Authorization: Bearer <api_key>
```

## Provider Registry

**File:** `open-sse/providers/registry/codebuddy-cn-api.js`

| Field | Value |
|-------|-------|
| `id` | `codebuddy-cn-api` |
| `alias` | `cbca` |
| `priority` | `901` (3-digit, 9xx prefix to avoid upstream collision) |
| `category` | `apikey` |
| `transport.baseUrl` | `https://copilot.tencent.com/v2/chat/completions` |
| `transport.format` | `openai` |
| `transport.forceStream` | `true` (upstream rejects non-stream, error 11101) |
| `transport.thinkingFormat` | `openai` |
| `transport.authType` | `api_key` |
| `transport.auth` | `{ header: "Authorization", scheme: "bearer" }` |
| `transport.timeoutMs` | `120000` |
| `transport.stallTimeoutMs` | `60000` |
| `features.usage` | `true` |
| `features.usageApikey` | `true` |
| `features.sanitizer` | `true` |
| `display.name` | `CodeBuddy CN API` |
| `display.icon` | Reuse `public/providers/codebuddy-cn.png` |
| `display.color` | `#1E6FFF` (Tencent blue) |
| `display.website` | `https://copilot.tencent.com` |
| `display.notice.apiKeyUrl` | `https://copilot.tencent.com/profile/keys` |

## Model List (19 models, live-verified via API probe)

| # | Model ID | Context | Max Output | Vision | Reasoning | Tools | Credit Rate |
|---|----------|---------|------------|--------|-----------|-------|-------------|
| 1 | `claude-haiku-4.5` | 200K | 64K | No | Yes | Yes | 0.11 |
| 2 | `deepseek-r1` | 128K | 32K | No | Yes | Yes | 0.01 |
| 3 | `deepseek-v3` | 1M | 384K | No | No | Yes | 0.01 |
| 4 | `deepseek-v3-2-volc` | 64K* | 32K* | Yes | No | Yes | 0.01 |
| 5 | `deepseek-v3.2` | 96K* | 32K* | No | No | Yes | 0.01 |
| 6 | `deepseek-v4-flash` | 1M | 384K | Yes | Yes | Yes | 0.01 |
| 7 | `deepseek-v4-pro` | 1M | 384K | Yes | Yes | Yes | 0.03 |
| 8 | `glm-4.7` | 204K | 131K | No | Yes | Yes | 0.02 |
| 9 | `glm-5.0` | 204K | 131K | No | Yes | Yes | 0.02 |
| 10 | `glm-5.1` | 200K | 131K | Yes | Yes | Yes | 0.02 |
| 11 | `glm-5.2` | 1M | 131K | Yes | Yes | Yes | 0.02 |
| 12 | `glm-5v-turbo` | 200K | 131K | Yes | Yes | Yes | 0.03 |
| 13 | `hunyuan-2.0-instruct` | 256K* | 8K* | No | No | Yes | 0.01 |
| 14 | `hy3-preview` | 256K | 64K | No | Yes | Yes | 0.01 |
| 15 | `kimi-k2.5` | 262K | 262K | Yes | Yes | Yes | 0.05 |
| 16 | `kimi-k2.6` | 262K | 262K | Yes | Yes | Yes | 0.09 |
| 17 | `kimi-k2.7` | 262K | 262K | Yes | Yes | Yes | 0.07 |
| 18 | `minimax-m2.7` | 204K | 131K | Yes | Yes | Yes | 0.10 |
| 19 | `minimax-m3` | 512K | 128K | Yes | Yes | Yes | 0.10 |

*Values marked with * are from etteum-pool/upstream estimates (not on models.dev). Context/Max Output from models.dev where available. Credit rates from etteum-pool (credits per 1K tokens on CodeBuddy CN billing). Note: Hunyuan models use "hy" prefix on models.dev (e.g., `tencent/hy3-preview`), but CodeBuddy CN API accepts the full name `hunyuan-2.0-instruct` as confirmed by live probe.

**Excluded:** `glm-5.0-turbo` (timeout during probe), `claude-sonnet-4.5/4.6`, `gpt-*`, `hunyuan-turbo`, `qwen3-coder` (not available on CodeBuddy CN).

**Usage:** `cbca/glm-5.2`, `cbca/deepseek-v4-pro`, `cbca/kimi-k2.5`, etc.

## Executor

**File:** `open-sse/executors/codebuddyCnApi.js`
**Class:** `CodebuddyCnApiExecutor extends DefaultExecutor`

### Key Behaviors

1. **Force stream:** Always sets `stream: true` (upstream error 11101 for non-stream)
2. **No executor-level retry:** Single fetch, let 9Router's account fallback handle resilience
3. **Default reasoning:** `reasoning_effort: "max"` (highest quality)
4. **Default temperature:** `0.1` (low randomness for coding tasks)
5. **Reasoning summary:** Always injects `reasoning_summary: "auto"`

### transformRequest Pipeline

1. `cleanMessages()` - Anthropic->OpenAI format conversion:
   - `tool_use` blocks -> OpenAI `tool_calls` array
   - `tool_result` blocks -> OpenAI `role: "tool"` messages
   - Anthropic `image` blocks -> OpenAI `image_url` blocks (inline in content array)
   - Array content with only text blocks -> collapse to plain string

2. `sanitizeToolSchemas()` - JSON Schema cleanup:
   - Inline resolve `$ref` / `$defs` / `definitions`
   - Strip `$schema`, `$id`, `$comment`
   - Ensure `type: "object"` and `properties: {}` defaults
   - Schema cache (200-entry cap)

3. `detectAndReplaceAgentPrompt()` - Identity stripping (second layer after Sanitizer):
   - Detects CLI/agent system prompts via regex patterns
   - System prompts > 2000 chars are also flagged
   - Replacement: "You are a helpful AI assistant that helps with software engineering tasks."

4. `injectReasoning()` - Reasoning/thinking support:
   - Reads `reasoning_effort`, `reasoning.effort`, `thinking.type`
   - Default: `"max"` when not specified
   - Strips `"none"/"off"` values
   - Always adds `reasoning_summary: "auto"`

5. `applyMaxTokensDefault()` - If client doesn't specify max_tokens:
   - Look up model's max output from `CODEBUDDY_CN_API_MODEL_CONFIG` constants
   - Set `body.max_tokens = modelConfig.maxOutput` (provider's maximum)
   - This ensures we always get the fullest possible response

### Supported Parameters

| Parameter | Handling |
|-----------|----------|
| `max_tokens` / `max_completion_tokens` | If not specified by client, default to model's max output limit from constants |
| `temperature` | Default `0.1` if not specified |
| `top_p` | Pass through |
| `presence_penalty` | Pass through |
| `reasoning_effort` | Normalize, default `"max"` |
| `thinking` (Anthropic format) | Convert to `reasoning_effort` |
| `tools` / `tool_choice` | Pass through (sanitize schemas) |
| `parallel_tool_calls` | Pass through |
| `stream` | Force `true` |

### Error Handling

| Status | Code | Action |
|--------|------|--------|
| 200 | - | Success, return response |
| 400 | 11101 | "Non-stream not supported" (shouldn't happen) |
| 400 | 11102 | "Model not found" -> return 400 to client |
| 401 | - | "Invalid API key" -> return 401 |
| 403 | - | "Content moderation" -> return 403, no retry |
| 429 | - | "Rate limited" -> return to trigger account fallback |

## Sanitizer Filter System

**Service:** `open-sse/services/sanitizer.js`
**DB Table:** `sanitizerRules`
**Feature Flag:** `features.sanitizer: true`

### Architecture

Sanitizer runs as a pipeline stage in `chatCore.js` (after RTK/Caveman/Ponytail, before executor dispatch). Applies to any provider with `features.sanitizer: true`.

### DB Schema

```sql
CREATE TABLE IF NOT EXISTS sanitizerRules (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,            -- "regex" | "exact"
  pattern TEXT NOT NULL,
  replacement TEXT DEFAULT '',
  enabled INTEGER DEFAULT 1,
  priority INTEGER DEFAULT 0,
  provider TEXT DEFAULT 'all',   -- "all" or specific provider ID
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
```

### Default Rules (22 total, seeded on first boot)

**Phase 1: Regex Rules (18)**

| ID | Pattern | Purpose |
|----|---------|---------|
| `remove_billing_header_regex` | `x-(?:anthropic-)?billing-header:?\s*[^\n]*` | Strip billing headers |
| `remove_cc_entrypoint_any` | `cc_entrypoint=\w+` | Strip CLI entrypoint markers |
| `remove_cc_version_any` | `cc_version=[\w.]+` | Strip version identifiers |
| `remove_cch_hash` | `c?ch=[a-f0-9]+` | Strip conversation hash fingerprints |
| `remove_claude_code_github` | `https?://github\.com/anthropics/claude-code[^\s]*` | Strip GitHub references |
| `remove_claude_code_identity_variations` | `You are Claude Code[^.]*\.` | Strip identity statements |
| `remove_anthropic_cli_ref` | `Anthropic'?'s official (?:CLI\|tool\|agent)[^.]*\.?` | Strip CLI references |
| `remove_anxthxropic_ref` | `Anxthxropic'?'s official[^.]*\.?` | Strip obfuscated references |
| `remove_cursor_identity` | `You are (?:a )?(?:powerful )?(?:AI )?(?:assistant\|agent) (?:made\|built\|created) by (?:Cursor\|Anysphere)[^.]*\.?` | Strip Cursor identity |
| `remove_windsurf_identity` | `You are (?:Windsurf\|Cascade\|Codeium)[^.]*\.?` | Strip Windsurf identity |
| `remove_cline_identity` | `You are Cline[^.]*\.?` | Strip Cline identity |
| `remove_ai_coding_agent_pattern` | `(?:autonomous\|agentic) (?:AI \|coding )?(?:agent\|assistant)[^.]*\.` | Strip generic agent patterns |
| `remove_mcp_server_ref` | `MCP (?:server\|client\|protocol)[^.]*\.?` | Strip MCP protocol references |
| `remove_powered_by_anthropic` | `powered by (?:Claude\|Anthropic\|Anxthxropic)[^.]*\.?` | Strip "powered by" patterns |
| `remove_ohmyopencode_ref` | `OhMyOpenCode[^.]*\.?` | Strip OhMyOpenCode references |
| `remove_opencode_ref` | `opencode[^.]*\.?` | Strip OpenCode references |
| `remove_system_prompt_fingerprint` | `(?:system\|assistant) (?:prompt\|message) (?:by\|from) [^.]*\.?` | Strip prompt attribution |
| `remove_claude_sonnet_identity` | `claude[- ]sonnet[- ][^.]*\.?` | Strip model identity |

**Phase 2: Exact String Fallbacks (4)**

| ID | Exact String | Replacement |
|----|-------------|-------------|
| `remove_feedback_line` | Claude Code feedback/survey URL line (exact string from etteum-pool source, ported during implementation) | `""` |
| `remove_powerful_ai_agent` | `"Advanced AI Agent"` | `""` |
| `remove_claude_code_identity` | `"You are Claude Code, Anxthxropic's official CLI for Claude."` | `""` |
| `remove_claude_code_mention` | `"Claude Code"` | `"the assistant"` |

### Filter Application Scope

Applied to:
- All `messages[].content` (string and array blocks)
- `tool_result` content (nested in arrays)
- Tool descriptions (`tools[].function.description`)

### Caching

- In-memory cache with 30s TTL
- Compiled regex patterns (compiled once, reused)
- "Reload" button in dashboard bypasses cache immediately
- Multi-provider support: rules can target `"all"` or specific provider IDs

### chatCore.js Integration

```javascript
if (getProviderFeature(provider, "sanitizer")) {
  body = await applySanitizerFilters(body, provider);
}
```

## Test Connection & Quota Tracking

### Test Connection

**Primary:** Billing API (`POST /v2/billing/meter/get-user-resource`)
- Validates API key authentication
- Returns real credit/quota data
- Latency measurement

**Fallback:** Chat endpoint probe (abort after status code)
- Used only if billing API returns 404 or network error

**Auth failure:** Returns `{ valid: false, error: "..." }`

### Quota Tracking

**File:** `open-sse/services/usage/codebuddy-cn-api.js`

Parses billing API response into 9Router quota format:

| Account Type | Detection | Fields Used |
|-------------|-----------|-------------|
| Monthly/Base | `CycleEndTime << DeductionEndTime` (>2d gap) | `CycleCapacityUsedPrecise` / `CycleCapacitySizePrecise` |
| Bonus/Promo | `CycleEndTime ~= DeductionEndTime` | `CapacityUsedPrecise` / `CapacitySizePrecise` |

Output: One quota row per package, soonest-expiring first.

### Credit Tracking Per Request

- Extract `usage.credit` from SSE stream chunks (real credit consumed)
- Fallback: `totalTokens * creditRate` estimation
- Credit rates stored in `src/lib/codebuddy-cn-api/constants.js`

## Identity & Fingerprint

### Per-Request Headers

```javascript
{
  "Authorization": "Bearer <api_key>",
  "Content-Type": "application/json",
  "User-Agent": "CLI/<version> CodeBuddy/<version>",  // Configurable via settings
  "X-Product": "SaaS",
  "X-IDE-Type": "CLI",
  "X-IDE-Name": "CLI",
  "X-Domain": "copilot.tencent.com",
  "X-Conversation-ID": "<fresh UUID per request>",
  "X-Request-ID": "<UUID no dashes per request>",
  "x-requested-with": "XMLHttpRequest",
  "x-codebuddy-request": "1",
}
```

### Anti-Detection

- Fresh `X-Conversation-ID` and `X-Request-ID` per request
- No machine fingerprint (API key auth doesn't require it)
- No telemetry or data collection
- No post-auth user info fetch

### CLI Version Settings Override

Dashboard settings card (Profile/Settings page) with:
- **CLI Version** input field (default: `2.109.0`)
- Updates `User-Agent` header without rebuild
- Persisted in SQLite, loaded at boot via `initCodebuddyCnApiSettings()`

```javascript
// src/lib/codebuddy-cn-api/constants.js
export function getCliVersion() {
  return process.env.CODEBUDDY_CN_API_CLI_VERSION || "2.109.0";
}
export function getUserAgent() {
  const v = getCliVersion();
  return `CLI/${v} CodeBuddy/${v}`;
}
```

## Dashboard UI

### Provider Card

Standard API key provider card in the Providers page:
- Shows in "API Key Providers" section
- Add flow: API key input
- Connection list shows status, latency, credit balance
- Test button hits billing API

### Sanitizer Rules Page

New sidebar item: `/dashboard/sanitizer`

Features:
- Table listing all rules (ID, type, pattern, enabled toggle, priority)
- Add new rule (type: regex/exact, pattern, replacement, provider target)
- Edit/delete existing rules
- Toggle each rule on/off
- "Reset to Defaults" button
- "Reload" button (bypass cache)
- Provider dropdown: "All Providers" or specific provider

### Sidebar Navigation

Add to `src/app/(dashboard)/dashboard/layout.js`:
```javascript
{ href: "/dashboard/sanitizer", label: "Sanitizer", icon: "filter_alt" }
```

## File Inventory

### New Files (12)

| File | Purpose |
|------|---------|
| `open-sse/providers/registry/codebuddy-cn-api.js` | Provider registry (19 models, transport, features) |
| `open-sse/executors/codebuddyCnApi.js` | Custom executor |
| `open-sse/services/sanitizer.js` | Sanitizer filter engine (DB-backed, cached) |
| `open-sse/services/usage/codebuddy-cn-api.js` | Quota tracker via billing API |
| `src/lib/db/repos/sanitizerRulesRepo.js` | SQLite CRUD for sanitizer rules |
| `src/lib/codebuddy-cn-api/constants.js` | Shared constants (models, credit rates, identity) |
| `src/lib/codebuddy-cn-api/initSanitizerRules.js` | Boot-time sanitizer rule seeder |
| `src/lib/codebuddy-cn-api/initCodebuddyCnApiSettings.js` | Boot-time settings initializer |
| `src/app/(dashboard)/dashboard/sanitizer/page.js` | Sanitizer rules management UI |
| `src/app/api/sanitizer/route.js` | Sanitizer rules API (GET/POST/PUT/DELETE) |
| `tests/unit/codebuddy-cn-api.test.js` | Executor unit tests |
| `tests/unit/sanitizer.test.js` | Sanitizer filter tests |

### Modified Files (8)

| File | Change |
|------|--------|
| `open-sse/providers/registry/index.js` | Add import for codebuddy-cn-api |
| `open-sse/executors/index.js` | Register CodebuddyCnApiExecutor |
| `open-sse/providers/capabilities.js` | Add capability map for 19 models |
| `open-sse/handlers/chatCore.js` | Add sanitizer filter stage (conditional) |
| `src/lib/db/schema.js` | Add `sanitizerRules` table |
| `src/app/api/providers/[id]/test/testUtils.js` | Add test probe for codebuddy-cn-api |
| `src/app/api/settings/route.js` | Apply CodeBuddy CN API settings on save |
| `src/app/(dashboard)/dashboard/layout.js` | Add Sanitizer to sidebar nav |

## Reference Sources

- **Qoder-API branch** (`feat/qoder-api-provider`): Provider pattern, executor structure, settings flow, test patterns
- **Etteum-Pool** (`priyo000/etteum-pool`): Sanitizer filter rules, cleanMessages(), tool schema sanitization, agent prompt detection, credit rates, CodeBuddy CN provider implementation
- **Upstream codebuddy-cn**: Existing provider to coexist alongside (not modified)
- **models.dev**: Model context windows and max output tokens
- **Live API probe**: 19 confirmed working models, billing API validation
