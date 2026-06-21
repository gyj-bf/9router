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
