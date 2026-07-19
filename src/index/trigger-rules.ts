import { buildMatch } from './fts.js';
import type { Repo } from './repo.js';
import { CATEGORIES, CURATIONS } from './schema.js';

export type TriggerCondition =
  | { type: 'category'; value: string }
  | { type: 'is_list'; value: boolean }
  | { type: 'correspondent'; value: boolean }
  | { type: 'interest_profile'; value: string }
  | { type: 'label'; value: string }
  | { type: 'from_addr'; value: string }
  | { type: 'from_domain'; value: string }
  | { type: 'subject_fts'; terms: string[] };
export interface TriggerPredicate { conditions: TriggerCondition[] }
export interface TriggerMatch { id: string; account: string; from: string | null; subject: string | null; date: string | null; category: string | null; labels: string[] }

export function validateTriggerPredicate(value: unknown): TriggerPredicate {
  if (!value || typeof value !== 'object' || !Array.isArray((value as TriggerPredicate).conditions) || (value as TriggerPredicate).conditions.length === 0) throw new Error('Trigger rule predicate requires conditions');
  for (const condition of (value as TriggerPredicate).conditions) {
    if (!condition || typeof condition !== 'object') throw new Error('invalid Trigger rule condition');
    if (condition.type === 'category' && !(CATEGORIES as readonly string[]).includes(condition.value)) throw new Error(`invalid category: ${condition.value}`);
    else if (condition.type === 'interest_profile' && !(CURATIONS as readonly string[]).includes(condition.value)) throw new Error(`invalid Interest profile membership: ${condition.value}`);
    else if (condition.type === 'is_list') { if (typeof condition.value !== 'boolean') throw new Error('is_list must be boolean'); }
    else if (condition.type === 'correspondent') { if (typeof condition.value !== 'boolean') throw new Error('correspondent must be boolean'); }
    else if (condition.type === 'subject_fts') { if (!Array.isArray(condition.terms) || !buildMatch(condition.terms)) throw new Error('subject_fts requires terms'); }
    else if (['label', 'from_addr', 'from_domain'].includes(condition.type)) { if (typeof condition.value !== 'string' || !condition.value.trim()) throw new Error(`${condition.type} requires a value`); }
    else if (condition.type !== 'category' && condition.type !== 'interest_profile') throw new Error('unknown Trigger rule predicate');
  }
  return value as TriggerPredicate;
}

export async function evaluateTriggerRule(repo: Repo, account: string, messageIds: readonly string[], input: unknown): Promise<TriggerMatch[]> {
  const predicate = validateTriggerPredicate(input);
  if (!messageIds.length) return [];
  const placeholders = messageIds.map(() => '?').join(',');
  const rows = await repo.driver.prepare(`SELECT m.rowid,m.gmail_message_id,m.account,m.from_addr,m.subject,m.date_header,m.category,m.is_list,m.labels_json,c.msgs_sent,c.curation,d.curation domain_curation
    FROM messages m LEFT JOIN contacts c ON c.account=m.account AND lower(c.address)=lower(m.from_addr)
    LEFT JOIN domains d ON d.account=m.account AND d.domain=substr(m.from_addr,instr(m.from_addr,'@')+1)
    WHERE m.account=? AND m.gmail_message_id IN (${placeholders})`).all(account, ...messageIds) as Record<string, unknown>[];
  const fts = new Map<string, Set<number>>();
  for (const condition of predicate.conditions) if (condition.type === 'subject_fts') {
    const match = buildMatch(condition.terms);
    const hits = await repo.driver.prepare(`SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?`).all(match) as { rowid: number }[];
    fts.set(JSON.stringify(condition), new Set(hits.map((h) => h.rowid)));
  }
  return rows.filter((row) => predicate.conditions.every((condition) => {
    const labels = JSON.parse(String(row['labels_json'] ?? '[]')) as string[];
    switch (condition.type) {
      case 'category': return row['category'] === condition.value;
      case 'is_list': return Boolean(row['is_list']) === condition.value;
      case 'correspondent': return (Number(row['msgs_sent'] ?? 0) > 0) === condition.value;
      case 'interest_profile': return row['curation'] === condition.value || row['domain_curation'] === condition.value;
      case 'label': return labels.includes(condition.value);
      case 'from_addr': return String(row['from_addr'] ?? '').toLowerCase() === condition.value.toLowerCase();
      case 'from_domain': return String(row['from_addr'] ?? '').toLowerCase().endsWith(`@${condition.value.toLowerCase()}`);
      case 'subject_fts': return fts.get(JSON.stringify(condition))?.has(Number(row['rowid'])) ?? false;
    }
  })).map((row) => ({ id: String(row['gmail_message_id']), account: String(row['account']), from: row['from_addr'] as string | null, subject: row['subject'] as string | null, date: row['date_header'] as string | null, category: row['category'] as string | null, labels: JSON.parse(String(row['labels_json'] ?? '[]')) as string[] }));
}
