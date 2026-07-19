import type { StorageDriver, SqlParam } from '../src/index/driver.js';
import { getUserVersion } from '../src/index/migrations.js';
import { Repo } from '../src/index/repo.js';
import { SCHEMA_VERSION, type BodyState } from '../src/index/schema.js';
const TABLES = new Set(['messages', 'contacts', 'domains', 'threads', 'interest_profile', 'labels', 'sync_runs']);
export interface ImportOptions { batchSize?: number; startLine?: number; maxBatches?: number }

export async function importSeed(driver: StorageDriver, ndjson: string, options: ImportOptions = {}) {
  const lines = ndjson.split(/\r?\n/).filter(Boolean); const header = JSON.parse(lines[0] ?? '{}') as { type?: string; schema_version?: number };
  const target = await getUserVersion(driver);
  if (header.type !== 'header') throw new Error('seed import requires a header line');
  if (header.schema_version !== target || target !== SCHEMA_VERSION) throw new Error(`seed schema version ${header.schema_version} does not match target ${target}`);
  const batchSize = options.batchSize ?? 500; const start = Math.max(1, options.startLine ?? 1); const repo = new Repo(driver); let batches = 0; let imported = 0; let nextLine = start;
  for (let offset = start; offset < lines.length; offset += batchSize) {
    if (options.maxBatches != null && batches >= options.maxBatches) break;
    const batch = lines.slice(offset, offset + batchSize).map((line) => JSON.parse(line) as { type: string; row: Record<string, unknown> });
    for (const envelope of batch) {
      if (!TABLES.has(envelope.type)) throw new Error(`seed table not allowed: ${envelope.type}`);
      if (envelope.type === 'messages') await importMessage(repo, envelope.row);
      else await upsertRow(driver, envelope.type, envelope.row);
      imported++;
    }
    batches++; nextLine = offset + batch.length;
  }
  await ensureWatermarks(driver);
  return { imported, batches, nextLine, complete: nextLine >= lines.length };
}

async function importMessage(repo: Repo, r: Record<string, unknown>) {
  await repo.upsertMessage({ account: String(r['account']), gmailMessageId: String(r['gmail_message_id']), threadId: nullable(r['thread_id']), internalDate: num(r['internal_date']), dateHeader: nullable(r['date_header']), fromAddr: nullable(r['from_addr']), toAddr: nullable(r['to_addr']), ccAddr: nullable(r['cc_addr']), subject: nullable(r['subject']), labels: r['labels_json'] ? JSON.parse(String(r['labels_json'])) as string[] : [], category: r['category'] as never, isList: Boolean(r['is_list']), direction: r['direction'] as never, unread: Boolean(r['unread']), starred: Boolean(r['starred']), important: Boolean(r['important']), sizeEstimate: num(r['size_estimate']), snippet: nullable(r['snippet']), bodyState: String(r['body_state']) as BodyState, bodyText: nullable(r['body_text']), gmailUrl: nullable(r['gmail_url']), ocrImagesJson: nullable(r['ocr_images_json']) });
  if (r['summary_text'] != null) await repo.saveMessageSummary({ account: String(r['account']), gmailMessageId: String(r['gmail_message_id']), text: String(r['summary_text']), isModel: Boolean(r['summary_is_model']), ...(r['summarized_at'] ? { at: String(r['summarized_at']) } : {}) });
}
async function upsertRow(driver: StorageDriver, table: string, row: Record<string, unknown>) {
  const columns = Object.keys(row); if (!columns.every((c) => /^[a-z_]+$/.test(c))) throw new Error('invalid seed column');
  await driver.prepare(`INSERT OR REPLACE INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`).run(...columns.map((c) => row[c] as SqlParam));
}
async function ensureWatermarks(driver: StorageDriver) {
  const rows = await driver.prepare(`SELECT account,max(internal_date) newest FROM messages GROUP BY account`).all() as { account: string; newest: number | null }[];
  for (const row of rows) {
    const exists = await driver.prepare(`SELECT 1 ok FROM sync_runs WHERE account=? AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1`).get(row.account);
    if (!exists && row.newest) { const at = new Date(row.newest).toISOString(); await driver.prepare(`INSERT INTO sync_runs(account,phase,selector,started_at,finished_at,fetched,indexed) VALUES(?,?,?,?,?,?,?)`).run(row.account, 'sync', 'seed import', at, at, 0, 0); }
  }
}
function nullable(v: unknown): string | null { return v == null ? null : String(v); }
function num(v: unknown): number | undefined { return v == null ? undefined : Number(v); }
