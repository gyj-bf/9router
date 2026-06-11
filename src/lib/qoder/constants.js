/**
 * Qoder API constants ported from CLIProxyAPIPlus qoder-provider branch.
 *
 * Endpoint set:
 *   openapi.qoder.sh   - device flow + userinfo + quota usage
 *   center.qoder.sh    - token refresh (best-effort, currently 403 for device tokens)
 *   api3.qoder.sh      - inference (chat) + model list, requires COSY signing
 *   qoder.com/device   - browser landing page for device authorization
 */

export const QODER_OPENAPI_BASE = "https://openapi.qoder.sh";
export const QODER_CENTER_BASE = "https://center.qoder.sh";
export const QODER_CHAT_BASE = "https://api3.qoder.sh";

export const QODER_DEFAULTS = Object.freeze({
  region: "sg",
  cosyVersion: "2.11.2",
  mitmBypassQoder: false,
  mitmBypassExtraHosts: "",
});

// Regional inference hosts — override via QODER_API_REGION env var (us, sg, jp).
// All 3 hosts verified to support PAT + COSY signing + body encoding (2026-06-10).
// SG has lowest latency from Asia, JP is current default, US is fallback.
export const QODER_REGION_HOSTS = {
  us: "https://api1.qoder.sh",
  sg: "https://api2.qoder.sh",
  jp: "https://api3.qoder.sh",
};

export function getQoderRegion() {
  const raw = (process.env.QODER_API_REGION || QODER_DEFAULTS.region).toLowerCase().trim();
  return QODER_REGION_HOSTS[raw] ? raw : QODER_DEFAULTS.region;
}

export function getQoderChatBase() {
  return QODER_REGION_HOSTS[getQoderRegion()];
}

export function getQoderChatUrl() {
  return `${getQoderChatBase()}/algo${QODER_CHAT_SIG_PATH}?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`;
}

export function getQoderActivityUrl() {
  return `${getQoderChatBase()}/algo/api/v2/activity`;
}

export function getQoderModelListUrl() {
  return `${getQoderChatBase()}/algo/api/v2/model/list`;
}

export const QODER_LOGIN_URL = "https://qoder.com/device/selectAccounts";

// Device flow endpoints
export const QODER_DEVICE_TOKEN_URL = `${QODER_OPENAPI_BASE}/api/v1/deviceToken/poll`;
export const QODER_USERINFO_URL = `${QODER_OPENAPI_BASE}/api/v1/userinfo`;
export const QODER_QUOTA_USAGE_URL = `${QODER_OPENAPI_BASE}/api/v2/quota/usage`;
export const QODER_REFRESH_TOKEN_URL = `${QODER_CENTER_BASE}/algo/api/v3/user/refresh_token`;

// Activity / free quota tracker endpoint (under /algo on center.qoder.sh, COSY-signed).
// Discovered from @qoder-ai/qodercli npm package — listActivities() method.
export const QODER_ACTIVITY_URL = `${QODER_CENTER_BASE}/algo/api/v2/activity`;

// Inference endpoints (under /algo on api3.qoder.sh, all COSY-signed)
export const QODER_CHAT_SIG_PATH = "/api/v2/service/pro/sse/agent_chat_generation";
export const QODER_CHAT_URL = `${QODER_CHAT_BASE}/algo${QODER_CHAT_SIG_PATH}?FetchKeys=llm_model_result&AgentId=agent_common`;
export const QODER_CHAT_URL_ENCODED = `${QODER_CHAT_URL}&Encode=1`;
export const QODER_MODEL_LIST_URL = `${QODER_CHAT_BASE}/algo/api/v2/model/list`;

// COSY header constants. These are not arbitrary — the upstream signature
// validation matches them against the values used at signing time.
export const QODER_IDE_VERSION = "1.0.0";
export const QODER_CLIENT_TYPE = "5";
export const QODER_DATA_POLICY = "disagree";
export const QODER_LOGIN_VERSION = "v2";
export const QODER_MACHINE_OS = "x86_64_windows";
export const QODER_MACHINE_TYPE = "5";

/**
 * Cosy protocol version (distinct from IDE version). Sourced from
 * lingma-proxy's Remote API mode which reverse-engineers the same
 * protocol. Override via `QODER_COSY_VERSION` env var if a newer
 * version is discovered.
 */
export function getQoderCosyVersion() {
  return process.env.QODER_COSY_VERSION || QODER_DEFAULTS.cosyVersion;
}

// Max output tokens: Set a high default to allow for long code generation and reasoning, can be overridden by request body
// OpenAI max tokens is typically 4096-8192 depending on model, Anthropic models vary but often around 2048-4096
// Setting a high default (32768) to allow for complex coding tasks and reasoning, but can be adjusted per request
export const DEFAULT_MAX_OUTPUT_TOKENS = 32768; // High reasoning effort

