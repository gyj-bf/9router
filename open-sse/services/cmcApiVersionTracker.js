// open-sse/services/cmcApiVersionTracker.js
import { debug, warn } from "@/sse/utils/logger.js";
import {
  DEFAULT_CLI_VERSION,
  NPM_REGISTRY_URL,
  VERSION_CACHE_TTL_MS,
  LOG_TAG,
} from "../config/cmcApiConstants.js";

// In-memory cache
let cache = null; // { version: string, fetchedAt: number }

/**
 * Get the latest command-code CLI version from npm registry.
 * Cached for VERSION_CACHE_TTL_MS (default: 2 hours).
 * Falls back to DEFAULT_CLI_VERSION on failure.
 *
 * @returns {Promise<string>} The CLI version string (e.g., "0.40.5")
 */
export async function getCliVersion() {
  // Return cached version if fresh
  if (cache && (Date.now() - cache.fetchedAt) < VERSION_CACHE_TTL_MS) {
    return cache.version;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000); // 5s timeout
    const res = await fetch(NPM_REGISTRY_URL, {
      signal: controller.signal,
      headers: { "Accept": "application/json" },
    });
    clearTimeout(timeout);

    if (!res.ok) {
      warn(LOG_TAG, `npm registry returned ${res.status}, using fallback version`);
      return cache?.version || DEFAULT_CLI_VERSION;
    }

    const data = await res.json();
    const version = data.version;

    if (typeof version === "string" && version.length > 0) {
      cache = { version, fetchedAt: Date.now() };
      debug(LOG_TAG, `Fetched CLI version from npm: ${version}`, { cacheTTLms: VERSION_CACHE_TTL_MS });
      return version;
    }

    warn(LOG_TAG, "npm registry returned invalid version, using fallback");
    return cache?.version || DEFAULT_CLI_VERSION;
  } catch (err) {
    warn(LOG_TAG, `Failed to fetch CLI version: ${err.message}, using fallback`);
    return cache?.version || DEFAULT_CLI_VERSION;
  }
}

/**
 * Get the cached version without triggering a fetch.
 * Returns DEFAULT_CLI_VERSION if cache is empty.
 *
 * @returns {string}
 */
export function getCachedVersion() {
  return cache?.version || DEFAULT_CLI_VERSION;
}

/**
 * Force-clear the cache (for testing).
 */
export function _clearCache() {
  cache = null;
}
