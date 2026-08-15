"""
Wash Point booking bot — Telegram front door for the car wash's booking
system. Customer message -> Gemini extracts service/date/time -> Python
deterministically checks real availability against Supabase (bays,
existing appointments + buffer, crew breaks, bay closures, operating
hours, blackout dates, lead time, advance window) -> books it directly if
free, or searches and offers up to 3 nearby alternatives if not.

Design notes (same principles used throughout this project):
- Gemini never decides availability or does arithmetic — only language
  understanding (which service, what date/time, is this picking one of
  the offered alternatives). A wrong LLM guess here means a double-booked
  bay, not just an awkward reply.
- All times are explicit Asia/Kuala_Lumpur (MYT) via zoneinfo, never a
  naive datetime treated as UTC — this project has hit that exact bug
  twice already (seed data, and the PWA's date-shift bug).
- Auto-books directly on an available match, per spec ("if available, it
  will update the booking list") — no separate yes/no confirm step. It
  does still ask for name + phone once, since neither is reliably known
  otherwise (Telegram's profile name isn't a real intake, and chat_id is
  only a real phone number on WhatsApp, not Telegram).
- Re-verifies availability immediately before inserting, since a slightly
  stale check (however small the window) could otherwise double-book a
  bay if the owner edits appointments via the PWA at the same moment.
- Any Gemini/network failure gets a graceful reply instead of silence —
  learned the hard way earlier in this project (quote agent, quota
  exhaustion) that a bare try/except-free call leaves the customer with
  nothing.

Run:
  python booking_bot.py
"""

from __future__ import annotations

import os
import random
import re
import time
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from dotenv import load_dotenv
from supabase import create_client

from gemini_parse import parse_booking
from telegram_api import get_updates, send_message

load_dotenv()

TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]
TZ = ZoneInfo("Asia/Kuala_Lumpur")

supabase = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])

# In-memory only, per chat: tracks a customer mid-way through picking one
# of several offered alternative slots. Lost on restart — same accepted
# tradeoff as the quote agent's pending-quote memory.
PENDING: dict[int, dict] = {}


# ── Time helpers ─────────────────────────────────────────────────────
def _parse_time(t: str):
    # Postgres time columns come back as "HH:MM:SS"; Gemini gives "HH:MM".
    parts = [int(p) for p in t.split(":")]
    return datetime.min.time().replace(hour=parts[0], minute=parts[1])


