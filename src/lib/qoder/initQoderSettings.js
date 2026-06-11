import { getSettings } from "@/lib/localDb";
import { applyQoderSettingsToEnv } from "@/lib/qoder/qoderEnv";
import * as logger from "@/sse/utils/logger";

const LOG_TAG = "Qoder Settings";

let initPromise = null;

async function doInit() {
  const settings = await getSettings();
  applyQoderSettingsToEnv(settings);
}

export function ensureQoderSettingsInitialized() {
  if (!initPromise) {
    initPromise = doInit().catch((error) => {
      initPromise = null;
      logger.error(LOG_TAG, "Error initializing Qoder settings", { error: error.message });
    });
  }
  return initPromise;
}

setImmediate(() => {
  ensureQoderSettingsInitialized();
});

export default ensureQoderSettingsInitialized;
