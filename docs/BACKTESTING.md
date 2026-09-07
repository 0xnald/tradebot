# Backtesting & Selection Validation (Phase 6)

## Purpose

This is **not** an attempt to prove Scout Alpha is profitable. It is an
attempt to answer, honestly and reproducibly, one question:

> Does the Smart Selection Engine (Phase 5) extract better opportunities
> from Scout Robinhood than simply taking every Scout call?

Everything below — the lookahead-bias protection, the "UNAVAILABLE" states,
the small-sample caveats — exists to keep that answer honest even when it's
disappointing.

## Architecture

`src/backtesting/` consumes the **real, unmodified** Phase 5
`SmartSelectionEngine` (`src/scoring/smartSelectionEngine.ts`). It never
reimplements scoring. The pipeline, per signal:

```
ScoutSignal (real, historical)
  -> signalReconstructor.ts     reconstruct SmartSelectionInputs as of the
                                 decision timestamp, via LookaheadGuard
  -> SmartSelectionEngine        the REAL Phase 5 engine, unmodified
       .evaluate(inputs, decisionTimestamp)
  -> entrySimulator.ts          earliest trustworthy fill price at/after
                                 the decision, within a max delay
  -> exitOutcomeSimulator.ts    horizon returns, MFE/MAE, TP/SL detection
  -> metricsCalculator.ts       per-cohort metrics + selection lift + buckets
  -> portfolioSimulator.ts      capital-constrained portfolio view
  -> backtestRunner.ts          orchestrates all of the above -> BacktestRun
  -> reportFormatter.ts         human-readable report
```

`src/storage/backtestRunRepository.ts` persists each `BacktestRun`
(immutable, append-only) to `data/backtests/runs.ndjson`.

Run it: `npm run backtest` (real network calls: on-chain pool discovery +
GeckoTerminal historical candles — no wallet, no signing, no broadcasting).
Reprint the latest saved report without re-running: `npm run backtest:report`.

## Lookahead-bias protection

`src/backtesting/lookaheadGuard.ts`'s `LookaheadGuard` is the single
enforcement point. Every historical fact fed into a backtested decision is
wrapped as `TimestampedObservation<T>` (`{observedAt, value}`) and passed
through `guard.admit(field, observation)`, which returns `null` — and
records a `LookaheadViolation` — for anything observed after the decision
timestamp. There is no other path a feature can take into
`SmartSelectionInputs` in `signalReconstructor.ts`. `lookaheadGuard.test.ts`
proves this directly for price, liquidity, holder, wallet, and general
market data.

Entry/exit **simulation** (§ below) is a different concern and is not
lookahead: it deliberately looks at candles *after* the decision timestamp
to model what a real fill and a real exit would have looked like. That's
not bias — it's the outcome being measured, computed identically for every
cohort.

## What is genuinely historically reconstructable — and what isn't

This is the central, load-bearing finding of Phase 6, established by direct
verification (not assumption):

**Reconstructable:**
- The Scout signal itself (`ScoutSignal`) — it's the historical message,
  by construction never lookahead.
- `walletAssociations` — parsed directly from the message's own live-buys
  text (`buildScoutWalletAssociations`), not from any external lookup.
- Historical **price** (and per-candle volume) via GeckoTerminal's public
  OHLCV API (`geckoTerminalHistoricalPriceProvider.ts`), confirmed live
  against real Robinhood Chain pools — *when* the pool can first be
  identified and *if* GeckoTerminal has indexed it (see the coverage gap
  below).

**Never reconstructable for this dataset (no verified historical
point-in-time source exists — never substituted with a current value):**
`tokenContractInfo`, `contractFeatures`, `tokenAge`, `liquidityAnalysis`,
`marketFlow`, `momentum`, `entryQuality`, `anomalyFindings`,
`holderConcentration`, `deployerAnalysis`, `poolQuality`,
`walletQualityByAddress`, `walletRelationships`, and every
`marketSnapshot` field except `priceUsd` (liquidity, 24h volume, market
cap, recent flow, token age, holder info). Phases 2-4 only ever fetch
**current** state from their providers (DexScreener, Blockscout, on-chain
reads) — no point-in-time historical snapshot of any of these was ever
captured for a real signal, and there is no verified third-party source
that can reconstruct them after the fact. This means Smart Selection, when
backtested, runs on a **materially incomplete** feature set compared to a
live decision — every score computed here reflects that gap; it does not
reflect a bug.

