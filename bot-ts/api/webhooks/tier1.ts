import "../../src/env.js";
import { waitUntil } from "@vercel/functions";
import { tier1Bot } from "../../src/tier1-bot.js";

export async function POST(request: Request): Promise<Response> {
  return tier1Bot.webhooks.telegram(request, { waitUntil });
}
