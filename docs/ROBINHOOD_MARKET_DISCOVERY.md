# Robinhood Chain Market Discovery

How Scout Alpha finds *where and how* a Scout-called token actually trades
on Robinhood Chain (chain id 4663). This is the reference for the
mechanics; `docs/DATA_SOURCES.md` §7 for Pons and §2 for the Uniswap V4 deployment has the full verification record
(exact addresses, how each was confirmed), and `docs/BACKTESTING.md` has
how this feeds into historical backtesting specifically.

## Scope boundary (read this first)

**Market discovery is not token discovery.** Every provider described here
— Pons, Uniswap V3, Uniswap V4, GeckoTerminal — takes a token address that
already came from a Scout signal and answers "where does *this* token
trade?" None of them enumerates tokens, scans for "opportunities," or can
originate a trading candidate on its own. See ARCHITECTURE.md's
"Invariant: Scout is the only strategy entry point" and
`src/backtesting/scoutOriginationBoundary.test.ts`.

## The three venues a Robinhood Chain memecoin can actually be on

### 1. Plain Uniswap V3

A standard `getPool(tokenA, tokenB, fee)` lookup against the canonical
factory (`0x1f7d7550B1b028f7571E69A784071F0205FD2EfA`), checked across a
list of known quote tokens (WETH, USDG) and the four standard fee tiers.
Fully documented in `docs/DATA_SOURCES.md` §2.