## A real coverage gap, found and root-caused: Pons Family launchpad

Running `npm run backtest` against the real 20-message 2026-09-04 fixture
first surfaced something more specific than "some data is missing":
**Phase 2's on-chain pool discovery (`UniswapV3PoolProvider`, which only
queries the single officially-documented Uniswap V3 factory) found zero
pools for 5 of the 7 real, actively-Scout-called memecoins in this
dataset**, even though those exact tokens had real, actively-traded
markets GeckoTerminal independently indexed.

A follow-up investigation (prompted by a lead pointing at the **Pons
Family** launchpad, `docs.ponsfamily.com` /
`github.com/ponsdotdev/ponsfamily`) root-caused this precisely, verified
on-chain rather than assumed — full record in `docs/DATA_SOURCES.md` §7.
Summary: **4 of the 7 real signals are confirmed Pons V2 bonding-curve
launches** (`getLaunchedToken()` on the verified V2 factory,
`0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e`, returns `exists: true`).
Pons V2 tokens never appear in Uniswap V3 discovery because pre-graduation
they trade on a bonding curve (not a DEX pool at all) and post-graduation
they move to a **Uniswap V4** pool, which has no per-pool contract address
to `getPool()` at all — V4 pools are identified by a `bytes32 PoolId`. That
PoolId turned out to be **fully derivable on-chain** (`keccak256` of the
sorted currency pair + fee + tickSpacing + Pons' known hook address) —
verified to match GeckoTerminal's independently-reported pool id exactly,
for a real graduated token. `src/market-data/ponsV2Provider.ts` implements
this and is now tried first, before Uniswap V3 discovery, in
`signalReconstructor.ts`.

The remaining 3 signals are **not** Pons: BABA is a plain standalone
Uniswap V3 deployment (already coverable by existing discovery, though
GeckoTerminal still returned no candle data for it within the backtest's
short lookback window — see below); BUFO and one of the two CRC tokens are
launched through a mechanism that was **not identified** — GeckoTerminal
shows several pools for them, including a legitimate-looking Uniswap V3
pool paired against a non-standard "novelty" quote token, plus several
more 32-byte pool ids with unusual fee labels. This is left explicitly
open, not guessed at.

**A caution surfaced during this investigation, worth restating for
anyone doing similar work:** an outside source supplied a Pons V2 factory
address that turned out to be **not a valid address at all** (39 hex
characters — the RPC rejected it outright). Both `docs.ponsfamily.com` and
the project's own GitHub README independently agreed on the correct one,
confirmed to have real bytecode on-chain. A "primary source" claim is not
a substitute for on-chain verification.

## Phase 6.6 — reconstructing prices ourselves, independent of indexer delay

Phase 6.5 fixed *discovering* the right venue; Phase 6.6 asked a follow-up
question: can we obtain historically-correct market observations
independently of delayed third-party indexing, rather than depending on
GeckoTerminal to have already indexed a fresh pool or curve? Full mechanics
(venue lifecycle, the resolution algorithm, exact block/timestamp handling,
known limitations): `docs/ROBINHOOD_MARKET_DISCOVERY.md`. Summary:

- **On-chain event reconstruction now comes first**, GeckoTerminal is the
  fallback — a documented, tested tier order
  (`tieredHistoricalPriceProvider.ts`), not an assumption. Verified live:
  a Pons V2 curve's own `CurveBuy`/`CurveSell` events, and a graduated
  Uniswap V4 pool's `Swap` events (filtered by its `PoolId`, never treated
  as an address), both produce real, ground-truth prices with no indexer
  dependency at all.
- **The graduation-boundary rule is enforced by real timestamps, not
  current phase.** A launch's `getLaunchedToken()` phase reflects *today's*
  state; a historical decision must compare against the launch's actual
  `CurveCompleted` block timestamp to know whether the curve or the V4 pool
  is the historically-correct venue. Getting this wrong the naive way (using
  "is it graduated now") would silently let a pre-graduation decision see
  post-graduation V4 data — a real lookahead violation. `venueResolver.test.ts`
  proves the before/after/exact-boundary cases directly; this was treated as
  correctness-critical, not a nice-to-have, per the explicit instruction that
  prompted this phase.
