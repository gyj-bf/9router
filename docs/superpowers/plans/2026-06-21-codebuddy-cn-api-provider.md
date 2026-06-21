# CodeBuddy CN API Provider — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a custom CodeBuddy CN API provider with sanitizer filter system, quota tracking, and dashboard UI to 9Router.

**Architecture:** Pipeline-integrated sanitizer (chatCore.js stage) + focused executor (CodebuddyCnApiExecutor extends DefaultExecutor) + DB-backed sanitizer rules + billing API for test connection and quota tracking.

**Tech Stack:** Next.js 16, React 19, SQLite (better-sqlite3/sql.js), Zustand, Tailwind CSS 4, Material Symbols

**Branch:** `feat/codebuddy-cn-api-provider` (already created from master)

## Global Constraints

- Provider ID: `codebuddy-cn-api`, alias: `cbca`, priority: `901`
- Category: `apikey` (no OAuth)
- Force stream: `true` (upstream error 11101 for non-stream)
- Default reasoning_effort: `"max"`, default temperature: `0.1`
- No executor-level retry — 9Router account fallback handles resilience
- Sanitizer feature flag: `features.sanitizer: true`
- CLI version configurable via dashboard settings (no rebuild needed)
- All model specs from live API probe + models.dev (19 models)
- Reference: etteum-pool (`priyo000/etteum-pool`) for sanitizer rules and cleanMessages()
- Reference: qoder-api branch (`feat/qoder-api-provider`) for provider pattern
- Logger: Use `src/sse/utils/logger.js` with per-module LOG_TAG (uppercase). Each module defines its own tag: executor=`"CODEBUDDY CN API"`, sanitizer=`"SANITIZER"`, usage=`"CODEBUDDY CN USAGE"`, test=`"CODEBUDDY CN TEST"`, settings=`"CODEBUDDY CN SETTINGS"`
- Default CLI version: `DEFAULT_CLI_VERSION = "2.109.0"` as named constant

## File Structure

### New Files (12)

| File | Responsibility |
|------|---------------|
| `src/lib/codebuddy-cn-api/constants.js` | Model configs, credit rates, identity constants, getCliVersion(), getUserAgent() |
| `open-sse/providers/registry/codebuddy-cn-api.js` | Provider registry entry (19 models, transport, features) |
| `open-sse/executors/codebuddyCnApi.js` | Custom executor (cleanMessages, sanitizeToolSchemas, injectReasoning, headers) |
| `open-sse/services/sanitizer.js` | Sanitizer filter engine (loadRules, applyFilters, cache) |
| `open-sse/services/usage/codebuddy-cn-api.js` | Quota tracker via billing API |
| `src/lib/db/repos/sanitizerRulesRepo.js` | SQLite CRUD for sanitizerRules table |
| `src/lib/codebuddy-cn-api/initSanitizerRules.js` | Boot-time seeder for 22 default rules |
| `src/lib/codebuddy-cn-api/initCodebuddyCnApiSettings.js` | Boot-time settings initializer |
| `src/app/(dashboard)/dashboard/sanitizer/page.js` | Sanitizer rules management UI |
| `src/app/api/sanitizer/route.js` | Sanitizer rules REST API (GET/POST/PUT/DELETE) |
| `tests/unit/codebuddy-cn-api.test.js` | Executor unit tests |
| `tests/unit/sanitizer.test.js` | Sanitizer filter unit tests |

### Modified Files (8)

| File | Change |
|------|--------|
| `open-sse/providers/registry/index.js` | Add import + array entry for codebuddy-cn-api |
| `open-sse/executors/index.js` | Import + register CodebuddyCnApiExecutor |
| `open-sse/providers/capabilities.js` | Add PROVIDER_CAPABILITIES entry for 19 models |
| `open-sse/handlers/chatCore.js` | Add sanitizer filter stage after Ponytail, before executor dispatch |
| `src/lib/db/schema.js` | Add `sanitizerRules` table to TABLES |
| `src/app/api/providers/[id]/test/testUtils.js` | Add test probe for codebuddy-cn-api (billing API) |
| `src/app/api/settings/route.js` | Apply codebuddyCnApiCliVersion setting on save |
| `src/shared/components/Sidebar.js` | Add Sanitizer nav item |

---

### Task 1: Constants & Model Configuration

**Files:**
- Create: `src/lib/codebuddy-cn-api/constants.js`

**Interfaces:**
- Produces: `CODEBUDDY_CN_API_MODELS`, `CODEBUDDY_CN_API_MODEL_CONFIG`, `CODEBUDDY_CN_API_CREDIT_RATES`, `DEFAULT_SANITIZER_RULES`, `getCliVersion()`, `getUserAgent()`, `CODEBUDDY_CN_API_DEFAULT_HEADERS`

- [ ] **Step 1: Create the constants file with all model configs**

```javascript
// src/lib/codebuddy-cn-api/constants.js

// ── CLI Version (configurable via dashboard settings) ──
export const DEFAULT_CLI_VERSION = "2.109.0";

export function getCliVersion() {
  return process.env.CODEBUDDY_CN_API_CLI_VERSION || DEFAULT_CLI_VERSION;
}

export function getUserAgent() {
  const v = getCliVersion();
  return `CLI/${v} CodeBuddy/${v}`;
}

// ── Default Headers ──
export function buildDefaultHeaders(apiKey) {
  return {
    "Authorization": `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "User-Agent": getUserAgent(),
    "X-Product": "SaaS",
    "X-IDE-Type": "CLI",
    "X-IDE-Name": "CLI",
    "X-Domain": "copilot.tencent.com",
    "X-Conversation-ID": crypto.randomUUID(),
    "X-Request-ID": crypto.randomUUID().replace(/-/g, ""),
    "x-requested-with": "XMLHttpRequest",
    "x-codebuddy-request": "1",
  };
}

// ── API URLs ──
export const CODEBUDDY_CN_API_CHAT_URL = "https://copilot.tencent.com/v2/chat/completions";
export const CODEBUDDY_CN_API_BILLING_URL = "https://copilot.tencent.com/v2/billing/meter/get-user-resource";

