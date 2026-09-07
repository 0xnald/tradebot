import type { WalletIdentity } from "../types/domain.js";
import { createFileRepository, type FileRepository } from "./fileRepository.js";

export type WalletIdentityRepository = FileRepository<WalletIdentity>;

/**
 * A resolved identity is keyed by its real address (one record per known
 * wallet, upserted as new evidence arrives). An unresolved one has no
 * address to key by, so it's keyed by its evidence instead — this still
 * dedupes correctly if the same unresolved observation is processed twice
 * (e.g. re-running ingestion), without conflating two different unresolved
 * mentions into one record.
 */
export function walletIdentityId(identity: WalletIdentity): string {
  if (identity.address) return `${identity.chainId}:${identity.address.toLowerCase()}`;
  return `${identity.chainId}:unresolved:${identity.discoverySource}:${identity.sourceReferences.join(",")}`;
}

export function createWalletIdentityRepository(filePath: string): WalletIdentityRepository {
  return createFileRepository<WalletIdentity>({ filePath, getId: walletIdentityId, mode: "upsert" });
}
