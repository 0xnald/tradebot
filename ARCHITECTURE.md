# Scout Alpha — Architecture

## Pipeline overview

```
Scout signal
  -> ingestion                (capture raw signal)
  -> signal-parsing           (extract token/contract info)
  -> token-analysis           \
  -> blockchain                >  independent research, run in parallel
  -> market-data              /
  -> wallet-intelligence      /
  -> scoring                  (Smart Selection Score)
  -> risk                     (BUY / WAIT / IGNORE, veto authority, position sizing)
  -> paper-trading | execution (paper only for now)
  -> position-management      (take-profit / stop-loss / trailing exit)
  -> analytics + backtesting  (record result, feed back into scoring)
```

Everything downstream of `signal-parsing` is our own independent analysis.
Scout only ever supplies the initial lead.

**Two parallel realizations of this same pipeline exist (Phase 7):**
`src/backtesting/` replays a historical Scout dataset (`npm run backtest`)
for strategy validation; `src/live/` runs the same shape event-driven
against the real, live Scout channel (`npm run live`) for real-time paper
trading. Both call the identical, unmodified `SmartSelectionEngine` — see
`docs/LIVE_PIPELINE.md` for the live path's specifics (low-latency,
event-driven ingestion, bounded concurrency, independent position
monitoring, restart recovery). Live intelligence gathering is honestly
scoped narrower than the full Phase 2-4 analyzer set for now — documented
in `docs/LIVE_PIPELINE.md` rather than silently assumed complete.

## Invariant: Scout is the only strategy entry point

Market-intelligence sources (Pons, Uniswap V3/V4, GeckoTerminal, and any
future addition) answer exactly one question: *"given a Scout token, where
and how does it trade?"* They take a token/pool identifier as **input** —
`PoolDataProvider.discoverPools(contractAddress)`,
`PonsV2Provider.getLaunchInfo(tokenAddress)`,
`HistoricalPriceProvider.getCandles(chainId, poolAddress, ...)` — and none
of them exposes an "enumerate/discover new tokens" method. They must never
originate a trading candidate: no scanning Pons launches, Uniswap pools,
or GeckoTerminal for "opportunities" and feeding the result into Smart
Selection, backtesting, or (once it exists) paper/live trading.

This already holds structurally: `SmartSelectionInputs.scoutSignal` is a
required field (not optional — the type system rejects a call without
one), `SmartSelectionEngine.evaluate()` is only ever invoked from two
places — `backtestRunner.ts`'s `for (const scoutSignal of eligibleSignals)`
loop (historical) and `signalProcessor.ts`'s `processRawMessage()` (live),
which only ever runs on a message that just came through
`parseScoutMessage()`. Neither path has any way to append a signal from
anywhere else. `src/backtesting/scoutOriginationBoundary.test.ts`
proves this behaviorally: an "eager" fake market-intelligence layer that
already knows about real tokens Scout never mentioned is confirmed to
never be queried about them, and an empty Scout signal list produces zero
Smart Selection decisions.

## Module boundaries

