# Scout Alpha — Token & Market Intelligence (Phase 4)

Every feature this phase produces, its exact formula/definition, where its
data comes from, its freshness, and its documented limitations. This is
the source of truth for Phase 4's data model — `ARCHITECTURE.md` only
summarizes it.

**Non-negotiable principle repeated throughout:** every analyzer here
returns FEATURES, never a verdict. There is no "safety score", no
buy/sell decision, and no single number claiming to summarize a token.
The future Smart Selection engine (a later phase) is meant to see exactly
which inputs were known, unknown, or unavailable, and why.

## Data quality states (`src/types/domain.ts`, `src/shared/dataQuality.ts`)

Every composite result carries a `dataQuality: DataQualityState`, one of:

| State | Meaning |
|---|---|
| `KNOWN` | Actually observed and (where relevant) fresh. |
| `UNKNOWN` | Structurally can't be established right now (e.g. a feature-detection check found no evidence either way). |
| `UNAVAILABLE` | No provider currently supplies this at all. |
| `STALE` | Observed, but older than a documented freshness threshold. |
| `PARTIAL` | Some but not all of a composite value's inputs are known. |

`buildDataQualitySummary()` rolls per-field states into one `overall`
state with a documented precedence (all unavailable/unknown → UNAVAILABLE;
any degraded field → PARTIAL; all known but something stale → STALE; else
KNOWN). Missing data is **never** converted to `0`, `false`, or "unchanged"
anywhere in this phase — that's the one rule every analyzer below follows.

## Freshness (`src/shared/freshness.ts`)

`computeFreshness(observedAt, staleAfterSeconds)` — a value is stale once
older than a threshold the caller supplies. Documented defaults
(`DEFAULT_STALE_AFTER_SECONDS`): market data 60s, holder data 15min,
liquidity snapshots 60s. Not a streaming architecture — just a timestamp
comparison, per the Phase 4 brief.

---

## 1. Token contract analysis

### Metadata & deployment (`src/token-analysis/tokenAnalysisService.ts`, unchanged from Phase 2/3)

Name/symbol/decimals/totalSupply/deployment block & timestamp/deployer —
all directly on-chain via `RobinhoodChainClient`. **New Phase 4 finding:**
deployment lookup uses `findContractDeploymentBlock`, which only works
within the public RPC's retention window (~6,000-8,000 blocks — see
`docs/DATA_SOURCES.md` §1). Old contracts genuinely fail this lookup;
`TokenAnalysisService` already reports that as `unavailable`, not a crash.

### Contract feature detection (`src/token-analysis/contractFeatureAnalyzer.ts`)

**Method:** bytecode-selector-presence scan. For each risk-relevant
function group, compute the real 4-byte selector with viem's
`toFunctionSelector` (keccak256-based — not a memorized hex constant) for
each candidate signature, and check whether it appears in the contract's
deployed bytecode (`eth_getCode`).

| Feature | Candidate signatures checked |
|---|---|
| `mintFunctionDetected` | `mint(address,uint256)`, `mint(uint256)` |
| `burnFunctionDetected` | `burn(uint256)`, `burn(address,uint256)`, `burnFrom(address,uint256)` |
| `pauseFunctionDetected` | `pause()`, `unpause()`, `paused()` |
| `blacklistFunctionDetected` | `blacklist(address)`, `addBlacklist(address)`, `setBlacklist(address,bool)`, `isBlacklisted(address)`, `blocklist(address)` |
| `ownershipFunctionDetected` | `owner()`, `renounceOwnership()`, `transferOwnership(address)` |
| `maxTransactionFunctionDetected` | `setMaxTransactionAmount(uint256)`, `maxTransactionAmount()`, `_maxTxAmount()` |
| `maxWalletFunctionDetected` | `setMaxWalletAmount(uint256)`, `maxWalletAmount()`, `_maxWalletSize()` |
| `feeOrTaxFunctionDetected` | `setFees(uint256,uint256)`, `setTaxes(uint256,uint256)`, `buyTax()`, `sellTax()`, `setBuyTax(uint256)`, `setSellTax(uint256)` |
| `proxyPatternDetected` | EIP-1967 implementation storage slot (`keccak256("eip1967.proxy.implementation") - 1`) non-zero |

