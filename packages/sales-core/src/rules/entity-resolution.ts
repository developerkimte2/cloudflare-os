/**
 * Deterministic customer resolution (設計書 §13). The LLM proposes candidates; only these rules
 * decide, and only the strongest signals decide automatically. Everything else goes to Review
 * (AC-003) while the activity is still recorded against an UNRESOLVED placeholder (設計書 §13.4).
 */
import type { CustomerAccount, CustomerPerson, ReviewOption } from "../domain/types.js";
import { domainOfEmail, normalizeEmail, normalizeName } from "../domain/util.js";
import type { Repository } from "../db/repository.js";
import type { Extraction } from "../ai/schema.js";
import type { SalesConfig } from "./config.js";

export type ResolutionMethod =
  | "EMAIL_EXACT"
  | "EXTERNAL_ID"
  | "PHONE_EXACT"
  | "DOMAIN_AND_NAME"
  | "COMPANY_AND_PERSON"
  | "COMPANY_ONLY"
  | "NONE";

export interface AccountResolution {
  /** Resolved account, or undefined when nothing could be decided. */
  account?: CustomerAccount;
  /** Resolved persons (subset of candidates that matched). */
  persons: CustomerPerson[];
  method: ResolutionMethod;
  confidence: number;
  /** True when a human must confirm (multiple candidates, weak signal, or nothing found). */
  needsReview: boolean;
  reason: string;
  /** Options to present in the review item (existing accounts + "new" + "none"). */
  candidates: CustomerAccount[];
  /** The name the source used for the company, if any (for creating a placeholder). */
  mentionedCompanyName?: string;
  /** Persons mentioned that did not match an existing record. */
  unmatchedPersons: Extraction["entities"]["person_candidates"];
  /**
   * account_candidates / person.company values dropped by looksLikeCompanyName (a meta-phrase like
   * "会社名は聞きそびれた", or a person's own name/honorific) — kept only for diagnostics.
   */
  rejectedNames: string[];
}

const NON_COMPANY_PUNCTUATION = /[。、！？!?]/;
const NON_COMPANY_PHRASE = /(不明|聞きそびれ|未定|わからない|分からない|未確認|なし|失念)/;
const NON_COMPANY_PREFIX = /^(会社名|社名|顧客名|お客様|先方)/;
const PERSON_HONORIFIC_SUFFIX = /(様|さん|殿)$/;

/**
 * True when `name` plausibly is a company name. False for the extractor's observed failure modes
 * (2026-09-14 batch test #4/#15/#16): a "company unknown" meta-phrase, or a person's own name (with
 * or without an honorific) echoed back as if it were the company — both otherwise sail straight
 * into account_candidates and can create or match a placeholder account under that literal string.
 */
export function looksLikeCompanyName(name: string, personNames: string[]): boolean {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 40) return false;
  if (NON_COMPANY_PUNCTUATION.test(trimmed)) return false;
  if (NON_COMPANY_PHRASE.test(trimmed)) return false;
  if (NON_COMPANY_PREFIX.test(trimmed)) return false;
  if (PERSON_HONORIFIC_SUFFIX.test(trimmed)) return false;
  const normalized = normalizeName(trimmed);
  return !personNames.some(p => normalizeName(p) === normalized);
}

/**
 * An UNRESOLVED account is itself an unconfirmed AI guess (設計書 §13.4) — often the placeholder's
 * own name is bogus (a hallucinated company name, or the AI echoing back a "company unknown"
 * phrase as if it were one, 2026-09-14 batch test #4/#15/#16). Matching a *new* mention against one
 * of these, however strong the signal (exact email, exact company+person name), must not silently
 * stack a second unverified guess on top of the first — it always asks a human to confirm.
 * Once a human has confirmed an account (RESOLVED/MANUAL), the strong-signal methods below trust it.
 */
function isConfirmed(account: CustomerAccount): boolean {
  return account.resolutionStatus !== "UNRESOLVED";
}

