// Resolves (or, honestly, fails to resolve) a full wallet address from what
// Scout actually published. See docs/WALLET_DATA_SOURCES.md §1 for the full
// investigation — the short version: real Scout messages never contain a
// full wallet address anywhere (text, entities, or buttons), so in
// practice every real wallet from Scout resolves as "unresolved" today.
// This is still written generically against any linked button URL,
// matching Phase 1's approach to recovering the *token* contract address,
// so it costs nothing and is directly testable against the "resolved from
// URL" / "ambiguous" cases even though real data doesn't exercise them yet.

import { ROBINHOOD_MAINNET_CHAIN_ID } from "../blockchain/chainConfig.js";
import type { ScoutSignal, WalletIdentity } from "../types/domain.js";

const TRUNCATED_PATTERN = /^0x([0-9a-fA-F]+)…([0-9a-fA-F]+)$/;

function buildFullAddressPattern(prefix: string, suffix: string): RegExp | null {
  const middleLength = 40 - prefix.length - suffix.length;
  if (middleLength < 0) return null; // malformed truncated string — prefix+suffix alone exceed a full address
  return new RegExp(`0x${prefix}[0-9a-fA-F]{${middleLength}}${suffix}`, "i");
}

/**
 * Resolves one truncated wallet string against a list of candidate URLs
 * (a signal's linked buttons). Never guesses: exactly one distinct match
 * is required for "high" confidence; zero or more-than-one both leave
 * `address` unset.
 */
export function resolveWalletFromTruncated(
  truncated: string,
  candidateUrls: string[],
  sourceReferenceBase: string[],
  discoveredAt: string,
  chainId: number = ROBINHOOD_MAINNET_CHAIN_ID,
): WalletIdentity {
  const parsed = TRUNCATED_PATTERN.exec(truncated.trim());
  if (!parsed) {
    return {
      chainId,
      truncatedAddress: truncated,
      discoverySource: "scout-message-text",
      discoveredAt,
      confidence: "unresolved",
      label: "truncated wallet string did not match the expected 0xPREFIX…SUFFIX shape",
      sourceReferences: sourceReferenceBase,
    };
  }

  const pattern = buildFullAddressPattern(parsed[1], parsed[2]);
  const matches = new Set<string>();
  const matchingUrls: string[] = [];

  if (pattern) {
    for (const url of candidateUrls) {
      const match = pattern.exec(url);
      if (match) {
        matches.add(match[0].toLowerCase());
        matchingUrls.push(url);
      }
    }
  }

  if (matches.size === 1) {
    return {
      chainId,
      address: [...matches][0],
      truncatedAddress: truncated,
      discoverySource: "scout-message-buttons",
      discoveredAt,
      confidence: "high",
      sourceReferences: [...sourceReferenceBase, ...matchingUrls],
    };
  }

  if (matches.size > 1) {
    return {
      chainId,
      truncatedAddress: truncated,
      discoverySource: "scout-message-buttons",
      discoveredAt,
      confidence: "low",
      label: "ambiguous: more than one distinct address in linked buttons matches this truncated pattern",
      sourceReferences: [...sourceReferenceBase, ...matchingUrls],
    };
  }

  return {
    chainId,
    truncatedAddress: truncated,
    discoverySource: "scout-message-text",
    discoveredAt,
    confidence: "unresolved",
    label: "no linked button contains a full address matching this truncated pattern",
    sourceReferences: sourceReferenceBase,
  };
}

/** Resolves an identity for every live-buy line on a Scout signal, in order. */
export function resolveScoutWalletIdentities(signal: ScoutSignal): WalletIdentity[] {
  const liveBuys = signal.liveBuys ?? [];
  if (liveBuys.length === 0) return [];

  const candidateUrls = signal.links ?? [];
  const discoveredAt = signal.receivedAt;
  const chainId = signal.chainId ?? ROBINHOOD_MAINNET_CHAIN_ID;

  return liveBuys.map((buy) =>
    resolveWalletFromTruncated(buy.walletTruncated, candidateUrls, [signal.id], discoveredAt, chainId),
  );
}
