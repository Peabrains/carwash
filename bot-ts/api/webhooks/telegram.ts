import "../../src/env.js";
import { bot } from "../../src/bot.js";

export async function POST(request: Request): Promise<Response> {
  return bot.webhooks.telegram(request);
}
