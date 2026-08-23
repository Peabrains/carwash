import assert from "node:assert/strict";
import test from "node:test";
import { bookingIntervalsOverlap, intervalsOverlap, isDateBookable } from "../src/booking-rules.js";

test("adjacent non-booking intervals do not overlap", () => {
  assert.equal(intervalsOverlap(0, 20, 20, 40), false);
});

test("booking buffer prevents a candidate starting too soon after an appointment", () => {
  const minute = 60_000;
  assert.equal(bookingIntervalsOverlap(30 * minute, 50 * minute, 0, 20 * minute, 15), true);
  assert.equal(bookingIntervalsOverlap(35 * minute, 55 * minute, 0, 20 * minute, 15), false);
});

test("booking buffer also protects the candidate from a following appointment", () => {
  const minute = 60_000;
  assert.equal(bookingIntervalsOverlap(0, 20 * minute, 30 * minute, 50 * minute, 15), true);
  assert.equal(bookingIntervalsOverlap(0, 20 * minute, 35 * minute, 55 * minute, 15), false);
});

test("booking date accepts today and the final advance day only", () => {
  assert.equal(isDateBookable("2026-08-22", "2026-08-22", 14), true);
  assert.equal(isDateBookable("2026-09-05", "2026-08-22", 14), true);
  assert.equal(isDateBookable("2026-09-06", "2026-08-22", 14), false);
  assert.equal(isDateBookable("2026-08-21", "2026-08-22", 14), false);
});
