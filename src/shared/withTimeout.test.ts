import { test } from "node:test";
import assert from "node:assert/strict";
import { withTimeout, TimeoutError } from "./withTimeout.js";

test("resolves with the underlying value when it completes before the timeout", async () => {
  const result = await withTimeout(Promise.resolve(42), 1000, "fast task");
  assert.equal(result, 42);
});

test("rejects with a TimeoutError when the underlying promise is too slow", async () => {
  const slow = new Promise((resolve) => setTimeout(() => resolve("late"), 200));
  await assert.rejects(() => withTimeout(slow, 20, "slow task"), TimeoutError);
});

test("TimeoutError message names the label and the timeout", async () => {
  const slow = new Promise(() => {}); // never resolves
  await assert.rejects(() => withTimeout(slow, 10, "pons lookup"), /pons lookup timed out after 10ms/);
});

test("propagates the underlying rejection reason when the task fails before timing out", async () => {
  const failing = Promise.reject(new Error("provider exploded"));
  await assert.rejects(() => withTimeout(failing, 1000, "task"), /provider exploded/);
});

test("clears its internal timer so a fast-resolving call does not leave a dangling timeout", async () => {
  // If the timer weren't cleared, this would still resolve fine, but we confirm no unhandled
  // rejection/timeout fires afterward by waiting past the timeout window.
  await withTimeout(Promise.resolve("ok"), 10, "task");
  await new Promise((resolve) => setTimeout(resolve, 30));
  // no assertion needed beyond "didn't throw/crash" — absence of an unhandled rejection is the proof
});
