import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import type { StorageDriver } from '../index/driver.js';
import { getUserVersion } from '../index/migrations.js';
import { SCHEMA_VERSION } from '../index/schema.js';

export const EXPORT_TABLES = ['messages', 'contacts', 'domains', 'threads', 'interest_profile', 'labels', 'sync_runs'] as const;

export async function* exportIndex(driver: StorageDriver, account?: string): AsyncGenerator<string> {
  const version = await getUserVersion(driver);
  if (version !== SCHEMA_VERSION) throw new Error(`export requires schema version ${SCHEMA_VERSION}, found ${version}`);
  const accounts = await driver.prepare(`SELECT DISTINCT account FROM messages${account ? ' WHERE account=?' : ''} ORDER BY account`).all(...(account ? [account] : [])) as { account: string }[];
  yield JSON.stringify({ type: 'header', schema_version: version, exported_at: new Date().toISOString(), accounts: accounts.map((r) => r.account) });
  for (const table of EXPORT_TABLES) {
    const rows = await driver.prepare(`SELECT * FROM ${table}${account ? ' WHERE account=?' : ''}`).all(...(account ? [account] : [])) as Record<string, unknown>[];
    for (const row of rows) yield JSON.stringify({ type: table, row });
  }
}

export async function writeExport(driver: StorageDriver, out?: string, account?: string): Promise<void> {
  const stream = out ? createWriteStream(out, { encoding: 'utf8' }) : process.stdout;
  for await (const line of exportIndex(driver, account)) if (!stream.write(`${line}\n`)) await once(stream, 'drain');
  if (out) await new Promise<void>((resolve, reject) => { stream.end(resolve); stream.on('error', reject); });
}
