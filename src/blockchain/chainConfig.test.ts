import { test } from "node:test";
import assert from "node:assert/strict";
import { loadChainConfigFromEnv, describeRpcEndpointSafely } from "./chainConfig.js";

const ENV_KEYS = ["ROBINHOOD_RPC_HTTP", "ROBINHOOD_RPC_WS", "ROBINHOOD_CHAIN_RPC_URL", "ROBINHOOD_CHAIN_WS_URL"] as const;

function withEnv(vars: Partial<Record<(typeof ENV_KEYS)[number], string>>, fn: () => void): void {
  const previous: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) {
    previous[key] = process.env[key];
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(vars)) process.env[key] = value;
  try {
    fn();
  } finally {
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test("loadChainConfigFromEnv falls back to the documented public default when nothing is configured", () => {
  withEnv({}, () => {
    const config = loadChainConfigFromEnv();
    assert.equal(config.rpcUrl, "https://rpc.mainnet.chain.robinhood.com");
    assert.equal(config.wsUrl, "wss://feed.mainnet.chain.robinhood.com");
  });
});

test("ROBINHOOD_RPC_HTTP takes precedence over ROBINHOOD_CHAIN_RPC_URL when both are set", () => {
  withEnv({ ROBINHOOD_RPC_HTTP: "https://example-authenticated.example.com/v1/secret", ROBINHOOD_CHAIN_RPC_URL: "https://example-legacy.example.com" }, () => {
    const config = loadChainConfigFromEnv();
    assert.equal(config.rpcUrl, "https://example-authenticated.example.com/v1/secret");
  });
});

test("falls back to ROBINHOOD_CHAIN_RPC_URL when ROBINHOOD_RPC_HTTP is not set (backward compatibility)", () => {
  withEnv({ ROBINHOOD_CHAIN_RPC_URL: "https://example-legacy.example.com" }, () => {
    const config = loadChainConfigFromEnv();
    assert.equal(config.rpcUrl, "https://example-legacy.example.com");
  });
});

test("same precedence rule applies to the WebSocket URL (ROBINHOOD_RPC_WS over ROBINHOOD_CHAIN_WS_URL)", () => {
  withEnv({ ROBINHOOD_RPC_WS: "wss://example-authenticated.example.com/ws", ROBINHOOD_CHAIN_WS_URL: "wss://example-legacy.example.com" }, () => {
    const config = loadChainConfigFromEnv();
    assert.equal(config.wsUrl, "wss://example-authenticated.example.com/ws");
  });
});

test("describeRpcEndpointSafely identifies the public default by name, not by parsing", () => {
  const description = describeRpcEndpointSafely("https://rpc.mainnet.chain.robinhood.com");
  assert.equal(description, "public Robinhood RPC (documented default)");
});

test("describeRpcEndpointSafely never includes the path or query string of a configured URL", () => {
  const description = describeRpcEndpointSafely("https://robinhood-mainnet.g.alchemy.com/v2/super-secret-api-key-12345?extra=1");
  assert.ok(!description.includes("super-secret-api-key-12345"));
  assert.ok(!description.includes("extra=1"));
  assert.ok(description.includes("robinhood-mainnet.g.alchemy.com"));
});

test("describeRpcEndpointSafely redacts a leading subdomain label that looks like an embedded credential", () => {
  const description = describeRpcEndpointSafely("https://abcdefghijklmnopqrstuvwxyz123456.some-provider.com");
  assert.ok(!description.includes("abcdefghijklmnopqrstuvwxyz123456"));
  assert.ok(description.includes("<redacted>"));
  assert.ok(description.includes("some-provider.com"));
});

test("describeRpcEndpointSafely does not redact a short, ordinary-looking hostname label", () => {
  const description = describeRpcEndpointSafely("https://rpc.some-provider.com");
  assert.ok(description.includes("rpc.some-provider.com"));
  assert.ok(!description.includes("<redacted>"));
});

test("describeRpcEndpointSafely degrades gracefully (never throws) for an unparseable URL", () => {
  const description = describeRpcEndpointSafely("not a real url");
  assert.ok(description.includes("redacted"));
});
