/**
 * Schema migrations for the Sales Context Core (設計書 §11, §42).
 *
 * Plain SQLite DDL, valid on Durable Object SQLite and on D1. Migrations are append-only and
 * tracked in `schema_migrations`; never edit an applied migration — add a new one.
 */
import { splitStatements, type SqlExecutor } from "./sql.js";

export interface Migration {
  id: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    id: "0001_initial",
    sql: `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('SALES','MANAGER','ADMIN')),
  manager_user_id TEXT,
  timezone TEXT NOT NULL DEFAULT 'Asia/Tokyo',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE external_identities (
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (provider, external_id)
);

CREATE TABLE customer_accounts (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  normalized_name TEXT,
  primary_domain TEXT,
  external_provider TEXT,
  external_account_id TEXT,
  resolution_status TEXT NOT NULL CHECK (resolution_status IN ('RESOLVED','UNRESOLVED','MANUAL')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_customer_accounts_normalized ON customer_accounts(normalized_name);
CREATE INDEX idx_customer_accounts_domain ON customer_accounts(primary_domain);

CREATE TABLE customer_persons (
  id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES customer_accounts(id),
  display_name TEXT NOT NULL,
  normalized_name TEXT,
  email TEXT,
  phone TEXT,
  title TEXT,
  external_provider TEXT,
  external_person_id TEXT,
  resolution_status TEXT NOT NULL CHECK (resolution_status IN ('RESOLVED','UNRESOLVED','MANUAL')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_customer_persons_email ON customer_persons(email);
CREATE INDEX idx_customer_persons_account ON customer_persons(account_id);
CREATE INDEX idx_customer_persons_normalized ON customer_persons(normalized_name);

CREATE TABLE opportunities (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES customer_accounts(id),
  title TEXT NOT NULL,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  collaborator_user_ids TEXT NOT NULL DEFAULT '[]',
  lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('OPEN','WON','LOST','ON_HOLD','CLOSED')),
  operational_state TEXT NOT NULL CHECK (operational_state IN ('UNKNOWN','ACTIVE','WAITING_CUSTOMER','WAITING_INTERNAL','FOLLOWUP_REQUIRED','SCHEDULED','BLOCKED','CONTRACTING')),
  phase_label TEXT,
  expected_amount REAL,
  currency TEXT,
  expected_close_date TEXT,
  next_action_id TEXT,
  last_meaningful_activity_at TEXT,
  last_context_recomputed_at TEXT,
  risk_level TEXT NOT NULL DEFAULT 'NONE' CHECK (risk_level IN ('NONE','LOW','MEDIUM','HIGH')),
  risk_reason TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_opportunities_owner ON opportunities(owner_user_id);
CREATE INDEX idx_opportunities_account ON opportunities(account_id);
CREATE INDEX idx_opportunities_lifecycle ON opportunities(lifecycle_state);

CREATE TABLE source_documents (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  external_id TEXT,
  submitted_by_user_id TEXT REFERENCES users(id),
  r2_object_key TEXT,
  raw_text TEXT,
  content_hash TEXT NOT NULL UNIQUE,
  occurred_at TEXT,
  received_at TEXT NOT NULL,
  processing_status TEXT NOT NULL CHECK (processing_status IN ('RECEIVED','PROCESSING','PROCESSED','REVIEW_REQUIRED','FAILED','REVERTED')),
  processing_error TEXT,
  processed_at TEXT
);
CREATE INDEX idx_source_documents_status ON source_documents(processing_status);
CREATE INDEX idx_source_documents_submitter ON source_documents(submitted_by_user_id, received_at);

CREATE TABLE activities (
  id TEXT PRIMARY KEY,
  opportunity_id TEXT REFERENCES opportunities(id),
  account_id TEXT REFERENCES customer_accounts(id),
  person_ids TEXT NOT NULL DEFAULT '[]',
  actor_user_ids TEXT NOT NULL DEFAULT '[]',
  type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  source_id TEXT NOT NULL REFERENCES source_documents(id),
  summary TEXT NOT NULL,
  facts_json TEXT NOT NULL DEFAULT '[]',
  questions_json TEXT NOT NULL DEFAULT '[]',
  objections_json TEXT NOT NULL DEFAULT '[]',
  commitments_json TEXT NOT NULL DEFAULT '[]',
  decisions_json TEXT NOT NULL DEFAULT '[]',
  ai_confidence REAL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_activities_opportunity ON activities(opportunity_id, occurred_at);
CREATE INDEX idx_activities_source ON activities(source_id);

CREATE TABLE commitments (
  id TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL REFERENCES opportunities(id),
  side TEXT NOT NULL CHECK (side IN ('CUSTOMER','OUR_COMPANY')),
  owner_person_id TEXT,
  owner_user_id TEXT,
  description TEXT NOT NULL,
  due_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('OPEN','FULFILLED','OVERDUE','CANCELLED','UNKNOWN')),
  source_evidence_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_commitments_opportunity ON commitments(opportunity_id, status);

CREATE TABLE next_actions (
  id TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL REFERENCES opportunities(id),
  assigned_user_id TEXT NOT NULL REFERENCES users(id),
  action_type TEXT NOT NULL,
  title TEXT NOT NULL,
  purpose TEXT NOT NULL,
  due_at TEXT,
  recommended_at TEXT,
  priority TEXT NOT NULL CHECK (priority IN ('LOW','NORMAL','HIGH','URGENT')),
  status TEXT NOT NULL CHECK (status IN ('OPEN','DONE','SNOOZED','CANCELLED')),
  generated_by TEXT NOT NULL CHECK (generated_by IN ('AI','USER','SYSTEM')),
  source_decision_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_next_actions_assignee ON next_actions(assigned_user_id, status, due_at);
CREATE INDEX idx_next_actions_opportunity ON next_actions(opportunity_id, status);

CREATE TABLE calendar_event_mirrors (
  id TEXT PRIMARY KEY,
  google_calendar_id TEXT NOT NULL,
  google_event_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  attendees_json TEXT NOT NULL DEFAULT '[]',
  organizer_email TEXT,
  meeting_url TEXT,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  status TEXT NOT NULL,
  account_id TEXT,
  opportunity_id TEXT,
  resolution_confidence REAL,
  etag TEXT,
  last_synced_at TEXT NOT NULL,
  UNIQUE (google_calendar_id, google_event_id)
);
CREATE INDEX idx_calendar_owner_start ON calendar_event_mirrors(owner_user_id, start_at);

CREATE TABLE ai_context_snapshots (
  id TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL REFERENCES opportunities(id),
  current_situation TEXT NOT NULL,
  latest_development TEXT NOT NULL,
  customer_intent TEXT,
  decided_json TEXT NOT NULL DEFAULT '[]',
  unresolved_json TEXT NOT NULL DEFAULT '[]',
  risks_json TEXT NOT NULL DEFAULT '[]',
  commitments_json TEXT NOT NULL DEFAULT '[]',
  recommended_actions_json TEXT NOT NULL DEFAULT '[]',
  evidence_ids_json TEXT NOT NULL DEFAULT '[]',
  model_provider TEXT NOT NULL,
  model_name TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  confidence_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_snapshots_opportunity ON ai_context_snapshots(opportunity_id, created_at);

CREATE TABLE ai_decisions (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  decision_type TEXT NOT NULL,
  input_source_ids_json TEXT NOT NULL DEFAULT '[]',
  proposed_json TEXT NOT NULL,
  applied_json TEXT,
  confidence REAL NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('AUTO_APPLIED','REVIEW_REQUIRED','APPROVED','REJECTED','REVERTED')),
  reasoning_summary TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  model_name TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_ai_decisions_entity ON ai_decisions(entity_type, entity_id);

CREATE TABLE review_items (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  assigned_user_id TEXT,
  related_entity_type TEXT,
  related_entity_id TEXT,
  question TEXT NOT NULL,
  options_json TEXT,
  source_evidence_ids_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('OPEN','RESOLVED','DISMISSED')),
  resolution_json TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX idx_review_items_status ON review_items(status, assigned_user_id);

CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  source_ids_json TEXT,
  ai_decision_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_audit_logs_entity ON audit_logs(entity_type, entity_id, created_at);
CREATE INDEX idx_audit_logs_created ON audit_logs(created_at);

CREATE TABLE notification_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  notification_type TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  message_hash TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  status TEXT NOT NULL
);
CREATE INDEX idx_notification_logs_hash ON notification_logs(user_id, message_hash);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE source_applications (
  source_id TEXT PRIMARY KEY REFERENCES source_documents(id),
  opportunity_id TEXT,
  activity_id TEXT,
  created_commitment_ids TEXT NOT NULL DEFAULT '[]',
  created_next_action_ids TEXT NOT NULL DEFAULT '[]',
  created_review_ids TEXT NOT NULL DEFAULT '[]',
  created_account_id TEXT,
  created_person_ids TEXT NOT NULL DEFAULT '[]',
  created_opportunity INTEGER NOT NULL DEFAULT 0,
  snapshot_id TEXT,
  opportunity_before_json TEXT,
  decision_ids TEXT NOT NULL DEFAULT '[]',
  applied_at TEXT NOT NULL,
  reverted_at TEXT
);
`,
  },
  {
    id: "0002_opportunity_proposal_document_url",
    sql: `
ALTER TABLE opportunities ADD COLUMN proposal_document_url TEXT;
`,
  },
  {
    id: "0003_next_action_snoozed_until",
    sql: `
ALTER TABLE next_actions ADD COLUMN snoozed_until TEXT;
`,
  },
  {
    id: "0004_customer_account_contact_details",
    sql: `
ALTER TABLE customer_accounts ADD COLUMN address TEXT;
ALTER TABLE customer_accounts ADD COLUMN phone TEXT;
ALTER TABLE customer_accounts ADD COLUMN website_url TEXT;
`,
  },
  {
    id: "0005_opportunity_contact_person_ids",
    sql: `
ALTER TABLE opportunities ADD COLUMN contact_person_ids TEXT;
UPDATE opportunities SET contact_person_ids = (
  SELECT json_group_array(person_id) FROM (
    SELECT DISTINCT je.value AS person_id
    FROM activities a, json_each(a.person_ids) je
    WHERE a.opportunity_id = opportunities.id
      AND je.value IN (SELECT id FROM customer_persons WHERE account_id = opportunities.account_id)
  )
);
`,
  },
  {
    id: "0006_source_document_target_opportunity",
    sql: `
ALTER TABLE source_documents ADD COLUMN target_opportunity_id TEXT;
`,
  },
  {
    id: "0007_opportunity_close_details",
    sql: `
ALTER TABLE opportunities ADD COLUMN won_amount REAL;
ALTER TABLE opportunities ADD COLUMN closed_at TEXT;
ALTER TABLE opportunities ADD COLUMN lost_reason TEXT;
ALTER TABLE opportunities ADD COLUMN lost_reason_note TEXT;
ALTER TABLE opportunities ADD COLUMN competitor TEXT;
CREATE INDEX idx_opportunities_closed_at ON opportunities(closed_at);
`,
  },
  {
    id: "0008_products",
    sql: `
CREATE TABLE products (
  id TEXT PRIMARY KEY,
  code TEXT,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'SERVICE' CHECK (category IN ('GOODS','SERVICE','MAINTENANCE','SUBSCRIPTION','OTHER')),
  unit_price REAL,
  cost REAL,
  tax_category TEXT NOT NULL DEFAULT 'STANDARD' CHECK (tax_category IN ('STANDARD','REDUCED','EXEMPT')),
  unit_label TEXT,
  description TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_products_active ON products(active, sort_order);
`,
  },
];

/** Applies every pending migration in order. Idempotent. */
export function migrate(db: SqlExecutor, migrations: Migration[] = MIGRATIONS): string[] {
  db.run(
    "CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const applied = new Set(
    db.all<{ id: string }>("SELECT id FROM schema_migrations").map(r => r.id),
  );
  const newlyApplied: string[] = [];
  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;
    db.transaction(() => {
      for (const statement of splitStatements(migration.sql)) db.run(statement);
      db.run(
        "INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)",
        migration.id, new Date().toISOString(),
      );
    });
    newlyApplied.push(migration.id);
  }
  return newlyApplied;
}
