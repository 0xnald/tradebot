import { test } from "node:test";
import assert from "node:assert/strict";
import { UnknownMarketRegimeProvider } from "./marketRegimeProvider.js";

test("always returns UNKNOWN with a stated reason — a stub, not a model", () => {
  const provider = new UnknownMarketRegimeProvider();
  const result = provider.assess();
  assert.equal(result.regime, "UNKNOWN");
  assert.ok(result.notes.length > 0);
});
