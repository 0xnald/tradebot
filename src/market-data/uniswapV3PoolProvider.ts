// On-chain Uniswap V3 pool discovery and swap retrieval for Robinhood
// Chain. Uses only the officially-verified Factory address and known quote
// tokens — see docs/DATA_SOURCES.md §2. Every "pool exists" fact here comes
// directly from calling the real Factory contract, never guessed.

import { getAddress, isAddress, zeroAddress, type Address } from "viem";
import type { RobinhoodChainClient } from "../blockchain/robinhoodChainClient.js";
import {
  ROBINHOOD_CHAIN_KNOWN_QUOTE_TOKENS,
  UNISWAP_V3_ADDRESSES,
  UNISWAP_V3_FEE_TIERS,
} from "../blockchain/chainConfig.js";
import type { PoolInfo, ProviderResult, SwapRecord, SwapSide } from "../types/domain.js";
import { UNISWAP_V3_FACTORY_ABI, UNISWAP_V3_POOL_ABI, UNISWAP_V3_SWAP_EVENT } from "./uniswapV3Abi.js";
import type { GetRecentSwapsOptions, PoolDataProvider } from "./poolDataProvider.js";

const DEFAULT_QUOTE_TOKENS = Object.values(ROBINHOOD_CHAIN_KNOWN_QUOTE_TOKENS);
/**
 * Bounds an unspecified swap-log block range so a single call can't scan
 * the whole chain. Deliberately kept small (not the ~2000 blocks this
 * started at): each returned swap costs two sequential RPC round-trips
 * (tx.from + block timestamp lookup, the latter cached per unique block),
 * and a live check (Phase 3, docs/WALLET_DATA_SOURCES.md) found the real
 * WETH/USDG pool alone averaging over 1 swap per block — a 2000-block
 * default there means thousands of sequential round-trips against a
 * rate-limited public RPC, which is slow and close to "hammering" a
 * provider. Callers that need a wider window should pass an explicit
 * `fromBlock`/`toBlock` and accept the cost deliberately.
 */
const DEFAULT_LOOKBACK_BLOCKS = 200n;

export interface UniswapV3PoolProviderOptions {
  chainClient: RobinhoodChainClient;
  factoryAddress?: Address;
  quoteTokens?: { address: string; symbol: string }[];
  feeTiers?: readonly number[];
}

/**
 * Positive Swap-event delta for a token means the pool's reserve of that
 * token increased — i.e. the trader sent it INTO the pool (a SELL of that
 * token). Negative means the pool paid it OUT to the trader (a BUY). This
 * is Uniswap V3's documented amount0Delta/amount1Delta convention, not a
 * guess — see the Swap event / `swap()` return value in the V3 core
 * reference.
 */
function classifySide(tokenDelta: bigint): SwapSide {
  if (tokenDelta < 0n) return "BUY";
  if (tokenDelta > 0n) return "SELL";
  return "UNKNOWN";
}

export class UniswapV3PoolProvider implements PoolDataProvider {
  readonly name = "uniswap-v3-onchain";
  #chainClient: RobinhoodChainClient;
  #factoryAddress: Address;
  #quoteTokens: { address: string; symbol: string }[];
  #feeTiers: readonly number[];

  constructor(options: UniswapV3PoolProviderOptions) {
    this.#chainClient = options.chainClient;
    this.#factoryAddress = options.factoryAddress ?? (UNISWAP_V3_ADDRESSES.factory as Address);
    this.#quoteTokens = options.quoteTokens ?? DEFAULT_QUOTE_TOKENS;
    this.#feeTiers = options.feeTiers ?? UNISWAP_V3_FEE_TIERS;
  }

