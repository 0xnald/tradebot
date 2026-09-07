# Scout Alpha — Project Plan

## Vision

Build an autonomous agent that receives opportunity leads from the Scout
Robinhood Telegram channel, independently researches and scores each one,
and only trades when our own system determines the setup has sufficient
expected value — on Robinhood Chain, via Uniswap/UniswapX.

## Core principle (non-negotiable)

Scout is an **opportunity source, not a buy instruction**. The agent must
never blindly copy Scout. Our value-add is a second layer of intelligent
selection, plus a risk engine with unconditional veto power.

## Status

The phase list below is the original plan and is kept as-is for history;
actual execution diverged from its exact grouping. What has really been
built, in order: Phase 0 scaffold; Phase 1 real Scout ingestion/parsing;
an on-chain Robinhood Chain data layer; wallet intelligence; token/market
intelligence; the Smart Selection Engine (deterministic `IGNORE`/`WATCH`/
`TRADE_CANDIDATE` scoring, no LLM); **backtesting & selection validation**
(`src/backtesting`, see `docs/BACKTESTING.md`), which reused the real
Smart Selection Engine unmodified; and, most recently, **Phase 6.6 —
historical market data reliability & reconstruction**
(`docs/ROBINHOOD_MARKET_DISCOVERY.md`), which root-caused the backtester's
coverage gap to a previously-unresearched launchpad (Pons Family, see
`docs/DATA_SOURCES.md` §7) and added on-chain event-based price
reconstruction (Pons bonding-curve trades, Uniswap V4 swaps via a
deterministically-computed PoolId, Uniswap V3 swaps) as a tier tried
*before* GeckoTerminal, with a correctness-critical rule enforced and
tested: a graduated launch's real on-chain graduation timestamp — never
its current phase — decides whether a historical decision sees the
pre-graduation curve or the post-graduation pool. The real dataset remains
too small (7 eligible signals) to measure whether selection beats the raw
baseline; two tokens' launch mechanism remains genuinely unidentified and
is left that way rather than guessed at.

Most recently, **Phase 7 — the live Scout → paper trading pipeline**
(`src/live`, see `docs/LIVE_PIPELINE.md`) added a second, event-driven
realization of the same pipeline: a live Telegram listener (reusing
Phase 1's already-event-driven `TelegramMtprotoAdapter` — no second
ingestion architecture) feeds a bounded-concurrency signal queue, real-time
intelligence gathering (current price/liquidity via the same on-chain
reconstruction Phase 6.6 built, plus token contract info and wallet
associations), the same unmodified `SmartSelectionEngine`, and a paper
trading engine with continuous position monitoring — all timestamped
per-stage for latency measurement, all persisted for restart recovery,
none of it touching a real wallet or transaction. Live intelligence
gathering was deliberately narrower than the full historical feature set
at the end of Phase 7 (documented, not hidden). No live trading, wallet
signing, or transaction broadcasting exists anywhere in the codebase, and
Scout remains the only strategy entry point for both the historical and
live paths (see ARCHITECTURE.md's "Invariant: Scout is the only strategy
entry point" and `src/backtesting/scoutOriginationBoundary.test.ts`).

Most recently, **Phase 7.1 — live intelligence completion & latency
optimization** (see `docs/LIVE_INTELLIGENCE.md`) closed most of that gap
without touching Smart Selection's weights/thresholds. It fixed a real
correctness bug (a NaN could reach `SmartSelectionResult` under
malformed/sparse input via an unguarded date parse feeding
`weightedAverage()` — root-caused, fixed at the source, hardened as
defense-in-depth, regression-tested); root-caused and fixed
`TokenAnalysisService`'s Phase 7 timeout (a sequential binary-search
deployment lookup plus a Blockscout call, not a too-small timeout) by
splitting it into independent fast/slow tiers; replaced the live
gatherer's sequential provider chain with a concurrent fan-out under one
shared, bounded deadline, preferring on-chain price data over DexScreener
when both resolve; wired contract features, token age, liquidity
analysis, momentum, and best-effort market flow/deployer analysis into
the live path by reusing Phase 4's analyzers unchanged; surfaced the
scoring engine's own existing confidence-component breakdown and
per-group data-quality states onto every live signal record instead of
discarding them; added narrowly-scoped caching for genuinely
time-independent data (token metadata, Pons launch metadata — the latter
live-only, never applied to the shared historical venue resolver); and
added burst-concurrency tests (5+ simultaneous signals, bounded
concurrency, one slow signal never blocking the others). Entry-quality
and full-shape holder-structure scoring remain deliberately unwired, with
the reasoning documented rather than worked around by fabricating
evidence. Zero real transactions; the confidence threshold for
`TRADE_CANDIDATE` was never lowered.

