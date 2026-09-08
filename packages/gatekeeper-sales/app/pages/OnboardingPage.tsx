import type { RpcStub } from "capnweb";
import { useState } from "react";
import type { RegisterIdentityInput, SalesManagementApi, UserDto } from "../../src/management-types";
import { errorMessage } from "../api";
import { ROLE_LABEL } from "../labels";

type Role = UserDto["role"];
const ROLES: Role[] = ["SALES", "MANAGER", "ADMIN"];

export default function OnboardingPage({
  api,
  isAdmin,
  firstUser,
  onRegistered,
}: {
  api: RpcStub<SalesManagementApi>;
  isAdmin: boolean;
  firstUser: boolean;
  onRegistered: () => void;
}) {
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [timezone, setTimezone] = useState("Asia/Tokyo");
  const [role, setRole] = useState<Role>("SALES");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async () => {
    if (!displayName.trim() || !email.trim() || submitting) return;
    setSubmitting(true);
    setError(undefined);
    const input: RegisterIdentityInput = {
      displayName: displayName.trim(),
      email: email.trim(),
      timezone: timezone.trim() || undefined,
      role: isAdmin ? role : undefined,
    };
    try {
      await api.register(input);
      onRegistered();
    } catch (caught) {
      setError(errorMessage(caught));
      setSubmitting(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center bg-kumo-base px-4">
      <div className="w-full max-w-sm rounded-xl border border-kumo-line bg-kumo-control p-6">
        <h1 className="text-lg font-semibold text-kumo-default">Sales OS へようこそ</h1>
        <p className="mt-1 text-sm text-kumo-subtle">はじめに、あなたの情報を登録してください。</p>
        {firstUser && (
          <p className="mt-3 rounded-lg bg-kumo-tint px-3 py-2 text-xs text-kumo-subtle">
            まだ誰も登録されていません。最初に登録した方が管理者（ADMIN）になります。
          </p>
        )}

        <div className="mt-4 space-y-3">
          <Field label="表示名">
            <input
              value={displayName}
              onChange={(event) => setDisplayName(event.currentTarget.value)}
              placeholder="山田 太郎"
              className="h-9 w-full rounded-lg border border-kumo-line bg-kumo-base px-3 text-sm text-kumo-default outline-none focus:border-kumo-ring focus:ring-1 focus:ring-kumo-ring/20"
            />
          </Field>
          <Field label="メールアドレス">
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.currentTarget.value)}
              placeholder="you@example.com"
              className="h-9 w-full rounded-lg border border-kumo-line bg-kumo-base px-3 text-sm text-kumo-default outline-none focus:border-kumo-ring focus:ring-1 focus:ring-kumo-ring/20"
            />
          </Field>
          <Field label="タイムゾーン">
            <input
              value={timezone}
              onChange={(event) => setTimezone(event.currentTarget.value)}
              placeholder="Asia/Tokyo"
              className="h-9 w-full rounded-lg border border-kumo-line bg-kumo-base px-3 text-sm text-kumo-default outline-none focus:border-kumo-ring focus:ring-1 focus:ring-kumo-ring/20"
            />
          </Field>
          {isAdmin && (
            <Field label="役割">
              <select
                value={role}
                onChange={(event) => setRole(event.currentTarget.value as Role)}
                className="h-9 w-full rounded-lg border border-kumo-line bg-kumo-base px-3 text-sm text-kumo-default outline-none focus:border-kumo-ring focus:ring-1 focus:ring-kumo-ring/20"
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>

        {error && <p className="mt-3 text-xs text-kumo-danger">{error}</p>}

        <button
          type="button"
          disabled={!displayName.trim() || !email.trim() || submitting}
          onClick={() => void submit()}
          className="press mt-4 w-full rounded-lg bg-kumo-brand px-4 py-2.5 text-sm font-medium text-white hover:bg-kumo-brand-hover disabled:opacity-50"
        >
          {submitting ? "登録中…" : "登録する"}
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-kumo-subtle">{label}</span>
      {children}
    </label>
  );
}
