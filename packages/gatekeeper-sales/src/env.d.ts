// Project-specific Env/ctx.exports augmentation for Wrangler's generated types.

declare namespace Cloudflare {
  interface Env {
    /** Tenant name; one SalesCoreDurableObject per tenant. Default "default". */
    SALES_TENANT?: string;
    /** `anthropic` | `workers-ai` | `ollama` | `openai-compat`. */
    SALES_AI_PROVIDER?: string;
    /** Model id for the provider, e.g. `claude-sonnet-5` or `@cf/openai/gpt-oss-120b`. */
    SALES_AI_MODEL?: string;
    /** Secret: API key / token. Ollama needs none. */
    SALES_AI_API_KEY?: string;
    /** Optional base URL override (OpenAI-compatible root, or Anthropic root / AI Gateway URL). */
    SALES_AI_BASE_URL?: string;
    /** Workers AI: the Cloudflare account id (used to build the OpenAI-compatible base URL). */
    SALES_AI_ACCOUNT_ID?: string;
    /** Injected by run-dev-server / deploy: public base URL of this worker. Unused today. */
    BASE_URL?: string;
    /** Secret: Slack bot token (`chat:write` scope). Notification outlet only (設計書 §20). */
    SALES_SLACK_BOT_TOKEN?: string;
    /** Channel id or #name `chat.postMessage` sends to. Not a secret. */
    SALES_SLACK_CHANNEL?: string;
    /**
     * Workers AI account id used for voice transcription (`transcribe.ts`), independent of
     * SALES_AI_PROVIDER (Whisper only runs on Workers AI, even when the judgment AI is Ollama).
     * Falls back to SALES_AI_ACCOUNT_ID when SALES_AI_PROVIDER is already "workers-ai".
     */
    SALES_TRANSCRIBE_ACCOUNT_ID?: string;
    /** Secret: Workers AI API token for transcription. Falls back to SALES_AI_API_KEY (see above). */
    SALES_TRANSCRIBE_API_KEY?: string;
  }

  interface GlobalProps {
    mainModule: typeof import("./worker.js");
    durableNamespaces: "SalesCoreDurableObject" | "SalesGatekeeper";
  }
}
