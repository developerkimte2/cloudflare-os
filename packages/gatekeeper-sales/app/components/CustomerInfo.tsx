import { useEffect, useState } from "react";
import type {
  AccountPatch,
  CustomerAccount,
  CustomerPerson,
  PersonInput,
  PersonPatch,
} from "../../src/management-types";

const INPUT_CLASS =
  "h-8 w-full rounded-md border border-kumo-line bg-kumo-base px-2 text-sm text-kumo-default placeholder:text-kumo-inactive";

/**
 * Company contact details and the customer-side contacts (担当者). Both belong to the customer, not
 * the opportunity, so an edit here shows on every opportunity for the same customer.
 * Each save callback resolves true on success; forms stay open on failure so nothing typed is lost.
 */
export function CustomerInfo({
  account,
  persons,
  onSaveAccount,
  onCreatePerson,
  onUpdatePerson,
}: {
  account: CustomerAccount;
  persons: CustomerPerson[];
  onSaveAccount: (patch: AccountPatch) => Promise<boolean>;
  onCreatePerson: (input: PersonInput) => Promise<boolean>;
  onUpdatePerson: (personId: string, patch: PersonPatch) => Promise<boolean>;
}) {
  const [adding, setAdding] = useState(false);

  return (
    <div className="space-y-3">
      <CompanyCard account={account} onSave={onSaveAccount} />

      <div className="rounded-xl border border-kumo-line bg-kumo-control p-4">
        <div className="mb-2 flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium text-kumo-default">担当者（顧客側）</h3>
          {!adding && (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="press rounded-md border border-kumo-line bg-kumo-base px-2 py-1 text-xs font-medium text-kumo-default hover:bg-kumo-tint"
            >
              ＋ 担当者を追加
            </button>
          )}
        </div>
        {persons.length === 0 && !adding && (
          <p className="text-sm text-kumo-subtle">まだ担当者が登録されていません。</p>
        )}
        <div className="divide-y divide-kumo-line">
          {persons.map((person) => (
            <PersonRow key={person.id} person={person} onSave={(patch) => onUpdatePerson(person.id, patch)} />
          ))}
        </div>
        {adding && (
          <PersonForm
            submitLabel="追加"
            onCancel={() => setAdding(false)}
            onSubmit={async (values) => {
              const ok = await onCreatePerson({
                displayName: values.displayName,
                title: values.title || undefined,
                email: values.email || undefined,
                phone: values.phone || undefined,
              });
              if (ok) setAdding(false);
            }}
          />
        )}
      </div>
    </div>
  );
}

function CompanyCard({
  account,
  onSave,
}: {
  account: CustomerAccount;
  onSave: (patch: AccountPatch) => Promise<boolean>;
}) {
  const [address, setAddress] = useState(account.address ?? "");
  const [phone, setPhone] = useState(account.phone ?? "");
  const [websiteUrl, setWebsiteUrl] = useState(account.websiteUrl ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setAddress(account.address ?? "");
    setPhone(account.phone ?? "");
    setWebsiteUrl(account.websiteUrl ?? "");
  }, [account]);

  const changed = (value: string, saved: string | undefined) => value.trim() !== (saved ?? "");
  const dirty =
    changed(address, account.address) || changed(phone, account.phone) || changed(websiteUrl, account.websiteUrl);

  const save = async () => {
    setSaving(true);
    await onSave({
      address: changed(address, account.address) ? address : undefined,
      phone: changed(phone, account.phone) ? phone : undefined,
      websiteUrl: changed(websiteUrl, account.websiteUrl) ? websiteUrl : undefined,
    });
    setSaving(false);
  };

  return (
    <div className="rounded-xl border border-kumo-line bg-kumo-control p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium text-kumo-default">会社情報: {account.displayName}</h3>
        <span className="text-[11px] text-kumo-inactive">この顧客のすべての案件で共通です</span>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Labeled label="住所" className="sm:col-span-2">
          <input
            value={address}
            onChange={(event) => setAddress(event.currentTarget.value)}
            placeholder="〒100-0001 東京都千代田区…"
            className={INPUT_CLASS}
          />
        </Labeled>
        <Labeled label="電話番号">
          <input
            type="tel"
            value={phone}
            onChange={(event) => setPhone(event.currentTarget.value)}
            placeholder="03-1234-5678"
            className={INPUT_CLASS}
          />
        </Labeled>
        <Labeled label="会社URL">
          <div className="flex items-center gap-2">
            <input
              type="url"
              value={websiteUrl}
              onChange={(event) => setWebsiteUrl(event.currentTarget.value)}
              placeholder="https://example.co.jp"
              className={INPUT_CLASS}
            />
            {account.websiteUrl && (
              <a
                href={account.websiteUrl}
                target="_blank"
                rel="noreferrer"
                className="shrink-0 text-xs text-kumo-link hover:underline"
              >
                開く
              </a>
            )}
          </div>
        </Labeled>
      </div>
      <div className="mt-3 flex justify-end">
        <button
          type="button"
          disabled={!dirty || saving}
          onClick={() => void save()}
          className="press rounded-lg bg-kumo-brand px-3.5 py-1.5 text-sm font-medium text-white hover:bg-kumo-brand-hover disabled:opacity-50"
        >
          {saving ? "保存中…" : "会社情報を保存"}
        </button>
      </div>
    </div>
  );
}