// Temperature: Controls randomness in output generation (0-2 for OpenAI, 0-1 for Anthropic)
// Lower values (0.0-0.3) make output more deterministic/focused for coding tasks
// Higher values (0.7-1.0) make output more creative/random for generative tasks
// OpenAI default: 1.0, Anthropic default: 1.0
export const DEFAULT_TEMPERATURE = 0.1; // Low randomness for coding tasks

/**
 * Platform identifiers the Qoder backend accepts in `Cosy-Machineos`.
 * Mirrors lingma-proxy's `MachineOSHeader()` switch table. Pick one
 * randomly per request to avoid fingerprinting on a single hardcoded
 * platform (qoder2api used to always send `"x86_64_windows"`).
 */
export const QODER_MACHINE_OS_OPTIONS = [
  "x86_64_darwin",
  "arm64_darwin",
  "x86_64_linux",
  "arm64_linux",
  "x86_64_windows",
  "arm64_windows",
];

// Canonical model identifiers. Identity map — keep as a map so callers can
// cheaply test "is this a known qoder model?" before sending the request.
export const QODER_MODEL_MAP = {
  // Tier models
  auto: "auto",
  ultimate: "ultimate",
  performance: "performance",
  efficient: "efficient",
  lite: "lite",
  // Frontier models
  qmodel_latest: "qmodel_latest",
  qmodel: "qmodel",
  dmodel: "dmodel",
  dfmodel: "dfmodel",
  gm51model: "gm51model",
  kmodel: "kmodel",
  mmodel: "mmodel",
};

/**
 * Static model configs for the API Key executor. The OAuth executor
 * (qoder.js) fetches live configs from `/algo/api/v2/model/list`, but
 * the API Key executor uses a static map because it has no device
 * token to call the model list endpoint.
 *
 * `is_reasoning` and `is_vl` affect how the backend routes the request
 * and whether it enables thinking-mode or vision capabilities.
 * Values derived from the Qoder model catalog as of June 2026.
 */
export const QODER_MODEL_CONFIG_MAP = {
  auto: {
    display_name: "Auto",
    is_reasoning: false,
    is_vl: false,
    format: "openai",
    source: "system",
    max_input_tokens: 180000,
  },
  ultimate: {
    display_name: "Ultimate",
    is_reasoning: false,
    is_vl: false,
    format: "openai",
    source: "system",
    max_input_tokens: 180000,
  },
  performance: {
    display_name: "Performance",
    is_reasoning: false,
    is_vl: false,
    format: "openai",
    source: "system",
    max_input_tokens: 180000,
  },
  efficient: {
    display_name: "Efficient",
    is_reasoning: false,
    is_vl: false,
    format: "openai",
    source: "system",
    max_input_tokens: 131072,
  },
  lite: {
    display_name: "Lite",
    is_reasoning: false,
    is_vl: false,
    format: "openai",
    source: "system",
    max_input_tokens: 131072,
  },
  qmodel_latest: {
    display_name: "Qwen 3.7 Max",
    model: "qwen3-max-latest",
    is_reasoning: false,
    is_vl: false,
    format: "openai",
    source: "system",
    max_input_tokens: 180000,
  },
  qmodel: {
    display_name: "Qwen 3.6 Plus",
    model: "qwen3.6-plus",
    is_reasoning: false,
    is_vl: false,
    format: "openai",
    source: "system",
    max_input_tokens: 180000,
  },
  dmodel: {
    display_name: "DeepSeek V4 Pro",
    model: "deepseek-v4-pro",
    is_reasoning: true,
    is_vl: false,
    format: "openai",
    source: "system",
    max_input_tokens: 180000,
  },
  dfmodel: {
    display_name: "DeepSeek V4",
    model: "deepseek-v4",
    is_reasoning: true,
    is_vl: false,
    format: "openai",
    source: "system",
    max_input_tokens: 180000,
  },
  gm51model: {
    display_name: "GLM 5.1",
    model: "glm-5.1",
    is_reasoning: true,
    is_vl: false,
    format: "openai",
    source: "system",
    max_input_tokens: 131072,
  },
  kmodel: {
    display_name: "Kimi K2.6",
    model: "kimi-k2.6",
    is_reasoning: false,
    is_vl: false,
    format: "openai",
    source: "system",
    max_input_tokens: 180000,
  },
  mmodel: {
    display_name: "MiniMax M2.7",
    model: "minimax-m2.7",
    is_reasoning: false,
    is_vl: false,
    format: "openai",
    source: "system",
    max_input_tokens: 180000,
  },
};

// RSA public key for COSY encryption (extracted from Qoder IDE v0.9).
// Matches the CLIProxyAPIPlus branch and live qodercli traffic.
export const QODER_RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;
