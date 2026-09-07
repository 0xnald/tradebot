# Scout Alpha

Autonomous, risk-gated trading agent that treats calls from the **Scout
Robinhood** Telegram channel as opportunity leads, targeting **Robinhood
Chain** (EVM, chain ID 4663).

> ⚠️ **Status: Phase 5 complete (signal ingestion + on-chain data + wallet
> intelligence + token/market intelligence + Smart Selection Engine).**
> `TRADE_CANDIDATE` is an analysis output, not a trade — no risk decisions
> or execution logic exists yet. Paper trading only. Live trading is not
> implemented anywhere in this codebase, and won't be enabled until that's
> a deliberate, later decision.

## Core principle

Scout is an **opportunity source, not a buy instruction**. Every signal goes
through independent research, scoring, and a risk engine that can veto any
trade. The system must never blindly copy a Scout call.

## Lifecycle

```
SIGNAL RECEIVED → ANALYZED → ACCEPTED/REJECTED → PAPER ENTRY
→ POSITION MANAGEMENT → EXIT → RESULT
```

Every signal produces a complete, auditable record through this lifecycle,
which later feeds backtesting and strategy evaluation.

## Documentation

- [PROJECT_PLAN.md](./PROJECT_PLAN.md) — phases, scope, non-goals, open decisions
- [ARCHITECTURE.md](./ARCHITECTURE.md) — module boundaries, data contracts, safety gates
- [docs/DATA_SOURCES.md](./docs/DATA_SOURCES.md) — what was verified about Robinhood Chain, Uniswap, and third-party data providers, and how
- [docs/WALLET_DATA_SOURCES.md](./docs/WALLET_DATA_SOURCES.md) — wallet-address recovery investigation and wallet-activity data source research
- [docs/TOKEN_MARKET_INTELLIGENCE.md](./docs/TOKEN_MARKET_INTELLIGENCE.md) — every Phase 4 feature's formula, data source, thresholds, and limitations
- [docs/SMART_SELECTION.md](./docs/SMART_SELECTION.md) — Smart Selection Engine architecture, every weight/threshold/formula, and what remains statistically unvalidated

## Explicit constraints

- No real-money trading yet — `TRADING_MODE=live` is not implemented or enabled
- No reverse-engineering of BasedBot; no Telegram UI automation; no invented APIs
- No fabricated blockchain, market, or Scout data
- The risk engine can always veto a trade; the LLM never has signing authority

## Getting started

```bash
cp .env.example .env
npm install
npm run typecheck
npm test
```

Fill in real values in `.env` only when the corresponding module
(ingestion, data providers, execution) actually exists and consumes them —
`.env.example` marks which variables are active now vs. reserved for later
phases.

## Phase 1: signal ingestion

The only working pipeline right now is:

```
Scout Telegram channel → ingestion → signal-parsing → ScoutSignal → storage → logs
```

Run it without any credentials — it replays a real captured set of Scout
messages through the full pipeline:

```bash
npm run ingest:dev
```

Captured signals land in `data/signals.ndjson` (gitignored, one JSON object
per line). Once Telegram credentials are configured (see
[src/ingestion/README.md](./src/ingestion/README.md)), the same command
automatically switches to the live channel.

## Phase 2: Robinhood Chain data layer

Read-only on-chain/market data acquisition, independent of Scout:

```
contract address → RobinhoodChainClient (chain reads)
                  → UniswapV3PoolProvider (on-chain pool discovery + swaps)
                  → DexScreenerMarketDataProvider (price/liquidity/volume)
                  → BlockscoutHolderDataProvider (holder distribution)
                  → normalized TokenContractInfo / TokenMarketData
```

Everything here uses the real public RPC and two real, verified third-party
APIs (DexScreener, Blockscout) — see `docs/DATA_SOURCES.md` for exactly
what was checked and how, including which of these is unreliable
(Blockscout, intermittently blocked by Cloudflare) and how the code
degrades to a structured error instead of crashing or making something up.

```bash
npm test               # unit tests only — fully mocked, no network
npm run test:integration   # optional — hits the real RPC/DexScreener/Blockscout
```

## Phase 3: wallet intelligence

Determines whether a wallet's *history* makes it a useful signal — not
just who traded, but whether that trading pattern is actually good:

```
wallet address + known pools → OnChainWalletActivityProvider (real Swap logs)
                              → walletTradeMatcher (FIFO entry/exit → WIN/LOSS/OPEN/UNKNOWN)
                              → WalletPerformanceAnalyzer (lifetime/30d/7d stats)
                              → WalletQualityAnalyzer (features, not a final score)

ScoutSignal → scoutWalletIdentityResolver (resolve or honestly fail)
            → buildScoutWalletAssociations (preserved for Phase 6/7)
```

