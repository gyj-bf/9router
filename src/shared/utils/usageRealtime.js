export const METRIC_ANIMATION_DURATION_MS = 450;
export const DELTA_CLEAR_TIMEOUT_MS = 1800;
export const HIGHLIGHT_CLEAR_TIMEOUT_MS = 900;
export const COMPACT_THOUSAND = 1000;
export const COMPACT_MILLION = 1000000;
export const COMPACT_THOUSAND_DECIMAL_CUTOFF = 10000;
export const COMPACT_MILLION_DECIMAL_CUTOFF = 10000000;
export const HIGHLIGHT_SHADOW_ALPHA = 0.18;
export const ANIMATION_MAX_PROGRESS = 1;
export const EASE_OUT_CUBIC_POWER = 3;
export const REALTIME_STATS_REFRESH_DEBOUNCE_MS = 500;
export const STATS_REQUEST_SEQUENCE_STEP = 1;

export function prefersReducedMotion() {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function formatCompactDelta(value) {
  const abs = Math.abs(value || 0);
  if (abs >= COMPACT_MILLION) return `${(abs / COMPACT_MILLION).toFixed(abs >= COMPACT_MILLION_DECIMAL_CUTOFF ? 0 : 1)}M`;
  if (abs >= COMPACT_THOUSAND) return `${(abs / COMPACT_THOUSAND).toFixed(abs >= COMPACT_THOUSAND_DECIMAL_CUTOFF ? 0 : 1)}K`;
  return new Intl.NumberFormat().format(abs);
}

export function formatSignedDelta(value, formatter) {
  if (!value) return "";
  const sign = value > 0 ? "+" : "−";
  return `${sign}${formatter(Math.abs(value))}`;
}

export function calculateEasedProgress(progress) {
  const clamped = Math.min(ANIMATION_MAX_PROGRESS, progress);
  return ANIMATION_MAX_PROGRESS - Math.pow(ANIMATION_MAX_PROGRESS - clamped, EASE_OUT_CUBIC_POWER);
}

export function interpolateValue(from, to, easedProgress) {
  return from + (to - from) * easedProgress;
}

export function shouldTriggerDelta(pulseKey, previousValue, currentValue) {
  return !!(pulseKey && previousValue !== currentValue);
}

export function calculateDelta(previousValue, currentValue) {
  return currentValue - previousValue;
}

export function createRequestSequenceGuard() {
  let currentSeq = 0;

  return {
    next() {
      currentSeq += STATS_REQUEST_SEQUENCE_STEP;
      return currentSeq;
    },
    isValid(requestId) {
      return currentSeq === requestId;
    },
    current() {
      return currentSeq;
    },
  };
}

export function createDebounceTimer() {
  let timerId = null;

  return {
    schedule(callback, delay) {
      if (timerId !== null) {
        clearTimeout(timerId);
      }
      timerId = setTimeout(() => {
        timerId = null;
        callback();
      }, delay);
      return timerId;
    },
    clear() {
      if (timerId !== null) {
        clearTimeout(timerId);
        timerId = null;
      }
    },
    isActive() {
      return timerId !== null;
    },
  };
}
