import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseRpcForLogQuery } from "./rpcRouting.js";
import type { RpcProviderCapabilities } from "./chainConfig.js";

const CAPPED_AT_10: RpcProviderCapabilities = { maxGetLogsBlockRange: 10, supportsLargeGetLogs: false };
const UNLIMITED: RpcProviderCapabilities = { maxGetLogsBlockRange: undefined, supportsLargeGetLogs: true };

test("a range within the primary's known cap stays on PRIMARY", () => {
  const role = chooseRpcForLogQuery({ fromBlock: 100n, toBlock: 109n, purpose: "PONS_CURVE_FLOW", primaryCapabilities: CAPPED_AT_10 });
  assert.equal(role, "PRIMARY");
});

test("a range exactly at the cap stays on PRIMARY (inclusive boundary)", () => {
  const role = chooseRpcForLogQuery({ fromBlock: 0n, toBlock: 9n, purpose: "PONS_CURVE_FLOW", primaryCapabilities: CAPPED_AT_10 });
  assert.equal(role, "PRIMARY"); // 10 blocks (0..9 inclusive), matching the cap exactly
});

test("a range exceeding the cap by even one block routes to LOG", () => {
  const role = chooseRpcForLogQuery({ fromBlock: 0n, toBlock: 10n, purpose: "PONS_CURVE_FLOW", primaryCapabilities: CAPPED_AT_10 });
  assert.equal(role, "LOG"); // 11 blocks
});

test("a large range (real Phase 7.3B curve window, ~107,069 blocks) routes to LOG", () => {
  const role = chooseRpcForLogQuery({ fromBlock: 54444453n, toBlock: 54551522n, purpose: "PONS_CURVE_FLOW", primaryCapabilities: CAPPED_AT_10 });
  assert.equal(role, "LOG");
});

test("when the primary provider is configured as unlimited, everything stays on PRIMARY regardless of range", () => {
  const role = chooseRpcForLogQuery({ fromBlock: 0n, toBlock: 5_000_000n, purpose: "PONS_GRADUATION_SEARCH", primaryCapabilities: UNLIMITED });
  assert.equal(role, "PRIMARY");
});

test("the decision is a pure function of range + capability — the same inputs always produce the same role, independent of purpose", () => {
  const a = chooseRpcForLogQuery({ fromBlock: 0n, toBlock: 100n, purpose: "PONS_CURVE_FLOW", primaryCapabilities: CAPPED_AT_10 });
  const b = chooseRpcForLogQuery({ fromBlock: 0n, toBlock: 100n, purpose: "UNISWAP_V4_FLOW", primaryCapabilities: CAPPED_AT_10 });
  const c = chooseRpcForLogQuery({ fromBlock: 0n, toBlock: 100n, purpose: "OTHER_EVENT_HISTORY", primaryCapabilities: CAPPED_AT_10 });
  assert.equal(a, b);
  assert.equal(b, c);
  assert.equal(a, "LOG");
});

test("a single-block range stays on PRIMARY", () => {
  const role = chooseRpcForLogQuery({ fromBlock: 42n, toBlock: 42n, purpose: "UNISWAP_V4_FLOW", primaryCapabilities: CAPPED_AT_10 });
  assert.equal(role, "PRIMARY");
});