- **Every signal's outcome is classified with a specific reason**
  (`MarketReconstructionFailureReason`: `NO_MARKET`, `MARKET_NOT_DISCOVERED`,
  `POOL_EXISTS_BUT_NO_INDEXER_DATA`, `CURVE_EXISTS_BUT_NO_INDEXER_DATA`,
  `HISTORICAL_DATA_TOO_FRESH`, `RPC_HISTORY_LIMITATION`, etc.) rather than a
  generic "unavailable" — see each `BacktestSignal.marketResolution` and the
  report's per-signal trace section.
- **USD conversion stays disclosed, not assumed.** Several real Pons V2
  launches turned out to be quoted in Robinhood's tokenized-equity tokens
  (AMZN/META/LLY-style), not a stablecoin — converting those to USD would
  require a second, unverified historical price hop. Raw quote-denominated
  prices are still reconstructed; only the USD figure is withheld for
  non-USD-stable quote assets (currently: everything except USDG).
- **Never silently substitutes current data.** This was already true
  everywhere in Phase 6 and remains true here — every new on-chain provider
  returns `unavailable`, never a live/current value, when historical data
  can't be found.

## Entry simulation

`entrySimulator.ts`: entry timestamp is always the decision timestamp;
entry **price** is the earliest candle open at or after that timestamp,
within a configurable `maxEntryDelayMinutes` (default 5). If no such candle
exists, entry is `UNAVAILABLE` — never a later, more favorable price, and
never a fabricated one. Fees and slippage are tracked separately
(`feesUsd`, `slippagePct`) and applied when computing net returns, not
baked into the recorded market price.

## Exit / outcome simulation

`exitOutcomeSimulator.ts` computes, purely from historical OHLC candles
after entry:
- **Per-horizon returns** (`1m/5m/15m/30m/1h/4h/24h`, configurable) — a
  horizon is `UNAVAILABLE` (not approximated) if the candle series doesn't
  actually extend that far, never filled in from the nearest earlier candle.
- **MFE/MAE** across every candle observed in the window.
- **TP/SL hit detection** — a level is only ever marked "hit" when a candle
  actually crosses it. If both TP and SL are crossed within the *same*
  candle, OHLC data cannot establish which happened first;
  `candleOrderingAmbiguous` is set `true` and the outcome is conservatively
  recorded as the stop-loss (the worse case), never the more flattering
  take-profit.
- Candle granularity is chosen once per outcome window (1-minute up to 1h
  of horizon, 5-minute up to 4h, hourly beyond that) purely to stay within
  GeckoTerminal's practical per-request candle limit — a documented
  precision tradeoff for the 24h horizon, not a hidden one.

## Cohorts and selection lift

Every eligible signal carries exactly **one** real, historically-simulated
outcome (computed under identical entry/exit/fee/slippage assumptions).
Cohorts are pure filters over that one outcome set:
- `RAW_SCOUT_BASELINE` — every eligible signal (see eligibility below).
- `TRADE_CANDIDATE` — only signals the real Smart Selection engine scored
  as `TRADE_CANDIDATE`.
- `WATCH` — a counterfactual only; never treated as capital committed.

`metricsCalculator.computeSelectionLift` cross-tabulates the SAME outcomes
against the real decision to answer: did `TRADE_CANDIDATE` have better
expectancy/win-rate/average-return than the raw baseline, and what
fraction of raw-baseline *profitable* signals did Smart Selection filter
out (a real cost of selection) vs. *losing* signals it correctly avoided?
A `statisticallyConvincing` flag is `false` below a 30-usable-signal floor
per cohort — with 7 total eligible signals in the real dataset, every lift
number in a real run is directional only, never proof.

## Eligibility

Only `EARLY_CALL` Scout messages with a recovered contract address are
treated as entry opportunities (`backtestRunner.selectEligibleSignals`).
`PERFORMANCE_UPDATE` messages describe a token already called earlier —
not a fresh decision point — and are excluded, with the exclusion count
recorded in `DataAvailabilityReport.notes`, never silently dropped.

## Portfolio simulation

`portfolioSimulator.ts` is the capital-constrained view: fixed
%-of-capital position sizing (no leverage, no compounding unless
configured), a hard cap on concurrent positions, and a documented default
for competing signals — earliest `decisionTimestamp` wins a free capital
slot; a later signal that arrives with no free slot is recorded as
*skipped*, never queued or silently downsized. Equity is tracked at cost
basis for open positions (no intraday mark-to-market); PnL realizes only
at close. This is separate from the independent-return metrics above,
which ignore capital constraints entirely — both modes are computed and
reported side by side, never conflated.

