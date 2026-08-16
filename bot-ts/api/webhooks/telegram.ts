import "../../src/env.js";
import { bot } from "../../src/bot.js";

export default async function handler(request: Request): Promise<Response> {
  return bot.webhooks.telegram(request);
}