Key honest finding: Scout's truncated wallet addresses
(`0x3430…c941`) **cannot be recovered** to full addresses from anything
Scout publishes — verified directly, not assumed. See
`docs/WALLET_DATA_SOURCES.md`. And because no verified provider gives
historical USD prices, real trades from the one verified activity provider
land in `OPEN`/`UNKNOWN`, never a fabricated `WIN`/`LOSS` — the win/loss
logic itself is fully implemented and tested against synthetic data.

```bash
npm test               # includes ~60 new wallet-intelligence unit tests, fully mocked
npm run test:integration   # includes a live test that discovers a real trader from real swap data
```

## Phase 4: token & market intelligence

Turns a contract address plus the Phase 2/3 data layer into transparent,
per-feature evidence — never a single "safety score":

```
contract address → ContractFeatureAnalyzer (bytecode-selector evidence — never a safety claim)
                  → tokenAgeAnalyzer, LiquidityAnalyzer, MarketFlowAnalyzer, MomentumAnalyzer
                  → EntryQualityAnalyzer (signal-time vs. now)
                  → MarketAnomalyAnalyzer (NORMAL/UNUSUAL/HIGHLY_UNUSUAL/UNKNOWN)
                  → holderConcentrationAnalyzer, DeployerAnalyzer, PoolQualityAnalyzer
                  → SignalMarketSnapshot (captured once, never overwritten)
```

Every result distinguishes KNOWN / UNKNOWN / UNAVAILABLE / STALE / PARTIAL
— see `docs/TOKEN_MARKET_INTELLIGENCE.md` for every formula, threshold,
and limitation. Key live finding: the public RPC turns out to **not be an
archive node** (confirmed by direct probing — historical `eth_getCode`
queries fail beyond roughly 6,000-8,000 blocks back), so deployment-block
and pool-age lookups genuinely fail for old contracts like Robinhood's own
canonical WETH — every caller already handles this as `UNAVAILABLE`
rather than crashing. See `docs/DATA_SOURCES.md` §1 for the full finding.

```bash
npm test               # includes ~100 new Phase 4 unit tests, fully mocked
npm run test:integration   # includes live tests against real WETH bytecode/swaps, and confirms the RPC retention-window finding
```

## Phase 5: Smart Selection Engine

Combines everything above into a transparent, explainable decision — pure
computation, zero network calls, zero LLM calls, zero randomness:

```
ScoutSignal + token/market/wallet intelligence
  → 9 named feature groups (signal quality, token quality, liquidity,
    market flow, momentum, entry quality, holder structure,
    wallet intelligence, market conditions [stub])
  → HardBlockerEngine (7 deterministic blockers — can force IGNORE regardless of score)
  → ConfidenceEngine (SEPARATE from score — completeness/critical-features/wallet-sample/freshness)
  → EntryChaseDetector (anti-chase classification)
  → ExpectedValueEstimator (heuristic label only — never a real probability)
  → SmartSelectionResult: IGNORE / WATCH / TRADE_CANDIDATE
```

`TRADE_CANDIDATE` means the intelligence layer believes an opportunity
deserves to proceed to risk/execution — **it is not a trade**. Every
weight and threshold is centralized in one versioned, documented config
(`smart-selection-v1`) and explicitly labeled heuristic, not statistically
validated — see `docs/SMART_SELECTION.md`. Score and confidence are
computed completely separately (a result can score 100 with confidence 15
if almost nothing is actually known — verified in testing). A worked
example from a fully-known "extremely weak" opportunity: contract
red-flags + collapsing liquidity + sell-heavy flow + crashing momentum +
concentrated holders scores 42.8 → `IGNORE`, entirely reproducibly.

```bash
npm test   # includes ~100 new Phase 5 unit tests plus 26 end-to-end scenario tests, fully deterministic
```

## Live Scout pipeline (Phase 7 / 7.4)

```bash
npm run live          # connects to the real Scout Telegram channel if
                       # TELEGRAM_API_ID/API_HASH/SESSION_STRING are set,
                       # otherwise replays the captured fixture — runs
                       # until Ctrl+C, paper trading only
npm run live:status   # point-in-time snapshot from the persisted NDJSON
                       # files — signal counts, decisions, latency, provider
                       # failures, open/closed paper positions
npm run live:report   # accumulated LIVE-only statistics (decision
                       # distribution, confidence, market-flow coverage,
                       # venue distribution, post-decision observation
                       # returns by horizon) — the evidence base for any
                       # future strategy change; never mixes REPLAY runs in
```

Robinhood Chain RPC is split into two explicit roles (`src/blockchain/
rpcRouting.ts`): a PRIMARY/authenticated provider for ordinary reads, and
a PUBLIC LOG provider for bounded `eth_getLogs` event-history queries
whose range exceeds the primary provider's known capability — decided
deterministically before either request is made, never by trying one and
falling back after a predictable rejection. See `docs/RPC_PERFORMANCE.md`
for the full investigation and `docs/LIVE_PIPELINE.md` for the live
observation architecture (post-decision horizons, REPLAY/LIVE separation,
restart safety).

## Project structure

See `ARCHITECTURE.md` for the module map, or run:

```bash
git ls-files -- tradebot
```
