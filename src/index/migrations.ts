/**
 * Versioned, forward-only migrations (SCOPE 0.2, PLAN §6).
 *
 * Each migration has a monotonically increasing `version` and an `up(db)` that
 * runs its DDL. `runMigrations` applies every migration whose version exceeds
 * the database's current schema version, in order, then bumps that version.
 * The node:sqlite driver supplies an interactive transaction; D1 treats those
 * control statements as boundaries around its forward-only sequence.
 * Migrations are append-only: never
 * edit or reorder an existing one — add a new one.
 *
 * The FTS5 table is external-content over `messages` (PLAN §6): it stores no
 * copy of the columns itself; instead the repo layer keeps it in sync via
 * explicit INSERT/DELETE against the contentless index (we deliberately do NOT
 * use FTS5 content-sync triggers, so the repo controls exactly what the FTS
 * `body` column holds across the meta → full → summary-only ladder).
 */

import type { StorageDriver } from './driver.js';

import { FTS_TABLE_DDL, projectFtsRow } from './fts.js';

export interface Migration {
  version: number;
  name: string;
  up: (db: StorageDriver) => Promise<void>;
}

/** Migration 1 — full PLAN §6 data model. */
const m001_initial: Migration = {
  version: 1,
  name: 'initial schema',
  up: async (db) => {
    await db.exec(`
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
        PRIMARY KEY (account, gmail_message_id)
      );

      CREATE INDEX idx_messages_thread   ON messages (account, thread_id);
      CREATE INDEX idx_messages_internal ON messages (account, internal_date);
      CREATE INDEX idx_messages_from     ON messages (account, from_addr);
      CREATE INDEX idx_messages_state    ON messages (account, body_state);

      -- FTS5 search index over messages, keyed by messages.rowid. The repo
      -- writes the searchable text explicitly (DELETE+INSERT by rowid) so it
      -- controls exactly what the \`body\` column holds across the
      -- meta → full → summary-only ladder (PLAN §6) — which is why this is a
      -- self-contained FTS5 table rather than a contentless/external-content
      -- one (contentless FTS5 cannot delete a row by rowid alone, and \`body\`
      -- is a computed column that has no single source column to mirror).
      CREATE VIRTUAL TABLE messages_fts USING fts5(
        subject,
        sender,
        recipients,
        body
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
        account           TEXT    NOT NULL,
        domain            TEXT    NOT NULL,
        msgs              INTEGER NOT NULL DEFAULT 0,
        distinct_contacts INTEGER NOT NULL DEFAULT 0,
        engagement_score  REAL,
        curation          TEXT,
        category          TEXT,
        category_note     TEXT,
        categorized_at    TEXT,
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
    `);
  },
};

/**
 * Migration 2 — thread-level summary columns (M3.5, ADR-0003).
 *
 * `messages` already carries the summary ladder (`summary_text` /
 * `summary_is_model` / `summarized_at`, migration 1); threads did not. A
 * thread summary is the agent's paraphrase of a whole conversation (ADR-0003:
 * "thread preferred when a conversation is the meaningful unit"). It attaches
 * to the thread row, is provenance-marked, and never overwrites the thread's
 * source fields. Threads carry no FTS row of their own (the per-message FTS
 * index already covers conversation text), so this is a pure column add.
 */
const m002_thread_summary: Migration = {
  version: 2,
  name: 'thread summary columns',
  up: async (db) => {
    await db.exec(`
      ALTER TABLE threads ADD COLUMN summary_text     TEXT;
      ALTER TABLE threads ADD COLUMN summary_is_model INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE threads ADD COLUMN summarized_at    TEXT;
    `);
  },
};

