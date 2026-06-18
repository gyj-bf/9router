import { getSettings } from "@/lib/localDb";
import { applyOutboundProxyEnv } from "@/lib/network/outboundProxy";
import * as logger from "@/sse/utils/logger";

const LOG_TAG = "OUTBOUND PROXY";

let initPromise = null;

async function doInit() {
  const settings = await getSettings();
  applyOutboundProxyEnv(settings);
}

export function ensureOutboundProxyInitialized() {
  if (!initPromise) {
    initPromise = doInit().catch((error) => {
      initPromise = null;
      logger.error(LOG_TAG, "Error initializing outbound proxy", { error: error.message });
    });
  }
  return initPromise;
}

setImmediate(() => {
  ensureOutboundProxyInitialized();
});

export default ensureOutboundProxyInitialized;
