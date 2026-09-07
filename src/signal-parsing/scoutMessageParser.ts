// Converts a RawScoutMessage into a normalized ScoutSignal.
//
// The two message templates handled here (EARLY_CALL, PERFORMANCE_UPDATE)
// were derived from real messages captured from the public
// https://t.me/s/scoutrobinhood preview — see
// src/ingestion/fixtures/README.md for provenance and
// src/signal-parsing/README.md for the documented schema. Anything not
// actually present in a message is left undefined; nothing here invents a
// value.

import type { RawScoutMessage, ScoutMessageButton } from "../ingestion/types.js";
import type { ParseConfidence, ScoutLiveBuy, ScoutMessageType, ScoutSignal } from "../types/domain.js";
import { parseAgeToSeconds, parseCompactUsd, parseIntSafe, parsePercent } from "./numberFormats.js";

const CONTRACT_ADDRESS_PATTERN = /0x[0-9a-fA-F]{40}/;

function buildSignalId(source: string, sourceMessageId: string): string {
  return `${source}:${sourceMessageId}`;
}

/**
 * Scout's message TEXT never contains a contract address in the observed
 * data — it only appears inside the message's linked buttons (DexScreener,
 * GMGN, BasedBot deep-link, GeckoTerminal, X search), each redundantly
 * encoding the same address in its URL. This scans all of them and only
 * trusts the result if every button agrees.
 */
function extractContractAddress(buttons: ScoutMessageButton[], warnings: string[]): string | undefined {
  const found = new Set<string>();
  for (const button of buttons) {
    const match = CONTRACT_ADDRESS_PATTERN.exec(button.url);
    if (match) found.add(match[0].toLowerCase());
  }
  if (found.size === 0) {
    warnings.push("no contract address found in message buttons");
    return undefined;
  }
  if (found.size > 1) {
    warnings.push("ambiguous contract address: message buttons reference more than one address");
    return undefined;
  }
  return [...found][0];
}

function classifyMessageType(text: string): ScoutMessageType {
  if (/EARLY CALL/i.test(text)) return "EARLY_CALL";
  if (/hit\s+[0-9.]+X/i.test(text) && /called/i.test(text) && text.includes("→")) {
    return "PERFORMANCE_UPDATE";
  }
  return "UNKNOWN";
}

function parseEarlyCall(text: string, warnings: string[]): Partial<ScoutSignal> {
  const fields: Partial<ScoutSignal> = {};

  const header = /\$(\S+)\s*·\s*(\S+)/.exec(text);
  if (header) {
    fields.tokenSymbol = header[1];
    fields.chainRaw = header[2];
  } else {
    warnings.push("could not parse ticker/chain header line");
  }

  const called = /called at\s*\$([0-9.,]+\s*[kKmMbB]?)/.exec(text);
  if (called) fields.calledValueUsd = parseCompactUsd(called[1]);
  else warnings.push("no 'called at' value found");

  const dex = /DEX:\s*([^\n]+)/.exec(text);
  if (dex) fields.dexName = dex[1].trim();

  const mcap = /Mcap:\s*\$([0-9.,]+\s*[kKmMbB]?)/.exec(text);
  if (mcap) fields.marketCapUsd = parseCompactUsd(mcap[1]);
  else warnings.push("no market cap found");

  const liq = /Liq:\s*\$([0-9.,]+\s*[kKmMbB]?)\s*\|\s*([0-9.]+)%/.exec(text);
  if (liq) {
    fields.liquidityUsd = parseCompactUsd(liq[1]);
    fields.liquidityPct = parsePercent(liq[2]);
  } else {
    warnings.push("no liquidity found");
  }

  const tax = /Tax:\s*B\s*([0-9.]+)%\s*\|\s*S\s*([0-9.]+)%/.exec(text);
  if (tax) {
    fields.buyTaxPct = parsePercent(tax[1]);
    fields.sellTaxPct = parsePercent(tax[2]);
  }

  const age = /Age:\s*([0-9.]+\s*[smhd])(?:\s*·\s*\S*\s*([a-zA-Z0-9_]+))?/i.exec(text);
  if (age) {
    fields.ageRaw = age[1].replace(/\s+/g, "");
    fields.ageSeconds = parseAgeToSeconds(fields.ageRaw);
    if (age[2]) fields.dexSlug = age[2];
  }

  const holders = /Holders:\s*([0-9,]+)/.exec(text);
  if (holders) fields.holderCount = parseIntSafe(holders[1]);

  const vol = /Vol 24h:\s*\$([0-9.,]+\s*[kKmMbB]?)/.exec(text);
  if (vol) fields.volume24hUsd = parseCompactUsd(vol[1]);

  const swaps = /([0-9,]+)\s*swaps\s*\(5m\)/.exec(text);
  if (swaps) fields.swapCount5m = parseIntSafe(swaps[1]);

  fields.dexScreenerVerified = /DexS:\s*profile\s*✓/.test(text);

  const proof = /Proof:\s*([0-9]+)\s*elite\s*\+\s*([0-9]+)\s*good/.exec(text);
  if (proof) {
    fields.eliteHolderCount = parseIntSafe(proof[1]);
    fields.goodHolderCount = parseIntSafe(proof[2]);
  }

  const liveBuys: ScoutLiveBuy[] = [];
  const liveBuyPattern = /(💎|✅)\s*\$([0-9,]+)\s*·\s*(0x[0-9a-fA-F]{2,8}…[0-9a-fA-F]{2,8})/g;
  let match: RegExpExecArray | null;
  while ((match = liveBuyPattern.exec(text))) {
    liveBuys.push({
      badge: match[1] === "💎" ? "elite" : "good",
      amountUsd: Number(match[2].replace(/,/g, "")),
      walletTruncated: match[3],
    });
  }
  if (liveBuys.length > 0) fields.liveBuys = liveBuys;

  return fields;
}

