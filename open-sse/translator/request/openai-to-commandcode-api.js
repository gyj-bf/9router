/**
 * OpenAI → CommandCode-API (CC-API) request translator
 *
 * Converts an OpenAI chat completion body into the CC-API `/alpha/generate` body schema.
 * Based on openai-to-commandcode.js with key differences:
 *  - Registers as COMMANDCODE_API format (not COMMANDCODE)
 *  - MULTIMODAL: passes image_url / image / file blocks through (no "[image omitted]")
 *  - Default system prompt from cmcApiConstants when none provided
 *  - reasoning_effort, max_tokens capping, temperature, tool_choice, parallel_tool_calls
 *  - Config enrichment with fake project data from cmcApiConstants
 *
 * Upstream `/alpha/generate` schema:
 *  - params.system: STRING at top level (Anthropic-style; system messages NOT allowed in messages[])
 *  - params.messages[*].role ∈ {"user","assistant","tool"}
 *  - params.messages[*].content: Array of content blocks (NEVER a string)
 *  - tool_use blocks (assistant): {type:"tool-call", toolCallId, toolName, input}
 *  - tool_result blocks (role=user): {type:"tool-result", toolCallId, toolName, output}
 *  - tools[*]: Anthropic plain {name, description, input_schema}
 */
import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { randomUUID } from "crypto";
import { ROLE, OPENAI_BLOCK } from "../schema/index.js";
import {
  MAX_TOKENS_CAP,
  DEFAULT_MAX_TOKENS_CMCA,
  DEFAULT_TEMPERATURE,
  DEFAULT_SYSTEM_PROMPT,
  FAKE_GIT_BRANCH,
  FAKE_GIT_REPO,
  FAKE_WORKING_DIR_PREFIX,
} from "../../config/cmcApiConstants.js";

function flattenText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const p of content) {
      if (typeof p === "string") parts.push(p);
      else if (p && typeof p === "object" && typeof p.text === "string") parts.push(p.text);
    }
    return parts.join("\n");
  }
  return String(content);
}

function toContentBlocks(content) {
  if (content == null) return [{ type: OPENAI_BLOCK.TEXT, text: "" }];
  if (typeof content === "string") return [{ type: OPENAI_BLOCK.TEXT, text: content }];
  if (Array.isArray(content)) {
    const blocks = [];
    for (const part of content) {
      if (typeof part === "string") {
        blocks.push({ type: OPENAI_BLOCK.TEXT, text: part });
      } else if (part && typeof part === "object") {
        if (part.type === OPENAI_BLOCK.TEXT && typeof part.text === "string") {
          blocks.push({ type: OPENAI_BLOCK.TEXT, text: part.text });
        } else if (part.type === OPENAI_BLOCK.IMAGE_URL || part.type === OPENAI_BLOCK.IMAGE) {
          // MULTIMODAL: pass image blocks through in CC-API format
          const url = part.image_url?.url || part.url;
          if (url) {
            blocks.push({ type: "image", image: url });
          }
        } else if (part.type === OPENAI_BLOCK.FILE) {
          // MULTIMODAL: pass file blocks through
          blocks.push({ type: "file", file: part.file });
        } else if (typeof part.text === "string") {
          blocks.push({ type: OPENAI_BLOCK.TEXT, text: part.text });
        }
      }
    }
    return blocks.length ? blocks : [{ type: OPENAI_BLOCK.TEXT, text: "" }];
  }
  return [{ type: OPENAI_BLOCK.TEXT, text: String(content) }];
}

function safeParseJson(s) {
  if (s == null) return {};
  if (typeof s !== "string") return s;
  try { return JSON.parse(s); } catch { return {}; }
}