// ── Model Configuration ──
// context/maxOutput from models.dev where available, * from etteum-pool estimates
export const CODEBUDDY_CN_API_MODELS = [
  { id: "claude-haiku-4.5", name: "Claude Haiku 4.5" },
  { id: "deepseek-r1", name: "DeepSeek-R1" },
  { id: "deepseek-v3", name: "DeepSeek-V3" },
  { id: "deepseek-v3-2-volc", name: "DeepSeek-V3.2-Volc" },
  { id: "deepseek-v3.2", name: "DeepSeek-V3.2" },
  { id: "deepseek-v4-flash", name: "DeepSeek-V4-Flash" },
  { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro" },
  { id: "glm-4.7", name: "GLM-4.7" },
  { id: "glm-5.0", name: "GLM-5.0" },
  { id: "glm-5.1", name: "GLM-5.1" },
  { id: "glm-5.2", name: "GLM-5.2" },
  { id: "glm-5v-turbo", name: "GLM-5v-Turbo" },
  { id: "hunyuan-2.0-instruct", name: "Hunyuan 2.0 Instruct" },
  { id: "hy3-preview", name: "Hy3 Preview" },
  { id: "kimi-k2.5", name: "Kimi-K2.5" },
  { id: "kimi-k2.6", name: "Kimi-K2.6" },
  { id: "kimi-k2.7", name: "Kimi-K2.7-Code" },
  { id: "minimax-m2.7", name: "MiniMax-M2.7" },
  { id: "minimax-m3", name: "MiniMax-M3" },
];

// Per-model config: contextWindow, maxOutput, vision, reasoning, creditRate
export const CODEBUDDY_CN_API_MODEL_CONFIG = {
  "claude-haiku-4.5":     { contextWindow: 200000, maxOutput: 64000,  vision: false, reasoning: true,  creditRate: 0.11 },
  "deepseek-r1":          { contextWindow: 128000, maxOutput: 32000,  vision: false, reasoning: true,  creditRate: 0.01 },
  "deepseek-v3":          { contextWindow: 1000000, maxOutput: 384000, vision: false, reasoning: false, creditRate: 0.01 },
  "deepseek-v3-2-volc":   { contextWindow: 64000,  maxOutput: 32000,  vision: true,  reasoning: false, creditRate: 0.01 },
  "deepseek-v3.2":        { contextWindow: 96000,  maxOutput: 32000,  vision: false, reasoning: false, creditRate: 0.01 },
  "deepseek-v4-flash":    { contextWindow: 1000000, maxOutput: 384000, vision: true,  reasoning: true,  creditRate: 0.01 },
  "deepseek-v4-pro":      { contextWindow: 1000000, maxOutput: 384000, vision: true,  reasoning: true,  creditRate: 0.03 },
  "glm-4.7":              { contextWindow: 204800, maxOutput: 131072, vision: false, reasoning: true,  creditRate: 0.02 },
  "glm-5.0":              { contextWindow: 204800, maxOutput: 131072, vision: false, reasoning: true,  creditRate: 0.02 },
  "glm-5.1":              { contextWindow: 200000, maxOutput: 131072, vision: true,  reasoning: true,  creditRate: 0.02 },
  "glm-5.2":              { contextWindow: 1000000, maxOutput: 131072, vision: true,  reasoning: true,  creditRate: 0.02 },
  "glm-5v-turbo":         { contextWindow: 200000, maxOutput: 131072, vision: true,  reasoning: true,  creditRate: 0.03 },
  "hunyuan-2.0-instruct": { contextWindow: 256000, maxOutput: 8000,   vision: false, reasoning: false, creditRate: 0.01 },
  "hy3-preview":          { contextWindow: 256000, maxOutput: 64000,  vision: false, reasoning: true,  creditRate: 0.01 },
  "kimi-k2.5":            { contextWindow: 262144, maxOutput: 262144, vision: true,  reasoning: true,  creditRate: 0.05 },
  "kimi-k2.6":            { contextWindow: 262144, maxOutput: 262144, vision: true,  reasoning: true,  creditRate: 0.09 },
  "kimi-k2.7":            { contextWindow: 262144, maxOutput: 262144, vision: true,  reasoning: true,  creditRate: 0.07 },
  "minimax-m2.7":         { contextWindow: 204800, maxOutput: 131072, vision: true,  reasoning: true,  creditRate: 0.10 },
  "minimax-m3":           { contextWindow: 512000, maxOutput: 128000, vision: true,  reasoning: true,  creditRate: 0.10 },
};

// Quick lookup map
export const CODEBUDDY_CN_API_MODEL_CONFIG_MAP = new Map(
  Object.entries(CODEBUDDY_CN_API_MODEL_CONFIG)
);

// ── Agent Prompt Detection Patterns ──
export const AGENT_PROMPT_PATTERNS = [
  /claude.*official.*cli/i,
  /code.*official.*cli/i,
  /you are (?:cursor|windsurf|cline|aider|continue|copilot|cody)/i,
  /you are an? (?:ai )?(?:coding |code )?agent/i,
  /cc_entrypoint/i,
  /OhMyOpenCode/i,
];

export const NEUTRAL_SYSTEM_PROMPT = "You are a helpful AI assistant that helps with software engineering tasks.";
export const AGENT_PROMPT_LENGTH_THRESHOLD = 2000;
```

- [ ] **Step 2: Verify syntax**

Run: `node -c src/lib/codebuddy-cn-api/constants.js`
Expected: No output (syntax OK)

- [ ] **Step 3: Commit**

```bash
git add src/lib/codebuddy-cn-api/constants.js
git commit -m "feat(codebuddy-cn-api): add constants and model configuration"
```

---

### Task 2: Provider Registry Entry

**Files:**
- Create: `open-sse/providers/registry/codebuddy-cn-api.js`
- Modify: `open-sse/providers/registry/index.js`

**Interfaces:**
- Consumes: `CODEBUDDY_CN_API_MODELS` from Task 1
- Produces: Registry entry object consumed by 9Router provider system

- [ ] **Step 1: Create the registry entry**

```javascript
// open-sse/providers/registry/codebuddy-cn-api.js
import { CODEBUDDY_CN_API_MODELS } from "@/lib/codebuddy-cn-api/constants.js";

export default {
  id: "codebuddy-cn-api",
  alias: "cbca",
  uiAlias: "cbca",
  priority: 901,
  category: "apikey",

  display: {
    name: "CodeBuddy CN API",
    icon: "smart_toy",
    color: "#1E6FFF",
    textIcon: "CB",
    website: "https://copilot.tencent.com",
    notice: {
      text: "CodeBuddy China (腾讯云代码助手). Get your API key from the Tencent portal.",
      apiKeyUrl: "https://copilot.tencent.com/profile/keys",
    },
  },

  transport: {
    baseUrl: "https://copilot.tencent.com/v2/chat/completions",
    format: "openai",
    forceStream: true,
    thinkingFormat: "openai",
    authType: "api_key",
    timeoutMs: 120_000,
    stallTimeoutMs: 60_000,
    headers: {
      "X-Product": "SaaS",
      "X-IDE-Type": "CLI",
      "X-IDE-Name": "CLI",
      "X-Domain": "copilot.tencent.com",
      "x-requested-with": "XMLHttpRequest",
      "x-codebuddy-request": "1",
    },
    auth: { header: "Authorization", scheme: "bearer" },
    usage: { url: "https://copilot.tencent.com/v2/billing/meter/get-user-resource" },
  },

  models: CODEBUDDY_CN_API_MODELS,

  features: {
    usage: true,
    usageApikey: true,
    sanitizer: true,
  },
};
```

- [ ] **Step 2: Register in registry/index.js**

Read `open-sse/providers/registry/index.js` to find the last import number. Add using `p901` to match the provider priority:

```javascript
// Use p901 to match provider priority — easy to find
import p901 from "./codebuddy-cn-api.js";
```

And append `p901` to the export array:

```javascript
export default [
  p0, p1, /* ...existing entries... */, p901
];
```

- [ ] **Step 3: Verify the provider loads**

Run: `node -e "import('./open-sse/providers/registry/codebuddy-cn-api.js').then(m => console.log(m.default.id, m.default.models.length + ' models'))"`
Expected: `codebuddy-cn-api 19 models`

- [ ] **Step 4: Commit**

```bash
git add open-sse/providers/registry/codebuddy-cn-api.js open-sse/providers/registry/index.js
git commit -m "feat(codebuddy-cn-api): add provider registry entry with 19 models"
```

---

### Task 3: Capabilities Map

**Files:**
- Modify: `open-sse/providers/capabilities.js`

**Interfaces:**
- Consumes: `CODEBUDDY_CN_API_MODEL_CONFIG` from Task 1
- Produces: Per-model capability overrides for the provider system

- [ ] **Step 1: Add PROVIDER_CAPABILITIES entry**

In `open-sse/providers/capabilities.js`, find the `PROVIDER_CAPABILITIES` object and add a new entry after the existing `"codebuddy-cn"` block:

```javascript
"codebuddy-cn-api": {
  "claude-haiku-4.5":     { tools: true, vision: false, reasoning: true,  thinkingFormat: "openai", thinkingCanDisable: true,  contextWindow: 200000,  maxOutput: 64000 },
  "deepseek-r1":          { tools: true, vision: false, reasoning: true,  thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 128000,  maxOutput: 32000 },
  "deepseek-v3":          { tools: true, vision: false, reasoning: false, thinkingFormat: null,     thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 384000 },
  "deepseek-v3-2-volc":   { tools: true, vision: true,  reasoning: false, thinkingFormat: null,     thinkingCanDisable: false, contextWindow: 64000,   maxOutput: 32000 },
  "deepseek-v3.2":        { tools: true, vision: false, reasoning: false, thinkingFormat: null,     thinkingCanDisable: false, contextWindow: 96000,   maxOutput: 32000 },
  "deepseek-v4-flash":    { tools: true, vision: true,  reasoning: true,  thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 384000 },
  "deepseek-v4-pro":      { tools: true, vision: true,  reasoning: true,  thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 384000 },
  "glm-4.7":              { tools: true, vision: false, reasoning: true,  thinkingFormat: "openai", thinkingCanDisable: true,  contextWindow: 204800,  maxOutput: 131072 },
  "glm-5.0":              { tools: true, vision: false, reasoning: true,  thinkingFormat: "openai", thinkingCanDisable: true,  contextWindow: 204800,  maxOutput: 131072 },
  "glm-5.1":              { tools: true, vision: true,  reasoning: true,  thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 200000,  maxOutput: 131072 },
  "glm-5.2":              { tools: true, vision: true,  reasoning: true,  thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 131072 },
  "glm-5v-turbo":         { tools: true, vision: true,  reasoning: true,  thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 200000,  maxOutput: 131072 },
  "hunyuan-2.0-instruct": { tools: true, vision: false, reasoning: false, thinkingFormat: null,     thinkingCanDisable: false, contextWindow: 256000,  maxOutput: 8000 },
  "hy3-preview":          { tools: true, vision: false, reasoning: true,  thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 256000,  maxOutput: 64000 },
  "kimi-k2.5":            { tools: true, vision: true,  reasoning: true,  thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 262144,  maxOutput: 262144 },
  "kimi-k2.6":            { tools: true, vision: true,  reasoning: true,  thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 262144,  maxOutput: 262144 },
  "kimi-k2.7":            { tools: true, vision: true,  reasoning: true,  thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 262144,  maxOutput: 262144 },
  "minimax-m2.7":         { tools: true, vision: true,  reasoning: true,  thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 204800,  maxOutput: 131072 },
  "minimax-m3":           { tools: true, vision: true,  reasoning: true,  thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 512000,  maxOutput: 128000 },
},
```

- [ ] **Step 2: Verify syntax**

Run: `node -c open-sse/providers/capabilities.js`
Expected: No output (syntax OK)

- [ ] **Step 3: Commit**

```bash
git add open-sse/providers/capabilities.js
git commit -m "feat(codebuddy-cn-api): add capabilities map for 19 models"
```

---

### Task 4: DB Schema — sanitizerRules Table

**Files:**
- Modify: `src/lib/db/schema.js`
- Create: `src/lib/db/repos/sanitizerRulesRepo.js`

**Interfaces:**
- Produces: `sanitizerRulesRepo.getAll()`, `.getByProvider(provider)`, `.create(rule)`, `.update(id, changes)`, `.delete(id)`, `.seedDefaults(rules)`, `.count()`

- [ ] **Step 1: Add sanitizerRules table to schema.js**

In `src/lib/db/schema.js`, find the `TABLES` object and add after the last table entry:

```javascript
sanitizerRules: {
  columns: {
    id: "TEXT PRIMARY KEY",
    type: "TEXT NOT NULL",           // "regex" | "exact"
    pattern: "TEXT NOT NULL",
    replacement: "TEXT DEFAULT ''",
    enabled: "INTEGER DEFAULT 1",
    priority: "INTEGER DEFAULT 0",
    provider: "TEXT DEFAULT 'all'",  // "all" or specific provider ID
    createdAt: "TEXT NOT NULL",
    updatedAt: "TEXT NOT NULL",
  },
},
```

- [ ] **Step 2: Create the sanitizerRulesRepo**

```javascript
// src/lib/db/repos/sanitizerRulesRepo.js
import { getDb } from "@/lib/db/index.js";

const TABLE = "sanitizerRules";

export function getAllSanitizerRules() {
  const db = getDb();
  return db.prepare(`SELECT * FROM ${TABLE} ORDER BY priority ASC, id ASC`).all();
}

export function getSanitizerRulesByProvider(provider) {
  const db = getDb();
  return db.prepare(
    `SELECT * FROM ${TABLE} WHERE provider = 'all' OR provider = ? ORDER BY priority ASC, id ASC`
  ).all(provider);
}

export function createSanitizerRule(rule) {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO ${TABLE} (id, type, pattern, replacement, enabled, priority, provider, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    rule.id, rule.type, rule.pattern, rule.replacement || "",
    rule.enabled ?? 1, rule.priority ?? 0, rule.provider || "all",
    now, now
  );
  return { ...rule, createdAt: now, updatedAt: now };
}

export function updateSanitizerRule(id, changes) {
  const db = getDb();
  const now = new Date().toISOString();
  const sets = [];
  const values = [];
  for (const [key, val] of Object.entries(changes)) {
    if (["type", "pattern", "replacement", "enabled", "priority", "provider"].includes(key)) {
      sets.push(`${key} = ?`);
      values.push(val);
    }
  }
  sets.push("updatedAt = ?");
  values.push(now);
  values.push(id);
  db.prepare(`UPDATE ${TABLE} SET ${sets.join(", ")} WHERE id = ?`).run(...values);
}

export function deleteSanitizerRule(id) {
  const db = getDb();
  db.prepare(`DELETE FROM ${TABLE} WHERE id = ?`).run(id);
}

export function countSanitizerRules() {
  const db = getDb();
  return db.prepare(`SELECT COUNT(*) as count FROM ${TABLE}`).get().count;
}

export function seedDefaultSanitizerRules(rules) {
  const existing = countSanitizerRules();
  if (existing > 0) return; // Don't overwrite user customizations
  for (const rule of rules) {
    createSanitizerRule(rule);
  }
}
```

- [ ] **Step 3: Verify syntax**

Run: `node -c src/lib/db/repos/sanitizerRulesRepo.js && node -c src/lib/db/schema.js`
Expected: No output (syntax OK)

- [ ] **Step 4: Commit**

```bash
git add src/lib/db/schema.js src/lib/db/repos/sanitizerRulesRepo.js
git commit -m "feat(codebuddy-cn-api): add sanitizerRules DB table and repository"
```

---

### Task 5: Sanitizer Service

**Files:**
- Create: `open-sse/services/sanitizer.js`
- Create: `src/lib/codebuddy-cn-api/initSanitizerRules.js`

**Interfaces:**
- Consumes: `getSanitizerRulesByProvider(provider)` from Task 4
- Produces: `applySanitizerFilters(body, provider)` — mutates body in-place, returns body

- [ ] **Step 1: Create the sanitizer service**

```javascript
// open-sse/services/sanitizer.js
import { getSanitizerRulesByProvider } from "@/lib/db/repos/sanitizerRulesRepo.js";
import * as logger from "@/sse/utils/logger.js";

const LOG_TAG = "SANITIZER";

// ── Cache: load once, invalidate on CRUD, reload after CRUD ──
let cache = [];

export async function loadSanitizerCache() {
  try {
    cache = getSanitizerRulesByProvider("all"); // Load all + provider-specific
    logger.debug(LOG_TAG, `Sanitizer cache loaded: ${cache.length} rules`);
  } catch (e) {
    logger.error(LOG_TAG, "Failed to load sanitizer cache", { error: e.message });
  }
}

export function invalidateSanitizerCache() {
  // Reload from DB after CRUD operation
  loadSanitizerCache();
}

export function getSanitizerRules() {
  return cache;
}

function applyRules(text, rules) {
  if (!text || typeof text !== "string") return text;
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (rule.type === "regex") {
      const regex = new RegExp(rule.pattern, "gi");
      text = text.replace(regex, rule.replacement || "");
    } else if (rule.type === "exact") {
      text = text.replaceAll(rule.pattern, rule.replacement || "");
    }
  }
  return text;
}

