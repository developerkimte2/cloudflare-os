import { defineConfig } from "vite-plus";
import { vitestTask } from "@gadgets/scripts/vitest-task";

/**
 * Vite+ settings for this package, mirroring gatekeeper-scheduler: the SPA's own build config lives
 * in `vite.app.config.ts`; Vite+ reads per-package settings only from `vite.config.*`.
 */
export default defineConfig({
  run: {
    tasks: {
      test: vitestTask(["vitest run", "vitest run -c vitest.node.config.ts", "vitest run -c vitest.app.config.ts"]),
      "clean:error-reporting-artifacts": {
        command: "gadgets-clean-error-reporting .",
        cache: false,
      },
      "build:app": {
        command: "node build-app.mjs",
        dependsOn: ["clean:error-reporting-artifacts"],
        input: [
          { auto: true },
          { pattern: "!**/dist-app/**", base: "workspace" },
          { pattern: "!**/src/generated/**", base: "workspace" },
          { pattern: "!**/.wrangler/**", base: "workspace" },
        ],
        output: ["dist-app/**", "src/generated/app.txt"],
        env: ["VITE_FRONTEND_ERROR_REPORTING"],
      },
      "build:app:dev": {
        command: "node build-app.mjs --dev",
        dependsOn: ["clean:error-reporting-artifacts"],
        input: [
          { auto: true },
          { pattern: "!**/dist-app/**", base: "workspace" },
          { pattern: "!**/src/generated/**", base: "workspace" },
          { pattern: "!**/.wrangler/**", base: "workspace" },
        ],
        output: ["src/generated/app.txt"],
        env: ["VITE_FRONTEND_ERROR_REPORTING"],
      },
    },
  },
});