**Known gap:** if a real pool exists but its quote token isn't in the
known list (verified real example: a token paired against a token called
"ANTHROPIC" that isn't WETH or USDG), discovery correctly finds nothing —
not a bug, a coverage limit of a finite quote-token list. See
`docs/DATA_SOURCES.md` §7's BUFO finding.

### 2. Pons V2 (bonding curve, pre-graduation)

Most real memecoin volume on this chain turned out to route through the
**Pons Family** launchpad (`docs.ponsfamily.com`,
`github.com/ponsdotdev/ponsfamily`), not plain Uniswap V3. Pons V2's full
supply mints into a bonding-curve contract at launch. `getLaunchedToken(token)`
on the V2 factory (`0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e`) is an O(1)
on-chain check: `.exists` tells you it's a Pons launch, `.curve` gives the
bonding curve's own contract address, `.phase` gives its lifecycle state.

The curve emits `CurveBuy`/`CurveSell` events with exact `quoteIn`/`tokensOut`
(or `tokensIn`/`quoteOut`) amounts — real, ground-truth trade prices, no
indexer needed. GeckoTerminal also happens to index the curve address
itself as if it were a "pool," which is how the coverage gap in Phase 6
was first noticed.

### 3. Pons V2, post-graduation (Uniswap V4)

Once a curve's reserved allocation sells out, Pons permanently locks
liquidity into a **Uniswap V4** pool (verified official deployment on
Robinhood Chain: PoolManager `0x8366a39cc670b4001a1121b8f6a443a643e40951`
— see `docs/DATA_SOURCES.md` §2). V4 pools have **no per-pool contract
address** — they're identified by a `bytes32 PoolId`, computed as:

```
sorted (currency0, currency1) = numeric sort of (token, pairToken)
PoolId = keccak256(abi.encode(currency0, currency1, poolFee /* = 0 */, tickSpacing, hooks))
hooks  = 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044   // Pons' "Meme Hook"
```

Verified live to match GeckoTerminal's own reported pool id exactly for a
real graduated token, and confirmed that PoolManager emits real
`Initialize`/`Swap` events filterable by that PoolId (715 real swaps found
in one 12,000-block window during Phase 6.6 investigation).

## The lifecycle, and the rule that matters most

```
LAUNCHED -> CURVE (bonding curve, Pons V2)
         -> GRADUATED (CurveCompleted event fires)
         -> V4 POOL (permanently locked, Uniswap V4)
```

**A launch's CURRENT phase is not enough to pick a venue for a HISTORICAL
decision.** A launch that graduated at real time G; a decision at time
D < G must resolve to the curve (the V4 pool didn't exist yet at D), even
though the launch shows as graduated *today*. Only D >= G resolves to the
V4 pool. `PonsV2Provider.getLaunchInfo()` returns the real
`graduationTimestamp` (from the actual on-chain `CurveCompleted` event,
never inferred from `phase` alone) specifically so
`venueResolver.resolveMarketVenue()` can enforce this comparison. This is
proven directly in `venueResolver.test.ts` (before/after/exact-boundary
cases) — treated as a correctness-critical lookahead test, not a nice-to-have.

In the real 2026-09-04 dataset, all 4 confirmed Pons V2 signals happened
to be called at-or-after their real graduation moment (Scout appears to
watch for graduation as a signal of a "real" launch), so this boundary
case never actually fired in that specific dataset — but the mechanism
is there, tested, and load-bearing for any future dataset where it does.

## Resolution algorithm (`venueResolver.resolveMarketVenue`)

For a given token + decision timestamp:

1. Check Pons V2 (`getLaunchedToken`). If it exists:
   - Not graduated -> venue = curve.
   - Graduated, but the real graduation timestamp can't be found -> **fail
     closed** (venue = `UNKNOWN`) rather than guess. This is deliberate:
     guessing either venue could be a lookahead violation.
   - Graduated, decision < graduation -> venue = curve (pre-graduation).
   - Graduated, decision >= graduation -> venue = the computed V4 PoolId.
2. Otherwise, fall back to Uniswap V3 factory discovery across known quote
   tokens/fee tiers, accepting the first discovered pool that actually
   produces historical data.
3. Otherwise, venue = `UNKNOWN` (`MARKET_NOT_DISCOVERED`).

Once a venue is resolved, it is authoritative — a resolved-but-empty Pons
venue is never silently swapped for an unrelated Uniswap V3 pool that
happens to have data, even if one exists for the same token address (a
real, verified case: one Pons-launched token also independently has an
unrelated standalone V3 pool). Misattributing price to the wrong market is
worse than honestly reporting it unavailable.

## Historical price reconstruction hierarchy

For the resolved venue, `TieredHistoricalPriceProvider` tries, in order:

1. **On-chain event reconstruction** (`OnChainPonsCurvePriceProvider` /
   `OnChainUniswapV4PriceProvider` / `OnChainUniswapV3PriceProvider`) —
   ground-truth trade prices computed directly from `CurveBuy`/`CurveSell`
   or `Swap` events, no indexer dependency. Only produces a USD price when
   the venue's quote asset is a recognized USD-stable token (see
   "USD conversion" below) — otherwise reports `unavailable` rather than
   presenting a non-USD ratio as a USD price.
2. **GeckoTerminal** (`GeckoTerminalHistoricalPriceProvider`) — the
   existing indexer-backed fallback from Phase 6, tried only if on-chain
   reconstruction didn't produce usable data.

Both tiers are always attempted when an on-chain reconstruction dependency
is configured; omitting it (as existing tests do) reproduces pre-6.6,
GeckoTerminal-only behavior exactly — a deliberate backward-compatible
default.

### USD conversion

Real Pons V2 launches turned out to pair against more than stablecoins —
verified real quote tokens found during Phase 6.6 include USDG ("Global
Dollar," USD-pegged) **and Robinhood's own tokenized-equity tokens**
(AMZN, META, LLY-style tokens representing real stock). A raw,
quote-denominated price is always reconstructed when possible; it is only
converted to a USD figure when the quote asset is a recognized USD-stable
token (currently: USDG only). Converting a "meme token per share of AMZN"
ratio to USD would require a second, unverified historical price hop (the
stock's own historical USD price) — deliberately not attempted; that
data stays available at the raw, quote-denominated level but not as a
`priceUsd`, and is honestly reported as unconvertible rather than guessed.

### Block-range and timestamp mechanics

- `BlockTimeEstimator` calibrates a linear block-number/timestamp model
  from two real on-chain points, used only to size a search window —
  every returned observation's timestamp is always a fresh, real
  `eth_getBlock` read, never the estimate itself.
- `BlockTimestampResolver` caches `blockNumber -> timestamp` per backtest
  run so the same block is never re-queried.
- `fetchLogsWithAdaptiveChunking` recursively bisects a log query that
  fails with "too many results" — verified live that this is a
  result-count limit, not a fixed block-range cap (a quiet pool's
  1,000,000-block query succeeds in one call; a busy pool's 50,000-block
  window can fail) — see `docs/DATA_SOURCES.md` §4.
- **Two performance findings from real live runs, both fixed:**
  1. `PonsV2Provider`'s graduation-timestamp lookup originally scanned
     from block 0 — genesis-to-tip, tens of millions of blocks — since
     `CurveCompleted` fires at most once and a full scan is *correct*.
     Measured live: this took minutes per token against the public RPC and
     destabilized a multi-signal run. Bounded to a documented, generous
     recent-block lookback window instead (`DEFAULT_GRADUATION_SEARCH_LOOKBACK_BLOCKS`) —
     correct for any realistically-recent Pons launch (the whole platform
     pattern is fast, short-lived speculative tokens), a disclosed
     assumption rather than a silent one.
  2. The on-chain price providers' adaptive chunking used a lower
     `maxSplitDepth` (3, vs. the helper's own default of 6) after a busy
     pool's default-depth bisection cascade was measured taking 150+
     seconds (up to 64 sequential sub-queries) for what's meant to be a
     small, bounded time window. Failing faster and falling through to
     GeckoTerminal is both quicker and gentler on a documented
     rate-limited public endpoint.
- A related, real correctness fix: the decision-time price probe in
  `signalReconstructor.ts` originally queried with a 60-second forward
  buffer past the decision timestamp (to tolerate indexing lag). This
  could return a candle genuinely observed *after* the decision — correctly
  rejected by `LookaheadGuard`, but losing a legitimately-available
  at-or-before-decision price for no benefit, since (unlike live trading)
  a historical backtest has no reason to wait for "the current candle to
  close." Removed — the probe now queries with `beforeTimestamp =
  decisionTimestamp` exactly.

## Phase 7.2 — a second, LIVE-only set of readers, deliberately separate

Everything above (`venueResolver.ts`, `OnChainPonsCurvePriceProvider`,
`OnChainUniswapV4PriceProvider`, `OnChainUniswapV3PriceProvider`) is
**historical/backtesting** code: it serves multiple different decision
timestamps for the same token across one backtest run, so it must
re-check a launch's phase/graduation fresh every time (the
graduation-boundary rule above), and it's correctly gated to only produce
a `priceUsd` for a recognized USD-stable quote token (needed for
comparable historical candles).

A live decision has neither property — every call is implicitly "as of
right now," and withholding ALL price/flow evidence just because a
curve's quote asset happens to be a tokenized-equity token rather than
USDG would throw away real, usable information. Phase 7.2
(`docs/LIVE_INTELLIGENCE.md` has the full writeup) therefore built a
second, live-only set of readers instead of changing the behavior of the
ones above:

- `src/live/resolvedMarketContext.ts` — resolves venue (Pons curve /
  Pons-graduated-V4 / Uniswap V3 / unknown) exactly ONCE per live signal,
  reusing the SAME Pons `getLaunchedToken()` call and V3 pool discovery
  this document's resolution algorithm already does, but without the
  historical resolver's multi-candidate-pool probing loop (that loop's
  latency, applied even to confirmed-Pons tokens that always turned out
  to have zero V3 pools, was Phase 7.1's real bottleneck — see
  `docs/LIVE_INTELLIGENCE.md`'s investigation).
- `src/market-data/ponsCurveMarketReader.ts` — current price, reserve
  "liquidity" (the curve's own quote-token balance, read directly, no
  event scan), and recent-flow, all always quote-denominated with a USD
  figure layered on ONLY when `convertToUsd` (the same, unchanged
  function this document's "USD conversion" section describes) resolves
  one.
- `src/market-data/uniswapV4FlowReader.ts` — recent-flow (and,
  incidentally, price observations for momentum) for a graduated Pons
  token's V4 pool, filtered to its specific PoolId, with the same
  quote-denominated-first policy.

Both readers fetch each bounded event window exactly once and derive
price AND flow from the same fetch — never two separate scans for two
different questions about the same trades.

## Known, honestly-reported limitations

- **BUFO and one CRC token remain unresolved.** Not Pons V1, not Pons V2,
  and (for the second CRC token) no discoverable Uniswap V3 pool either.
  GeckoTerminal shows several candidate pools for them, including
  32-byte pool ids with unusual fee labels not yet explained. No
  speculative provider was built for these — see
  `docs/DATA_SOURCES.md` §7.
- **Liquidity, volume, and holder reconstruction are not implemented** —
  this phase reconstructs price only. `HistoricalObservation.liquidity`
  exists in the type but is always `null` from every current provider.
- **On-chain reconstruction for a Pons V2 launch that graduates *during*
  the outcome-simulation window** (entered pre-graduation, some horizon
  falls post-graduation) is not implemented — the resolver picks one
  venue for the whole entry+exit simulation based on the decision
  timestamp. A signal in that situation gets a single venue's data for
  its whole simulated position, which may under-cover the post-graduation
  portion. Not observed in the real dataset (no Pons token in it graduated
  mid-simulation), but a known simplification for the general case.
