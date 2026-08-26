import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const publishableKey = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "";
  const secretKey = Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const authorization = request.headers.get("Authorization");
  if (!supabaseUrl || !publishableKey || !secretKey || !authorization) return json({ error: "Authentication is not configured." }, 500);

  let payload: { email?: string; name?: string; role?: string; isActive?: boolean; providerId?: string; locationId?: string };
  try { payload = await request.json(); } catch { return json({ error: "Invalid request body." }, 400); }

  const email = String(payload.email ?? "").trim().toLowerCase();
  const name = String(payload.name ?? "").trim();
  const role = String(payload.role ?? "worker");
  const providerId = String(payload.providerId ?? "");
  const locationId = String(payload.locationId ?? "");
  if (!email || !email.includes("@") || !providerId || !locationId || !["owner", "manager", "worker"].includes(role)) {
    return json({ error: "Enter a valid staff email and staff details." }, 400);
  }

  // Preserve the existing database authorization check for the signed-in owner.
  const userClient = createClient(supabaseUrl, publishableKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: invitation, error: invitationError } = await userClient.rpc("invite_staff_member", {
    p_email: email,
    p_name: name,
    p_role: role,
    p_provider_id: providerId,
    p_location_id: locationId,
    p_is_active: payload.isActive !== false,
  });
  if (invitationError) return json({ error: invitationError.message }, 403);

  // Admin invitation is deliberately server-only: this key bypasses RLS.
  const adminClient = createClient(supabaseUrl, secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
  if (invitation?.status === "invited") {
    const redirectTo = Deno.env.get("STAFF_INVITE_REDIRECT_URL") ?? "https://peabrains.github.io/carwash/#/staff/login";
    const { error: emailError } = await adminClient.auth.admin.inviteUserByEmail(email, {
      data: { name, role, provider_id: providerId, location_id: locationId },
      redirectTo,
    });
    if (emailError) return json({ error: `Invitation saved, but the email could not be sent: ${emailError.message}` }, 502);
  }

  return json({ ...invitation, emailSent: invitation?.status === "invited" });
});
