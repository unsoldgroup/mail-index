/**
 * A trivial in-memory {@link MailSource} backed by recorded fixtures (SCOPE
 * 0.3). It honours the interface with zero network: `listIds` yields fixture
 * ids newest-first, `getMetadata` projects the metadata subset, `getFull`
 * returns the full record, and `check` reports the fixture mailbox.
 *
 * Used as the reference implementation the contract suite runs against (proving
 * the harness works) and as a building block for higher-stage sync tests.
 */

import type {
  MailScope,
  MailSource,
  MessageFull,
  MessageMetadata,
  ProviderLabel,
  SourceIdentity,
} from './index.js';
import { DEFAULT_FIXTURES, type MailSourceFixtures } from './fixtures/index.js';

/** Project a full fixture record down to the metadata-only shape. */
function toMetadata(m: MessageFull): MessageMetadata {
  return {
    id: m.id,
    threadId: m.threadId,
    internalDate: m.internalDate,
    dateHeader: m.dateHeader,
    from: m.from,
    to: m.to,
    cc: m.cc,
    ...(m.replyTo == null ? {} : { replyTo: m.replyTo }),
    ...(m.originFrom == null ? {} : { originFrom: m.originFrom }),
    subject: m.subject,
    labels: m.labels,
    snippet: m.snippet,
    sizeEstimate: m.sizeEstimate,
    ...(m.headers ? { headers: m.headers } : {}),
  };
}

/** Whether a fixture message counts as Sent (drives `includeSent` filtering). */
function isSent(m: MessageFull): boolean {
  return m.labels.includes('SENT');
}

export class FakeMailSource implements MailSource {
  readonly provider = 'fake';
  readonly #fixtures: MailSourceFixtures;

  constructor(fixtures: MailSourceFixtures = DEFAULT_FIXTURES) {
    this.#fixtures = fixtures;
  }

  check(): Promise<SourceIdentity> {
    return Promise.resolve({ ok: true, address: this.#fixtures.address });
  }

  async *listIds(scope: MailScope = {}): AsyncIterable<string> {
    // Honour the one Gmail operator the inbox reconcile relies on: `in:inbox`
    // restricts the sweep to INBOX-labelled fixtures, so the fake mirrors the
    // real adapters closely enough for membership reconcile to be exercised.
    const inboxOnly = scope.query != null && /\bin:inbox\b/i.test(scope.query);
    let count = 0;
    for (const m of this.#fixtures.messages) {
      if (scope.includeSent === false && isSent(m)) continue;
      if (inboxOnly && !m.labels.includes('INBOX')) continue;
      if (scope.limit != null && count >= scope.limit) return;
      count += 1;
      yield m.id;
    }
  }

  getMetadata(ids: readonly string[]): Promise<MessageMetadata[]> {
    const byId = new Map(this.#fixtures.messages.map((m) => [m.id, m]));
    const out: MessageMetadata[] = [];
    for (const id of ids) {
      const m = byId.get(id);
      if (m) out.push(toMetadata(m));
    }
    return Promise.resolve(out);
  }

  getFull(id: string): Promise<MessageFull | null> {
    const m = this.#fixtures.messages.find((x) => x.id === id);
    return Promise.resolve(m ?? null);
  }

  /**
   * A small fixed label catalogue: the self-named system labels the fixtures
   * use plus one opaque user label (`Label_1` → "Coverage Review"), so tests can
   * exercise both id→name translation and system-label passthrough.
   */
  listLabels(): Promise<ProviderLabel[]> {
    return Promise.resolve([
      { id: 'INBOX', name: 'INBOX', type: 'system' },
      { id: 'SENT', name: 'SENT', type: 'system' },
      { id: 'UNREAD', name: 'UNREAD', type: 'system' },
      { id: 'STARRED', name: 'STARRED', type: 'system' },
      { id: 'IMPORTANT', name: 'IMPORTANT', type: 'system' },
      { id: 'CATEGORY_PERSONAL', name: 'CATEGORY_PERSONAL', type: 'system' },
      { id: 'Label_1', name: 'Coverage Review', type: 'user' },
    ]);
  }
}
