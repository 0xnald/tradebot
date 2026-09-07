# Scout Alpha — Wallet Data Sources (Phase 3 research)

Companion to `docs/DATA_SOURCES.md` (Phase 2). Same standard applies: only
official domains and empirically-tested live responses count as evidence;
third-party SEO content is not used as a source.

## 1. Can Scout's truncated wallet addresses be recovered? (No — verified)

Phase 1 found Scout's live-buy lines show only `0x3430…c941`-style truncated
strings. Phase 3 re-examined the raw message data captured on 2026-09-04
(`src/ingestion/fixtures/scoutrobinhood-2026-09-04.raw.json` and the
original HTML in that capture) specifically for a way to recover the full
address:

| Candidate source | Finding |
|---|---|
| Message text | Contains only the truncated string, literally — confirmed the ellipsis (`…`) is a real character in the text, not a CSS/display truncation |
| Message formatting entities | The truncated string is wrapped in a plain `<code>` span in the rendered preview, corresponding to a `MessageEntityCode` entity — **not** a `MessageEntityTextUrl` (which would carry a hidden target URL, and which the preview DOES render as `<a href>` for the real buttons — see below). Directly checked: `grep`-ing the raw HTML for any `<a>` wrapping a `<code>` span, or any `data-*`/`title` attribute near the wallet text, found none. |
| Inline keyboard buttons (BasedBot/GMGN/DexScreener/GeckoTerminal/X-search) | All five confirmed (Phase 2) to encode the **token contract address**, not any wallet address. None reference individual wallets. |
| Any other message metadata captured by ingestion | `RawScoutMessage` (ingestion's own model) captures id/channel/text/buttons/media — no other field exists that could carry a wallet address; nothing was found in the raw captured data. |
| The underlying MTProto message object | Not independently re-verified live (no Telegram credentials in this environment — same limitation as Phase 1). However, the public web preview is Telegram's own rendering of the same entity data a Bot API/MTProto client would see, and it shows no `MessageEntityTextUrl` for the wallet text — so there is no reason to expect the raw object carries a hidden full address the preview simply failed to show. This is inference from strong evidence, not a live-confirmed fact — flagged accordingly. |

**Conclusion: the full wallet address is not recoverable from any part of
a Scout message, by design.** Scout's bot appears to deliberately truncate
these for display. This is documented, not assumed — see the evidence
above. `WalletIdentity` (§4 below) reflects this: a wallet observed only
from Scout's live-buy text is `confidence: "unresolved"`, with the
truncated string preserved as evidence, never promoted to a real address.

The identity resolver (`src/wallet-intelligence/scoutWalletIdentityResolver.ts`)
is still written generically to check every button URL on a signal for a
full address matching a truncated pattern — not because real Scout data
ever has one today (it doesn't), but because (a) the same generic
button-scanning approach is exactly what correctly recovered the *token*
contract address in Phase 1, so the same defensive check costs nothing and
covers a possible future format change, and (b) it's directly testable
against synthetic fixtures for the "resolved from URL" and "ambiguous"
cases the brief explicitly asks for.

**What was deliberately NOT built:** a heuristic matcher that tries to
guess which real on-chain wallet a truncated string "probably" refers to by
correlating amount + rough timing against real Swap logs. This was
considered and rejected: multiple real wallets can plausibly match a 4+4
hex-character truncated pattern within a loose time/amount window, and
presenting such a probabilistic guess as a resolved `WalletIdentity` would
violate "do not fabricate wallet addresses" in spirit even if every
individual data point used were real. If this is wanted later, it should
be a separate, explicitly probabilistic feature — not baked into identity
resolution.

## 2. Data sources evaluated for historical Robinhood Chain wallet activity

### 2a. Direct RPC (`eth_getLogs` over pool `Swap` events) — ✅ verified, primary source

Already built and verified in Phase 2 (`RobinhoodChainClient`,
`UniswapV3PoolProvider`). For wallet intelligence, this is used
pool-scoped: given a wallet address and a set of known pools, fetch that
pool's `Swap` logs and filter to the ones where the transaction sender is
the wallet.

- **Data provided:** exact swap amounts (token + quote), direction
  (BUY/SELL via the same amount-delta convention as Phase 2), block
  number/timestamp, transaction hash. Real, exact, on-chain — the strongest
  source available.
- **Robinhood Chain support:** yes — it's the chain itself.
- **Historical depth:** the full chain history, bounded only by RPC
  `eth_getLogs` block-range limits (untested here what the public RPC's
  range cap is — kept conservative, see `DEFAULT_LOOKBACK_BLOCKS` in
  `uniswapV3PoolProvider.ts`).
- **API requirements:** none beyond the public RPC (or a paid provider).
- **Rate limits:** the public RPC is documented as rate-limited for
  production (`docs/DATA_SOURCES.md` §1) — not load-tested for an exact
  number.
- **Cost:** free (public RPC).
- **Reliability:** proven reliable in Phase 2 and again in Phase 3's
  integration test — no Cloudflare/bot-gating issue, since it's plain RPC.
- **Limitation:** this only finds a wallet's activity in pools you already
  know to check. It cannot answer "show me everything wallet X has ever
  traded" without already knowing which tokens/pools to look at — see §2c.

### 2b. Blockscout address endpoints — ⚠️ verified real, same reliability caveat as Phase 2

Tested live on 2026-09-05 against the real WETH address:

- `GET /api/v2/addresses/{address}/token-transfers` — **worked 3/3** on this
  attempt (first attempt of the session had failed with the Cloudflare
  challenge on a *different* address-shaped path a few minutes earlier,
  consistent with Phase 2's "intermittent" finding, not "this endpoint is
  special"). Returns real ERC20 Transfer events for that address: block
  number, from/to, token info.
- `GET /api/v2/addresses/{address}/transactions` — hit the Cloudflare
  challenge on the attempt made.

- **Data provided:** ERC20 Transfer events (not swaps directly — a single
  swap produces two Transfer events, which would need correlating by
  transaction hash to reconstruct as one trade; this correlation step was
  **not implemented** in this phase, for time/scope reasons, in favor of
  the more reliable and already-verified pool-log approach in §2a).
- **Robinhood Chain support:** yes (it's Robinhood Chain's own explorer).
- **Historical depth:** full indexed history (Blockscout indexes from
  genesis).
- **API requirements:** none (unauthenticated).
- **Rate limits:** none documented; the real constraint is intermittent
  Cloudflare bot-mitigation, exactly as found in Phase 2.
- **Cost:** free.
- **Reliability:** the same honest verdict as Phase 2 — real, but not
  dependable enough to be the primary source.
- **Limitation:** would require building Transfer→swap correlation logic
  to be as useful as §2a; not done this phase given §2a already provides a
  verified, more reliable path to the same information for pools we
  already know about.

### 2c. Zerion — documented, NOT tested (no API key)

Zerion's official docs (`developers.zerion.io/supported-blockchains`,
fetched live) list a chain with the slug **`robinhood`** among 38+
supported chains. This is a real finding from an official source, but:

- Zerion's API requires an API key (not a free/anonymous endpoint like
  DexScreener or Blockscout) — no key was obtained or used in this phase.
- **No request against Zerion's API was made.** Nothing about its actual
  response shape, wallet-history depth, rate limits, or pricing for this
  chain specifically was verified. The chain-slug listing is the only
  confirmed fact.
- This is the most promising candidate for **wallet-centric** (not
  pool-centric) portfolio/activity history — a genuine gap in what §2a/2b
  provide (see §2d) — but implementing against it without ever having
  tested a real response would risk exactly the "do not claim a provider
  works unless tested" violation. Documented as a **future option**, not
  implemented.

### 2d. The core limitation: no wallet-centric "show me everything" source was verified

Every wallet-activity source actually implemented and verified in this
phase (§2a) is **pool-scoped**: you must already know which token/pool to
check. There is currently no verified way to ask "what has wallet X traded,
across all of Robinhood Chain, ever?" without either (a) a working Zerion
integration (untested, §2c) or (b) building Blockscout Transfer-event
correlation (not built, §2b). In practice, this phase's wallet-intelligence
is exercised on wallets already observed via a Scout signal or an explicit
token/pool list — not arbitrary wallet lookup. This is the single most
important limitation to carry into Phase 4+.

## 3. Historical price/liquidity-at-trade-time — not available

No provider verified in Phase 2 or Phase 3 gives **historical** price or
liquidity at an arbitrary past timestamp — DexScreener's API (Phase 2)
returns current/live pair state only. Consequently, `WalletTrade.approxUsdValue`,
`tokenPriceUsdAtTrade`, and `liquidityUsdAtTrade` are `null` for every
trade produced by the real on-chain provider in this phase — not because
the code doesn't populate them, but because no verified data source exists
yet to populate them honestly. Using a token's *current* price for a past
trade was considered and rejected as inventing a historical price. This is
exactly the "IMPORTANT: Do not invent historical prices" requirement in
practice, and it's the reason most round-trips computed from real data in
this phase land in `OPEN`/`UNKNOWN` rather than `WIN`/`LOSS` — see
`src/wallet-intelligence/README.md` for how the performance engine is still
fully implemented and tested (against synthetic trades with known USD
values) despite this real-world data gap.

## 3a. Scalability finding: swap-log enrichment cost on a high-volume pool

While building the live integration test for this phase, a full-range
(`npm run test:integration`) run against the real WETH/USDG pool did not
complete in several minutes and was abandoned in favor of a bounded smoke
test. Root cause, confirmed with a small explicit 20-block range: that pool
alone produced **24 real swaps in 20 blocks** — over 1 per block. Each swap
currently costs two sequential RPC round-trips in
`uniswapV3PoolProvider.ts` (a transaction lookup for `trader`, and a block
timestamp lookup, the latter cached per unique block within one call). At
that swap density, the previous default lookback (2000 blocks) implied
thousands of sequential round-trips against the public, rate-limited RPC —
slow, and arguably close to "hammering" a provider, which the brief
explicitly warns against.

**Fix applied:** `DEFAULT_LOOKBACK_BLOCKS` reduced from 2000 to 200. This
is a real, verified fix (not just a guess) — see
`uniswapV3PoolProvider.ts` for the updated constant and its reasoning.
**Not done, and worth doing before relying on wide-range queries against
a high-volume pool:** parallelizing the per-swap `trader`/timestamp
enrichment with the `ConcurrencyLimiter` already built for this phase
(currently only applied across *pools* in
`OnChainWalletActivityProvider`, not across the swaps *within* one pool's
log fetch). Flagged here as a concrete, scoped follow-up rather than
silently left for someone to rediscover.

**Follow-up observation:** after fixing the above and re-testing with an
explicitly small 30-block range (not relying on any default), the live
integration test still took **71 seconds** to complete — noticeably slower
than an earlier ad-hoc 20-block check that completed in a few seconds
minutes prior. Both used the same public RPC. This is consistent with (not
independently proven beyond) the official docs' own warning that the
public RPC is "rate-limited and not recommended for production use" —
apparent latency/throughput can vary significantly under repeated use from
the same source. Documented as observed variability, not a fixed number to
rely on.

## 4. Summary table

| Source | Verified live? | Wallet-centric? | Gives USD/price history? | Used as |
|---|---|---|---|---|
| Direct RPC / pool Swap logs | ✅ | Only if pools known | ❌ | Primary `WalletActivityProvider` |
| Blockscout address endpoints | ✅ (intermittent) | ✅ | ❌ (raw transfers only) | Documented alternative, not implemented |
| Zerion | ❌ (docs only) | ✅ (claimed) | Unknown (untested) | Documented future option |
| DexScreener (Phase 2) | ✅ | ❌ (token-centric) | Current only, not historical | Not used for wallet trade history |
