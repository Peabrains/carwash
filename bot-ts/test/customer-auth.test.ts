import test from "node:test";
import assert from "node:assert/strict";
import { bearerToken, verifiedCustomerId } from "../api/public/_shared.js";

test("extracts a bearer token without accepting other auth schemes", () => {
  assert.equal(bearerToken(new Request("https://washcar.my", { headers: { authorization: "Bearer valid-token" } })), "valid-token");
  assert.equal(bearerToken(new Request("https://washcar.my", { headers: { authorization: "Basic abc" } })), "");
});

test("returns only the user id verified by Supabase", async () => {
  const auth = { getUser: async (token: string) => ({ data: { user: token === "valid-token" ? { id: "customer-1" } : null }, error: null }) };
  assert.equal(await verifiedCustomerId(new Request("https://washcar.my", { headers: { authorization: "Bearer valid-token" } }), auth), "customer-1");
});

test("guests and invalid tokens remain unlinked", async () => {
  const auth = { getUser: async () => ({ data: { user: null }, error: new Error("invalid token") }) };
  assert.equal(await verifiedCustomerId(new Request("https://washcar.my"), auth), null);
  assert.equal(await verifiedCustomerId(new Request("https://washcar.my", { headers: { authorization: "Bearer invalid" } }), auth), null);
});
