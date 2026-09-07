# Scout Alpha — Data Sources (Phase 2 research)

This document records what was actually verified before any Phase 2 code
was written, per the instruction to research before coding. Every claim
below is either (a) sourced from a domain that is plausibly authoritative
for that claim, with the exact page fetched, or (b) an empirically observed
live API response captured on **2026-09-05**. Anything not verified is
labeled as such — nothing here is a search-snippet guess.

## A note on how this research was done

Search results for "Robinhood Chain" and "Robinhood Chain Uniswap" returned
a cluster of third-party sites (`trustswap.com/robinhood/*`,
`nockterminal.com`, `robinhoodchain.wiki`, `docs.bags.fm`,
`bitcoinfoundation.org`) that are **not treated as sources here** — a new,
trending chain attracting a swarm of unfamiliar SEO-style sites all citing
suspiciously precise details is a known content-farm / scam pattern, not
evidence of accuracy. Only `robinhood.com`/`docs.robinhood.com` (Robinhood's
own domain), `developers.uniswap.org`/`support.uniswap.org` (Uniswap
Labs' own domain), and empirically-tested live API endpoints were used.

## 1. Chain identity & RPC (verified: robinhood.com, docs.robinhood.com)

Confirmed from `https://robinhood.com/us/en/support/articles/robinhood-chain-mainnet/`
and `https://docs.robinhood.com/chain/connecting`:

| Field | Value |
|---|---|
| Mainnet chain ID | **4663** |
| Testnet chain ID | 46630 |
| Native currency | ETH |
| Mainnet HTTP RPC | `https://rpc.mainnet.chain.robinhood.com` |
| Testnet HTTP RPC | `https://rpc.testnet.chain.robinhood.com` |
| Mainnet WebSocket | `wss://feed.mainnet.chain.robinhood.com` |
| Testnet WebSocket | `wss://feed.testnet.chain.robinhood.com` |
| Block explorer | `https://robinhoodchain.blockscout.com` |
| Rollup stack | Arbitrum Orbit (per multiple sources; not independently re-derived from raw chain data) |

The docs explicitly state the **public RPC is rate-limited and not
recommended for production use**, and recommend (as officially supported
third-party providers): **Alchemy** (primary recommendation — Robinhood-branded
subdomain, `https://robinhood-mainnet.g.alchemy.com/v2/{API_KEY}`), plus
QuickNode, Blockdaemon, dRPC, and Validation Cloud. None of these
third-party provider accounts were signed up for or tested in this phase —
only the public RPC was used, and only for read calls.

**Phase 4 finding — the public RPC is NOT an archive node.** Directly
probed live on 2026-09-05: `eth_getCode` at a specific historical block
succeeds roughly 6,000 blocks back from the current tip and fails (`-32000
"metadata is not found"`) roughly 8,000 blocks back (exact cutoff not
pinned down further than that range). This means `findContractDeploymentBlock`
/ `getContractCreationInfo` (binary-searches historical `eth_getCode` —
see `src/blockchain/robinhoodChainClient.ts`) — and anything built on them,
including Phase 4's pool-age lookup — **will genuinely fail for any
contract or pool older than that short retention window** when using the
default public RPC. Confirmed live against the real WETH contract and its
WETH/USDG pool, both of which are old enough to fail this way every time.
This mainly affects long-lived tokens (like Robinhood's own canonical
WETH/USDG) — a freshly-deployed Scout memecoin (typically minutes to hours
old) would very likely still be within the retained window. Every caller
of this method in this codebase already catches the failure and reports
the corresponding field as unavailable rather than crashing — this is a
real capability gap, not an unhandled bug. A paid archive-capable provider
(Alchemy, etc., above) would remove it; none was tested.

**Caveat:** this was read via an automated fetch-and-summarize tool, not by
reading raw HTML myself. The chain ID (4663) matches what was independently
given at the start of this project and is corroborated by every other
source below, so it's treated as solid. Treat the exact RPC/WS URL strings
as "very likely correct, worth a final human glance" rather than
byte-for-byte guaranteed.

## 2. Uniswap on Robinhood Chain (verified: developers.uniswap.org)

Confirmed from Uniswap's own developer docs
(`developers.uniswap.org/docs/protocols/v3/deployments/v3-robinhood-chain-deployments`,
reached via a `303` redirect the docs site issues to its own content
endpoint):

| Contract | Address |
|---|---|
| UniswapV3Factory | `0x1f7d7550b1b028f7571e69a784071f0205fd2efa` |
| SwapRouter02 | `0xcaf681a66d020601342297493863e78c959e5cb2` |
| QuoterV2 | `0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7` |
| NonfungiblePositionManager | `0x73991a25c818bf1f1128deaab1492d45638de0d3` |
| UniswapInterfaceMulticall | `0x282a3c4d320cc7f0d5eaf56b8029e4b88338f0a3` |
| UniversalRouter | `0x8876789976decbfcbbbe364623c63652db8c0904` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |

**Correction (Phase 6.6, 2026-09-06):** the claim above — "no V4
PoolManager is listed for this chain" — was wrong, found via a redirect
this session followed to a different content endpoint on the same
`developers.uniswap.org` domain
(`docs/protocols/v4/deployments`, which lists Robinhood Chain under a
"## Robinhood Chain: 4663" heading the earlier V3-only page didn't
surface). Uniswap V4 **is** deployed on Robinhood Chain:

| Contract | Address |
|---|---|
| PoolManager | `0x8366a39cc670b4001a1121b8f6a443a643e40951` |
| PositionDescriptor | `0x9639443158e8c5efa35bd45287bf2effd3d8dc06` |
| PositionManager | `0x58daec3116aae6d93017baaea7749052e8a04fa7` |
| Quoter | `0x8dc178efb8111bb0973dd9d722ebeff267c98f94` |
| StateView | `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b` |

Confirmed live: PoolManager has real bytecode (`eth_getCode` returns
48,020 bytes) and emits real `Initialize`/`Swap` events (715 real swaps
found in a single 12,000-block window for one known pool) exactly matching
the official Uniswap V4 core event ABI
(`github.com/Uniswap/v4-core/blob/main/src/interfaces/IPoolManager.sol`).
This matters because Pons V2 (§7 below) permanently migrates graduated
launches' liquidity into V4 pools — Phase 2's original V3-only pool
discovery could never see these. See `docs/ROBINHOOD_MARKET_DISCOVERY.md`
for how V4 pools (identified by a `bytes32 PoolId`, not an address) are
discovered and read.

Corroborating evidence this data is real and not fabricated: the Permit2
address and address format match Permit2's actual canonical
cross-chain deployment address, and `docs.robinhood.com/chain/protocol-contracts`
independently lists the same Permit2 address and the real canonical
Ethereum mainnet WETH address for its bridge-gateway contract — internally
consistent across two independent official sources.

Robinhood's own canonical token list
(`docs.robinhood.com/chain/contracts`) gives:

| Token | Address |
|---|---|
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| USDG (Global Dollar) | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` |

These two are used as the "known quote tokens" for on-chain pool discovery
(see `src/market-data/uniswapV3PoolProvider.ts`). **Only Uniswap is
implemented in this phase** — the pool-discovery abstraction is designed to
support other DEXs later, but no other Robinhood Chain DEX's contracts were
researched or verified, so none is implemented.

## 3. Block explorer API — Blockscout (empirically tested, 2026-09-05)

`robinhoodchain.blockscout.com` runs Blockscout, which exposes an
unauthenticated REST API v2. This was tested directly (not just read about)
against the real WETH address above:

- `GET /api/v2/stats` — **worked**, returned real-looking chain stats
  (`total_blocks`, `total_addresses`, gas prices, etc.).
- `GET /api/v2/tokens/{address}` — **worked** on a retry, returned real
  token data: `{"name":"WETH","decimals":"18","holders_count":"529494",
  "circulating_market_cap":"102402065.56...","exchange_rate":"2451.45",...}`.
- `GET /api/v2/tokens/{address}/holders` — **failed 3/3 attempts** with an
  HTTP 403 from a Cloudflare bot-challenge (`Just a moment...` / managed
  challenge), from this environment.
- The `/api-docs` page itself also returned a Cloudflare challenge.

**Conclusion:** Blockscout's API is real and does carry the holder-count
and per-token data we need, but is **not reliably reachable unauthenticated
from this environment** — it appears to be behind Cloudflare bot mitigation
that triggers intermittently and, for the `/holders` endpoint specifically,
consistently in this session's testing. No documented rate limit or API-key
tier was found (no `X-RateLimit-*` response headers were present on a
successful call). This is exactly the kind of failure mode
`HolderDataProvider` is designed around: `BlockscoutHolderDataProvider` is
implemented to call this real endpoint, but every caller must be prepared
for it to return an `"error"`/`"unavailable"` result rather than data. This
has **not been proven reliable enough to depend on** for anything beyond
best-effort holder data.

## 4. Market data — DexScreener (empirically tested, 2026-09-05)

DexScreener already indexes Robinhood Chain under the chain slug
**`robinhood`** — the same slug Scout's own messages link to
(`dexscreener.com/robinhood/{address}`, confirmed in Phase 1). Its public
API was tested directly and unauthenticated (no API key used or required
for these endpoints):

- `GET https://api.dexscreener.com/latest/dex/search?q=robinhood` —
  **worked**, returned real pairs with `chainId: "robinhood"`.
- `GET https://api.dexscreener.com/token-pairs/v1/{chainId}/{tokenAddress}` —
  **worked**, tested against the real WETH address, returned multiple real
  Uniswap V3 pools (`dexId: "uniswap"`, `labels: ["v3"]` — consistent with
  §2's finding that only V3 is deployed) with rich per-pool data:
  `priceUsd`, `priceNative`, `liquidity.{usd,base,quote}`,
  `volume.{m5,h1,h6,h24}`, `txns.{m5,h1,h6,h24}.{buys,sells}`,
  `priceChange.{h1,h6,h24}`, `fdv`, `marketCap`, `pairCreatedAt`.

This is the primary source for `MarketDataProvider` in this phase: real,
live, free, no key required. DexScreener's own documented general rate
limit (per their docs site, not independently load-tested here) is on the
order of tens of requests per minute for most endpoints — treat this as
approximate, not a guaranteed number, and the in-memory cache (§6) exists
specifically to avoid hammering it.

**Market cap honesty note:** DexScreener's `marketCap` field is their own
computed value (from circulating supply × price, per their docs); `fdv` is
fully-diluted (total supply × price). This project does **not**
independently recompute market cap from total supply, because Robinhood
Chain token total supply for arbitrary memecoins isn't independently
verified as "circulating" — see the `IMPORTANT: Do not fabricate market
cap` requirement. `TokenMarketData.marketCapUsd` is populated **only** by
passing through DexScreener's own `marketCap` field verbatim when present;
if DexScreener has no data for the token (no indexed pair yet, or has
stopped indexing it), it is `null` with `marketCapUnavailableReason` set —
never computed locally.

## 5. What's obtainable directly from the chain vs. needs an indexer

| Data | Obtainable on-chain? | How |
|---|---|---|
| Native ETH balance | Yes | `eth_getBalance` |
| Token name/symbol/decimals/totalSupply | Yes | Standard ERC20 `eth_call`s |
| Token balance of an address | Yes | ERC20 `balanceOf` |
| Transaction / receipt by hash | Yes | Standard RPC |
| Uniswap V3 pool existence for a token | Yes | `factory.getPool(tokenA, tokenB, fee)` for known fee tiers |
| Pool's current `token0`/`token1`/`slot0`/`liquidity` | Yes | Direct pool contract reads |
| Swap events for a pool | Yes, but expensive | `eth_getLogs` for the pool's `Swap` event topic over a block range |
| Contract deployment block | Yes, but not O(1) | Binary search over `eth_getCode` (implemented — no external dependency, ~26 RPC calls for the current ~54.9M block height per Blockscout's `/stats`) |
| **Total holder count / holder list** | **No** (would require indexing every `Transfer` event since deployment) | Indexer only — Blockscout, best-effort |
| **Historical price/volume/liquidity aggregates** | **No** (would require indexing every swap) | Indexer only — DexScreener |
| Market cap | Not independently computable responsibly (needs a trustworthy circulating-supply figure) | Pass through DexScreener's own figure, or `null` |

## 6. Caching & rate limits

Simple in-memory, per-process, TTL-based caching (`src/shared/ttlCache.ts`)
is used to avoid redundant calls for the same `(chainId, contractAddress)`
within a short window — see `src/market-data/README.md` and
`src/token-analysis/README.md` for the specific TTLs used per provider.
This is explicitly **not** a distributed cache and does not survive a
process restart.

**Phase 7.1 additions**, deliberately narrow — only data that is either
genuinely time-independent or explicitly scoped to a live-only context:

- `src/shared/tokenMetadataCache.ts` — token metadata (name/symbol/
  decimals/totalSupply), 24h TTL, keyed by `(chainId, address)`. Safe to
  share between the live path AND `src/backtesting`'s venue resolver
  because decimals don't vary by decision timestamp — there's no
  time dimension to get wrong.
- `src/market-data/cachingPonsV2Provider.ts` — Pons launch metadata
  (curve address, pair token, phase, graduation timestamp), 60s TTL,
  **live-only**. Deliberately NOT applied inside the shared backtesting
  venue resolver: that function resolves the same token at MULTIPLE
  DIFFERENT historical decision timestamps within one backtest run, and
  Phase 6.6's graduation-boundary correctness guarantee (§7 below)
  depends on checking the launch's real phase/graduation timestamp fresh
  for every decision — a cached pre-graduation snapshot could otherwise
  wrongly serve a post-graduation historical decision.
- Price, liquidity, and recent swap/flow data are never cached beyond the
  lifetime of a single gather call — these change too fast for any TTL
  to be safe for a live trading decision.

No paid tier, account, or API key was set up for any provider in this
phase. Everything documented above works unauthenticated, with Blockscout
being the one source observed to be unreliable.

## 6a. Final live confirmation (`npm run test:integration`, 2026-09-05)

Ran once against the real network after implementation, not just during
research:

- ✅ `RobinhoodChainClient.getBlockNumber()` against the real public RPC — succeeded.
- ✅ `RobinhoodChainClient.getTokenMetadata()` against the real WETH contract — succeeded, returned `symbol: "WETH"`, `decimals: 18`.
- ✅ `DexScreenerMarketDataProvider.getMarketData()` against real WETH — succeeded, returned real pools.
- ❌ `BlockscoutHolderDataProvider.getHolderDistribution()` against real WETH — failed both underlying calls with `HTTP 403 Forbidden`, exactly the documented Cloudflare-gating behavior from §3. Handled gracefully (structured `status: "error"`, not a crash or thrown exception).

This is exactly the mixed reliability profile documented above — two of
three real providers are solid, one is real-but-unreliable, and the code
degrades to a structured partial/error result rather than fabricating
anything.

## 7. Pons Family launchpad (verified: docs.ponsfamily.com, github.com/ponsdotdev/ponsfamily, on-chain, 2026-09-05)

**Phase 6 finding.** Investigated after backtesting found GeckoTerminal
showing active markets for real Scout-called tokens that our Uniswap V3
pool discovery (§2) couldn't see at all. Verified directly against
`docs.ponsfamily.com`, the `github.com/ponsdotdev/ponsfamily` source repo
and ABI, and live on-chain calls/logs — not assumed from either source
alone, since the two disagreed on one address (below).

**Two generations, both on Robinhood Chain (4663):**

| | V1 | V2 |
|---|---|---|
| Factory | `0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB` | `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` |
| Mechanism | Fixed-supply ERC-20 + one-sided Uniswap V3 position (1% fee), position NFT locked | Full supply mints into a constant-product bonding curve; on sellout, "graduates" into a permanently-locked, full-range **Uniswap V4** pool (pool fee 0 — a hook charges fees instead) |
| Point lookup | `getLaunchedToken(address token) view returns (LaunchedToken)`, `.exists` flag | `getLaunchedToken(address token) view returns (LaunchedToken)`, `.exists` flag, `.phase` (`NotGraduated=0`/`Swept=1`/`PoolCreated=2`/`Rescued=3`) |

**A caution for future reference:** the V2 factory address was
independently given to me as `0x7E1EAbd52Ae29598e6483F72dCf1a70b14284dB`
by an outside source — that string is **not a valid address** (39 hex
chars, odd length; the RPC rejects it outright). Both `docs.ponsfamily.com`
and the GitHub README independently give `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e`,
which has real bytecode on-chain (confirmed via `eth_getCode`) — that is
the address used everywhere in this codebase. Any third-party-supplied
contract address should be verified on-chain before use, not trusted
because it was labeled "primary source."

**V2 pre-graduation pricing:** the bonding curve contract itself (the
`curve` address from `getLaunchedToken`) emits `CurveBuy`/`CurveSell`
events (`quoteIn`/`tokensOut`, `tokensIn`/`quoteOut`) and is what
GeckoTerminal indexes as the token's "pool" while still on the curve —
confirmed by directly matching a real token's `curve` address to
GeckoTerminal's reported pool address, then tracing 178 real `CurveBuy`
and 117 real `CurveSell` events on it directly from chain logs, plus the
single `CurveCompleted` event marking graduation.

**V2 post-graduation pricing — the graduated Uniswap V4 pool's `PoolId`
is fully derivable, no extra on-chain read needed once you have the
factory struct:**

```
sorted (currency0, currency1) = numeric sort of (token, pairToken)
PoolId = keccak256(abi.encode(currency0, currency1, poolFee /* = 0 */, tickSpacing, hooks))
hooks  = 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044   // Pons' "Meme Hook" singleton, per docs
```

Verified live: computed this way for a real graduated token, it matched
GeckoTerminal's own reported 66-character pool id **exactly**, and
`GET /networks/robinhood/pools/{that id}/ohlcv/minute` returned real
historical candles with `meta.base`/`meta.quote` matching the expected
token/pair. GeckoTerminal's pool-address parameter transparently accepts
either a normal 20-byte pool address or a 32-byte Uniswap V4 `PoolId` in
the same endpoint.

**Real result against the Phase 6 dataset (7 eligible Scout signals,
2026-09-04):** 4 of 7 are confirmed Pons V2 launches (3 already graduated
to V4 by the time Scout posted the call, 1 still on-curve); 0 of 7 are
Pons V1. The remaining 3 (BUFO and one of the two CRC tokens; BABA is a
plain standalone Uniswap V3 deployment, already coverable) are **not**
launched through either Pons factory — GeckoTerminal shows several pools
for them, including one legitimate-looking Uniswap V3 pool paired against
a non-standard "novelty" quote token and several more 32-byte pool ids
with unusual fee labels. What actually deploys these is **not established**
and is explicitly left open — not guessed at, not conflated with the Pons
finding above. See `src/market-data/ponsV2Provider.ts` for the
implementation and `docs/BACKTESTING.md` for how Phase 6 uses it.

**Phase 7.2 re-confirmed this same 4-of-7 split**, but via a standalone
diagnostic script (`scripts/profileScoutSignals.ts`), querying
`ponsV2Provider.getLaunchInfo` directly, one token at a time, outside the
live pipeline's bounded timeout and concurrency — specifically to
establish ground truth before building anything new. Found the Pons
lookup itself takes anywhere from ~300ms (not-Pons, fast negative) to
~4.9s (a graduated launch — its graduation-timestamp search is the likely
cost) under those isolated conditions. The live pipeline itself, running
this same lookup CONCURRENTLY with several other RPC-heavy calls per
signal, did NOT reproduce this identification within its shared timeout
in real verification runs — see `docs/LIVE_INTELLIGENCE.md` §5 for the
honest, root-caused (RPC contention under concurrent load, not a design
flaw) writeup of that gap. See
`docs/LIVE_INTELLIGENCE.md` §4 and `docs/ROBINHOOD_MARKET_DISCOVERY.md`
for the live-only readers (`PonsCurveMarketReader`,
`UniswapV4FlowReader`) built to act on this identification quickly
instead of re-discovering it per question.

## 7a. RPC performance (Phase 7.3, empirically measured — see docs/RPC_PERFORMANCE.md)

Confirmed with real, isolated measurements (`scripts/singleSignalControl.ts`):
the public Robinhood RPC's per-call latency, not concurrent request
volume, is the dominant cost for resolving a fresh Pons/V4 token's market
data. A single signal, run alone with zero concurrent competition, still
could not complete venue+flow resolution inside a 4-second budget; giving
it more RPC concurrency (4→8 simultaneous requests permitted) made no
measurable difference. The specific slow step is the bounded
`eth_getLogs` call fetching `CurveBuy`/`CurveSell`/`Swap` events for
flow — consistent with this document's own §2 finding (a busy pool's
full-depth adaptive-chunking log fetch measured 150+ seconds in the worst
case). `ROBINHOOD_CHAIN_RPC_URL`/`ROBINHOOD_CHAIN_WS_URL` (already
supported, §1) are the intended path to a higher-throughput authenticated
endpoint if one becomes available; no such endpoint was available to test
against in this phase.

## 8. Explicitly rejected / not used

- `teleproto` (see Phase 1 notes) — unrelated to this phase, still not used.
- `trustswap.com/robinhood/*`, `nockterminal.com`, `robinhoodchain.wiki`,
  `docs.bags.fm`, `bitcoinfoundation.org` — not used as sources for any
  fact in this document, for the reason given at the top.
- No other Robinhood Chain DEX besides Uniswap was researched. If one is
  added later, it needs the same treatment: official contract addresses
  from an official source, verified before any address is hardcoded.
- Alchemy/QuickNode/Blockdaemon/dRPC/Validation Cloud — named as officially
  recommended in Robinhood's docs, but no account was created and none was
  tested. `.env.example` includes an optional slot for a paid RPC URL, but
  the default/tested configuration in this phase is the public RPC.
