import type { StorageDriver } from '../src/index/driver.js';
import { evaluateTriggerRule, validateTriggerPredicate, type TriggerMatch } from '../src/index/trigger-rules.js';
import { Repo } from '../src/index/repo.js';
import type { TriggerAdmin } from '../src/mcp/tools.js';
import type { Env } from './index.js';

export interface DeliveryParams { deliveryId: string; rule: { id: string; name: string }; consumerId: string; matches: TriggerMatch[] }

export function triggerAdmin(driver: StorageDriver): TriggerAdmin {
  return {
    async saveRule(input) {
      const id = String(input['id'] ?? crypto.randomUUID()); const name = String(input['name'] ?? '').trim();
      if (!name) throw new Error('Trigger rule name is required');
      const predicate = validateTriggerPredicate(input['predicate']); const consumers = input['consumer_ids'];
      if (!Array.isArray(consumers)) throw new Error('consumer_ids must be an array');
      const now = new Date().toISOString();
      await driver.prepare(`INSERT INTO trigger_rules(id,name,account,predicate_json,consumer_ids_json,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name,account=excluded.account,predicate_json=excluded.predicate_json,consumer_ids_json=excluded.consumer_ids_json,enabled=excluded.enabled,updated_at=excluded.updated_at`)
        .run(id, name, input['account'] == null ? null : String(input['account']), JSON.stringify(predicate), JSON.stringify(consumers.map(String)), input['enabled'] === false ? 0 : 1, now, now);
      return { id };
    },
    async listRules() { const rows = await driver.prepare('SELECT * FROM trigger_rules ORDER BY created_at').all() as Record<string, unknown>[]; return { rules: rows.map((r) => ({ ...r, predicate: JSON.parse(String(r['predicate_json'])), consumer_ids: JSON.parse(String(r['consumer_ids_json'])), enabled: Boolean(r['enabled']), predicate_json: undefined, consumer_ids_json: undefined })) }; },
    async deleteRule(id) { const result = await driver.prepare('DELETE FROM trigger_rules WHERE id=?').run(id); return { deleted: result.changes > 0 }; },
    async registerConsumer(input) { const id = String(input['id'] ?? crypto.randomUUID()); const url = new URL(String(input['url'])); if (url.protocol !== 'https:') throw new Error('webhook consumer URL must use HTTPS'); const secret = String(input['secret'] ?? ''); if (!secret) throw new Error('webhook consumer secret is required'); await driver.prepare('INSERT INTO webhook_consumers(id,url,secret,created_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET url=excluded.url,secret=excluded.secret').run(id, url.toString(), secret, new Date().toISOString()); return { id }; },
    async deleteConsumer(id) { const result = await driver.prepare('DELETE FROM webhook_consumers WHERE id=?').run(id); return { deleted: result.changes > 0 }; },
  };
}

export async function evaluateRules(env: Env, driver: StorageDriver, repo: Repo, account: string, messageIds: string[]): Promise<number> {
  const rules = await driver.prepare('SELECT id,name,predicate_json,consumer_ids_json FROM trigger_rules WHERE enabled=1 AND (account IS NULL OR account=?)').all(account) as { id: string; name: string; predicate_json: string; consumer_ids_json: string }[];
  let queued = 0;
  for (const rule of rules) {
    const matches = await evaluateTriggerRule(repo, account, messageIds, JSON.parse(rule.predicate_json)); if (!matches.length) continue;
    for (const consumerId of JSON.parse(rule.consumer_ids_json) as string[]) {
      const params: DeliveryParams = { deliveryId: crypto.randomUUID(), rule: { id: rule.id, name: rule.name }, consumerId, matches };
      const jobId = crypto.randomUUID(); const now = new Date().toISOString();
      await driver.prepare(`INSERT INTO jobs(id,kind,account,params_json,status,progress_json,created_at) VALUES(?,?,?,?,?,?,?)`).run(jobId, 'webhook_delivery', account, JSON.stringify(params), 'queued', '{}', now);
      try { await env.SYNC_QUEUE.send({ jobId, kind: 'webhook_delivery', account, params }); queued++; }
      catch (error) { await driver.prepare(`UPDATE jobs SET status='failed',error=?,finished_at=? WHERE id=?`).run('queue enqueue failed', new Date().toISOString(), jobId); throw error; }
    }
  }
  return queued;
}

export async function deliverWebhook(driver: StorageDriver, params: DeliveryParams, fetchImpl: typeof fetch): Promise<void> {
  const consumer = await driver.prepare('SELECT url,secret FROM webhook_consumers WHERE id=?').get(params.consumerId) as { url: string; secret: string } | undefined;
  if (!consumer) throw new Error(`Unknown webhook consumer ${params.consumerId}`);
  const deliveredAt = new Date().toISOString(); const body = JSON.stringify({ delivery_id: params.deliveryId, rule: params.rule, matches: params.matches, delivered_at: deliveredAt });
  const timestamp = String(Math.floor(Date.now() / 1000)); const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(consumer.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))).map((b) => b.toString(16).padStart(2, '0')).join('');
  const response = await fetchImpl(consumer.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mailindex-signature': `sha256=${signature}`, 'x-mailindex-timestamp': timestamp }, body });
  if (!response.ok) throw new Error(`webhook consumer returned ${response.status}`);
}
