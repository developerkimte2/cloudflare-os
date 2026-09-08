import { describe, expect, it } from "vitest";
import { z } from "zod";
import { completeJson, extractJsonObject, SchemaValidationError } from "../src/ai/json.js";
import { FakeLlmProvider } from "../src/ai/provider.js";

describe("extractJsonObject", () => {
  it("extracts a bare JSON object", () => {
    expect(extractJsonObject('{"a":1}')).toBe('{"a":1}');
  });

  it("extracts JSON from a ```json code fence", () => {
    const text = "Here you go:\n```json\n{\"a\":1}\n```\nThanks.";
    expect(extractJsonObject(text)).toBe('{"a":1}');
  });

  it("extracts JSON from a bare ``` code fence (no language tag)", () => {
    const text = "```\n{\"a\":1}\n```";
    expect(extractJsonObject(text)).toBe('{"a":1}');
  });

  it("extracts JSON embedded in surrounding prose", () => {
    const text = 'Sure, the result is {"a":1} — let me know if you need more.';
    expect(extractJsonObject(text)).toBe('{"a":1}');
  });

  it("handles nested braces", () => {
    const text = '{"a":{"b":{"c":1}},"d":2}';
    expect(extractJsonObject(text)).toBe(text);
  });

  it("does not get confused by braces inside strings", () => {
    const text = '{"a":"contains } a brace","b":1}';
    expect(extractJsonObject(text)).toBe(text);
  });

  it("handles escaped quotes inside strings", () => {
    const text = '{"a":"she said \\"hi } there\\""}';
    expect(extractJsonObject(text)).toBe(text);
  });

  it("returns undefined when there is no JSON object", () => {
    expect(extractJsonObject("no json here")).toBeUndefined();
  });

  it("returns undefined for an unterminated object", () => {
    expect(extractJsonObject('{"a":1')).toBeUndefined();
  });
});

const schema = z.object({ name: z.string(), age: z.number().min(0) });

describe("completeJson", () => {
  it("succeeds on the first try when the response already validates", async () => {
    const llm = new FakeLlmProvider([{ name: "Taro", age: 30 }]);
    const result = await completeJson(llm, { system: "s", user: "u" }, schema);
    expect(result.value).toEqual({ name: "Taro", age: 30 });
    expect(result.repairs).toBe(0);
    expect(llm.requests).toHaveLength(1);
  });

  it("repairs once when the first response is invalid but the second is valid", async () => {
    const llm = new FakeLlmProvider([
      { name: "Taro", age: -5 }, // invalid: age must be >= 0
      { name: "Taro", age: 30 },
    ]);
    const result = await completeJson(llm, { system: "s", user: "u" }, schema);
    expect(result.value).toEqual({ name: "Taro", age: 30 });
    expect(result.repairs).toBe(1);
    expect(llm.requests).toHaveLength(2);
    // The repair prompt must mention the issues found in the first attempt.
    expect(llm.requests[1]!.user).toContain("age");
    expect(llm.requests[1]!.user).toContain(JSON.stringify({ name: "Taro", age: -5 }));
  });

  it("throws SchemaValidationError after exhausting maxRepairs", async () => {
    const llm = new FakeLlmProvider([
      { name: "Taro", age: -1 },
      { name: "Taro", age: -2 },
    ]);
    await expect(completeJson(llm, { system: "s", user: "u" }, schema, { maxRepairs: 1 }))
      .rejects.toBeInstanceOf(SchemaValidationError);
    expect(llm.requests).toHaveLength(2);
  });

  it("treats non-JSON output as a schema failure that can be repaired", async () => {
    const llm = new FakeLlmProvider([
      "sorry, I cannot help with that",
      { name: "Taro", age: 30 },
    ]);
    const result = await completeJson(llm, { system: "s", user: "u" }, schema);
    expect(result.value).toEqual({ name: "Taro", age: 30 });
    expect(result.repairs).toBe(1);
  });

  it("sets json:true on every request", async () => {
    const llm = new FakeLlmProvider([{ name: "Taro", age: 30 }]);
    await completeJson(llm, { system: "s", user: "u", json: false }, schema);
    expect(llm.requests[0]!.json).toBe(true);
  });
});
