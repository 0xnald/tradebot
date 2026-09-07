# blockchain

Read-only access to Robinhood Chain (EVM, chain ID 4663). This is the only
module allowed to hold a viem `PublicClient` — everything else that needs
chain data goes through `RobinhoodChainClient`.

- **Input:** contract addresses, wallet addresses, transaction hashes.
- **Output:** raw chain facts (balances, token metadata, logs, deployment
  info).
- **Must NOT:** sign or submit transactions. There is no signer, no private
  key handling, and no transaction-building code anywhere in this module —
  see the repo-wide "PAPER TRADING SAFETY" constraint.

Status: implemented (Phase 2).

## `RobinhoodChainClient`

A thin wrapper around a viem `PublicClient`, built with the official RPC
endpoint by default (see `.env.example` / `chainConfig.ts` — sourced from
`docs.robinhood.com/chain/connecting`, see `docs/DATA_SOURCES.md` §1).

Methods: `getBlockNumber`, `getTransaction`, `getTransactionReceipt`,
`getNativeBalance`, `getTokenBalance`, `getTokenMetadata`, `getLogs`,
`readContract` (generic escape hatch for other modules, e.g. Uniswap pool
reads in `src/market-data`), plus two chain-only (no external indexer)
capabilities:

- **`findContractDeploymentBlock`** — binary-searches `eth_getCode` to find
  the first block a contract existed at. ~26 RPC calls at the current
  ~55M block height. No indexer needed.
- **`getContractCreationInfo`** — uses the above, then scans that single
  block's transactions for the contract-creation tx (`to === null`) whose
  receipt's `contractAddress` matches, to recover the deployer address and
  creation tx hash. Also purely on-chain.

Constructor accepts an injected viem `PublicClient` (`options.client`) so
tests can supply a `custom()` transport with mocked RPC responses instead
of hitting the network — see `robinhoodChainClient.test.ts`. The one thing
that does hit the real network is `src/integration/*.test.integration.ts`
(`npm run test:integration`), which confirmed this client works against
the real RPC on 2026-09-05 (see `docs/DATA_SOURCES.md` §6a).

## What needed research vs. what's obvious EVM stuff

Chain ID, RPC URLs, and Uniswap contract addresses are all sourced from
official documentation, not guessed — see `docs/DATA_SOURCES.md`. Standard
ERC20 reads and RPC methods are ordinary EVM/viem usage and didn't need
separate verification beyond "does viem's documented API still look like
this" (checked against the installed `viem@2.56.x`).
