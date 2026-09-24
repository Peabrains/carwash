import test from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { activeProviders } from "../src/tier1-flow.js";

test("Telegram provider menu filters the providers status column", async () => {
  const filters: Array<[string, unknown]> = [];
  const db = {
    from(table: string) {
      assert.equal(table, "providers");
      return {
        select() {
          return {
            eq(column: string, value: unknown) {
              filters.push([column, value]);
              return {
                order: async () => ({ data: [{ id: "washpoint", name: "WashPoint" }], error: null }),
              };
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;

  const providers = await activeProviders(db);

  assert.deepEqual(filters, [["status", "active"]]);
  assert.deepEqual(providers, [{ id: "washpoint", name: "WashPoint" }]);
});