export function applySanitizerFilters(body, provider) {
  if (!body?.messages) return body;
  const rules = cache.filter(r =>
    r.enabled && (r.provider === "all" || r.provider === provider)
  );
  if (rules.length === 0) return body;

  // Apply to all message content
  for (const message of body.messages) {
    if (typeof message.content === "string") {
      message.content = applyRules(message.content, rules);
    } else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === "text" && block.text) {
          block.text = applyRules(block.text, rules);
        }
        // Handle tool_result nested content
        if (block.type === "tool_result") {
          if (typeof block.content === "string") {
            block.content = applyRules(block.content, rules);
          } else if (Array.isArray(block.content)) {
            for (const sub of block.content) {
              if (sub.type === "text" && sub.text) {
                sub.text = applyRules(sub.text, rules);
              }
            }
          }
        }
      }
    }
  }

  // Apply to tool descriptions
  if (body.tools) {
    for (const tool of body.tools) {
      if (tool.function?.description) {
        tool.function.description = applyRules(tool.function.description, rules);
      }
    }
  }

  return body;
}
```

- [ ] **Step 2: Create the default rules seeder**

```javascript
// src/lib/codebuddy-cn-api/initSanitizerRules.js
import { seedDefaultSanitizerRules } from "@/lib/db/repos/sanitizerRulesRepo.js";

