# Scout Alpha — Smart Selection Engine (Phase 5)

> **smart-selection-v1 is heuristic and has not yet been statistically
> validated.** Every weight, threshold, and formula in this document was
> chosen for plausibility and transparency — not derived from backtested
> outcome data, because none exists yet. This document is the source of
> truth for exactly what the engine does and why; treat every number in it
> as a documented starting point, not a proven result.

## What this phase is (and isn't)

The Smart Selection Engine combines Scout signal information, token
intelligence (Phase 4), market intelligence (Phase 2/4), and wallet
intelligence (Phase 3) into one of three decisions:

```
IGNORE | WATCH | TRADE_CANDIDATE
```

`TRADE_CANDIDATE` means **the intelligence layer believes this opportunity
deserves to proceed to the risk/execution pipeline** — it is not a buy
instruction, and nothing here executes, signs, or broadcasts anything.
`src/execution`, `src/risk`, and paper trading all remain unimplemented;
this phase only ever writes an analysis record.

Scout is an **input signal**, never the decision. Every meaningful part of
the score corresponds to a measurable, named feature — there is no single
"AI score" and no LLM anywhere in this decision path (see §14).

## Architecture

```
ScoutSignal + SignalMarketSnapshot + TokenContractInfo + ContractFeatureDetection
+ TokenAge + LiquidityAnalysis + MarketFlowAnalysis + MomentumAnalysis
+ EntryQualityFeatures + HolderConcentrationBreakdown + DeployerAnalysis
+ PoolQualityAssessment[] + ScoutWalletAssociation[] + WalletQualityFeatures
+ WalletRelationshipSignal[]
        │
        ▼
┌─────────────────────────────────────────────────────────────┐
│ SmartSelectionEngine.evaluate()  (src/scoring/smartSelectionEngine.ts) │
│  — pure computation, zero network calls, zero LLM calls, zero randomness │
├─────────────────────────────────────────────────────────────┤
│ 1. EntryChaseDetector       → chase risk classification       │
│ 2. assessWalletIntelligence → wallet group score + status     │
│ 3. 9 feature-group scorers  → FeatureGroupScore[]              │
│ 4. overallScore              = weighted avg of AVAILABLE groups│
│ 5. HardBlockerEngine        → deterministic block/no-block     │
│ 6. ConfidenceEngine         → separate 0-100 confidence         │
│ 7. ExpectedValueEstimator   → heuristic label, not a probability│
│ 8. decision + chase-risk cap → IGNORE / WATCH / TRADE_CANDIDATE│
│ 9. buildExplanation          → factors straight from contributions│
└─────────────────────────────────────────────────────────────┘
        │
        ▼
   SmartSelectionResult  →  SmartSelectionRepository (append-only)
```

Every component above is independently unit-tested
(`src/scoring/*.test.ts`); `smartSelectionEngine.test.ts` covers the full
set of 26 named scenarios from the Phase 5 brief end-to-end.

## Reused, not duplicated

Nothing in this phase re-fetches or re-derives data another phase already
computed:

| Input | Source |
|---|---|
| `ScoutSignal` | Phase 1 (`src/signal-parsing`) |
| `SignalMarketSnapshot`, `TokenMarketData`, pools | Phase 2/4 (`src/market-data`) |
| `TokenContractInfo`, `ContractFeatureDetection`, `TokenAge`, `HolderConcentrationBreakdown`, `DeployerAnalysis` | Phase 2/4 (`src/token-analysis`) |
| `LiquidityAnalysis`, `MarketFlowAnalysis`, `MomentumAnalysis`, `EntryQualityFeatures`, `PoolQualityAssessment` | Phase 4 (`src/market-data`) |
| `ScoutWalletAssociation`, `WalletQualityFeatures`, `WalletRelationshipSignal` | Phase 3 (`src/wallet-intelligence`) |

The engine itself makes **zero** provider/RPC/API calls — it only accepts
already-computed intelligence as plain data, per the Phase 5 "avoid
unnecessary provider calls... should not directly call random external
APIs" requirement.