| Module | Responsibility | Must NOT do |
|---|---|---|
| `src/ingestion` | Capture raw signals from a configured source (initially the public `scoutrobinhood` Telegram channel) | Interpret content, automate UI clicks, act on signals |
| `src/signal-parsing` | Extract token symbol / contract address / chain from raw signal text | Fetch external data, make trading decisions |
| `src/blockchain` | Read on-chain facts for a contract/wallet on Robinhood Chain | Sign or submit transactions |
| `src/market-data` | Price, liquidity, volume for a token | Fabricate data when a provider is unavailable |
| `src/wallet-intelligence` | Derive wallet quality (win rate, profitability, entry quality, clustering) from on-chain history | Trust an external channel's "elite wallet" labels without independent verification |
| `src/token-analysis` | Contract-level checks: age, holder distribution, deployer behavior, honeypot/tax | Make a buy/wait/ignore decision |
| `src/scoring` | Combine all upstream features into a transparent `IGNORE`/`WATCH`/`TRADE_CANDIDATE` decision (`SmartSelectionResult`) — never executes, never signs | Call an LLM in the numerical scoring path; treat `TRADE_CANDIDATE` as an executed trade |
| `src/risk` | Turn a `SmartSelectionResult` into a `RiskDecision` and `TradeDecision`; can veto any trade | Be bypassed by any other module, including the LLM |
| `src/paper-trading` | Simulated execution and ledger (`TRADING_MODE=paper`) | Touch any real wallet or transaction |
| `src/execution` | Real execution adapters (Uniswap/UniswapX on Robinhood Chain) | Run while `TRADING_MODE` is not `live`; reverse-engineer BasedBot or any undocumented API |
| `src/position-management` | Manage open positions: TP/SL/trailing exits | Open new positions |
| `src/backtesting` | Replay historical records to evaluate strategy changes | Use data unavailable at original decision time (no lookahead) |
| `src/live` | Event-driven live pipeline: signal lifecycle, bounded-concurrency queue, real-time intelligence gathering, paper trading engine, position monitoring (Phase 7) | Sign, broadcast, or touch a real wallet; scan for tokens independently of Scout; block signal ingestion on position monitoring or vice versa |
| `src/analytics` | Performance reporting over trade results | — |
| `src/shared` | Cross-cutting utilities (logging, error types) | Accumulate unrelated logic |
| `src/types` | Shared data contracts (see below) | Contain behavior |
| `src/storage` | Persist and look up captured signals, backtest runs, live signal records, and paper positions, each behind its own repository | Leak into `signal-parsing`; mix concerns across repositories |
| `config` | Load/validate environment configuration, including the `TRADING_MODE` gate | Allow live mode before it is implemented and reviewed |

## Lifecycle & auditability

Every signal is assigned an id at ingestion and passes through recorded
stages:

```
RECEIVED -> ANALYZED -> ACCEPTED/REJECTED -> PAPER_ENTRY
-> POSITION_MANAGEMENT -> EXIT -> RESULT
```

(`SignalLifecycleStage` in `src/types/domain.ts`.) Each stage transition
should be persisted with enough detail to reconstruct why a decision was
made — this is what makes the system auditable and backtestable.

## Trading mode gating

`TRADING_MODE` is `paper` or `live` (see `.env.example`). Only `paper` is
supported right now. Live execution is not just "off by default" — it does
not exist in the codebase yet. When it's eventually built, the gate belongs
in `config` (refuse to start in `live` mode until explicitly implemented)
and again in `execution` (refuse to submit any transaction unless the
active mode is `live` and that path has been reviewed).

## LLM boundary

An LLM may be used for narrow reasoning/classification sub-tasks where it
genuinely adds value — e.g. interpreting free-text signal wording, or
classifying a deployer's behavior pattern into a category. It must not be
assumed capable of predicting profitability on its own.

Rules:

- The LLM's output is one input feature into `scoring`, never the whole
  score.
- The LLM never has custody of keys and never signs or submits transactions.
- `risk` sits downstream of everything, including any LLM-derived input,
  and can veto regardless of what the LLM or the score concluded.

## Risk engine authority

`src/risk` is the single point of trade-approval authority. It can veto a
trade for any configured reason (exposure limits, daily loss limits, stale
or missing data, etc.), and nothing else in the system can override that
veto.

## Tech stack

- **Language/runtime:** TypeScript on Node.js ≥ 20. Chosen because the
  execution side of this system (Uniswap/UniswapX on an EVM chain) has the
  strongest, best-maintained tooling in this ecosystem (viem/ethers,
  Uniswap SDKs), and keeping ingestion/analysis/execution in one language
  avoids an unnecessary serialization boundary around the trade-decision
  path.
- **Persistence:** not yet chosen (see `PROJECT_PLAN.md`).
- **Scoring/ML:** starts in-process; if a model needs a runtime Node can't
  serve well, it becomes a separate, explicitly justified service behind a
  defined interface — not a default assumption.

Dependencies added so far, each justified at the point it was needed
(see `package.json`):

- **`telegram` (GramJS)** — a user-mode MTProto client, needed because
  Telegram's Bot API cannot subscribe to posts from a channel we don't
  administer (see `src/ingestion/README.md`). This is the standard,
  actively maintained open-source implementation of Telegram's own
  documented protocol for user applications — not a reverse-engineered or
  undocumented access path.
- **`tsx`** (dev only) — runs TypeScript directly for `npm run ingest:dev`
  and `npm test`, avoiding both a separate build step before every run and
  a second test framework (Node's built-in `node:test` + `node:assert`
  cover testing needs without another dependency).
