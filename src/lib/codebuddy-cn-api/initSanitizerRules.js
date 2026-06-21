// src/lib/codebuddy-cn-api/initSanitizerRules.js
import { seedDefaultSanitizerRules } from "@/lib/db/repos/sanitizerRulesRepo.js";

const DEFAULT_RULES = [
  // Phase 1: Regex rules (18)
  { id: "remove_billing_headers_regex", type: "regex", pattern: "x-(?:anthropic-)?billing-header:?\\s*[^\\n]*", replacement: "", priority: 1 },
  { id: "remove_cc_entrypoint_any", type: "regex", pattern: "cc_entrypoint=\\w+", replacement: "", priority: 2 },
  { id: "remove_cc_version_any", type: "regex", pattern: "cc_version=[\\w.]+", replacement: "", priority: 3 },
  { id: "remove_cch_hash", type: "regex", pattern: "c?ch=[a-f0-9]+", replacement: "", priority: 4 },
  { id: "remove_claude_code_github", type: "regex", pattern: "https?://github\\.com/anthropics/claude-code[^\\s]*", replacement: "", priority: 5 },
  { id: "remove_claude_code_identity_variations", type: "regex", pattern: "You are Claude Code[^.]*\\.", replacement: "", priority: 6 },
  { id: "remove_anthropic_cli_ref", type: "regex", pattern: "Anthropic'?'s official (?:CLI|tool|agent)[^.]*\\.?", replacement: "", priority: 7 },
  { id: "remove_anxthxropic_ref", type: "regex", pattern: "Anxthxropic'?'s official[^.]*\\.?", replacement: "", priority: 8 },
  { id: "remove_cursor_identity", type: "regex", pattern: "You are (?:a )?(?:powerful )?(?:AI )?(?:assistant|agent) (?:made|built|created) by (?:Cursor|Anysphere)[^.]*\\.?", replacement: "", priority: 9 },
  { id: "remove_windsurf_identity", type: "regex", pattern: "You are (?:Windsurf|Cascade|Codeium)[^.]*\\.?", replacement: "", priority: 10 },
  { id: "remove_cline_identity", type: "regex", pattern: "You are Cline[^.]*\\.?", replacement: "", priority: 11 },
  { id: "remove_ai_coding_agent_pattern", type: "regex", pattern: "(?:autonomous|agentic) (?:AI |coding )?(?:agent|assistant)[^.]*\\.", replacement: "", priority: 12 },
  { id: "remove_mcp_server_ref", type: "regex", pattern: "MCP (?:server|client|protocol)[^.]*\\.?", replacement: "", priority: 13 },
  { id: "remove_powered_by_anthropic", type: "regex", pattern: "powered by (?:Claude|Anthropic|Anxthxropic)[^.]*\\.?", replacement: "", priority: 14 },
  { id: "remove_ohmyopencode_ref", type: "regex", pattern: "OhMyOpenCode[^.]*\\.?", replacement: "", priority: 15 },
  { id: "remove_opencode_ref", type: "regex", pattern: "opencode[^.]*\\.?", replacement: "", priority: 16 },
  { id: "remove_system_prompt_fingerprint", type: "regex", pattern: "(?:system|assistant) (?:prompt|message) (?:by|from) [^.]*\\.?", replacement: "", priority: 17 },
  { id: "remove_claude_sonnet_identity", type: "regex", pattern: "claude[- ]sonnet[- ][^.]*\\.?", replacement: "", priority: 18 },
  // Phase 2: Exact string fallbacks (4)
  { id: "remove_powerful_ai_agent", type: "exact", pattern: "Advanced AI Agent", replacement: "", priority: 19 },
  { id: "remove_claude_code_identity", type: "exact", pattern: "You are Claude Code, Anxthxropic's official CLI for Claude.", replacement: "", priority: 20 },
  { id: "remove_claude_code_mention", type: "exact", pattern: "Claude Code", replacement: "the assistant", priority: 21 },
  { id: "remove_feedback_line", type: "exact", pattern: "If you found this conversation helpful, please leave feedback at https://claude.ai/feedback", replacement: "", priority: 22 },
];

export async function initSanitizerRules() {
  try {
    await seedDefaultSanitizerRules(DEFAULT_RULES);
  } catch (e) {
    // Table may not exist yet on first boot — schema sync runs later
    console.warn("[sanitizer] Failed to seed default rules:", e.message);
  }
}
