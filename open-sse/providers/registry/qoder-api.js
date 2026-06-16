import { QODER_STALL_TIMEOUT_MS, QODER_REQUEST_TIMEOUT_MS } from "../../shared/qoder/constants.js";

export default {
  id: "qoder-api",
  priority: 31,
  alias: "qda",
  uiAlias: "qda",
  display: {
    name: "Qoder API",
    icon: "water_drop",
    color: "#EC4899",
    textIcon: "QA",
    website: "https://qoder.com",
    notice: {
      text: "This provider uses a Personal Access Token. Account may be restricted or banned. Use at your own risk.",
      apiKeyUrl: "https://qoder.com/account/integrations",
    },
    deprecated: true,
    deprecationNotice: "RISK_NOTICE",
  },
  category: "apikey",
  transport: {
    baseUrl: "https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation",
    format: "openai",
    authType: "api_key",
    headers: {},
    timeoutMs: QODER_REQUEST_TIMEOUT_MS,
    stallTimeoutMs: QODER_STALL_TIMEOUT_MS,
  },
  models: [
    { id: "auto", name: "Auto" },
    { id: "ultimate", name: "Ultimate" },
    { id: "performance", name: "Performance" },
    { id: "efficient", name: "Efficient" },
    { id: "lite", name: "Lite" },
    { id: "qmodel_latest", name: "Qwen3.7-Max" },
    { id: "qmodel", name: "Qwen3.7-Plus" },
    { id: "dmodel", name: "DeepSeek-V4-Pro" },
    { id: "dfmodel", name: "DeepSeek-V4-Flash" },
    { id: "gm51model", name: "GLM-5.1" },
    { id: "kmodel", name: "Kimi-K2.7-Code" },
    { id: "mmodel", name: "MiniMax-M3" },
  ],
  features: {
    usage: true,
    usageApikey: true,
  },
};
