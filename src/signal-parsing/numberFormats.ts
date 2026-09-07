// Small, dependency-free number parsers for the compact formats Scout uses
// in its messages (e.g. "$57k", "$3.60M", "36.1%", "2m", "6.9h").

const COMPACT_USD_PATTERN = /^\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*([kKmMbB])?$/;

export function parseCompactUsd(input: string): number | undefined {
  const match = COMPACT_USD_PATTERN.exec(input.trim());
  if (!match) return undefined;
  const base = Number(match[1].replace(/,/g, ""));
  if (Number.isNaN(base)) return undefined;
  const suffix = match[2]?.toLowerCase();
  const multiplier = suffix === "k" ? 1_000 : suffix === "m" ? 1_000_000 : suffix === "b" ? 1_000_000_000 : 1;
  return base * multiplier;
}

export function parsePercent(input: string): number | undefined {
  const match = /^(-?[0-9]+(?:\.[0-9]+)?)\s*%?$/.exec(input.trim());
  if (!match) return undefined;
  return Number(match[1]);
}

const AGE_UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

export function parseAgeToSeconds(input: string): number | undefined {
  const match = /^([0-9]+(?:\.[0-9]+)?)\s*(s|m|h|d)$/i.exec(input.trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unitSeconds = AGE_UNIT_SECONDS[match[2].toLowerCase()];
  return unitSeconds ? amount * unitSeconds : undefined;
}

export function parseIntSafe(input: string): number | undefined {
  const cleaned = input.replace(/,/g, "").trim();
  return /^[0-9]+$/.test(cleaned) ? Number(cleaned) : undefined;
}
