// Small, documented normalization helpers shared by every feature-group
// scorer. Each maps a raw value onto [0,1] via an explicit, stated rule —
// never a hidden formula. See docs/SMART_SELECTION.md for why each band
// was chosen (plausibility, not statistical optimization — see the
// INITIAL HEURISTIC WEIGHTS disclaimer there).

import { clamp01 } from "../shared/math.js";

export { clamp01 };

/** Linear interpolation between two points, clamped to [0,1] outside the range. */
export function linearBand(value: number, fromValue: number, fromScore: number, toValue: number, toScore: number): number {
  if (fromValue === toValue) return fromScore;
  const t = (value - fromValue) / (toValue - fromValue);
  return clamp01(fromScore + clamp01(t) * (toScore - fromScore));
}

/** Step function over ascending value thresholds — `bands` must be sorted by `maxValue` ascending; the last band's `maxValue` is treated as +Infinity. */
export interface Band {
  maxValue: number;
  score: number;
}

export function stepBand(value: number, bands: Band[]): number {
  for (const band of bands) {
    if (value <= band.maxValue) return band.score;
  }
  return bands[bands.length - 1]?.score ?? 0;
}

/**
 * An "inverted U": score rises from 0 up to 1 at `peakCenter`, then falls
 * back down as the value moves further past the peak — used for momentum,
 * where a little positive change is healthy but an extreme pump is chase
 * territory, not "more is better".
 */
export function invertedU(value: number, peakCenter: number, halfWidth: number): number {
  if (halfWidth <= 0) return value === peakCenter ? 1 : 0;
  const distance = Math.abs(value - peakCenter);
  return clamp01(1 - distance / halfWidth);
}

/**
 * Weighted average that ignores null entries entirely (never treats a
 * missing value as 0) — returns null if nothing was available.
 *
 * Also excludes NaN/Infinity/-Infinity values via `Number.isFinite`, not
 * just `!== null` — a non-finite "value" is not a legitimate data point,
 * and letting it through would poison the sum (`NaN * weight = NaN`,
 * `Infinity * weight = Infinity`) for every group that depends on this
 * function. This is the single choke point every feature-group score and
 * the final overallScore pass through, so this is the last line of
 * defense against a malformed upstream input silently turning into a
 * NaN/Infinity SmartSelectionResult (see docs/LIVE_PIPELINE.md's
 * "NaN scoring edge case" finding — root-caused to unguarded date parsing
 * upstream, fixed at the source via `safeAgeSeconds` below, with this
 * filter kept as defense-in-depth).
 */
export function weightedAverage(entries: { value: number | null; weight: number }[]): number | null {
  const usable = entries.filter((e) => e.value !== null && Number.isFinite(e.value) && e.weight > 0);
  if (usable.length === 0) return null;
  const totalWeight = usable.reduce((sum, e) => sum + e.weight, 0);
  if (totalWeight === 0) return null;
  return usable.reduce((sum, e) => sum + e.value! * e.weight, 0) / totalWeight;
}

/**
 * Age in seconds from an ISO timestamp to `now` — or `null` if the
 * timestamp is missing or unparseable. NEVER returns NaN: `new
 * Date(x).getTime()` silently returns NaN for an invalid string, which
 * would otherwise propagate through `linearBand`/`weightedAverage` into
 * the final score/confidence. Callers must treat `null` the same way they
 * already treat "timestamp not provided" (UNAVAILABLE data quality /
 * skip the check that depends on it) — never substitute 0.
 */
export function safeAgeSeconds(observedAt: string | null | undefined, now: Date): number | null {
  if (!observedAt) return null;
  const parsedMs = new Date(observedAt).getTime();
  if (Number.isNaN(parsedMs)) return null;
  return (now.getTime() - parsedMs) / 1000;
}
