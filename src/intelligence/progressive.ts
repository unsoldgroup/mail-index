import type { AggregationMessageRow, Repo } from '../index/repo.js';
import type { BatchStatement } from '../index/driver.js';
import { computeAggregates } from './aggregate.js';
import { registrableDomain } from './domain.js';
import { featuresFromRow, scoreContact } from './interest.js';

type Member = { bucket: string; address: string };
type Dirty = { bucket: string; revision: string };

async function write(repo: Repo, statements: BatchStatement[]) {
  for (let i = 0; i < statements.length; i += 50) await repo.driver.batch(statements.slice(i, i + 50));
}

const memberKey = (m: Member) => JSON.stringify([m.bucket, m.address]);

function aggregateChanges(rows: AggregationMessageRow[], own: string[]) {
  const members = new Map<string, Member>();
  const register = (row: AggregationMessageRow, address: string) => {
    const bucket = row.thread_id ? 't' + row.thread_id : 'm' + row.gmail_message_id;
    const member = { bucket, address };
    members.set(memberKey(member), member);
  };
  const aggregates = computeAggregates(rows, own, register);
  // The score engine also recognizes angle-bracket aliases in bulk headers.
  for (const m of rows) {
    if (
      m.direction !== 'received' ||
      !(m.is_list || m.category === 'promotions' || m.category === 'social')
    )
      continue;
    for (const match of m.from_addr?.toLowerCase().matchAll(/<([^<>]*)>/g) ?? []) register(m, match[1]!);
  }
  return { aggregates, members };
}

/** Drain message changes under the account sync lock. Membership is widened
 * before derived writes, then pruned after scoring. A failure at any boundary
 * leaves both old and intermediate owners discoverable on retry. */
