import { afterEach, describe, expect, it, vi } from "vitest";
import { describeTranscription, transcribeAudio, TRANSCRIBE_MODEL_NAME, TranscribeError } from "../../src/transcribe.js";

function env(overrides: Partial<Cloudflare.Env> = {}): Cloudflare.Env {
  return overrides as Cloudflare.Env;
}

describe("describeTranscription", () => {
  it("is unconfigured with no vars", () => {
    expect(describeTranscription(env())).toEqual({ configured: false });
  });

  it("is configured from dedicated SALES_TRANSCRIBE_* vars regardless of SALES_AI_PROVIDER", () => {
    expect(describeTranscription(env({
      SALES_AI_PROVIDER: "ollama",
      SALES_TRANSCRIBE_ACCOUNT_ID: "acct-1", SALES_TRANSCRIBE_API_KEY: "key-1",
    }))).toEqual({ configured: true });
  });

  it("falls back to SALES_AI_ACCOUNT_ID/KEY only when SALES_AI_PROVIDER is workers-ai", () => {
    expect(describeTranscription(env({
      SALES_AI_PROVIDER: "workers-ai", SALES_AI_ACCOUNT_ID: "acct-2", SALES_AI_API_KEY: "key-2",
    }))).toEqual({ configured: true });
    expect(describeTranscription(env({
      SALES_AI_PROVIDER: "ollama", SALES_AI_ACCOUNT_ID: "acct-2", SALES_AI_API_KEY: "key-2",
    }))).toEqual({ configured: false });
  });
});

describe("transcribeAudio", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws without calling fetch when not configured", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(transcribeAudio(env(), new ArrayBuffer(0), "audio/webm")).rejects.toThrow(TranscribeError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("posts raw bytes to the Workers AI whisper run endpoint and returns the text", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, result: { text: "  ABC社の山田さんと話した  " } }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const audio = new ArrayBuffer(4);
    const result = await transcribeAudio(
      env({ SALES_TRANSCRIBE_ACCOUNT_ID: "acct-1", SALES_TRANSCRIBE_API_KEY: "key-1" }),
      audio, "audio/webm",
    );

    expect(result).toEqual({ text: "ABC社の山田さんと話した", modelName: TRANSCRIBE_MODEL_NAME });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/acct-1/ai/run/@cf/openai/whisper-large-v3-turbo");
    expect(init.headers.authorization).toBe("Bearer key-1");
    expect(init.headers["content-type"]).toBe("audio/webm");
    expect(init.body).toBe(audio);
  });

  it("throws TranscribeError when Workers AI reports success:false", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: false, errors: [{ message: "invalid audio" }] }), { status: 200 }),
    ));
    await expect(
      transcribeAudio(env({ SALES_TRANSCRIBE_ACCOUNT_ID: "a", SALES_TRANSCRIBE_API_KEY: "k" }), new ArrayBuffer(0), "audio/webm"),
    ).rejects.toThrow(/invalid audio/);
  });

  it("throws TranscribeError on a non-2xx HTTP status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 500 })));
    await expect(
      transcribeAudio(env({ SALES_TRANSCRIBE_ACCOUNT_ID: "a", SALES_TRANSCRIBE_API_KEY: "k" }), new ArrayBuffer(0), "audio/webm"),
    ).rejects.toThrow(TranscribeError);
  });

  it("throws TranscribeError when the response has no text", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, result: { text: "" } }), { status: 200 }),
    ));
    await expect(
      transcribeAudio(env({ SALES_TRANSCRIBE_ACCOUNT_ID: "a", SALES_TRANSCRIBE_API_KEY: "k" }), new ArrayBuffer(0), "audio/webm"),
    ).rejects.toThrow(TranscribeError);
  });
});
