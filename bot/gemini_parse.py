"""
Gemini parsing for the Wash Point booking bot.

Gemini's job is language understanding only — which service, what date/time
(including resolving "tomorrow", "next Sat", etc. against today's real
date), and whether a reply is picking one of several offered alternative
slots. It never computes availability, totals, or booking decisions —
those are deterministic Python against real Supabase data, for the same
reason the quote-agent and PWA logic keep arithmetic out of the LLM: a
wrong guess here would mean double-booking a bay or misquoting a customer.
"""

from __future__ import annotations

import json
import os

from dotenv import load_dotenv
from google import genai
from google.genai import types

load_dotenv()

MODEL = os.environ.get("GEMINI_MODEL", "gemini-flash-lite-latest")

SCHEMA = {
    "type": "object",
    "properties": {
        "is_slot_choice": {
            "type": "boolean",
            "description": "True only if alternative slots were offered "
            "below AND this message is picking one of them (e.g. '1', "
            "'the first one', 'the 10am one', '2:30 works'). False if no "
            "alternatives were offered, or this is a new/different request.",
        },
        "chosen_slot_index": {
            "type": "integer",
            "description": "1-based index of the chosen alternative, if is_slot_choice is true.",
        },
        "is_booking_request": {
            "type": "boolean",
            "description": "True if the customer is asking to book a wash "
            "(now or as part of this conversation). False for greetings or "
            "unrelated messages. Also false when is_slot_choice is true.",
        },
        "matched_service": {
            "type": "string",
            "description": "Exact name of the matched service from the list below, if identifiable.",
        },
        "requested_date": {
            "type": "string",
            "description": "ISO date YYYY-MM-DD, resolved against today's "
            "actual date given below (e.g. 'tomorrow', 'next Saturday'). "
            "Omit if no date, or only a vague one ('sometime this week'), was given.",
        },
        "requested_time": {
            "type": "string",
            "description": "24h HH:MM. Only fill this in if a genuinely "
            "specific time was given or clearly implied. Vague references "
            "like 'morning' or 'afternoon' are NOT specific enough — omit "
            "this field for those rather than guessing an exact time.",
        },
        "reply_text": {
            "type": "string",
            "description": "A short, friendly reply — used when asking "
            "which service, asking for a specific date/time, or replying "
            "to a greeting/unrelated message. Do NOT state availability, "
            "prices, or confirm a booking here — those are computed "
            "separately and appended by the system.",
        },
    },
    "required": ["is_slot_choice", "is_booking_request", "reply_text"],
}

PROMPT = (
    "You are a friendly booking assistant for Wash Point, a car wash. "
    "Today's actual date is {today} ({weekday}). Here are the services "
    "offered:\n\n{services}\n\n"
    "{pending_context}"
    "Determine what the customer's message below means. If they're asking "
    "to book, identify matched_service (must match a name from the list "
    "above exactly), and requested_date/requested_time if specific enough "
    "— resolve relative dates like 'tomorrow' or 'Friday' against today's "
    "actual date above. If the service or a specific date/time is missing "
    "or unclear, leave those fields out and use reply_text to ask for "
    "exactly what's missing — don't guess. If this is a greeting or "
    "unrelated to booking, set is_booking_request to false and reply "
    "briefly.\n\n"
    "Customer message: {message}"
)


def _client() -> genai.Client:
    return genai.Client(api_key=os.environ["GEMINI_API_KEY"])


def _pending_context(pending: dict | None) -> str:
    if not pending:
        return ""

    if pending.get("stage") == "collecting_details":
        known = []
        if pending.get("service"):
            known.append(f"service = {pending['service']['name']}")
        if pending.get("date_iso"):
            known.append(f"date = {pending['date_iso']}")
        if pending.get("time_str"):
            known.append(f"time = {pending['time_str']}")
        if not known:
            return ""
        return (
            f"For this booking, the customer has already told you: {', '.join(known)}. "
            "Do not ask for these again. If their message below adds a missing piece, "
            "great. If it's a question (e.g. 'what services do you have'), answer it "
            "directly in reply_text while keeping the already-known details in mind — "
            "don't restart the conversation or ask something already answered.\n\n"
        )

    if pending.get("stage") != "awaiting_slot_choice":
        return ""
    options = "\n".join(
        f"{i + 1}. {opt['label']}" for i, opt in enumerate(pending["options"])
    )
    return (
        f"The customer was just offered these alternative slots for "
        f"{pending['service']['name']}, since their original request was full:\n"
        f"{options}\n"
        "Check first whether their message below is picking one of these.\n\n"
    )


def parse_booking(message: str, services: list[dict], today_iso: str, weekday: str, pending: dict | None = None) -> dict:
    services_text = "\n".join(
        f"- {s['name']}: {s['duration_minutes']} min, RM{s['price_myr']}" for s in services
    )
    client = _client()
    contents = PROMPT.format(
        today=today_iso,
        weekday=weekday,
        services=services_text,
        pending_context=_pending_context(pending),
        message=message,
    )
    response = client.models.generate_content(
        model=MODEL,
        contents=contents,
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=SCHEMA,
        ),
    )
    return json.loads(response.text)