## Score/confidence/chase-risk calibration

`metricsCalculator.computeScoreBuckets` / `computeConfidenceBuckets` bucket
the real `SmartSelectionResult.overallScore` / `.confidence` into
0-19/20-29/…/90-100 and report sample count, average/median return, win
rate, expectancy, and **data completeness** per bucket —
`computeChaseRiskBuckets` does the same grouped by
`LOW/MEDIUM/HIGH/UNKNOWN` chase risk instead of a numeric range. A bucket's
`dataCompletenessPct` matters as much as its return numbers: a bucket with
one sample and 100% completeness says nothing; report both, always.

## No parameter optimization

Phase 6 never tunes Smart Selection's weights or thresholds. `npm run
backtest` runs `SMART_SELECTION_V1_CONFIG` completely unmodified — the
first (and, as of this writing, only) result is genuinely out-of-sample.
There is no threshold-sweeping tool in this phase; adding one later must
never write back to production config or claim a "best" threshold from
this dataset's tiny sample.

## Real result (2026-09-04 fixture, `npm run backtest`)

20 Scout messages parsed; 7 were `EARLY_CALL` with a contract address (the
only eligible entry opportunities) — 13 `PERFORMANCE_UPDATE` messages
excluded throughout.

**Before/after, Phase 6.5 -> Phase 6.6** (GeckoTerminal-only discovery vs.
on-chain event reconstruction tried first):

| Metric | Phase 6.5 | Phase 6.6 |
|---|---|---|
| Market venue resolved | 4/7 (Pons discovery added) | 5/7 (+ BABA's V3 pool now resolves reliably) |
| Historical price reconstructed | 1/7 | **3/7** |
| Valid simulated entry | 1/7 | 2/7 |
| Valid simulated exit/outcome | 1/7 | 1/7 |
| Complete Smart Selection feature set | 0/7 | 0/7 (unchanged — liquidity/holder/wallet remain permanently unavailable, see above) |

Per-signal, in the final stable run (also `data/backtests/latest-report.txt`):

- **THROBBIN — price reconstructed directly from on-chain events**
  (`reconstructionMethod: ONCHAIN_EVENT`), no GeckoTerminal involved. This
  is the direct, concrete answer to this phase's question: yes, a
  historically-correct observation was obtained independently of indexer
  delay, for a real signal. Venue: the graduated Uniswap V4 pool (it had
  already graduated by the time Scout posted the call).
- **BABA and CRC — price reconstructed via the GeckoTerminal fallback
  tier** (on-chain reconstruction was attempted first per the documented
  hierarchy but didn't win for these two; GeckoTerminal did).
- **Diem and BIOHACKING — correctly resolved venues, still no price.**
  Both classified `MISSING_PRICE`: the venue identifiers are independently
  confirmed correct on-chain, but neither the on-chain tier nor
  GeckoTerminal produced usable data within the decision-time window. Most
  consistent with genuinely very-fresh markets (BIOHACKING's curve had
  traded for only ~5 minutes before the call).
- **BUFO and the second CRC token — `MARKET_NOT_DISCOVERED`, unresolved
  mechanism**, unchanged from Phase 6.5. No speculative provider was built
  for them.
- With n=1 backtestable raw-baseline signal (THROBBIN), the outcome was a
  **-94% loss** by the 4-hour mark. One real, unflattering data point, not
  a verdict on Smart Selection — `TRADE_CANDIDATE`/`WATCH`/selection-lift
  are all `n/a` because Smart Selection didn't classify THROBBIN as
  `TRADE_CANDIDATE`, so there's nothing to compare yet.
- **Score/confidence separation held up under real, near-total data
  scarcity**, exactly as Phase 5 documented: all 7 signals scored 90-100
  overall (the few available signal-quality features scored well) but
  averaged only ~23/100 confidence — a high score with low confidence is
  the system correctly saying "this looks good on what little we know,"
  not a contradiction. See the report's §8/§8b for the buckets.
- The root cause of the remaining gaps is real-world data coverage/timing
  (or a genuinely unidentified launch mechanism, for 2 tokens), not a bug
  in the lookahead guard, entry/exit simulators, or metrics calculator —
  all of which have dedicated deterministic unit tests (synthetic
  fixtures) proving they behave correctly when data IS available.
- **A live-data caveat, distinct from the deterministic-reproducibility
  guarantee below:** consecutive real runs against live external state
  (an RPC and a still-indexing public API) can reconstruct a price for a
  different number of signals run to run — observed directly across the
  runs made while building this phase, and root-caused to real,
  documented causes each time (a full-history graduation scan
  destabilizing later calls; a lookahead-adjacent probe-window bug; the
  external indexer's own state simply changing between runs) rather than
  left as an unexplained flake. The deterministic-reproducibility tests
  guarantee identical *computation* over a *fixed* reconstructed dataset —
  they do not, and cannot, guarantee that two live runs against live
  external state reconstruct the same dataset.

This is exactly the honest, unflattering finding this phase exists to
surface, not something to work around.

## What's still missing before this could inform paper or live trading

1. **Two tokens' launch mechanism remains genuinely unidentified** (BUFO,
   one CRC). Not Pons V1/V2, no discoverable Uniswap V3 pool. Left
   unresolved rather than guessed at — see `docs/DATA_SOURCES.md` §7.
2. **No historical source for liquidity, holder distribution, contract
   features, deployer analysis, or wallet performance**, even once a
   venue is found. These feature groups are permanently unavailable to
   backtesting unless a verified historical provider is found, or unless
   the live system starts capturing its own point-in-time snapshots going
   forward (which would only make FUTURE signals backtestable, not these).
3. **Volume, liquidity, and buy/sell-flow reconstruction are not
   implemented for the on-chain tier** — Phase 6.6 reconstructs price
   only. `HistoricalObservation.liquidity` exists in the type but every
   current provider always leaves it `null`.
4. **On-chain reconstruction across a mid-simulation graduation isn't
   handled** — a signal entered pre-graduation whose exit horizon extends
   past a later graduation uses one venue's data for the whole simulated
   position. Not observed in the real dataset, but a known simplification.
5. **Sample size.** Even with perfect data coverage, 7 eligible signals
   from one day of one channel is far too small for statistical
   confidence. This needs weeks-to-months of continuous real ingestion
   before a lift number means anything.
6. No chronological train/validation/out-of-sample split was meaningful
   at this size — this is a single out-of-sample evaluation, nothing more.

## Dataset scope (Phase 6.6 §14)

The repository contains exactly one real Scout dataset:
`src/ingestion/fixtures/scoutrobinhood-2026-09-04.raw.json` (20 messages,
7 eligible signals — used throughout this document). No other real Scout
fixture exists in this repo. Per explicit instruction, no new messages
were scraped from the live channel to pad this out, and no other on-chain
activity was relabeled as "Scout data" — the primary benchmark remains
this one real, honestly-small dataset. Capturing more real messages
requires live Telegram credentials and running `npm run ingest:dev`
against the real channel over time (see `src/ingestion/README.md`); that
is future data-collection work, not something to fabricate here.

## Testing

Every backtesting module has a dedicated `*.test.ts` file using synthetic
fixtures (deterministic node:test + node:assert, no framework) covering:
no-lookahead admission/rejection, missing/invalid observations, entry
delay and UNAVAILABLE handling, slippage/fees, TP/SL hit detection
including same-candle ambiguity, multiple horizons with independent
UNAVAILABLE handling, win/loss/expectancy/profit-factor/drawdown math,
zero-trade/all-win/all-loss/incomplete-dataset edge cases, selection lift
and its filtered-opportunity accounting, score/confidence/chase-risk
buckets, portfolio capital constraints and forced position closes, and a
full reproducibility check (same dataset+config -> identical metrics,
different only in `id`/`runAt`). None of these fixtures are used to claim
real-world profitability — see the repeated warnings against that in each
test file's module comment.

Phase 6.6 added dedicated deterministic tests (all network-independent,
fake chain clients/providers only) for: the graduation-boundary venue
selection (before/after/exact-boundary, proven as a correctness-critical
lookahead test), on-chain event-based price reconstruction for all three
venues (Pons curve, Uniswap V4, Uniswap V3) including malformed logs and
duplicate events, `PoolId` handling (never treated as an address), the
tiered on-chain-then-GeckoTerminal fallback ordering, block-timestamp
caching, adaptive log-range chunking under the RPC's "too many results"
failure mode, and the Scout-only strategy-origination boundary.
