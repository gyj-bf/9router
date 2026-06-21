// src/lib/codebuddy-cn-api/initCodebuddyCnApiSettings.js
import { getSettings } from "@/lib/localDb.js";
import { initSanitizerRules } from "./initSanitizerRules.js";
import { loadSanitizerCache } from "../../../open-sse/services/sanitizer.js";

const LOG_TAG = "CODEBUDDY CN SETTINGS";

let initialized = false;

/**
 * Apply CodeBuddy CN API settings to process.env immediately.
 * Called from the settings PATCH handler when settings change at runtime.
 */
export function applyCodebuddyCnApiSettingsToEnv(settings) {
  if (settings.codebuddyCnApiCliVersion) {
    process.env.CODEBUDDY_CN_API_CLI_VERSION = settings.codebuddyCnApiCliVersion;
  } else {
    delete process.env.CODEBUDDY_CN_API_CLI_VERSION;
  }
}

/**
 * Read settings from DB and apply CLI version override to env.
 * Called once at boot time (deferred via setImmediate).
 */
export async function initCodebuddyCnApiSettings() {
  if (initialized) return;

  try {
    const settings = await getSettings();
    applyCodebuddyCnApiSettingsToEnv(settings);
    initialized = true;
    if (settings.codebuddyCnApiCliVersion) {
      console.log(`[${LOG_TAG}] CLI version override: ${settings.codebuddyCnApiCliVersion}`);
    }
  } catch (e) {
    // DB may not be ready yet on first boot
    console.warn(`[${LOG_TAG}] Failed to init settings:`, e.message);
  }
}

// Defer init so HTTP server accepts connections first (same pattern as initOutboundProxy)
setImmediate(async () => {
  await initCodebuddyCnApiSettings();
  await initSanitizerRules();
  await loadSanitizerCache();
});
