# token-analysis

Contract-level analysis of the token itself: metadata, deployment info,
deployer identity, and holder distribution. Combines direct on-chain reads
(via `src/blockchain`) with an indexer for the one thing the chain alone
can't give you.

- **Input:** `TokenContractInfo` (see `src/types/domain.ts`).
- **Output:** completed `TokenContractInfo`, wrapped in a `ProviderResult`.
- **Must NOT:** make a buy/wait/ignore decision — that's `scoring` + `risk`.
  Must NOT trust an external channel's "elite wallet" claims — holder
  quality here is only ever derived from actual on-chain/indexer data.

Status: implemented (Phase 2) for metadata, deployment, and holder
distribution; Phase 4 added contract feature detection, token age,
deployer analysis, and holder concentration breakdowns. Honeypot
*guarantees* are explicitly out of scope — see `ContractFeatureAnalyzer`
below.

## Phase 4 additions

- **`ContractFeatureAnalyzer`** — bytecode-selector evidence for
  mint/burn/pause/blacklist/ownership/max-tx/max-wallet/fee functions,
  plus EIP-1967 proxy detection. Evidence, never a safety verdict — see
  `docs/TOKEN_MARKET_INTELLIGENCE.md` §1.
- **`tokenAgeAnalyzer.ts`** — `computeTokenAge()`, documented age
  categories (`BRAND_NEW`/`VERY_NEW`/`NEW`/`ESTABLISHED`/`MATURE`).
- **`holderConcentrationAnalyzer.ts`** — top-5/top-10/largest-holder/
  deployer-share breakdowns, derived from an already-fetched
  `HolderDistribution` (no new fetch).
- **`DeployerAnalyzer`** — deployer's own balances (reusing
  `RobinhoodChainClient`) and observed swap count (reusing already-fetched
  `SwapRecord[]`) — never a new indexer call, never an identity claim.

## `TokenAnalysisService`

Orchestrates `RobinhoodChainClient` (name/symbol/decimals/totalSupply,
deployment block/timestamp, deployer address — all obtainable purely
on-chain, see `docs/DATA_SOURCES.md` §5) and a `HolderDataProvider`
(holder count/distribution, which is **not** obtainable on-chain without
indexing every `Transfer` event since deployment). Callers get one
`ProviderResult<TokenContractInfo>` back; they don't need to know which
half of the data came from where — that split is exactly what
`docs/DATA_SOURCES.md` documents.

## `HolderDataProvider` → `BlockscoutHolderDataProvider`

Calls Robinhood Chain's official Blockscout instance
(`robinhoodchain.blockscout.com`), which does carry real holder-count and
per-holder balance data (confirmed against the real WETH token, see
`docs/DATA_SOURCES.md` §3). **This is the one provider in Phase 2 that is
not reliably reachable** — its `/holders` endpoint failed 3/3 attempts in
testing with a Cloudflare bot-challenge (confirmed again in the final live
integration run, `docs/DATA_SOURCES.md` §6a). Every caller must handle an
`"error"`/`"partial"` result from this provider as a normal, expected
outcome — not an edge case.

If a deployer address is known (from `TokenAnalysisService`'s on-chain
lookup), it's passed through so the provider can report the deployer's own
holding percentage when it appears in the top-holders page.
