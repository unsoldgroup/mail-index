-- mail-index worker: squashed schema (== core SCHEMA_VERSION 9 end state,
-- transcribed from src/index/migrations.ts m001..m009), plus worker_state.
-- D1 migrations run without BEGIN/COMMIT (D1 rejects explicit transactions);
-- wrangler's d1_migrations table is the version authority (no user_version).

CREATE TABLE messages (
  account             TEXT    NOT NULL,
  gmail_message_id    TEXT    NOT NULL,
  thread_id           TEXT,
  internal_date       INTEGER,
  date_header         TEXT,
  from_addr           TEXT,
  to_addr             TEXT,
  cc_addr             TEXT,
  subject             TEXT,
  labels_json         TEXT,
  category            TEXT,
  is_list             INTEGER NOT NULL DEFAULT 0,
  direction           TEXT    NOT NULL DEFAULT 'received',
  unread              INTEGER NOT NULL DEFAULT 0,
  starred             INTEGER NOT NULL DEFAULT 0,
  important           INTEGER NOT NULL DEFAULT 0,
  size_estimate       INTEGER,
  snippet             TEXT,
  body_state          TEXT    NOT NULL DEFAULT 'meta',
  body_text           TEXT,
  summary_text        TEXT,
  summary_is_model    INTEGER NOT NULL DEFAULT 0,
  summarized_at       TEXT,
  gmail_url           TEXT,
  indexed_at          TEXT,
  body_fetched_at     TEXT,
  ocr_images_json     TEXT,
  PRIMARY KEY (account, gmail_message_id)
);

CREATE INDEX idx_messages_thread   ON messages (account, thread_id);
CREATE INDEX idx_messages_internal ON messages (account, internal_date);
CREATE INDEX idx_messages_from     ON messages (account, from_addr);
CREATE INDEX idx_messages_state    ON messages (account, body_state);

-- Self-contained FTS5 index keyed by messages.rowid (ADR-0006), porter-stemmed.
-- MUST stay identical to FTS_TABLE_DDL in src/index/fts.ts.
CREATE VIRTUAL TABLE messages_fts USING fts5(
  subject,
  sender,
  recipients,
  body,
  tokenize = 'porter unicode61'
);

CREATE TABLE contacts (
  account           TEXT    NOT NULL,
  address           TEXT    NOT NULL,
  display_name      TEXT,
  domain            TEXT,
  person_id         INTEGER,
  msgs_received     INTEGER NOT NULL DEFAULT 0,
  msgs_sent         INTEGER NOT NULL DEFAULT 0,
  read_count        INTEGER NOT NULL DEFAULT 0,
  replied_count     INTEGER NOT NULL DEFAULT 0,
  initiated_count   INTEGER NOT NULL DEFAULT 0,
  starred_count     INTEGER NOT NULL DEFAULT 0,
  important_count   INTEGER NOT NULL DEFAULT 0,
  first_seen        TEXT,
  last_seen         TEXT,
  engagement_score  REAL,
  centrality        REAL,
  community_id      INTEGER,
  curation          TEXT,
  PRIMARY KEY (account, address)
);

CREATE INDEX idx_contacts_domain ON contacts (account, domain);
CREATE INDEX idx_contacts_score  ON contacts (account, engagement_score);

CREATE TABLE domains (
  account            TEXT    NOT NULL,
  domain             TEXT    NOT NULL,
  msgs               INTEGER NOT NULL DEFAULT 0,
  distinct_contacts  INTEGER NOT NULL DEFAULT 0,
  engagement_score   REAL,
  curation           TEXT,
  category           TEXT,
  category_note      TEXT,
  categorized_at     TEXT,
  registrable_domain TEXT,
  PRIMARY KEY (account, domain)
);

CREATE TABLE threads (
  account           TEXT    NOT NULL,
  thread_id         TEXT    NOT NULL,
  subject           TEXT,
  participants_json TEXT,
  msg_count         INTEGER NOT NULL DEFAULT 0,
  unread_count      INTEGER NOT NULL DEFAULT 0,
  user_participated INTEGER NOT NULL DEFAULT 0,
  first_at          TEXT,
  last_at           TEXT,
  summary_text      TEXT,
  summary_is_model  INTEGER NOT NULL DEFAULT 0,
  summarized_at     TEXT,
  PRIMARY KEY (account, thread_id)
);

CREATE TABLE interest_profile (
  account       TEXT NOT NULL,
  keywords_json TEXT,
  updated_at    TEXT,
  PRIMARY KEY (account)
);

CREATE TABLE contact_stats_snapshot (
  account          TEXT    NOT NULL,
  address          TEXT    NOT NULL,
  taken_at         TEXT    NOT NULL,
  msgs_received    INTEGER NOT NULL DEFAULT 0,
  read_count       INTEGER NOT NULL DEFAULT 0,
  replied_count    INTEGER NOT NULL DEFAULT 0,
  engagement_score REAL,
  PRIMARY KEY (account, address, taken_at)
);

CREATE TABLE sync_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  account     TEXT NOT NULL,
  phase       TEXT NOT NULL,
  selector    TEXT,
  started_at  TEXT,
  finished_at TEXT,
  fetched     INTEGER NOT NULL DEFAULT 0,
  indexed     INTEGER NOT NULL DEFAULT 0,
  error       TEXT
);

CREATE INDEX idx_sync_runs_account ON sync_runs (account, phase, started_at);

CREATE TABLE account_identity (
  account       TEXT NOT NULL,
  address       TEXT NOT NULL,
  provider      TEXT,
  first_seen    TEXT,
  last_verified TEXT,
  PRIMARY KEY (account)
);

CREATE TABLE topics (
  account     TEXT    NOT NULL,
  topic_id    INTEGER NOT NULL,
  keywords    TEXT,
  label       TEXT,
  description TEXT,
  named_at    TEXT,
  built_at    TEXT,
  PRIMARY KEY (account, topic_id)
);

CREATE TABLE thread_topics (
  account   TEXT    NOT NULL,
  thread_id TEXT    NOT NULL,
  topic_id  INTEGER NOT NULL,
  PRIMARY KEY (account, thread_id)
);

CREATE INDEX idx_thread_topics_topic ON thread_topics (account, topic_id);

CREATE TABLE labels (
  account    TEXT NOT NULL,
  label_id   TEXT NOT NULL,
  name       TEXT NOT NULL,
  type       TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account, label_id)
);

CREATE INDEX idx_labels_name ON labels (account, name);

-- Worker-only: sync cursors and small pipeline state (no filesystem in Workers).
CREATE TABLE worker_state (
  key   TEXT PRIMARY KEY,
  value TEXT
);
