# Live Scout → Paper Trading Pipeline (Phase 7)

An event-driven, low-latency pipeline that turns a live Scout Robinhood
Telegram message into a paper trade, using the exact same, unmodified
Phase 5 `SmartSelectionEngine` Phase 6/6.6's historical backtester uses.
No real transaction, wallet signature, or private key exists anywhere in
this module — every trade is `PAPER_*`, simulated only.

## The invariant this whole phase sits inside

**Scout is the only strategy entry point.** Pons, Uniswap V3/V4,
GeckoTerminal, and DexScreener answer "given a Scout token, where and how
does it trade *right now*?" — they never enumerate tokens or originate a
candidate. See `ARCHITECTURE.md`'s "Invariant: Scout is the only strategy
entry point" and `src/backtesting/scoutOriginationBoundary.test.ts` (the
same structural guarantee applies here: `SmartSelectionEngine.evaluate()`
is only ever called from `signalProcessor.ts`'s per-signal pipeline, which
only runs for a signal that came from `parseScoutMessage()`).

## Pipeline

```
Raw Telegram message (event-driven, GramJS NewMessage handler)
  -> RECEIVED            (timestamped the instant it arrives)
  -> PARSED               (parseScoutMessage — reused unchanged from Phase 1)
  -> VALIDATED / REJECTED (EARLY_CALL only, has a contract address, not a duplicate)
  -> INTELLIGENCE_STARTED/COMPLETED  (current price, token contract info, wallet associations)
  -> SCORING_STARTED/COMPLETED       (the real, unmodified SmartSelectionEngine)
  -> PAPER_DECISION       (IGNORE / WATCH / TRADE_CANDIDATE)
  -> PAPER_ENTRY          (only for TRADE_CANDIDATE, only if not stale, only if capital allows)
  -> PAPER_POSITION_OPEN
  -> ... independent position monitoring ...
  -> PAPER_POSITION_CLOSED
```

Every stage is timestamped by `LifecycleTracker`
(`src/live/lifecycleTracker.ts`) into a `LifecycleEvent[]`, assembled into
one `LiveSignalRecord` per signal (`src/live/signalProcessor.ts`) —
persisted via `src/storage/liveSignalRecordRepository.ts`.

## Two independent responsibilities that never block each other (§12)

`LivePipeline` (`src/live/livePipeline.ts`) runs:

- **Signal processing** — one raw message triggers one bounded-concurrency
  task (`ConcurrencyLimiter`, reused from Phase 3). The adapter's own
  `onMessage` callback returns immediately (fire-and-forget through the
  limiter with an attached `.catch()`), so the adapter's own message loop
  (GramJS's live event stream, or a fixture replay's sequential `await`
  loop) is never blocked by one signal's processing time. A slow provider
  for signal A never delays signal B from entering the pipeline.
- **Position monitoring** — a separate `setInterval` loop, completely
  decoupled from signal ingestion. One broken position's poll (a thrown
  error) is caught and logged; it never stops monitoring the others, and
  never touches signal-processing stats.

## Live intelligence gathering — explicitly scoped (read this before assuming full parity with Phase 5's original design)

`src/live/liveIntelligenceGatherer.ts` wires, for a live decision:

- **Current price** (`src/live/currentPriceResolver.ts`) — tier 1: the
  exact same on-chain venue-resolution and event-reconstruction machinery
  Phase 6.6 built (`venueResolver.resolveMarketVenue`,
  `OnChainPonsCurvePriceProvider`/`OnChainUniswapV4PriceProvider`/
  `OnChainUniswapV3PriceProvider`), just queried with "now" instead of a
  historical decision timestamp — lookahead restrictions don't apply to a
  live decision, a current observation is exactly the right one. Tier 2:
  DexScreener, a verified live market-data API. Both timeout-bounded
  (`withTimeout`, default 4s) and reported honestly as UNAVAILABLE when
  both fail — never a stale/current-data substitution for a genuinely
  missing observation, and never a fabricated price.
