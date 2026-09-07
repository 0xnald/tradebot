import { test } from "node:test";
import assert from "node:assert/strict";
import { getCachedTokenMetadata, clearTokenMetadataCache } from "./tokenMetadataCache.js";
import type { TokenMetadataRaw } from "../blockchain/robinhoodChainClient.js";

function fakeChainClient(chainId: number, metadata: TokenMetadataRaw) {
  let calls = 0;
  return {
    chainId,
    getTokenMetadata: async () => {
      calls += 1;
      return metadata;
    },
    get callCount() {
      return calls;
    },
  };
}

test("caches token metadata across repeated calls for the same (chainId, address)", async () => {
  clearTokenMetadataCache();
  const client = fakeChainClient(4663, { name: "Test", symbol: "TST", decimals: 18, totalSupplyRaw: "1000" });
  const address = "0xeb1898a0d496000506a2799e1b4077776497fd29";

  const first = await getCachedTokenMetadata(client, address);
  const second = await getCachedTokenMetadata(client, address);

  assert.deepEqual(first, second);
  assert.equal(client.callCount, 1); // second call was served from cache, not a new RPC round trip
});

test("treats the same address case-insensitively (a checksum vs lowercase variant hits the same cache entry)", async () => {
  clearTokenMetadataCache();
  const client = fakeChainClient(4663, { name: "Test", symbol: "TST", decimals: 18, totalSupplyRaw: "1000" });

  await getCachedTokenMetadata(client, "0xeb1898a0d496000506a2799e1b4077776497fd29");
  await getCachedTokenMetadata(client, "0xEB1898A0D496000506A2799E1B4077776497FD29" as `0x${string}`);

  assert.equal(client.callCount, 1);
});

test("different addresses get independent cache entries", async () => {
  clearTokenMetadataCache();
  const client = fakeChainClient(4663, { name: "Test", symbol: "TST", decimals: 18, totalSupplyRaw: "1000" });

  await getCachedTokenMetadata(client, "0xeb1898a0d496000506a2799e1b4077776497fd29");
  await getCachedTokenMetadata(client, "0x1111111111111111111111111111111111111a");

  assert.equal(client.callCount, 2);
});

test("different chainIds for the same address are cached independently (never cross-chain confusion)", async () => {
  clearTokenMetadataCache();
  const chain1 = fakeChainClient(4663, { name: "Chain1Token", symbol: "C1", decimals: 18, totalSupplyRaw: "1000" });
  const chain2 = fakeChainClient(1, { name: "Chain2Token", symbol: "C2", decimals: 6, totalSupplyRaw: "2000" });
  const address = "0xeb1898a0d496000506a2799e1b4077776497fd29";

  const r1 = await getCachedTokenMetadata(chain1, address);
  const r2 = await getCachedTokenMetadata(chain2, address);

  assert.equal(r1.symbol, "C1");
  assert.equal(r2.symbol, "C2");
  assert.equal(chain1.callCount, 1);
  assert.equal(chain2.callCount, 1);
});

test("clearTokenMetadataCache() forces the next call to re-fetch", async () => {
  clearTokenMetadataCache();
  const client = fakeChainClient(4663, { name: "Test", symbol: "TST", decimals: 18, totalSupplyRaw: "1000" });
  const address = "0xeb1898a0d496000506a2799e1b4077776497fd29";

  await getCachedTokenMetadata(client, address);
  clearTokenMetadataCache();
  await getCachedTokenMetadata(client, address);

  assert.equal(client.callCount, 2);
});
