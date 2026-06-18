import crypto from "crypto";

import {
  getQoderChatUrl,
  QODER_MODEL_MAP,
  QODER_MODEL_CONFIG_MAP,
  QODER_MACHINE_OS_OPTIONS,
  getQoderCosyVersion,
  QODER_DEFAULT_TEMPERATURE,
  QODER_DEFAULT_REASONING_EFFORT,
  QODER_DEFAULT_MAX_THINKING_TOKENS,
  QODER_BUSINESS_NAME_MAX_LENGTH,
  QODER_MAX_RETRIES,
  QODER_RETRY_BASE_DELAY_MS,
  QODER_RETRY_MAX_DELAY_MS,
  QODER_RETRY_JITTER,
  QODER_RETRYABLE_STATUSES,
  QODER_CONNECT_TIMEOUT_MS,
  QODER_PEEK_TIMEOUT_MS,
  QODER_PEEK_BUFFER_CAP,
  QODER_USER_AGENT,
  QODER_DEFAULT_MAX_INPUT_TOKENS,
} from "../../src/lib/qoder/constants.js";
import { qoderEncodeBody } from "../../src/lib/qoder/encoding.js";
import { buildCosyHeaders } from "../../src/lib/qoder/cosy.js";
import { exchangeQoderApiToken, isQoderApiSessionValid } from "../../src/lib/qoder/apiSession.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import * as logger from "../../src/sse/utils/logger.js";

const LOG_TAG = "QODER API";

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
    max_input_tokens: modelConfig.max_input_tokens || QODER_DEFAULT_MAX_INPUT_TOKENS,
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

export function buildQoderApiPayload(body, { modelKey, modelConfig, userId }) {
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
    aliyun_user_type: "",
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
      version: getQoderCosyVersion(),
      type: "agent",
      stage: "start",
      id: requestId,
      name: prompt.length > QODER_BUSINESS_NAME_MAX_LENGTH ? prompt.slice(0, QODER_BUSINESS_NAME_MAX_LENGTH) : prompt,
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
      max_tokens: body.max_tokens || body.max_completion_tokens || QODER_DEFAULT_MAX_THINKING_TOKENS,
      temperature: body.temperature !== undefined ? body.temperature : QODER_DEFAULT_TEMPERATURE,
      reasoning_effort: body.reasoning_effort ?? QODER_DEFAULT_REASONING_EFFORT,
      max_thinking_tokens: body.max_thinking_tokens ?? QODER_DEFAULT_MAX_THINKING_TOKENS,
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

function parseQueueError(innerBody) {
  if (!innerBody) return null;
  try {
    const outer = JSON.parse(innerBody);
    const message = outer.message || outer.body || "";
    if (typeof message !== "string") return null;
    const parsed = JSON.parse(message);
    const innerMsg = parsed.message || parsed.body || "";
    if (typeof innerMsg === "string") {
      try {
        const queueData = JSON.parse(innerMsg);
        if (queueData.isQueued === true || queueData.serviceAvailable === false) {
          return {
            code: queueData.code || outer.code || parsed.code,
            modelKey: queueData.modelKey,
            queueCount: queueData.queueCount || 0,
            queueType: queueData.queueType || "unknown",
            serviceAvailable: queueData.serviceAvailable,
            waitTime: queueData.waitTime || 0,
          };
        }
      } catch {}
    }
    if (parsed.isQueued === true || parsed.serviceAvailable === false) {
      return {
        code: parsed.code || outer.code,
        modelKey: parsed.modelKey,
        queueCount: parsed.queueCount || 0,
        queueType: parsed.queueType || "unknown",
        serviceAvailable: parsed.serviceAvailable,
        waitTime: parsed.waitTime || 0,
      };
    }
  } catch {}
  return null;
}

function parseModelNotEnabledError(innerBody) {
  if (!innerBody) return null;
  try {
    const parsed = JSON.parse(innerBody);
    const message = (parsed.message || parsed.error?.message || "").toLowerCase();
    const code = (parsed.code || parsed.error?.code || "").toLowerCase();

    const isModelNotEnabled =
      code === "model_not_enabled" ||
      message.includes("not enabled") ||
      message.includes("not available for") ||
      message.includes("upgrade");

    if (!isModelNotEnabled) return null;

    return {
      code: code || "model_not_enabled",
      message: parsed.message || parsed.error?.message || "Model not enabled for this account",
    };
  } catch {}
  return null;
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
        if (statusValue === 403) {
          const modelError = parseModelNotEnabledError(inner);
          if (modelError) {
            logger.error(LOG_TAG, "Model not enabled in stream", { statusValue, body: inner.slice(0, 200) });
            const errChunk = JSON.stringify({
              id: `qoder-api-error-${Date.now()}`,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{ index: 0, delta: { content: `\n[Model not enabled for this account. Try "qmodel_latest" or upgrade at https://qoder.com/pricing]` }, finish_reason: "stop" }],
            });
            controller.enqueue(encoder.encode(`data: ${errChunk}\n\n`));
            emitDone(controller);
            return;
          }
        }
        const queueInfo = parseQueueError(inner);
        if (queueInfo) {
          logger.error(LOG_TAG, "Upstream queue error in stream", {
            statusValue,
            code: queueInfo.code,
            queueCount: queueInfo.queueCount,
            queueType: queueInfo.queueType,
            waitTime: queueInfo.waitTime,
            serviceAvailable: queueInfo.serviceAvailable,
          });
          const waitSec = queueInfo.waitTime || 0;
          const waitStr = waitSec > 0 ? `~${Math.ceil(waitSec / 60)}min` : "unpredictable";
          const errMsg = `Model "${queueInfo.modelKey || model}" is queued (${queueInfo.queueType}, ${queueInfo.queueCount} ahead, ${waitStr} wait). Service temporarily unavailable.`;
          const errChunk = JSON.stringify({
            id: `qoder-api-error-${Date.now()}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: { content: `\n[Queue: ${errMsg}]` }, finish_reason: "stop" }],
          });
          controller.enqueue(encoder.encode(`data: ${errChunk}\n\n`));
        } else {
          logger.error(LOG_TAG, "Upstream error in stream", { statusValue, body: inner });
          const errChunk = JSON.stringify({
            id: `qoder-api-error-${Date.now()}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: { content: `\n[Upstream provider error (code ${statusValue})]` }, finish_reason: "stop" }],
          });
          controller.enqueue(encoder.encode(`data: ${errChunk}\n\n`));
        }
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

