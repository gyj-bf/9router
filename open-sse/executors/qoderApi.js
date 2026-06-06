import crypto from "crypto";

import {
  QODER_CHAT_URL_ENCODED,
  QODER_MODEL_MAP,
  QODER_MODEL_CONFIG_MAP,
  QODER_MACHINE_OS_OPTIONS,
  QODER_COSY_VERSION,
} from "../../src/lib/qoder/constants.js";
import { qoderEncodeBody } from "../../src/lib/qoder/encoding.js";
import { buildCosyHeaders } from "../../src/lib/qoder/cosy.js";
import { exchangeQoderApiToken, isQoderApiSessionValid } from "../../src/lib/qoder/apiSession.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import * as logger from "../../src/sse/utils/logger.js";

// Max output tokens: Set a high default to allow for long code generation and reasoning, can be overridden by request body
// OpenAI max tokens is typically 4096-8192 depending on model, Anthropic models vary but often around 2048-4096
// Setting a high default (32768) to allow for complex coding tasks and reasoning, but can be adjusted per request
const DEFAULT_MAX_OUTPUT_TOKENS = 32768; // High reasoning effort

// Temperature: Controls randomness in output generation (0-2 for OpenAI, 0-1 for Anthropic)
// Lower values (0.0-0.3) make output more deterministic/focused for coding tasks
// Higher values (0.7-1.0) make output more creative/random for generative tasks
// OpenAI default: 1.0, Anthropic default: 1.0
const DEFAULT_TEMPERATURE = 0.1; // Low randomness for coding tasks

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof part.text === "string") return part.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return content == null ? "" : String(content);
}

function extractImagesFromContent(content) {
  if (!Array.isArray(content)) return [];
  const images = [];
  for (const part of content) {
    if (part && part.type === "image_url") {
      // Support both {image_url: {url: "..."}} and {image_url: "..."}
      const url = part.image_url?.url || part.image_url;
      if (url && typeof url === "string" && url.trim()) {
        images.push(url.trim());
      }
    }
  }
  return images;
}

function extractAllImages(messages) {
  const images = [];
  for (const msg of messages) {
    if (msg?.content) {
      images.push(...extractImagesFromContent(msg.content));
    }
  }
  return images;
}

function latestUserText(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return textFromContent(messages[index].content);
  }
  return "";
}

function mapMessage(message) {
  const mapped = { role: message.role };
  
  if (message.role === "user") {
    const text = textFromContent(message.content);
    const images = extractImagesFromContent(message.content);
    
    // content is always string (text only)
    mapped.content = text;
    
    // contents is array with text + images
    const contentsArr = [];
    if (text) {
      contentsArr.push({ type: "text", text });
    }
    for (const imageUrl of images) {
      contentsArr.push({
        type: "image_url",
        image_url: { url: imageUrl }
      });
    }
    mapped.contents = contentsArr;
    
    return mapped;
  }
  
  if (message.role === "assistant") {
    mapped.content = textFromContent(message.content);
    if (Array.isArray(message.tool_calls)) mapped.tool_calls = message.tool_calls;
    return mapped;
  }
  
  if (message.role === "tool") {
    mapped.content = textFromContent(message.content);
    if (message.tool_call_id) mapped.tool_call_id = message.tool_call_id;
    return mapped;
  }
  
  mapped.content = textFromContent(message.content);
  return mapped;
}

function buildModelConfig(modelKey, modelConfig = {}) {
  return {
    display_name: modelConfig.display_name || modelConfig.name || modelKey,
    model: modelConfig.model || "",
    format: modelConfig.format || "openai",
    is_vl: Boolean(modelConfig.is_vl),
    is_reasoning: Boolean(modelConfig.is_reasoning),
    api_key: modelConfig.api_key || "",
    url: modelConfig.url || "",
    source: modelConfig.source || "system",
    max_input_tokens: modelConfig.max_input_tokens || 180000,
    ...modelConfig,
    key: modelKey,
  };
}

export function buildQoderApiPayload(body, { modelKey, modelConfig, userId, userType = "personal_standard" }) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const prompt = latestUserText(messages);
  const imageUrls = extractAllImages(messages);
  const hasImages = imageUrls.length > 0;
  const requestId = crypto.randomUUID();
  const requestSetId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const modelConfigPayload = buildModelConfig(modelKey, modelConfig || {});
  
  if (hasImages) {
    modelConfigPayload.is_vl = true;
    logger.info("Qoder API", `Found ${imageUrls.length} image(s) in messages`, {
      urls: imageUrls.map(url => url.substring(0, 64) + (url.length > 64 ? '...' : ''))
    });
  }
  
  const now = Date.now();

  const payload = {
    request_id: requestId,
    request_set_id: requestSetId,
    chat_record_id: requestId,
    session_id: sessionId,
    stream: true,
    user_id: userId,
    aliyun_user_type: userType || "personal_standard",
    chat_task: "FREE_INPUT",
    image_urls: hasImages ? imageUrls : null,
    is_reply: true,
    is_retry: false,
    code_language: "",
    source: 1,
    version: "3",
    chat_prompt: "",
    session_type: "qodercli",
    agent_id: "agent_common",
    task_id: "common",
    model_config: modelConfigPayload,
    business: {
      product: "cli",
      version: "1.0.0",
      type: "agent",
      stage: "start",
      id: requestId,
      name: prompt.length > 30 ? prompt.slice(0, 30) : prompt,
      begin_at: now,
    },
    chat_context: {
      chatPrompt: "",
      imageUrls: hasImages ? imageUrls : null,
      text: { type: "text", text: prompt },
      extra: {
        context: [],
        modelConfig: { key: modelKey, is_reasoning: Boolean(modelConfigPayload.is_reasoning) },
        originalContent: { type: "text", text: prompt },
      },
      features: [],
    },
    parameters: {
      max_tokens: body.max_tokens || DEFAULT_MAX_OUTPUT_TOKENS,
      temperature: body.temperature !== undefined ? body.temperature : DEFAULT_TEMPERATURE,
    },
    messages: messages.map(mapMessage),
  };

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    payload.tools = body.tools;
  }

  return payload;
}