function parsePerformanceUpdate(text: string, warnings: string[]): Partial<ScoutSignal> {
  const fields: Partial<ScoutSignal> = {};

  const header = /\$(\S+)\s+hit\s+([0-9.]+)X/i.exec(text);
  if (header) {
    fields.tokenSymbol = header[1];
    fields.multiplier = Number(header[2]);
  } else {
    warnings.push("could not parse ticker/multiplier header line");
  }

  const values = /called\s*\$([0-9.,]+\s*[kKmMbB]?)\s*→\s*\$([0-9.,]+\s*[kKmMbB]?)/.exec(text);
  if (values) {
    fields.calledValueUsd = parseCompactUsd(values[1]);
    fields.peakValueUsd = parseCompactUsd(values[2]);
  } else {
    warnings.push("could not parse called/peak value line");
  }

  return fields;
}

function computeConfidence(
  messageType: ScoutMessageType,
  fields: Partial<ScoutSignal>,
  hasContract: boolean,
): ParseConfidence {
  if (messageType === "UNKNOWN") return "low";

  if (messageType === "EARLY_CALL") {
    const coreFieldsPresent =
      Boolean(fields.tokenSymbol) && hasContract && fields.marketCapUsd !== undefined && fields.liquidityUsd !== undefined;
    if (coreFieldsPresent) return "high";
    return fields.tokenSymbol ? "partial" : "low";
  }

  // PERFORMANCE_UPDATE
  const coreFieldsPresent =
    fields.tokenSymbol !== undefined &&
    fields.multiplier !== undefined &&
    fields.calledValueUsd !== undefined &&
    fields.peakValueUsd !== undefined;
  if (coreFieldsPresent) return "high";
  return fields.tokenSymbol ? "partial" : "low";
}

export function parseScoutMessage(raw: RawScoutMessage, source: string): ScoutSignal {
  const warnings: string[] = [];
  const messageType = classifyMessageType(raw.text);

  let fields: Partial<ScoutSignal> = {};
  if (messageType === "EARLY_CALL") {
    fields = parseEarlyCall(raw.text, warnings);
  } else if (messageType === "PERFORMANCE_UPDATE") {
    fields = parsePerformanceUpdate(raw.text, warnings);
  } else {
    warnings.push("message did not match any known Scout template");
  }

  const contractAddress =
    messageType === "UNKNOWN" ? undefined : extractContractAddress(raw.buttons, warnings);

  const signal: ScoutSignal = {
    id: buildSignalId(source, raw.id),
    source,
    sourceMessageId: raw.id,
    messageUrl: raw.messageUrl,
    receivedAt: new Date().toISOString(),
    postedAt: raw.postedAt ?? undefined,
    messageType,
    contractAddress,
    rawText: raw.text,
    links: raw.buttons.map((button) => button.url),
    parseConfidence: computeConfidence(messageType, fields, Boolean(contractAddress)),
    parseWarnings: warnings,
    ...fields,
  };

  return signal;
}