export async function refreshDerived(
  repo: Repo,
  account: string,
  own: string[],
  onInterest: () => Promise<void>,
  now = new Date(),
) {
  const db = repo.driver;
  await db.prepare('INSERT INTO derived_state(account) VALUES (?) ON CONFLICT DO NOTHING').run(account);
  const state = (await db
    .prepare('SELECT own,score_day FROM derived_state WHERE account=?')
    .get(account)) as { own: string | null; score_day: string | null };
  const identity = JSON.stringify(own.map((a) => a.toLowerCase()).sort());
  const bootstrap = state.own !== identity;
  const dirty = (await db
    .prepare('SELECT bucket,revision FROM derived_dirty WHERE account=?')
    .all(account)) as Dirty[];
  const buckets = dirty.map((d) => d.bucket);
  const day = now.toISOString().slice(0, 10);
  const daily = state.score_day !== day;
  if (!bootstrap && !daily && !dirty.length) {
    await onInterest();
    return;
  }

  const changed =
    bootstrap || dirty.length
      ? await repo.messagesForAggregation(account, bootstrap ? undefined : buckets)
      : [];
  const { aggregates, members } = aggregateChanges(changed, own);
  const previous = (await db
    .prepare(
      `SELECT bucket,address FROM derived_members WHERE account=?
    ${bootstrap ? '' : 'AND bucket IN (SELECT value FROM json_each(?))'}`,
    )
    .all(account, ...(bootstrap ? [] : [JSON.stringify(buckets)]))) as Member[];
  const oldKeys = new Set(previous.map(memberKey));
  const added = [...members.values()].filter((m) => !oldKeys.has(memberKey(m)));
  for (let i = 0; i < added.length; i += 200) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO derived_members(account,bucket,address)
      SELECT ?,json_extract(value,'$.bucket'),json_extract(value,'$.address') FROM json_each(?)`,
      )
      .run(account, JSON.stringify(added.slice(i, i + 200)));
  }
  const addresses = [...new Set([...members.values(), ...previous].map((m) => m.address))];
  let related = changed;
  if (bootstrap) {
    await repo.replaceAggregates(account, aggregates);
  } else if (dirty.length) {
    const other = (await db
      .prepare(
        `SELECT DISTINCT bucket FROM derived_members WHERE account=?
      AND address IN (SELECT value FROM json_each(?)) AND bucket NOT IN (SELECT value FROM json_each(?))`,
      )
      .all(account, JSON.stringify(addresses), JSON.stringify(buckets))) as { bucket: string }[];
    if (other.length)
      related = await repo.messagesForAggregation(account, [...buckets, ...other.map((o) => o.bucket)]);
    const affected = new Set(addresses);
    const contacts = (other.length ? computeAggregates(related, own) : aggregates).contacts.filter((c) =>
      affected.has(c.address),
    );
    const threads = aggregates.threads;
    await repo.replaceAggregates(
      account,
      { contacts, threads, domains: [] },
      {
        contacts: addresses,
        threads: buckets.filter((b) => b.startsWith('t')).map((b) => b.slice(1)),
        domains: [],
      },
    );
    const domains = [
      ...new Set(addresses.filter((a) => a.includes('@')).map((a) => a.slice(a.lastIndexOf('@') + 1))),
    ];
    const totals = (await db
      .prepare(
        `SELECT domain,sum(msgs_sent+msgs_received) AS msgs,count(*) AS distinctContacts
      FROM contacts WHERE account=? AND domain IN (SELECT value FROM json_each(?)) GROUP BY domain`,
      )
      .all(account, JSON.stringify(domains))) as {
      domain: string;
      msgs: number;
      distinctContacts: number;
    }[];
    await repo.replaceAggregates(
      account,
      {
        contacts: [],
        threads: [],
        domains: totals.map((d) => ({ ...d, registrableDomain: registrableDomain(d.domain) })),
      },
      { contacts: [], threads: [], domains },
    );
  }

  await onInterest();
  await refreshScores(repo, account, now, daily || bootstrap ? undefined : { addresses, related });
  await write(
    repo,
    previous
      .filter((m) => !members.has(memberKey(m)))
      .map((m) => ({
        sql: 'DELETE FROM derived_members WHERE account=? AND bucket=? AND address=?',
        params: [account, m.bucket, m.address],
      })),
  );
  await write(
    repo,
    dirty.map((d) => ({
      sql: 'DELETE FROM derived_dirty WHERE account=? AND bucket=? AND revision=?',
      params: [account, d.bucket, d.revision],
    })),
  );
  if (bootstrap || daily)
    await db
      .prepare('UPDATE derived_state SET own=?,score_day=? WHERE account=?')
      .run(identity, day, account);
}

async function refreshScores(
  repo: Repo,
  account: string,
  now: Date,
  scope?: {
    addresses: string[];
    related: AggregationMessageRow[];
  },
) {
  const scoring = await repo.contactScoringRows(account, scope?.addresses, scope?.related);
  // Compare the previous observation at its own clock time so an unrelated
  // change within the day cannot manufacture recency-only history. Refresh
  // time decay on the first sync of every UTC day, including empty sweeps.
  const snapshots = (await repo.driver
    .prepare(
      `SELECT c.address,c.engagement_score AS current_score,s.taken_at,s.engagement_score,
      s.msgs_received,s.read_count,s.replied_count,s.msgs_sent,s.last_seen FROM contacts c LEFT JOIN contact_stats_snapshot s
      ON s.rowid=(SELECT rowid FROM contact_stats_snapshot h WHERE h.account=c.account AND h.address=c.address
        ORDER BY h.taken_at DESC LIMIT 1) WHERE c.account=?
      ${scope ? 'AND c.address IN (SELECT value FROM json_each(?))' : ''}`,
    )
    .all(account, ...(scope ? [JSON.stringify(scope.addresses)] : []))) as {
    address: string;
    current_score: number | null;
    taken_at: string | null;
    engagement_score: number | null;
    msgs_received: number;
    msgs_sent: number | null;
    last_seen: string | null;
    read_count: number;
    replied_count: number;
  }[];
  const last = new Map(snapshots.map((s) => [s.address, s]));
  const day = now.toISOString().slice(0, 10);
  const scored = scoring.flatMap((row) => {
    const s = last.get(row.address);
    const time = s?.taken_at && s.taken_at.startsWith(day) ? Date.parse(s.taken_at) : now.getTime();
    if (
      s?.taken_at &&
      s.current_score === s.engagement_score &&
      s.last_seen === row.last_seen &&
      s.msgs_sent === row.msgs_sent &&
      s.engagement_score === scoreContact(featuresFromRow(row, time)) &&
      s.msgs_received === row.msgs_received &&
      s.read_count === row.read_count &&
      s.replied_count === row.replied_count
    )
      return [];
    return [
      { address: row.address, engagementScore: scoreContact(featuresFromRow(row, now.getTime())) },
    ];
  });
  await repo.persistEngagementScores(account, scored, now.toISOString());
}