/**
 * Migration 3 — per-account mailbox identity (adapter-switch safety).
 *
 * An account label is the durable index key — `messages` is keyed by
 * `(account, gmail_message_id)`, and Gmail message ids are identical whichever
 * CLI (`gws`, `gog`) fetched them. So a user can switch a label's transport
 * between adapters and the cached index stays fully valid: a re-sync only pulls
 * new mail (upsert is idempotent). The one footgun is pointing a label at a
 * *different mailbox* (e.g. authenticating the new adapter as another address),
 * which would silently mix two mailboxes' mail under one label.
 *
 * This table records the authenticated address the label is bound to (captured
 * on first sync). The sync identity probe then asserts the adapter still
 * resolves to that same address before reusing the index — the provider may
 * change freely, the mailbox identity may not. `provider` is informational
 * (which adapter last verified the binding).
 */
const m003_account_identity: Migration = {
  version: 3,
  name: 'account identity (adapter-switch safety)',
  up: async (db) => {
    await db.exec(`
      CREATE TABLE account_identity (
        account       TEXT NOT NULL,
        address       TEXT NOT NULL,
        provider      TEXT,
        first_seen    TEXT,
        last_verified TEXT,
        PRIMARY KEY (account)
      );
    `);
  },
};

/**
 * Migration 4 — OCR-candidate images (agent-OCR design).
 *
 * Marketing email increasingly puts the offer/price/deadline inside *images*,
 * so the distilled `body_text` is near-empty. mail-index never OCRs (that would
 * need a vision model + network); instead it deterministically picks which
 * images plausibly carry readable content (see `intelligence/images.ts`) and
 * stores those candidate URLs here, computed at enrich time. The MCP server then
 * hands them to the local agent — which has vision — to read. A pure column add;
 * `ocr_images_json` holds a compact JSON array (`[{src,width,height,alt,score,
 * reason}]`) or NULL when the body carries no content-bearing images.
 */
const m004_ocr_images: Migration = {
  version: 4,
  name: 'ocr candidate images',
  up: async (db) => {
    await db.exec(`ALTER TABLE messages ADD COLUMN ocr_images_json TEXT;`);
  },
};

/**
 * Migration 5 — rebuild `messages_fts` to the canonical self-contained schema.
 *
 * Pre-v1 prototype builds (the shell-to-`sqlite3` CLI) created a 7-column
 * `messages_fts` (`account, gmail_message_id, thread_id, subject, sender,
 * recipients, body`) and kept it in sync by `(account, gmail_message_id)` —
 * DELETE+re-INSERT on every upsert. That reassigns the FTS rowid each time, so
 * the FTS rowid drifts away from `messages.rowid`. v1's repo layer (ADR-0006)
 * uses a 4-column SELF-CONTAINED FTS keyed by `messages.rowid` (search JOINs
 * `f.rowid = m.rowid`). On a DB carrying the prototype's table, v1 search
 * silently returns the WRONG message for every drifted row.
 *
 * This migration unconditionally drops `messages_fts` and rebuilds it in the
 * canonical shape, repopulating every row from `messages` BY ROWID using the
 * exact body formula `Repo.#syncFts` applies: `body` = snippet + distilled body
 * (only when `body_state = 'full'`) + agent summary, newline-joined, empties
 * dropped; `recipients` = `to_addr` + `cc_addr`. Idempotent — on a DB already
 * in canonical shape it produces an equivalent index.
 */
const m005_rebuild_fts: Migration = {
  version: 5,
  name: 'rebuild messages_fts (canonical self-contained, rowid-aligned)',
  up: async (db) => {
    await db.exec(`
      DROP TABLE IF EXISTS messages_fts;

      CREATE VIRTUAL TABLE messages_fts USING fts5(
        subject,
        sender,
        recipients,
        body
      );

      INSERT INTO messages_fts(rowid, subject, sender, recipients, body)
      SELECT
        m.rowid,
        m.subject,
        m.from_addr,
        -- recipients = to + cc (filter(Boolean).join(' '))
        NULLIF(TRIM(COALESCE(m.to_addr, '') || ' ' || COALESCE(m.cc_addr, '')), ''),
        -- body = [snippet, body_text (full only), summary].filter(Boolean).join('\\n')
        NULLIF(
          TRIM(
            COALESCE(NULLIF(m.snippet, ''), '')
            || CASE
                 WHEN m.body_state = 'full' AND COALESCE(m.body_text, '') <> ''
                 THEN char(10) || m.body_text ELSE ''
               END
            || CASE
                 WHEN COALESCE(m.summary_text, '') <> ''
                 THEN char(10) || m.summary_text ELSE ''
               END
          ),
          ''
        )
      FROM messages m;
    `);
  },
};

