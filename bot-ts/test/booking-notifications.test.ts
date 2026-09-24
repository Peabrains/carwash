import test from "node:test";
import assert from "node:assert/strict";
import {
  formatBookingNotification,
  isAuthorizedCronRequest,
  retryDelayMinutes,
} from "../src/booking-notifications.js";

const booking = {
  reference: "WP-ABC",
  providerName: "WashPoint",
  locationName: "Main",
  serviceName: "Premium Wash",
  scheduledAt: "2026-09-25T02:00:00Z",
  vehiclePlate: "QAA 123",
};

test("24 hour reminder includes reference, provider, location and vehicle", () => {
  const text = formatBookingNotification("reminder_24h", booking);
  assert.match(text, /WP-ABC/);
  assert.match(text, /WashPoint/);
  assert.match(text, /Main/);
  assert.match(text, /QAA 123/);
});

for (const type of ["confirmed", "reminder_2h", "cancelled", "rescheduled"] as const) {
  test(`${type} notification includes the booking details`, () => {
    const text = formatBookingNotification(type, booking);
    assert.match(text, /Premium Wash/);
    assert.match(text, /25 Sept? 2026/);
    assert.doesNotMatch(text, /phone/i);
  });
}

test("retry delay grows but remains bounded", () => {
  assert.deepEqual([1, 2, 3, 4, 5].map(retryDelayMinutes), [5, 15, 60, 360, 360]);
});

test("cron authorization requires an exact bearer secret", () => {
  assert.equal(isAuthorizedCronRequest("Bearer correct-secret", "correct-secret"), true);
  assert.equal(isAuthorizedCronRequest("Bearer wrong-secret", "correct-secret"), false);
  assert.equal(isAuthorizedCronRequest(null, "correct-secret"), false);
  assert.equal(isAuthorizedCronRequest("Bearer correct-secret", ""), false);
});
