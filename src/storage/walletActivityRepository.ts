import type { WalletTrade } from "../types/domain.js";
import { createFileRepository, type FileRepository } from "./fileRepository.js";

export type WalletActivityRepository = FileRepository<WalletTrade>;

/** A trade either happened or it didn't — keyed by the exact on-chain event, never overwritten. */
export function walletTradeId(trade: WalletTrade): string {
  return `${trade.chainId}:${trade.transactionHash}:${trade.poolAddress}:${trade.walletAddress.toLowerCase()}`;
}

export function createWalletActivityRepository(filePath: string): WalletActivityRepository {
  return createFileRepository<WalletTrade>({ filePath, getId: walletTradeId, mode: "append" });
}
