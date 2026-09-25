import test from "node:test";
import assert from "node:assert/strict";
import { assertPrivateProviderBookable, listMarketplaceProviders } from "../src/public-provider-access.js";

function dbWith(status: string, operationsSuspended = false, onboarding = "ready") {
  const rows: Record<string, unknown[]> = {
    providers: [{ id: "p1", name: "Provider 1", description: "", status: "active" }],
    provider_profiles: [{ provider_id: "p1", marketplace_status: status, operations_suspended: operationsSuspended }],
    provider_onboarding: [{ provider_id: "p1", status: onboarding }],
  };
  return { from: (table: string) => ({ select: async () => ({ data: rows[table], error: null }) }) } as never;
}

test("marketplace lists only approved operational providers", async () => {
  assert.equal((await listMarketplaceProviders(dbWith("approved"))).length, 1);
  for (const status of ["not_submitted", "pending_review", "changes_requested", "rejected", "suspended"]) {
    assert.equal((await listMarketplaceProviders(dbWith(status))).length, 0);
  }
  assert.equal((await listMarketplaceProviders(dbWith("approved", true))).length, 0);
  assert.equal((await listMarketplaceProviders(dbWith("approved", false, "in_progress"))).length, 0);
});

test("private links allow operational unapproved providers but fail closed on suspension", async () => {
  assert.equal((await assertPrivateProviderBookable(dbWith("pending_review"), "p1")).marketplaceVerified, false);
  await assert.rejects(() => assertPrivateProviderBookable(dbWith("approved", true), "p1"), /unavailable/i);
  await assert.rejects(() => assertPrivateProviderBookable(dbWith("approved", false, "blocked"), "p1"), /unavailable/i);
});