async function peekFirstFrame(response, signal) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let peekedBytes = null;
  let firstFrameRaw = null;
  let bufferOverflow = false;

  const emptyStream = () => new ReadableStream({ start(c) { c.close(); } });

  try {
    const peekDeadline = Date.now() + QODER_PEEK_TIMEOUT_MS;

    while (true) {
      if (signal?.aborted) break;

      const remaining = peekDeadline - Date.now();
      if (remaining <= 0) {
        break;
      }

      let timeoutId;
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("peek timeout")), Math.min(remaining, QODER_PEEK_TIMEOUT_MS));
      });

      let chunk;
      try {
        chunk = await Promise.race([reader.read(), timeoutPromise]);
      } catch {
        clearTimeout(timeoutId);
        reader.cancel().catch(() => {});
        break;
      }
      clearTimeout(timeoutId);

      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });

      if (buffer.length > QODER_PEEK_BUFFER_CAP) {
        bufferOverflow = true;
        break;
      }

      const nlIndex = buffer.indexOf("\n");
      if (nlIndex !== -1) {
        firstFrameRaw = buffer.slice(0, nlIndex);
        peekedBytes = new TextEncoder().encode(buffer);
        break;
      }
    }
  } catch (e) {
    reader.cancel().catch(() => {});
    return { isQueueError: false, peekError: e, remainingStream: emptyStream() };
  }

  if (!peekedBytes) {
    reader.cancel().catch(() => {});
    return { isQueueError: false, firstFrameData: null, bufferOverflow, remainingStream: emptyStream() };
  }

  const trimmed = firstFrameRaw.replace(/\r$/, "").trim();
  if (trimmed.startsWith("data:")) {
    const jsonStr = trimmed.slice(5).trimStart();
    if (jsonStr && jsonStr !== "[DONE]") {
      try {
        const envelope = JSON.parse(jsonStr);
        const statusValue = typeof envelope.statusCodeValue === "number" ? envelope.statusCodeValue : 200;
        if (statusValue !== 200) {
          const inner = typeof envelope.body === "string" ? envelope.body : "";

          // Check model-not-enabled first (403 specific)
          if (statusValue === 403) {
            const modelError = parseModelNotEnabledError(inner);
            if (modelError) {
              reader.cancel().catch(() => {});
              return { isModelNotEnabled: true, modelError, peekedBytes: null, remainingStream: null };
            }
          }

          // Then check queue error
          const queueInfo = parseQueueError(inner);
          if (queueInfo) {
            reader.cancel().catch(() => {});
            return { isQueueError: true, queueInfo, peekedBytes: null, remainingStream: null };
          }

          // Other upstream error
          reader.cancel().catch(() => {});
          return { isQueueError: false, upstreamStatus: statusValue, upstreamBody: inner, peekedBytes: null, remainingStream: null };
        }
      } catch {}
    }
  }

  const remainingStream = new ReadableStream({
    start(controller) {
      controller.enqueue(peekedBytes);
      return (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
        } catch (e) {
          controller.error(e);
          return;
        }
        controller.close();
      })();
    },
  });

  return { isQueueError: false, firstFrameData: peekedBytes, remainingStream };
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

  async ensureSession(credentials, onCredentialsRefreshed, proxyOptions = null, signal = null) {
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
      const session = await exchangeQoderApiToken(credentials?.apiKey, cached || {}, proxyOptions, signal);
      
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

  async execute({ model, body, credentials, signal, provider, onCredentialsRefreshed, proxyOptions = null }) {
    const requestId = crypto.randomUUID();
    const chatUrl = getQoderChatUrl();

    let session;
    try {
      session = await this.ensureSession(credentials || {}, onCredentialsRefreshed, proxyOptions, signal);
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

    // Retry transient upstream errors (502, 503, 504) up to 5 times.
    // Backoff: 500ms base, 3s max, 10% jitter. Non-retryable errors (400, 401, 403) return immediately.
    const MAX_RETRIES = QODER_MAX_RETRIES;
    const RETRYABLE_STATUSES = QODER_RETRYABLE_STATUSES;
    let response;
    let lastError = null;
    let transformedBody;
    let headers;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const baseDelay = Math.min(QODER_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1), QODER_RETRY_MAX_DELAY_MS);
        const backoffMs = Math.round(baseDelay * (1 + QODER_RETRY_JITTER * Math.random()));
        logger.info(LOG_TAG, `Retry ${attempt}/${MAX_RETRIES} in ${backoffMs}ms`, {
          requestId,
          modelKey,
          lastStatus: lastError?.status,
        });
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        if (signal?.aborted) {
          logger.warn(LOG_TAG, "Client disconnected before retry", { requestId });
          return {
            response: errorResponse("Request aborted", "client_error", "aborted", 499),
            url: chatUrl,
            headers: headers || {},
            transformedBody: transformedBody || body,
          };
        }
      }

      try {
        transformedBody = buildQoderApiPayload(body || {}, {
          modelKey,
          modelConfig,
          userId: session.userId,
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
          cosyVersion: getQoderCosyVersion(),
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

      headers = {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "Accept-Language": "en-US",
        "Cache-Control": "no-cache",
        "Accept-Encoding": "identity",
        "User-Agent": QODER_USER_AGENT,
        "X-Model-Key": modelKey,
        "X-Model-Source": modelConfig.source || "system",
        ...cosyHeaders,
      };

      // Build abort signal: combine client disconnect + connect timeout
      const connectCtrl = new AbortController();
      const connectTimer = setTimeout(() => connectCtrl.abort(new Error("fetch connect timeout")), QODER_CONNECT_TIMEOUT_MS);
      const mergedSignal = signal
        ? AbortSignal.any([signal, connectCtrl.signal])
        : connectCtrl.signal;

      try {
        response = await proxyAwareFetch(chatUrl, {
          method: "POST",
          headers,
          body: encodedBodyBuffer,
          signal: mergedSignal,
        }, proxyOptions);
      } catch (error) {
        clearTimeout(connectTimer);
        if (signal?.aborted) {
          logger.warn(LOG_TAG, "Request aborted by client", { requestId, error: error.message });
          return {
            response: errorResponse("Request aborted", "client_error", "aborted", 499),
            url: chatUrl,
            headers,
            transformedBody,
          };
        }
        lastError = { status: 503, message: error.message };
        logger.error(LOG_TAG, "Network request failed", {
          requestId,
          attempt,
          error: error.message,
        });
        continue;
      }

      clearTimeout(connectTimer);

      if (!response.ok) {
        // Retryable status — try again
        if (RETRYABLE_STATUSES.has(response.status) && attempt < MAX_RETRIES) {
          lastError = { status: response.status, message: response.statusText };
          logger.warn(LOG_TAG, `Upstream returned ${response.status}, will retry`, {
            requestId,
            attempt,
            status: response.status,
            statusText: response.statusText,
          });
          // Consume the error body before retrying
          try { await response.text(); } catch {}
          continue;
        }

        // Non-retryable error or retries exhausted
        let errorBody = "";
        try {
          errorBody = (await response.text()).slice(0, 500);
        } catch {}

        logger.error(LOG_TAG, "Upstream error response", {
          requestId,
          status: response.status,
          statusText: response.statusText,
          body: errorBody,
          attempts: attempt + 1,
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

      // Success — break out of retry loop
      break;
    }

    // If all retries exhausted without success
    if (!response || !response.ok) {
      const status = lastError?.status || 503;
      logger.error(LOG_TAG, "All retry attempts exhausted", {
        requestId,
        modelKey,
        lastStatus: status,
        attempts: MAX_RETRIES + 1,
      });
      return {
        response: errorResponse(
          `Upstream provider unavailable after ${MAX_RETRIES + 1} attempts (${status})`,
          "upstream_error", "upstream_unavailable", 502),
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

    const peek = await peekFirstFrame(response, signal);

    if (peek.bufferOverflow) {
      logger.warn(LOG_TAG, "Peek buffer exceeded cap, error detection skipped", { requestId });
    }

    if (peek.isModelNotEnabled) {
      const err = peek.modelError;
      logger.error(LOG_TAG, "Model not enabled for this account", {
        requestId,
        modelKey,
        code: err.code,
        upstreamMessage: err.message,
      });
      const upstreamDetail = err.message && err.message !== "Model not enabled for this account"
        ? ` Upstream: ${err.message}`
        : "";
      return {
        response: errorResponse(
          `Model "${modelKey}" is not enabled for this account. Try "qmodel_latest" or upgrade your plan at https://qoder.com/pricing.${upstreamDetail}`,
          "model_not_enabled", "model_not_enabled", 403
        ),
        url: chatUrl,
        headers,
        transformedBody,
      };
    }

    if (peek.isQueueError) {
      const q = peek.queueInfo;
      const waitSec = q.waitTime || 0;
      const waitStr = waitSec > 0 ? `~${Math.ceil(waitSec / 60)}min` : "unpredictable";
      logger.error(LOG_TAG, "Queue error detected in first frame, triggering fallback", {
        requestId,
        modelKey: q.modelKey,
        queueCount: q.queueCount,
        queueType: q.queueType,
        waitTime: waitStr,
      });
      return {
        response: errorResponse(
          `Model "${q.modelKey || modelKey}" queued (${q.queueType}, ${q.queueCount} ahead, ${waitStr} wait). Service unavailable.`,
          "upstream_error", "service_unavailable", 503),
        url: chatUrl,
        headers,
        transformedBody,
      };
    }

    if (peek.upstreamStatus && peek.upstreamStatus !== 200) {
      logger.error(LOG_TAG, "Upstream error in first frame, triggering fallback", {
        requestId,
        statusValue: peek.upstreamStatus,
        body: (peek.upstreamBody || "").slice(0, 200),
      });
      return {
        response: errorResponse(
          `Upstream provider error (code ${peek.upstreamStatus})`,
          "upstream_error", "upstream_error", 502),
        url: chatUrl,
        headers,
        transformedBody,
      };
    }

    if (peek.peekError) {
      logger.error(LOG_TAG, "Peek failed, passing through without error detection", {
        requestId,
        error: peek.peekError.message,
      });
    }

    const reconstructedResponse = new Response(peek.remainingStream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });

    return {
      response: wrapQoderApiSSE(reconstructedResponse, `${provider || "qoder-api"}/${modelKey}`),
      url: chatUrl,
      headers,
      transformedBody,
    };
  }
}
