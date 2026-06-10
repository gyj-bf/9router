import crypto from "crypto";

import {
  getQoderChatUrl,
  QODER_MODEL_MAP,
  QODER_MODEL_CONFIG_MAP,
  QODER_MACHINE_OS_OPTIONS,
  QODER_COSY_VERSION,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_TEMPERATURE,
} from "../../src/lib/qoder/constants.js";
import { qoderEncodeBody } from "../../src/lib/qoder/encoding.js";
import { buildCosyHeaders } from "../../src/lib/qoder/cosy.js";
import { exchangeQoderApiToken, isQoderApiSessionValid } from "../../src/lib/qoder/apiSession.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import * as logger from "../../src/sse/utils/logger.js";

const LOG_TAG = "Qoder API";

function errorResponse(message, type, code, status) {
  return new Response(
    JSON.stringify({ error: { message, type, code } }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

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

/**
 * Detect user's reasoning intent from OpenAI-compatible request parameters.
 * Returns: true (force-enable), false (force-disable), null (use model default).
 */
function detectReasoningFromBody(body) {
  if (body.reasoning_effort && body.reasoning_effort !== "none") return true;
  if (body.reasoning?.effort && body.reasoning.effort !== "none") return true;
  if (body.thinking?.type === "enabled") return true;
  if (body.enable_thinking === true) return true;

  if (body.reasoning_effort === "none") return false;
  if (body.reasoning?.effort === "none") return false;
  if (body.thinking?.type === "disabled") return false;
  if (body.enable_thinking === false) return false;

  return null;
}

/**
 * Inject reasoning_content placeholder on assistant messages for reasoning models.
 * DeepSeek/GLM reasoning models require reasoning_content echoed back in multi-turn;
 * clients in OpenAI format don't send it, so we inject a space to satisfy upstream validation.
 */
function injectReasoningPlaceholders(messages) {
  return messages.map((msg) => {
    if (msg?.role !== "assistant") return msg;
    if (typeof msg.reasoning_content === "string" && msg.reasoning_content.length > 0) return msg;
    return { ...msg, reasoning_content: " " };
  });
}

/**
 * Hoist system messages out of the messages array.
 * Qoder API rejects system messages in the messages array; they must be
 * passed as a top-level "system" field instead.
 */
function hoistSystemMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages: [], systemText: "" };
  }
  const systemParts = [];
  const out = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    if (msg.role === "system") {
      const text = textFromContent(msg.content);
      if (text) systemParts.push(text);
      continue;
    }
    out.push(msg);
  }
  return { messages: out, systemText: systemParts.join("\n\n") };
}

function mapMessage(message) {
  if (!message || typeof message !== "object") {
    return { role: "user", content: "" };
  }
  
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
    if (typeof message.reasoning_content === "string") mapped.reasoning_content = message.reasoning_content;
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
    ...modelConfig,
    display_name: modelConfig.display_name || modelConfig.name || modelKey,
    model: modelConfig.model || "",
    format: modelConfig.format || "openai",
    is_vl: Boolean(modelConfig.is_vl),
    is_reasoning: Boolean(modelConfig.is_reasoning),
    api_key: modelConfig.api_key || "",
    url: modelConfig.url || "",
    source: modelConfig.source || "system",
    max_input_tokens: modelConfig.max_input_tokens || 180000,
    key: modelKey,
  };
}

/**
 * Sanitize tool_choice when reasoning mode is active.
 * Qwen/Qoder reasoning models reject tool_choice: "required" or object format
 * when thinking mode is enabled. Neutralize to "auto" to prevent API errors.
 */
function sanitizeToolChoiceForReasoning(body, isReasoningActive) {
  if (!isReasoningActive) return body;

  const toolChoice = body.tool_choice;
  if (!toolChoice || toolChoice === "auto" || toolChoice === "none") return body;

  const needsSanitize =
    toolChoice === "required" ||
    (typeof toolChoice === "object" && toolChoice !== null);

  if (needsSanitize) {
    logger.warn(LOG_TAG, "Neutralizing tool_choice to 'auto' (reasoning mode active)", {
      original: toolChoice,
    });
    return { ...body, tool_choice: "auto" };
  }

  return body;
}

