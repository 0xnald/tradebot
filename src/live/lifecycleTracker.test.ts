import { test } from "node:test";
import assert from "node:assert/strict";
import { LifecycleTracker } from "./lifecycleTracker.js";

const T0 = new Date("2026-09-06T12:00:00.000Z");
const T1 = new Date("2026-09-06T12:00:00.250Z"); // +250ms
const T2 = new Date("2026-09-06T12:00:01.000Z"); // +750ms after T1

test("the first recorded event has no duration-since-previous", () => {
  const tracker = new LifecycleTracker("sig-1");
  const event = tracker.record("RECEIVED", "OK", { at: T0 });
  assert.equal(event.durationMsSincePrevious, null);
});

test("each subsequent event records the duration since the previous one", () => {
  const tracker = new LifecycleTracker("sig-1");
  tracker.record("RECEIVED", "OK", { at: T0 });
  const parsed = tracker.record("PARSED", "OK", { at: T1 });
  const validated = tracker.record("VALIDATED", "OK", { at: T2 });
  assert.equal(parsed.durationMsSincePrevious, 250);
  assert.equal(validated.durationMsSincePrevious, 750);
});

test("events are append-only and returned in recorded order", () => {
  const tracker = new LifecycleTracker("sig-1");
  tracker.record("RECEIVED", "OK", { at: T0 });
  tracker.record("PARSED", "OK", { at: T1 });
  assert.deepEqual(
    tracker.events.map((e) => e.stage),
    ["RECEIVED", "PARSED"],
  );
});

test("currentStage reflects the most recently recorded stage", () => {
  const tracker = new LifecycleTracker("sig-1");
  assert.equal(tracker.currentStage, null);
  tracker.record("RECEIVED", "OK", { at: T0 });
  assert.equal(tracker.currentStage, "RECEIVED");
  tracker.record("REJECTED", "ERROR", { at: T1, error: "stale" });
  assert.equal(tracker.currentStage, "REJECTED");
});

test("records an error status and message on a failed stage", () => {
  const tracker = new LifecycleTracker("sig-1");
  const event = tracker.record("INTELLIGENCE_STARTED", "ERROR", { at: T0, error: "RPC unreachable" });
  assert.equal(event.status, "ERROR");
  assert.equal(event.error, "RPC unreachable");
});

test("millisecondsSince computes elapsed time from a stage's first occurrence to the latest event", () => {
  const tracker = new LifecycleTracker("sig-1");
  tracker.record("RECEIVED", "OK", { at: T0 });
  tracker.record("PARSED", "OK", { at: T1 });
  tracker.record("VALIDATED", "OK", { at: T2 });
  assert.equal(tracker.millisecondsSince("RECEIVED"), 1000);
});

test("millisecondsSince returns null when the stage was never recorded", () => {
  const tracker = new LifecycleTracker("sig-1");
  tracker.record("RECEIVED", "OK", { at: T0 });
  assert.equal(tracker.millisecondsSince("PAPER_ENTRY"), null);
});

test("millisecondsBetween computes the gap between two specific stages", () => {
  const tracker = new LifecycleTracker("sig-1");
  tracker.record("RECEIVED", "OK", { at: T0 });
  tracker.record("PARSED", "OK", { at: T1 });
  tracker.record("PAPER_ENTRY", "OK", { at: T2 });
  assert.equal(tracker.millisecondsBetween("RECEIVED", "PAPER_ENTRY"), 1000);
  assert.equal(tracker.millisecondsBetween("PARSED", "PAPER_ENTRY"), 750);
});

test("millisecondsBetween returns null when either stage is missing", () => {
  const tracker = new LifecycleTracker("sig-1");
  tracker.record("RECEIVED", "OK", { at: T0 });
  assert.equal(tracker.millisecondsBetween("RECEIVED", "PAPER_ENTRY"), null);
});

test("attaches arbitrary structured details to an event without affecting duration tracking", () => {
  const tracker = new LifecycleTracker("sig-1");
  const event = tracker.record("SCORING_COMPLETED", "OK", { at: T0, details: { score: 82, confidence: 40 } });
  assert.deepEqual(event.details, { score: 82, confidence: 40 });
});
