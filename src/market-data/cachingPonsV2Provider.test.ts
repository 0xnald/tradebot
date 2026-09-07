import { test } from "node:test";
import assert from "node:assert/strict";
import { CachingPonsV2Provider } from "./cachingPonsV2Provider.js";
import type { PonsV2LaunchDataProvider, PonsV2LaunchInfo } from "./ponsV2Provider.js";
import type { ProviderResult } from "../types/domain.js";

function fakeInner(result: ProviderResult<PonsV2LaunchInfo | null>): PonsV2LaunchDataProvider & { callCount: number } {
  let callCount = 0;
  return {
    name: "fake-pons",
    get callCount() {
      return callCount;
    },
    async getLaunchInfo() {
      callCount += 1;
      return result;
    },
  };
}

const launchInfo: PonsV2LaunchInfo = {
  token: "0xtoken",
  curve: "0xcurve",
  deployer: "0xdeployer",
  pairToken: "0xpair",
  poolFee: 3000,
  tickSpacing: 60,
  phase: "NOT_GRADUATED",
  graduationThreshold: "1000000000000000000",
  priceIdentifier: "0xcurve",
  priceIdentifierKind: "CURVE",
  graduationTimestamp: null,
};

test("caches getLaunchInfo across repeated calls for the same token within the TTL", async () => {
  const inner = fakeInner({ status: "ok", data: launchInfo, unavailable: [], errors: [] });
  const cached = new CachingPonsV2Provider(inner, 60_000);

  const first = await cached.getLaunchInfo("0xtoken");
  const second = await cached.getLaunchInfo("0xtoken");

  assert.deepEqual(first, second);
  assert.equal(inner.callCount, 1);
});

test("expires and re-fetches after the TTL elapses", async () => {
  const inner = fakeInner({ status: "ok", data: launchInfo, unavailable: [], errors: [] });
  const cached = new CachingPonsV2Provider(inner, 10); // 10ms TTL

  await cached.getLaunchInfo("0xtoken");
  await new Promise((resolve) => setTimeout(resolve, 20));
  await cached.getLaunchInfo("0xtoken");

  assert.equal(inner.callCount, 2);
});

test("different tokens are cached independently", async () => {
  const inner = fakeInner({ status: "ok", data: launchInfo, unavailable: [], errors: [] });
  const cached = new CachingPonsV2Provider(inner, 60_000);

  await cached.getLaunchInfo("0xtokenA");
  await cached.getLaunchInfo("0xtokenB");

  assert.equal(inner.callCount, 2);
});

test("exposes a distinguishable name so provider-call diagnostics can tell cached from uncached", () => {
  const inner = fakeInner({ status: "ok", data: launchInfo, unavailable: [], errors: [] });
  const cached = new CachingPonsV2Provider(inner);
  assert.equal(cached.name, "fake-pons:cached");
});
