/**
 * CodeBuddy CN API usage handler
 *
 * Scoped to the "codebuddy-cn-api" provider — the custom API-key variant
 * (as distinct from the OAuth-based "codebuddy-cn" provider).
 *
 * Quota lives behind a Tencent billing endpoint (POST, payload wrapped twice
 * under data.Response.Data). It mixes two credit types that must NOT be merged:
 *
 *  - Refill / base ("基础体验包"): a recurring allowance whose cycle resets long
 *    before the resource itself expires (CycleEndTime << DeductionEndTime). The
 *    live numbers live in the *Cycle* fields (e.g. CycleCapacityUsed 6.54 / 500)
 *    and resetAt is the next monthly refresh.
 *  - Bonus ("活动赠送包"): one-shot credits that run a single cycle and then
 *    expire for good (CycleEndTime == DeductionEndTime). Numbers live in the
 *    plain Capacity fields.
 *
 * We surface one quota row per package — a cadence label (Monthly/Weekly/Daily)
 * for refill packs, "Bonus Pack N" for bonus packs (soonest-expiring first).
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { PROVIDERS } from "../../providers/index.js";
import { U, parseResetTime } from "./shared.js";
import * as logger from "@/sse/utils/logger.js";
import { CODEBUDDY_CN_API_BILLING_URL } from "@/lib/codebuddy-cn-api/constants.js";

const LOG_TAG = "CODEBUDDY CN USAGE";
const PROVIDER_ID = "codebuddy-cn-api";

// Prefer the *Precise string fields (exact), fall back to the numeric ones.
function num(precise, plain) {
  const n = Number(precise ?? plain);
  return Number.isFinite(n) ? n : 0;
}

// Label a refill pack by its cycle length (Monthly is the common CodeBuddy case).
function refillCadence(acc) {
  const start = parseResetTime(acc.CycleStartTime);
  const end = parseResetTime(acc.CycleEndTime);
  if (start && end) {
    const days = (new Date(end).getTime() - new Date(start).getTime()) / 86400000;
    if (days <= 1.5) return "Daily";
    if (days <= 10) return "Weekly";
  }
  return "Monthly";
}

export async function getCodebuddyCnApiUsage(credentials, proxyOptions = null) {
  const token = credentials.apiKey || credentials.accessToken;
  if (!token) {
    return { message: "CodeBuddy CN API credential not available." };
  }

  try {
    const billingUrl = U(PROVIDER_ID).url || CODEBUDDY_CN_API_BILLING_URL;
    const providerHeaders = PROVIDERS[PROVIDER_ID]?.headers || {};

    const response = await proxyAwareFetch(billingUrl, {
      method: "POST",
      headers: {
        ...providerHeaders,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: "{}",
    }, proxyOptions);

    if (response.status === 401 || response.status === 403) {
      logger.warn(LOG_TAG, "Credential invalid or expired", { status: response.status });
      return { message: "CodeBuddy CN API credential invalid or expired." };
    }
    if (!response.ok) {
      logger.warn(LOG_TAG, "Quota API error", { status: response.status });
      return { message: `CodeBuddy CN API quota API error (${response.status}).` };
    }

    const json = await response.json();
    if (json?.code !== 0) {
      logger.warn(LOG_TAG, "Quota error response", { code: json?.code, msg: json?.msg });
      return { message: `CodeBuddy CN API quota error: ${json?.msg || "unknown"}` };
    }

    const data = json?.data?.Response?.Data || {};
    const accounts = Array.isArray(data.Accounts) ? data.Accounts : [];
    if (accounts.length === 0) {
      return { message: "CodeBuddy CN API connected. No credit packages found." };
    }

    const cycleEndMs = (acc) => {
      const r = parseResetTime(acc.CycleEndTime);
      return r ? new Date(r).getTime() : Number.POSITIVE_INFINITY;
    };
    // Refill packs roll into a new cycle before the resource expires; bonus packs
    // end exactly at expiry. >2d gap between cycle end and validity end = refill.
    const REFILL_GAP_MS = 2 * 24 * 60 * 60 * 1000;
    const isRefill = (acc) => {
      const ce = cycleEndMs(acc);
      const de = Number(acc.DeductionEndTime);
      return Number.isFinite(ce) && Number.isFinite(de) && de - ce > REFILL_GAP_MS;
    };
    const byExpiry = (a, b) => cycleEndMs(a) - cycleEndMs(b);

    const refills = accounts.filter(isRefill).sort(byExpiry);
    const bonuses = accounts.filter((a) => !isRefill(a)).sort(byExpiry);

    const quotas = {};
    // Refill packs first: cadence-labelled, using the *Cycle* balance and
    // resetting at the next refresh.
    const seenRefill = {};
    refills.forEach((acc) => {
      const base = refillCadence(acc);
      seenRefill[base] = (seenRefill[base] || 0) + 1;
      const name = seenRefill[base] > 1 ? `${base} ${seenRefill[base]}` : base;
      quotas[name] = {
        used: num(acc.CycleCapacityUsedPrecise, acc.CycleCapacityUsed),
        total: num(acc.CycleCapacitySizePrecise, acc.CycleCapacitySize),
        resetAt: parseResetTime(acc.CycleEndTime),
        unlimited: false,
      };
    });
    // Bonus packs: use the lifetime Capacity balance; resetAt is the expiry.
    bonuses.forEach((acc, i) => {
      quotas[`Bonus Pack ${i + 1}`] = {
        used: num(acc.CapacityUsedPrecise, acc.CapacityUsed),
        total: num(acc.CapacitySizePrecise, acc.CapacitySize),
        resetAt: parseResetTime(acc.CycleEndTime),
        unlimited: false,
      };
    });

    logger.debug(LOG_TAG, "Usage fetched", {
      refills: refills.length,
      bonuses: bonuses.length,
    });

    return { plan: "CodeBuddy CN API", quotas };
  } catch (error) {
    logger.warn(LOG_TAG, "Usage fetch failed", { error: error.message });
    return { message: `CodeBuddy CN API error: ${error.message}` };
  }
}
