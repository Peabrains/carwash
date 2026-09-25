import test from "node:test";
import assert from "node:assert/strict";
import { createManualBooking } from "../src/manual-booking.js";

const valid = {
  requestId: "manual-1", providerId: "washpoint", locationId: "washpoint-main",
  customerName: "Ari", customerPhone: "0123456789", vehiclePlate: "QAA1234",
  vehicleMakeModel: "Perodua Myvi", serviceId: "service-1", dateIso: "2026-10-10",
  time24h: "10:00", source: "walk_in" as const,
};
const actor = { id: "staff-1", role: "manager", providerId: "washpoint", locationId: null };
const deps = { reserve: async () => ({ status: "created" as const, reference: "WP-1" }), canUseRequestedBay: async () => true };

test("manual booking validates required fields and sources", async () => {
  await assert.rejects(() => createManualBooking({ ...valid, customerName: "" }, actor, deps), /customer name/i);
  await assert.rejects(() => createManualBooking({ ...valid, source: "telegram" as never }, actor, deps), /source/i);
});

test("manual booking rejects unauthorized and cross-provider actors", async () => {
  await assert.rejects(() => createManualBooking(valid, { ...actor, role: "worker" }, deps), /permission/i);
  await assert.rejects(() => createManualBooking(valid, { ...actor, providerId: "other" }, deps), /provider/i);
});

test("manual booking uses atomic reservation and preserves duplicate result", async () => {
  let received: unknown;
  const result = await createManualBooking(valid, actor, { ...deps, reserve: async input => { received = input; return { status: "existing", reference: "WP-OLD" }; } });
  assert.equal(result.status, "existing");
  assert.deepEqual(received, valid);
});

test("manual booking rejects an unavailable requested bay", async () => {
  await assert.rejects(() => createManualBooking({ ...valid, requestedBayId: "bay-2" }, actor, { ...deps, canUseRequestedBay: async () => false }), /bay is unavailable/i);
});

test("manual booking surfaces slot and plan-limit rejection", async () => {
  await assert.rejects(() => createManualBooking(valid, actor, { ...deps, reserve: async () => { throw new Error("Your plan booking limit has been reached"); } }), /plan booking limit/i);
  const unavailable = await createManualBooking(valid, actor, { ...deps, reserve: async () => ({ status: "unavailable", reference: "" }) });
  assert.equal(unavailable.status, "unavailable");
});
