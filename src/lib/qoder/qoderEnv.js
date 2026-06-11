import { updateMitmBypassCache } from "../../../open-sse/utils/proxyFetch.js";
import { QODER_DEFAULTS, QODER_REGION_HOSTS } from "./constants.js";

const VALID_REGIONS = new Set(Object.keys(QODER_REGION_HOSTS));
const COSY_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

function normalizeString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function sanitizeRegion(raw) {
  const normalized = raw.toLowerCase();
  return VALID_REGIONS.has(normalized) ? normalized : QODER_DEFAULTS.region;
}

function sanitizeCosyVersion(raw) {
  return COSY_VERSION_PATTERN.test(raw) ? raw : QODER_DEFAULTS.cosyVersion;
}

export function applyQoderSettingsToEnv(
  { qoderApiRegion, qoderCosyVersion, mitmBypassQoder, mitmBypassExtraHosts } = {}
) {
  if (typeof process === "undefined" || !process.env) return;

  const region = sanitizeRegion(normalizeString(qoderApiRegion) || QODER_DEFAULTS.region);
  const cosyVersion = sanitizeCosyVersion(normalizeString(qoderCosyVersion) || QODER_DEFAULTS.cosyVersion);
  const bypassEnabled = Boolean(mitmBypassQoder);
  const extraHosts = normalizeString(mitmBypassExtraHosts);

  process.env.QODER_API_REGION = region;
  process.env.QODER_COSY_VERSION = cosyVersion;

  if (bypassEnabled) {
    process.env.MITM_BYPASS_QODER = "true";
  } else {
    delete process.env.MITM_BYPASS_QODER;
  }

  if (extraHosts) {
    process.env.MITM_BYPASS_EXTRA_HOSTS = extraHosts;
  } else {
    delete process.env.MITM_BYPASS_EXTRA_HOSTS;
  }

  updateMitmBypassCache({
    mitmBypassQoder: bypassEnabled,
    mitmBypassExtraHosts: extraHosts,
  });
}
