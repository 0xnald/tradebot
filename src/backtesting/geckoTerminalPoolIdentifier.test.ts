import { test } from "node:test";
import assert from "node:assert/strict";
import { isGeckoTerminalPoolIdentifier } from "./geckoTerminalPoolIdentifier.js";

test("accepts a normal 20-byte pool address", () => {
  assert.equal(isGeckoTerminalPoolIdentifier("0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca"), true);
});

test("accepts a 32-byte Uniswap V4 PoolId", () => {
  assert.equal(isGeckoTerminalPoolIdentifier("0x29a9f241f8299f80d4fc533fee32e97a10b4b5d39d52f6b6376e1b596ab2cad3"), true);
});

test("rejects a malformed value that is neither shape", () => {
  assert.equal(isGeckoTerminalPoolIdentifier("not-an-address"), false);
  assert.equal(isGeckoTerminalPoolIdentifier("0x1234"), false);
});

test("rejects an odd-length hex string (the exact malformed-address bug found during the Pons investigation)", () => {
  assert.equal(isGeckoTerminalPoolIdentifier("0x7E1EAbd52Ae29598e6483F72dCf1a70b14284dB"), false);
});
