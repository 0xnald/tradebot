// Pons V2 launch discovery for Robinhood Chain — see docs/DATA_SOURCES.md
// §7 for the full verification record. A Pons V2 token never appears in
// Uniswap V3 factory discovery: pre-graduation it trades on a bonding
// curve (not a DEX pool at all), and post-graduation its liquidity moves
// to a Uniswap V4 pool, which has no per-pool contract address to look up
// via a V3-style factory `getPool()` call.

import { getAddress, isAddress, keccak256, encodeAbiParameters, parseAbiItem, type Address } from "viem";
import type { RobinhoodChainClient } from "../blockchain/robinhoodChainClient.js";
import { PONS_ADDRESSES } from "../blockchain/chainConfig.js";
import { fetchLogsWithAdaptiveChunking } from "../blockchain/logRangeChunking.js";
import { PONS_V2_FACTORY_ABI, PONS_V2_GRADUATION_PHASES } from "./ponsV2Abi.js";
import type { ProviderResult } from "../types/domain.js";

const CURVE_COMPLETED_EVENT = parseAbiItem("event CurveCompleted(address recipient, uint256 quoteOut, uint256 tokenOut)");

/**
 * `CurveCompleted` fires at most once per curve, so scanning from genesis
 * would eventually find it — but genuinely scanning tens of millions of
 * blocks against a documented-rate-limited public RPC was measured live
 * to take minutes per token and to destabilize a multi-signal backtest
 * run. Pons launches are short-lived speculative tokens by construction
 * (the whole real dataset spans one day); bounding the search to a
 * generous, documented recent window is a disclosed assumption, not a
 * silent one — see docs/DATA_SOURCES.md §7.
 */
const DEFAULT_GRADUATION_SEARCH_LOOKBACK_BLOCKS = 5_000_000n;

export type PonsV2GraduationPhase = (typeof PONS_V2_GRADUATION_PHASES)[number];

export interface PonsV2LaunchInfo {
  token: string;
  curve: string;
  deployer: string;
  pairToken: string;
  poolFee: number;
  tickSpacing: number;
  phase: PonsV2GraduationPhase;
  graduationThreshold: string;
  /**
   * What to pass as a "pool address" to a price provider: the curve
   * contract's own address pre-graduation (GeckoTerminal indexes it
   * directly as the token's pool), or the deterministically-computed
   * Uniswap V4 PoolId once graduated (`POOL_CREATED`/`RESCUED`) — never a
   * value that requires trusting an external index to resolve.
   */
  priceIdentifier: string;
  priceIdentifierKind: "CURVE" | "V4_POOL_ID";
  /**
   * The real on-chain timestamp of the `CurveCompleted` event, when
   * graduated — NEVER inferred from "current phase" alone. A caller
   * MUST compare a historical decision timestamp against this, not
   * against `phase`, before deciding whether the curve or the V4 pool is
   * the correct venue for that decision — using `phase` alone would risk
   * treating a token as "on the V4 pool" for a decision made before it
   * actually graduated. See docs/BACKTESTING.md's graduation-boundary
   * lookahead test.
   */
  graduationTimestamp: string | null;
}

export interface PonsV2ProviderOptions {
  chainClient: RobinhoodChainClient;
  factoryAddress?: Address;
  memeHookAddress?: Address;
  /** How far back (in blocks) to search for a graduated launch's `CurveCompleted` event. See `DEFAULT_GRADUATION_SEARCH_LOOKBACK_BLOCKS`'s doc comment for why this is bounded rather than a full-history scan. */
  graduationSearchLookbackBlocks?: bigint;
}

/** Structural interface so callers (and tests) can supply a fake without constructing a real `PonsV2Provider`. */
export interface PonsV2LaunchDataProvider {
  readonly name: string;
  getLaunchInfo(tokenAddress: string): Promise<ProviderResult<PonsV2LaunchInfo | null>>;
}

/**
 * Uniswap V4's PoolId = keccak256(abi.encode(currency0, currency1, fee,
 * tickSpacing, hooks)), with currencies sorted numerically. Verified live
 * against a real graduated Pons launch: this computation matched
 * GeckoTerminal's independently-reported pool id exactly — see
 * docs/DATA_SOURCES.md §7.
 */
function computeV4PoolId(token: Address, pairToken: Address, poolFee: number, tickSpacing: number, hooks: Address): `0x${string}` {
  const [currency0, currency1] = BigInt(token) < BigInt(pairToken) ? [token, pairToken] : [pairToken, token];
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [currency0, currency1, poolFee, tickSpacing, hooks],
    ),
  );
}