Most recently, **Phase 7.2 — Pons live market intelligence & decision-
latency improvement** (see `docs/LIVE_INTELLIGENCE.md` §4-§6,
`docs/ROBINHOOD_MARKET_DISCOVERY.md`) closed the biggest gap Phase 7.1's
own verification left open: market flow was entirely unwired for Pons/V4
tokens, and both market flow and on-chain price resolution timed out on
every real signal. Directly profiling the 7 real eligible Scout signals
found 4 of them ARE genuine Pons V2 launches (3 graduated to Uniswap V4,
1 still on its bonding curve) — and that the live path was
re-discovering, then discarding, that fact every time it needed a
different piece of information. The fix generalizes the "resolve once"
principle Phase 7.1 already applied to token analysis: a shared
`ResolvedMarketContext` determines the venue exactly once per signal, and
venue-specific readers (`PonsCurveMarketReader`, `UniswapV4FlowReader`) —
deliberately separate from their USD-gated backtesting counterparts —
answer price, liquidity, flow, and momentum from that single resolution,
always quote-denominated with USD added only when a trustworthy
conversion exists. A second timeout-boundedness bug (venue resolution's
own internal loop wasn't covered by the outer deadline) was found and
fixed the same way the first one was in Phase 7.1: by real live/replay
verification, not synthetic tests. A new, optional WATCH-observation
capability records what happened to WATCH decisions afterward — never a
trade, never re-scored, purely analytical. Smart Selection's weights and
thresholds were not touched, and the confidence threshold was not
lowered. Honestly reported: live/replay verification found the new
Pons-aware chain still timed out on all 7 real signals under the live
pipeline's concurrent RPC load, even after a deliberate, evidence-based
attempt to give it more time (reverted when it didn't help — see
`docs/LIVE_INTELLIGENCE.md` §5). The identification logic itself is
proven correct and fast in isolation (a standalone diagnostic script,
`scripts/profileScoutSignals.ts`, correctly identified all 4 real Pons
launches one at a time); getting it to complete inside the live
pipeline's concurrent load is left as genuine, documented follow-up work,
not claimed as solved.

Most recently, **Phase 7.3 — RPC performance & live pipeline
reliability** (see `docs/RPC_PERFORMANCE.md`) tested Phase 7.2's
concurrency hypothesis directly, by building the infrastructure to
measure it: a single, shared, priority-aware global RPC concurrency
limiter and full request instrumentation (signal id, caller, latency,
concurrency-at-start), both verified by 15 deterministic tests. The
decisive result came from running each of the 4 real Pons signals
individually through the exact production pipeline with zero concurrent
competition (`scripts/singleSignalControl.ts`): venue resolution still
failed within the shared deadline, and raising RPC concurrency from 4 to
8 made no difference. This proves concurrency was never the dominant
constraint — the real bottleneck is a single, necessary, correctly
bounded `eth_getLogs` call for flow events that is simply slow against
the public RPC. A genuine duplicate RPC round trip was found and fixed
along the way (`TokenAnalysisService` re-fetching metadata
`resolveMarketContextOnce` had already cached), cutting per-signal RPC
volume from up to 19 to 4 requests without changing the outcome — useful
confirmation it was a secondary cost, not the critical-path one. Smart
Selection was not touched. The full benchmark matrix and load-test suite
described in the phase brief were not exhaustively built, given the
depth this investigation required to reach a confident, evidence-based
root cause; reported honestly as bounded scope, not claimed as complete.

## Phases

Each phase should be reviewed and explicitly approved before moving to the
next. Nothing beyond Phase 0 has been started.

- **Phase 0 — Scaffold (this phase).** Directory structure, documentation,
  data contracts. No trading logic.
- **Phase 1 — Signal ingestion & parsing.** Capture real Scout messages
  from the public channel; extract token/contract references.
- **Phase 2 — Data layer.** Blockchain data, market data, wallet
  intelligence, token analysis — all against real, documented data sources.
- **Phase 3 — Scoring engine.** Smart Selection Score from deterministic
  rules + quantitative features + historical statistics, with ML and LLM
  assistance added only where they demonstrably help.
- **Phase 4 — Risk engine & paper trading.** Veto logic, position sizing,
  simulated ledger. `TRADING_MODE=paper` becomes real.
- **Phase 5 — Execution adapter (paper-tested).** Uniswap/UniswapX
  integration on Robinhood Chain, exercised only in paper mode.
- **Phase 6 — Position management.** Take-profit, stop-loss, trailing exits.
- **Phase 7 — Backtesting & performance analytics.** Historical replay,
  strategy evaluation, feedback into scoring.
- **Phase 8 — Live-mode readiness review.** An explicit, separate go/no-go
  decision. `TRADING_MODE=live` stays unimplemented/disabled until then.

## Non-goals (right now)

- No live/real-money trading.
- No reverse-engineering of BasedBot; no invented BasedBot API.
- No Telegram UI automation.
- No blind copying of Scout calls.
- No fabricated blockchain, market, or wallet data.
- No fabricated or assumed Scout integration beyond what the public channel
  actually exposes.

## Open decisions

These are starting defaults, not final answers — revisit as needed:

- **Language/stack:** TypeScript on Node.js, chosen for the strength of its
  EVM tooling (viem/ethers, Uniswap SDKs) on the execution side. Scoring/ML
  work may later run behind a separate, explicitly justified service if
  Node's ecosystem isn't sufficient.
- **Persistence:** not yet chosen. SQLite is the likely default for the
  paper-trading phase given low throughput and the need for simple,
  inspectable audit records.
- **Market/on-chain data providers:** not yet chosen. Must be selected and
  documented in `ARCHITECTURE.md` before Phase 2 begins — no placeholder or
  fabricated data sources.

## Definition of done (long-term)

Every signal has a complete, auditable lifecycle record:

```
SIGNAL RECEIVED → ANALYZED → ACCEPTED/REJECTED → PAPER ENTRY
→ POSITION MANAGEMENT → EXIT → RESULT
```

and that historical record set is usable for backtesting and continuous
strategy evaluation.
