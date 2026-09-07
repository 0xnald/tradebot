// Phase 6 §8/§10/§14 — performance metrics, selection lift, and
// score/confidence/chase-risk bucket calibration. Every signal carries a
// SINGLE real outcome (computed once under identical entry/exit/fee/
// slippage assumptions, per §6) plus the real Smart Selection decision for
// that signal; cohorts are just filters over that one joined record set —
// RAW_SCOUT_BASELINE is "every eligible signal", TRADE_CANDIDATE/WATCH are
// "only the signals Smart Selection actually put in that bucket". This is
// what makes selection lift an honest counterfactual rather than two
// separately-simulated strategies.

import type {
  BacktestBucketStats,
  BacktestCohort,
  BacktestMetrics,
  BacktestOutcome,
  ChaseRiskClassification,
  HistoricalHorizonLabel,
  SelectionLiftReport,
  SmartSelectionDecision,
} from "../types/domain.js";

export interface BacktestRecord {
  signalId: string;
  decisionTimestamp: string;
  decision: SmartSelectionDecision;
  overallScore: number;
  confidence: number;
  chaseRisk: ChaseRiskClassification;
  outcome: BacktestOutcome;
}

/** Minimum usable-signal count below which a lift comparison is flagged as not statistically convincing. Deliberately conservative and documented, not tuned to make results look good. */
export const DEFAULT_MIN_SAMPLE_FOR_SIGNIFICANCE = 30;

const SCORE_AND_CONFIDENCE_BUCKETS: Array<[number, number, string]> = [
  [0, 19, "0-19"],
  [20, 29, "20-29"],
  [30, 39, "30-39"],
  [40, 49, "40-49"],
  [50, 59, "50-59"],
  [60, 69, "60-69"],
  [70, 79, "70-79"],
  [80, 89, "80-89"],
  [90, 100, "90-100"],
];

const CHASE_RISK_LEVELS: ChaseRiskClassification[] = ["LOW_CHASE_RISK", "MEDIUM_CHASE_RISK", "HIGH_CHASE_RISK", "UNKNOWN"];

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Peak-to-trough decline of the cumulative (additive, non-compounding) return curve, in chronological order — an independent-return-mode drawdown, distinct from the capital-constrained drawdown the portfolio simulator computes. */
function maxDrawdown(returnsInChronologicalOrder: number[]): number | null {
  if (returnsInChronologicalOrder.length === 0) return null;
  let cumulative = 0;
  let peak = 0;
  let worstDrawdown = 0;
  for (const r of returnsInChronologicalOrder) {
    cumulative += r;
    peak = Math.max(peak, cumulative);
    worstDrawdown = Math.min(worstDrawdown, cumulative - peak);
  }
  return worstDrawdown;
}

/** Only accepts a horizon return whose data quality was actually KNOWN — never a PARTIAL/UNAVAILABLE value pretending to be a real outcome. */
export function extractReturnPct(outcome: BacktestOutcome, horizon: HistoricalHorizonLabel | "final"): number | null {
  if (horizon === "final") {
    return outcome.hasValidExit ? outcome.finalReturnPct : null;
  }
  const horizonReturn = outcome.returnsByHorizon.find((r) => r.horizon === horizon);
  if (!horizonReturn || horizonReturn.dataQuality !== "KNOWN") return null;
  return horizonReturn.returnPct;
}

function inCohort(record: BacktestRecord, cohort: BacktestCohort): boolean {
  if (cohort === "RAW_SCOUT_BASELINE") return true;
  return record.decision === cohort;
}

function chronological(records: BacktestRecord[]): BacktestRecord[] {
  return [...records].sort((a, b) => new Date(a.decisionTimestamp).getTime() - new Date(b.decisionTimestamp).getTime());
}

export function computeBacktestMetrics(
  records: BacktestRecord[],
  cohort: BacktestCohort,
  horizon: HistoricalHorizonLabel | "final",
): BacktestMetrics {
  const cohortRecords = chronological(records.filter((r) => inCohort(r, cohort)));
  const returns = cohortRecords
    .map((r) => extractReturnPct(r.outcome, horizon))
    .filter((r): r is number => r !== null);

  const wins = returns.filter((r) => r > 0);
  const losses = returns.filter((r) => r < 0);
  const winRatePct = returns.length ? (wins.length / returns.length) * 100 : null;
  const lossRatePct = returns.length ? (losses.length / returns.length) * 100 : null;
  const averageWinnerPct = mean(wins);
  const averageLoserPct = mean(losses);
  // Classic expectancy formula; mathematically equal to the plain mean
  // return for this binary win/loss/tie classification, kept as a separate
  // field because BacktestMetrics documents them as distinct concepts.
  const expectancyPct =
    returns.length > 0 ? ((winRatePct ?? 0) / 100) * (averageWinnerPct ?? 0) + ((lossRatePct ?? 0) / 100) * (averageLoserPct ?? 0) : null;
  const grossProfit = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : null;

  return {
    cohort,
    horizon,
    totalSignals: cohortRecords.length,
    usableSignals: returns.length,
    winCount: wins.length,
    lossCount: losses.length,
    winRatePct,
    lossRatePct,
    averageReturnPct: mean(returns),
    medianReturnPct: median(returns),
    averageWinnerPct,
    averageLoserPct,
    expectancyPct,
    profitFactor,
    maxDrawdownPct: maxDrawdown(returns),
    cumulativeReturnPct: returns.length ? returns.reduce((a, b) => a + b, 0) : null,
    bestTradePct: returns.length ? Math.max(...returns) : null,
    worstTradePct: returns.length ? Math.min(...returns) : null,
  };
}

