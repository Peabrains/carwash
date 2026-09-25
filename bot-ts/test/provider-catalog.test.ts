import test from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { activeProviders } from "../src/tier1-flow.js";

test("Telegram provider menu uses the approved marketplace set", async () => {
  const rows: Record<string, unknown[]> = {
    providers: [{ id: "washpoint", name: "WashPoint", description: "", status: "active" }, { id: "pending", name: "Pending", description: "", status: "active" }],
    provider_profiles: [{ provider_id: "washpoint", marketplace_status: "approved", operations_suspended: false }, { provider_id: "pending", marketplace_status: "pending_review", operations_suspended: false }],
    provider_onboarding: [{ provider_id: "washpoint", status: "active" }, { provider_id: "pending", status: "ready" }],
  };
  const db = {
    from(table: string) {
      return { select: async () => ({ data: rows[table], error: null }) };
    },
  } as unknown as SupabaseClient;

  const providers = await activeProviders(db);

  assert.deepEqual(providers, [{ id: "washpoint", name: "WashPoint", description: "", marketplaceVerified: true }]);
});
