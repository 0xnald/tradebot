// Phase 7 §9 — a configurable in-memory paper portfolio ledger. No
// leverage, no borrowing: a position can only open if enough simulated
// cash is actually available. These are simulation parameters only, not
// tuned/optimized in this phase — see PaperPortfolioConfig.

import type { PaperPortfolioConfig } from "../types/domain.js";

export type PositionRejectionReason = "MAX_CONCURRENT_POSITIONS" | "INSUFFICIENT_CAPITAL";

export interface PositionAdmission {
  allowed: boolean;
  reason?: PositionRejectionReason;
}

export class PaperPortfolio {
  readonly config: PaperPortfolioConfig;
  #cashUsd: number;
  #openPositionsCostBasisUsd = 0;
  #openPositionCount = 0;

  constructor(config: PaperPortfolioConfig) {
    this.config = config;
    this.#cashUsd = config.startingCapitalUsd;
  }

  get cashUsd(): number {
    return this.#cashUsd;
  }

  get openPositionCount(): number {
    return this.#openPositionCount;
  }

  /** Cost-basis equity (cash + committed position sizes) — no intraday mark-to-market, matching the same simplification Phase 6's portfolio simulator uses. */
  get equityUsd(): number {
    return this.#cashUsd + this.#openPositionsCostBasisUsd;
  }

  /** Fixed % of current cash, capped at the configured maximum — never a % of total equity, so a string of losses shrinks future position sizes (no leverage effect). */
  computePositionSizeUsd(): number {
    const pctOfCash = (this.#cashUsd * this.config.positionSizePct) / 100;
    return Math.min(pctOfCash, this.config.maxPositionSizeUsd);
  }

  canOpenPosition(sizeUsd: number): PositionAdmission {
    if (this.#openPositionCount >= this.config.maxConcurrentPositions) {
      return { allowed: false, reason: "MAX_CONCURRENT_POSITIONS" };
    }
    // sizeUsd <= 0 happens when cash has been fully depleted (0% of $0 is $0) — a real capital
    // shortage, not a valid zero-dollar trade, so it's rejected the same way as "not enough cash."
    if (sizeUsd <= 0 || sizeUsd > this.#cashUsd) {
      return { allowed: false, reason: "INSUFFICIENT_CAPITAL" };
    }
    return { allowed: true };
  }

  openPosition(sizeUsd: number): void {
    this.#cashUsd -= sizeUsd;
    this.#openPositionsCostBasisUsd += sizeUsd;
    this.#openPositionCount += 1;
  }

  closePosition(sizeUsd: number, realizedPnlUsd: number): void {
    this.#cashUsd += sizeUsd + realizedPnlUsd;
    this.#openPositionsCostBasisUsd -= sizeUsd;
    this.#openPositionCount -= 1;
  }
}
