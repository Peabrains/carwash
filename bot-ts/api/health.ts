import "../src/env.js";
import { publicSupabaseClient } from "../src/supabase-booking.js";

function response(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export async function GET() {
  const checks: Record<string, unknown> = {};
  let healthy = true;

  try {
    const { error } = await publicSupabaseClient().from("providers").select("id").limit(1);
    checks.supabase = error ? { ok: false, error: error.message } : { ok: true };
    healthy &&= !error;
  } catch (error) {
    checks.supabase = { ok: false, error: error instanceof Error ? error.message : "Supabase check failed" };
    healthy = false;
  }

  const token = process.env.TIER1_TELEGRAM_BOT_TOKEN;
  if (!token) {
    checks.telegram = { ok: false, error: "TIER1_TELEGRAM_BOT_TOKEN is not configured" };
    healthy = false;
  } else {
    try {
      const result = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`, { signal: AbortSignal.timeout(5000) });
      const body = await result.json() as { ok?: boolean; result?: { url?: string; last_error_message?: string } };
      const webhookUrl = body.result?.url || "";
      const ok = result.ok && body.ok === true && webhookUrl.length > 0 && !body.result?.last_error_message;
      checks.telegram = { ok, webhookConfigured: webhookUrl.length > 0, lastError: body.result?.last_error_message || null };
      healthy &&= ok;
    } catch (error) {
      checks.telegram = { ok: false, error: error instanceof Error ? error.message : "Telegram check failed" };
      healthy = false;
    }
  }

  const body = { ok: healthy, service: "carwash-bot", checks, timestamp: new Date().toISOString() };
  console.info("[health] production_check", body);
  return response(body, healthy ? 200 : 503);
}