- **Token contract info** via the existing `TokenAnalysisService`.
- **Wallet associations** parsed directly from the Scout message text
  (`buildScoutWalletAssociations`) — instant, no I/O.

**Not yet wired into the live path** (an honest, explicit scope decision,
not an oversight): the deeper Phase 4 analyzers (contract-feature
detection, token age, liquidity/momentum/entry-quality/anomaly analysis,
holder concentration, deployer analysis, pool quality) and full
wallet-performance/relationship intelligence. `SmartSelectionInputs`
receives `null`/empty for those groups. This is exactly the situation
Smart Selection is designed to handle — `overallScore` excludes missing
groups rather than defaulting to zero, and `confidence` honestly reflects
how little is actually known — proven repeatedly in Phase 6's real
backtest runs with similarly sparse historical data. Wiring the remaining
analyzers into the live path is real, valuable follow-up work, explicitly
left for a later phase rather than rushed here.

## RESOLVED (Phase 7.1 §2) — the NaN scoring edge case flagged during Phase 7

Phase 7 flagged (see git history for the original note) that feeding the
live gatherer's sparsest realistic input shape into `SmartSelectionEngine`
could, in ad-hoc testing, produce `overallScore: NaN` rather than a real
number or a clean `null`. Phase 7.1 §2 explicitly named this a
**correctness bug** (distinct from the frozen scoring heuristics/weights)
and required it be root-caused and fixed.

**Root cause.** Three sites did unguarded timestamp arithmetic —
`(now.getTime() - new Date(x).getTime()) / 1000`:

- `src/scoring/featureGroupScorers.ts`'s `scoreSignalQuality()`, on
  `signal.receivedAt`.
- `src/scoring/hardBlockerEngine.ts`'s `STALE_CRITICAL_DATA` check, on
  `inputs.marketDataObservedAt`.
- `src/scoring/smartSelectionEngine.ts`'s `evaluate()`, on the same
  `marketDataObservedAt`, computing `marketDataAgeSeconds`.

`new Date(x).getTime()` silently returns `NaN` for a missing/malformed
timestamp string. That NaN then fed `linearBand()` (which preserves NaN
through `Math.min`/`Math.max`), producing a NaN normalized feature value.
The real poison point was `src/scoring/normalization.ts`'s
`weightedAverage()`: its filter was `e.value !== null && e.weight > 0`,
and `NaN !== null` evaluates `true` in JavaScript — so a NaN "value" was
treated as usable and poisoned the weighted sum (`NaN * weight = NaN`,
and any sum containing a NaN term is NaN). `smartSelectionEngine.ts`'s
`overallScore = weightedAverage(...) ?? 0` only substitutes 0 for
`null`/`undefined`, not `NaN`, so a poisoned group score could reach the
final result.

In the real live/backtest pipeline, `signal.receivedAt` and
`marketSnapshot.capturedAt` are always self-generated via
`new Date().toISOString()`, so this exact path is not known to be
reachable today — but Phase 7.1 §2 explicitly required defensive
robustness "under any possible sparse/partial input" regardless of
current reachability.

**Fix (Smart Selection's intended scoring semantics unchanged — this is
purely defensive hardening against malformed input, not a weight/threshold
change):**

1. Added `safeAgeSeconds(observedAt, now)` to
   `src/scoring/normalization.ts` — returns `null` (never `NaN`) for a
   missing *or* unparseable timestamp, via an explicit `Number.isNaN`
   check on the parsed milliseconds. All three call sites above now use
   it and treat `null` exactly the way they already treated "timestamp
   not provided" (an `UNAVAILABLE` feature / a skipped hard-blocker check)
   — never a fabricated value.
2. Hardened `weightedAverage()` itself to filter on
   `Number.isFinite(e.value)` in addition to `e.value !== null` — this is
   the single choke point every feature-group score and the final
   `overallScore` pass through, so it's kept as defense-in-depth even
   after fixing the three call sites, in case a future feature group
   introduces its own unguarded arithmetic.

