import type { StorageDriver } from '../src/index/driver.js';
import type { Repo } from '../src/index/repo.js';

export type CrmChangeOperation = 'upsert' | 'tombstone';

export interface CrmChangeInput {
  account: string;
  entityType: string;
  entityKey: string;
  operation: CrmChangeOperation;
  reason?: string;
  payload?: Record<string, unknown>;
  dedupeKey?: string;
}

export interface CrmChangeEvent extends CrmChangeInput {
  cursor: string;
  createdAt: string;
}

export interface CrmChangePage {
  events: CrmChangeEvent[];
  nextCursor: string;
  terminalCursor: string;
  hasMore: boolean;
}

function splitAddresses(value: string | null): string[] {
  if (!value) return [];
  return value.split(/,(?=[^,]*@)/).map((address) => address.trim()).filter(Boolean);
}

const CURSOR_PREFIX = 'crm_v1_';

function encodeCursor(sequence: number): string {
  return `${CURSOR_PREFIX}${Buffer.from(String(sequence)).toString('base64url')}`;
}

function decodeCursor(cursor?: string): number {
  if (!cursor) return 0;
  if (!cursor.startsWith(CURSOR_PREFIX)) throw new Error('invalid CRM cursor');
  const sequence = Number(Buffer.from(cursor.slice(CURSOR_PREFIX.length), 'base64url').toString());
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('invalid CRM cursor');
  return sequence;
}

/**
 * The index holds every authorized mailbox, but a CRM only receives the ones
 * its operator chose. CRM_ACCOUNTS is a comma-separated allowlist; unset means
 * every account publishes, which is the pre-allowlist behaviour.
 */
export function crmAccountAllowed(env: { CRM_ACCOUNTS?: string }, account: string): boolean {
  const allowed = (env.CRM_ACCOUNTS ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
  return allowed.length === 0 || allowed.includes(account);
}

export class CrmChangeFeed {
  constructor(private readonly driver: StorageDriver) {}

  async append(input: CrmChangeInput): Promise<string> {
    if (!input.account.trim() || !input.entityType.trim() || !input.entityKey.trim()) {
      throw new Error('account, entityType, and entityKey are required');
    }
    if (input.operation === 'tombstone' && !input.reason) {
      throw new Error('tombstone reason is required');
    }
    const createdAt = new Date().toISOString();
    const result = await this.driver.prepare(
      `INSERT OR IGNORE INTO crm_change_events(
         account,entity_type,entity_key,operation,reason,payload_json,dedupe_key,created_at
       ) VALUES(?,?,?,?,?,?,?,?)`,
    ).run(
      input.account,
      input.entityType,
      input.entityKey,
      input.operation,
      input.reason ?? null,
      input.payload ? JSON.stringify(input.payload) : null,
      input.dedupeKey ?? null,
      createdAt,
    );
    if (Number(result.changes) > 0) return encodeCursor(Number(result.lastInsertRowid));
    const existing = await this.driver.prepare(
      'SELECT sequence FROM crm_change_events WHERE dedupe_key=?',
    ).get(input.dedupeKey ?? '') as { sequence: number } | undefined;
    if (!existing) throw new Error('CRM event dedupe failed');
    return encodeCursor(existing.sequence);
  }

  async read(options: { after?: string; limit?: number; accounts?: readonly string[] } = {}): Promise<CrmChangePage> {
    const after = decodeCursor(options.after);
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    // Filtered in SQL, not after the fact: a page emptied by the filter would
    // leave the cursor where it was and stall the reader forever.
    const accounts = options.accounts ?? [];
    const scope = accounts.length > 0 ? ` AND account IN (${accounts.map(() => '?').join(',')})` : '';
    const terminal = await this.driver.prepare(
      `SELECT COALESCE(MAX(sequence),0) AS sequence FROM crm_change_events WHERE 1=1${scope}`,
    ).get(...accounts) as { sequence: number };
    const rows = await this.driver.prepare(
      `SELECT sequence,account,entity_type,entity_key,operation,reason,payload_json,created_at
         FROM crm_change_events
        WHERE sequence > ?${scope}
        ORDER BY sequence ASC
        LIMIT ?`,
    ).all(after, ...accounts, limit) as Array<Record<string, unknown>>;
    const events = rows.map((row): CrmChangeEvent => ({
      account: String(row['account']),
      entityType: String(row['entity_type']),
      entityKey: String(row['entity_key']),
      operation: String(row['operation']) as CrmChangeOperation,
      ...(row['reason'] == null ? {} : { reason: String(row['reason']) }),
      ...(row['payload_json'] == null
        ? {}
        : { payload: JSON.parse(String(row['payload_json'])) as Record<string, unknown> }),
      cursor: encodeCursor(Number(row['sequence'])),
      createdAt: String(row['created_at']),
    }));
    const nextCursor = events.at(-1)?.cursor ?? encodeCursor(after);
    const terminalCursor = encodeCursor(Number(terminal.sequence));
    return {
      events,
      nextCursor,
      terminalCursor,
      hasMore: decodeCursor(nextCursor) < Number(terminal.sequence),
    };
  }
}

export async function publishMessageChanges(
  feed: CrmChangeFeed,
  repo: Pick<Repo, 'getMessage'>,
  account: string,
  messageIds: readonly string[],
  // Accepted for call-site symmetry with the attachment publisher, but not
  // recorded: crm_change_events has no Job column, so there is nowhere to put it
  // without a migration. Underscored so it does not read as a dropped write.
  _jobId: string,
): Promise<string | undefined> {
  let cursor: string | undefined;
  for (const id of messageIds) {
    const row = await repo.getMessage(account, id);
    if (!row) continue;
    cursor = await feed.append({
      account,
      entityType: 'message',
      entityKey: id,
      operation: 'upsert',
      dedupeKey: `message:${account}:${id}:${row.body_fetched_at ?? ''}:${row.body_state}`,
      payload: {
        providerMessageKey: id,
        rfcMessageId: row.rfc_message_id,
        threadKey: row.thread_id,
        subject: row.subject,
        from: row.from_addr,
        to: splitAddresses(row.to_addr),
        cc: splitAddresses(row.cc_addr),
        occurredAt: row.internal_date,
        direction: row.direction,
        category: row.category,
        isBulk: row.is_list === 1,
        bodyMarkdown: row.body_text,
        extractedNewContent: row.body_text,
      },
    });
  }
  return cursor;
}
