import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./__tests__/worker.ts",
      miniflare: {
        compatibilityDate: "2026-09-04",
        compatibilityFlags: ["allow_irrevocable_stub_storage", "nodejs_als"],
        durableObjects: {
          SALES_CORE: { className: "SalesCoreDurableObject", useSQLite: true },
        },
        bindings: {
          SALES_TENANT: "test",
          SALES_AI_PROVIDER: "ollama",
          SALES_AI_MODEL: "test-model",
          SALES_AI_BASE_URL: "http://llm.test/v1",
          SALES_SLACK_BOT_TOKEN: "xoxb-test",
          SALES_SLACK_CHANNEL: "#sales-test",
        },
      },
    }),
  ],
  test: {
    include: ["__tests__/*.test.ts"],
    // Asserts the pool actually started, rather than trusting a green run to mean workerd.
    setupFiles: ["@gadgets/scripts/assert-workerd"],
    // A rejection thrown inside the Durable Object is also surfaced by the pool as an unhandled
    // error, independently of the awaited RPC call that the test asserts on. Only the exact
    // rejections the tests expect are tolerated; everything else stays fatal.
    onUnhandledError(error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("Sales OS にまだ登録されていません")) return false;
      if (message.includes("処理済みの取込は破棄できません")) return false;
      if (message.includes("Morning Brief の送信は管理者のみ実行できます")) return false;
    },
  },
});