export function wrapQoderApiSSE(response, model = "qoder-api/lite") {
  if (!response?.ok || !response.body) return response;

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let doneEmitted = false;

  const emitDone = (controller) => {
    if (!doneEmitted) {
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      doneEmitted = true;
    }
  };

  const processLine = (line, controller) => {
    const trimmed = line.replace(/\r$/, "").trim();
    if (!trimmed || !trimmed.startsWith("data:") || doneEmitted) return;

    const data = trimmed.slice(5).trimStart();
    if (!data) return;
    if (data === "[DONE]") {
      emitDone(controller);
      return;
    }

    try {
      const envelope = JSON.parse(data);
      const statusValue = typeof envelope.statusCodeValue === "number" ? envelope.statusCodeValue : 200;
      const inner = typeof envelope.body === "string" ? envelope.body : "";
      if (statusValue !== 200) {
        const errChunk = JSON.stringify({
          id: `qoder-api-error-${Date.now()}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: { content: `\n[Qoder API error ${statusValue}: ${inner || "upstream error"}]` }, finish_reason: "stop" }],
        });
        controller.enqueue(encoder.encode(`data: ${errChunk}\n\n`));
        emitDone(controller);
        return;
      }
      if (!inner) return;
      if (inner === "[DONE]") {
        emitDone(controller);
        return;
      }
      controller.enqueue(encoder.encode(`data: ${inner.replace(/\r?\n/g, "")}\n\n`));
    } catch {
      const errChunk = JSON.stringify({ error: { message: "Invalid Qoder API stream frame", type: "qoder_api_stream_error" } });
      controller.enqueue(encoder.encode(`data: ${errChunk}\n\n`));
    }
  };

  const transform = new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        processLine(line, controller);
      }
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer.length > 0) {
        processLine(buffer, controller);
        buffer = "";
      }
      emitDone(controller);
    },
  });

  return new Response(response.body.pipeThrough(transform), {
    status: response.status,
    statusText: response.statusText,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

export class QoderApiExecutor {
  static normalizeModelKey(model) {
    return String(model || "lite").replace(/^qoder-api\//, "").replace(/^qda\//, "") || "lite";
  }

  static getModelConfig(modelKey) {
    const staticConfig = QODER_MODEL_CONFIG_MAP[modelKey];
    if (staticConfig) return staticConfig;
    const value = QODER_MODEL_MAP[modelKey];
    return typeof value === "object" ? value : { key: modelKey, source: "system" };
  }

  async ensureSession(credentials, onCredentialsRefreshed, proxyOptions = null) {
    const providerSpecificData = credentials?.providerSpecificData || {};
    const cached = providerSpecificData.qoderApiSession;
    if (isQoderApiSessionValid(cached) && cached.userId && cached.securityOauthToken) return cached;

    const session = await exchangeQoderApiToken(credentials?.apiKey, cached || {}, proxyOptions);
    const nextProviderSpecificData = {
      ...providerSpecificData,
      qoderApiSession: session,
    };
    credentials.providerSpecificData = nextProviderSpecificData;
    if (onCredentialsRefreshed) {
      await onCredentialsRefreshed({
        apiKey: credentials.apiKey,
        providerSpecificData: nextProviderSpecificData,
      });
    }
    return session;
  }

  async execute({ model, body, credentials, provider, onCredentialsRefreshed, proxyOptions = null }) {
    const session = await this.ensureSession(credentials || {}, onCredentialsRefreshed, proxyOptions);
    const modelKey = QoderApiExecutor.normalizeModelKey(model || body?.model);
    const modelConfig = QoderApiExecutor.getModelConfig(modelKey);
    const transformedBody = buildQoderApiPayload(body || {}, {
      modelKey,
      modelConfig,
      userId: session.userId,
      userType: session.userType || "personal_standard",
    });

    const encodedBody = qoderEncodeBody(Buffer.from(JSON.stringify(transformedBody), "utf8"));
    const encodedBodyBuffer = Buffer.from(encodedBody, "latin1");
    const cosyHeaders = buildCosyHeaders(encodedBodyBuffer, QODER_CHAT_URL_ENCODED, {
      userId: session.userId,
      authToken: session.securityOauthToken,
      name: session.name || "",
      email: session.email || "",
      machineId: session.machineId || "",
      machineToken: session.machineToken || "",
      machineType: session.machineType || "",
      cosyVersion: QODER_COSY_VERSION,
      machineOs: QODER_MACHINE_OS_OPTIONS[Math.floor(Math.random() * QODER_MACHINE_OS_OPTIONS.length)],
    });

    const headers = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
      "Accept-Encoding": "identity",
      "X-Model-Key": modelKey,
      "X-Model-Source": modelConfig.source || "system",
      ...cosyHeaders,
    };

    const response = await proxyAwareFetch(QODER_CHAT_URL_ENCODED, {
      method: "POST",
      headers,
      body: encodedBodyBuffer,
    }, proxyOptions);

    if (!response.ok) {
      return { response, url: QODER_CHAT_URL_ENCODED, headers, transformedBody };
    }

    return {
      response: wrapQoderApiSSE(response, `${provider || "qoder-api"}/${modelKey}`),
      url: QODER_CHAT_URL_ENCODED,
      headers,
      transformedBody,
    };
  }
}
