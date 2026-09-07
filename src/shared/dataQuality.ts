// Builds a DataQualitySummary from per-field states — see the
// DataQualityState doc comment in src/types/domain.ts for what each state
// means. The overall-state precedence here is a documented rule, not an
// implicit default:
//
//   1. If every field is UNAVAILABLE or UNKNOWN -> overall UNAVAILABLE.
//   2. Else if any field is UNAVAILABLE, UNKNOWN, or PARTIAL -> overall PARTIAL.
//   3. Else if any field is STALE -> overall STALE.
//   4. Else (every field KNOWN) -> overall KNOWN.
//
// This means "some things are simply unknown/unavailable" always shows up
// as PARTIAL (not silently as KNOWN), and staleness is only surfaced at
// the top level once everything that IS known has actually been checked
// for freshness.

import type { DataQualityField, DataQualityState, DataQualitySummary } from "../types/domain.js";

export function buildDataQualitySummary(fields: DataQualityField[], now: Date = new Date()): DataQualitySummary {
  const overall = computeOverallState(fields);
  return { overall, fields, observedAt: now.toISOString() };
}

function computeOverallState(fields: DataQualityField[]): DataQualityState {
  if (fields.length === 0) return "UNKNOWN";

  const allUnavailableOrUnknown = fields.every((f) => f.state === "UNAVAILABLE" || f.state === "UNKNOWN");
  if (allUnavailableOrUnknown) return "UNAVAILABLE";

  const anyDegraded = fields.some((f) => f.state === "UNAVAILABLE" || f.state === "UNKNOWN" || f.state === "PARTIAL");
  if (anyDegraded) return "PARTIAL";

  const anyStale = fields.some((f) => f.state === "STALE");
  if (anyStale) return "STALE";

  return "KNOWN";
}
