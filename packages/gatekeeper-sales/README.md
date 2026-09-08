# Sales OS (gatekeeper-sales)

Cloudflare OS adapter for the **AI Sales Operations OS** (設計書: `AI_Sales_Operations_OS_Design_v1.0.md`,
計画: `plans/sales-os-phase0.md`). The sales domain itself lives in `packages/sales-core`; this package
only bridges it into Cloudflare OS as an ambient gatekeeper plus a management app.

```
Workshop user ──(auto-provisioned account)──► SalesAccount
        │                                        │ singleton      ┌──────────────────────────┐
        │  chat / executeCode: env.SALES ────────┼───────────────►│ SalesGatekeeper (facet)   │
        │                                        │                │  SalesSessionImpl         │
        │  sidebar "Sales OS" ────────────────────┼─ startAppUi ──►│  reads = observations     │
        │                                        │                │  writes = approval actions│
        ▼                                        ▼                └────────────┬─────────────┘
   management SPA (app/) ── host.ui ──► SalesManagementApiImpl ─────────────────┤
                                                                                 ▼
                                                            SalesCoreDurableObject (1 per tenant)
                                                            SQLite via @gadgets/sales-core
```

## What the user sees

- **Sidebar → Sales OS**: 今日 (Today) / 案件 / 確認 / チーム / 設定. First open asks for name + email
  and binds the Workshop account to a Sales OS user (the first user of a tenant becomes ADMIN;
  Workshop admins may pick a role).
- **Agent binding `SALES`** in every workspace chat. `describeBinding('SALES')` returns
  `src/types.d.ts`; the agent calls it through `executeCode`. Reads are audited observations. Writes
  (`capture`, `updateNextAction`, `resolveReview`, …) are submitted to the Workshop approval queue
  with `awaitDecision`, and applied to the core only after approval. Users can opt in to auto-approve
  the action kinds `sales.capture`, `sales.edit`, `sales.review`, `sales.recompute` from the
  Connections UI; `sales.revert` always needs a click.

## Identity

`GatekeeperVendor.createAccount()` receives no user identity (Workshop design). The account id is
bound to a Sales OS user in `external_identities(provider = "cfos")` when the user registers from the
management app. Disconnecting the account only drops that binding; sales data belongs to the team.
Production deployments should later bind identities from Cloudflare Access emails instead
(計画書 §2 設計差分).

## Configuration

Vars (in `wrangler.jsonc`, override per deployment):

| Var | Meaning |
|---|---|
| `SALES_TENANT` | Name of the tenant DO. One tenant per deployment. |
| `SALES_AI_PROVIDER` | `anthropic` \| `workers-ai` \| `ollama` \| `openai-compat` |
| `SALES_AI_MODEL` | e.g. `claude-sonnet-5`, `@cf/openai/gpt-oss-120b`, `qwen3-coder:30b` |
| `SALES_AI_BASE_URL` | Optional. Anthropic root or AI Gateway URL; OpenAI-compatible root for the others. |
| `SALES_AI_ACCOUNT_ID` | Workers AI: Cloudflare account id (builds the `/ai/v1` base URL). |

Secret: `SALES_AI_API_KEY` (`wrangler secret put SALES_AI_API_KEY`; not needed for Ollama).

Local dev: create `packages/gatekeeper-sales/.dev.vars` (gitignored):

```
SALES_AI_PROVIDER=workers-ai
SALES_AI_MODEL=@cf/openai/gpt-oss-120b
SALES_AI_ACCOUNT_ID=<cloudflare account id>
SALES_AI_API_KEY=<api token with Workers AI>
```

or, fully offline with Ollama:

```
SALES_AI_PROVIDER=ollama
SALES_AI_MODEL=qwen3-coder:30b
SALES_AI_BASE_URL=http://localhost:11434/v1
```

Business thresholds (confidence gates, stalled days, phase labels) are not env vars: admins edit them in
Sales OS → 設定 and they live in the tenant's `settings` table (設計書 §46).

## Development

```sh
pnpm install
pnpm --filter @gadgets/sales-core test:run        # domain tests (node:sqlite)
pnpm --filter @gadgets/gatekeeper-sales test:run  # workerd DO test + app tests
pnpm exec vp run -F @gadgets/gatekeeper-sales build
pnpm run dev-server                               # or .\start-local.ps1 on Windows
```

`run-dev-server.ts` discovers the package from its `wrangler.jsonc`, binds it as `GATEKEEPER_SALES` and
routes `/gatekeeper/sales/*`; nothing in the Workshop needs editing. The management app is built from
`app/` into `src/generated/app.txt` (single-file HTML) by `build-app.mjs`, the same way as
gatekeeper-scheduler.

`src/types.txt` must be byte-identical to `src/types.d.ts` (a symlink upstream; a real file on Windows
checkouts) — `__tests__/types-copy.test.ts` enforces it.

## Not in Phase 0

Calendar / Gmail / Slack / voice integrations, Manager digests, R2 raw storage. See
`plans/sales-os-phase0.md` §4 and the design document's phase plan.