- **`viem`** — added in Phase 2 as the EVM client library for
  `RobinhoodChainClient`, per the project brief's own suggestion. Chosen
  over `ethers` for its smaller footprint, native TypeScript types, and a
  `custom()` transport that makes mocking RPC responses in unit tests
  straightforward (see `src/blockchain/robinhoodChainClient.test.ts`).

No database driver or general-purpose HTTP client has been added —
`src/shared/fetchJson.ts` wraps the platform `fetch` (available natively in
Node ≥ 20) rather than adding `axios`/`node-fetch`. Each future module's
real dependencies are proposed and justified when that module is actually
implemented.

## Phase 1 finding: where Scout's data actually lives

Before building the parser, real messages were captured from the public
`https://t.me/s/scoutrobinhood` preview (see
`src/ingestion/fixtures/README.md`). The load-bearing finding: **the
contract address never appears in a Scout message's visible text** — only
inside its linked buttons (DexScreener/GMGN/BasedBot-deeplink/GeckoTerminal/X
search), each redundantly encoding the same address. Wallet addresses shown
in-text are truncated (`0x3430…c941`), not usable for on-chain lookups. Full
schema, both observed message templates, and exactly what Scout does vs.
doesn't provide are documented in `src/signal-parsing/README.md` — that
document, not this one, is the source of truth for the message format,
since it's derived directly from captured data.

## Phase 2 finding: what's on-chain vs. what needs an indexer

Full research, official sources, and live-test results are in
`docs/DATA_SOURCES.md` — that document is the source of truth for Phase 2's
data model, not this one. The short version: token metadata, deployment
block/timestamp, and deployer address are all obtainable directly from the
chain (no indexer needed — see `RobinhoodChainClient`); holder distribution
and historical price/volume aggregates are not, and come from third-party
indexers (Blockscout, DexScreener) that were empirically tested, not
assumed to work. `TokenMarketData.marketCapUsd` is a documented example of
"do not fabricate": it's only ever a pass-through of a provider's own
figure, `null` with a reason otherwise — never computed locally from total
supply.

## Phase 3 finding: wallet identity can't be resolved from Scout, and performance needs a defined entry/exit

Full research and live-test results are in `docs/WALLET_DATA_SOURCES.md`.
Two load-bearing findings for this module's design:

1. Scout's truncated wallet strings (`0x3430…c941`) are **not recoverable**
   to a full address from anything Scout publishes — not the text, not a
   hidden formatting entity, not any linked button (verified directly
   against the raw captured message data, not assumed). Every wallet from
   a real Scout message is therefore `confidence: "unresolved"` in
   `WalletIdentity` — a documented limitation, not a gap to paper over with
   a probabilistic guess (a swap-log timing/amount correlation approach was
   considered and deliberately rejected — see the data-sources doc).
2. "Is this trade profitable?" requires a matched entry AND exit with known
   USD values — `walletTradeMatcher.ts` FIFO-matches BUY→SELL per token and
   defines WIN/LOSS/OPEN/UNKNOWN explicitly (see
   `src/wallet-intelligence/README.md`). Because no verified provider gives
   historical USD values yet, real trades mostly land in OPEN/UNKNOWN — the
   logic is fully implemented and tested against synthetic data with known
   values, but today's real on-chain-only data doesn't carry what a
   WIN/LOSS verdict needs. This is correct, honest behavior.

## Phase 4 finding: the public RPC is not an archive node, and features are transparent, not scored

Full formulas, thresholds, and live-test results are in
`docs/TOKEN_MARKET_INTELLIGENCE.md`. Two load-bearing findings:

