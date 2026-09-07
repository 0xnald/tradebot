// Phase 6.6 — estimates which block number was current at a given
// timestamp, so on-chain event reconstruction knows roughly where to
// search without a slow O(log n) binary search per lookup. This is
// EXPLICITLY an estimate used only to pick a search window — every actual
// observation returned to a caller always carries a REAL, freshly-resolved
// block timestamp (via BlockTimestampResolver), never this estimate.
//
// Calibrated from two real on-chain points (current tip and a block ~1M
// back) rather than a hardcoded blocks-per-second constant, since a
// hardcoded constant would silently drift wrong if block time ever
// changes. Two extra RPC calls, computed once and cached for the life of
// this instance — share one instance across a whole backtest run.

import type { RobinhoodChainClient } from "./robinhoodChainClient.js";

const DEFAULT_CALIBRATION_LOOKBACK_BLOCKS = 1_000_000n;

interface CalibrationModel {
  blockA: bigint;
  timestampAMs: number;
  blockB: bigint;
  timestampBMs: number;
}

export class BlockTimeEstimator {
  #chainClient: RobinhoodChainClient;
  #calibrationLookbackBlocks: bigint;
  #model: CalibrationModel | null = null;

  constructor(chainClient: RobinhoodChainClient, calibrationLookbackBlocks: bigint = DEFAULT_CALIBRATION_LOOKBACK_BLOCKS) {
    this.#chainClient = chainClient;
    this.#calibrationLookbackBlocks = calibrationLookbackBlocks;
  }

  async #ensureModel(): Promise<CalibrationModel> {
    if (this.#model) return this.#model;

    const blockB = await this.#chainClient.getBlockNumber();
    const timestampBMs = new Date(await this.#chainClient.getBlockTimestamp(blockB)).getTime();
    const blockA = blockB > this.#calibrationLookbackBlocks ? blockB - this.#calibrationLookbackBlocks : 0n;
    const timestampAMs = new Date(await this.#chainClient.getBlockTimestamp(blockA)).getTime();

    this.#model = { blockA, timestampAMs, blockB, timestampBMs };
    return this.#model;
  }

  /** Linear-interpolates (or extrapolates) a block number for `timestampMs`, clamped to >= 0. An estimate for search-window sizing only — never treated as an exact block. */
  async estimateBlockAt(timestampMs: number): Promise<bigint> {
    const { blockA, timestampAMs, blockB, timestampBMs } = await this.#ensureModel();
    if (timestampBMs === timestampAMs) return blockB;

    const fraction = (timestampMs - timestampAMs) / (timestampBMs - timestampAMs);
    const blockDelta = Number(blockB - blockA);
    const estimated = blockA + BigInt(Math.round(fraction * blockDelta));
    return estimated < 0n ? 0n : estimated;
  }
}
