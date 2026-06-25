export default {
  id: "commandcode-api",
  priority: 902,
  alias: "cmca",
  aliases: ["commandcode-api"],
  uiAlias: "cmca",
  display: {
    name: "Command Code API",
    icon: "smart_toy",
    color: "#1a1a2e",
    textIcon: "CC",
    website: "https://commandcode.ai",
    notice: {
      text: "Use your CommandCode CLI API key (starts with user_...). This provider includes enhanced anti-detection (fingerprinting, CLI version tracking, session lifecycle) for account safety.",
      apiKeyUrl: "https://commandcode.ai/studio",
    },
  },
  category: "apikey",
  transport: {
    baseUrl: "https://api.commandcode.ai/alpha/generate",
    format: "commandcodeapi",
    forceStream: true,
    // No static headers — executor builds full anti-detection header set dynamically
  },
  models: [
    { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash" },
    { id: "moonshotai/Kimi-K2.6", name: "Kimi K2.6" },
    { id: "moonshotai/Kimi-K2.5", name: "Kimi K2.5" },
    { id: "zai-org/GLM-5.1", name: "GLM 5.1" },
    { id: "zai-org/GLM-5", name: "GLM 5" },
    { id: "MiniMaxAI/MiniMax-M2.7", name: "MiniMax M2.7" },
    { id: "MiniMaxAI/MiniMax-M2.5", name: "MiniMax M2.5" },
    { id: "Qwen/Qwen3.6-Max-Preview", name: "Qwen 3.6 Max Preview" },
    { id: "Qwen/Qwen3.6-Plus", name: "Qwen 3.6 Plus" },
    { id: "stepfun/Step-3.5-Flash", name: "Step 3.5 Flash" },
  ],
  features: {
    usage: true,
  },
};