Each result is `"detected"` / `"not_detected"` / `"unknown"` (`unknown`
only when bytecode itself couldn't be fetched). **`"not_detected"` is
never a safety claim** — the candidate signature list is not exhaustive,
a proxy's own bytecode won't contain its real implementation's selectors
(hence checking `proxyPatternDetected` separately), and a 4-byte selector
match is strong evidence, not mathematical proof. This is explicitly
**not a honeypot guarantee** and never claims a token is safe.

- **Data source:** `eth_getCode`, `eth_getStorageAt` — direct RPC, no indexer.
- **Freshness:** point-in-time (bytecode essentially never changes post-deployment, except behind a proxy).
- **Limitation:** no source-code/ABI verification is attempted (most memecoins aren't verified anyway); non-standard function names outside the checked list produce a false `not_detected`.

## 2. Token age (`src/token-analysis/tokenAgeAnalyzer.ts`)

`ageSeconds`/`ageMinutes`/`ageHours` from `now - deployedAt`.
`ageCategory` (documented, not arbitrary-and-hidden):

| Category | Threshold |
|---|---|
| `BRAND_NEW` | < 10 minutes |
| `VERY_NEW` | < 1 hour |
| `NEW` | < 24 hours |
| `ESTABLISHED` | < 30 days |
| `MATURE` | ≥ 30 days |

Chosen at memecoin timescales — real Scout calls have shown tokens
literally 1-6 minutes old (`src/ingestion/fixtures`). `UNKNOWN` when
`deployedAt` is missing or unparseable — never defaults to "brand new" or
any other guess.

## 3. Liquidity analysis (`src/market-data/liquidityAnalyzer.ts`)

Given a current and previous `LiquiditySnapshot` (see §Storage below):

- `changePct` = `(current - previous) / previous * 100`.
- `trend`: `LARGE_WITHDRAWAL` if `changePct <= -30`; `STABLE` if
  `|changePct| <= 5`; else `INCREASING`/`DECREASING` by sign. Both
  thresholds are constructor options (`largeWithdrawalThresholdPct=30`,
  `stableBandPct=5`), documented defaults, not hidden magic numbers.
- `accelerationPctPoints`: difference between this step's `changePct` and
  the prior step's, only when a third (T-2) snapshot is supplied.
- `topPoolLiquidityConcentrationPct`: the largest pool's share of total
  known liquidity across all of a token's pools, when supplied.

**Never calls a drop a "rug"** — `LARGE_WITHDRAWAL` is neutral,
evidence-based terminology. `trend` is `UNKNOWN` (not `STABLE`) when there
is no prior snapshot to compare against — a single reading is not evidence
of stability.

- **Data source:** `LiquiditySnapshot` history, from `src/storage/liquiditySnapshotRepository.ts`.
- **Limitation:** requires the caller to have actually taken snapshots over time — this phase provides the storage mechanism, not a running monitor (explicitly out of scope).

## 4. Market flow (`src/market-data/marketFlowAnalyzer.ts`)

Over a set of `SwapRecord`s: `buyCount`/`sellCount`/`unknownCount`
(`UNKNOWN`-direction swaps are **never** folded into buy or sell).
Volumes (`buyQuoteVolume`, `sellQuoteVolume`, `netQuoteFlow`,
`averageTradeSizeQuote`, `medianTradeSizeQuote`) are in **quote-token
units — not USD**. No verified per-swap USD source exists (see
`docs/WALLET_DATA_SOURCES.md` §3); converting with a *current* price would
misrepresent a past trade's value at the time, which this project treats
the same as inventing a historical price.

- `buySellRatio` = `buyQuoteVolume / sellQuoteVolume` (volume-based, not a raw count ratio — "do not use raw trade counts as a proxy for volume").
- `largeTradeCount`: trades at or beyond `largeTradeMultiplier` (default **3x**, documented) times the median trade size.
- `uniqueTraderCount`: `null` (not `0`) when no swap has an observed trader — an empty set here means "unknown", not "zero traders".
- `recentTradeCount`: swaps within `recentWindowSeconds` (default 300s) of `now`; `null` if no swap in the set has a timestamp at all.

- **Data source:** `SwapRecord[]` from `PoolDataProvider.getRecentSwaps` (Phase 2, on-chain).
- **Freshness:** as fresh as the underlying swap fetch's block range.
- **Limitation:** no USD figures — quote-token-denominated only, by design.

## 5. Momentum (`src/market-data/momentumAnalyzer.ts`)

Over timestamped price observations: `changePct1m/5m/15m/30m/1h` — each
only computed when an observation exists within **50% of the interval**
around the target time (documented `INTERVAL_TOLERANCE_FRACTION`); never
approximated from a far-off sample. **With only one observation (current
price only), every interval is `null`** and `dataQuality` is
`UNAVAILABLE` with `insufficientDataReason` stated — the literal
requirement "if only current price is available, say that historical
momentum is unavailable."

- `rateOfChangePctPerMinute`: from the shortest available interval.
- `accelerationPctPoints`: difference between the two shortest available intervals' per-minute rates (positive = recent momentum stronger than the medium-term rate).
- `drawdownFromRecentHighPct` / `distanceFromRecentLowPct`: against the max/min price in the observation set — needs ≥ 2 observations.
- `volatilityPct`: standard deviation of consecutive pct changes — needs ≥ 3 observations.

- **Data source:** caller-supplied price observations (this analyzer does not fetch anything itself — reuse of whatever `TokenMarketData`/snapshot history the caller has).
- **Limitation:** no built-in historical price store yet — see `SignalMarketSnapshot`/`LiquiditySnapshot` for what IS stored over time today.

## 6. Entry quality (`src/market-data/entryQualityAnalyzer.ts`)

Compares signal-time values to current values. **Features only — never a
buy/sell decision.**

- `priceSincePct`/`marketCapSincePct`/`liquiditySincePct`: `(current - atSignal) / atSignal * 100`.
- `chaseRisk`: `HIGH` if `priceSincePct >= 50` **and** within `5` pct-points of the recent high (`nearRecentHighPct`); `ELEVATED` if `priceSincePct >= 20` alone; `LOW` otherwise; `UNKNOWN` if `priceSincePct` can't be computed. All three numbers are constructor-configurable, documented defaults.
- `liquidityDeteriorating`: `"detected"` if `liquiditySincePct <= -10` (documented threshold).
- `volumeAcceleration`: `HIGH` at ≥3x signal-time volume, `MODERATE` at ≥1.5x, else `LOW`; `UNKNOWN` if either volume is missing.
- `flowDeteriorating`: `"detected"` if the current buy/sell ratio has fallen to ≤50% of its signal-time value (documented `flowDeterationRatioFraction`).
- `distanceFromRecentHighPct` / `priceAccelerationPctPoints`: reused directly from `MomentumAnalyzer`'s output, not recomputed.

- **Data source:** a `SignalMarketSnapshot` (signal-time) + current `TokenMarketData`/`MomentumAnalysis`.
- **Limitation:** every "since signal" field needs both a signal-time and current value — genuinely `UNAVAILABLE` for signals captured before this phase existed (no snapshot to compare against).

## 7. Market anomaly detection (`src/market-data/marketAnomalyAnalyzer.ts`)

Reuses every other analyzer's output rather than recomputing (`liquidityAnalysis.changePct`, `marketFlow.buySellRatio`/`largeTradeCount`, `momentum.accelerationPctPoints`). Every threshold is a **disclosed, documented** order-of-magnitude choice — not empirically derived, and never a claim of malicious intent:

| Finding | UNUSUAL | HIGHLY_UNUSUAL |
|---|---|---|
| Volume spike | ≥ 4x prior average | ≥ 10x |
| Liquidity removal | ≤ -25% single step | ≤ -50% |
| Buy/sell imbalance | ratio ≥ 4 or ≤ 0.25 | ratio ≥ 10 or ≤ 0.1 |
| Large-trade anomaly | ≥ 1 trade > 3x median (per MarketFlowAnalyzer) | ≥ 3 such trades |
| Price acceleration | ≥ 20 pct-points between intervals | ≥ 50 |
| Transaction frequency | ≥ 3x prior average | ≥ 8x |
| Holder concentration change | ≥ 10 pct-points | ≥ 20 |

`overall` is the worst non-`UNKNOWN` level found; `UNKNOWN` only if
**every** finding is `UNKNOWN`. Uses only
`NORMAL`/`UNUSUAL`/`HIGHLY_UNUSUAL`/`UNKNOWN` — never "malicious",
"scam", or "rug". `thresholds` on the result restates every number above
for audit purposes.

- **Limitation:** `holderConcentrationChange` needs two `HolderDistribution` snapshots over time — this phase doesn't build a holder-snapshot store (only liquidity snapshots), so it's `UNKNOWN` unless the caller separately tracks that.

## 8. Holder analysis (`src/token-analysis/holderConcentrationAnalyzer.ts`)

Pure derivation from an already-fetched `HolderDistribution` (Phase 2's
`HolderDataProvider` — same real-but-Cloudflare-flaky Blockscout source,
see `docs/DATA_SOURCES.md` §3): `top5ConcentrationPct`/`top10ConcentrationPct`
(sum of the top N holders' `percentageOfSupply` — `null`, not
approximated, if any of those percentages is itself unknown),
`largestHolderSharePct`, `deployerSharePct` (only if the deployer actually
appears in the fetched top-holders page), and `concentrationChangePct`
(only when a previous `HolderDistribution` is supplied). **Never
interprets concentration as good or bad** — these are raw features for
later scoring.

## 9. Deployer analysis (`src/token-analysis/deployerAnalyzer.ts`)

Reuses `RobinhoodChainClient.getNativeBalance`/`getTokenBalance` (Phase 2)
for the deployer's own balances, and reuses whatever `SwapRecord[]` the
caller already fetched for this token's pools to count
`observedDeployerSwapCount` — **no new indexer call**. `deployerFullHistoryAvailable`
is always `false` with a stated reason pointing at
`docs/WALLET_DATA_SOURCES.md` §2d (no verified wallet-centric transaction
history indexer exists). Only ever reports **"deployer address"** and
**"observable on-chain behavior"** — never attempts to identify a person
or claim ownership.

## 10. Pool quality (`src/market-data/poolQualityAnalyzer.ts`)

**Returns every relevant pool — never silently picks "the best" one.**
Pool age reuses `RobinhoodChainClient.getContractCreationInfo` unchanged
(a Uniswap V3 pool is itself a contract, so the same Phase 2 binary-search
deployment lookup works — subject to the same RPC retention limitation as
§1). `recentSwapCount`/`recentBuyCount`/`recentSellCount` are `null` (not
`0`) when no swap data was supplied at all, distinct from a genuine zero.

## 11. Signal market snapshot (`src/market-data/signalMarketSnapshot.ts`, `src/storage/signalMarketSnapshotRepository.ts`)

Pure composition over already-fetched provider results (`TokenMarketData`,
`HolderDistribution`, `TokenAge`, `MarketFlowAnalysis`) into one
`SignalMarketSnapshot` — no fetching of its own. **Never overwrites the
original `ScoutSignal`**, and the repository is append-only keyed by
`signalId`: the first snapshot recorded for a signal is preserved as "the
initial market state" forever; a later attempt to re-record the same
signal id is a no-op. This is exactly the "Scout signal → initial market
state → agent decision → subsequent outcome" chain the brief asks for —
this phase only captures the first link.

## Storage (`src/storage`)

- `liquiditySnapshotRepository.ts` — append-only, keyed by `chainId:poolAddress:observedAt`. `getRecentLiquiditySnapshots()` returns the N most recent, newest first — the shape `LiquidityAnalyzer` expects.
- `signalMarketSnapshotRepository.ts` — append-only, keyed by `signalId` (first-write-wins).

Both built on the same generic `createFileRepository()` factored out in
Phase 3 — no new persistence mechanism introduced.

## Performance & rate limiting

No new RPC-hammering risk introduced: `ContractFeatureAnalyzer` makes one
`eth_getCode` + one `eth_getStorageAt` call per token (parallelizable by
the caller if analyzing many tokens — not done automatically here to keep
this phase's scope to single-token analysis, per the brief). `PoolQualityAnalyzer.assessAllPools`
runs its per-pool lookups concurrently via `Promise.all` (safe — bounded
by the number of a token's own pools, typically ≤ 8 given
`UNISWAP_V3_FEE_TIERS.length × quote-token count`). All other analyzers
are pure, synchronous computation over already-fetched data — zero
additional network calls.

## Cross-phase reuse (what was NOT duplicated)

- `PoolDataProvider.getRecentSwaps` (Phase 2) — used by `MarketFlowAnalyzer`, `DeployerAnalyzer`, `PoolQualityAnalyzer`.
- `RobinhoodChainClient.getContractCreationInfo`/`getNativeBalance`/`getTokenBalance` (Phase 2) — used by `PoolQualityAnalyzer`, `DeployerAnalyzer`.
- `HolderDataProvider` (Phase 2/3) — used by `holderConcentrationAnalyzer`.
- The Phase 3 documented wallet-history limitation (`docs/WALLET_DATA_SOURCES.md` §2d) — cited directly by `DeployerAnalyzer` rather than re-researched.
- `ConcurrencyLimiter`/`TtlCache`/generic `createFileRepository` (Phase 2/3 `src/shared`, `src/storage`) — no new caching or persistence primitive built.

## Live-tested findings (2026-09-05)

- ✅ `ContractFeatureAnalyzer` against real WETH — real, non-empty bytecode, no mint/pause/blacklist/proxy detected (evidence, not a safety claim).
- ✅ `MarketFlowAnalyzer` + `PoolQualityAnalyzer` against real, bounded (20-block) WETH/USDG swap data.
- ⚠️ Deployment-block/pool-age lookup against real WETH/its pool — **failed as expected**, confirming the non-archive-RPC retention-window limitation documented in `docs/DATA_SOURCES.md` §1. Handled gracefully (structured `null`/`UNAVAILABLE`, not a crash) by every caller.