export function buildQoderApiPayload(body, { modelKey, modelConfig, userId, userType = "personal_standard" }) {
  const allMessages = Array.isArray(body.messages) ? body.messages : [];
  const { messages, systemText } = hoistSystemMessages(allMessages);
  const prompt = latestUserText(messages);
  const imageUrls = extractAllImages(messages);
  const hasImages = imageUrls.length > 0;
  const requestId = crypto.randomUUID();
  const requestSetId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const modelConfigPayload = buildModelConfig(modelKey, modelConfig || {});
  
  if (hasImages) {
    modelConfigPayload.is_vl = true;
    logger.info(LOG_TAG, `Found ${imageUrls.length} image(s) in messages`, {
      urls: imageUrls.map(url => url.substring(0, 64) + (url.length > 64 ? '...' : ''))
    });
  }

  const reasoningOverride = detectReasoningFromBody(body);
  if (reasoningOverride !== null) {
    modelConfigPayload.is_reasoning = reasoningOverride;
  }

  const isReasoningModel = Boolean(modelConfigPayload.is_reasoning);
  body = sanitizeToolChoiceForReasoning(body, isReasoningModel);
  const processedMessages = isReasoningModel ? injectReasoningPlaceholders(messages) : messages;
  
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
    system: systemText,
    model_config: modelConfigPayload,
    business: {
      product: "cli",
      version: "1.0.0",
      type: "agent",
      stage: "start",
      id: requestId,
      name: prompt.length > 100 ? prompt.slice(0, 100) : prompt,
      begin_at: now,
    },
    chat_context: {
      chatPrompt: "",
      imageUrls: hasImages ? imageUrls : null,
      text: { type: "text", text: prompt },
      extra: {
        context: [],
        modelConfig: { key: modelKey, is_reasoning: isReasoningModel },
        originalContent: { type: "text", text: prompt },
      },
      features: [],
    },
    parameters: {
      max_tokens: body.max_tokens || body.max_completion_tokens || DEFAULT_MAX_OUTPUT_TOKENS,
      temperature: body.temperature !== undefined ? body.temperature : DEFAULT_TEMPERATURE,
      ...(body.top_p !== undefined && { top_p: body.top_p }),
      ...(body.presence_penalty !== undefined && { presence_penalty: body.presence_penalty }),
      ...(body.frequency_penalty !== undefined && { frequency_penalty: body.frequency_penalty }),
      ...(body.parallel_tool_calls !== undefined && { parallel_tool_calls: body.parallel_tool_calls }),
      ...(body.response_format !== undefined && { response_format: body.response_format }),
      ...(body.stop !== undefined && { stop: body.stop }),
    },
    messages: processedMessages.map(mapMessage),
  };

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    payload.tools = body.tools;
  }

  if (body.tool_choice !== undefined) {
    payload.tool_choice = body.tool_choice;
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
        logger.error(LOG_TAG, "Upstream error in stream", { statusValue, body: inner });
        const errChunk = JSON.stringify({
          id: `qoder-api-error-${Date.now()}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: { content: `\n[Upstream provider error (code ${statusValue})]` }, finish_reason: "stop" }],
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
    } catch (parseErr) {
      logger.warn(LOG_TAG, "Failed to parse stream frame", { dataLength: data.length, error: parseErr.message });
      const errChunk = JSON.stringify({
        id: `qoder-api-error-${Date.now()}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: { content: "\n[Stream parse error]" }, finish_reason: "stop" }],
      });
      controller.enqueue(encoder.encode(`data: ${errChunk}\n\n`));
      emitDone(controller);
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
    if (!credentials?.apiKey) {
      logger.error(LOG_TAG, "Missing API key in credentials");
      throw new Error("Qoder API key is required");
    }

    const providerSpecificData = credentials?.providerSpecificData || {};
    const cached = providerSpecificData.qoderApiSession;
    
    if (isQoderApiSessionValid(cached) && cached.userId && cached.securityOauthToken) {
      return cached;
    }
    
    try {
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
    } catch (error) {
      logger.error(LOG_TAG, "Failed to exchange API key for session", {
        error: error.message,
      });
      throw error;
    }
  }

  async execute({ model, body, credentials, provider, onCredentialsRefreshed, proxyOptions = null }) {
    const requestId = crypto.randomUUID();
    const chatUrl = getQoderChatUrl();

    let session;
    try {
      session = await this.ensureSession(credentials || {}, onCredentialsRefreshed, proxyOptions);
    } catch (error) {
      logger.error(LOG_TAG, "Session initialization failed", {
        requestId,
        error: error.message,
      });
      return {
        response: errorResponse(
          "Authentication failed. Please check your API key",
          "authentication_error", "auth_failed", 401),
        url: chatUrl,
        headers: {},
        transformedBody: body,
      };
    }

    const modelKey = QoderApiExecutor.normalizeModelKey(model || body?.model);
    const modelConfig = QoderApiExecutor.getModelConfig(modelKey);

    let transformedBody;
    try {
      transformedBody = buildQoderApiPayload(body || {}, {
        modelKey,
        modelConfig,
        userId: session.userId,
        userType: session.userType || "personal_standard",
      });
    } catch (error) {
      logger.error(LOG_TAG, "Failed to build request payload", {
        requestId,
        error: error.message,
      });
      return {
        response: errorResponse("Invalid request format",
          "invalid_request_error", "invalid_request", 400),
        url: chatUrl,
        headers: {},
        transformedBody: body,
      };
    }

    let encodedBodyBuffer;
    try {
      const encodedBody = qoderEncodeBody(Buffer.from(JSON.stringify(transformedBody), "utf8"));
      encodedBodyBuffer = Buffer.from(encodedBody, "latin1");
    } catch (error) {
      logger.error(LOG_TAG, "Failed to encode request body", {
        requestId,
        error: error.message,
      });
      return {
        response: errorResponse("Internal processing error",
          "server_error", "encoding_failed", 500),
        url: chatUrl,
        headers: {},
        transformedBody,
      };
    }

    let cosyHeaders;
    try {
      cosyHeaders = buildCosyHeaders(encodedBodyBuffer, chatUrl, {
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
    } catch (error) {
      logger.error(LOG_TAG, "Failed to build COSY headers", {
        requestId,
        error: error.message,
      });
      return {
        response: errorResponse("Authentication failed",
          "authentication_error", "auth_failed", 401),
        url: chatUrl,
        headers: {},
        transformedBody,
      };
    }

    const headers = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
      "Accept-Encoding": "identity",
      "X-Model-Key": modelKey,
      "X-Model-Source": modelConfig.source || "system",
      ...cosyHeaders,
    };

    let response;
    try {
      response = await proxyAwareFetch(chatUrl, {
        method: "POST",
        headers,
        body: encodedBodyBuffer,
      }, proxyOptions);
    } catch (error) {
      logger.error(LOG_TAG, "Network request failed", {
        requestId,
        error: error.message,
      });
      return {
        response: errorResponse("Upstream service unavailable",
          "server_error", "network_error", 503),
        url: chatUrl,
        headers,
        transformedBody,
      };
    }

    if (!response.ok) {
      let errorBody = "";
      try {
        errorBody = (await response.text()).slice(0, 500);
      } catch {}
      
      logger.error(LOG_TAG, "Upstream error response", {
        requestId,
        status: response.status,
        statusText: response.statusText,
        body: errorBody,
      });
      
      return {
        response: errorResponse(
          `Upstream provider returned ${response.status}`,
          "upstream_error", "upstream_error",
          response.status >= 500 ? 502 : response.status),
        url: chatUrl,
        headers,
        transformedBody,
      };
    }

    logger.info(LOG_TAG, "Chat request successful", {
      requestId,
      modelKey,
      status: response.status,
    });

    return {
      response: wrapQoderApiSSE(response, `${provider || "qoder-api"}/${modelKey}`),
      url: chatUrl,
      headers,
      transformedBody,
    };
  }
}
