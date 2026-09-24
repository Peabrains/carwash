import test from "node:test";
import assert from "node:assert/strict";
import { canCustomerChangeBooking, customerIdentityMatches } from "../src/public-booking-rules.js";

test("reference and normalized Malaysian phone identify the customer", () => {
  assert.equal(customerIdentityMatches(
    { reference: "WP-1", customer_phone: "012-345 6789", customer_name: "Aina", vehicle_plate: "QAA 123" },
    { reference: "WP-1", phone: "+60123456789", name: "", vehiclePlate: "" },
  ), true);
});

test("wrong phone never matches a booking reference", () => {
  assert.equal(customerIdentityMatches(
    { reference: "WP-1", customer_phone: "0123456789", customer_name: "Aina", vehicle_plate: "QAA 123" },
    { reference: "WP-1", phone: "0199999999", name: "", vehiclePlate: "" },
  ), false);
});

test("booking lookup without reference requires phone, name, and plate", () => {
  assert.equal(customerIdentityMatches(
    { reference: "WP-1", customer_phone: "0123456789", customer_name: "Aina Binti Ali", vehicle_plate: "QAA 123" },
    { reference: "", phone: "012-3456789", name: " aina binti ali ", vehiclePlate: "qaa123" },
  ), true);
});

test("change is rejected exactly at the location cutoff", () => {
  assert.deepEqual(canCustomerChangeBooking(
    { status: "confirmed", scheduledAt: "2026-09-25T02:00:00Z", noticeMinutes: 60 },
    new Date("2026-09-25T01:00:00Z"),
  ), { allowed: false, reason: "This booking is too close to its appointment time to change online." });
});

for (const status of ["cancelled", "completed", "no_show"]) {
  test(`${status} bookings cannot be changed`, () => {
    assert.equal(canCustomerChangeBooking(
      { status, scheduledAt: "2026-09-25T04:00:00Z", noticeMinutes: 60 },
      new Date("2026-09-25T01:00:00Z"),
    ).allowed, false);
  });
}
