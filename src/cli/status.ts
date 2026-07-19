/**
 * `mail-index status` (SCOPE 0.7, PLAN §13, ADR-0005).
 *
 * Reports the index's freshness and shape, per account: when each account was
 * last successfully synced (`index_as_of` — the latest finished `sync_runs`),
 * whether a sync is currently running (the in-flight lock row, ADR-0005), the
 * body-ladder breakdown (meta / full / summary-only counts), and message/contact
 * totals.
 *
 * `--json` emits a machine-readable object the tray/scheduler ladder + ADR-0005
 * freshness contract consume. The human form is a compact per-account block.
 *
 * Queries run directly against the live connection (`repo.db`): this is a
 * read-only reporting surface, distinct from the write invariants the Repo
 * methods guard, so it does not earn dedicated repo verbs.
 */

import { Repo } from '../index/repo.js';
import type { StorageDriver } from '../index/driver.js';
import { BODY_STATES, type BodyState } from '../index/schema.js';

/** Per-account body-ladder counts (CONTEXT.md "Body state"). */
export type BodyStateCounts = Record<BodyState, number>;

/** Per-account status snapshot. */
export interface AccountStatus {
  account: string;
  /** ISO timestamp of the latest successful sync, or null if never synced. */
  indexAsOf: string | null;
  /** True when a sync is currently in flight for this account (ADR-0005 lock). */
  syncing: boolean;
  /** Count of messages at each body state. */
  bodyStates: BodyStateCounts;
  /** Total messages indexed for this account. */
  messages: number;
  /** Total contacts known for this account. */
  contacts: number;
}

/** The whole status report (all accounts that appear anywhere in the index). */
export interface StatusReport {
  accounts: AccountStatus[];
  totals: {
    messages: number;
    contacts: number;
    /** Index-wide body-state breakdown. */
    bodyStates: BodyStateCounts;
  };
}

function emptyCounts(): BodyStateCounts {
  return { meta: 0, full: 0, 'summary-only': 0 };
}

/**
 * Discover every account label that appears in the index: the union of accounts
 * seen in `messages`, `contacts`, and `sync_runs`. An account that has only ever
 * had a (failed or in-flight) sync still shows up, which is what an operator
 * checking "did my sync start?" needs.
 */
async function discoverAccounts(db: StorageDriver): Promise<string[]> {
  const rows = (await db
    .prepare(
      `SELECT account FROM messages
       UNION SELECT account FROM contacts
       UNION SELECT account FROM sync_runs
       ORDER BY account`,
    )
    .all()) as { account: string }[];
  return rows.map((r) => r.account);
}

async function bodyStateCounts(db: StorageDriver, account?: string): Promise<BodyStateCounts> {
  const counts = emptyCounts();
  const rows = (await (
    account
      ? db
          .prepare(`SELECT body_state, count(*) c FROM messages WHERE account = ? GROUP BY body_state`)
          .all(account)
      : db.prepare(`SELECT body_state, count(*) c FROM messages GROUP BY body_state`).all()
  )) as { body_state: string; c: number }[];
  for (const row of rows) {
    if ((BODY_STATES as readonly string[]).includes(row.body_state)) {
      counts[row.body_state as BodyState] = row.c;
    }
  }
  return counts;
}

async function indexAsOf(db: StorageDriver, account: string): Promise<string | null> {
  const row = (await db
    .prepare(
      `SELECT finished_at FROM sync_runs
        WHERE account = ? AND finished_at IS NOT NULL AND error IS NULL
        ORDER BY finished_at DESC LIMIT 1`,
    )
    .get(account)) as { finished_at: string | null } | undefined;
  return row?.finished_at ?? null;
}

async function countContacts(db: StorageDriver, account?: string): Promise<number> {
  const row = (await (
    account
      ? db.prepare(`SELECT count(*) c FROM contacts WHERE account = ?`).get(account)
      : db.prepare(`SELECT count(*) c FROM contacts`).get()
  )) as { c: number };
  return row.c;
}

/** Build the full status report from the live index. */
export async function buildStatus(repo: Repo): Promise<StatusReport> {
  const db = repo.driver;
  const labels = await discoverAccounts(db);

  const accounts: AccountStatus[] = await Promise.all(labels.map(async (account) => ({
    account,
    indexAsOf: await indexAsOf(db, account),
    syncing: await repo.activeSyncRun(account) != null,
    bodyStates: await bodyStateCounts(db, account),
    messages: await repo.countMessages(account),
    contacts: await countContacts(db, account),
  })));

  return {
    accounts,
    totals: {
      messages: await repo.countMessages(),
      contacts: await countContacts(db),
      bodyStates: await bodyStateCounts(db),
    },
  };
}

/** Render the human-readable status block. */
export function formatStatus(report: StatusReport): string {
  const lines: string[] = [];
  if (report.accounts.length === 0) {
    lines.push('No accounts indexed yet. Run: mail-index sync --account <label>');
    return lines.join('\n') + '\n';
  }

  for (const a of report.accounts) {
    const freshness = a.indexAsOf ? a.indexAsOf : 'never synced';
    const running = a.syncing ? ' [sync running]' : '';
    lines.push(`${a.account}${running}`);
    lines.push(`  index_as_of: ${freshness}`);
    lines.push(
      `  bodies: meta ${a.bodyStates.meta}, full ${a.bodyStates.full}, ` +
        `summary-only ${a.bodyStates['summary-only']}`,
    );
    lines.push(`  messages: ${a.messages}, contacts: ${a.contacts}`);
  }

  lines.push('');
  lines.push(
    `Total: ${report.totals.messages} messages, ${report.totals.contacts} contacts ` +
      `(meta ${report.totals.bodyStates.meta}, full ${report.totals.bodyStates.full}, ` +
      `summary-only ${report.totals.bodyStates['summary-only']})`,
  );
  return lines.join('\n') + '\n';
}

/** Render the machine-readable JSON form (ADR-0005 freshness contract). */
export function formatStatusJson(report: StatusReport): string {
  return JSON.stringify(report, null, 2) + '\n';
}
