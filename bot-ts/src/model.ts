import "./env.js";
import { gateway } from "@ai-sdk/gateway";

/**
 * All model calls go through Vercel AI Gateway.
 * Change AI_MODEL to switch providers without changing bot logic.
 */
export const bookingModel = gateway(
  process.env.AI_MODEL ?? "openai/gpt-5.6-luna",
);
