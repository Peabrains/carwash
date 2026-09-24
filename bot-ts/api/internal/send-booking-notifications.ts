import "../../src/env.js";
import { isAuthorizedCronRequest, processDueBookingNotifications } from "../../src/booking-notifications.js";

function json(body: Record<string, unknown>, status = 200) {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  if (!isAuthorizedCronRequest(request.headers.get("authorization"), process.env.BOOKING_NOTIFICATION_CRON_SECRET)) {
    return json({ error: "Unauthorized" }, 401);
  }
  try {
    const summary = await processDueBookingNotifications();
    return json({ ok: true, ...summary });
  } catch (error) {
    console.error("[booking-notifications] batch_failed", { error: error instanceof Error ? error.message : "Unknown error" });
    return json({ ok: false, error: "Notification run failed" }, 500);
  }
}
