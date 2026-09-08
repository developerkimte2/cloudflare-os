/**
 * Slack is a notification *outlet*, not a data store (設計書 §20). This is deliberately just the
 * foundation: a way to send one message. No triggers, no scheduling, no Notification Fatigue
 * dedup (設計書 §20.2) — those are Phase 1 (計画書 §2 "Slack"). Today the only caller is the
 * admin-only "テスト送信" button on the settings page.
 */

export interface SlackInfo {
  configured: boolean;
  /** The configured channel (id or #name), shown for troubleshooting; never the token. */
  channel?: string;
}

export class SlackError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "SlackError";
  }
}

export function describeSlack(env: Cloudflare.Env): SlackInfo {
  const token = env.SALES_SLACK_BOT_TOKEN?.trim();
  const channel = env.SALES_SLACK_CHANNEL?.trim();
  return { configured: !!(token && channel), channel: channel || undefined };
}

/** Posts `text` to the configured channel via `chat.postMessage`. Throws SlackError on failure. */
export async function postToSlack(env: Cloudflare.Env, text: string): Promise<void> {
  const token = env.SALES_SLACK_BOT_TOKEN?.trim();
  const channel = env.SALES_SLACK_CHANNEL?.trim();
  if (!token || !channel) {
    throw new SlackError("Slack is not configured: set SALES_SLACK_BOT_TOKEN and SALES_SLACK_CHANNEL");
  }
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ channel, text }),
  });
  let body: { ok?: boolean; error?: string };
  try {
    body = await res.json();
  } catch {
    throw new SlackError(`Slack chat.postMessage returned a non-JSON response (status ${res.status})`, res.status);
  }
  if (!res.ok || !body.ok) {
    throw new SlackError(`Slack chat.postMessage failed: ${body.error ?? res.status}`, res.status);
  }
}
