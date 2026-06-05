"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import PropTypes from "prop-types";
import Card from "@/shared/components/Card";
import {
  prefersReducedMotion,
  formatCompactDelta,
  formatSignedDelta,
  calculateEasedProgress,
  interpolateValue,
  shouldTriggerDelta,
  calculateDelta,
  METRIC_ANIMATION_DURATION_MS,
  DELTA_CLEAR_TIMEOUT_MS,
  HIGHLIGHT_CLEAR_TIMEOUT_MS,
  HIGHLIGHT_SHADOW_ALPHA,
} from "@/shared/utils/usageRealtime";

const fmt = (n) => new Intl.NumberFormat().format(n || 0);
const fmtCost = (n) => `$${(n || 0).toFixed(2)}`;

function AnimatedMetricValue({ value, formatter, prefix = "" }) {
  const [displayValue, setDisplayValue] = useState(value || 0);
  const previousValue = useRef(value || 0);

  useEffect(() => {
    const from = previousValue.current;
    const to = value || 0;
    previousValue.current = to;

    if (from === to || prefersReducedMotion()) {
      setDisplayValue(to);
      return undefined;
    }

    const startedAt = performance.now();
    let frameId = 0;

    const tick = (now) => {
      const progress = (now - startedAt) / METRIC_ANIMATION_DURATION_MS;
      const eased = calculateEasedProgress(progress);
      setDisplayValue(interpolateValue(from, to, eased));
      if (progress < 1) frameId = requestAnimationFrame(tick);
    };

    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, [value]);

  return <>{prefix}{formatter(displayValue)}</>;
}

function DeltaBadge({ delta, formatter }) {
  if (!delta) return null;

  return (
    <span className="inline-flex items-center rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-[10px] font-semibold text-success shadow-sm animate-pulse">
      {formatSignedDelta(delta, formatter)}
    </span>
  );
}

function AnimatedMetricCard({ label, value, formatter, deltaFormatter, valueClassName = "", helperText = "", pulseKey, prefix = "" }) {
  const previousValue = useRef(value || 0);
  const [delta, setDelta] = useState(0);
  const [highlighted, setHighlighted] = useState(false);

  useEffect(() => {
    const currentValue = value || 0;
    const previous = previousValue.current;
    previousValue.current = currentValue;

    if (!shouldTriggerDelta(pulseKey, previous, currentValue)) return undefined;

    setDelta(calculateDelta(previous, currentValue));
    setHighlighted(true);

    const clearDelta = setTimeout(() => setDelta(0), DELTA_CLEAR_TIMEOUT_MS);
    const clearHighlight = setTimeout(() => setHighlighted(false), HIGHLIGHT_CLEAR_TIMEOUT_MS);

    return () => {
      clearTimeout(clearDelta);
      clearTimeout(clearHighlight);
    };
  }, [pulseKey, value]);

  const cardClassName = useMemo(() => {
    const base = "flex min-w-0 flex-col gap-1 px-4 py-3 transition-all duration-300";
    if (!highlighted) return base;
    return `${base} border-success/40 shadow-[0_0_18px_rgba(34,197,94,${HIGHLIGHT_SHADOW_ALPHA})]`;
  }, [highlighted]);

  return (
    <Card className={cardClassName}>
      <div className="flex items-start justify-between gap-2">
        <span className="text-text-muted text-sm uppercase font-semibold">{label}</span>
        <DeltaBadge delta={delta} formatter={deltaFormatter} />
      </div>
      <span className={`truncate text-2xl font-bold ${valueClassName}`}>
        <AnimatedMetricValue value={value} formatter={formatter} prefix={prefix} />
      </span>
      {helperText ? <span className="text-[10px] text-text-muted">{helperText}</span> : null}
    </Card>
  );
}

export default function OverviewCards({ stats }) {
  const pulseKey = stats.summaryPulse;

  return (
    <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-4 sm:gap-4">
      <AnimatedMetricCard
        label="Total Requests"
        value={stats.totalRequests}
        formatter={(value) => fmt(Math.round(value))}
        deltaFormatter={(value) => fmt(Math.round(value))}
        pulseKey={pulseKey}
      />
      <AnimatedMetricCard
        label="Total Input Tokens"
        value={stats.totalPromptTokens}
        formatter={(value) => fmt(Math.round(value))}
        deltaFormatter={formatCompactDelta}
        valueClassName="text-primary"
        pulseKey={pulseKey}
      />
      <AnimatedMetricCard
        label="Output Tokens"
        value={stats.totalCompletionTokens}
        formatter={(value) => fmt(Math.round(value))}
        deltaFormatter={formatCompactDelta}
        valueClassName="text-success"
        pulseKey={pulseKey}
      />
      <AnimatedMetricCard
        label="Est. Cost"
        value={stats.totalCost}
        formatter={fmtCost}
        deltaFormatter={fmtCost}
        valueClassName="text-warning"
        helperText="Estimated, not actual billing"
        pulseKey={pulseKey}
        prefix="~"
      />
    </div>
  );
}

AnimatedMetricValue.propTypes = {
  value: PropTypes.number,
  formatter: PropTypes.func.isRequired,
  prefix: PropTypes.string,
};

DeltaBadge.propTypes = {
  delta: PropTypes.number,
  formatter: PropTypes.func.isRequired,
};

AnimatedMetricCard.propTypes = {
  label: PropTypes.string.isRequired,
  value: PropTypes.number,
  formatter: PropTypes.func.isRequired,
  deltaFormatter: PropTypes.func.isRequired,
  valueClassName: PropTypes.string,
  helperText: PropTypes.string,
  pulseKey: PropTypes.number,
  prefix: PropTypes.string,
};

OverviewCards.propTypes = {
  stats: PropTypes.object.isRequired,
};
