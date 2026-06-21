// open-sse/services/sanitizer.js
import { getSanitizerRulesByProvider } from "@/lib/db/repos/sanitizerRulesRepo.js";
import * as logger from "@/sse/utils/logger.js";

const LOG_TAG = "SANITIZER";

// ── Cache: load once, invalidate on CRUD, reload after CRUD ──
let cache = [];

export async function loadSanitizerCache() {
  try {
    cache = await getSanitizerRulesByProvider("all");
    logger.debug(LOG_TAG, `Sanitizer cache loaded: ${cache.length} rules`);
  } catch (e) {
    logger.error(LOG_TAG, "Failed to load sanitizer cache", { error: e.message });
  }
}

export function invalidateSanitizerCache() {
  // Reload from DB after CRUD operation (fire-and-forget)
  loadSanitizerCache().catch((e) => {
    logger.error(LOG_TAG, "Failed to reload sanitizer cache after invalidation", {
      error: e.message,
    });
  });
}

export function getSanitizerRules() {
  return cache;
}

function applyRules(text, rules) {
  if (!text || typeof text !== "string") return text;
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (rule.type === "regex") {
      const regex = new RegExp(rule.pattern, "gi");
      text = text.replace(regex, rule.replacement || "");
    } else if (rule.type === "exact") {
      text = text.replaceAll(rule.pattern, rule.replacement || "");
    }
  }
  return text;
}

export function applySanitizerFilters(body, provider) {
  if (!body?.messages) return body;
  const rules = cache.filter(
    (r) => r.enabled && (r.provider === "all" || r.provider === provider)
  );
  if (rules.length === 0) return body;

  // Apply to all message content
  for (const message of body.messages) {
    if (typeof message.content === "string") {
      message.content = applyRules(message.content, rules);
    } else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === "text" && block.text) {
          block.text = applyRules(block.text, rules);
        }
        // Handle tool_result nested content
        if (block.type === "tool_result") {
          if (typeof block.content === "string") {
            block.content = applyRules(block.content, rules);
          } else if (Array.isArray(block.content)) {
            for (const sub of block.content) {
              if (sub.type === "text" && sub.text) {
                sub.text = applyRules(sub.text, rules);
              }
            }
          }
        }
      }
    }
  }

  // Apply to tool descriptions
  if (body.tools) {
    for (const tool of body.tools) {
      if (tool.function?.description) {
        tool.function.description = applyRules(tool.function.description, rules);
      }
    }
  }

  return body;
}