No group weight, intra-group weight, threshold, or EV heuristic was
touched. Regression tests (`src/scoring/smartSelectionEngine.test.ts`
#27-32) adversarially feed unparseable `receivedAt`/`capturedAt` values,
both individually and together, plus an almost-entirely-null sparse
input, and assert every numeric field on the returned
`SmartSelectionResult` is finite — recursively, not just the top-level
`overallScore`/`confidence`. `normalization.test.ts` covers
`weightedAverage`/`safeAgeSeconds` directly. The full existing 102-test
`src/scoring` suite (pre-dating this fix) still passes unchanged, meaning
no intended behavior shifted for any well-formed input.

## Paper trading (§8/§9) — never touches a real wallet

`src/live/paperTradingEngine.ts`'s `openPaperPosition()` and
`src/live/paperPortfolio.ts`'s `PaperPortfolio` together simulate: entry
timestamp, entry price (from `currentPriceResolver`, with its real
source and data-quality recorded), position size (a fixed % of *current*
cash, capped at a configured maximum — no leverage, no borrowing),
slippage (raises the effective execution price), fee, resulting token
amount, and a `positionId`. `LivePaperPosition`/`PaperTradeExecution`
(domain.ts) contain no signing/broadcast-shaped field at all — there is
structurally nothing to accidentally wire up to a real wallet later
without a deliberate, separate addition.

## Position management (§10/§11)

`src/live/paperPositionManager.ts`'s `pollPosition()`:

- Polls the same tiered current-price resolver used at entry.
- Computes PnL, return %, and running MFE/MAE (never resets on a
  worse/better subsequent price — always the running extreme).
- Marks a position's `marketStatus` as `STALE_PRICE` when the price
  observation is older than `priceStalenessSeconds`, or `UNKNOWN` when no
  price at all could be resolved — and **never evaluates an exit
  condition against a stale or missing price**. A position with a stale
  price is left open with an honestly-labeled snapshot, not silently
  closed or silently kept open based on old data.
- Supports configurable take-profit, stop-loss, max-holding-time, and a
  liquidity-emergency exit, in `evaluateExit()`. Threshold comparisons are
  rounded to 8 decimal places before comparing — IEEE 754 floating point
  makes `(0.8 - 1.0) / 1.0 * 100` equal `-19.999999999999996`, not exactly
  `-20`, which would silently make an exact `-20%` stop-loss fail to fire
  without this. Caught by `paperPositionManager.test.ts`'s dedicated
  boundary tests — a real bug found and fixed while building this phase,
  not a hypothetical.

## Stale-signal protection (§14)

`signalProcessor.ts` checks the Scout-reported call age against
`PaperPortfolioConfig.maxSignalAgeSecondsForEntry` **immediately before**
committing capital (after Smart Selection has already run, so the
decision is still recorded even for a signal that arrives too late to
trade) — an old signal is rejected with `STALE_SIGNAL`, never blindly
traded. Not tuned/optimized in this phase, per instruction.

## Deduplication (§13) and restart safety (§19)

A signal is deduplicated by `source:sourceMessageId` (the same scheme
Phase 1's `FileSignalRepository` already uses) — checked, then marked
processed, *before* any heavy work starts, so a genuinely-concurrent
duplicate can't race past the check. `LivePipeline.recoverFromDisk()`
reloads every persisted `LiveSignalRecord`'s id into the in-memory dedup
set and resumes monitoring every `LivePaperPosition` still `OPEN` on disk
— a restart never reprocesses an old Scout call and never silently drops
an open position. Proven directly in `livePipeline.test.ts`.

## Latency metrics (§16)

`src/live/latencyMetrics.ts` computes count/average/median/p95/max for
the two headline metrics — `scoutToPaperEntry` (the single most important
number) and `scoutToDecision` — plus every individual stage transition and
every external provider's own latency, from the same `LifecycleEvent[]`
and `providerCalls[]` already recorded on each `LiveSignalRecord`.

## Observability (§17) and failure isolation (§18)

Every signal produces one structured `LiveSignalRecord` — token, Scout
timestamp, received timestamp, venue, market-data quality, score,
confidence, decision, paper entry, position id, and (for a rejection) a
specific `SignalRejectionReason`. Logging goes through the existing
`src/shared/logger.ts`, which already redacts API hashes/tokens/session
strings/secrets before any log line is emitted — nothing new was needed
here. Every per-signal and per-position failure is caught at its own
boundary (`livePipeline.ts`'s `#handleRawMessage`/`#pollAllPositions`) and
logged, never thrown past — proven directly by
`livePipeline.test.ts`'s "one signal whose processing throws does not
crash the listener" case.

## Status view (§20)

`src/live/statusView.ts`'s `formatStatusView()` renders: listener status,
recent signals (time/token/score/confidence/decision/latency), open
positions (token/entry/current/PnL/age), recently-closed trades
(token/entry/exit/return/reason), and summary counters. `npm run live`
prints this every 15 seconds and once more on shutdown.

## Running it

`npm run live` — connects to the real Telegram channel if
`TELEGRAM_API_ID`/`TELEGRAM_API_HASH`/`TELEGRAM_SESSION_STRING` are set;
otherwise **replays** the real captured 2026-09-04 fixture (clearly
logged as replay, never confused with live ingestion — Phase 7 §22). A
live run stays connected until `Ctrl+C`; a replay run shuts down
automatically once the fixture is exhausted and prints the same final
report. Fixes a real pre-existing gap found while building this: the
original `src/ingestion/runDev.ts` calls `adapter.stop()` immediately
after `adapter.start()` resolves, which — for the live Telegram
adapter specifically — resolves as soon as it's subscribed, so `runDev.ts`
would disconnect right after connecting without ever actually waiting for
a live push event. `scripts/liveScout.ts` fixes this for the live
pipeline by keeping the process alive (via the status-view interval and
the adapter's own event loop) until an explicit `SIGINT`/`SIGTERM`.

## Historical backtesting is untouched (§23)

`src/backtesting/` and `npm run backtest`/`backtest:report` are unchanged
by this phase — they remain the tool for validating the Smart Selection
model and measuring selection lift against a historical dataset. Both
paths call the identical `SmartSelectionEngine` with the identical
`SMART_SELECTION_V1_CONFIG`; neither blocks the other.

## Phase 7.1 — live intelligence completion & latency optimization

Phase 7 proved the architecture; Phase 7.1 made the intelligence it feeds
Smart Selection more complete and more concurrent, without touching
Smart Selection's own weights/thresholds/heuristics (frozen except the
NaN correctness fix documented above). Full detail — the 9-feature-group
coverage matrix, the tier model, and the `TokenAnalysisService` timeout
root-cause investigation — lives in `docs/LIVE_INTELLIGENCE.md`. Summary:

- **Parallel fan-out** (`liveIntelligenceGatherer.ts`,
  `currentPriceResolver.ts`): every independent data source (DexScreener,
  on-chain price tier, fast token metadata, slow token enrichment,
  contract features, market flow) now runs concurrently under one shared,
  bounded deadline, instead of Phase 7's sequential chain. On-chain price
  is preferred over DexScreener when both resolve (more immediate, no
  third-party indexing lag), matching the Pons-aware "don't wait on a
  slower generic path when on-chain data already suffices" principle.
- **TokenAnalysisService fast/slow split**: root-caused the timeout (a
  binary-search deployment-block lookup plus a Blockscout holder call,
  run sequentially) and fixed it architecturally — `getFastTokenInfo()`
  and `getSlowTokenInfo()` are now independent, the latter never blocking
  the former.
- **Newly wired feature groups** (reusing existing Phase 4 analyzers,
  no scoring-logic duplication): contract features (fast, always
  attempted), token age (free, pure), liquidity analysis (free, pure,
  honestly reports "first known reading" rather than a fabricated trend),
  momentum (free, pure, honestly reports "insufficient history" for a
  first observation), market flow (best-effort, Uniswap-V3-pool-shaped
  only), deployer analysis (best-effort, needs a resolved deployer
  address). Entry quality and holder-structure-in-the-right-shape remain
  deliberately unwired — see `docs/LIVE_INTELLIGENCE.md` §1's caveats for
  why forcing either would mean fabricating evidence rather than
  reporting an honest gap. Unresolved Scout wallet mentions are unchanged
  from Phase 3: UNAVAILABLE/UNRESOLVED, never zero, never a fabricated
  score (`walletIntelligenceScorer.ts` untouched).
- **Confidence diagnostics surfaced, not reinvented**: `LiveSignalRecord`
  now carries `confidenceBreakdown` (the confidence engine's own existing
  completeness/criticalFeatureAvailability/walletSampleSize/freshness
  components) and `dataQuality` (the existing per-feature-group
  KNOWN/PARTIAL/UNAVAILABLE/STALE states) alongside the existing
  `providerCalls` (per-provider OK/TIMEOUT/ERROR/SKIPPED outcomes) — no
  second confidence formula was created; every value already existed on
  `SmartSelectionResult` and was previously discarded rather than
  persisted.
- **Fail-closed staleness fix**: `signalProcessor.ts`'s stale-signal check
  used `scoutSignal.postedAt` (Scout's own, externally-sourced timestamp)
  in an unguarded `new Date(x).getTime()` — the same class of bug the
  Phase 7.1 §2 NaN fix addressed inside scoring, but in the live pipeline
  itself. Fixed via the same `safeAgeSeconds()` helper: an unparseable
  `postedAt` now fails CLOSED (rejected as `STALE_SIGNAL`) rather than
  silently passing an undeterminable age through as "not stale."
- **Safe caching** (`src/shared/tokenMetadataCache.ts`,
  `src/market-data/cachingPonsV2Provider.ts`): token metadata (name/
  symbol/decimals/totalSupply) is genuinely time-independent, so it's
  cached with a 24h TTL and shared safely between the live path and
  `src/backtesting`'s venue resolver (decimals don't vary by decision
  timestamp). Pons launch metadata is cached with a short, 60s TTL —
  live-only, deliberately NOT wired into the shared backtesting resolver,
  since that function serves multiple different historical decision
  timestamps per backtest run and Phase 6.6's graduation-boundary
  correctness guarantee depends on re-checking phase/graduation fresh
  per decision. Price, liquidity, and recent flow are never cached.
- **Burst-concurrency verification**: `livePipeline.test.ts` now includes
  a 5-signal burst test (none dropped, all eventually processed), a
  bounded-concurrency test (observed concurrent signal count never
  exceeds the configured limit even under a 6-signal burst), and a
  one-slow-signal-does-not-block-the-others test.

## Phase 7.2 — Pons live market intelligence & decision-latency improvement

Full technical detail lives in `docs/LIVE_INTELLIGENCE.md` §4-§6 and
`docs/ROBINHOOD_MARKET_DISCOVERY.md`'s Phase 7.2 section. Summary:

- **Shared market context, resolved once**: `src/live/resolvedMarketContext.ts`
  checks whether a Scout token is a Pons V2 launch (curve or graduated to
  V4) exactly once per signal, dispatching price/liquidity/flow to a
  venue-specific fast path instead of Phase 7.1's generic on-chain
  resolution (which re-ran Pons/V3 discovery for every question and timed
  out on venue resolution alone for graduated tokens).
- **New venue-specific readers**: `PonsCurveMarketReader` (curve price
  from the most recent bonding-curve trade, reserve liquidity from a
  direct balance read, flow from `CurveBuy`/`CurveSell` events) and
  `UniswapV4FlowReader` (flow and price observations from `Swap` events
  filtered to the resolved PoolId, with direction classified from the
  sign of the Scout token's own balance delta — UNKNOWN when not safely
  determinable). Both are deliberately separate from their
  backtesting-only counterparts (which are correctly USD-gated for
  historical comparability) — these always return quote-denominated
  values and add USD only via the same, unchanged `convertToUsd`.
- **Momentum enrichment**: when a Pons reader finds real recent trades
  with a resolvable USD price, ALL of them (each with a real timestamp)
  feed the existing, unmodified `MomentumAnalyzer` — genuine multi-point
  momentum instead of always a single observation.
- **A second real timeout-boundedness bug**, found the same way Phase
  7.1's `TokenAnalysisService` bug was: live verification, not synthetic
  tests. Venue resolution's own internal V3 candidate-probing loop wasn't
  covered by the outer `withTimeout`, so the "shared decision deadline"
  wasn't actually being enforced end-to-end. Fixed by wrapping the whole
  chain in one timeout.
- **WATCH observation persistence** (`data/live/watch-observations.ndjson`,
  optional — `LivePipeline`'s `watchObservationRepository`): a WATCH
  decision is never a trade and is never re-scored, but its market is now
  polled on the same interval as open positions, purely to record what
  happened afterward. A watch stops being polled once it falls outside a
  configurable observation window (default 4h); one broken observation
  never stops the others, matching the pipeline's existing per-item
  failure isolation.
- **Honest live-verification result**: all of the above is verified
  correct and fast by 30+ deterministic unit tests and a standalone
  diagnostic script run one-token-at-a-time. Inside the live pipeline
  itself, under real concurrent RPC load (this chain running alongside 4
  other RPC-heavy branches per signal, across up to 5 signals at once),
  the Pons-aware chain timed out on all 7 real signals in every replay
  run performed — including after deliberately widening its own timeout,
  which didn't help and was reverted. See `docs/LIVE_INTELLIGENCE.md` §5
  for the full, root-caused (RPC contention, not a design flaw) account.

Smart Selection's weights/thresholds were not touched. Whether real
confidence numbers moved, and by how much, is reported honestly in the
Phase 7.2 completion report rather than targeted — see
`docs/LIVE_INTELLIGENCE.md` §5's explicit "55 is a decision boundary, not
a development objective" framing.

## Phase 7.3 — RPC performance & live pipeline reliability

Full detail: `docs/RPC_PERFORMANCE.md`. Summary:

- **A single global RPC concurrency limiter**
  (`src/blockchain/rpcConcurrencyLimiter.ts`), priority-aware
  (CRITICAL/MEDIUM/LOW), shared across every live intelligence branch —
  never a separate limiter per analyzer. Configurable via
  `ROBINHOOD_RPC_MAX_CONCURRENCY` (default 4, chosen from evidence: 8
  made no measurable difference). `SIGNAL_PROCESSING_CONCURRENCY` (the
  existing `maxConcurrentSignals`) is a fully separate, still-independent
  control.
- **RPC instrumentation** (`src/blockchain/rpcInstrumentation.ts`,
  `instrumentedChainClient.ts`) — every call tagged with the current
  signal id (via `AsyncLocalStorage`, `src/shared/signalContext.ts`, no
  new function-signature plumbing), caller, method, latency, status, and
  concurrency-at-start. `npm run live` prints a diagnostic summary at
  shutdown.
- **A single-signal control test** (`scripts/singleSignalControl.ts`,
  Phase 7.3 §26) — the key new evidence: each of the 4 real Pons signals,
  run individually with zero concurrent competition, still failed to
  resolve venue within the shared deadline, and raising RPC concurrency
  4→8 did not help. This means the Phase 7.2 "it's contention" hypothesis
  was too narrow — the dominant cost is a single slow, necessary
  `eth_getLogs` call for flow events, not concurrent RPC pressure.
- **A real deduplication fix**: `TokenAnalysisService` was fetching the
  same token's metadata a second time, uncached, duplicating
  `resolveMarketContextOnce`'s own fetch. Now shares the same cache —
  measured to cut RPC requests per signal from up to 19 to 4, without
  changing the outcome (confirming it was a secondary cost).
- **Deadline-aware scheduling**: the lowest-priority, latest-starting
  step (deployer enrichment) now checks the remaining shared budget
  before starting, recorded as the new `DEADLINE_SKIPPED` status —
  distinct from `TIMEOUT` — when too little time remains to plausibly
  finish.
- **WATCH observation and position monitoring** now run on their own,
  separately-instantiated LOW-priority provider set, so background
  re-checks of already-decided signals can never compete with a fresh
  Scout call's CRITICAL/MEDIUM RPC work.
- **Honest scope**: the full 5-value concurrency benchmark matrix and the
  complete deterministic load-test suite (10 scenarios) described in the
  phase brief were not exhaustively built, given the depth this
  investigation itself required to reach a confident, evidence-based root
  cause. What was measured is reported in full in
  `docs/RPC_PERFORMANCE.md`.

## Phase 7.4 — continuous live observation

`npm run live` was already capable of running indefinitely for a genuine
Telegram connection (only REPLAY mode has a natural end — the fixture is
finite); Phase 7.4 added the accounting and reporting layer around it:

- **REPLAY vs. LIVE separation** (`LiveSignalRecord.mode`): every record
  is tagged explicitly, set from `isReplay` in `scripts/liveScout.ts` and
  threaded through every return path in `signalProcessor.ts` — including
  the early-rejection path (PERFORMANCE_UPDATE, missing contract address,
  etc.), which a first implementation missed, silently mis-tagging every
  rejected message as LIVE regardless of the real run mode (caught by a
  regression test before it could corrupt a report). `npm run live:status`
  and `npm run live:report` both read this field and never combine the
  two.
- **Per-signal console output**: `[SCOUT] token: ... venue: ... price:
  ... flow: ... confidence: ... score: ... decision: ... latency: ...
  paper_position: ...` for every eligible call, via an `onRecordProcessed`
  hook on `LivePipeline` — a `PERFORMANCE_UPDATE` gets one line noting
  it's not a new opportunity, never a full decision line.
- **Post-decision observation at fixed horizons** (`+1m/+5m/+15m/+30m/
  +1h/+4h`, `src/live/livePipeline.ts`'s `POST_DECISION_HORIZONS`):
  extends the existing Phase 7.2 WATCH-observation mechanism (same
  poll cycle, same repository) to also track legitimate `TRADE_CANDIDATE`
  decisions, and to fire each horizon exactly once (rather than
  continuously re-polling) — never holding the live decision open waiting
  for it. Each `WatchObservation` now carries `horizonLabel` and
  `returnFromDecisionPct` (computed from `LiveSignalRecord.decisionPriceUsd`,
  the price actually decided against — never re-derived from a later
  observation). On restart, horizons already elapsed before the crash are
  treated as handled rather than re-fired (§25 "where practical" — avoids
  duplicate observations at the cost of not guaranteeing zero gaps for a
  horizon that fell exactly during downtime).
- **`npm run live:status`** — a point-in-time snapshot from the persisted
  NDJSON files (signal counts, decision distribution, latency, provider
  failures, open/closed paper positions), safe to run alongside a live
  process.
- **`npm run live:report`** — accumulated LIVE-only statistics: decision
  distribution, average confidence, market-flow availability, venue
  distribution, paper entries, and post-decision observation returns
  bucketed by horizon and by WATCH vs. TRADE_CANDIDATE — the evidence base
  a future strategy change should be based on.
- **Reconnect**: `TelegramMtprotoAdapter` relies on GramJS's own
  `connectionRetries` for transient MTProto disconnects (never a custom
  busy-loop); restart-level duplicate protection is the existing
  `recoverFromDisk`/`isDuplicate` dedup state, unchanged.

**Not exercised live in this phase**: no Telegram credentials
(`TELEGRAM_API_ID`/`API_HASH`/`SESSION_STRING`) were configured in this
environment, so the real Telegram connection path was not verified
against live network traffic — only via REPLAY and unit tests. This is
disclosed, not assumed working.

## Explicitly not built (per the stop condition)

No live execution, no wallet signing, no private keys, no transaction
broadcasting, no BasedBot integration, no Smart Selection bypass, no
Smart Selection weight/threshold changes, and no autonomous token
scanning (Pons/Uniswap/GeckoTerminal are consulted only for a token Scout
already named — see `ARCHITECTURE.md`'s invariant section).
