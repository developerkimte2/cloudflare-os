/** Builds the sales-core LLM provider from Worker env (計画書 §2 "LLM"). */
import {
  AnthropicProvider, LlmError, OpenAiCompatProvider, type LlmProvider, type LlmRequest,
  type LlmResponse,
} from "@gadgets/sales-core";

export interface AiInfo {
  provider: string;
  model: string;
  configured: boolean;
}

/** Placeholder used when nothing is configured: every call fails with an actionable message. */
class UnconfiguredProvider implements LlmProvider {
  readonly provider = "unconfigured";
  constructor(readonly model: string, private readonly reason: string) {}
  async complete(_request: LlmRequest): Promise<LlmResponse> {
    throw new LlmError(`AI provider is not configured: ${this.reason}`);
  }
}

export function describeAi(env: Cloudflare.Env): AiInfo {
  const provider = (env.SALES_AI_PROVIDER ?? "").trim();
  const model = (env.SALES_AI_MODEL ?? "").trim();
  return { provider, model, configured: buildLlm(env).provider !== "unconfigured" };
}

export function buildLlm(env: Cloudflare.Env): LlmProvider {
  const provider = (env.SALES_AI_PROVIDER ?? "").trim().toLowerCase();
  const model = (env.SALES_AI_MODEL ?? "").trim();
  const apiKey = env.SALES_AI_API_KEY?.trim();
  const baseUrl = env.SALES_AI_BASE_URL?.trim();
  if (!provider || !model) {
    return new UnconfiguredProvider(model, "set SALES_AI_PROVIDER and SALES_AI_MODEL");
  }
  switch (provider) {
    case "anthropic":
      if (!apiKey) return new UnconfiguredProvider(model, "SALES_AI_API_KEY is missing");
      return new AnthropicProvider({ apiKey, model, baseUrl });
    case "workers-ai": {
      const accountId = env.SALES_AI_ACCOUNT_ID?.trim();
      if (!apiKey) return new UnconfiguredProvider(model, "SALES_AI_API_KEY is missing");
      const url = baseUrl ?? (accountId
        ? `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1` : undefined);
      if (!url) return new UnconfiguredProvider(model, "SALES_AI_ACCOUNT_ID or SALES_AI_BASE_URL is missing");
      return new OpenAiCompatProvider({ baseUrl: url, model, apiKey, provider: "workers-ai" });
    }
    case "ollama":
      return new OpenAiCompatProvider({
        baseUrl: baseUrl ?? "http://localhost:11434/v1", model, provider: "ollama",
      });
    case "openai-compat":
    case "openai":
      if (!baseUrl && provider === "openai-compat") {
        return new UnconfiguredProvider(model, "SALES_AI_BASE_URL is missing");
      }
      return new OpenAiCompatProvider({
        baseUrl: baseUrl ?? "https://api.openai.com/v1", model, apiKey, provider,
      });
    default:
      return new UnconfiguredProvider(model, `unknown SALES_AI_PROVIDER "${provider}"`);
  }
}
