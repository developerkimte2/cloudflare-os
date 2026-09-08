/**
 * JSON extraction + schema validation + one bounded repair round. Every skill goes through
 * `completeJson()` so no raw model text ever reaches the rules layer (設計書 §14.2, §15).
 */
import type { z } from "zod";
import type { LlmProvider, LlmRequest, LlmResponse } from "./provider.js";

export class SchemaValidationError extends Error {
  constructor(message: string, readonly issues: string[], readonly rawText: string) {
    super(message);
    this.name = "SchemaValidationError";
  }
}

/** Pulls the first JSON object out of a response that may contain prose or code fences. */
export function extractJsonObject(text: string): string | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.indexOf("{");
  if (start < 0) return undefined;
  // Walk to the matching close brace, honouring strings.
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i]!;
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return candidate.slice(start, i + 1);
    }
  }
  return undefined;
}

export interface CompleteJsonResult<T> {
  value: T;
  response: LlmResponse;
  /** Number of repair rounds that were needed (0 = first answer validated). */
  repairs: number;
}

export interface CompleteJsonOptions {
  /** Maximum repair rounds after the first attempt. Default 1. */
  maxRepairs?: number;
}

export async function completeJson<S extends z.ZodType>(
  llm: LlmProvider,
  request: LlmRequest,
  schema: S,
  options: CompleteJsonOptions = {},
): Promise<CompleteJsonResult<z.infer<S>>> {
  const maxRepairs = options.maxRepairs ?? 1;
  let attempt = 0;
  let lastError: SchemaValidationError | undefined;
  let currentRequest: LlmRequest = { ...request, json: true };
  while (attempt <= maxRepairs) {
    const response = await llm.complete(currentRequest);
    const parsed = tryParse(response.text, schema);
    if (parsed.ok) return { value: parsed.value, response, repairs: attempt };
    lastError = parsed.error;
    attempt++;
    currentRequest = {
      ...request,
      json: true,
      user: request.user +
        "\n\n---\nあなたの前回の出力は JSON schema 検証に失敗しました。以下の問題を修正し、" +
        "同じ内容を **JSON オブジェクトのみ** で出力し直してください。説明文は不要です。\n" +
        "問題:\n" + lastError.issues.map(i => `- ${i}`).join("\n") +
        "\n\n前回の出力 (先頭 2000 文字):\n" + response.text.slice(0, 2000),
    };
  }
  throw lastError!;
}

function tryParse<S extends z.ZodType>(text: string, schema: S):
    { ok: true; value: z.infer<S> } | { ok: false; error: SchemaValidationError } {
  const json = extractJsonObject(text);
  if (!json) {
    return { ok: false, error: new SchemaValidationError(
      "No JSON object found in model output", ["出力に JSON オブジェクトが含まれていません"], text) };
  }
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (err) {
    return { ok: false, error: new SchemaValidationError(
      "Model output is not valid JSON", [`JSON parse error: ${(err as Error).message}`], text) };
  }
  const result = schema.safeParse(data);
  if (result.success) return { ok: true, value: result.data };
  const issues = result.error.issues.slice(0, 20).map(i => `${i.path.join(".") || "(root)"}: ${i.message}`);
  return { ok: false, error: new SchemaValidationError("Model output failed schema validation", issues, text) };
}
