// open-sse/services/cmcApiFingerprint.js
import { randomBytes, randomUUID } from "crypto";
import { ADJECTIVES, NOUNS, PROJECT_SLUG_TTL_MS } from "../config/cmcApiConstants.js";

/**
 * Generate a fake machine ID: "m" + 32 hex chars.
 * Format matches real CLI: m3a7f2b1c9e8d4a6f0b2c5e7d1a3f9b4
 */
export function generateMachineId() {
  return "m" + randomBytes(16).toString("hex");
}

/**
 * Generate a realistic project slug: kebab-case, 2-3 words from curated lists.
 * Examples: crimson-ferret-theory, azure-mountain-logic
 */
export function generateProjectSlug() {
  const parts = [
    ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)],
    NOUNS[Math.floor(Math.random() * NOUNS.length)],
  ];
  // 50% chance of a third word for variety
  if (Math.random() > 0.5) {
    parts.push(NOUNS[Math.floor(Math.random() * NOUNS.length)]);
  }
  return parts.join("-");
}

/**
 * Generate a W3C traceparent header value.
 * Format: 00-<32-hex trace-id>-<16-hex span-id>-<2-hex flags>
 * Example: 00-a1b2c3d4e5f6789012345678abcdef01-b8e4e98753a04e6c-01
 */
export function generateTraceparent() {
  const traceId = randomBytes(16).toString("hex");
  const spanId = randomBytes(8).toString("hex");
  return `00-${traceId}-${spanId}-01`;
}

/**
 * Create a new fingerprint for a connection.
 * @returns {{ machineId: string, projectSlug: string, projectSlugUpdatedAt: string, createdAt: string }}
 */
export function createFingerprint() {
  const now = new Date().toISOString();
  return {
    machineId: generateMachineId(),
    projectSlug: generateProjectSlug(),
    projectSlugUpdatedAt: now,
    createdAt: now,
  };
}

/**
 * Check if the project slug should be rotated (older than TTL).
 * @param {{ projectSlugUpdatedAt?: string }} fingerprint
 * @returns {boolean}
 */
export function shouldRotateProjectSlug(fingerprint) {
  if (!fingerprint?.projectSlugUpdatedAt) return true;
  const age = Date.now() - new Date(fingerprint.projectSlugUpdatedAt).getTime();
  return age >= PROJECT_SLUG_TTL_MS;
}

/**
 * Get or create a fingerprint for a connection, based on existing connection data.
 * If existing data has a valid fingerprint, reuse it. Otherwise create new.
 * Rotates project slug if expired.
 *
 * @param {object} existingData - The connection's data object (from providerConnections.data JSON)
 * @returns {{ fingerprint: object, updated: boolean }} - The fingerprint and whether it was created/updated
 */
export function getFingerprint(existingData = {}) {
  const existing = existingData?.cmcApi;

  // No existing fingerprint — create new
  if (!existing?.machineId) {
    const fingerprint = createFingerprint();
    return { fingerprint, updated: true };
  }

  // Existing fingerprint — check if project slug needs rotation
  if (shouldRotateProjectSlug(existing)) {
    const fingerprint = {
      ...existing,
      projectSlug: generateProjectSlug(),
      projectSlugUpdatedAt: new Date().toISOString(),
    };
    return { fingerprint, updated: true };
  }

  // Existing fingerprint is fresh — reuse as-is
  return { fingerprint: existing, updated: false };
}
