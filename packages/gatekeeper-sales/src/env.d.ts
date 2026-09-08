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
  }

  interface GlobalProps {
    mainModule: typeof import("./worker.js");
    durableNamespaces: "SalesCoreDurableObject" | "SalesGatekeeper";
  }
}