export function resolveEntities(
  repo: Repository,
  extraction: Extraction,
  config: SalesConfig,
): AccountResolution {
  const rawPersons = extraction.entities.person_candidates;
  const personNames = rawPersons.map(p => p.name);
  const rejectedNames: string[] = [];
  const accounts = extraction.entities.account_candidates.filter(a => {
    if (looksLikeCompanyName(a.name, personNames)) return true;
    rejectedNames.push(a.name);
    return false;
  });
  // A person's own `company` field goes through the same guard, so a bogus value can't leak into
  // mentionedCompanyName via that path either.
  const persons = rawPersons.map(p => {
    if (!p.company || looksLikeCompanyName(p.company, personNames)) return p;
    rejectedNames.push(p.company);
    return { ...p, company: null };
  });
  const mentionedCompanyName = accounts[0]?.name ?? persons.find(p => p.company)?.company ?? undefined;

  // 1. email exact match → person → account
  for (const p of persons) {
    if (!p.email) continue;
    const existing = repo.findPersonByEmail(normalizeEmail(p.email));
    if (existing?.accountId) {
      const account = repo.getAccount(existing.accountId);
      if (account) {
        const pending = !isConfirmed(account);
        return finish("EMAIL_EXACT", 1, account, [existing], pending,
          `メールアドレス ${existing.email} が既存の担当者に一致` +
          (pending ? "（この顧客はまだ未確定です。同じ相手か確認してください）" : ""));
      }
    }
  }

  // 4. domain + person name (domain from any candidate email or explicit account domain)
  const domains = new Set<string>();
  for (const p of persons) if (p.email) { const d = domainOfEmail(p.email); if (d) domains.add(d); }
  for (const a of accounts) if (a.domain) domains.add(a.domain.toLowerCase());
  for (const domain of domains) {
    const account = repo.findAccountByDomain(domain);
    if (!account) continue;
    const matched = matchPersons(repo, persons, account.id);
    if (matched.length > 0) {
      const pending = !isConfirmed(account);
      return finish("DOMAIN_AND_NAME", 0.99, account, matched, pending,
        `ドメイン ${domain} と担当者名が既存レコードに一致` +
        (pending ? "（この顧客はまだ未確定です。同じ相手か確認してください）" : ""));
    }
    return finish("DOMAIN_AND_NAME", 0.97, account, [], true,
      `ドメイン ${domain} は既存顧客に一致するが担当者は未登録`,
      [account]);
  }

  // 5. company name + person name (normalized exact)
  const exactAccounts = uniqueById(accounts.flatMap(a => repo.findAccountsByNormalizedName(a.name)));
  if (exactAccounts.length === 1) {
    const account = exactAccounts[0]!;
    const matched = matchPersons(repo, persons, account.id);
    if (matched.length > 0) {
      const pending = !isConfirmed(account);
      return finish("COMPANY_AND_PERSON", 0.99, account, matched, pending,
        "会社名と担当者名が既存レコードに完全一致" +
        (pending ? "（この顧客はまだ未確定です。同じ相手か確認してください）" : ""));
    }
    // 6. company only → design says review required.
    return finish("COMPANY_ONLY", 0.9, account, [], true,
      "会社名のみ一致 (担当者は未登録または不一致)", [account]);
  }
  if (exactAccounts.length > 1) {
    return finish("COMPANY_ONLY", 0.5, undefined, [], true,
      "同名の顧客が複数存在", exactAccounts);
  }

  // Fuzzy candidates for the review options only.
  const fuzzy = uniqueById(accounts.flatMap(a => repo.findAccountCandidates(a.name)));
  const strongest = accounts[0];
  if (fuzzy.length === 0) {
    // A person mentioned without a company (including one looksLikeCompanyName rejected, e.g. the
    // 会社名は聞きそびれた case) is still a real sales signal worth a human's "which customer?" —
    // only a genuinely empty mention (a lunch order, small talk) should sail through without one.
    const hasSignal = accounts.length > 0 || persons.length > 0;
    return finish("NONE", strongest ? strongest.confidence : 0, undefined, [], hasSignal,
      accounts.length > 0
        ? "既存顧客に該当なし (新規リードの可能性)"
        : persons.length > 0
          ? "担当者は分かるが顧客の会社が特定できない"
          : "本文に顧客名が含まれていない",
      []);
  }
  return finish("NONE", 0.5, undefined, [], true, "表記揺れの可能性がある候補が存在", fuzzy);

  function finish(
    method: ResolutionMethod, confidence: number, account: CustomerAccount | undefined,
    matched: CustomerPerson[], needsReview: boolean, reason: string,
    candidates: CustomerAccount[] = account ? [account] : [],
  ): AccountResolution {
    const resolved = account !== undefined && !needsReview && confidence >= config.entityAutoConfidence;
    const matchedIds = new Set(matched.map(m => normalizeName(m.displayName)));
    return {
      account: resolved ? account : undefined,
      persons: matched,
      method,
      confidence,
      // Nothing found and nothing mentioned is not a review case; a mention that matched nothing is.
      needsReview: !resolved && (needsReview || account !== undefined),
      reason,
      candidates,
      mentionedCompanyName,
      unmatchedPersons: persons.filter(p => !matchedIds.has(normalizeName(p.name))),
      rejectedNames,
    };
  }
}

function matchPersons(
  repo: Repository, candidates: Extraction["entities"]["person_candidates"], accountId: string,
): CustomerPerson[] {
  const matched: CustomerPerson[] = [];
  for (const c of candidates) {
    const byName = repo.findPersonsByName(c.name, accountId);
    if (byName.length === 1) matched.push(byName[0]!);
  }
  return uniqueById(matched);
}

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter(i => (seen.has(i.id) ? false : (seen.add(i.id), true)));
}

/** Review options for a CUSTOMER_AMBIGUOUS item. */
export function customerReviewOptions(
  resolution: AccountResolution, placeholderAccountId: string,
): ReviewOption[] {
  const options: ReviewOption[] = resolution.candidates
    .filter(c => c.id !== placeholderAccountId)
    .map(c => ({ id: `account:${c.id}`, label: c.displayName, value: { accountId: c.id } }));
  options.push({
    id: "new",
    label: `新規顧客として登録${resolution.mentionedCompanyName ? ` (${resolution.mentionedCompanyName})` : ""}`,
    value: { newAccount: true },
  });
  options.push({ id: "none", label: "どれでもない / 顧客に紐付けない", value: { none: true } });
  return options;
}