1. Directly probing the public RPC found `eth_getCode` at a historical
   block succeeds ~6,000 blocks back from the tip and fails ~8,000 blocks
   back — this RPC does not retain old state. `findContractDeploymentBlock`
   (Phase 2, reused by Phase 4's pool-age lookup) genuinely fails for old
   contracts as a result — confirmed live against Robinhood's own
   canonical WETH and its pool. Every caller already catches this and
   reports the field as unavailable; it's a real capability gap, not an
   unhandled bug. See `docs/DATA_SOURCES.md` §1.
2. Every Phase 4 analyzer returns **features**, never a score or a
   safety verdict — `ContractFeatureDetection`'s `"not_detected"`
   explicitly does not mean safe, `MarketAnomalyFindings` never uses
   "malicious" or "rug" language, and every numeric threshold used
   anywhere in Phase 4 is a disclosed constructor option with a stated
   rationale, restated in the result's own `thresholds` field where
   applicable (`MarketAnomalyFindings.thresholds`).

## Phase 5 finding: score and confidence must be computed completely separately

Full architecture, every weight/threshold, and what remains statistically
unvalidated: `docs/SMART_SELECTION.md`. The load-bearing design decision:
`overallScore` only ever averages the feature groups that actually
produced a value (missing data is excluded, never treated as 0), while
`confidence` is a fully independent 0-100 number measuring how complete
and fresh that evidence is. Live-tested proof this isn't just a claim: an
opportunity with only one of nine feature groups computable scored 100 on
that one group alone (correct, since it's the only evidence) but 15.2 on
confidence, and was separately hard-blocked to `IGNORE` — score, confidence,
and hard blockers are three independent gates, and `TRADE_CANDIDATE`
requires passing all three. `src/scoring` now implements this (previously
a placeholder); it makes zero network calls and calls no LLM — the
"Smart" in Smart Selection is entirely deterministic, versioned
(`smart-selection-v1`) heuristics.

## Phase 6 finding: most real Scout memecoins launch via Pons Family, not plain Uniswap V3

Full methodology, real run results, and every honest limitation:
`docs/BACKTESTING.md`; full on-chain verification record: `docs/DATA_SOURCES.md`
§7. `src/backtesting` consumes the real, unmodified Phase 5
`SmartSelectionEngine` — it never reimplements scoring — and adds a
`LookaheadGuard` as the single enforcement point for "no feature observed
after the decision timestamp may influence a historical decision"
(`lookaheadGuard.test.ts` proves this directly for price, liquidity,
holder, and wallet data).

Running `npm run backtest` against the real 2026-09-04 fixture first found
Phase 2's on-chain pool discovery (`UniswapV3PoolProvider`, the single
documented Uniswap V3 factory) returning **zero pools for 5 of 7** real,
actively-Scout-called memecoins, despite GeckoTerminal independently
showing real markets for them. Root-caused, not left as a mystery: **4 of
the 7 are confirmed Pons Family V2 bonding-curve launches** — verified via
`getLaunchedToken()` on the real, on-chain-confirmed V2 factory
(`0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` — an outside-supplied
address for this factory turned out to be invalid, not even a well-formed
address; verify on-chain, not from a claim). Pons V2 tokens are invisible
to Uniswap V3 discovery by construction: pre-graduation they trade on a
bonding curve (no DEX pool exists yet), and post-graduation they move to a
**Uniswap V4** pool, addressed by a `bytes32 PoolId` rather than a
deployed contract address — and that PoolId turned out to be fully
computable on-chain (verified to match GeckoTerminal's own reported id
exactly for a real graduated token). `src/market-data/ponsV2Provider.ts`
implements this discovery and is tried before Uniswap V3 in
`signalReconstructor.ts`. The remaining 3 signals are not Pons — one
(BABA) is a plain standalone Uniswap V3 deployment; two (BUFO and one CRC
token) use a still-unidentified mechanism, explicitly left open rather
than guessed at.

With Pons discovery wired in, the real backtest run improved from 0/7 to
**1/7 signals reaching a full valid entry and exit** (the rest resolved a
correct on-chain venue but hit GeckoTerminal indexing gaps on very fresh
pools) — still far too small a sample for any selection-lift conclusion,
but a concrete, honestly-reported improvement traceable to a real,
verified root cause rather than an unexplained gap.

## Phase 7 finding: the two independent responsibilities genuinely don't block each other, and event-driven ingestion already existed

Full methodology: `docs/LIVE_PIPELINE.md`. The change of direction for this
phase — live, event-driven paper trading rather than only historical
batch backtesting — turned out to need less new low-level infrastructure
than expected: `TelegramMtprotoAdapter` (Phase 1) was **already
event-driven** (GramJS's `NewMessage` handler, not polling); Phase 3's
`ConcurrencyLimiter` was directly reusable as the bounded-concurrency
signal queue; Phase 6.6's on-chain venue-resolution and event-based price
reconstruction generalized to live "current price" lookups by simply
passing `now()` instead of a historical decision timestamp. The real new
work was orchestration (`src/live/livePipeline.ts`) and the paper-trading
engine/position-manager themselves.

A real, pre-existing gap was found and fixed in the process:
`src/ingestion/runDev.ts` calls `adapter.stop()` immediately after
`adapter.start()` resolves — which, for the live Telegram adapter
specifically, resolves as soon as it's subscribed, not when messages stop
arriving. `runDev.ts` would therefore disconnect right after connecting,
without ever actually listening. `scripts/liveScout.ts` fixes this for
the live pipeline (keeps the process alive until `Ctrl+C`); `runDev.ts`
itself is untouched, since fixing it wasn't in this phase's scope.

Two real bugs were caught by this phase's own tests before they could
matter: (1) exact-boundary stop-loss/take-profit comparisons silently
failing to trigger due to IEEE 754 floating-point representation error
(`(0.8 - 1.0) / 1.0 * 100` is `-19.999999999999996`, not `-20`) — fixed by
rounding before comparison; (2) a zero-capital portfolio computing a
`$0` position size that then "succeeded" as a no-op trade instead of
being rejected as insufficient capital. Both are documented with their
regression tests in `docs/LIVE_PIPELINE.md`.

Live intelligence gathering was deliberately narrower than Phase 5's full
input surface at the end of this phase (current price + token contract
info + wallet associations from message text only) — an explicit,
disclosed scope decision, not a gap discovered later. Phase 7.1 (below)
wired most of the remaining feasible groups; Smart Selection remains
unmodified throughout and handles a partial input exactly as designed:
score excludes missing groups, confidence reflects the gap.

## Phase 7.1 finding: sequential fan-out, not a slow provider, was the real latency problem

Full methodology: `docs/LIVE_INTELLIGENCE.md`. Phase 7's live
verification showed `TokenAnalysisService` hitting its full 4-second
budget on every real signal — the instinctive fix would be "raise the
timeout," which was explicitly prohibited. Investigating instead found
the real cause: three genuinely slow-but-independent operations (chain
metadata, a binary-search deployment-block lookup, a Blockscout holder
call) were awaited **sequentially** inside one method, so their
worst-case latencies stacked. The same shape of bug existed one level up:
`liveIntelligenceGatherer.ts` ran DexScreener, then conditionally an
on-chain price fallback, then token analysis — three more sequential
steps. Both were fixed the same way: split into independent pieces
(`getFastTokenInfo`/`getSlowTokenInfo`; on-chain price and DexScreener
resolved concurrently, preferring on-chain when both succeed) and fan
them all out under one shared, bounded deadline via `Promise.all`,
instead of a chain of `await`s. This is a general lesson worth stating
plainly: **a latency budget that's applied per-step to a sequential chain
is not the same as the same budget applied to the whole operation** — the
architecture, not the timeout number, was the bug.

A second, unrelated correctness gap was found and fixed the same way as
Phase 7.1's headline NaN fix: `signalProcessor.ts`'s stale-signal check
parsed Scout's own (externally-sourced) `postedAt` timestamp without
guarding against an unparseable value, which would have silently been
treated as "not stale" (since `NaN > threshold` is always `false`) rather
than correctly failing closed. Fixed with the same `safeAgeSeconds()`
helper built for the scoring-module fix, reinforcing that "unguarded
external-timestamp parsing" was a pattern worth checking everywhere it
appears, not just where it was first found.

Newly wired feature groups (contract features, token age, liquidity
analysis, momentum, best-effort market flow and deployer analysis) all
reuse Phase 4's existing analyzers unchanged — no scoring logic was
duplicated or reimplemented for the live path. Two groups (entry quality,
holder-structure-in-the-right-shape) were investigated and deliberately
left unwired, with the reasoning recorded in
`docs/LIVE_INTELLIGENCE.md` §1, because wiring them as requested would
have meant fabricating evidence rather than reporting an honest gap —
consistent with this project's established posture (e.g. Phase 6.6
leaving 2 unidentified backtest tokens unresolved rather than guessing).

## Phase 7.2 finding: "resolve once" applies to venue detection, not just to a single provider call

Full methodology: `docs/LIVE_INTELLIGENCE.md` §4-§6,
`docs/ROBINHOOD_MARKET_DISCOVERY.md`. Phase 7.1's live verification left
market flow entirely unwired for Pons/V4 tokens and market-flow/on-chain
price both timing out 7/7. Directly profiling the 7 real eligible
signals (outside the pipeline's own bounded timeout, to see ground truth)
found the actual cause: 4 of the 7 ARE real Pons V2 launches, and the
live path was re-discovering that fact — and then discarding it — every
time it needed a different piece of information (price, then separately
flow), each time paying the full cost of checking Pons and falling
through to a Uniswap V3 discovery loop that, for a confirmed Pons token,
always found nothing.

The fix generalizes Phase 7.1's "resolve once" principle (already applied
to fast/slow token info) to venue detection itself:
`resolveMarketContextOnce` determines curve/graduated-V4/Uniswap-V3/unknown
exactly once per signal, and every downstream question (price, liquidity,
flow, momentum) is answered from that same resolution via a
venue-specific reader — `PonsCurveMarketReader` or `UniswapV4FlowReader`,
both deliberately kept separate from their backtesting counterparts since
those are correctly USD-gated for historical comparability in a way a
live decision should not be (a tokenized-equity-quoted Pons token would
otherwise lose ALL price/flow evidence, not just its USD conversion).

A second instance of Phase 7.1's own lesson recurred here: an
end-to-end timing regression (venue resolution's internal candidate-pool
loop wasn't covered by the outer timeout) was found only by real
live/replay verification, not by the deterministic unit tests (whose fake
providers resolve instantly and can't exhibit a multi-call latency
stack). Confirms that this verification step is load-bearing, not a
formality, for exactly the class of bug that concurrency refactors are
prone to introducing.

**Honest limit of what's actually been observed working end-to-end**:
after that fix, live/replay verification still showed the Pons-aware
chain timing out on all 7 real signals — including a deliberate,
evidence-based attempt to give it a larger dedicated budget (7000ms
instead of 4000ms), which made zero difference to the completion rate
while making latency worse, and was reverted rather than kept. The
standalone diagnostic script proves the underlying identification logic
is correct and fast enough in isolation; the live pipeline's concurrent
RPC load (this chain runs alongside 4 other RPC-heavy branches per
signal, across up to 5 signals at once, against the same unauthenticated
public RPC) is the more likely bottleneck, not the architecture. See
`docs/LIVE_INTELLIGENCE.md` §5 for the full account — reported honestly
rather than glossed over, consistent with this project's standing
practice of treating a negative or incomplete verification result as
useful evidence, not a failure to hide.

## Phase 7.3 finding: concurrency control was necessary but not sufficient — the real bottleneck is one slow call, not contention

Full methodology: `docs/RPC_PERFORMANCE.md`. Phase 7.2 hypothesized RPC
contention under concurrent replay load as the reason Pons/V4 market
intelligence never reached Smart Selection. Phase 7.3 built the
infrastructure to test that directly: a single, shared, priority-aware
global RPC concurrency limiter (`src/blockchain/rpcConcurrencyLimiter.ts`)
and full request instrumentation
(`src/blockchain/instrumentedChainClient.ts`), both verified correct by
15 deterministic tests.

The decisive test was simpler than a benchmark matrix: run each of the 4
real Pons signals **individually** through the exact production
`SignalProcessor`, with zero other signals competing for anything
(`scripts/singleSignalControl.ts`). Venue resolution still failed within
the shared deadline — and raising the RPC concurrency ceiling from 4 to 8
made no measurable difference, because the limiter never needed more than
4–6 concurrent slots regardless of how many were available. This is
conclusive: for a single signal, concurrency was never the constraint.
The actual bottleneck is a single, necessary, correctly-bounded
`eth_getLogs` call (fetching flow events) that is simply slow against the
public RPC — a finding consistent with, and now more precisely located
than, Phase 6.6's original observation that a full-depth log-fetch
cascade against a busy pool measured 150+ seconds in the worst case.

A real, separate inefficiency was found and fixed along the way:
`TokenAnalysisService` was independently re-fetching a token's metadata
that `resolveMarketContextOnce` (Phase 7.2) had already fetched and
cached — a genuine duplicate RPC round trip on every single signal, now
eliminated by sharing one cache. This measurably cut RPC volume (19 → 4
requests per signal) without changing the outcome, which is itself
useful confirmation that the duplicate fetch was a secondary cost, not
the critical-path one.

This is a good example of why this project insists on measuring rather
than assuming: the natural instinct after Phase 7.2 was to build more
concurrency control, and that control is real, tested, and worth having
— but building it and then measuring with it in place is what revealed
that concurrency was the wrong lever, redirecting the actual fix toward
the specific slow call instead of a general "add more capacity" approach
that would not have helped.

## Phase 7.4 finding: the "one slow call" was a provider policy limit, and fixing transport surfaced a second, different bottleneck

Phase 7.3's "one slow call" turned out (Phase 7.3B) to be a flat 10-block
`eth_getLogs` cap on the authenticated provider's plan — a policy limit,
not something any amount of retrying or timeout-raising could fix.
`src/blockchain/rpcRouting.ts` routes each bounded log query to whichever
of two configured RPC provider roles (PRIMARY/authenticated, LOG/public)
can actually serve its range, decided from `RpcProviderCapabilities`
before any request is made. Fixing transport didn't finish the job by
itself: once the log fetch started succeeding, resolving each returned
trade's block timestamp turned out to be happening sequentially rather
than concurrently, which alone could exceed the whole decision budget for
a busy pool — a second, previously-invisible bottleneck only visible once
the first one was actually removed. And under real multi-signal
concurrent load (vs. an isolated single-signal test), Pons classification
itself can still occasionally miss the shared decision deadline by
queueing behind other RPC work — a third, distinct, not-yet-addressed
constraint. Three different bottlenecks, three different classes of fix
(provider policy → routing, sequential I/O → concurrency, contention →
still open) — none of which resembled the others going in, which is why
this project keeps measuring rather than assuming the next fix is the
last one.

## Data contracts

Canonical shapes live in `src/types/domain.ts`: `ScoutSignal`,
`TokenContractInfo`, `TokenMarketData`, `PoolInfo`, `SwapRecord`,
`LiquiditySnapshot`, `HolderInfo`, `HolderDistribution`, `ProviderResult`,
`WalletProfile`, `WalletIdentity`, `WalletTrade`, `WalletRoundTrip`,
`WalletPerformanceSummary`, `WalletQualityFeatures`,
`WalletRelationshipSignal`, `ScoutWalletAssociation`,
`DataQualityState`, `DataQualitySummary`, `ContractFeatureDetection`,
`TokenAge`, `LiquidityAnalysis`, `MarketFlowAnalysis`, `MomentumAnalysis`,
`EntryQualityFeatures`, `MarketAnomalyFindings`,
`HolderConcentrationBreakdown`, `DeployerAnalysis`, `PoolQualityAssessment`,
`SignalMarketSnapshot`, `SmartSelectionDecision`, `FeatureContribution`,
`FeatureGroupScore`, `ExpectedValueEstimate`, `ChaseRiskClassification`,
`EntryChaseAssessment`, `HardBlockerResult`, `WalletEvidenceStatus`,
`WalletSignalAssessment`, `MarketRegimeAssessment`, `ConfidenceBreakdown`,
`SmartSelectionConfig`, `SmartSelectionFeatureSnapshot`,
`SmartSelectionResult`,
`ScoreBreakdown`, `RiskDecision`, `TradeDecision`, `PaperPosition`,
`TradeResult`, `LiveSignalLifecycleStage`, `TimestampedObservation`,
`LookaheadViolation`, `BacktestDataset`, `BacktestSignal`,
`BacktestDecision`, `LevelHitResult`, `HorizonReturn`, `BacktestOutcome`,
`BacktestPosition`, `BacktestCohort`, `BacktestBucketStats`,
`BacktestMetrics`, `SelectionLiftReport`, `CounterfactualOutcome`,
`DataAvailabilityReport`, `BacktestConfig`, `EquityCurvePoint`,
`PortfolioSimulationResult`, `BacktestRun`, `ReconstructionMethod`,
`MarketVenueType`, `MarketReconstructionFailureReason`,
`HistoricalObservation`, `MarketResolutionTrace`, `LifecycleEvent`,
`SignalRejectionReason`, `LiveSignalRecord`, `LiveProviderCallResult`,
`LiveProviderCallSummary`, `PaperPortfolioConfig`, `PaperTradeExecution`,
`PaperMarketStatus`, `PaperPositionSnapshot`, `LivePaperPosition`,
`LatencyStats`, `LivePipelineLatencyReport`. These are data-only — no behavior —
and exist so every module agrees on the shape of information flowing
through the pipeline.
