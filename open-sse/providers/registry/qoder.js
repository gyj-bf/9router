import { QODER_STALL_TIMEOUT_MS, QODER_REQUEST_TIMEOUT_MS } from "../../shared/qoder/constants.js";

export default {
  id: "qoder",
  priority: 30,
  alias: "qd",
  uiAlias: "qd",
  display: {
    name: "Qoder",
    icon: "water_drop",
    color: "#EC4899",
    website: "https://qoder.com",
    notice: {
      signupUrl: "https://qoder.com",
    },
    deprecated: true,
    deprecationNotice: "RISK_NOTICE",
  },
  category: "free",
  transport: {
    baseUrl: "https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation",
    headers: {},
    timeoutMs: QODER_REQUEST_TIMEOUT_MS,
    stallTimeoutMs: QODER_STALL_TIMEOUT_MS,
    usage: {
      url: "https://openapi.qoder.sh/api/v2/quota/usage",
    },
  },
  models: [
    { id: "auto", name: "Qoder Auto" },
    { id: "ultimate", name: "Qoder Ultimate" },
    { id: "performance", name: "Qoder Performance" },
    { id: "efficient", name: "Qoder Efficient" },
    { id: "lite", name: "Qoder Lite" },
    { id: "qmodel_latest", name: "Qwen3.7-Max (Qoder)" },
    { id: "qmodel", name: "Qwen3.7-Plus (Qoder)" },
    { id: "gm51model", name: "GLM-5.1 (Qoder)" },
    { id: "kmodel", name: "Kimi-K2.7-Code (Qoder)" },
    { id: "dmodel", name: "DeepSeek-V4-Pro (Qoder)" },
    { id: "dfmodel", name: "DeepSeek-V4-Flash (Qoder)" },
    { id: "mmodel", name: "MiniMax-M3 (Qoder)" },
  ],
  oauth: {
    openApiBaseUrl: "https://openapi.qoder.sh",
    centerBaseUrl: "https://center.qoder.sh",
    chatBaseUrl: "https://api3.qoder.sh",
    deviceTokenUrl: "https://openapi.qoder.sh/api/v1/deviceToken/poll",
    refreshUrl: "https://center.qoder.sh/algo/api/v3/user/refresh_token",
    userInfoUrl: "https://openapi.qoder.sh/api/v1/userinfo",
    quotaUsageUrl: "https://openapi.qoder.sh/api/v2/quota/usage",
    loginUrl: "https://qoder.com/device/selectAccounts",
  },
  features: {
    usage: true,
  },
};