export class PonsV2Provider implements PonsV2LaunchDataProvider {
  readonly name = "pons-v2-onchain";
  #chainClient: RobinhoodChainClient;
  #factoryAddress: Address;
  #memeHookAddress: Address;
  #graduationSearchLookbackBlocks: bigint;

  constructor(options: PonsV2ProviderOptions) {
    this.#chainClient = options.chainClient;
    this.#factoryAddress = options.factoryAddress ?? (PONS_ADDRESSES.v2Factory as Address);
    this.#memeHookAddress = options.memeHookAddress ?? (PONS_ADDRESSES.v2MemeHook as Address);
    this.#graduationSearchLookbackBlocks = options.graduationSearchLookbackBlocks ?? DEFAULT_GRADUATION_SEARCH_LOOKBACK_BLOCKS;
  }

  /**
   * Returns `status: "unavailable"` (not "error") when the token simply
   * was never launched through Pons V2 — that's an expected, common
   * outcome, not a failure.
   */
  async getLaunchInfo(tokenAddress: string): Promise<ProviderResult<PonsV2LaunchInfo | null>> {
    if (!isAddress(tokenAddress)) {
      return {
        status: "error",
        data: null,
        unavailable: ["ponsV2Launch"],
        errors: [{ message: `invalid token address: ${tokenAddress}`, provider: this.name }],
      };
    }

    const token = getAddress(tokenAddress);

    try {
      const raw = await this.#chainClient.readContract<{
        token: Address;
        curve: Address;
        deployer: Address;
        creatorFeeRecipient: Address;
        pairToken: Address;
        graduationThreshold: bigint;
        poolFee: number;
        tickSpacing: number;
        creatorTaxBps: number;
        buybackEnabled: boolean;
        phase: number;
        sweptQuote: bigint;
        sweptTokens: bigint;
        sweptAt: bigint;
        exists: boolean;
      }>({
        address: this.#factoryAddress,
        abi: PONS_V2_FACTORY_ABI,
        functionName: "getLaunchedToken",
        args: [token],
      });

      if (!raw.exists) {
        return { status: "unavailable", data: null, unavailable: ["ponsV2Launch"], errors: [] };
      }

      const phase = PONS_V2_GRADUATION_PHASES[raw.phase] ?? "NOT_GRADUATED";
      const graduated = phase === "POOL_CREATED" || phase === "RESCUED";
      const pairToken = getAddress(raw.pairToken);
      const curve = getAddress(raw.curve);

      const priceIdentifier = graduated
        ? computeV4PoolId(token, pairToken, raw.poolFee, raw.tickSpacing, this.#memeHookAddress)
        : curve;

      const graduationTimestamp = graduated ? await this.#findGraduationTimestamp(curve) : null;

      const info: PonsV2LaunchInfo = {
        token,
        curve,
        deployer: getAddress(raw.deployer),
        pairToken,
        poolFee: raw.poolFee,
        tickSpacing: raw.tickSpacing,
        phase,
        graduationThreshold: raw.graduationThreshold.toString(),
        priceIdentifier,
        priceIdentifierKind: graduated ? "V4_POOL_ID" : "CURVE",
        graduationTimestamp,
      };

      return { status: "ok", data: info, unavailable: [], errors: [] };
    } catch (error) {
      return {
        status: "error",
        data: null,
        unavailable: ["ponsV2Launch"],
        errors: [{ message: error instanceof Error ? error.message : String(error), provider: this.name }],
      };
    }
  }

  /** Searches only the last `#graduationSearchLookbackBlocks` blocks (see its doc comment) — falls back to null (never fabricated) if it can't be found within that window. */
  async #findGraduationTimestamp(curveAddress: Address): Promise<string | null> {
    try {
      const currentBlock = await this.#chainClient.getBlockNumber();
      const fromBlock = currentBlock > this.#graduationSearchLookbackBlocks ? currentBlock - this.#graduationSearchLookbackBlocks : 0n;
      const logs = await fetchLogsWithAdaptiveChunking(
        (from, to) => this.#chainClient.getLogs({ address: curveAddress, event: CURVE_COMPLETED_EVENT, fromBlock: from, toBlock: to }),
        fromBlock,
        currentBlock,
      );
      const blockNumber = logs[0]?.blockNumber;
      if (!blockNumber) return null;
      return await this.#chainClient.getBlockTimestamp(blockNumber);
    } catch {
      return null; // best-effort only — a missing graduation timestamp is handled as UNAVAILABLE by callers, never assumed
    }
  }
}