const DEFAULT_RULES = [
  // Phase 1: Regex rules (18)
  { id: "remove_billing_header_regex", type: "regex", pattern: "x-(?:anthropic-)?billing-header:?\\s*[^\\n]*", replacement: "", priority: 1 },
  { id: "remove_cc_entrypoint_any", type: "regex", pattern: "cc_entrypoint=\\w+", replacement: "", priority: 2 },
  { id: "remove_cc_version_any", type: "regex", pattern: "cc_version=[\\w.]+", replacement: "", priority: 3 },
  { id: "remove_cch_hash", type: "regex", pattern: "c?ch=[a-f0-9]+", replacement: "", priority: 4 },
  { id: "remove_claude_code_github", type: "regex", pattern: "https?://github\\.com/anthropics/claude-code[^\\s]*", replacement: "", priority: 5 },
  { id: "remove_claude_code_identity_variations", type: "regex", pattern: "You are Claude Code[^.]*\\.", replacement: "", priority: 6 },
  { id: "remove_anthropic_cli_ref", type: "regex", pattern: "Anthropic'?'s official (?:CLI|tool|agent)[^.]*\\.?", replacement: "", priority: 7 },
  { id: "remove_anxthxropic_ref", type: "regex", pattern: "Anxthxropic'?'s official[^.]*\\.?", replacement: "", priority: 8 },
  { id: "remove_cursor_identity", type: "regex", pattern: "You are (?:a )?(?:powerful )?(?:AI )?(?:assistant|agent) (?:made|built|created) by (?:Cursor|Anysphere)[^.]*\\.?", replacement: "", priority: 9 },
  { id: "remove_windsurf_identity", type: "regex", pattern: "You are (?:Windsurf|Cascade|Codeium)[^.]*\\.?", replacement: "", priority: 10 },
  { id: "remove_cline_identity", type: "regex", pattern: "You are Cline[^.]*\\.?", replacement: "", priority: 11 },
  { id: "remove_ai_coding_agent_pattern", type: "regex", pattern: "(?:autonomous|agentic) (?:AI |coding )?(?:agent|assistant)[^.]*\\.", replacement: "", priority: 12 },
  { id: "remove_mcp_server_ref", type: "regex", pattern: "MCP (?:server|client|protocol)[^.]*\\.?", replacement: "", priority: 13 },
  { id: "remove_powered_by_anthropic", type: "regex", pattern: "powered by (?:Claude|Anthropic|Anxthxropic)[^.]*\\.?", replacement: "", priority: 14 },
  { id: "remove_ohmyopencode_ref", type: "regex", pattern: "OhMyOpenCode[^.]*\\.?", replacement: "", priority: 15 },
  { id: "remove_opencode_ref", type: "regex", pattern: "opencode[^.]*\\.?", replacement: "", priority: 16 },
  { id: "remove_system_prompt_fingerprint", type: "regex", pattern: "(?:system|assistant) (?:prompt|message) (?:by|from) [^.]*\\.?", replacement: "", priority: 17 },
  { id: "remove_claude_sonnet_identity", type: "regex", pattern: "claude[- ]sonnet[- ][^.]*\\.?", replacement: "", priority: 18 },
  // Phase 2: Exact string fallbacks (4)
  { id: "remove_powerful_ai_agent", type: "exact", pattern: "Advanced AI Agent", replacement: "", priority: 19 },
  { id: "remove_claude_code_identity", type: "exact", pattern: "You are Claude Code, Anxthxropic's official CLI for Claude.", replacement: "", priority: 20 },
  { id: "remove_claude_code_mention", type: "exact", pattern: "Claude Code", replacement: "the assistant", priority: 21 },
  { id: "remove_feedback_line", type: "exact", pattern: "If you found this conversation helpful, please leave feedback at https://claude.ai/feedback", replacement: "", priority: 22 },
];

