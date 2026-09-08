import { afterEach, describe, expect, it, vi } from "vitest";
import { describeSlack, postToSlack, SlackError } from "../../src/slack.js";

function env(overrides: Partial<Cloudflare.Env> = {}): Cloudflare.Env {
  return overrides as Cloudflare.Env;
}

describe("describeSlack", () => {
  it("is unconfigured when either var is missing", () => {
    expect(describeSlack(env())).toEqual({ configured: false, channel: undefined });
    expect(describeSlack(env({ SALES_SLACK_BOT_TOKEN: "xoxb-1" }))).toEqual({
      configured: false, channel: undefined,
    });
    expect(describeSlack(env({ SALES_SLACK_CHANNEL: "#sales" }))).toEqual({
      configured: false, channel: "#sales",
    });
  });

  it("is configured when both the token and channel are set, and never reports the token", () => {
    const info = describeSlack(env({ SALES_SLACK_BOT_TOKEN: "xoxb-1", SALES_SLACK_CHANNEL: "#sales" }));
    expect(info).toEqual({ configured: true, channel: "#sales" });
    expect(JSON.stringify(info)).not.toContain("xoxb-1");
  });
});

describe("postToSlack", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws without calling fetch when Slack is not configured", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(postToSlack(env(), "hello")).rejects.toThrow(SlackError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("posts to chat.postMessage with the bot token and configured channel", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    await postToSlack(env({ SALES_SLACK_BOT_TOKEN: "xoxb-1", SALES_SLACK_CHANNEL: "#sales" }), "hello");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://slack.com/api/chat.postMessage");
    expect(init.headers.authorization).toBe("Bearer xoxb-1");
    expect(JSON.parse(init.body)).toEqual({ channel: "#sales", text: "hello" });
  });

  it("throws SlackError when Slack's API reports ok:false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, error: "channel_not_found" }), { status: 200 })),
    );
    await expect(
      postToSlack(env({ SALES_SLACK_BOT_TOKEN: "xoxb-1", SALES_SLACK_CHANNEL: "#nope" }), "hello"),
    ).rejects.toThrow(/channel_not_found/);
  });

  it("throws SlackError on a non-2xx HTTP status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 500 })));
    await expect(
      postToSlack(env({ SALES_SLACK_BOT_TOKEN: "xoxb-1", SALES_SLACK_CHANNEL: "#sales" }), "hello"),
    ).rejects.toThrow(SlackError);
  });
});
