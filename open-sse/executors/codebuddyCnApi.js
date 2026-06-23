// open-sse/executors/codebuddyCnApi.js
import { DefaultExecutor } from "./default.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import {
  buildDefaultHeaders,
  CODEBUDDY_CN_API_CHAT_URL,
  CODEBUDDY_CN_API_MODEL_CONFIG_MAP,
  AGENT_PROMPT_PATTERNS,
  NEUTRAL_SYSTEM_PROMPT,
  AGENT_PROMPT_LENGTH_THRESHOLD,
  DEFAULT_REASONING_EFFORT,
} from "@/lib/codebuddy-cn-api/constants.js";

// ── Schema cache for tool sanitization ──
const schemaCache = new Map();
const SCHEMA_CACHE_MAX = 200;

function resolveJsonSchemaRefs(schema, defs) {
  if (!schema || typeof schema !== "object") return schema;
  if (schema.$ref) {
    const refPath = schema.$ref.replace(/^#\/(\$defs|definitions)\//, "");
    return defs[refPath] ? resolveJsonSchemaRefs(defs[refPath], defs) : schema;
  }
  const result = {};
  for (const [key, val] of Object.entries(schema)) {
    if (["$schema", "$id", "$comment", "$defs", "definitions"].includes(key)) continue;
    result[key] = Array.isArray(val)
      ? val.map(v => resolveJsonSchemaRefs(v, defs))
      : resolveJsonSchemaRefs(val, defs);
  }
  return result;
}

function sanitizeToolSchemas(tools) {
  if (!tools) return tools;
  for (const tool of tools) {
    const fn = tool.function;
    if (!fn?.parameters) continue;
    const cacheKey = JSON.stringify(fn.parameters);
    if (schemaCache.has(cacheKey)) {
      fn.parameters = schemaCache.get(cacheKey);
      continue;
    }
    const defs = fn.parameters.$defs || fn.parameters.definitions || {};
    let cleaned = resolveJsonSchemaRefs(fn.parameters, defs);
    if (!cleaned.type) cleaned.type = "object";
    if (!cleaned.properties) cleaned.properties = {};
    if (schemaCache.size < SCHEMA_CACHE_MAX) {
      schemaCache.set(cacheKey, cleaned);
    }
    fn.parameters = cleaned;
  }
  return tools;
}

function isAgentSystemPrompt(text) {
  if (!text || typeof text !== "string") return false;
  if (text.length > AGENT_PROMPT_LENGTH_THRESHOLD) return true;
  return AGENT_PROMPT_PATTERNS.some(p => p.test(text));
}

function cleanMessages(messages) {
  if (!messages) return messages;
  const cleaned = [];
  for (const msg of messages) {
    const m = { ...msg };

    // Handle system messages with agent prompts
    if (m.role === "system" && isAgentSystemPrompt(m.content)) {
      m.content = NEUTRAL_SYSTEM_PROMPT;
    }

    // Convert Anthropic tool_use blocks to OpenAI tool_calls
    if (m.role === "assistant" && Array.isArray(m.content)) {
      const toolCalls = [];
      const textParts = [];
      for (const block of m.content) {
        if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            type: "function",
            function: { name: block.name, arguments: JSON.stringify(block.input || {}) },
          });
        } else if (block.type === "text") {
          textParts.push(block.text);
        }
      }
      m.content = textParts.join("\n") || null;
      if (toolCalls.length > 0) m.tool_calls = toolCalls;
    }

    // Convert Anthropic tool_result to OpenAI tool role
    if (m.role === "user" && Array.isArray(m.content)) {
      const toolResults = m.content.filter(b => b.type === "tool_result");
      if (toolResults.length > 0) {
        // Emit one message per tool_result
        for (const tr of toolResults) {
          cleaned.push({
            role: "tool",
            tool_call_id: tr.tool_use_id,
            content: typeof tr.content === "string" ? tr.content : JSON.stringify(tr.content),
          });
        }
        // Keep non-tool_result blocks
        const otherBlocks = m.content.filter(b => b.type !== "tool_result");
        if (otherBlocks.length > 0) {
          m.content = otherBlocks.length === 1 && otherBlocks[0].type === "text"
            ? otherBlocks[0].text
            : otherBlocks;
          cleaned.push(m);
        }
        continue;
      }

      // Convert image blocks to OpenAI format
      const hasImages = m.content.some(b => b.type === "image");
      if (hasImages) {
        m.content = m.content.map(b => {
          if (b.type === "image" && b.source?.type === "base64") {
            return {
              type: "image_url",
              image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` },
            };
          }
          if (b.type === "image" && b.source?.type === "url") {
            return { type: "image_url", image_url: { url: b.source.url } };
          }
          return b;
        });
      }

      // Collapse text-only arrays to string
      if (Array.isArray(m.content) && m.content.every(b => b.type === "text")) {
        m.content = m.content.map(b => b.text).join("\n");
      }
    }

    cleaned.push(m);
  }
  return cleaned;
}

function injectReasoning(body) {
  const explicitEffort = body.reasoning_effort
    || body.reasoning?.effort
    || (body.thinking?.type === "enabled" ? DEFAULT_REASONING_EFFORT : null);

  if (explicitEffort === "none" || explicitEffort === "off") {
    delete body.reasoning_effort;
  } else {
    body.reasoning_effort = explicitEffort || DEFAULT_REASONING_EFFORT;
  }

  delete body.reasoning;
  delete body.thinking;
}

function applyMaxTokensDefault(body, model) {
  if (body.max_tokens != null || body.max_completion_tokens != null) return;
  const config = CODEBUDDY_CN_API_MODEL_CONFIG_MAP.get(model);
  if (config?.maxOutput) {
    body.max_tokens = config.maxOutput;
  }
}

export class CodebuddyCnApiExecutor extends DefaultExecutor {
  constructor() {
    super("codebuddy-cn-api");
  }

  buildUrl() {
    return CODEBUDDY_CN_API_CHAT_URL;
  }

  buildHeaders(credentials) {
    const apiKey = credentials.apiKey || credentials.accessToken;
    return buildDefaultHeaders(apiKey);
  }

  transformRequest(model, body, stream, credentials) {
    const transformed = super.transformRequest(model, body, stream, credentials);

    // Force stream
    transformed.stream = true;

    // Clean messages (Anthropic -> OpenAI conversion)
    transformed.messages = cleanMessages(transformed.messages);

    // Sanitize tool schemas
    if (transformed.tools) {
      transformed.tools = sanitizeToolSchemas(transformed.tools);
    }

    // Inject reasoning config
    injectReasoning(transformed);

    // Default temperature for coding
    if (transformed.temperature == null) {
      transformed.temperature = 0.1;
    }

    // Default max_tokens to model's max output
    applyMaxTokensDefault(transformed, model);

    return transformed;
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions }) {
    const url = this.buildUrl(model, stream);
    const headers = this.buildHeaders(credentials);
    const transformed = this.transformRequest(model, body, stream, credentials);

    const response = await proxyAwareFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(transformed),
      signal,
    }, proxyOptions);

    return { response, url, headers, transformedBody: transformed };
  }
}

export default CodebuddyCnApiExecutor;
