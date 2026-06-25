import { randomUUID } from "crypto";
import { debug } from "@/sse/utils/logger.js";
import {
  LOG_TAG,
  SESSION_IDLE_TIMEOUT_MS,
} from "../config/cmcApiConstants.js";

// In-memory session state: Map<connectionId, { sessionId, threadId, state, lastActivity, startPromise }>
const sessions = new Map();

// Idle timeout sweeper
let sweeperInterval = null;
function ensureSweeper() {
  if (sweeperInterval) return;
  sweeperInterval = setInterval(() => {
    const now = Date.now();
    for (const [connId, session] of sessions) {
      if (session.state === "ACTIVE" && (now - session.lastActivity) > SESSION_IDLE_TIMEOUT_MS) {
        debug(LOG_TAG, `Session for ${connId} idle for ${SESSION_IDLE_TIMEOUT_MS / 60000}min, ending`);
        endSession(connId).catch(() => {});
      }
    }
  }, SESSION_IDLE_TIMEOUT_MS / 2); // Check every ~2.5 minutes
  sweeperInterval.unref?.();
}

export async function ensureSessionActive(connectionId, fingerprint, version, apiKey) {
  ensureSweeper();
  const existing = sessions.get(connectionId);
  if (existing?.state === "ACTIVE" || existing?.state === "STARTING") {
    existing.lastActivity = Date.now();
    return;
  }

  // Session lifecycle is tracked in-memory only.
  // The CC API does NOT have a separate lifecycle event endpoint —
  // sending a standalone POST with { event: "session-start" } returns 400.
  // Instead, session identity (sessionId, machineId, projectSlug) is embedded
  // in every generate request via headers + body fields, which is how the
  // real CLI maintains session continuity.
  const sessionId = randomUUID();
  const threadId = randomUUID();

  const session = {
    sessionId,
    threadId,
    state: "ACTIVE",
    lastActivity: Date.now(),
    startPromise: null,
  };
  sessions.set(connectionId, session);
  debug(LOG_TAG, `session activated for ${connectionId} (id=${sessionId.slice(0, 8)}...)`);
}

export function recordActivity(connectionId) {
  const session = sessions.get(connectionId);
  if (session) {
    session.lastActivity = Date.now();
  }
}

export async function endSession(connectionId) {
  const session = sessions.get(connectionId);
  if (!session || session.state === "IDLE") return;

  debug(LOG_TAG, `session ended for ${connectionId} (id=${session.sessionId.slice(0, 8)}...)`);
  sessions.delete(connectionId);
}

export function getSessionState(connectionId) {
  return sessions.get(connectionId)?.state || "IDLE";
}

// For testing
export function _clearSessions() {
  sessions.clear();
}
