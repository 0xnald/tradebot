import { test } from "node:test";
import assert from "node:assert/strict";
import { createLogger } from "./logger.js";

function captureLastLog(fn: () => void): Record<string, unknown> {
  const original = console.log;
  let lastLine = "{}";
  console.log = (line: string) => {
    lastLine = line;
  };
  try {
    fn();
  } finally {
    console.log = original;
  }
  return JSON.parse(lastLine);
}

test("redacts known secret-shaped keys", () => {
  const record = captureLastLog(() => {
    createLogger("test").info("msg", {
      apiHash: "abc123",
      sessionString: "1AZWarz...",
      password: "hunter2",
      privateKey: "0xdeadbeef",
    });
  });

  assert.equal(record.apiHash, "[redacted]");
  assert.equal(record.sessionString, "[redacted]");
  assert.equal(record.password, "[redacted]");
  assert.equal(record.privateKey, "[redacted]");
});

test("does NOT redact tokenSymbol, a legitimate domain field", () => {
  const record = captureLastLog(() => {
    createLogger("test").info("msg", { tokenSymbol: "THROBBIN" });
  });

  assert.equal(record.tokenSymbol, "THROBBIN");
});

test("does NOT redact unrelated fields", () => {
  const record = captureLastLog(() => {
    createLogger("test").info("msg", { contractAddress: "0xabc", parseConfidence: "high" });
  });

  assert.equal(record.contractAddress, "0xabc");
  assert.equal(record.parseConfidence, "high");
});