  async discoverPools(contractAddress: string): Promise<ProviderResult<PoolInfo[]>> {
    if (!isAddress(contractAddress)) {
      return {
        status: "error",
        data: null,
        unavailable: ["pools"],
        errors: [{ message: `invalid contract address: ${contractAddress}`, provider: this.name }],
      };
    }

    const token = getAddress(contractAddress);
    const pools: PoolInfo[] = [];
    const errors: { message: string; provider?: string }[] = [];

    for (const quote of this.#quoteTokens) {
      if (getAddress(quote.address) === token) continue; // skip pairing the token with itself

      for (const fee of this.#feeTiers) {
        try {
          const poolAddress = await this.#chainClient.readContract<Address>({
            address: this.#factoryAddress,
            abi: UNISWAP_V3_FACTORY_ABI,
            functionName: "getPool",
            args: [token, getAddress(quote.address), fee],
          });

          if (poolAddress && poolAddress !== zeroAddress) {
            pools.push({
              chainId: this.#chainClient.chainId,
              poolAddress,
              dexId: this.name,
              tokenAddress: token,
              quoteTokenAddress: getAddress(quote.address),
              quoteTokenSymbol: quote.symbol,
              feeTier: fee,
              source: this.name,
            });
          }
        } catch (error) {
          errors.push({
            message: `getPool(${quote.symbol}, fee=${fee}) failed: ${error instanceof Error ? error.message : String(error)}`,
            provider: this.name,
          });
        }
      }
    }

    if (pools.length === 0 && errors.length > 0) {
      return { status: "error", data: null, unavailable: ["pools"], errors };
    }
    return {
      status: errors.length > 0 ? "partial" : "ok",
      data: pools,
      unavailable: errors.length > 0 ? ["some fee-tier/quote-token combinations could not be checked"] : [],
      errors,
    };
  }

  async getRecentSwaps(pool: PoolInfo, options: GetRecentSwapsOptions = {}): Promise<ProviderResult<SwapRecord[]>> {
    try {
      const [token0, token1] = await Promise.all([
        this.#chainClient.readContract<Address>({
          address: pool.poolAddress as Address,
          abi: UNISWAP_V3_POOL_ABI,
          functionName: "token0",
        }),
        this.#chainClient.readContract<Address>({
          address: pool.poolAddress as Address,
          abi: UNISWAP_V3_POOL_ABI,
          functionName: "token1",
        }),
      ]);

      const toBlock = options.toBlock ?? (await this.#chainClient.getBlockNumber());
      const fromBlock = options.fromBlock ?? (toBlock > DEFAULT_LOOKBACK_BLOCKS ? toBlock - DEFAULT_LOOKBACK_BLOCKS : 0n);

      const logs = await this.#chainClient.getLogs({
        address: pool.poolAddress as Address,
        event: UNISWAP_V3_SWAP_EVENT,
        fromBlock,
        toBlock,
      });

      const target = getAddress(pool.tokenAddress);
      const isToken0 = getAddress(token0) === target;
      const isToken1 = getAddress(token1) === target;

      const swaps: SwapRecord[] = [];
      const blockTimestampCache = new Map<string, string>();
      for (const log of logs as any[]) {
        const { amount0, amount1, recipient } = log.args as {
          amount0: bigint;
          amount1: bigint;
          recipient: Address;
        };

        let side: SwapSide = "UNKNOWN";
        let tokenAmount = amount0;
        let quoteAmount = amount1;
        if (isToken0 && !isToken1) {
          side = classifySide(amount0);
          tokenAmount = amount0;
          quoteAmount = amount1;
        } else if (isToken1 && !isToken0) {
          side = classifySide(amount1);
          tokenAmount = amount1;
          quoteAmount = amount0;
        }
        // else: pool doesn't actually contain `pool.tokenAddress` as either
        // token0 or token1 (a caller passed a mismatched PoolInfo) — leave
        // UNKNOWN and fall back to raw amount0/amount1 rather than guessing.

        let trader: string | undefined;
        try {
          const tx = await this.#chainClient.getTransaction(log.transactionHash);
          trader = tx.from;
        } catch {
          trader = undefined; // best-effort only — see PoolInfo/SwapRecord doc comments
        }

        const blockKey = log.blockNumber.toString();
        let timestamp = blockTimestampCache.get(blockKey);
        if (!timestamp) {
          try {
            timestamp = await this.#chainClient.getBlockTimestamp(log.blockNumber);
            blockTimestampCache.set(blockKey, timestamp);
          } catch {
            timestamp = undefined; // best-effort — a missing timestamp doesn't invalidate the rest of the swap record
          }
        }

        swaps.push({
          chainId: this.#chainClient.chainId,
          poolAddress: pool.poolAddress,
          transactionHash: log.transactionHash,
          blockNumber: Number(log.blockNumber),
          timestamp,
          trader: trader ?? recipient,
          tokenAmount: tokenAmount.toString(),
          quoteAmount: quoteAmount.toString(),
          side,
          source: this.name,
        });
      }

      return { status: "ok", data: swaps, unavailable: [], errors: [] };
    } catch (error) {
      return {
        status: "error",
        data: null,
        unavailable: ["swaps"],
        errors: [{ message: error instanceof Error ? error.message : String(error), provider: this.name }],
      };
    }
  }
}
