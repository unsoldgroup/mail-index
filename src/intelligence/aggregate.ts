/**
 * Contact / domain / thread aggregation (SCOPE 2.1, PLAN §6, D11, CONTEXT.md
 * "Correspondent").
 *
 * Rolls the indexed `messages` up into the three derived tables the
 * intelligence layer reads from: `contacts`, `domains`, `threads`. This is a
 * **derived, INDEX-ONLY** pass (PLAN §4: the intelligence engines read the
 * index, never the provider) — it takes message rows from the repo and writes
 * aggregates back through the repo, touching no `MailSource`.
 *
 * It is **idempotent + re-runnable**: {@link Repo.replaceAggregates} rebuilds
 * the derived rows from scratch each run (preserving user-owned columns like
 * `curation`), so running it after every sync converges to the same tables.
 *
 * The rollup rules (per account):
 *
 *  - **contacts** — one row per distinct address the user corresponds *with*.
 *    A `received` message credits its `from_addr` (msgs_received, and the
 *    read/starred/important snapshots, D12). A `sent` message credits every
 *    recipient on `to`/`cc` (msgs_sent → the contact becomes a CORRESPONDENT,
 *    the strongest human-vs-noise signal). `replied`/`initiated` are derived
 *    from sent mail relative to each contact's threads (see below). The user's
 *    own address is never a contact of itself.
 *
 *  - **domains** — rollup of contacts by email domain: total messages and the
 *    count of distinct contacts on that domain.
 *
 *  - **threads** — one row per `thread_id`: subject (from the newest message),
 *    participant addresses, message + unread counts, first/last activity, and
 *    `user_participated` (did the user send into this thread — needs the Sent
 *    index, D11).
 *
 * Replied vs initiated (PLAN §10): walking each contact's threads in time
 * order, a user-sent message that follows an earlier received message from the
 * contact in the same thread counts as a **reply** to that contact; a user-sent
 * message that is the first message in a thread (no earlier received message
 * from the contact) counts as the user having **initiated** with that contact.
 */

import type {
  AggregationMessageRow,
  ContactAggregate,
  DomainAggregate,
  Repo,
  ThreadAggregate,
} from '../index/repo.js';
import { extractAddress } from '../ingest/classify.js';
import { registrableDomain } from './domain.js';

/** The domain portion of a bare address (`a@b.com` → `b.com`), or null. */
function domainOf(address: string): string | null {
  const at = address.lastIndexOf('@');
  if (at < 0 || at === address.length - 1) return null;
  return address.slice(at + 1).toLowerCase();
}

/** Pull a display name out of a `Name <addr>` header value, or null. */
function displayNameOf(value: string | null | undefined): string | null {
  if (!value) return null;
  const angle = value.indexOf('<');
  if (angle <= 0) return null;
  const name = value.slice(0, angle).trim().replace(/^"|"$/g, '').trim();
  return name.length > 0 ? name : null;
}