def _parse_ts(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def fmt_date_label(date_iso: str) -> str:
    d = date.fromisoformat(date_iso)
    return d.strftime("%a %d %b")


# Accepts local (01X-XXXXXXX[X]) or country-code (+60/60...) Malaysian
# mobile formats, spaces/dashes optional. Returns a normalized local
# 0-prefixed form, or None if it doesn't look like a valid MY mobile.
# Intentionally lenient on exact prefix/length rules (Malaysian numbering
# has several valid lengths depending on prefix) rather than risk
# rejecting a real customer's real number over an edge case.
def normalize_my_phone(raw: str) -> str | None:
    digits = re.sub(r"[^\d+]", "", raw)
    if digits.startswith("+60"):
        digits = "0" + digits[3:]
    elif digits.startswith("60") and len(digits) >= 11:
        digits = "0" + digits[2:]
    if re.fullmatch(r"01\d{8,9}", digits):
        return digits
    return None


# ── Data access ──────────────────────────────────────────────────────
def get_services() -> list[dict]:
    return supabase.table("services").select("*").eq("is_active", True).execute().data


def get_settings() -> dict:
    return supabase.table("booking_settings").select("*").eq("id", 1).single().execute().data


def get_day_state(date_iso: str) -> dict:
    """Everything needed to check every bay/time on one date, fetched once."""
    bays = supabase.table("bays").select("id,name").eq("is_active", True).order("name").execute().data
    day_start = f"{date_iso}T00:00:00{_offset_str()}"
    day_end = f"{date_iso}T23:59:59{_offset_str()}"
    appts = (
        supabase.table("appointments")
        .select("bay_id,scheduled_at,duration_minutes")
        .neq("status", "cancelled")
        .gte("scheduled_at", day_start)
        .lte("scheduled_at", day_end)
        .execute()
        .data
    )
    breaks = supabase.table("crew_break_schedule").select("bay_id,start_time,duration_minutes").execute().data
    closures = (
        supabase.table("bay_closures")
        .select("bay_id,starts_at,ends_at")
        .lte("starts_at", day_end)
        .gte("ends_at", day_start)
        .execute()
        .data
    )
    blackout = supabase.table("blackout_dates").select("label").eq("date", date_iso).execute().data
    return {"bays": bays, "appts": appts, "breaks": breaks, "closures": closures, "blackout": blackout}


def _offset_str() -> str:
    return datetime.now(TZ).strftime("%z")  # e.g. "+0800" -> used as "+08:00"-ish; normalized below


def _offset_iso() -> str:
    off = datetime.now(TZ).utcoffset()
    total_min = int(off.total_seconds() // 60)
    sign = "+" if total_min >= 0 else "-"
    return f"{sign}{abs(total_min) // 60:02d}:{abs(total_min) % 60:02d}"


# ── Availability ─────────────────────────────────────────────────────
def validate_request(date_iso: str, time_str: str, duration: int, settings: dict) -> str | None:
    now = datetime.now(TZ)
    try:
        requested_dt = datetime.combine(date.fromisoformat(date_iso), _parse_time(time_str), tzinfo=TZ)
    except (ValueError, IndexError):
        return "Sorry, I couldn't understand that date/time — could you try again? e.g. 'tomorrow 2pm'."

    if requested_dt < now + timedelta(minutes=settings["min_lead_minutes"]):
        return f"That's too soon — we need at least {settings['min_lead_minutes']} minutes' notice."
    if requested_dt.date() > (now + timedelta(days=settings["max_advance_days"])).date():
        return f"That's too far ahead — we only take bookings up to {settings['max_advance_days']} days in advance."

    blackout = supabase.table("blackout_dates").select("label").eq("date", date_iso).execute().data
    if blackout:
        label = blackout[0].get("label") or "closed that day"
        return f"Sorry, we're closed then — {label}."

    weekend = requested_dt.weekday() >= 5  # Mon=0 ... Sat=5, Sun=6
    open_t = settings["weekend_open"] if weekend else settings["weekday_open"]
    close_t = settings["weekend_close"] if weekend else settings["weekday_close"]
    open_dt = datetime.combine(requested_dt.date(), _parse_time(open_t), tzinfo=TZ)
    close_dt = datetime.combine(requested_dt.date(), _parse_time(close_t), tzinfo=TZ)
    if requested_dt < open_dt or requested_dt + timedelta(minutes=duration) > close_dt:
        return f"We're open {open_t[:5]}–{close_t[:5]} that day — could you pick a time in that window?"

    return None


def find_available_bay(date_iso: str, time_str: str, duration: int, settings: dict, day_state: dict | None = None) -> str | None:
    """Returns a free bay_id, or None if every active bay conflicts."""
    ds = day_state or get_day_state(date_iso)
    req_start = datetime.combine(date.fromisoformat(date_iso), _parse_time(time_str), tzinfo=TZ)
    req_end = req_start + timedelta(minutes=duration)
    buffer = timedelta(minutes=settings["buffer_minutes"])

    for bay in ds["bays"]:
        conflict = False

        for a in ds["appts"]:
            if a["bay_id"] != bay["id"]:
                continue
            a_start = _parse_ts(a["scheduled_at"])
            a_end = a_start + timedelta(minutes=a["duration_minutes"]) + buffer
            if req_start < a_end and a_start < req_end:
                conflict = True
                break
        if conflict:
            continue

        for b in ds["breaks"]:
            if b["bay_id"] != bay["id"]:
                continue
            b_start = datetime.combine(date.fromisoformat(date_iso), _parse_time(b["start_time"]), tzinfo=TZ)
            b_end = b_start + timedelta(minutes=b["duration_minutes"])
            if req_start < b_end and b_start < req_end:
                conflict = True
                break
        if conflict:
            continue

        for c in ds["closures"]:
            if c["bay_id"] != bay["id"]:
                continue
            c_start = _parse_ts(c["starts_at"])
            c_end = _parse_ts(c["ends_at"])
            if req_start < c_end and c_start < req_end:
                conflict = True
                break
        if conflict:
            continue

        return bay["id"]

    return None


def search_alternatives(date_iso: str, time_str: str, duration: int, settings: dict, max_options: int = 6, max_days: int = 3, exclude_original: bool = True) -> list[dict]:
    options = []
    start_date = date.fromisoformat(date_iso)
    start_time = _parse_time(time_str)

    for day_offset in range(max_days + 1):
        d = start_date + timedelta(days=day_offset)
        d_iso = d.isoformat()
        weekend = d.weekday() >= 5
        open_t = _parse_time(settings["weekend_open"] if weekend else settings["weekday_open"])
        close_t = _parse_time(settings["weekend_close"] if weekend else settings["weekday_close"])

        scan_start = start_time if day_offset == 0 else open_t
        cur = datetime.combine(d, scan_start, tzinfo=TZ)
        close_dt = datetime.combine(d, close_t, tzinfo=TZ)
        day_state = get_day_state(d_iso)
        if day_state["blackout"]:
            continue

        while cur + timedelta(minutes=duration) <= close_dt:
            cur_time_str = cur.strftime("%H:%M")
            is_original_slot = exclude_original and day_offset == 0 and cur_time_str == time_str
            if not is_original_slot:
                now_ok = cur >= datetime.now(TZ) + timedelta(minutes=settings["min_lead_minutes"])
                if now_ok and find_available_bay(d_iso, cur_time_str, duration, settings, day_state):
                    options.append({"date": d_iso, "time": cur_time_str, "label": f"{fmt_date_label(d_iso)} {cur_time_str}"})
                    if len(options) >= max_options:
                        return options
            cur += timedelta(minutes=15)

    return options


def book_appointment(bay_id: str, service: dict, chat_id, name: str, phone: str, date_iso: str, time_str: str) -> dict:
    scheduled_at = datetime.combine(date.fromisoformat(date_iso), _parse_time(time_str), tzinfo=TZ)
    reference = f"WP-{date_iso.replace('-', '')}-{random.randint(1000, 9999)}"
    row = {
        "customer_chat_id": str(chat_id),
        "customer_name": name,
        "customer_phone": phone,
        "channel": "telegram",
        "bay_id": bay_id,
        "service_id": service["id"],
        "scheduled_at": scheduled_at.isoformat(),
        "duration_minutes": service["duration_minutes"],
        "price_myr": service["price_myr"],
        "status": "confirmed",
        "reference": reference,
    }
    result = supabase.table("appointments").insert(row).execute()
    return result.data[0]


# ── Message handling ─────────────────────────────────────────────────
def do_booking_attempt(chat_id, service: dict, date_iso: str, time_str: str) -> None:
    """Checks availability for a specific slot. If free, moves to
    collecting name + phone (booking isn't finalized until that's done —
    see finalize_booking). If busy, offers alternatives, same as before."""
    settings = get_settings()
    error = validate_request(date_iso, time_str, service["duration_minutes"], settings)
    if error:
        send_message(TOKEN, chat_id, error)
        return

    day_state = get_day_state(date_iso)
    bay_id = find_available_bay(date_iso, time_str, service["duration_minutes"], settings, day_state)

    if bay_id:
        PENDING[chat_id] = {"stage": "awaiting_name", "service": service, "date": date_iso, "time": time_str}
        send_message(
            TOKEN, chat_id,
            f"Good news, {service['name']} on {fmt_date_label(date_iso)} at {time_str} is open! "
            "What name should I book it under?",
        )
        return

    options = search_alternatives(date_iso, time_str, service["duration_minutes"], settings)
    if not options:
        send_message(
            TOKEN, chat_id,
            f"Sorry, we're fully booked around then for {service['name']} — "
            "try a different day, or message us directly.",
        )
        return

    PENDING[chat_id] = {"stage": "awaiting_slot_choice", "service": service, "options": options}
    lines = "\n".join(f"{i + 1}. {o['label']}" for i, o in enumerate(options))
    send_message(
        TOKEN, chat_id,
        f"That slot's full for {service['name']}. Here are the next {len(options)} open slots from there:\n{lines}\n"
        "Reply with the number that works — or if none of these suit you, just tell me a specific time and I'll check that directly.",
    )


def browse_availability(chat_id, service: dict, date_iso: str) -> None:
    """Service + date given, but no specific time — e.g. 'what's open today
    for a full detail'. Lists real open slots for that date rather than
    just asking 'what time?' again, reusing the same alternative-slot
    mechanism the busy-path uses. Scoped to just the requested date
    (max_days=0) rather than silently spilling into other days, since the
    customer asked about a specific day."""
    settings = get_settings()
    weekend = date.fromisoformat(date_iso).weekday() >= 5
    open_t = (settings["weekend_open"] if weekend else settings["weekday_open"])[:5]
    options = search_alternatives(date_iso, open_t, service["duration_minutes"], settings, max_days=0, exclude_original=False)

    if not options:
        send_message(
            TOKEN, chat_id,
            f"Sorry, no open slots left for {service['name']} on {fmt_date_label(date_iso)}. "
            "Want me to check a different day?",
        )
        return

    PENDING[chat_id] = {"stage": "awaiting_slot_choice", "service": service, "options": options}
    lines = "\n".join(f"{i + 1}. {o['label']}" for i, o in enumerate(options))
    send_message(
        TOKEN, chat_id,
        f"Here are the next {len(options)} open slots for {service['name']} on {fmt_date_label(date_iso)} "
        f"(there may be more later in the day):\n{lines}\n"
        "Reply with the number that works — or tell me a specific time and I'll check that directly.",
    )


def finalize_booking(chat_id, name: str, phone: str, service: dict, date_iso: str, time_str: str) -> None:
    """Name + phone collected — re-verify (real time has passed during
    that back-and-forth) and actually write the booking."""
    settings = get_settings()
    day_state = get_day_state(date_iso)
    bay_id = find_available_bay(date_iso, time_str, service["duration_minutes"], settings, day_state)

    if not bay_id:
        send_message(TOKEN, chat_id, "Ah, that slot just got taken while we were chatting — let me find you another.")
        do_booking_attempt(chat_id, service, date_iso, time_str)
        return

    appt = book_appointment(bay_id, service, chat_id, name, phone, date_iso, time_str)
    send_message(
        TOKEN, chat_id,
        f"You're booked, {name}! {service['name']} on {fmt_date_label(date_iso)} at {time_str}. "
        f"RM{service['price_myr']}. Ref: {appt['reference']}. See you then!",
    )


def handle_message(msg: dict) -> None:
    chat_id = msg["chat"]["id"]
    if "text" not in msg:
        return
    text = msg["text"].strip()
    if text.startswith("/"):
        return

    pending = PENDING.get(chat_id)

    # Name/phone collection is plain text, not a booking query — handled
    # directly without a Gemini call, both to save quota and because
    # feeding "John Tan" or "012-3456789" through the booking-intent
    # parser would just invite it to misread them as something else.
    if pending and pending.get("stage") == "awaiting_name":
        if not text or len(text) > 80:
            send_message(TOKEN, chat_id, "Could you share your name for the booking?")
            return
        pending["name"] = text
        pending["stage"] = "awaiting_phone"
        send_message(TOKEN, chat_id, f"Thanks {text}! And your phone number?")
        return

    if pending and pending.get("stage") == "awaiting_phone":
        phone = normalize_my_phone(text)
        if not phone:
            send_message(TOKEN, chat_id, "That doesn't look like a Malaysian mobile number — could you send it again? e.g. 012-3456789")
            return
        del PENDING[chat_id]
        finalize_booking(chat_id, pending["name"], phone, pending["service"], pending["date"], pending["time"])
        return

    services = get_services()
    now = datetime.now(TZ)
    today_iso = now.date().isoformat()
    weekday = now.strftime("%A")

    try:
        parsed = parse_booking(text, services, today_iso, weekday, pending)
    except Exception as e:
        print(f"Gemini call failed: {e}", flush=True)
        send_message(TOKEN, chat_id, "Sorry, having a small hiccup on our end — please try again in a moment.")
        return

    if parsed.get("is_slot_choice") and pending and pending.get("stage") == "awaiting_slot_choice":
        idx = parsed.get("chosen_slot_index")
        options = pending["options"]
        if not idx or not (1 <= idx <= len(options)):
            send_message(TOKEN, chat_id, f"Sorry, which one did you mean — 1 to {len(options)}?")
            return
        chosen = options[idx - 1]
        del PENDING[chat_id]
        do_booking_attempt(chat_id, pending["service"], chosen["date"], chosen["time"])
        return

    # Accumulate across turns instead of re-asking from scratch each time —
    # each message only needs to be parsed for what IT contains; whatever
    # was already established earlier in this chat is carried forward and
    # merged here in code, not re-derived by the LLM from a text summary.
    collecting = pending if pending and pending.get("stage") == "collecting_details" else {}
    new_service = next((s for s in services if s["name"] == parsed.get("matched_service")), None)
    service = new_service or collecting.get("service")
    date_iso = parsed.get("requested_date") or collecting.get("date_iso")
    time_str = parsed.get("requested_time") or collecting.get("time_str")

    if not collecting and not parsed.get("is_booking_request"):
        send_message(TOKEN, chat_id, parsed.get("reply_text") or "Hi! Want to book a wash? Let me know which service and when.")
        return

    # Service + date given but no specific time ("what's open today for a
    # detail") — show real options instead of just asking "what time?"
    if service and date_iso and not time_str:
        if chat_id in PENDING:
            del PENDING[chat_id]
        browse_availability(chat_id, service, date_iso)
        return

    if not (service and date_iso and time_str):
        PENDING[chat_id] = {"stage": "collecting_details", "service": service, "date_iso": date_iso, "time_str": time_str}
        # Gemini now has the accumulated state (see _pending_context), so
        # its reply can answer a side question or ask only for what's
        # genuinely still missing — the hardcoded fallback only covers
        # the unlikely case reply_text came back empty.
        missing = []
        if not service:
            missing.append("which service")
        if not date_iso:
            missing.append("what date")
        if not time_str:
            missing.append("what time")
        send_message(TOKEN, chat_id, parsed.get("reply_text") or f"Got it — just need to know {' and '.join(missing)}.")
        return

    if chat_id in PENDING:
        del PENDING[chat_id]
    do_booking_attempt(chat_id, service, date_iso, time_str)


def run() -> None:
    print("Wash Point booking bot running. Ctrl+C to stop.", flush=True)
    offset = None
    while True:
        try:
            updates = get_updates(TOKEN, offset=offset)
        except Exception as e:
            print(f"getUpdates failed: {e}", flush=True)
            time.sleep(3)
            continue
        for update in updates:
            offset = update["update_id"] + 1
            msg = update.get("message")
            if not msg:
                continue
            try:
                handle_message(msg)
            except Exception as e:
                print(f"Error handling message: {e}", flush=True)
                try:
                    send_message(TOKEN, msg["chat"]["id"], "Sorry, something went wrong — please try again or message us directly.")
                except Exception:
                    pass


if __name__ == "__main__":
    run()
