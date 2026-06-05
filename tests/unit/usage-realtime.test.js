import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  prefersReducedMotion,
  formatCompactDelta,
  formatSignedDelta,
  calculateEasedProgress,
  interpolateValue,
  shouldTriggerDelta,
  calculateDelta,
  createRequestSequenceGuard,
  createDebounceTimer,
  METRIC_ANIMATION_DURATION_MS,
  DELTA_CLEAR_TIMEOUT_MS,
  HIGHLIGHT_CLEAR_TIMEOUT_MS,
  COMPACT_THOUSAND,
  COMPACT_MILLION,
  COMPACT_THOUSAND_DECIMAL_CUTOFF,
  COMPACT_MILLION_DECIMAL_CUTOFF,
  HIGHLIGHT_SHADOW_ALPHA,
  REALTIME_STATS_REFRESH_DEBOUNCE_MS,
  STATS_REQUEST_SEQUENCE_STEP,
} from "../../src/shared/utils/usageRealtime.js";

describe("usageRealtime utilities", () => {
  describe("prefersReducedMotion", () => {
    beforeEach(() => {
      vi.stubGlobal("window", undefined);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("returns false when window is undefined", () => {
      expect(prefersReducedMotion()).toBe(false);
    });

    it("returns false when matchMedia is not available", () => {
      vi.stubGlobal("window", {});
      expect(prefersReducedMotion()).toBe(false);
    });

    it("returns true when user prefers reduced motion", () => {
      vi.stubGlobal("window", {
        matchMedia: vi.fn().mockReturnValue({ matches: true }),
      });
      expect(prefersReducedMotion()).toBe(true);
    });

    it("returns false when user does not prefer reduced motion", () => {
      vi.stubGlobal("window", {
        matchMedia: vi.fn().mockReturnValue({ matches: false }),
      });
      expect(prefersReducedMotion()).toBe(false);
    });

    it("calls matchMedia with correct query", () => {
      const matchMedia = vi.fn().mockReturnValue({ matches: false });
      vi.stubGlobal("window", { matchMedia });
      
      prefersReducedMotion();
      
      expect(matchMedia).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)");
    });
  });

  describe("formatCompactDelta", () => {
    it("formats zero correctly", () => {
      expect(formatCompactDelta(0)).toBe("0");
    });

    it("formats null as zero", () => {
      expect(formatCompactDelta(null)).toBe("0");
    });

    it("formats undefined as zero", () => {
      expect(formatCompactDelta(undefined)).toBe("0");
    });

    it("formats small numbers without suffix", () => {
      expect(formatCompactDelta(500)).toBe("500");
      expect(formatCompactDelta(999)).toBe("999");
    });

    it("formats thousands with K suffix", () => {
      expect(formatCompactDelta(1000)).toBe("1.0K");
      expect(formatCompactDelta(1500)).toBe("1.5K");
      expect(formatCompactDelta(9999)).toBe("10.0K");
    });

    it("formats large thousands without decimal", () => {
      expect(formatCompactDelta(10000)).toBe("10K");
      expect(formatCompactDelta(99999)).toBe("100K");
    });

    it("formats millions with M suffix", () => {
      expect(formatCompactDelta(1000000)).toBe("1.0M");
      expect(formatCompactDelta(1500000)).toBe("1.5M");
      expect(formatCompactDelta(9999999)).toBe("10.0M");
    });

    it("formats large millions without decimal", () => {
      expect(formatCompactDelta(10000000)).toBe("10M");
      expect(formatCompactDelta(999999999)).toBe("1000M");
    });

    it("handles negative values", () => {
      expect(formatCompactDelta(-500)).toBe("500");
      expect(formatCompactDelta(-1500)).toBe("1.5K");
      expect(formatCompactDelta(-1500000)).toBe("1.5M");
    });

    it("uses correct thresholds", () => {
      expect(formatCompactDelta(COMPACT_THOUSAND - 1)).toBe("999");
      expect(formatCompactDelta(COMPACT_THOUSAND)).toBe("1.0K");
      expect(formatCompactDelta(COMPACT_MILLION - 1)).toBe("1000K");
      expect(formatCompactDelta(COMPACT_MILLION)).toBe("1.0M");
    });

    it("uses correct decimal cutoffs", () => {
      expect(formatCompactDelta(COMPACT_THOUSAND_DECIMAL_CUTOFF - 1)).toBe("10.0K");
      expect(formatCompactDelta(COMPACT_THOUSAND_DECIMAL_CUTOFF)).toBe("10K");
      expect(formatCompactDelta(COMPACT_MILLION_DECIMAL_CUTOFF - 1)).toBe("10.0M");
      expect(formatCompactDelta(COMPACT_MILLION_DECIMAL_CUTOFF)).toBe("10M");
    });
  });

  describe("formatSignedDelta", () => {
    it("returns empty string for zero", () => {
      const formatter = vi.fn((val) => `${val}`);
      expect(formatSignedDelta(0, formatter)).toBe("");
    });

    it("returns empty string for null", () => {
      const formatter = vi.fn((val) => `${val}`);
      expect(formatSignedDelta(null, formatter)).toBe("");
    });

    it("returns empty string for undefined", () => {
      const formatter = vi.fn((val) => `${val}`);
      expect(formatSignedDelta(undefined, formatter)).toBe("");
    });

    it("formats positive values with + sign", () => {
      const formatter = vi.fn((val) => `${val}`);
      const result = formatSignedDelta(100, formatter);

      expect(result).toBe("+100");
      expect(formatter).toHaveBeenCalledWith(100);
    });

    it("formats negative values with − sign", () => {
      const formatter = vi.fn((val) => `${val}`);
      const result = formatSignedDelta(-100, formatter);

      expect(result).toBe("−100");
      expect(formatter).toHaveBeenCalledWith(100);
    });

    it("passes absolute value to formatter", () => {
      const formatter = vi.fn((val) => `${val}`);
      formatSignedDelta(-500, formatter);

      expect(formatter).toHaveBeenCalledWith(500);
    });

    it("works with custom formatter", () => {
      const customFormatter = (val) => `$${val.toFixed(2)}`;

      expect(formatSignedDelta(10.5, customFormatter)).toBe("+$10.50");
      expect(formatSignedDelta(-10.5, customFormatter)).toBe("−$10.50");
    });

    it("handles very small values", () => {
      const formatter = vi.fn((val) => `${val}`);
      expect(formatSignedDelta(0.001, formatter)).toBe("+0.001");
      expect(formatSignedDelta(-0.001, formatter)).toBe("−0.001");
    });
  });

  describe("calculateEasedProgress", () => {
    it("returns 0 at start", () => {
      expect(calculateEasedProgress(0)).toBe(0);
    });

    it("returns 1 at end", () => {
      expect(calculateEasedProgress(1)).toBe(1);
    });

    it("applies ease-out cubic at midpoint", () => {
      const eased = calculateEasedProgress(0.5);
      expect(eased).toBeGreaterThan(0.5);
      expect(eased).toBeLessThan(1);
    });

    it("applies ease-out cubic at 25%", () => {
      const eased = calculateEasedProgress(0.25);
      expect(eased).toBeGreaterThan(0.25);
      expect(eased).toBeLessThan(1);
    });

    it("applies ease-out cubic at 75%", () => {
      const eased = calculateEasedProgress(0.75);
      expect(eased).toBeGreaterThan(0.75);
      expect(eased).toBeLessThan(1);
    });

    it("clamps progress to maximum of 1", () => {
      expect(calculateEasedProgress(1.5)).toBe(1);
      expect(calculateEasedProgress(2)).toBe(1);
      expect(calculateEasedProgress(10)).toBe(1);
    });

    it("handles negative progress", () => {
      const eased = calculateEasedProgress(-0.5);
      expect(eased).toBeLessThan(0);
    });
  });

  describe("interpolateValue", () => {
    it("returns from value at 0% progress", () => {
      expect(interpolateValue(0, 100, 0)).toBe(0);
    });

    it("returns to value at 100% progress", () => {
      expect(interpolateValue(0, 100, 1)).toBe(100);
    });

    it("interpolates correctly at 50% progress", () => {
      expect(interpolateValue(0, 100, 0.5)).toBe(50);
    });

    it("handles negative ranges", () => {
      expect(interpolateValue(100, 0, 0.5)).toBe(50);
    });

    it("handles negative values", () => {
      expect(interpolateValue(-100, 100, 0.5)).toBe(0);
    });

    it("handles same from and to", () => {
      expect(interpolateValue(50, 50, 0.5)).toBe(50);
    });

    it("handles large ranges", () => {
      expect(interpolateValue(0, 1000000, 0.5)).toBe(500000);
    });
  });

  describe("shouldTriggerDelta", () => {
    it("returns false when pulseKey is undefined", () => {
      expect(shouldTriggerDelta(undefined, 100, 150)).toBe(false);
    });

    it("returns false when pulseKey is null", () => {
      expect(shouldTriggerDelta(null, 100, 150)).toBe(false);
    });

    it("returns false when pulseKey is 0", () => {
      expect(shouldTriggerDelta(0, 100, 150)).toBe(false);
    });

    it("returns false when values are equal", () => {
      expect(shouldTriggerDelta(123456, 100, 100)).toBe(false);
    });

    it("returns true when pulseKey present and values differ", () => {
      expect(shouldTriggerDelta(123456, 100, 150)).toBe(true);
    });

    it("returns true for negative delta", () => {
      expect(shouldTriggerDelta(123456, 150, 100)).toBe(true);
    });

    it("handles string pulseKey", () => {
      expect(shouldTriggerDelta("pulse", 100, 150)).toBe(true);
    });
  });

  describe("calculateDelta", () => {
    it("calculates positive delta", () => {
      expect(calculateDelta(100, 150)).toBe(50);
    });

    it("calculates negative delta", () => {
      expect(calculateDelta(150, 100)).toBe(-50);
    });

    it("calculates zero delta", () => {
      expect(calculateDelta(100, 100)).toBe(0);
    });

    it("handles negative values", () => {
      expect(calculateDelta(-100, 50)).toBe(150);
      expect(calculateDelta(50, -100)).toBe(-150);
    });

    it("handles large values", () => {
      expect(calculateDelta(0, 1000000)).toBe(1000000);
    });

    it("handles decimal values", () => {
      expect(calculateDelta(10.5, 20.7)).toBeCloseTo(10.2);
    });
  });

  describe("createRequestSequenceGuard", () => {
    it("starts at sequence 0", () => {
      const guard = createRequestSequenceGuard();
      expect(guard.current()).toBe(0);
    });

    it("increments sequence on next()", () => {
      const guard = createRequestSequenceGuard();
      const id1 = guard.next();
      expect(id1).toBe(STATS_REQUEST_SEQUENCE_STEP);
      expect(guard.current()).toBe(STATS_REQUEST_SEQUENCE_STEP);
    });

    it("increments sequence multiple times", () => {
      const guard = createRequestSequenceGuard();
      const id1 = guard.next();
      const id2 = guard.next();
      const id3 = guard.next();

      expect(id1).toBe(1);
      expect(id2).toBe(2);
      expect(id3).toBe(3);
      expect(guard.current()).toBe(3);
    });

    it("validates current request ID", () => {
      const guard = createRequestSequenceGuard();
      const id1 = guard.next();
      
      expect(guard.isValid(id1)).toBe(true);
    });

    it("invalidates old request IDs", () => {
      const guard = createRequestSequenceGuard();
      const id1 = guard.next();
      const id2 = guard.next();
      
      expect(guard.isValid(id1)).toBe(false);
      expect(guard.isValid(id2)).toBe(true);
    });

    it("invalidates future request IDs", () => {
      const guard = createRequestSequenceGuard();
      const id1 = guard.next();
      
      expect(guard.isValid(id1 + 1)).toBe(false);
    });

    it("invalidates zero when sequence has advanced", () => {
      const guard = createRequestSequenceGuard();
      guard.next();
      
      expect(guard.isValid(0)).toBe(false);
    });
  });

  describe("createDebounceTimer", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("starts inactive", () => {
      const timer = createDebounceTimer();
      expect(timer.isActive()).toBe(false);
    });

    it("becomes active after schedule()", () => {
      const timer = createDebounceTimer();
      const callback = vi.fn();
      
      timer.schedule(callback, 500);
      
      expect(timer.isActive()).toBe(true);
    });

    it("executes callback after delay", () => {
      const timer = createDebounceTimer();
      const callback = vi.fn();
      
      timer.schedule(callback, 500);
      
      expect(callback).not.toHaveBeenCalled();
      
      vi.advanceTimersByTime(500);
      
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it("becomes inactive after callback executes", () => {
      const timer = createDebounceTimer();
      const callback = vi.fn();
      
      timer.schedule(callback, 500);
      vi.advanceTimersByTime(500);
      
      expect(timer.isActive()).toBe(false);
    });

    it("cancels previous schedule when called again", () => {
      const timer = createDebounceTimer();
      const callback1 = vi.fn();
      const callback2 = vi.fn();
      
      timer.schedule(callback1, 500);
      vi.advanceTimersByTime(200);
      timer.schedule(callback2, 500);
      vi.advanceTimersByTime(500);
      
      expect(callback1).not.toHaveBeenCalled();
      expect(callback2).toHaveBeenCalledTimes(1);
    });

    it("clear() cancels pending callback", () => {
      const timer = createDebounceTimer();
      const callback = vi.fn();
      
      timer.schedule(callback, 500);
      vi.advanceTimersByTime(200);
      timer.clear();
      vi.advanceTimersByTime(500);
      
      expect(callback).not.toHaveBeenCalled();
    });

    it("clear() makes timer inactive", () => {
      const timer = createDebounceTimer();
      const callback = vi.fn();
      
      timer.schedule(callback, 500);
      timer.clear();
      
      expect(timer.isActive()).toBe(false);
    });

    it("clear() on inactive timer is safe", () => {
      const timer = createDebounceTimer();
      
      expect(() => timer.clear()).not.toThrow();
      expect(timer.isActive()).toBe(false);
    });

    it("can schedule after clear()", () => {
      const timer = createDebounceTimer();
      const callback1 = vi.fn();
      const callback2 = vi.fn();
      
      timer.schedule(callback1, 500);
      timer.clear();
      timer.schedule(callback2, 500);
      vi.advanceTimersByTime(500);
      
      expect(callback1).not.toHaveBeenCalled();
      expect(callback2).toHaveBeenCalledTimes(1);
    });

    it("uses correct delay", () => {
      const timer = createDebounceTimer();
      const callback = vi.fn();
      
      timer.schedule(callback, REALTIME_STATS_REFRESH_DEBOUNCE_MS);
      
      vi.advanceTimersByTime(REALTIME_STATS_REFRESH_DEBOUNCE_MS - 1);
      expect(callback).not.toHaveBeenCalled();
      
      vi.advanceTimersByTime(1);
      expect(callback).toHaveBeenCalledTimes(1);
    });
  });

  describe("constants", () => {
    it("exports correct animation duration", () => {
      expect(METRIC_ANIMATION_DURATION_MS).toBe(450);
    });

    it("exports correct delta clear timeout", () => {
      expect(DELTA_CLEAR_TIMEOUT_MS).toBe(1800);
    });

    it("exports correct highlight clear timeout", () => {
      expect(HIGHLIGHT_CLEAR_TIMEOUT_MS).toBe(900);
    });

    it("exports correct compact thresholds", () => {
      expect(COMPACT_THOUSAND).toBe(1000);
      expect(COMPACT_MILLION).toBe(1000000);
    });

    it("exports correct compact decimal cutoffs", () => {
      expect(COMPACT_THOUSAND_DECIMAL_CUTOFF).toBe(10000);
      expect(COMPACT_MILLION_DECIMAL_CUTOFF).toBe(10000000);
    });

    it("exports correct highlight shadow alpha", () => {
      expect(HIGHLIGHT_SHADOW_ALPHA).toBe(0.18);
    });

    it("exports correct realtime refresh debounce", () => {
      expect(REALTIME_STATS_REFRESH_DEBOUNCE_MS).toBe(500);
    });

    it("exports correct sequence step", () => {
      expect(STATS_REQUEST_SEQUENCE_STEP).toBe(1);
    });
  });
});