function PersonRow({ person, onSave }: { person: CustomerPerson; onSave: (patch: PersonPatch) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <PersonForm
        initial={person}
        submitLabel="保存"
        onCancel={() => setEditing(false)}
        onSubmit={async (values) => {
          const ok = await onSave({
            displayName: values.displayName,
            title: values.title || null,
            email: values.email || null,
            phone: values.phone || null,
          });
          if (ok) setEditing(false);
        }}
      />
    );
  }

  return (
    <div className="flex items-start gap-3 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-kumo-default">
          {person.displayName}
          {person.title && <span className="ml-2 text-xs text-kumo-subtle">{person.title}</span>}
        </p>
        <p className="mt-0.5 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-kumo-subtle">
          <span>電話: {person.phone ?? "—"}</span>
          <span className="break-all">メール: {person.email ?? "—"}</span>
        </p>
      </div>
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="press shrink-0 rounded-md border border-kumo-line bg-kumo-base px-2 py-1 text-xs font-medium text-kumo-default hover:bg-kumo-tint"
      >
        編集
      </button>
    </div>
  );
}

type PersonValues = { displayName: string; title: string; email: string; phone: string };

function PersonForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial?: CustomerPerson;
  submitLabel: string;
  onSubmit: (values: PersonValues) => Promise<void>;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<PersonValues>({
    displayName: initial?.displayName ?? "",
    title: initial?.title ?? "",
    email: initial?.email ?? "",
    phone: initial?.phone ?? "",
  });
  const [saving, setSaving] = useState(false);
  const set = (key: keyof PersonValues) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setValues((current) => ({ ...current, [key]: event.currentTarget.value }));

  const trimmed: PersonValues = {
    displayName: values.displayName.trim(),
    title: values.title.trim(),
    email: values.email.trim(),
    phone: values.phone.trim(),
  };

  // No <form>: the app runs in a sandboxed iframe without allow-forms, where submit is dropped.
  const submit = async () => {
    if (!trimmed.displayName) return;
    setSaving(true);
    await onSubmit(trimmed);
    setSaving(false);
  };

  return (
    <div className="my-2 rounded-lg border border-kumo-line bg-kumo-base p-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Labeled label="氏名（必須）">
          <input value={values.displayName} onChange={set("displayName")} placeholder="山田 太郎" className={INPUT_CLASS} />
        </Labeled>
        <Labeled label="役職・部署">
          <input value={values.title} onChange={set("title")} placeholder="情報システム部 部長" className={INPUT_CLASS} />
        </Labeled>
        <Labeled label="電話番号">
          <input type="tel" value={values.phone} onChange={set("phone")} placeholder="090-1234-5678" className={INPUT_CLASS} />
        </Labeled>
        <Labeled label="メールアドレス">
          <input
            type="email"
            value={values.email}
            onChange={set("email")}
            placeholder="taro.yamada@example.co.jp"
            className={INPUT_CLASS}
          />
        </Labeled>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="press rounded-lg border border-kumo-line px-3 py-1.5 text-sm text-kumo-default hover:bg-kumo-tint"
        >
          キャンセル
        </button>
        <button
          type="button"
          disabled={!trimmed.displayName || saving}
          onClick={() => void submit()}
          className="press rounded-lg bg-kumo-brand px-3.5 py-1.5 text-sm font-medium text-white hover:bg-kumo-brand-hover disabled:opacity-50"
        >
          {saving ? "保存中…" : submitLabel}
        </button>
      </div>
    </div>
  );
}

function Labeled({ label, className = "", children }: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1 block text-[11px] font-medium text-kumo-inactive">{label}</span>
      {children}
    </label>
  );
}
