"""
Telegram Bot API — minimal send/receive for the Wash Point booking bot.

Run directly:
  python telegram_api.py me         # verify the token works
  python telegram_api.py updates    # see recent messages + chat ids
"""

from __future__ import annotations

import os
import sys

import requests
from dotenv import load_dotenv

load_dotenv()


def get_me(token: str) -> dict:
    return requests.get(f"https://api.telegram.org/bot{token}/getMe").json()


def get_updates(token: str, offset: int | None = None) -> list[dict]:
    params = {"offset": offset, "timeout": 25} if offset else {"timeout": 25}
    result = requests.get(f"https://api.telegram.org/bot{token}/getUpdates", params=params, timeout=30).json()
    return result.get("result", [])


def send_message(token: str, chat_id: int | str, text: str) -> dict:
    payload = {"chat_id": chat_id, "text": text}
    return requests.post(f"https://api.telegram.org/bot{token}/sendMessage", json=payload).json()


if __name__ == "__main__":
    token = os.environ["TELEGRAM_BOT_TOKEN"]
    cmd = sys.argv[1] if len(sys.argv) > 1 else "me"

    if cmd == "me":
        print(get_me(token))
    elif cmd == "updates":
        updates = get_updates(token)
        if not updates:
            print("No messages yet — message your bot on Telegram first, then re-run this.")
        for u in updates:
            msg = u.get("message", {})
            chat = msg.get("chat", {})
            print(f"chat id: {chat.get('id')} | from: {chat.get('first_name')} | text: {msg.get('text')}")
