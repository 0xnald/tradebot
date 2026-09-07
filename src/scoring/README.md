# scoring

The Smart Selection Engine — combines Scout + token + market + wallet
intelligence into a transparent `IGNORE` / `WATCH` / `TRADE_CANDIDATE`
decision. Full architecture, every formula, and every documented
weight/threshold: see `docs/SMART_SELECTION.md` — that document, not this
one, is the source of truth.

- **Input:** already-computed Phase 1-4 intelligence (`ScoutSignal`,
  `SignalMarketSnapshot`, `TokenContractInfo`, `ContractFeatureDetection`,
  `LiquidityAnalysis`, `MarketFlowAnalysis`, `MomentumAnalysis`,
  `EntryQualityFeatures`, `HolderConcentrationBreakdown`,
  `DeployerAnalysis`, `PoolQualityAssessment[]`, `ScoutWalletAssociation[]`,
  `WalletQualityFeatures`, `WalletRelationshipSignal[]`) — nothing here
  fetches anything itself.
- **Output:** `SmartSelectionResult`.
- **Must NOT:** execute, sign, or broadcast anything (still fully
  disabled); call an LLM anywhere in the numerical scoring path; use
  randomness; claim `TRADE_CANDIDATE` means a trade happened.

Status: implemented (Phase 5).

## Files

- `smartSelectionConfig.ts` — the ONE versioned config (`smart-selection-v1`) holding every group weight/threshold. **Heuristic, not statistically optimized.**
- `normalization.ts` — shared `linearBand`/`stepBand`/`invertedU`/`weightedAverage` helpers.
- `featureGroupScorers.ts` — groups A/B/C/D/E/F/G/I (signal quality, token quality, liquidity, market flow, momentum, entry quality, holder structure, market-conditions stub).
- `walletIntelligenceScorer.ts` — group H, including the correlated-wallet clustering/discount.
- `entryChaseDetector.ts` — anti-chase classification (§9).
- `hardBlockerEngine.ts` — 7 deterministic, documented hard blockers (§5).
- `confidenceEngine.ts` — the score-vs-confidence separation (§7).
- `expectedValueEstimator.ts` — heuristic label only, never a real probability (§8).
- `marketRegimeProvider.ts` — group I stub, always `UNKNOWN`.
- `explainability.ts` — positive/negative/blocking factors straight from feature contributions (§16).
- `smartSelectionEngine.ts` — the orchestrator (`SmartSelectionEngine.evaluate()`).

Every file above has its own `*.test.ts`; `smartSelectionEngine.test.ts`
covers all 26 named scenarios from the Phase 5 brief end-to-end.