## Data quality: score vs. confidence (Phase 5 §7, the central design decision)

**Score answers "what does the available evidence indicate." Confidence
answers "how complete and reliable is that evidence."** These are
computed completely independently, and a result can legitimately have a
high score and low confidence (or vice versa) — see scenario #3 in the
tests and the diagnostic example below.

- **Score:** `overallScore` is the weighted average of only the feature
  groups that actually produced a score — a group with zero computable
  features is **excluded**, not zeroed. Missing data never drags the
  score down directly (`src/scoring/featureGroupScorers.ts`,
  `weightedAverage()` in `normalization.ts`).
- **Confidence:** `ConfidenceEngine` (`src/scoring/confidenceEngine.ts`)
  computes a fully separate 0-100 number from four weighted components:

  | Component | Weight | What it measures |
  |---|---|---|
  | completeness | 40 | fraction of total configured group weight that had a computable score |
  | criticalFeatureAvailability | 30 | fraction of {liquidity, contract-feature evidence, holder data} actually available |
  | walletSampleSize | 15 | average wallet sample-size confidence when wallets are AVAILABLE; a documented neutral default (30) otherwise |
  | freshness | 15 | market-data age, decaying from 100 at 60s to 0 at 10 minutes |

A worked example (from live testing, all inputs null except a fresh
EARLY_CALL signal): `overallScore = 100` (the only available group,
signal quality, scored perfectly) but `confidence = 15.2` and the result
is hard-blocked to `IGNORE` anyway. **Score alone is never sufficient —
the decision logic (§ below) always gates on both.**

## The 9 feature groups (`src/scoring/featureGroupScorers.ts`, `walletIntelligenceScorer.ts`)

Every feature reports `{ name, rawValue, normalizedValue, weight, contribution, reason, dataQuality }` — never just a number. `contribution = normalizedValue × weight`, `null` when the raw value is unavailable. Group weights (v1, sum to 100):

