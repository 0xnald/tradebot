import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyRpcError, isBisectable } from "./rpcErrorClassification.js";

test("classifies the exact authenticated-endpoint rejection observed in Phase 7.3A as INVALID_REQUEST", () => {
  const error = new Error(
    'JSON is not a valid request object.\n\nURL: https://example.com/v2/secret\nRequest body: {"method":"eth_getLogs","params":[{"fromBlock":"0x33ec0b6","toBlock":"0x360307b"}]}',
  );
  assert.equal(classifyRpcError(error), "INVALID_REQUEST");
});

test("INVALID_REQUEST is never treated as bisectable — it carries no evidence a smaller range would help", () => {
  assert.equal(isBisectable("INVALID_REQUEST"), false);
});

test("classifies a too-many-results style message as TOO_MANY_RESULTS and marks it bisectable", () => {
  assert.equal(classifyRpcError(new Error("query returned more than 10000 results")), "TOO_MANY_RESULTS");
  assert.equal(isBisectable("TOO_MANY_RESULTS"), true);
});

test("classifies an explicit block-range-limit message as RANGE_LIMIT but does NOT mark it bisectable", () => {
  assert.equal(classifyRpcError(new Error("block range exceeds maximum of 2000 blocks")), "RANGE_LIMIT");
  assert.equal(isBisectable("RANGE_LIMIT"), false);
});

test("classifies the real Alchemy free-tier rejection (which literally says 'block range') as RANGE_LIMIT, not bisectable — Phase 7.3B's actual root cause", () => {
  const error = new Error(
    "JSON is not a valid request object.\n\nURL: https://example.com/v2/secret\nRequest body: {...}\n\nDetails: Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range. Based on your parameters, this block range should work: [0x317b512, 0x317b51b]. Upgrade to PAYG for expanded block range.",
  );
  const errorClass = classifyRpcError(error);
  assert.equal(errorClass, "RANGE_LIMIT");
  assert.equal(isBisectable(errorClass), false);
});

test("classifies a rate-limit message as RATE_LIMIT (not bisectable)", () => {
  assert.equal(classifyRpcError(new Error("429 Too Many Requests")), "RATE_LIMIT");
  assert.equal(isBisectable("RATE_LIMIT"), false);
});

test("classifies a timeout message as TIMEOUT (not bisectable)", () => {
  assert.equal(classifyRpcError(new Error("request timed out after 15000ms")), "TIMEOUT");
  assert.equal(isBisectable("TIMEOUT"), false);
});

test("classifies a connection-reset message as NETWORK_TRANSIENT (not bisectable)", () => {
  assert.equal(classifyRpcError(new Error("socket hang up")), "NETWORK_TRANSIENT");
  assert.equal(isBisectable("NETWORK_TRANSIENT"), false);
});

test("falls back to DETERMINISTIC_RPC_ERROR for an unrecognized error shape (never assumed bisectable)", () => {
  const errorClass = classifyRpcError(new Error("execution reverted: custom contract error"));
  assert.equal(errorClass, "DETERMINISTIC_RPC_ERROR");
  assert.equal(isBisectable(errorClass), false);
});

test("handles a non-Error thrown value without throwing itself", () => {
  assert.equal(classifyRpcError("plain string failure"), "DETERMINISTIC_RPC_ERROR");
});
