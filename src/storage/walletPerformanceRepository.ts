import type { WalletPerformanceSummary } from "../types/domain.js";
import { createFileRepository, type FileRepository } from "./fileRepository.js";

export type WalletPerformanceRepository = FileRepository<WalletPerformanceSummary>;

/** Latest snapshot per wallet — recomputing overwrites the previous one. */
export function walletPerformanceId(summary: WalletPerformanceSummary): string {
  return `${summary.chainId}:${summary.walletAddress.toLowerCase()}`;
}

export function createWalletPerformanceRepository(filePath: string): WalletPerformanceRepository {
  return createFileRepository<WalletPerformanceSummary>({ filePath, getId: walletPerformanceId, mode: "upsert" });
}