export function initSanitizerRules() {
  try {
    seedDefaultSanitizerRules(DEFAULT_RULES);
  } catch (e) {
    // Table may not exist yet on first boot — schema sync runs later
    console.warn("[sanitizer] Failed to seed default rules:", e.message);
  }
}
```

- [ ] **Step 3: Verify syntax**

Run: `node -c open-sse/services/sanitizer.js && node -c src/lib/codebuddy-cn-api/initSanitizerRules.js`
Expected: No output (syntax OK)

- [ ] **Step 4: Commit**

```bash
git add open-sse/services/sanitizer.js src/lib/codebuddy-cn-api/initSanitizerRules.js
git commit -m "feat(codebuddy-cn-api): add sanitizer service and default rules seeder"
```

---

### Task 6: chatCore.js Sanitizer Integration

**Files:**
- Modify: `open-sse/handlers/chatCore.js`

**Interfaces:**
- Consumes: `applySanitizerFilters(body, provider)` from Task 5
- Produces: Sanitized body passed to executor

- [ ] **Step 1: Add import at top of chatCore.js**

Add after the existing imports (near the caveman/ponytail imports):

```javascript
import { applySanitizerFilters } from "../services/sanitizer.js";
```

- [ ] **Step 2: Add sanitizer stage in the token savers pipeline**

Find the section where Ponytail is injected (around line 177). After the Ponytail block and before `const executor = getExecutor(provider)`, add:

```javascript
// ── Sanitizer (provider-conditional, synchronous — cache is in-memory) ──
const providerConfig = PROVIDERS[provider];
if (providerConfig?.features?.sanitizer) {
  applySanitizerFilters(translatedBody, provider);
}
```

Note: `PROVIDERS` is already imported in chatCore.js from the provider config system. Verify the import exists; if not, add:
```javascript
import { PROVIDERS } from "../providers/index.js";
```

- [ ] **Step 3: Verify syntax**

Run: `node -c open-sse/handlers/chatCore.js`
Expected: No output (syntax OK)

- [ ] **Step 4: Commit**

```bash
git add open-sse/handlers/chatCore.js
git commit -m "feat(codebuddy-cn-api): integrate sanitizer into chatCore pipeline"
```

---

### Task 7: CodebuddyCnApiExecutor

**Files:**
- Create: `open-sse/executors/codebuddyCnApi.js`
- Modify: `open-sse/executors/index.js`

**Interfaces:**
- Consumes: `buildDefaultHeaders`, `CODEBUDDY_CN_API_CHAT_URL`, `CODEBUDDY_CN_API_MODEL_CONFIG_MAP`, `AGENT_PROMPT_PATTERNS`, `NEUTRAL_SYSTEM_PROMPT`, `AGENT_PROMPT_LENGTH_THRESHOLD` from Task 1
- Consumes: `proxyAwareFetch` from `open-sse/utils/proxyFetch.js`
- Produces: `CodebuddyCnApiExecutor` class with `execute()` method

- [ ] **Step 1: Create the executor**

```javascript
// open-sse/executors/codebuddyCnApi.js
import { DefaultExecutor } from "./default.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import * as logger from "@/sse/utils/logger.js";
import {
  buildDefaultHeaders,
  CODEBUDDY_CN_API_CHAT_URL,
  CODEBUDDY_CN_API_MODEL_CONFIG_MAP,
  AGENT_PROMPT_PATTERNS,
  NEUTRAL_SYSTEM_PROMPT,
  AGENT_PROMPT_LENGTH_THRESHOLD,
} from "@/lib/codebuddy-cn-api/constants.js";

const LOG_TAG = "CODEBUDDY CN API";

// ── Schema cache for tool sanitization ──
const schemaCache = new Map();
const SCHEMA_CACHE_MAX = 200;