/**
 * Migration 6 — registrable (eTLD+1) domain on the derived `domains` table.
 *
 * `domains.domain` is the raw sender host, so one brand fragments across its
 * bulk subdomains (`email.silversea.com`, `silversea.com`, …) — a poor key for
 * "how often does this operator email me". This adds a `registrable_domain`
 * column the aggregation pass fills (via `intelligence/domain.ts`
 * `registrableDomain`) so brand-level rollups (the `cadence` read, category
 * grouping) are deterministic. Pure column add; populated on the next
 * aggregation, which runs after every sync. Left NULL for existing rows here —
 * the `cadence` read falls back to computing the registrable domain on the fly
 * when the column is NULL, so it is useful before the next sync, and
 * aggregation backfills it durably thereafter.
 */
const m006_registrable_domain: Migration = {
  version: 6,
  name: 'registrable (eTLD+1) domain on domains',
  up: async (db) => {
    await db.exec(`ALTER TABLE domains ADD COLUMN registrable_domain TEXT;`);
  },
};

/**
 * Migration 7 — porter-stemmed FTS rebuild (FTS-tuning, PLAN; FTS contract).
 *
 * The FTS5 tokenizer is fixed at table-create time, so switching `messages_fts`
 * to the porter stemmer (so "refunds" matches "refund") is a full rebuild, not
 * an `ALTER`: drop the table, recreate it from the FTS contract's
 * {@link FTS_TABLE_DDL}, and repopulate every row via the SAME projection the
 * repo's live sync uses ({@link projectFtsRow}) — index-time and the rebuild can
 * never disagree on what got indexed. Runs last, so it supersedes the m005
 * canonical (default-tokenizer) rebuild with the porter-tokenized index.
 */