/** Split a `To:`/`Cc:` header into individual recipient values (comma list). */
function splitRecipients(value: string | null | undefined): string[] {
  if (!value) return [];
  // Addresses never contain a top-level comma; display names might be quoted,
  // but the recorded shapes here are plain `Name <addr>, Name <addr>`. A simple
  // comma split is sufficient and dependency-free.
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Mutable accumulator for one contact while we fold over messages. */
interface ContactAcc {
  address: string;
  displayName: string | null;
  domain: string | null;
  msgsReceived: number;
  msgsSent: number;
  readCount: number;
  repliedCount: number;
  initiatedCount: number;
  starredCount: number;
  importantCount: number;
  firstSeen: string | null;
  lastSeen: string | null;
}

/** Mutable accumulator for one thread. */
interface ThreadAcc {
  threadId: string;
  subject: string | null;
  subjectAt: number;
  participants: Set<string>;
  msgCount: number;
  unreadCount: number;
  userParticipated: boolean;
  firstAt: number | null;
  lastAt: number | null;
  /** Addresses the user has *received* from in this thread, so far (time order). */
  receivedFrom: Set<string>;
  /** Whether any user-sent message has been seen in this thread, so far. */
  sawSent: boolean;
}

/** The aggregated result, ready to hand to {@link Repo.replaceAggregates}. */
export interface Aggregates {
  contacts: ContactAggregate[];
  domains: DomainAggregate[];
  threads: ThreadAggregate[];
}

/** A timestamp for first/last bookkeeping: ISO string from `internal_date`. */
function toIso(internalDate: number | null): string | null {
  return internalDate != null ? new Date(internalDate).toISOString() : null;
}

/**
 * Compute the contact / domain / thread aggregates for one account from its
 * message rows. Pure (no I/O); the rows must arrive oldest-first so the
 * reply/initiated time ordering and first/last bookkeeping are correct —
 * {@link Repo.messagesForAggregation} orders them that way.
 */
export function computeAggregates(
  rows: readonly AggregationMessageRow[],
  ownAddresses: readonly string[] = [],
): Aggregates {
  const own = new Set(ownAddresses.map((a) => a.toLowerCase()));
  const contacts = new Map<string, ContactAcc>();
  const threads = new Map<string, ThreadAcc>();

  const contactFor = (address: string, displayName: string | null): ContactAcc => {
    let acc = contacts.get(address);
    if (!acc) {
      acc = {
        address,
        displayName,
        domain: domainOf(address),
        msgsReceived: 0,
        msgsSent: 0,
        readCount: 0,
        repliedCount: 0,
        initiatedCount: 0,
        starredCount: 0,
        importantCount: 0,
        firstSeen: null,
        lastSeen: null,
      };
      contacts.set(address, acc);
    } else if (acc.displayName == null && displayName != null) {
      acc.displayName = displayName;
    }
    return acc;
  };

  const touchSeen = (acc: ContactAcc, iso: string | null): void => {
    if (iso == null) return;
    if (acc.firstSeen == null || iso < acc.firstSeen) acc.firstSeen = iso;
    if (acc.lastSeen == null || iso > acc.lastSeen) acc.lastSeen = iso;
  };

  const threadFor = (threadId: string): ThreadAcc => {
    let t = threads.get(threadId);
    if (!t) {
      t = {
        threadId,
        subject: null,
        subjectAt: -Infinity,
        participants: new Set(),
        msgCount: 0,
        unreadCount: 0,
        userParticipated: false,
        firstAt: null,
        lastAt: null,
        receivedFrom: new Set(),
        sawSent: false,
      };
      threads.set(threadId, t);
    }
    return t;
  };

  for (const row of rows) {
    const iso = toIso(row.internal_date);
    const order = row.internal_date ?? 0;

    // ---- thread bookkeeping (every message contributes) ----
    const thread = row.thread_id ? threadFor(row.thread_id) : null;
    if (thread) {
      thread.msgCount += 1;
      if (row.unread) thread.unreadCount += 1;
      if (row.internal_date != null) {
        if (thread.firstAt == null || row.internal_date < thread.firstAt) {
          thread.firstAt = row.internal_date;
        }
        if (thread.lastAt == null || row.internal_date > thread.lastAt) {
          thread.lastAt = row.internal_date;
        }
      }
      // Newest message's subject wins (threads drift subject over their life).
      if (row.subject != null && order >= thread.subjectAt) {
        thread.subject = row.subject;
        thread.subjectAt = order;
      }
    }

    if (row.direction === 'sent') {
      // The user sent this. Credit every recipient as a Correspondent and feed
      // the reply/initiated signal from the thread's prior state.
      if (thread) {
        thread.userParticipated = true;
        thread.sawSent = true;
      }
      const fromAddr = extractAddress(row.from_addr);
      if (fromAddr) thread?.participants.add(fromAddr);

      const recipients = [
        ...splitRecipients(row.to_addr),
        ...splitRecipients(row.cc_addr),
      ];
      for (const raw of recipients) {
        const addr = extractAddress(raw);
        if (!addr || own.has(addr)) continue;
        const acc = contactFor(addr, displayNameOf(raw));
        acc.msgsSent += 1;
        touchSeen(acc, iso);
        thread?.participants.add(addr);

        if (thread) {
          if (thread.receivedFrom.has(addr)) {
            // The user is replying: an earlier message from this contact exists
            // in the thread before this sent message.
            acc.repliedCount += 1;
          } else if (thread.msgCount === 1) {
            // First message in the thread is this user-sent one → the user
            // initiated contact with this recipient.
            acc.initiatedCount += 1;
          }
        }
      }
    } else {
      // Received: the sender is the contact.
      const addr = extractAddress(row.from_addr);
      if (addr && !own.has(addr)) {
        const acc = contactFor(addr, displayNameOf(row.from_addr));
        acc.msgsReceived += 1;
        if (!row.unread) acc.readCount += 1;
        if (row.starred) acc.starredCount += 1;
        if (row.important) acc.importantCount += 1;
        touchSeen(acc, iso);
        if (thread) {
          thread.participants.add(addr);
          thread.receivedFrom.add(addr);
        }
      }
    }
  }

  // ---- finalize contacts ----
  const contactList: ContactAggregate[] = [...contacts.values()].map((c) => ({
    address: c.address,
    displayName: c.displayName,
    domain: c.domain,
    msgsReceived: c.msgsReceived,
    msgsSent: c.msgsSent,
    readCount: c.readCount,
    repliedCount: c.repliedCount,
    initiatedCount: c.initiatedCount,
    starredCount: c.starredCount,
    importantCount: c.importantCount,
    firstSeen: c.firstSeen,
    lastSeen: c.lastSeen,
  }));

  // ---- roll contacts up into domains ----
  const domainAcc = new Map<string, { msgs: number; contacts: number }>();
  for (const c of contactList) {
    if (!c.domain) continue;
    const d = domainAcc.get(c.domain) ?? { msgs: 0, contacts: 0 };
    d.msgs += c.msgsReceived + c.msgsSent;
    d.contacts += 1;
    domainAcc.set(c.domain, d);
  }
  const domainList: DomainAggregate[] = [...domainAcc.entries()].map(([domain, d]) => ({
    domain,
    msgs: d.msgs,
    distinctContacts: d.contacts,
    registrableDomain: registrableDomain(domain),
  }));

  // ---- finalize threads ----
  const threadList: ThreadAggregate[] = [...threads.values()].map((t) => ({
    threadId: t.threadId,
    subject: t.subject,
    participants: [...t.participants].sort(),
    msgCount: t.msgCount,
    unreadCount: t.unreadCount,
    userParticipated: t.userParticipated,
    firstAt: toIso(t.firstAt),
    lastAt: toIso(t.lastAt),
  }));

  return { contacts: contactList, domains: domainList, threads: threadList };
}

/**
 * Run the full aggregation pass for one account against the index and persist
 * it. Reads message rows through the repo, computes the rollups, and replaces
 * the derived tables in one transaction (idempotent). `ownAddresses` are the
 * authenticated mailbox addresses so the user is never counted as their own
 * contact — pass the identity probe's address(es).
 */
export async function aggregateAccount(
  repo: Repo,
  account: string,
  ownAddresses: readonly string[] = [],
): Promise<Aggregates> {
  const rows = await repo.messagesForAggregation(account);
  const aggregates = computeAggregates(rows, ownAddresses);
  await repo.replaceAggregates(account, aggregates);
  return aggregates;
}