function resolveJsonSchemaRefs(schema, defs) {
  if (!schema || typeof schema !== "object") return schema;
  if (schema.$ref) {
    const refPath = schema.$ref.replace(/^#\/(\$defs|definitions)\//, "");
    return defs[refPath] ? resolveJsonSchemaRefs(defs[refPath], defs) : schema;
  }
  const result = {};
  for (const [key, val] of Object.entries(schema)) {
    if (["$schema", "$id", "$comment", "$defs", "definitions"].includes(key)) continue;
    result[key] = Array.isArray(val)
      ? val.map(v => resolveJsonSchemaRefs(v, defs))
      : resolveJsonSchemaRefs(val, defs);
  }
  return result;
}

function sanitizeToolSchemas(tools) {
  if (!tools) return tools;
  for (const tool of tools) {
    const fn = tool.function;
    if (!fn?.parameters) continue;
    const cacheKey = JSON.stringify(fn.parameters);
    if (schemaCache.has(cacheKey)) {
      fn.parameters = schemaCache.get(cacheKey);
      continue;
    }
    const defs = fn.parameters.$defs || fn.parameters.definitions || {};
    let cleaned = resolveJsonSchemaRefs(fn.parameters, defs);
    if (!cleaned.type) cleaned.type = "object";
    if (!cleaned.properties) cleaned.properties = {};
    if (schemaCache.size < SCHEMA_CACHE_MAX) {
      schemaCache.set(cacheKey, cleaned);
    }
    fn.parameters = cleaned;
  }
  return tools;
}

function isAgentSystemPrompt(text) {
  if (!text || typeof text !== "string") return false;
  if (text.length > AGENT_PROMPT_LENGTH_THRESHOLD) return true;
  return AGENT_PROMPT_PATTERNS.some(p => p.test(text));
}

function cleanMessages(messages) {
  if (!messages) return messages;
  const cleaned = [];
  for (const msg of messages) {
    const m = { ...msg };

    // Handle system messages with agent prompts
    if (m.role === "system" && isAgentSystemPrompt(m.content)) {
      m.content = NEUTRAL_SYSTEM_PROMPT;
    }

    // Convert Anthropic tool_use blocks to OpenAI tool_calls
    if (m.role === "assistant" && Array.isArray(m.content)) {
      const toolCalls = [];
      const textParts = [];
      for (const block of m.content) {
        if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            type: "function",
            function: { name: block.name, arguments: JSON.stringify(block.input || {}) },
          });
        } else if (block.type === "text") {
          textParts.push(block.text);
        }
      }
      m.content = textParts.join("\n") || null;
      if (toolCalls.length > 0) m.tool_calls = toolCalls;
    }

    // Convert Anthropic tool_result to OpenAI tool role
    if (m.role === "user" && Array.isArray(m.content)) {
      const toolResults = m.content.filter(b => b.type === "tool_result");
      if (toolResults.length > 0) {
        // Emit one message per tool_result
        for (const tr of toolResults) {
          cleaned.push({
            role: "tool",
            tool_call_id: tr.tool_use_id,
            content: typeof tr.content === "string" ? tr.content : JSON.stringify(tr.content),
          });
        }
        // Keep non-tool_result blocks
        const otherBlocks = m.content.filter(b => b.type !== "tool_result");
        if (otherBlocks.length > 0) {
          m.content = otherBlocks.length === 1 && otherBlocks[0].type === "text"
            ? otherBlocks[0].text
            : otherBlocks;
          cleaned.push(m);
        }
        continue;
      }

      // Convert image blocks to OpenAI format
      const hasImages = m.content.some(b => b.type === "image");
      if (hasImages) {
        m.content = m.content.map(b => {
          if (b.type === "image" && b.source?.type === "base64") {
            return {
              type: "image_url",
              image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` },
            };
          }
          if (b.type === "image" && b.source?.type === "url") {
            return { type: "image_url", image_url: { url: b.source.url } };
          }
          return b;
        });
      }

      // Collapse text-only arrays to string
      if (Array.isArray(m.content) && m.content.every(b => b.type === "text")) {
        m.content = m.content.map(b => b.text).join("\n");
      }
    }

    cleaned.push(m);
  }
  return cleaned;
}

function injectReasoning(body) {
  const effort = body.reasoning_effort
    || body.reasoning?.effort
    || (body.thinking?.type === "enabled" ? "max" : null);

  if (effort === "none" || effort === "off") {
    delete body.reasoning_effort;
    delete body.reasoning;
  } else {
    body.reasoning_effort = effort || "max";
    body.reasoning_summary = "auto";
  }
  // Clean up Anthropic-style thinking params
  delete body.thinking;
  delete body.reasoning;
}

function applyMaxTokensDefault(body, model) {
  if (body.max_tokens != null || body.max_completion_tokens != null) return;
  const config = CODEBUDDY_CN_API_MODEL_CONFIG_MAP.get(model);
  if (config?.maxOutput) {
    body.max_tokens = config.maxOutput;
  }
}

export class CodebuddyCnApiExecutor extends DefaultExecutor {
  constructor() {
    super("codebuddy-cn-api");
  }

  buildUrl() {
    return CODEBUDDY_CN_API_CHAT_URL;
  }

  buildHeaders(credentials) {
    const apiKey = credentials.apiKey || credentials.accessToken;
    return buildDefaultHeaders(apiKey);
  }

  transformRequest(model, body, stream, credentials) {
    const transformed = super.transformRequest(model, body, stream, credentials);

    // Force stream
    transformed.stream = true;

    // Clean messages (Anthropic -> OpenAI conversion)
    transformed.messages = cleanMessages(transformed.messages);

    // Sanitize tool schemas
    if (transformed.tools) {
      transformed.tools = sanitizeToolSchemas(transformed.tools);
    }

    // Inject reasoning config
    injectReasoning(transformed);

    // Default temperature for coding
    if (transformed.temperature == null) {
      transformed.temperature = 0.1;
    }

    // Default max_tokens to model's max output
    applyMaxTokensDefault(transformed, model);

    return transformed;
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions }) {
    const url = this.buildUrl(model, stream);
    const headers = this.buildHeaders(credentials);
    const transformed = this.transformRequest(model, body, stream, credentials);

    const response = await proxyAwareFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(transformed),
      signal,
    }, proxyOptions);

    return { response, url, headers, transformedBody: transformed };
  }
}

export default CodebuddyCnApiExecutor;
```

- [ ] **Step 2: Register in executors/index.js**

Add import at the top with other executor imports:

```javascript
import { CodebuddyCnApiExecutor } from "./codebuddyCnApi.js";
```

Add to the `executors` map:

```javascript
"codebuddy-cn-api": new CodebuddyCnApiExecutor(),
```

Add to the re-exports at the bottom:

```javascript
export { CodebuddyCnApiExecutor } from "./codebuddyCnApi.js";
```

- [ ] **Step 3: Verify syntax**

Run: `node -c open-sse/executors/codebuddyCnApi.js && node -c open-sse/executors/index.js`
Expected: No output (syntax OK)

- [ ] **Step 4: Commit**

```bash
git add open-sse/executors/codebuddyCnApi.js open-sse/executors/index.js
git commit -m "feat(codebuddy-cn-api): add custom executor with cleanMessages, tool sanitization, reasoning injection"
```

---

### Task 8: Test Connection (Billing API)

**Files:**
- Modify: `src/app/api/providers/[id]/test/testUtils.js`

**Interfaces:**
- Consumes: `CODEBUDDY_CN_API_BILLING_URL`, `buildDefaultHeaders` from Task 1
- Produces: Test result `{ valid, latencyMs, error }` for codebuddy-cn-api connections

- [ ] **Step 1: Add codebuddy-cn-api test case in testApiKeyConnection**

In `testUtils.js`, find the `testApiKeyConnection` function. Look for the provider-specific switch/if-else block that handles different API key providers. Add a case for `codebuddy-cn-api`:

```javascript
// Inside testApiKeyConnection, add before the generic OpenAI-compatible fallback:
if (connection.provider === "codebuddy-cn-api") {
  const startTime = Date.now();
  try {
    const headers = {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": "CLI/2.109.0 CodeBuddy/2.109.0",
      "X-Product": "SaaS",
      "X-Domain": "copilot.tencent.com",
    };
    const resp = await proxyAwareFetch(
      "https://copilot.tencent.com/v2/billing/meter/get-user-resource",
      { method: "POST", headers, body: "{}", signal: AbortSignal.timeout(15000) },
      effectiveProxy
    );
    const latencyMs = Date.now() - startTime;
    if (resp.ok) {
      const data = await resp.json();
      if (data?.code === 0) {
        return { valid: true, latencyMs };
      }
      return { valid: false, error: `Billing API error: ${data?.msg || "unknown"}` };
    }
    if (resp.status === 401 || resp.status === 403) {
      return { valid: false, error: "Invalid API key" };
    }
    return { valid: false, error: `HTTP ${resp.status}` };
  } catch (e) {
    return { valid: false, error: e.message };
  }
}
```

- [ ] **Step 2: Verify syntax**

Run: `node -c src/app/api/providers/[id]/test/testUtils.js`
Expected: No output (syntax OK)

- [ ] **Step 3: Commit**

```bash
git add src/app/api/providers/[id]/test/testUtils.js
git commit -m "feat(codebuddy-cn-api): add test connection via billing API"
```

---

### Task 9: Quota/Usage Tracking

**Files:**
- Create: `open-sse/services/usage/codebuddy-cn-api.js`

**Interfaces:**
- Consumes: `CODEBUDDY_CN_API_BILLING_URL`, `buildDefaultHeaders` from Task 1
- Consumes: `proxyAwareFetch` from `open-sse/utils/proxyFetch.js`
- Produces: `getCodebuddyCnApiUsage(credentials, proxyOptions)` → `{ plan, quotas }`

- [ ] **Step 1: Create the usage service**

```javascript
// open-sse/services/usage/codebuddy-cn-api.js
import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { CODEBUDDY_CN_API_BILLING_URL } from "@/lib/codebuddy-cn-api/constants.js";

export async function getCodebuddyCnApiUsage(credentials, proxyOptions) {
  const apiKey = credentials.apiKey || credentials.accessToken;
  if (!apiKey) return null;

  try {
    const resp = await proxyAwareFetch(CODEBUDDY_CN_API_BILLING_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": "CLI/2.109.0 CodeBuddy/2.109.0",
        "X-Product": "SaaS",
        "X-Domain": "copilot.tencent.com",
      },
      body: "{}",
      signal: AbortSignal.timeout(15000),
    }, proxyOptions);

    if (!resp.ok) return null;

    const data = await resp.json();
    if (data?.code !== 0) return null;

    const accounts = data?.data?.Response?.Data?.Accounts || [];
    if (accounts.length === 0) return null;

    const quotas = {};
    for (const acc of accounts) {
      const isBonus = acc.SubProductName?.includes("赠送包") || acc.SubProductName?.includes("Bonus");
      const name = isBonus ? (acc.PackageName || "Bonus Pack") : "Monthly";

      // Use Precise fields for decimal accuracy
      const cycleEnd = acc.CycleEndTime;
      const deductionEnd = acc.DeductionEndTime;

      // Detect account type: if CycleEndTime << DeductionEndTime (>2d gap), it's a refill/base account
      const cycleEndMs = cycleEnd ? new Date(cycleEnd).getTime() : 0;
      const deductionEndMs = deductionEnd ? new Date(deductionEnd).getTime() : 0;
      const isRefill = Math.abs(deductionEndMs - cycleEndMs) > 2 * 24 * 60 * 60 * 1000;

      const used = parseFloat(isRefill
        ? (acc.CycleCapacityUsedPrecise || acc.CapacityUsedPrecise || "0")
        : (acc.CapacityUsedPrecise || acc.CycleCapacityUsedPrecise || "0"));
      const total = parseFloat(isRefill
        ? (acc.CycleCapacitySizePrecise || acc.CapacitySizePrecise || "0")
        : (acc.CapacitySizePrecise || acc.CycleCapacitySizePrecise || "0"));

      quotas[name] = {
        used,
        total,
        remain: Math.max(0, total - used),
        resetAt: cycleEnd || null,
        unlimited: false,
      };
    }

    return { plan: "CodeBuddy CN API", quotas };
  } catch (e) {
    console.warn("[codebuddy-cn-api] Usage fetch failed:", e.message);
    return null;
  }
}
```

- [ ] **Step 2: Register in usage service index**

Check if `open-sse/services/usage.js` has a provider→handler map. If so, add:

```javascript
"codebuddy-cn-api": getCodebuddyCnApiUsage,
```

with the appropriate import.

- [ ] **Step 3: Verify syntax**

Run: `node -c open-sse/services/usage/codebuddy-cn-api.js`
Expected: No output (syntax OK)

- [ ] **Step 4: Commit**

```bash
git add open-sse/services/usage/codebuddy-cn-api.js
git commit -m "feat(codebuddy-cn-api): add quota/usage tracking via billing API"
```

---

### Task 10: Settings & Boot-time Init

**Files:**
- Create: `src/lib/codebuddy-cn-api/initCodebuddyCnApiSettings.js`
- Modify: `src/app/api/settings/route.js`
- Modify: `src/app/layout.js` (or wherever boot-time inits are imported)

**Interfaces:**
- Consumes: `getSettings()` from `src/lib/localDb.js`
- Produces: `initCodebuddyCnApiSettings()` — sets `process.env.CODEBUDDY_CN_API_CLI_VERSION`

- [ ] **Step 1: Create the settings initializer**

```javascript
// src/lib/codebuddy-cn-api/initCodebuddyCnApiSettings.js
import { getSettings } from "@/lib/localDb.js";

export function initCodebuddyCnApiSettings() {
  try {
    const settings = getSettings();
    if (settings.codebuddyCnApiCliVersion) {
      process.env.CODEBUDDY_CN_API_CLI_VERSION = settings.codebuddyCnApiCliVersion;
    }
  } catch (e) {
    // DB may not be ready yet on first boot
    console.warn("[codebuddy-cn-api] Failed to init settings:", e.message);
  }
}

export function applyCodebuddyCnApiSettingsToEnv(settings) {
  if (settings.codebuddyCnApiCliVersion) {
    process.env.CODEBUDDY_CN_API_CLI_VERSION = settings.codebuddyCnApiCliVersion;
  } else {
    delete process.env.CODEBUDDY_CN_API_CLI_VERSION;
  }
}
```

- [ ] **Step 2: Add to settings route PATCH handler**

In `src/app/api/settings/route.js`, find the section where settings are applied after `updateSettings(body)`. Add:

```javascript
import { applyCodebuddyCnApiSettingsToEnv } from "@/lib/codebuddy-cn-api/initCodebuddyCnApiSettings.js";

// After updateSettings(body):
applyCodebuddyCnApiSettingsToEnv(body);
```

- [ ] **Step 3: Add boot-time init**

Find where other boot-time inits are imported (e.g., `src/app/layout.js` or similar). Add:

```javascript
import { initCodebuddyCnApiSettings } from "@/lib/codebuddy-cn-api/initCodebuddyCnApiSettings.js";

// Call alongside other init functions:
initCodebuddyCnApiSettings();
```

- [ ] **Step 4: Verify syntax**

Run: `node -c src/lib/codebuddy-cn-api/initCodebuddyCnApiSettings.js && node -c src/app/api/settings/route.js`
Expected: No output (syntax OK)

- [ ] **Step 5: Commit**

```bash
git add src/lib/codebuddy-cn-api/initCodebuddyCnApiSettings.js src/app/api/settings/route.js src/app/layout.js
git commit -m "feat(codebuddy-cn-api): add CLI version settings override and boot-time init"
```

---

### Task 11: Sanitizer API Route

**Files:**
- Create: `src/app/api/sanitizer/route.js`

**Interfaces:**
- Consumes: `getAllSanitizerRules`, `getSanitizerRulesByProvider`, `createSanitizerRule`, `updateSanitizerRule`, `deleteSanitizerRule` from Task 4
- Consumes: `invalidateSanitizerCache` from Task 5
- Produces: REST API: GET (list), POST (create), PUT (update), DELETE (delete)

- [ ] **Step 1: Create the API route**

```javascript
// src/app/api/sanitizer/route.js
import { NextResponse } from "next/server";
import {
  getAllSanitizerRules,
  createSanitizerRule,
  updateSanitizerRule,
  deleteSanitizerRule,
} from "@/lib/db/repos/sanitizerRulesRepo.js";
import { invalidateSanitizerCache } from "../../../../open-sse/services/sanitizer.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const rules = getAllSanitizerRules();
  return NextResponse.json({ rules });
}

export async function POST(request) {
  const body = await request.json();
  const { id, type, pattern, replacement, enabled, priority, provider } = body;
  if (!id || !type || !pattern) {
    return NextResponse.json({ error: "id, type, and pattern are required" }, { status: 400 });
  }
  if (!["regex", "exact"].includes(type)) {
    return NextResponse.json({ error: "type must be 'regex' or 'exact'" }, { status: 400 });
  }
  // Validate regex if type is regex
  if (type === "regex") {
    try { new RegExp(pattern); } catch (e) {
      return NextResponse.json({ error: `Invalid regex: ${e.message}` }, { status: 400 });
    }
  }
  const rule = createSanitizerRule({ id, type, pattern, replacement, enabled, priority, provider });
  invalidateSanitizerCache();
  return NextResponse.json({ rule }, { status: 201 });
}

export async function PUT(request) {
  const body = await request.json();
  const { id, ...changes } = body;
  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }
  updateSanitizerRule(id, changes);
  invalidateSanitizerCache();
  return NextResponse.json({ ok: true });
}

export async function DELETE(request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "id query param is required" }, { status: 400 });
  }
  deleteSanitizerRule(id);
  invalidateSanitizerCache();
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 2: Verify syntax**

Run: `node -c src/app/api/sanitizer/route.js`
Expected: No output (syntax OK)

- [ ] **Step 3: Commit**

```bash
git add src/app/api/sanitizer/route.js
git commit -m "feat(codebuddy-cn-api): add sanitizer rules REST API"
```

---

### Task 12: Dashboard UI — Sanitizer Page

**Files:**
- Create: `src/app/(dashboard)/dashboard/sanitizer/page.js`
- Modify: `src/shared/components/Sidebar.js`

**Interfaces:**
- Consumes: `GET/POST/PUT/DELETE /api/sanitizer` from Task 11
- Produces: React page component with rule management UI

- [ ] **Step 1: Add Sanitizer to sidebar navigation**

In `src/shared/components/Sidebar.js`, find the `systemItems` array and add Sanitizer BEFORE the existing items (so it appears above Settings in the sidebar):

```javascript
const systemItems = [
  { href: "/dashboard/sanitizer", label: "Sanitizer", icon: "filter_alt" },
  // ...existing systemItems (Proxy Pools, Skills, etc.)
];
```

- [ ] **Step 2: Create the sanitizer page**

Create `src/app/(dashboard)/dashboard/sanitizer/page.js` — a React client component with:
- Table listing all rules (ID, type, pattern, replacement, enabled toggle, provider, priority)
- Add rule form (id, type dropdown, pattern input, replacement input, provider dropdown)
- Edit inline (click row to edit)
- Delete button per row
- Toggle enabled/disabled per row
- "Reset to Defaults" button (calls `POST /api/sanitizer` with default rules)
- "Reload" button (calls `GET /api/sanitizer` to refresh)
- Uses Tailwind CSS 4 for styling, matching existing dashboard pages
- Uses `material-symbols-outlined` for icons

Follow the existing dashboard page patterns (e.g., `src/app/(dashboard)/dashboard/providers/page.js`) for layout, fetch patterns, and styling.

- [ ] **Step 3: Verify the page renders**

Run: `npm run dev` and navigate to `http://localhost:20128/dashboard/sanitizer`
Expected: Page renders with empty rules table (or seeded defaults)

- [ ] **Step 4: Commit**

```bash
git add src/app/\(dashboard\)/dashboard/sanitizer/page.js src/shared/components/Sidebar.js
git commit -m "feat(codebuddy-cn-api): add sanitizer rules dashboard page and sidebar nav"
```

---

### Task 13: Dashboard UI — Provider Settings Card

**Files:**
- Modify: `src/app/(dashboard)/dashboard/profile/page.js`

**Interfaces:**
- Consumes: `PATCH /api/settings` with `codebuddyCnApiCliVersion`
- Produces: Settings card with CLI version input

- [ ] **Step 1: Add CodeBuddy CN API settings card**

In the profile/settings page, find where other provider settings cards are rendered (e.g., the Qoder API Provider card). Add a similar card for CodeBuddy CN API:

```jsx
{/* CodeBuddy CN API Provider */}
<div className="rounded-lg border border-white/10 bg-white/5 p-4">
  <h3 className="text-sm font-medium text-white mb-3">CodeBuddy CN API Provider</h3>
  <div className="space-y-3">
    <div>
      <label className="block text-xs text-white/60 mb-1">CLI Version</label>
      <input
        type="text"
        value={settings.codebuddyCnApiCliVersion || "2.109.0"}
        onChange={e => setSettings(s => ({ ...s, codebuddyCnApiCliVersion: e.target.value }))}
        className="w-full rounded bg-white/10 px-3 py-1.5 text-sm text-white border border-white/10"
        placeholder="2.109.0"
      />
      <p className="text-xs text-white/40 mt-1">
        User-Agent: CLI/{settings.codebuddyCnApiCliVersion || "2.109.0"} CodeBuddy/{settings.codebuddyCnApiCliVersion || "2.109.0"}
      </p>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Verify the card renders**

Run: `npm run dev` and navigate to `http://localhost:20128/dashboard/profile`
Expected: CodeBuddy CN API Provider card appears with CLI version input

- [ ] **Step 3: Commit**

```bash
git add src/app/\(dashboard\)/dashboard/profile/page.js
git commit -m "feat(codebuddy-cn-api): add CLI version settings card to profile page"
```

---

### Task 14: Unit Tests

**Files:**
- Create: `tests/unit/codebuddy-cn-api.test.js`
- Create: `tests/unit/sanitizer.test.js`

- [ ] **Step 1: Create executor unit tests**

Write tests covering:
- `cleanMessages()`: tool_use → tool_calls conversion, tool_result → tool role, image block conversion, text-only collapse, agent prompt detection
- `sanitizeToolSchemas()`: $ref resolution, $defs stripping, type/properties defaults
- `injectReasoning()`: default "max", "none"/"off" stripping, Anthropic thinking conversion
- `applyMaxTokensDefault()`: sets model max when not specified, preserves client value
- `buildHeaders()`: fresh UUIDs per call, correct User-Agent
- `transformRequest()`: force stream=true, temperature default 0.1

Follow the test patterns from `tests/unit/qoder-api.test.js` on the qoder-api branch.

- [ ] **Step 2: Create sanitizer unit tests**

Write tests covering:
- Regex rule application (billing header, identity patterns, CLI references)
- Exact string replacement (Claude Code mention, feedback line)
- Multi-message sanitization (system, user, assistant messages)
- Tool description sanitization
- Array content blocks (text + image + tool_result)
- Cache behavior (TTL, invalidation)
- Provider filtering (rules with provider="all" vs specific)
- Disabled rules are skipped

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/unit/codebuddy-cn-api.test.js tests/unit/sanitizer.test.js`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add tests/unit/codebuddy-cn-api.test.js tests/unit/sanitizer.test.js
git commit -m "test(codebuddy-cn-api): add executor and sanitizer unit tests"
```

---

### Task 15: Integration Smoke Test

- [ ] **Step 1: Start dev server**

Run: `npm run dev`

- [ ] **Step 2: Verify provider appears in dashboard**

Navigate to `http://localhost:20128/dashboard/providers`
Expected: "CodeBuddy CN API" appears in API Key Providers section

- [ ] **Step 3: Add a test API key connection**

Click "Add API Key" on the CodeBuddy CN API card, enter a valid API key, save.
Expected: Connection appears with status indicator

- [ ] **Step 4: Test connection**

Click "Test" on the connection.
Expected: ✅ Active with latency and credit balance displayed

- [ ] **Step 5: Test chat request**

```bash
curl -X POST http://localhost:20128/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <your-9router-api-key>" \
  -d '{"model":"cbca/glm-5.2","messages":[{"role":"user","content":"say hi"}],"stream":true}'
```

Expected: SSE stream with valid response from CodeBuddy CN

- [ ] **Step 6: Verify sanitizer page**

Navigate to `http://localhost:20128/dashboard/sanitizer`
Expected: 22 default rules listed, all enabled

- [ ] **Step 7: Verify settings card**

Navigate to `http://localhost:20128/dashboard/profile`
Expected: CodeBuddy CN API Provider card with CLI version field

- [ ] **Step 8: Final commit**

```bash
git add -A
git commit -m "feat(codebuddy-cn-api): complete provider implementation"
```
