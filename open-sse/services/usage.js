/**
 * Usage Fetcher - Get usage data from provider APIs
 */

import { getGitHubUsage } from "./usage/github.js";
import { getGeminiUsage, getAntigravityUsage } from "./usage/google.js";
import { getClaudeUsage } from "./usage/claude.js";
import { getCodexUsage, consumeCodexRateLimitResetCredit } from "./usage/codex.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import * as logger from "../../src/sse/utils/logger.js";
import { exchangeQoderApiToken, isQoderApiSessionValid } from "../../src/lib/qoder/apiSession.js";
import { buildCosyHeaders } from "../../src/lib/qoder/cosy.js";
import {
  getQoderActivityUrl,
  getQoderCosyVersion,
  getQoderRegion,
  QODER_MACHINE_OS_OPTIONS,
  QODER_QUOTA_USAGE_URL,
} from "../../src/lib/qoder/constants.js";

export { consumeCodexRateLimitResetCredit };
import { getKiroUsage } from "./usage/kiro.js";
import { getMiniMaxUsage } from "./usage/minimax.js";
import { getCodeBuddyCnUsage } from "./usage/codebuddy-cn.js";
import {
  getQwenUsage,
  getIflowUsage,
  getOllamaUsage,
  getGlmUsage,
  getVercelAiGatewayUsage,
  getQoderUsage,
} from "./usage/misc.js";

/**
 * Get usage data for a provider connection
 * @param {Object} connection - Provider connection with accessToken
 * @returns {Object} Usage data with quotas
 */
// provider → usage handler (ctx carries every arg each handler needs)
const USAGE_HANDLERS = {
  github: (c) => getGitHubUsage(c.accessToken, c.providerSpecificData, c.proxyOptions),
  "gemini-cli": (c) => getGeminiUsage(c.accessToken, c.providerDataWithProjectId, c.proxyOptions),
  antigravity: (c) => getAntigravityUsage(c.accessToken, c.providerSpecificData, c.proxyOptions),
  claude: (c) => getClaudeUsage(c.accessToken, c.proxyOptions),
  codex: (c) => getCodexUsage(c.accessToken, c.proxyOptions),
  kiro: (c) => getKiroUsage(c.accessToken, c.providerSpecificData, c.proxyOptions),
  qoder: (c) => getQoderUsage(c.accessToken, c.proxyOptions),
  qwen: (c) => getQwenUsage(c.accessToken, c.providerSpecificData),
  iflow: (c) => getIflowUsage(c.accessToken),
  ollama: (c) => getOllamaUsage(c.accessToken),
  glm: (c) => getGlmUsage(c.apiKey, c.provider, c.proxyOptions),
  "glm-cn": (c) => getGlmUsage(c.apiKey, c.provider, c.proxyOptions),
  minimax: (c) => getMiniMaxUsage(c.apiKey, c.provider, c.proxyOptions),
  "minimax-cn": (c) => getMiniMaxUsage(c.apiKey, c.provider, c.proxyOptions),
  "vercel-ai-gateway": (c) => getVercelAiGatewayUsage(c.apiKey, c.proxyOptions),
  "codebuddy-cn": (c) => getCodeBuddyCnUsage(c.accessToken, c.apiKey, c.providerSpecificData, c.proxyOptions),
  "qoder-api": (c) => getQoderApiUsage(c.apiKey, c.providerSpecificData, c.proxyOptions),
};

export async function getUsageForProvider(connection, proxyOptions = null) {
  const { provider, accessToken, apiKey, providerSpecificData, projectId } = connection;
  const providerDataWithProjectId = {
    ...(providerSpecificData || {}),
    ...(projectId ? { projectId } : {}),
  };

  const handler = USAGE_HANDLERS[provider];
  if (!handler) return { message: `Usage API not implemented for ${provider}` };
  return await handler({ provider, accessToken, apiKey, providerSpecificData, providerDataWithProjectId, proxyOptions });

}

