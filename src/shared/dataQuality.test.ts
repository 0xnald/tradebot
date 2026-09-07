import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDataQualitySummary } from "./dataQuality.js";

test("overall is KNOWN only when every field is KNOWN", () => {
  const summary = buildDataQualitySummary([
    { field: "price", state: "KNOWN" },
    { field: "liquidity", state: "KNOWN" },
  ]);
  assert.equal(summary.overall, "KNOWN");
});

test("overall is UNAVAILABLE when every field is UNAVAILABLE or UNKNOWN", () => {
  const summary = buildDataQualitySummary([
    { field: "price", state: "UNAVAILABLE" },
    { field: "liquidity", state: "UNKNOWN" },
  ]);
  assert.equal(summary.overall, "UNAVAILABLE");
});

test("overall is PARTIAL when some fields are known and others are not", () => {
  const summary = buildDataQualitySummary([
    { field: "price", state: "KNOWN" },
    { field: "holderCount", state: "UNAVAILABLE" },
  ]);
  assert.equal(summary.overall, "PARTIAL");
});

test("overall is STALE only when everything is known but at least one field is stale", () => {
  const summary = buildDataQualitySummary([
    { field: "price", state: "KNOWN" },
    { field: "liquidity", state: "STALE" },
  ]);
  assert.equal(summary.overall, "STALE");
});

test("an empty field list is UNKNOWN, never fabricated as KNOWN", () => {
  const summary = buildDataQualitySummary([]);
  assert.equal(summary.overall, "UNKNOWN");
});

test("preserves the per-field reasons for later inspection", () => {
  const summary = buildDataQualitySummary([{ field: "holderCount", state: "UNAVAILABLE", reason: "Blockscout unreachable" }]);
  assert.equal(summary.fields[0].reason, "Blockscout unreachable");
});
