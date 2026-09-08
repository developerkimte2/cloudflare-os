/**
 * LLM provider abstraction (計画書 §2 "LLM"). The Sales Context Core only ever needs "send a system
 * prompt + user prompt, get text back"; JSON parsing / validation / repair are handled in
 * `json.ts` so every provider behaves identically.
 */

export interface LlmRequest {
  system: string;
  user: string;
  /** Hint that the answer must be a single JSON object. Providers that support JSON mode use it. */
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
}

export interface LlmResponse {
  text: string;
  provider: string;
  model: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface LlmProvider {
  readonly provider: string;
  readonly model: string;
  complete(request: LlmRequest): Promise<LlmResponse>;
}

export class LlmError extends Error {
  constructor(message: string, readonly status?: number, readonly bodySnippet?: string) {
    super(message);
    this.name = "LlmError";
  }
}

type FetchLike = typeof fetch;

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  /**
   * Base URL. Default is the public API; set to
   * `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic` to route via AI Gateway
   * (設計書 §8.1).
   */
  baseUrl?: string;
  fetch?: FetchLike;
}

/** Anthropic Messages API, optionally through Cloudflare AI Gateway. */
export class AnthropicProvider implements LlmProvider {
  readonly provider = "anthropic";
  readonly model: string;
  readonly #opts: AnthropicOptions;
  readonly #fetch: FetchLike;

  constructor(opts: AnthropicOptions) {
    this.#opts = opts;
    this.model = opts.model;
    // Looked up per call so a test can stub the global after construction.
    this.#fetch = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const base = (this.#opts.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
    const res = await this.#fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.#opts.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: request.maxTokens ?? 4096,
        temperature: request.temperature ?? 0,
        system: request.system,
        messages: [{ role: "user", content: request.user }],
      }),
    });
    if (!res.ok) throw await httpError("anthropic", res);
    const body = await res.json() as {
      content?: { type: string; text?: string }[];
      usage?: { input_tokens?: number; output_tokens?: number };
      model?: string;
    };
    const text = (body.content ?? []).filter(c => c.type === "text").map(c => c.text ?? "").join("");
    return {
      text, provider: this.provider, model: body.model ?? this.model,
      usage: { inputTokens: body.usage?.input_tokens, outputTokens: body.usage?.output_tokens },
    };
  }
}

export interface OpenAiCompatOptions {
  /** e.g. `https://api.cloudflare.com/client/v4/accounts/<id>/ai/v1` or `http://localhost:11434/v1`. */
  baseUrl: string;
  model: string;
  apiKey?: string;
  provider?: string;
  /** Some servers reject `response_format`; Workers AI accepts it, Ollama accepts `json_object`. */
  supportsJsonMode?: boolean;
  fetch?: FetchLike;
}

/** Any OpenAI-compatible `/chat/completions` endpoint: Workers AI, Ollama, OpenAI, vLLM… */
export class OpenAiCompatProvider implements LlmProvider {
  readonly provider: string;
  readonly model: string;
  readonly #opts: OpenAiCompatOptions;
  readonly #fetch: FetchLike;

  constructor(opts: OpenAiCompatOptions) {
    this.#opts = opts;
    this.model = opts.model;
    this.provider = opts.provider ?? "openai-compat";
    this.#fetch = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const base = this.#opts.baseUrl.replace(/\/+$/, "");
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.#opts.apiKey) headers.authorization = `Bearer ${this.#opts.apiKey}`;
    const body: Record<string, unknown> = {
      model: this.model,
      temperature: request.temperature ?? 0,
      max_tokens: request.maxTokens ?? 4096,
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.user },
      ],
    };
    if (request.json && this.#opts.supportsJsonMode !== false) {
      body.response_format = { type: "json_object" };
    }
    const res = await this.#fetch(`${base}/chat/completions`, {
      method: "POST", headers, body: JSON.stringify(body),
    });
    if (!res.ok) throw await httpError(this.provider, res);
    const data = await res.json() as {
      choices?: { message?: { content?: string | { type: string; text?: string }[] } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      model?: string;
    };
    const content = data.choices?.[0]?.message?.content;
    const text = typeof content === "string"
      ? content
      : (content ?? []).map(part => part.text ?? "").join("");
    return {
      text, provider: this.provider, model: data.model ?? this.model,
      usage: { inputTokens: data.usage?.prompt_tokens, outputTokens: data.usage?.completion_tokens },
    };
  }
}

async function httpError(provider: string, res: Response): Promise<LlmError> {
  let snippet = "";
  try {
    snippet = (await res.text()).slice(0, 300);
  } catch {
    // ignore
  }
  return new LlmError(`${provider} request failed with status ${res.status}`, res.status, snippet);
}

/**
 * Scripted provider for tests and fixtures. Each call pops the next response; a function can be
 * given to decide per request. Also records every request for assertions.
 */
export class FakeLlmProvider implements LlmProvider {
  readonly provider = "fake";
  readonly model = "fake-model";
  readonly requests: LlmRequest[] = [];
  #responses: (string | ((req: LlmRequest) => string))[];

  constructor(responses: (string | object | ((req: LlmRequest) => string | object))[] = []) {
    this.#responses = responses.map(r => {
      if (typeof r === "function") return (req: LlmRequest) => asText(r(req));
      return asText(r);
    });
  }

  push(response: string | object | ((req: LlmRequest) => string | object)): void {
    this.#responses.push(typeof response === "function"
      ? (req: LlmRequest) => asText(response(req))
      : asText(response));
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);
    const next = this.#responses.shift();
    if (next === undefined) throw new LlmError("FakeLlmProvider: no scripted response left");
    const text = typeof next === "function" ? next(request) : next;
    return { text, provider: this.provider, model: this.model };
  }
}

function asText(value: string | object): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
