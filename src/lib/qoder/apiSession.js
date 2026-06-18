import crypto from "crypto";

import { qoderEncodeBody } from "./encoding.js";
import { QODER_SESSION_TIMEOUT_MS, QODER_USER_AGENT, getQoderRegion, getQoderCosyVersion } from "../../../open-sse/shared/qoder/constants.js";
import { proxyAwareFetch } from "../../../open-sse/utils/proxyFetch.js";
import * as logger from "../../sse/utils/logger.js";

export const QODER_API_JOB_TOKEN_URL = "https://center.qoder.sh/algo/api/v3/user/jobToken?Encode=1";

// Refresh margin: If the session expires within this window (5 minutes),
// treat it as already expired and re-exchange the PAT proactively.
// This prevents mid-request token expiry when the upstream is slow or
// the request takes a long time to process (e.g., large payloads, reasoning).
// Previously 30s which was too tight — a slow network or brief outage
// during the last 30s would cause a failed request instead of a proactive refresh.
const DEFAULT_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const DEFAULT_SESSION_TTL_MS = 60 * 60 * 1000;
const QODER_APPCODE = "cosy";
const QODER_SIGNATURE_SECRET = "d2FyLCB3YXIgbmV2ZXIgY2hhbmdlcw==";
const QODER_EXCHANGE_VERSION = "0.1.43";
const QODER_EXCHANGE_CLIENT_TYPE = "5";
const QODER_EXCHANGE_LOGIN_VERSION = "v2";

function createMachineToken() {
  const source = `${crypto.randomUUID()}${crypto.randomUUID()}`.slice(0, 50);
  return Buffer.from(source, "utf8").toString("base64url");
}

function createMachineType() {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 18);
}

function normalizeMachineOptions(options = {}) {
  return {
    machineId: options.machineId || crypto.randomUUID(),
    machineToken: options.machineToken || createMachineToken(),
    machineType: options.machineType || createMachineType(),
  };
}

function formatQoderDate(date = new Date()) {
  return date.toUTCString();
}

function signQoderExchange(date) {
  return crypto
    .createHash("md5")
    .update(`${QODER_APPCODE}&${QODER_SIGNATURE_SECRET}&${date}`, "utf8")
    .digest("hex");
}

function parseExpiresAt(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now() + DEFAULT_SESSION_TTL_MS;
}

export async function exchangeQoderApiToken(token, options = {}, proxyOptions = null, callerSignal = null) {
  if (!token || typeof token !== "string" || token.trim() === "") {
    throw new Error("Qoder API credential is required");
  }

  const machine = normalizeMachineOptions(options);
  const innerPayload = {
    personalToken: token,
    securityOauthToken: "",
    refreshToken: "",
    needRefresh: false,
    authInfo: {},
  };
  const payload = {
    payload: JSON.stringify(innerPayload),
    encodeVersion: "1",
  };
  const encodedBody = qoderEncodeBody(Buffer.from(JSON.stringify(payload), "utf8"));
  const date = formatQoderDate();

  const timeoutSignal = AbortSignal.timeout(QODER_SESSION_TIMEOUT_MS);
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, timeoutSignal])
    : timeoutSignal;

  logger.debug("QODER API", `Token exchange | region=${getQoderRegion()} | url=${QODER_API_JOB_TOKEN_URL} | cosyVersion=${getQoderCosyVersion()} | mitmBypass=${Boolean(process.env.MITM_BYPASS_QODER)} | mitmExtraHosts=${process.env.MITM_BYPASS_EXTRA_HOSTS || ""}`);

  const response = await proxyAwareFetch(QODER_API_JOB_TOKEN_URL, {
    method: "POST",
    headers: {
      "cosy-machinetoken": machine.machineToken,
      "cosy-machinetype": machine.machineType,
      "login-version": QODER_EXCHANGE_LOGIN_VERSION,
      appcode: QODER_APPCODE,
      accept: "application/json",
      "accept-encoding": "identity",
      "cosy-version": QODER_EXCHANGE_VERSION,
      "cosy-clienttype": QODER_EXCHANGE_CLIENT_TYPE,
      date,
      signature: signQoderExchange(date),
      "content-type": "application/json",
      "Accept-Language": "en-US",
      "cosy-data-policy": "disagree",
      "cosy-machineid": machine.machineId,
      "user-agent": QODER_USER_AGENT,
    },
    body: encodedBody,
    signal,
  }, proxyOptions);

  if (!response.ok) {
    throw new Error(`Qoder API token exchange failed with status ${response.status}`);
  }

  const data = await response.json();
  const userId = data.id || data.userId || "";
  const securityOauthToken = data.securityOauthToken || "";

  if (!userId || !securityOauthToken) {
    throw new Error("Qoder API token exchange returned an incomplete session");
  }

  return {
    userId,
    name: data.name || "",
    userType: data.userType || "",
    securityOauthToken,
    refreshToken: data.refreshToken || "",
    email: data.email || "",
    plan: data.plan || "",
    raw: data,
    expiresAt: parseExpiresAt(data.expireTime || data.expiresAt),
    machineId: machine.machineId,
    machineToken: machine.machineToken,
    machineType: machine.machineType,
    exchangedAt: Date.now(),
  };
}

export function isQoderApiSessionValid(session, refreshMarginMs = DEFAULT_REFRESH_MARGIN_MS) {
  if (!session || typeof session !== "object") return false;
  if (!session.userId || !session.securityOauthToken) return false;
  if (!Number.isFinite(session.expiresAt)) return false;
  return session.expiresAt - Date.now() > refreshMarginMs;
}

export function redactQoderApiSession(session) {
  if (!session || typeof session !== "object") return session;
  return {
    ...session,
    securityOauthToken: session.securityOauthToken ? "[REDACTED]" : session.securityOauthToken,
    refreshToken: session.refreshToken ? "[REDACTED]" : session.refreshToken,
    machineToken: session.machineToken ? "[REDACTED]" : session.machineToken,
  };
}