export function computeSelectionLift(
  records: BacktestRecord[],
  horizon: HistoricalHorizonLabel | "final",
  minSampleForSignificance = DEFAULT_MIN_SAMPLE_FOR_SIGNIFICANCE,
): SelectionLiftReport {
  const raw = computeBacktestMetrics(records, "RAW_SCOUT_BASELINE", horizon);
  const tradeCandidate = computeBacktestMetrics(records, "TRADE_CANDIDATE", horizon);
  const watch = computeBacktestMetrics(records, "WATCH", horizon);

  const rawUsable = records
    .map((r) => ({ decision: r.decision, returnPct: extractReturnPct(r.outcome, horizon) }))
    .filter((r): r is { decision: SmartSelectionDecision; returnPct: number } => r.returnPct !== null);

  const profitable = rawUsable.filter((r) => r.returnPct > 0);
  const bad = rawUsable.filter((r) => r.returnPct < 0);
  const pctProfitableOpportunitiesFilteredOut = profitable.length
    ? (profitable.filter((r) => r.decision !== "TRADE_CANDIDATE").length / profitable.length) * 100
    : null;
  const pctBadOpportunitiesFilteredOut = bad.length
    ? (bad.filter((r) => r.decision !== "TRADE_CANDIDATE").length / bad.length) * 100
    : null;

  const sampleCount = tradeCandidate.usableSignals;
  const statisticallyConvincing = sampleCount >= minSampleForSignificance && raw.usableSignals >= minSampleForSignificance;
  const statisticalCaveat = statisticallyConvincing
    ? `Sample size (${sampleCount} TRADE_CANDIDATE outcomes) meets the ${minSampleForSignificance}-signal floor used here. Still directional evidence, not a formal significance test.`
    : `Sample size is small (${sampleCount} TRADE_CANDIDATE outcomes out of ${raw.usableSignals} usable raw-baseline outcomes) — treat this lift as directional only, not statistically proven.`;

  return {
    horizon,
    rawBaselineExpectancyPct: raw.expectancyPct,
    tradeCandidateExpectancyPct: tradeCandidate.expectancyPct,
    watchExpectancyPct: watch.expectancyPct,
    expectancyLiftPct:
      raw.expectancyPct !== null && tradeCandidate.expectancyPct !== null ? tradeCandidate.expectancyPct - raw.expectancyPct : null,
    winRateLiftPct: raw.winRatePct !== null && tradeCandidate.winRatePct !== null ? tradeCandidate.winRatePct - raw.winRatePct : null,
    averageReturnLiftPct:
      raw.averageReturnPct !== null && tradeCandidate.averageReturnPct !== null
        ? tradeCandidate.averageReturnPct - raw.averageReturnPct
        : null,
    // Positive = TRADE_CANDIDATE lost money less often than the raw baseline.
    downsideReductionPct:
      raw.lossRatePct !== null && tradeCandidate.lossRatePct !== null ? raw.lossRatePct - tradeCandidate.lossRatePct : null,
    pctProfitableOpportunitiesFilteredOut,
    pctBadOpportunitiesFilteredOut,
    sampleCount,
    statisticallyConvincing,
    statisticalCaveat,
  };
}

function computeBucketStats(
  records: BacktestRecord[],
  horizon: HistoricalHorizonLabel | "final",
  bucketLabel: string,
  bucketRecords: BacktestRecord[],
): BacktestBucketStats {
  const usableReturns = bucketRecords
    .map((r) => extractReturnPct(r.outcome, horizon))
    .filter((r): r is number => r !== null);
  const wins = usableReturns.filter((r) => r > 0);

  return {
    bucketLabel,
    sampleCount: bucketRecords.length,
    averageReturnPct: mean(usableReturns),
    medianReturnPct: median(usableReturns),
    winRatePct: usableReturns.length ? (wins.length / usableReturns.length) * 100 : null,
    expectancyPct: mean(usableReturns),
    averageConfidence: bucketRecords.length ? mean(bucketRecords.map((r) => r.confidence)) : null,
    dataCompletenessPct: bucketRecords.length ? (usableReturns.length / bucketRecords.length) * 100 : 0,
  };
}

export function computeScoreBuckets(records: BacktestRecord[], horizon: HistoricalHorizonLabel | "final"): BacktestBucketStats[] {
  return SCORE_AND_CONFIDENCE_BUCKETS.map(([lo, hi, label]) =>
    computeBucketStats(
      records,
      horizon,
      label,
      records.filter((r) => r.overallScore >= lo && r.overallScore <= hi),
    ),
  );
}

export function computeConfidenceBuckets(records: BacktestRecord[], horizon: HistoricalHorizonLabel | "final"): BacktestBucketStats[] {
  return SCORE_AND_CONFIDENCE_BUCKETS.map(([lo, hi, label]) =>
    computeBucketStats(
      records,
      horizon,
      label,
      records.filter((r) => r.confidence >= lo && r.confidence <= hi),
    ),
  );
}

export function computeChaseRiskBuckets(records: BacktestRecord[], horizon: HistoricalHorizonLabel | "final"): BacktestBucketStats[] {
  return CHASE_RISK_LEVELS.map((level) =>
    computeBucketStats(
      records,
      horizon,
      level,
      records.filter((r) => r.chaseRisk === level),
    ),
  );
}
