// Momentum from a series of timestamped price observations. Every
// interval change is only computed when an observation actually exists
// close enough to that point in time — never fabricated by assuming a
// flat price between samples. If only the current price is known (a
// single observation), every historical field is explicitly null with a
// stated reason, per the Phase 4 brief's "If only current price is
// available, say that historical momentum is unavailable."

import type { MomentumAnalysis } from "../types/domain.js";

export interface PriceObservation {
  observedAt: string;
  priceUsd: number;
}

/** An interval target is only used if a real observation falls within this fraction of the interval around it — documented, not silently approximated. */
const INTERVAL_TOLERANCE_FRACTION = 0.5;

const INTERVALS_MINUTES: { key: keyof Pick<MomentumAnalysis, "changePct1m" | "changePct5m" | "changePct15m" | "changePct30m" | "changePct1h">; minutes: number }[] = [
  { key: "changePct1m", minutes: 1 },
  { key: "changePct5m", minutes: 5 },
  { key: "changePct15m", minutes: 15 },
  { key: "changePct30m", minutes: 30 },
  { key: "changePct1h", minutes: 60 },
];

function findClosestWithinTolerance(
  observations: PriceObservation[],
  targetTimeMs: number,
  toleranceMs: number,
): PriceObservation | null {
  let best: PriceObservation | null = null;
  let bestDiff = Infinity;
  for (const obs of observations) {
    const diff = Math.abs(new Date(obs.observedAt).getTime() - targetTimeMs);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = obs;
    }
  }
  return best && bestDiff <= toleranceMs ? best : null;
}

function stddev(values: number[]): number {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

export class MomentumAnalyzer {
  analyze(
    chainId: number,
    contractAddress: string,
    observations: PriceObservation[],
    now: Date = new Date(),
  ): MomentumAnalysis {
    const observedAt = now.toISOString();
    const base = { chainId, contractAddress, observedAt, observationCount: observations.length };

    if (observations.length === 0) {
      return {
        ...base,
        changePct1m: null,
        changePct5m: null,
        changePct15m: null,
        changePct30m: null,
        changePct1h: null,
        rateOfChangePctPerMinute: null,
        accelerationPctPoints: null,
        drawdownFromRecentHighPct: null,
        distanceFromRecentLowPct: null,
        volatilityPct: null,
        dataQuality: "UNAVAILABLE",
        insufficientDataReason: "no price observations available",
      };
    }

    const sorted = [...observations].sort((a, b) => new Date(a.observedAt).getTime() - new Date(b.observedAt).getTime());
    const current = sorted[sorted.length - 1];
    const currentTimeMs = new Date(current.observedAt).getTime();

    if (sorted.length === 1) {
      return {
        ...base,
        changePct1m: null,
        changePct5m: null,
        changePct15m: null,
        changePct30m: null,
        changePct1h: null,
        rateOfChangePctPerMinute: null,
        accelerationPctPoints: null,
        drawdownFromRecentHighPct: null,
        distanceFromRecentLowPct: null,
        volatilityPct: null,
        dataQuality: "UNAVAILABLE",
        insufficientDataReason: "only one price observation available — historical momentum requires multiple timestamped observations",
      };
    }

    const changes: Partial<Record<string, number | null>> = {};
    const rates: { minutes: number; pct: number }[] = [];

    for (const { key, minutes } of INTERVALS_MINUTES) {
      const targetMs = currentTimeMs - minutes * 60_000;
      const toleranceMs = minutes * 60_000 * INTERVAL_TOLERANCE_FRACTION;
      const reference = findClosestWithinTolerance(sorted, targetMs, toleranceMs);
      if (reference && reference.priceUsd !== 0) {
        const pct = ((current.priceUsd - reference.priceUsd) / reference.priceUsd) * 100;
        changes[key] = pct;
        rates.push({ minutes, pct });
      } else {
        changes[key] = null;
      }
    }

    rates.sort((a, b) => a.minutes - b.minutes);
    const rateOfChangePctPerMinute = rates.length > 0 ? rates[0].pct / rates[0].minutes : null;
    const accelerationPctPoints =
      rates.length >= 2 ? rates[0].pct / rates[0].minutes - rates[1].pct / rates[1].minutes : null;

    const prices = sorted.map((o) => o.priceUsd);
    const maxPrice = Math.max(...prices);
    const minPrice = Math.min(...prices);
    const drawdownFromRecentHighPct = maxPrice > 0 ? ((current.priceUsd - maxPrice) / maxPrice) * 100 : null;
    const distanceFromRecentLowPct = minPrice > 0 ? ((current.priceUsd - minPrice) / minPrice) * 100 : null;

    let volatilityPct: number | null = null;
    if (sorted.length >= 3) {
      const pctChanges: number[] = [];
      for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1].priceUsd;
        if (prev !== 0) pctChanges.push(((sorted[i].priceUsd - prev) / prev) * 100);
      }
      if (pctChanges.length >= 2) volatilityPct = stddev(pctChanges);
    }

    return {
      ...base,
      changePct1m: changes.changePct1m ?? null,
      changePct5m: changes.changePct5m ?? null,
      changePct15m: changes.changePct15m ?? null,
      changePct30m: changes.changePct30m ?? null,
      changePct1h: changes.changePct1h ?? null,
      rateOfChangePctPerMinute,
      accelerationPctPoints,
      drawdownFromRecentHighPct,
      distanceFromRecentLowPct,
      volatilityPct,
      dataQuality: rates.length > 0 ? "KNOWN" : "PARTIAL",
    };
  }
}
