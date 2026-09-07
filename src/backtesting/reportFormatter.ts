// Phase 6 §17 — human-readable report. Plainly answers the questions the
// spec requires, in the order asked, with no marketing language. If results
// are weak, inconclusive, or data coverage is poor, this says so directly.

import type { BacktestMetrics, BacktestRun, SelectionLiftReport } from "../types/domain.js";

function pct(value: number | null, digits = 1): string {
  return value === null ? "n/a" : `${value.toFixed(digits)}%`;
}

function num(value: number | null, digits = 2): string {
  return value === null ? "n/a" : value.toFixed(digits);
}

function findMetrics(run: BacktestRun, cohort: BacktestMetrics["cohort"], horizon: BacktestMetrics["horizon"]): BacktestMetrics | undefined {
  return run.metricsByCohort.find((m) => m.cohort === cohort && m.horizon === horizon);
}

function findLift(run: BacktestRun, horizon: SelectionLiftReport["horizon"]): SelectionLiftReport | undefined {
  return run.selectionLift.find((l) => l.horizon === horizon);
}

export function formatBacktestReport(run: BacktestRun): string {
  const lines: string[] = [];
  const push = (line = "") => lines.push(line);

  const raw = findMetrics(run, "RAW_SCOUT_BASELINE", "final");
  const tc = findMetrics(run, "TRADE_CANDIDATE", "final");
  const watch = findMetrics(run, "WATCH", "final");
  const lift = findLift(run, "final");

  push(`SCOUT ALPHA — BACKTEST REPORT`);
  push(`Run: ${run.id}  |  ${run.runAt}`);
  push(`Dataset: ${run.datasetId}  |  Config: ${run.config.configVersion}  |  Smart Selection: ${run.config.smartSelectionConfigVersion}`);
  push("=".repeat(72));
  push();

  push(`1) How many calls were evaluated?`);
  push(`   ${run.datasetSize} eligible signal(s) (EARLY_CALL messages with a recovered contract address).`);
  push();

  push(`2) How many were actually reconstructable enough to backtest?`);
  push(`   ${run.dataAvailability.usableSignals}/${run.dataAvailability.datasetSize} had a reconstructed price (not fully UNAVAILABLE).`);
  push(`   ${run.dataAvailability.validEntryCount}/${run.dataAvailability.datasetSize} had a valid simulated entry.`);
  push(`   ${run.dataAvailability.validExitCount}/${run.dataAvailability.datasetSize} had a valid simulated exit/outcome.`);
  push(`   ${run.dataAvailability.completeFeatureReconstructionCount}/${run.dataAvailability.datasetSize} had a FULLY complete Smart Selection feature reconstruction.`);
  push();

  push(`3) Raw Scout baseline vs. TRADE_CANDIDATE outcomes (final mark, ${run.config.horizons.join("/")} horizons also computed):`);
  push(
    `   RAW_SCOUT_BASELINE: n=${raw?.usableSignals ?? 0}, win rate ${pct(raw?.winRatePct ?? null)}, expectancy ${pct(raw?.expectancyPct ?? null)}, avg return ${pct(raw?.averageReturnPct ?? null)}, max drawdown ${pct(raw?.maxDrawdownPct ?? null)}`,
  );
  push(
    `   TRADE_CANDIDATE:    n=${tc?.usableSignals ?? 0}, win rate ${pct(tc?.winRatePct ?? null)}, expectancy ${pct(tc?.expectancyPct ?? null)}, avg return ${pct(tc?.averageReturnPct ?? null)}, max drawdown ${pct(tc?.maxDrawdownPct ?? null)}`,
  );
  push(
    `   WATCH (counterfactual): n=${watch?.usableSignals ?? 0}, win rate ${pct(watch?.winRatePct ?? null)}, expectancy ${pct(watch?.expectancyPct ?? null)}`,
  );
  push();

  push(`4) Did Smart Selection improve expectancy / reduce drawdown vs. taking every call?`);
  if (lift) {
    const direction = lift.expectancyLiftPct === null ? "unknown (insufficient data)" : lift.expectancyLiftPct > 0 ? "IMPROVED" : lift.expectancyLiftPct < 0 ? "WORSENED" : "UNCHANGED";
    push(`   Expectancy lift: ${pct(lift.expectancyLiftPct)} (${direction})`);
    push(`   Win-rate lift: ${pct(lift.winRateLiftPct)}  |  Average-return lift: ${pct(lift.averageReturnLiftPct)}`);
    push(`   Downside reduction (loss-rate delta): ${pct(lift.downsideReductionPct)}`);
  } else {
    push(`   No lift data available.`);
  }
  push();

  push(`5) How many opportunities did Smart Selection filter out, and at what cost?`);
  if (lift) {
    push(`   ${pct(lift.pctProfitableOpportunitiesFilteredOut)} of raw-baseline PROFITABLE signals were filtered out (not TRADE_CANDIDATE) — a real cost.`);
    push(`   ${pct(lift.pctBadOpportunitiesFilteredOut)} of raw-baseline LOSING signals were correctly filtered out.`);
  }
  push();

  push(`6) How much historical data was unavailable, and for what?`);
  for (const note of run.dataAvailability.notes) push(`   - ${note}`);
  const missingEntries = Object.entries(run.dataAvailability.missingByField).sort((a, b) => b[1] - a[1]);
  if (missingEntries.length > 0) {
    push(`   Missing-by-field counts:`);
    for (const [field, count] of missingEntries) push(`     ${field}: ${count}/${run.dataAvailability.datasetSize}`);
  }
  push();

  push(`7) Is this result statistically convincing, or only directional?`);
  push(`   ${lift?.statisticalCaveat ?? "No lift computed."}`);
  push();

  push(`8) Score calibration (final horizon) — a high score with low confidence is expected and NOT a contradiction; see the score/confidence separation in docs/SMART_SELECTION.md:`);
  for (const bucket of run.scoreBuckets) {
    if (bucket.sampleCount === 0) continue;
    push(
      `   score ${bucket.bucketLabel}: n=${bucket.sampleCount}, avg confidence ${num(bucket.averageConfidence, 1)}, avg return ${pct(bucket.averageReturnPct)}, win rate ${pct(bucket.winRatePct)}, completeness ${pct(bucket.dataCompletenessPct, 0)}`,
    );
  }
  push();

  push(`8b) Confidence calibration (final horizon):`);
  for (const bucket of run.confidenceBuckets) {
    if (bucket.sampleCount === 0) continue;
    push(
      `   confidence ${bucket.bucketLabel}: n=${bucket.sampleCount}, avg return ${pct(bucket.averageReturnPct)}, win rate ${pct(bucket.winRatePct)}, completeness ${pct(bucket.dataCompletenessPct, 0)}`,
    );
  }
  push();

  push(`9) Portfolio simulation (fixed % position sizing, capital-constrained):`);
  for (const portfolio of run.portfolioResults) {
    push(
      `   ${portfolio.cohort}: start $${num(portfolio.startingCapitalUsd, 0)} -> end $${num(portfolio.endingCapitalUsd, 2)} (PnL $${num(portfolio.realizedPnlUsd, 2)}), max drawdown ${pct(portfolio.maxDrawdownPct)}, trades taken ${portfolio.tradesTaken}, skipped for capital ${portfolio.tradesSkippedForCapitalConstraint}`,
    );
  }
  push();

  push(`10) Per-signal reconstruction trace (Scout signal -> venue -> observation source -> outcome):`);
  if (run.signals.length === 0) {
    push(`   (no signals in this run)`);
  } else {
    for (const signal of run.signals) {
      const mr = signal.marketResolution;
      const venue = mr?.venueType ?? "UNKNOWN";
      const method = mr?.reconstructionMethod ?? "UNKNOWN";
      const outcome = signal.dataQuality === "UNAVAILABLE" ? (mr?.failureReason ?? "UNAVAILABLE") : `price via ${method}`;
      const graduation = mr?.graduationPhase ? ` [${mr.graduationPhase}${mr.usedPreGraduationVenue === true ? ", pre-graduation" : mr.usedPreGraduationVenue === false ? ", post-graduation" : ""}]` : "";
      push(`   ${signal.tokenSymbol ?? signal.signalId} (${signal.contractAddress ?? "no contract"}): venue=${venue}${graduation} -> ${outcome}`);
    }
  }
  push();

  push(`11) What's still missing before this could inform paper or live trading?`);
  push(`   - Historical liquidity, holder distribution, contract-feature detection, deployer analysis, and wallet-performance data have no verified point-in-time source — Smart Selection here ran on a materially incomplete feature set vs. a live run.`);
  push(`   - Sample size (${run.datasetSize} eligible signals) is far too small for statistical confidence regardless of the direction of any lift shown above.`);
  push(`   - No dataset chronological train/validation/out-of-sample split was meaningful at this sample size — this run is a single out-of-sample evaluation only.`);
  push();

  push(`ASSUMPTIONS`);
  for (const assumption of run.assumptions) push(`   - ${assumption}`);
  push();
  push("=".repeat(72));

  return lines.join("\n");
}
