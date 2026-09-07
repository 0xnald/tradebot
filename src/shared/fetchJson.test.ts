import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchJson } from "./fetchJson.js";

function withMockFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

test("returns ok:true with parsed JSON on a 200 response", async () => {
  const result = await withMockFetch(
    (async () => new Response(JSON.stringify({ hello: "world" }), { status: 200 })) as typeof fetch,
    () => fetchJson<{ hello: string }>("https://example.invalid/ok"),
  );

  assert.deepEqual(result, { ok: true, data: { hello: "world" } });
});

test("returns ok:false on a non-2xx response", async () => {
  const result = await withMockFetch(
    (async () => new Response("not found", { status: 404, statusText: "Not Found" })) as typeof fetch,
    () => fetchJson("https://example.invalid/missing"),
  );

  assert.equal(result.ok, false);
  assert.match((result as { ok: false; error: string }).error, /404/);
});

test("returns ok:false when fetch itself throws (network error)", async () => {
  const result = await withMockFetch(
    (async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as typeof fetch,
    () => fetchJson("https://example.invalid/network-error"),
  );

  assert.equal(result.ok, false);
  assert.match((result as { ok: false; error: string }).error, /ENOTFOUND/);
});

test("returns ok:false on timeout", async () => {
  const result = await withMockFetch(
    (async (_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      })) as unknown as typeof fetch,
    () => fetchJson("https://example.invalid/slow", 10),
  );

  assert.equal(result.ok, false);
  assert.match((result as { ok: false; error: string }).error, /timed out/);
});
