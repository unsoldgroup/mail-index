# Writing a MailSource adapter

A **MailSource** is the only seam through which mail-index talks to a mail
provider. Everything above it — the index, the graph/interest engines, the
MCP/CLI surfaces — is provider-agnostic ([PLAN.md §4](PLAN.md): "Only the ingest
layer talks to the MailSource adapter"). Keeping the provider behind this
interface keeps each provider's setup tax a **swappable** concern, not a
permanent one.

Two Gmail adapters ship today, both read-only and both needing a Google OAuth
client (their own or a shared one — gog does **not** ship a working built-in
client): the **gog adapter** (recommended — Gmail via the
[`gog`](https://github.com/openclaw/gogcli) CLI; Homebrew-installable, clean
JSON, `--gmail-no-send`) and the **gws adapter** (Gmail via Google's
[`gws`](https://github.com/googleworkspace/cli) CLI). Both share the Gmail-REST → neutral-record
mapping in `src/source/adapters/gmail-shared.ts`. The **jmap adapter**
(`src/source/adapters/jmap/`) reads any JMAP server (built for Stalwart) over
`fetch` with HTTP Basic auth; the Deployment stores its credentials per Account
(`/setup`). IMAP and other providers are future work. This document is for anyone writing a new one.

---

## The contract

The interface mirrors the two-phase progressive sync ([PLAN.md §7](PLAN.md)):
cheap metadata for everything, full bodies only on demand. It lives in
`src/source/index.ts`.

```ts
interface MailSource {
  /** Stable identifier for the provider (e.g. "gws", "imap"). */
  readonly provider: string;

  /** Auth/identity probe: who am I, am I authenticated. Never throws for an
   *  ordinary auth failure — reports { ok:false, reason } instead. */
  check(): Promise<SourceIdentity>;

  /** Enumerate provider message ids in `scope`, newest-first. Lazy: an async
   *  iterable so a large mailbox pages without buffering every id. */
  listIds(scope?: MailScope): AsyncIterable<string>;

  /** Fetch the cheap metadata shape (headers + snippet + labels, NO body) for
   *  each id, in input order. Ids the provider cannot return are OMITTED, never
   *  represented as null holes. */
  getMetadata(ids: readonly string[]): Promise<MessageMetadata[]>;

  /** Fetch the full record (metadata + body) for one id, or null if missing. */
  getFull(id: string): Promise<MessageFull | null>;
}
```

### Rules every adapter must honour

- **Read-only.** No method ever mutates the mailbox (no send, label, archive,
  delete). Fetching content is fine; mutating is not.
- **No provider JSON leaks upward.** Translate the provider's shapes into the
  neutral `MessageMetadata` / `MessageFull` records. Field names line up with
  the index's `MessageInput` so the sync layer is a near-mechanical mapping.
- **Adapters do NOT distill.** `getFull` hands back the body **as the provider
  gave it** (raw text and/or HTML). HTML→text, quote/signature/footer stripping
  happens in the ingest layer (CONTEXT.md "Enrichment"), not here.
- **The complete header bag.** `MessageMetadata.headers` must carry every header
  the provider returned (any case), unfiltered. Classification tests `List-Id` /
  `List-Unsubscribe` for *presence* to set `is_list`. A restricted header
  projection silently drops these — see the §8 pitfall below. An empty object
  means "the provider returned no headers", never "headers were filtered".
- **`listIds` honours `scope`.** Apply `query`, `since`, `limit`, and
  `includeSent` (PLAN D11 — Sent metadata is indexed for the replied/initiated
  signals). `includeSent: false` excludes Sent.
- **`getMetadata` omits unknowns**, `getFull` returns `null` for an unknown id.

#### The §8 pitfall (Gmail-specific, but illustrative)

Through gws, restricting headers via Gmail's `metadataHeaders` parameter is
unreliable and silently drops `List-*` headers. The gws adapter therefore uses
**plain** `format=metadata` and never passes `metadataHeaders`. Any adapter over
a provider with a header-projection option should learn from this: fetch the
whole header bag.

### The data shapes

```ts
interface MailScope {        // the set a sync run operates over; all optional
  query?: string;            // provider-native filter (opaque above the adapter)
  since?: string;            // "30d", "1mo", or ISO-8601
  limit?: number;            // hard cap on ids
  includeSent?: boolean;     // include Sent (D11)
}

interface SourceIdentity { ok: boolean; address: string | null; reason?: string }

interface MessageMetadata {
  id: string; threadId: string | null;
  internalDate: number | null;   // epoch ms — the canonical "when" axis
  dateHeader: string | null;
  from, to, cc, subject: string | null;
  labels: string[];              // provider label ids (INBOX, UNREAD, SENT, …)
  snippet: string | null; sizeEstimate: number | null;
  headers?: Record<string, string>;  // the COMPLETE header bag
}

interface MessageFull extends MessageMetadata {
  bodyText: string | null;       // raw, as the provider gave it
  bodyHtml: string | null;       // raw
  mimeType: string | null;       // hint for the distiller
}
```

---

## How to write one

1. **Implement `MailSource`** in `src/source/adapters/<name>/`. Keep the network
   call behind an injectable **runner** seam (the gws adapter's `GwsRunner` is a
   function `(args, configDir) => Promise<unknown>`). That single seam is what a
   test swaps for recorded fixtures, so the contract suite exercises your *real*
   adapter logic — argument building, pagination, parsing, payload walking — with
   **no child process and no network**.
2. **Register the adapter id** in `src/config/index.ts` (`ADAPTERS`), so an
   operator can select it via `"adapter": "<name>"` in their config.
3. **Wire construction** wherever the CLI/MCP builds a source for an account
   (`buildSource` in `src/cli/sync.ts`) so your adapter is instantiated for its
   accounts.
4. **Record fixtures** covering at least a direct, a list, and a sent message
   (PLAN §18 calls for breadth), plus a fixture-backed runner that replays them.

---

## The fixture-backed contract test

Every adapter proves conformance by running the **reusable contract suite**
(`src/source/contract.ts`) against recorded fixtures — no live network ever runs
in CI. The suite is parameterised over `(makeSource, fixtures)` so it never bakes
in a particular adapter.

Tests import the **compiled** output (`dist/…`), per the repo convention. A new
adapter's test mirrors the gws adapter's (`test/gws.test.ts`):

```ts
import { test } from 'node:test';
import { runMailSourceContract } from '../dist/source/contract.js';
import { MyAdapter } from '../dist/source/adapters/my/index.js';
import { MY_CONTRACT_FIXTURES, makeMyFixtureRunner } from '../dist/source/adapters/my/fixtures.js';

const makeAdapter = () =>
  new MyAdapter({ /* config */, runner: makeMyFixtureRunner(), pageSize: 2 });

// The full contract suite, run against the real adapter over recorded fixtures.
runMailSourceContract(test, makeAdapter, MY_CONTRACT_FIXTURES);
```

The suite asserts: a non-empty `provider`; `check()` authenticates and reports
the fixture address; `listIds()` yields exactly the fixture ids and honours
`limit`; `getMetadata()` returns the full declared shape (no body leakage) and
**omits** unknown ids; `getFull()` returns a non-empty body for a known id and
`null` for an unknown id; and the fixture set spans ≥2 messages.

Use a small `pageSize` (e.g. 2) so the suite exercises pagination across pages.
The in-memory `FakeMailSource` (`src/source/fake.ts`) is the reference
implementation that proves the harness itself.