| Group | Weight | Key features (see the scorer file for exact formulas) |
|---|---|---|
| A. Signal quality | 8 | Scout message type (EARLY_CALL=1.0 vs PERFORMANCE_UPDATE=0.1 — **not equally predictive**), signal age decay, parse completeness |
| B. Token quality | 12 | age category, mint/blacklist/pause/fee bytecode evidence (detected→0.2, not_detected→0.75 — **never 1.0**, absence of evidence isn't proof of safety), deployer supply share, metadata completeness |
| C. Liquidity | 15 | current liquidity (banded), trend (INCREASING/STABLE/DECREASING/LARGE_WITHDRAWAL), acceleration, pool count |
| D. Market flow | 13 | buy/sell ratio (capped at the extreme end — an unbounded ratio isn't "even better"), net flow, recent activity, unique traders; unknown-direction swaps are reported but carry **weight 0** |
| E. Momentum | 10 | short-term change (inverted-U peaking at +20%, not the fastest pump), acceleration, drawdown from high, volatility |
| F. Entry quality | 20 (largest single group — Phase 5 explicitly calls this "extremely important") | price-since-signal (inverted-U — chasing is penalized), liquidity/flow deterioration since signal, volume acceleration, distance from recent high |
| G. Holder structure | 10 | top-5/top-10 concentration (banded, neither extreme is "automatically good or bad"), largest holder, deployer share, holder count |
| H. Wallet intelligence | 12 | see §Wallet treatment below |
| I. Market conditions | 0 | **always UNKNOWN — an interface stub, not a model** (Phase 5 §I) |

## Wallet treatment (Phase 5 §10-11) — the most stateful part of the engine

`assessWalletIntelligence()` (`src/scoring/walletIntelligenceScorer.ts`)
distinguishes four situations, never collapsing them into one "no wallet
data":

| Status | Meaning | Score contribution |
|---|---|---|
| `UNAVAILABLE` | no wallets mentioned, or none have quality data computed yet | `null` — never zero, never positive |
| `UNRESOLVED` | Scout mentioned wallet(s) but none resolved to a full address (the normal case for real Scout data — see `docs/WALLET_DATA_SOURCES.md` §1) | `null` |
| `INSUFFICIENT_SAMPLE` | resolved, but every wallet's `sampleSizeConfidence` is below `walletMinimumSampleSizeConfidence` (0.15) | `null` |
| `AVAILABLE` | at least one resolved wallet has a trustworthy quality record | a real weighted composite score |

**Never substitutes Scout's own "elite"/"good" labels for computed
evidence** — only a resolved `WalletIdentity.address` with real
`WalletQualityFeatures` behind it ever contributes.

**Correlated-wallet penalty (§11):** wallets connected by a
`WalletRelationshipSignal.possiblyRelated = true` edge are grouped into
clusters (simple union-find, not a graph database). Within each cluster,
every member **except the single highest-quality one** has its weight
multiplied by `walletRelationshipIndependenceFactor` (0.3, documented) —
so 3 possibly-related wallets contribute noticeably less total weight than
3 independent ones, without ever claiming they're the same person/entity
(the code and every test enforce "possibly related" language only).

## Anti-chase logic (Phase 5 §9)

`EntryChaseDetector` (`src/scoring/entryChaseDetector.ts`) classifies
`LOW_CHASE_RISK` / `MEDIUM_CHASE_RISK` / `HIGH_CHASE_RISK` / `UNKNOWN` from
Phase 4's `EntryQualityFeatures.chaseRisk` plus two additional signals:
liquidity deteriorating during the price expansion, and a volume spike
(`HIGH` acceleration) without matching liquidity growth. **It never
rejects every fast-moving token** — classification and consequence are
separate: `SmartSelectionConfig.highChaseRiskCapsDecisionAt` (`"WATCH"` in
v1) is what actually downgrades a decision, and only ever downgrades,
never upgrades one.

## Hard blockers (Phase 5 §5) — deterministic, never LLM-overridable

`HardBlockerEngine` (`src/scoring/hardBlockerEngine.ts`) runs 7 checks, any of which forces `decision = "IGNORE"` regardless of score/confidence:

| Code | Condition |
|---|---|
| `INVALID_CONTRACT` | no token metadata (name/symbol/decimals/totalSupply) at all |
| `NO_USABLE_LIQUIDITY` | current liquidity **confirmed** below $500 (unknown liquidity does NOT block — that reduces confidence instead) |
| `CATASTROPHIC_LIQUIDITY_COLLAPSE` | a single-step drop ≤ -70% — stricter than `LiquidityAnalyzer`'s own -30% informational `LARGE_WITHDRAWAL` label |
| `TOKEN_DATA_FUNDAMENTALLY_UNAVAILABLE` | overall data quality is `UNAVAILABLE` |
| `IMPOSSIBLE_MARKET_STATE` | non-positive price or negative liquidity (defensive sanity net) |
| `EXTREME_EXECUTION_DETERIORATION` | `HIGH_CHASE_RISK` **and** confirmed liquidity deterioration together |
| `SEVERE_CONTRACT_RESTRICTION_DETECTED` | mint function detected **and** deployer already holds ≥50% of supply — a narrow, principled combination, not "any admin function blocks everything" (most legitimate tokens have some ownership function) |
| `STALE_CRITICAL_DATA` | market data older than 5 minutes |

There is no LLM anywhere in this decision path, so "the LLM must never
override a hard blocker" is true by construction, not by a guard that
could be bypassed.

## Expected value (Phase 5 §8) — explicitly not a real EV calculation

`ExpectedValueEstimator` (`src/scoring/expectedValueEstimator.ts`) never
invents a probability or a dollar magnitude. It produces one of
`UNKNOWN` / `HEURISTIC_POSITIVE` / `HEURISTIC_NEGATIVE`, always flagged
`statisticallyValidated: false`, from: hard-blocked → `HEURISTIC_NEGATIVE`;
confidence below `minimumConfidenceForTradeCandidate` → `UNKNOWN`;
`HIGH_CHASE_RISK` → `HEURISTIC_NEGATIVE`; score ≥ the trade-candidate
threshold → `HEURISTIC_POSITIVE`; score < the watch threshold →
`HEURISTIC_NEGATIVE`; otherwise `UNKNOWN`. **A real empirical
expected-value model requires backtesting real outcomes — that's later
work, not this phase.**

## Decision thresholds (`src/scoring/smartSelectionConfig.ts`)

```
thresholds: { watch: 45, tradeCandidate: 70 }
minimumConfidenceForTradeCandidate: 55
minimumDataQualityForTradeCandidate: "PARTIAL"
highChaseRiskCapsDecisionAt: "WATCH"
```

`TRADE_CANDIDATE` requires **all** of: score ≥ 70, confidence ≥ 55,
overall data quality at least `PARTIAL`, and chase risk not `HIGH`. Below
70 but ≥ 45 → `WATCH`. Below 45 → `IGNORE`. A hard blocker always forces
`IGNORE` first, before any of the above is even checked. **These
thresholds are heuristic and not proven profitable** — see the top of
this document.

## Explainability (Phase 5 §16)

`buildExplanation()` (`src/scoring/explainability.ts`) ranks every scored
feature by the magnitude of its actual `contribution`, and reports a
feature as a positive factor only when `normalizedValue ≥ 0.6`, a negative
factor only when `≤ 0.4` (a neutral mid-band is reported as neither),
capped at 5 each. Every string is the feature's own `reason` — generated
directly from what was actually computed, never a templated/generic
"AI-sounding" summary. Blocking factors are the hard blockers' own
`description` strings verbatim.

## Persistence (`src/storage/smartSelectionRepository.ts`)

Append-only, keyed by each result's own unique `id`
(`${signalId}:${computedAt}:${counter}`). **A later re-evaluation of the
same signal never overwrites a prior record** — it creates a new one,
so `listEvaluationsForSignal()` can show how the assessment of an
opportunity evolved as market conditions changed after the original Scout
call. This is exactly what later backtesting (Scout alone vs. Scout +
Smart Selection) needs.

## Reproducibility

`SmartSelectionEngine.evaluate()` is a pure function of its inputs plus an
injectable `now: Date` — no `Math.random()`, no wall-clock reads beyond
the injected `now`, no LLM call. The same `SmartSelectionInputs` and `now`
always produce identical `overallScore`, `confidence`, `decision`,
`scoreBreakdown`, and `hardBlockers` (verified directly in
`smartSelectionEngine.test.ts`, scenario 26). Only the result's own unique
`id` differs between two calls, by design (see Persistence above).

## Model versioning

`modelVersion: "smart-selection-v1"` is stamped on every
`SmartSelectionResult` and its `featureSnapshot.configVersion`. Every
weight/threshold lives in one file
(`src/scoring/smartSelectionConfig.ts`) — nothing is hardcoded elsewhere
in the codebase — so a future `smart-selection-v2` can be introduced as a
new config object without touching the scoring logic, and old
`SmartSelectionResult` records remain interpretable against the version
that actually produced them.

## What remains statistically unvalidated

Everything numeric in this phase: the 9 group weights, every intra-group
feature weight, every band/threshold (liquidity bands, concentration
bands, the ±5%/±30% liquidity trend thresholds, the 45/70 decision
thresholds, the 55 confidence minimum, the 0.3 wallet-relationship
discount, the 0.15 wallet sample-size minimum, and every hard-blocker
threshold). None of these were derived from backtested outcomes — there
is no historical result data yet to backtest against. The explicit purpose
of Phase 5's transparent, feature-level design is to make **eventual**
backtesting possible (Scout alone vs. Scout + Smart Selection) — this
phase builds the instrument, not the proof that it works.
