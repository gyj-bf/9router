// open-sse/providers/registry/codebuddy-cn-api.js
import { CODEBUDDY_CN_API_MODELS } from "@/lib/codebuddy-cn-api/constants.js";

export default {
  id: "codebuddy-cn-api",
  alias: "cbca",
  uiAlias: "cbca",
  priority: 901,
  category: "apikey",

  display: {
    name: "CodeBuddy CN API",
    icon: "smart_toy",
    color: "#1E6FFF",
    textIcon: "CB",
    website: "https://copilot.tencent.com",
    notice: {
      text: "CodeBuddy China (腾讯云代码助手). Get your API key from the Tencent portal.",
      apiKeyUrl: "https://copilot.tencent.com/profile/keys",
    },
  },

  transport: {
    baseUrl: "https://copilot.tencent.com/v2/chat/completions",
    format: "openai",
    forceStream: true,
    thinkingFormat: "openai",
    authType: "api_key",
    timeoutMs: 120_000,
    stallTimeoutMs: 60_000,
    headers: {
      "X-Product": "SaaS",
      "X-IDE-Type": "CLI",
      "X-IDE-Name": "CLI",
      "X-Domain": "copilot.tencent.com",
      "x-requested-with": "XMLHttpRequest",
      "x-codebuddy-request": "1",
    },
    auth: { header: "Authorization", scheme: "bearer" },
    usage: { url: "https://copilot.tencent.com/v2/billing/meter/get-user-resource" },
  },

  models: CODEBUDDY_CN_API_MODELS,

  features: {
    usage: true,
    usageApikey: true,
    sanitizer: true,
  },
};
