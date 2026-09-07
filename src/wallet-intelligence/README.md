# wallet-intelligence

Wallet identity, activity, performance, and behavioral relationships. The
goal is not "find wallets" — it's "determine whether a wallet's history
makes its activity a useful signal." See `docs/WALLET_DATA_SOURCES.md` for
the research behind every claim below.

- **Input:** wallet addresses, `ScoutSignal`s, `PoolInfo`s.
- **Output:** `WalletIdentity`, `WalletTrade[]`, `WalletRoundTrip[]`,
  `WalletPerformanceSummary`, `WalletQualityFeatures`,
  `WalletRelationshipSignal`, `ScoutWalletAssociation`.
- **Must NOT:** execute, sign, or broadcast anything — this module is
  research/analysis only. Must NOT claim wallet identity from a
  correlation ("possibly related", never "same person/entity"). Must NOT
  trust Scout's own "elite"/"good" labels as verified fact — they're
  preserved as Scout's claim, not treated as ground truth.

Status: implemented (Phase 3).

## Can Scout's truncated wallets be resolved? No — verified, not assumed

See `docs/WALLET_DATA_SOURCES.md` §1 for the full investigation. Short
version: Scout's messages never contain a full wallet address anywhere —
not in text, not in a hidden formatting entity, not in any linked button
(those only ever encode the *token* contract address). Every wallet
mentioned in a real Scout message today resolves as `confidence:
"unresolved"` via `scoutWalletIdentityResolver.ts`, which still preserves
the truncated string and every piece of surrounding evidence rather than
fabricating an address. The resolver is generic enough to recover a full
address from a button URL if one were ever present (tested against
synthetic fixtures), and to recognize genuine ambiguity (multiple distinct
candidates) as `"low"` confidence rather than guessing one.

`buildScoutWalletAssociations()` links each live-buy line to its Scout
signal — preserving signal id, wallet identity (resolved or not), Scout's
claimed badge/amount, and the raw evidence line — for the cross-signal
strategy evaluation planned in Phase 6/7. It does not compute any
performance across that link yet.

## Wallet activity: `WalletActivityProvider` → `OnChainWalletActivityProvider`

The one verified provider in this phase, built entirely on Phase 2's
already-verified `PoolDataProvider` (real on-chain `Swap` logs — no
external API, no Cloudflare risk). **Pool-scoped**: you must already know
which pools to check — there is no verified "show me everything this
wallet has ever done" source (see `docs/WALLET_DATA_SOURCES.md` §2d for
why, and what a future fix would need). Uses `ConcurrencyLimiter`
(`src/shared/concurrencyLimiter.ts`) to bound parallel pool lookups.

USD/price/liquidity/market-cap fields on every `WalletTrade` from this
provider are `null` — not a bug, see §3 of the data-sources doc: no
verified historical-price source exists yet, and using a token's *current*
price for a past trade would be inventing a historical price, which is
explicitly disallowed.

## Round-trip matching: `walletTradeMatcher.ts`

FIFO per `(wallet, token)`: the oldest open BUY is closed by the next SELL.
A stated, documented methodology — not the only possible one, but a
defined one (no partial-lot splitting, no over-engineering). Explicit
outcome definitions (see the `TradeOutcomeStatus` doc comment in
`src/types/domain.ts`):

- **WIN** — matched BUY→SELL, both USD values known, `pnlUsd > 0`.
- **LOSS** — matched BUY→SELL, both USD values known, `pnlUsd <= 0`.
  Breakeven counts as a LOSS — a deliberate, stated choice, not a silent
  default.
- **OPEN** — a BUY with no matching SELL yet found. May still be held.
- **UNKNOWN** — direction couldn't be classified, or a match was found but
  a required USD value is missing, or a SELL had no matched entry at all
  (an "orphan exit"). Distinct from OPEN.

Because no real trade from the one verified provider carries a USD value
yet, real-world round trips computed from it land in OPEN/UNKNOWN, not
WIN/LOSS — the logic is fully implemented and tested against synthetic
trades with known USD values (see `walletTradeMatcher.test.ts`), but
today's real data simply doesn't have the inputs a WIN/LOSS verdict needs.
This is the correct, honest behavior, not a bug to "fix" by inventing a
price.

## Performance: `WalletPerformanceAnalyzer`

Computes `lifetime`/`30d`/`7d` windows from round trips. A window with zero
trades is `computed: false` with a stated `insufficientDataReason` —
never a fabricated zero. `sampleSizeConfidence` scales with closed-trade
count up to a documented threshold (`SAMPLE_SIZE_CONFIDENCE_TARGET = 30`,
stated as a rule-of-thumb, not empirically derived) — this is what stops a
wallet with 2 lucky trades from outranking one with 200 trades and a
consistent 60% win rate.

## Wallet quality: `WalletQualityAnalyzer`

Produces **features** for a future scoring system — explicitly not a final
score or trade recommendation. Every formula is a simple, disclosed
heuristic (see the doc comments in `walletQualityAnalyzer.ts` for each
one's exact, stated scale). `earlyEntryScore` and `liquidityAwareScore`
depend on entry market-cap/liquidity data no verified provider populates
yet — they're `null`, listed in `unavailableFeatures`, not approximated.

## Wallet relationships: `WalletRelationshipAnalyzer`

A simple feature model (no graph database) detecting common-token overlap
and synchronized-buy timing between two wallets' trade histories. Always
reports `possiblyRelated` — never an identity claim. **Not implemented**:
common funding source / common deployer interaction detection — this would
need an indexed wallet-transaction-history API (native ETH transfers
aren't covered by `eth_getLogs`), which isn't verified in this phase (see
`docs/WALLET_DATA_SOURCES.md` §2). A documented gap, not a hidden one.

## Persistence

Four repositories in `src/storage`, all built on a new generic
`createFileRepository()` (NDJSON, same approach as Phase 1's
`FileSignalRepository`, factored out so these four don't duplicate that
logic): `WalletIdentityRepository` and `WalletPerformanceRepository`
(latest-state, upserted), `WalletActivityRepository` and
`ScoutWalletAssociationRepository` (append-only event logs, deduped by a
stable id).
