// Links wallets (resolved or not) to the Scout signal they were observed
// in. Preserved for later cross-signal strategy evaluation (Phase 6/7) —
// this module only builds and stores the association; it does not compute
// any performance across it.

import type { ScoutSignal, ScoutWalletAssociation } from "../types/domain.js";
import { resolveScoutWalletIdentities } from "./scoutWalletIdentityResolver.js";

export function buildScoutWalletAssociations(signal: ScoutSignal): ScoutWalletAssociation[] {
  const liveBuys = signal.liveBuys ?? [];
  if (liveBuys.length === 0) return [];

  const identities = resolveScoutWalletIdentities(signal);
  const observedAt = new Date().toISOString();

  return liveBuys.map((buy, index) => {
    const wallet = identities[index];
    return {
      id: `${signal.id}:${index}`,
      scoutSignalId: signal.id,
      chainId: wallet.chainId,
      wallet,
      badge: buy.badge,
      amountUsdClaimed: buy.amountUsd,
      associationSource: `scout-message:${signal.id}`,
      confidence: wallet.confidence,
      observedAt,
      rawEvidence: `${buy.badge} $${buy.amountUsd} · ${buy.walletTruncated}`,
    };
  });
}
