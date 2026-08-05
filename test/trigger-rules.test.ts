import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from '../dist/index/db.js';
import { Repo } from '../dist/index/repo.js';
import { evaluateTriggerRule, validateTriggerPredicate } from '../dist/index/trigger-rules.js';

test('Trigger rule predicates cover Message, Correspondent, Interest profile, labels, sender, and FTS', async () => {
  const repo = new Repo(await openDb({ path: ':memory:' }));
  try {
    await repo.upsertMessage({ account: 'acct', gmailMessageId: 'old', fromAddr: 'old@example.com', subject: 'Budget', category: 'primary', isList: false, labels: ['INBOX'], bodyState: 'meta' });
    await repo.upsertMessage({ account: 'acct', gmailMessageId: 'new', fromAddr: 'person@example.com', subject: 'Polar expedition budget', category: 'primary', isList: false, labels: ['INBOX', 'IMPORTANT'], bodyState: 'meta' });
    await repo.driver.prepare(`INSERT INTO contacts(account,address,msgs_sent,curation) VALUES(?,?,?,?)`).run('acct', 'person@example.com', 2, 'important');
    const predicate = validateTriggerPredicate({ conditions: [
      { type: 'category', value: 'primary' }, { type: 'is_list', value: false },
      { type: 'correspondent', value: true }, { type: 'interest_profile', value: 'important' },
      { type: 'label', value: 'IMPORTANT' }, { type: 'from_addr', value: 'person@example.com' },
      { type: 'from_domain', value: 'example.com' }, { type: 'subject_fts', terms: ['expedition'] },
    ] });
    const matches = await evaluateTriggerRule(repo, 'acct', ['new'], predicate);
    assert.deepEqual(matches.map((m) => m.id), ['new']);
    assert.equal(matches.some((m) => m.id === 'old'), false, 'pre-existing Messages never re-fire');
    assert.throws(() => validateTriggerPredicate({ conditions: [{ type: 'category', value: 'spam' }] }), /category/);
  } finally { await repo.driver.close(); }
});
