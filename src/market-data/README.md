# market-data

Normalized market, pool, and swap data for a token — DEX pool discovery,
price/liquidity/volume, and per-swap activity. This module never decides
whether a setup is good; it only reports what's observable.

- **Input:** a chain ID + contract address.
- **Output:** `TokenMarketData` (price/liquidity/volume/pools),
  `PoolInfo[]`, `SwapRecord[]`.
- **Must NOT:** fabricate a value when a provider is unavailable — every
  method returns a `ProviderResult<T>` (`ok` / `partial` / `unavailable` /
  `error`), never throws for a real-world failure, and never invents a
  market cap or price.

Status: implemented (Phase 2 providers; Phase 4 added analyzers on top).

## Phase 4 analyzers

`LiquidityAnalyzer`, `MarketFlowAnalyzer`, `MomentumAnalyzer`,
`EntryQualityAnalyzer`, `MarketAnomalyAnalyzer`, `PoolQualityAnalyzer`, and
`signalMarketSnapshot.ts` — every formula, documented threshold, data
source, and limitation is in `docs/TOKEN_MARKET_INTELLIGENCE.md`, not
repeated here. All of them are pure computation over data these Phase 2
providers already fetch (or the caller already has) — none of them makes a
new network call, and none of them produces a score or a decision.

## `MarketDataProvider` → `DexScreenerMarketDataProvider`

DexScreener already indexes Robinhood Chain under the chain slug
`"robinhood"` — the same slug Scout's own messages link to. Verified live
and working, no API key (`docs/DATA_SOURCES.md` §4). Aggregates across all
of a token's pools: liquidity and volume are **summed**; price, market cap,
FDV, and price-change are taken from the **deepest-liquidity pool** (a
documented convention, not an arbitrary pick).

`marketCapUsd` is **only ever a pass-through** of DexScreener's own figure
— never computed locally from total supply. If DexScreener has none, it's
`null` with `marketCapUnavailableReason` set. `buyCount24h`/`sellCount24h`
are trade **counts**, not dollar volumes — no verified provider separates
volume by side, so a `buyVolumeUsd`/`sellVolumeUsd` field was deliberately
left out rather than approximated.

Simple in-memory TTL cache (30s default) per `(chainId, address)` — see
`src/shared/ttlCache.ts`.

## `PoolDataProvider` → `UniswapV3PoolProvider`

Fully on-chain, using the officially-verified Uniswap V3 Factory address
(`docs/DATA_SOURCES.md` §2) and Robinhood Chain's own canonical WETH/USDG
addresses as the "known quote token" list. `discoverPools` calls
`factory.getPool(token, quote, fee)` for each quote token × standard fee
tier (100/500/3000/10000) — a pool only appears in the result if the real
Factory contract returned a non-zero address for it.

`getRecentSwaps` reads a pool's `Swap` event logs directly (bounded to the
last ~2000 blocks by default, or an explicit block range) and classifies
each as `BUY`/`SELL` using Uniswap V3's documented amount-delta convention
(negative delta for the token of interest = pool paid it out = BUY;
positive = pool received it = SELL — see the comment on `classifySide` in
`uniswapV3PoolProvider.ts`). If the pool's `token0`/`token1` can't be
matched to the requested token, classification is `UNKNOWN` rather than
guessed. `trader` is best-effort: the swap's transaction sender if that
lookup succeeds, otherwise the event's `recipient` (which, in a multi-hop
route through an aggregator, may not be the original EOA — documented, not
silently assumed accurate).

No V4 PoolManager exists on Robinhood Chain as of the Phase 2 research
date, so only V3 is implemented. No other Robinhood Chain DEX was
researched, so none is implemented — the `PoolDataProvider` interface
exists precisely so one can be added later without changing callers.

## Liquidity snapshots

`LiquiditySnapshot` (in `src/types/domain.ts`) is a data shape only — a
single point-in-time liquidity reading with a timestamp, meant to be stored
and compared later to detect increases/decreases/removal. No comparison or
alerting logic exists yet (out of scope per the Phase 2 brief).
