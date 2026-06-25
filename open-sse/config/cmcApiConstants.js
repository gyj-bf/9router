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

// ── CC API Endpoint ──
export const CC_API_BASE_URL = "https://api.commandcode.ai/alpha/generate";

// ── Fake Config (body enrichment) ──
export const FAKE_GIT_BRANCH = "main";
export const FAKE_GIT_REPO = true;
export const FAKE_WORKING_DIR_PREFIX = "/home/user";

// ── Token Limits ──
export const DEFAULT_MAX_TOKENS_CMCA = 64000;
export const MAX_TOKENS_CAP = 64000;
export const DEFAULT_TEMPERATURE = 0.3;

// ── Default System Prompt ──
export const DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant that helps with software engineering tasks.";

// ── Logging ──
export const LOG_TAG = "CMC API";

// ── Project Slug Word Lists ──
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
