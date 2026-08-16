import { transcribe } from "ai";
import { gateway } from "@ai-sdk/gateway";
import type { Attachment } from "chat";

const transcriptionModel = gateway.transcription(
  process.env.AI_TRANSCRIPTION_MODEL ?? "openai/gpt-4o-mini-transcribe",
);

/**
 * Convert Telegram voice/audio attachments into text before the booking agent
 * sees the turn. Audio is deliberately not sent to Luna as a file because the
 * booking model is a text model and the Chat SDK treats audio as unsupported
 * model context.
 */
export async function transcribeAttachments(
  attachments: Attachment[] | undefined,
): Promise<string | undefined> {
  const audio = (attachments ?? []).find((attachment) => attachment.type === "audio");
  if (!audio?.fetchData) return undefined;

  const startedAt = Date.now();
  try {
    const data = await audio.fetchData();
    const result = await transcribe({
      model: transcriptionModel,
      audio: data,
      maxRetries: 1,
    });
    const text = result.text.trim();

    console.info("[voice] transcription_success", {
      language: result.language ?? "unknown",
      durationSeconds: result.durationInSeconds ?? null,
      bytes: data.byteLength,
      elapsedMs: Date.now() - startedAt,
    });

    if (!text) return undefined;
    return text;
  } catch (error) {
    console.error("[voice] transcription_failed", {
      type: audio.mimeType ?? "audio",
      elapsedMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