const m007_porter_fts: Migration = {
  version: 7,
  name: 'porter-stemmed FTS rebuild',
  up: async (db) => {
    await db.exec(`DROP TABLE messages_fts;`);
    await db.exec(FTS_TABLE_DDL);
    const rows = (await db
      .prepare(
        `SELECT rowid, subject, from_addr, to_addr, cc_addr, snippet, body_text, summary_text
           FROM messages`,
      )
      .all()) as {
      rowid: number;
      subject: string | null;
      from_addr: string | null;
      to_addr: string | null;
      cc_addr: string | null;
      snippet: string | null;
      body_text: string | null;
      summary_text: string | null;
    }[];
    const insert = db.prepare(
      `INSERT INTO messages_fts(rowid, subject, sender, recipients, body)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const r of rows) {
      const fts = projectFtsRow({
        subject: r.subject,
        fromAddr: r.from_addr,
        toAddr: r.to_addr,
        ccAddr: r.cc_addr,
        snippet: r.snippet,
        bodyText: r.body_text,
        summary: r.summary_text,
      });
      await insert.run(r.rowid, fts.subject, fts.sender, fts.recipients, fts.body);
    }
  },
};

/**
 * Migration 8 — topic-clustering tables (UNS-1249).
 *
 * Mirrored verbatim from the UNS-1249 topic-clustering branch so a DB that the
 * topic-clustering work has already migrated to v8 stays openable by the
 * mainline CLI/MCP (forward-only: code must know every version the DB has seen).
 * Pure additive DDL — `topics` holds a per-account cluster signature + the
 * agent-assigned name; `thread_topics` maps each thread to its cluster. Inert in
 * mainline until the clustering engine lands; it only makes the schema version
 * agree. Keep byte-identical to the UNS-1249 definition so the two converge with
 * no duplicate when that feature merges.
 */
const m008_topics: Migration = {
  version: 8,
  name: 'topic clustering tables',
  up: async (db) => {
    await db.exec(`
      CREATE TABLE topics (
        account     TEXT    NOT NULL,
        topic_id    INTEGER NOT NULL,
        keywords    TEXT,                -- JSON array: top TF-IDF terms (signature)
        label       TEXT,                -- agent-assigned name; NULL until named
        description TEXT,                -- agent-assigned; NULL until named
        named_at    TEXT,                -- stamp when the agent named it
        built_at    TEXT,                -- stamp of the clustering run
        PRIMARY KEY (account, topic_id)
      );

      CREATE TABLE thread_topics (
        account   TEXT    NOT NULL,
        thread_id TEXT    NOT NULL,
        topic_id  INTEGER NOT NULL,
        PRIMARY KEY (account, thread_id)
      );

      CREATE INDEX idx_thread_topics_topic ON thread_topics (account, topic_id);
    `);
  },
};

/**
 * m009 — the per-account Gmail label catalogue (id → human name).
 *
 * Messages carry opaque label *ids* (`Label_123…` for user labels; system
 * labels like `INBOX`/`STARRED` are self-named). The human name lives only in
 * the provider's labels resource. We cache that small, stable map locally —
 * refreshed each sync the way inbox membership is (reconcile-inbox.ts) — so
 * display can translate id→name and writes can translate name→id without a
 * per-call provider round-trip (zero-egress core: the fetch rides the same
 * adapter spawn seam as every other provider call). Pure additive DDL.
 */
const m009_labels: Migration = {
  version: 9,
  name: 'gmail label catalogue (id → name)',
  up: async (db) => {
    await db.exec(`
      CREATE TABLE labels (
        account    TEXT NOT NULL,
        label_id   TEXT NOT NULL,        -- Gmail label id (INBOX, Label_123…)
        name       TEXT NOT NULL,        -- human-readable name
        type       TEXT,                 -- 'system' | 'user'
        updated_at TEXT NOT NULL,
        PRIMARY KEY (account, label_id)
      );

      CREATE INDEX idx_labels_name ON labels (account, name);
    `);
  },
};

const m010_google_tokens: Migration = {
  version: 10,
  name: 'encrypted Google OAuth grants',
  up: async (db) => {
    await db.exec(`
      CREATE TABLE google_tokens (
        account TEXT PRIMARY KEY,
        address TEXT NOT NULL,
        scopes TEXT NOT NULL,
        refresh_token_ciphertext BLOB NOT NULL,
        iv BLOB NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  },
};

const m011_jobs: Migration = {
  version: 11,
  name: 'remote queued jobs',
  up: async (db) => {
    await db.exec(`
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        account TEXT NOT NULL,
        params_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued','running','done','failed')),
        progress_json TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );
      CREATE INDEX idx_jobs_status_created ON jobs(status, created_at);
      CREATE INDEX idx_jobs_account_created ON jobs(account, created_at);
    `);
  },
};

const m012_trigger_rules: Migration = {
  version: 12,
  name: 'Trigger rules and webhook consumers',
  up: async (db) => {
    await db.exec(`
      CREATE TABLE trigger_rules (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, account TEXT,
        predicate_json TEXT NOT NULL, consumer_ids_json TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE webhook_consumers (
        id TEXT PRIMARY KEY, url TEXT NOT NULL, secret TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX idx_trigger_rules_account_enabled ON trigger_rules(account, enabled);
    `);
  },
};

const m013_crm_change_feed: Migration = {
  version: 13,
  name: 'CRM deployment change feed',
  up: async (db) => {
    await db.exec(`
      CREATE TABLE crm_change_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        account TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_key TEXT NOT NULL,
        operation TEXT NOT NULL CHECK (operation IN ('upsert','tombstone')),
        reason TEXT,
        payload_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_crm_change_events_account_sequence
        ON crm_change_events(account, sequence);
    `);
  },
};

const m014_crm_event_deduplication: Migration = {
  version: 14,
  name: 'CRM event idempotency keys',
  up: async (db) => {
    await db.exec(`
      ALTER TABLE crm_change_events ADD COLUMN dedupe_key TEXT;
      CREATE UNIQUE INDEX idx_crm_change_events_dedupe_key
        ON crm_change_events(dedupe_key);
    `);
  },
};

const m015_rfc_message_identity: Migration = {
  version: 15,
  name: 'RFC Message-ID identity',
  up: async (db) => {
    await db.exec(`
      ALTER TABLE messages ADD COLUMN rfc_message_id TEXT;
      CREATE INDEX idx_messages_rfc_message_id ON messages(rfc_message_id);
    `);
  },
};

/** Migration 16 — repair a D1 database whose version marker advanced without the CRM feed table. */
const m016_crm_feed_repair: Migration = {
  version: 16,
  name: 'repair missing CRM deployment change feed',
  up: async (db) => {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS crm_change_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        account TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_key TEXT NOT NULL,
        operation TEXT NOT NULL CHECK (operation IN ('upsert','tombstone')),
        reason TEXT,
        payload_json TEXT,
        created_at TEXT NOT NULL,
        dedupe_key TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_crm_change_events_account_sequence
        ON crm_change_events(account, sequence);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_change_events_dedupe_key
        ON crm_change_events(dedupe_key);
    `);
  },
};

/**
 * Migration 17 — mark a queued Job's failure terminal.
 *
 * A Job reaped for holding a stale lock must never be retried by a late queue
 * delivery: the row is a corpse, and re-running it would reopen the lock the
 * reaper just released. `terminal=1` is that tombstone, checked by `runJob`
 * before any work starts.
 */
const m017_terminal_jobs: Migration = {
  version: 17,
  name: 'terminal queued Job failures',
  up: async (db) => {
    // ADD COLUMN has no IF NOT EXISTS in SQLite, and this migration sits at the
    // tail of the chain, where the repair preflight and concurrent first-request
    // convergence both replay it against a database that may already carry the
    // column. Probing first is what makes the replay a no-op instead of an error.
    const columns = (await db.prepare('PRAGMA table_info(jobs)').all()) as { name: string }[];
    if (columns.some((column) => column.name === 'terminal')) return;
    await db.exec(`
      ALTER TABLE jobs ADD COLUMN terminal INTEGER NOT NULL DEFAULT 0
        CHECK (terminal IN (0,1));
    `);
  },
};

/**
 * Migration 18 — per-account auth health on the grant row.
 *
 * A refresh token that Google answers with `invalid_grant` is dead, not slow:
 * every later sync fails identically until an operator re-consents. Without a
 * durable marker the Deployment retried such an Account hourly forever and no
 * reader could tell a stale index from a healthy one. `auth_error` is set ONLY
 * for that terminal state — transient 5xx/rate-limit failures must leave it
 * null, or one blip would disable a working mailbox.
 */
const m018_auth_health: Migration = {
  version: 18,
  name: 'per-account Google auth health',
  up: async (db) => {
    // Same replay-safety reasoning as migration 17: probe before ALTER.
    const columns = (await db.prepare('PRAGMA table_info(google_tokens)').all()) as { name: string }[];
    if (columns.some((column) => column.name === 'auth_error')) return;
    await db.exec(`
      ALTER TABLE google_tokens ADD COLUMN auth_error TEXT;
      ALTER TABLE google_tokens ADD COLUMN auth_failed_at TEXT;
    `);
  },
};

/**
 * Migration 19 — per-Account settings (the body-retention window).
 *
 * One JSON blob rather than a column per knob: these are operator preferences
 * read as a unit at the start of a Job, not queryable dimensions, so a new
 * setting should not cost a migration. Defaults live in code (see
 * `DEFAULT_ACCOUNT_SETTINGS`), so an absent row is a valid, fully-defaulted
 * Account — no backfill needed for mailboxes connected before this.
 */
const m019_account_settings: Migration = {
  version: 19,
  name: 'per-account settings',
  up: async (db) => {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS account_settings (
        account       TEXT PRIMARY KEY,
        settings_json TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );
    `);
  },
};

/** All migrations, in ascending version order. Append-only. */
export const MIGRATIONS: readonly Migration[] = [
  m001_initial,
  m002_thread_summary,
  m003_account_identity,
  m004_ocr_images,
  m005_rebuild_fts,
  m006_registrable_domain,
  m007_porter_fts,
  m008_topics,
  m009_labels,
  m010_google_tokens,
  m011_jobs,
  m012_trigger_rules,
  m013_crm_change_feed,
  m014_crm_event_deduplication,
  m015_rfc_message_identity,
  m016_crm_feed_repair,
  m017_terminal_jobs,
  m018_auth_health,
  m019_account_settings,
];

/**
 * Read the database's applied schema version. Drivers expose the engine's
 * durable version store through this SQLite-shaped query: node:sqlite uses the
 * native pragma; D1 maps it to its one-row `schema_version` shim.
 */
export async function getUserVersion(db: StorageDriver): Promise<number> {
  const row = (await db.prepare('PRAGMA user_version').get()) as
    | { user_version: number }
    | undefined;
  return row?.user_version ?? 0;
}

/**
 * Apply each pending migration atomically and publish its version in the same
 * commit. Forward-only: throws if the database version is newer than the code
 * knows about (a downgrade).
 */
export async function runMigrations(db: StorageDriver): Promise<void> {
  const current = await getUserVersion(db);
  const latest = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);

  if (current > latest) {
    throw new Error(
      `database schema version ${current} is newer than this build supports (${latest}); upgrade mail-index`,
    );
  }
  if (current === latest) return;

  // Some early D1 deployments advanced the version marker while the CRM feed
  // DDL was absent. Create that table before replaying the repair migration so
  // an out-of-band schema repair cannot fail on a later index statement.
  if (current === 13) {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS crm_change_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        account TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_key TEXT NOT NULL,
        operation TEXT NOT NULL CHECK (operation IN ('upsert','tombstone')),
        reason TEXT,
        payload_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_crm_change_events_account_sequence
        ON crm_change_events(account, sequence);
    `);
  } else if (current >= 14) {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS crm_change_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        account TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_key TEXT NOT NULL,
        operation TEXT NOT NULL CHECK (operation IN ('upsert','tombstone')),
        reason TEXT,
        payload_json TEXT,
        created_at TEXT NOT NULL,
        dedupe_key TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_crm_change_events_account_sequence
        ON crm_change_events(account, sequence);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_change_events_dedupe_key
        ON crm_change_events(dedupe_key);
    `);
  }

  const pending = MIGRATIONS.filter((m) => m.version > current).sort(
    (a, b) => a.version - b.version,
  );

  for (const migration of pending) {
    if (db.beginMigration) await db.beginMigration(); else await db.exec('BEGIN');
    try {
      await migration.up(db);
      // Publish each migration atomically with its DDL. This lets later
      // migrations read tables created by earlier commits and makes a failed
      // retry resume at the last complete version on both sqlite and D1.
      await db.exec(`PRAGMA user_version = ${migration.version}`);
      if (db.commitMigration) await db.commitMigration(); else await db.exec('COMMIT');
    } catch (err) {
      if (db.rollbackMigration) await db.rollbackMigration(); else await db.exec('ROLLBACK');
      throw err;
    }
  }
}