async function getQoderApiUsage(apiKey, providerSpecificData, proxyOptions = null) {
  if (!apiKey) {
    return { message: "Qoder API usage unavailable: no API key" };
  }

  let session = providerSpecificData?.qoderApiSession;
  if (!isQoderApiSessionValid(session)) {
    try {
      session = await exchangeQoderApiToken(apiKey, session || {}, proxyOptions);
    } catch (error) {
      logger.error("Qoder API Usage", "Session exchange failed", { error: error.message });
      return { message: "Qoder API authentication failed. Please check your personal access token." };
    }
  }

  if (!session?.userId || !session?.securityOauthToken) {
    logger.warn("Qoder API Usage", "Session missing required fields", {
      hasUserId: !!session?.userId,
      hasToken: !!session?.securityOauthToken,
    });
    return { message: "Qoder API session is incomplete. Please reconnect." };
  }

  const machineOs = QODER_MACHINE_OS_OPTIONS[Math.floor(Math.random() * QODER_MACHINE_OS_OPTIONS.length)];
  const cosyCreds = {
    userId: session.userId,
    authToken: session.securityOauthToken,
    name: session.name || "",
    email: session.email || "",
    machineId: session.machineId || "",
    machineToken: session.machineToken || "",
    machineType: session.machineType || "",
    cosyVersion: getQoderCosyVersion(),
    machineOs,
  };

  const [activityResult, creditsResult] = await Promise.allSettled([
    fetchQoderActivity(cosyCreds, proxyOptions),
    fetchQoderCredits(session.securityOauthToken, proxyOptions),
  ]);

  const quotas = {};

  if (activityResult.status === "fulfilled" && activityResult.value) {
    Object.assign(quotas, activityResult.value);
  }

  if (creditsResult.status === "fulfilled" && creditsResult.value) {
    Object.assign(quotas, creditsResult.value);
  }

  if (Object.keys(quotas).length === 0) {
    const activityErr = activityResult.status === "rejected" ? activityResult.reason?.message : null;
    const creditsErr = creditsResult.status === "rejected" ? creditsResult.reason?.message : null;
    logger.warn("Qoder API Usage", "Both quota endpoints failed", { activityErr, creditsErr });
    return { message: "Qoder API connected. Unable to fetch quota data." };
  }

  return { quotas };
}

async function fetchQoderActivity(cosyCreds, proxyOptions) {
  const activityUrl = getQoderActivityUrl();
  const cosyHeaders = buildCosyHeaders("", activityUrl, cosyCreds);

  logger.debug("QODER API USAGE", `Quota tracker | region=${getQoderRegion()} | url=${activityUrl} | cosyVersion=${getQoderCosyVersion()} | mitmBypass=${Boolean(process.env.MITM_BYPASS_QODER)} | mitmExtraHosts=${process.env.MITM_BYPASS_EXTRA_HOSTS || ""}`);

  const response = await proxyAwareFetch(
    activityUrl,
    {
      method: "GET",
      headers: {
        ...cosyHeaders,
        Accept: "application/json",
        "Accept-Language": "en-US",
      },
    },
    proxyOptions,
  );

  if (!response.ok) {
    logger.warn("Qoder API Usage", `Activity endpoint returned ${response.status}`, { status: response.status });
    throw new Error(`activity endpoint returned ${response.status}`);
  }

  const body = await response.json().catch(() => null);
  if (!body || body.code !== 0 || !Array.isArray(body.data?.activities)) {
    logger.warn("Qoder API Usage", "Activity response was not parseable", { code: body?.code });
    return null;
  }

  const quotas = {};
  for (const activity of body.data.activities) {
    if (activity.type !== "MODEL_FREE_QUOTA") continue;
    if (!activity.eligible) continue;

    const label = activity.modelName || activity.activityId || "Free Quota";
    const resetAt = activity.resetAt
      ? new Date(activity.resetAt).toISOString()
      : null;

    quotas[label] = {
      used: Number(activity.used) || 0,
      total: Number(activity.limit) || 0,
      remaining: Number(activity.remaining) || 0,
      unit: "requests",
      resetAt,
      modelKeys: activity.modelKeys || [],
      activityEndAt: activity.activityEndAt
        ? new Date(activity.activityEndAt).toISOString()
        : null,
    };
  }

  return Object.keys(quotas).length > 0 ? quotas : null;
}

async function fetchQoderCredits(securityOauthToken, proxyOptions) {
  const response = await proxyAwareFetch(
    QODER_QUOTA_USAGE_URL,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${securityOauthToken}`,
        Accept: "application/json",
      },
    },
    proxyOptions,
  );

  if (!response.ok) {
    logger.warn("Qoder API Usage", `Credits endpoint returned ${response.status}`, { status: response.status });
    throw new Error(`credits endpoint returned ${response.status}`);
  }

  const body = await response.json().catch(() => null);
  if (!body) {
    logger.warn("Qoder API Usage", "Credits response was not JSON");
    return null;
  }

  const userQuota = body.userQuota || {};
  const orgQuota = body.orgResourcePackage || {};
  const expiresAtMs = Number.isFinite(Number(body.expiresAt)) && Number(body.expiresAt) > 0
    ? Number(body.expiresAt)
    : null;
  const resetAt = expiresAtMs ? new Date(expiresAtMs).toISOString() : null;

  const quotas = {};

  const userTotal = Number(userQuota.total) || 0;
  if (userTotal > 0) {
    quotas["Credits (Personal)"] = {
      used: Number(userQuota.used) || 0,
      total: userTotal,
      remaining: Number(userQuota.remaining) || 0,
      unit: userQuota.unit || "credits",
      resetAt,
    };
  }

  const orgTotal = Number(orgQuota.total) || 0;
  if (orgTotal > 0) {
    quotas["Credits (Organization)"] = {
      used: Number(orgQuota.used) || 0,
      total: orgTotal,
      remaining: Number(orgQuota.remaining) || 0,
      unit: orgQuota.unit || "credits",
      resetAt,
    };
  }

  return Object.keys(quotas).length > 0 ? quotas : null;
}