function convertMessages(messages = []) {
  const out = [];
  const systemTexts = [];

  for (const m of messages) {
    if (!m) continue;
    const role = m.role;

    if (role === ROLE.SYSTEM) {
      const t = flattenText(m.content);
      if (t) systemTexts.push(t);
      continue;
    }

    if (role === ROLE.TOOL) {
      const value = typeof m.content === "string" ? m.content : flattenText(m.content);
      out.push({
        role: ROLE.TOOL,
        content: [{
          type: "tool-result",
          toolCallId: m.tool_call_id || "",
          toolName: m.name || "",
          output: { type: "text", value },
        }],
      });
      continue;
    }

    if (role === ROLE.ASSISTANT) {
      const blocks = [];
      const text = flattenText(m.content);
      if (text) blocks.push({ type: OPENAI_BLOCK.TEXT, text });
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          const fn = tc.function || {};
          blocks.push({
            type: "tool-call",
            toolCallId: tc.id || "",
            toolName: fn.name || "",
            input: safeParseJson(fn.arguments),
          });
        }
      }
      out.push({ role: ROLE.ASSISTANT, content: blocks.length ? blocks : [{ type: OPENAI_BLOCK.TEXT, text: "" }] });
      continue;
    }

    out.push({ role: ROLE.USER, content: toContentBlocks(m.content) });
  }

  return { messages: out, system: systemTexts.join("\n\n") };
}

function convertTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const result = [];
  for (const t of tools) {
    if (!t) continue;
    if (t.type === OPENAI_BLOCK.FUNCTION && t.function) {
      result.push({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters || { type: "object" },
      });
    } else if (t.name && (t.input_schema || t.parameters)) {
      result.push({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema || t.parameters,
      });
    }
  }
  return result.length ? result : undefined;
}

export function openaiToCommandCodeApiRequest(model, body, stream /* , credentials */) {
  const { messages, system } = convertMessages(body.messages);
  const params = {
    model,
    messages,
    stream: stream !== false,
    max_tokens: Math.min(body.max_tokens ?? body.max_output_tokens ?? DEFAULT_MAX_TOKENS_CMCA, MAX_TOKENS_CAP),
    temperature: body.temperature ?? DEFAULT_TEMPERATURE,
  };

  // System prompt: use provided system or fall back to default
  params.system = system || DEFAULT_SYSTEM_PROMPT;

  const tools = convertTools(body.tools);
  if (tools) params.tools = tools;
  if (body.top_p != null) params.top_p = body.top_p;

  // reasoning_effort pass-through
  if (body.reasoning_effort) {
    params.reasoning_effort = body.reasoning_effort;
  }

  if (body.tool_choice) {
    const tc = body.tool_choice;
    if (tc === "auto") {
      params.tool_choice = { type: "auto" };
    } else if (tc === "none") {
      params.tool_choice = { type: "none" };
    } else if (tc === "required") {
      params.tool_choice = { type: "any" };
    } else if (typeof tc === "object") {
      const fnName = tc.function?.name || tc.name;
      if (fnName) {
        params.tool_choice = { type: "tool", name: fnName };
      } else if (tc.type === "function" && tc.function?.name) {
        params.tool_choice = { type: "tool", name: tc.function.name };
      } else if (tc.type) {
        params.tool_choice = { type: tc.type === "any" ? "any" : tc.type };
      }
    }
  }

  // parallel_tool_calls pass-through
  if (body.parallel_tool_calls != null) {
    params.parallel_tool_calls = body.parallel_tool_calls;
  }

  const today = new Date().toISOString().slice(0, 10);
  const projectSlug = body._projectSlug || "";

  return {
    threadId: randomUUID(),
    memory: "",
    config: {
      workingDir: `${FAKE_WORKING_DIR_PREFIX}/${projectSlug || "project"}`,
      date: today,
      environment: process.platform,
      structure: [],
      isGitRepo: FAKE_GIT_REPO,
      currentBranch: FAKE_GIT_BRANCH,
      mainBranch: FAKE_GIT_BRANCH,
      gitStatus: "",
      recentCommits: [],
    },
    params,
  };
}

register(FORMATS.OPENAI, FORMATS.COMMANDCODE_API, openaiToCommandCodeApiRequest, null);
