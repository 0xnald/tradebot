// Read-only Robinhood Chain client. Deliberately has no concept of a
// private key, signer, or wallet — see PAPER TRADING SAFETY in the Phase 2
// brief. Every method here is a read (eth_call / eth_getLogs / etc.);
// nothing here can submit a transaction.

import {
  createPublicClient,
  http,
  isAddress,
  getAddress,
  type Address,
  type Hash,
  type Log,
  type PublicClient,
  type Transport,
} from "viem";
import { ERC20_ABI } from "./erc20Abi.js";
import { defineRobinhoodChain, loadChainConfigFromEnv, type ChainConfig } from "./chainConfig.js";

export interface TokenMetadataRaw {
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  totalSupplyRaw: string | null;
}

export interface ContractCreationInfo {
  deploymentBlock: number;
  deploymentTimestamp: string;
  deployerAddress: string | null;
  creationTxHash: string | null;
}

export interface RobinhoodChainClientOptions {
  config?: ChainConfig;
  /** Inject a pre-built viem PublicClient (tests use this with a mocked transport). */
  client?: PublicClient;
}

export function isValidAddress(value: string): value is Address {
  return isAddress(value);
}

/**
 * Thin, read-only wrapper around a viem PublicClient for Robinhood Chain.
 * Intentionally exposes only reads — see module doc comment above.
 */
export class RobinhoodChainClient {
  readonly chainId: number;
  #client: PublicClient;

  constructor(options: RobinhoodChainClientOptions = {}) {
    const config = options.config ?? loadChainConfigFromEnv();
    this.chainId = config.chainId;
    this.#client =
      options.client ??
      (createPublicClient({
        chain: defineRobinhoodChain(config),
        transport: http(config.rpcUrl) as Transport,
      }) as PublicClient);
  }

  async getBlockNumber(): Promise<bigint> {
    return this.#client.getBlockNumber();
  }

  async getTransaction(hash: Hash) {
    return this.#client.getTransaction({ hash });
  }

  async getTransactionReceipt(hash: Hash) {
    return this.#client.getTransactionReceipt({ hash });
  }

  async getNativeBalance(address: Address): Promise<bigint> {
    return this.#client.getBalance({ address });
  }

