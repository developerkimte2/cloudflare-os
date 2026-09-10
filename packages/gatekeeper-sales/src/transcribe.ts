/**
 * Voice capture (plans/sales-os-voice.md): turns an uploaded/recorded audio clip into text via
 * Cloudflare Workers AI's Whisper model. This is a one-shot transcription utility, not part of the
 * `LlmProvider` abstraction in `llm.ts` (that one speaks chat-completions; Whisper is a different
 * native Workers AI REST shape) and it never touches the sales-core pipeline itself — the caller
 * (CaptureBox) puts the returned text in front of the user to review before it is captured.
 */

const MODEL = "@cf/openai/whisper-large-v3-turbo";
/** Shown next to the transcript so it's clear this isn't the sales-judgment AI (`AiAttribution`). */
export const TRANSCRIBE_MODEL_NAME = "workers-ai/whisper-large-v3-turbo";

export interface TranscribeInfo {
  configured: boolean;
}

export class TranscribeError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "TranscribeError";
  }
}

interface Credentials {
  accountId: string;
  apiKey: string;
}

/**
 * Transcription always runs on Cloudflare Workers AI regardless of `SALES_AI_PROVIDER` (local
 * providers like Ollama have no ASR model). Dedicated `SALES_TRANSCRIBE_*` vars take priority;
 * when absent, and only when the sales judgment AI is itself configured for `workers-ai`, its
 * account/key are reused so a single Workers AI setup covers both.
 */
function resolveCredentials(env: Cloudflare.Env): Credentials | undefined {
  const explicitAccountId = env.SALES_TRANSCRIBE_ACCOUNT_ID?.trim();
  const explicitApiKey = env.SALES_TRANSCRIBE_API_KEY?.trim();
  if (explicitAccountId && explicitApiKey) return { accountId: explicitAccountId, apiKey: explicitApiKey };

  if ((env.SALES_AI_PROVIDER ?? "").trim().toLowerCase() === "workers-ai") {
    const accountId = env.SALES_AI_ACCOUNT_ID?.trim();
    const apiKey = env.SALES_AI_API_KEY?.trim();
    if (accountId && apiKey) return { accountId, apiKey };
  }
  return undefined;
}

export function describeTranscription(env: Cloudflare.Env): TranscribeInfo {
  return { configured: !!resolveCredentials(env) };
}

/** Transcribes `audio` (raw bytes, any format Whisper accepts) to text. Throws TranscribeError on failure. */
export async function transcribeAudio(
  env: Cloudflare.Env, audio: ArrayBuffer, mimeType: string,
): Promise<{ text: string; modelName: string }> {
  const creds = resolveCredentials(env);
  if (!creds) {
    throw new TranscribeError(
      "Transcription is not configured: set SALES_TRANSCRIBE_ACCOUNT_ID and SALES_TRANSCRIBE_API_KEY " +
        "(or configure SALES_AI_PROVIDER=workers-ai with SALES_AI_ACCOUNT_ID and SALES_AI_API_KEY)",
    );
  }
  const url = `https://api.cloudflare.com/client/v4/accounts/${creds.accountId}/ai/run/${MODEL}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${creds.apiKey}`,
      "content-type": mimeType || "application/octet-stream",
    },
    body: audio,
  });

  let body: { result?: { text?: string }; success?: boolean; errors?: { message: string }[] };
  try {
    body = await res.json();
  } catch {
    throw new TranscribeError(`Workers AI whisper returned a non-JSON response (status ${res.status})`, res.status);
  }
  if (!res.ok || body.success === false) {
    throw new TranscribeError(`Workers AI whisper failed: ${body.errors?.[0]?.message ?? res.status}`, res.status);
  }
  const text = body.result?.text?.trim();
  if (!text) throw new TranscribeError("Workers AI whisper returned no text");
  return { text, modelName: TRANSCRIBE_MODEL_NAME };
}