  async getTokenBalance(token: Address, owner: Address): Promise<bigint> {
    return this.#client.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [owner],
    });
  }

  /**
   * Generic read-only contract call, for other modules (e.g.
   * src/market-data's Uniswap pool discovery) that need to read a contract
   * this client doesn't have a dedicated method for. Still just an
   * `eth_call` — never a state-changing transaction.
   */
  async readContract<T>(params: Parameters<PublicClient["readContract"]>[0]): Promise<T> {
    return this.#client.readContract(params) as Promise<T>;
  }

  /**
   * Reads name/symbol/decimals/totalSupply directly from the token
   * contract. Each field is independently best-effort: if one call reverts
   * (e.g. a non-standard token missing `name()`), the others still
   * populate rather than the whole call failing.
   */
  async getTokenMetadata(token: Address): Promise<TokenMetadataRaw> {
    const [name, symbol, decimals, totalSupply] = await Promise.all([
      this.#client
        .readContract({ address: token, abi: ERC20_ABI, functionName: "name" })
        .catch(() => null),
      this.#client
        .readContract({ address: token, abi: ERC20_ABI, functionName: "symbol" })
        .catch(() => null),
      this.#client
        .readContract({ address: token, abi: ERC20_ABI, functionName: "decimals" })
        .catch(() => null),
      this.#client
        .readContract({ address: token, abi: ERC20_ABI, functionName: "totalSupply" })
        .catch(() => null),
    ]);

    return {
      name: name ?? null,
      symbol: symbol ?? null,
      decimals: decimals ?? null,
      totalSupplyRaw: totalSupply !== null && totalSupply !== undefined ? totalSupply.toString() : null,
    };
  }

  async getLogs(params: Parameters<PublicClient["getLogs"]>[0]): Promise<Log[]> {
    return this.#client.getLogs(params);
  }

  async getBlockTimestamp(blockNumber: bigint): Promise<string> {
    const block = await this.#client.getBlock({ blockNumber });
    return new Date(Number(block.timestamp) * 1000).toISOString();
  }

  /** Raw deployed bytecode, or null if the address has no code (not a contract). Used for selector-presence feature detection — see src/token-analysis/contractFeatureAnalyzer.ts. */
  async getBytecode(address: Address): Promise<string | null> {
    const code = await this.#client.getBytecode({ address });
    return code && code !== "0x" ? code : null;
  }

  /** Raw storage slot value. Used for proxy-pattern detection (EIP-1967) — see contractFeatureAnalyzer.ts. */
  async getStorageAt(address: Address, slot: `0x${string}`): Promise<string | null> {
    const value = await this.#client.getStorageAt({ address, slot });
    return value ?? null;
  }

  /**
   * Binary-searches for the block at which `address` first had contract
   * code, using `eth_getCode` — no external indexer needed in principle.
   *
   * IMPORTANT, live-tested finding (Phase 4): Robinhood Chain's public RPC
   * only serves `eth_getCode` for RECENT history — confirmed live to work
   * ~6,000 blocks back from the tip and fail ~8,000 blocks back (a
   * non-archive node with a short retained-state window; exact cutoff not
   * pinned down further). This means this method — and anything built on
   * it (`getContractCreationInfo`, deployer lookup, pool-age lookup) —
   * will genuinely fail for any contract deployed further back than that
   * window when using the default public RPC. It throws in that case
   * (a clear, contextual error — see below) rather than silently
   * returning a wrong answer; every caller in this codebase
   * (TokenAnalysisService, PoolQualityAnalyzer) already catches that and
   * reports the corresponding field as unavailable rather than crashing.
   * A paid archive-capable RPC provider (Alchemy, etc. — see
   * docs/DATA_SOURCES.md §1) would remove this limitation.
   *
   * Returns null if the address currently has no code (not a contract).
   */
  async findContractDeploymentBlock(address: Address): Promise<number | null> {
    const currentCode = await this.#client.getBytecode({ address });
    if (!currentCode || currentCode === "0x") return null;

    let low = 0n;
    let high = await this.#client.getBlockNumber();

    // Invariant: code does NOT exist at `low`, code DOES exist at `high`.
    const codeExistsAt = async (block: bigint): Promise<boolean> => {
      const code = await this.#client.getBytecode({ address, blockNumber: block });
      return Boolean(code && code !== "0x");
    };

    // Block 0 (genesis) specifically errors even on RPCs that otherwise
    // serve plenty of history — observed as a distinct failure from the
    // general pruning behavior above. It's never queried again after this
    // (the loop below only re-checks `mid` values, never `low` itself), so
    // failing open here (assume not genesis-deployed) is safe.
    let genesisDeployed = false;
    try {
      genesisDeployed = await codeExistsAt(low);
    } catch {
      genesisDeployed = false;
    }
    if (genesisDeployed) return 0;

    while (low + 1n < high) {
      const mid = low + (high - low) / 2n;
      let midHasCode: boolean;
      try {
        // eslint-disable-next-line no-await-in-loop
        midHasCode = await codeExistsAt(mid);
      } catch (error) {
        throw new Error(
          `findContractDeploymentBlock: eth_getCode failed at block ${mid} (current tip ~${high}). ` +
            `This RPC likely doesn't retain state that far back (see the non-archive-node finding in this method's doc comment) — ` +
            `a paid archive RPC provider may be required for contracts this old. Original error: ${
              error instanceof Error ? error.message : String(error)
            }`,
        );
      }
      if (midHasCode) {
        high = mid;
      } else {
        low = mid;
      }
    }

    return Number(high);
  }

  /**
   * Finds the deployer and creation transaction for a contract by locating
   * its deployment block (see `findContractDeploymentBlock`) and then
   * scanning that single block's transactions for a contract-creation tx
   * (`to === null`) whose resulting contract address matches. Purely
   * on-chain — no indexer dependency.
   */
  async getContractCreationInfo(address: Address): Promise<ContractCreationInfo | null> {
    const deploymentBlock = await this.findContractDeploymentBlock(address);
    if (deploymentBlock === null) return null;

    const block = await this.#client.getBlock({
      blockNumber: BigInt(deploymentBlock),
      includeTransactions: true,
    });

    const target = getAddress(address);
    let deployerAddress: string | null = null;
    let creationTxHash: string | null = null;

    for (const tx of block.transactions) {
      if (typeof tx === "string") continue; // shouldn't happen with includeTransactions: true
      if (tx.to !== null) continue; // only contract-creation txs have to === null
      try {
        const receipt = await this.#client.getTransactionReceipt({ hash: tx.hash });
        if (receipt.contractAddress && getAddress(receipt.contractAddress) === target) {
          deployerAddress = getAddress(tx.from);
          creationTxHash = tx.hash;
          break;
        }
      } catch {
        // Receipt lookup failed for this tx — keep scanning the rest of the block.
      }
    }

    return {
      deploymentBlock,
      deploymentTimestamp: new Date(Number(block.timestamp) * 1000).toISOString(),
      deployerAddress,
      creationTxHash,
    };
  }
}
