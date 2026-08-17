/**
 * The `MailSource` adapter interface (SCOPE 0.3, ADR/D1, PLAN §4 ingest layer,
 * §19 adapter contract).
 *
 * A `MailSource` is the *only* seam through which the ingest layer talks to a
 * mail provider. Everything above it — the index, engines, MCP/CLI surfaces —
 * is provider-agnostic (PLAN §4: "Only the ingest layer talks to the MailSource
 * adapter"). gws is Adapter #1 (D1); `DirectGmailAdapter` / `ImapAdapter` are
 * v1.x. Keeping the provider behind this interface keeps the gws setup tax a
 * swappable concern, not a permanent one.
 *
 * The interface mirrors the two-phase progressive sync (PLAN §7):
 *
 *  - {@link MailSource.listIds} enumerates the message ids in a scope (the
 *    selector a sync run records).
 *  - {@link MailSource.getMetadata} fetches the cheap `format=metadata` shape
 *    phase-1 sync stores: headers + snippet + labels + internalDate. No body.
 *  - {@link MailSource.getFull} fetches the `format=full` shape phase-2 enrich
 *    promotes a Message to: the metadata plus a (raw, not-yet-distilled) body.
 *  - {@link MailSource.check} is the auth/identity probe: who am I, am I
 *    authenticated. Run before a sync so failures surface up front.
 *
 * These types are the contract every adapter *and* the sync layer share. They
 * are deliberately provider-neutral (no Gmail-API JSON shapes leak through);
 * field names line up with the index's `MessageInput` (see `index/repo.ts`) so
 * the sync layer is a near-mechanical mapping. Distillation (HTML→text, quote/
 * signature stripping — CONTEXT.md "Enrichment") happens in the ingest layer,
 * NOT in the adapter: an adapter hands back the body as the provider gave it.
 */

/**
 * The set of messages a sync run operates over. Provider-neutral; an adapter
 * translates it into whatever its provider understands (a Gmail search query,
 * an IMAP range, …). All fields optional — an empty scope means "the whole
 * mailbox in scope by the adapter's own policy" (PLAN §15 per-account policy).
 */
export interface MailScope {
  /**
   * Provider-native query/filter string (e.g. a Gmail search expression like
   * `from:bloomberg.com`). Opaque to everything above the adapter.
   */
  query?: string;
  /**
   * Lower bound on message age, as an ISO-8601 timestamp or a relative token
   * the adapter understands (e.g. `30d`, `1mo`). Matches the CLI `--since`.
   */
  since?: string;
  /**
   * Upper bound on message age (exclusive), as an ISO-8601 timestamp or
   * `YYYY-MM-DD`. Pairs with {@link MailScope.since} to sweep one historical
   * slice at a time, so a deep backfill never becomes one unbounded request.
   */
  until?: string;
  /** Hard cap on the number of ids returned. */
  limit?: number;
  /** Include messages the user sent (PLAN D11 — Sent metadata is indexed). */
  includeSent?: boolean;
}

/**
 * Result of the auth/identity probe ({@link MailSource.check}). `ok=false`
 * means the adapter could not authenticate or reach the provider; `reason`
 * carries a human-readable explanation for the CLI/log.
 */
export interface SourceIdentity {
  /** Whether the adapter is authenticated and the provider is reachable. */
  ok: boolean;
  /**
   * The authenticated mailbox address (the provider's notion of "me"), when
   * known. Null when the probe failed or the provider does not expose it.
   */
  address: string | null;
  /** Human-readable detail, especially when `ok` is false. */
  reason?: string;
}

/**
 * The `format=metadata` shape phase-1 sync stores (PLAN §6 `messages`, §7
 * phase 1). Headers + snippet + labels + timestamps; deliberately NO body.
 * Field names mirror `index/repo.ts` `MessageInput` so the mapping is direct.
 */
export interface MessageMetadata {
  /** Provider message id, unique within the source's mailbox. */
  id: string;
  /** RFC Message-ID header, stable across mailbox copies when supplied. */
  messageId?: string | null;
  /** Provider thread/conversation id this message belongs to. */
  threadId: string | null;
  /**
   * Provider-internal receipt timestamp, epoch milliseconds (Gmail
   * `internalDate`). The canonical sort/“when” axis.
   */
  internalDate: number | null;
  /** Raw `Date:` header value, when present. */
  dateHeader: string | null;
  /** `From:` header (display name + address as the provider gave it). */
  from: string | null;
  /** `To:` header. */
  to: string | null;
  /** `Cc:` header. */
  cc: string | null;
  /** `Subject:` header. */
  subject: string | null;
  /**
   * Provider label ids/names attached to the message (Gmail `labelIds`:
   * `INBOX`, `UNREAD`, `CATEGORY_PROMOTIONS`, `SENT`, …). Classification (§8)
   * derives category/is_list/direction/unread from these in the ingest layer.
   */
  labels: string[];
  /** Provider-supplied short preview text (Gmail `snippet`). */
  snippet: string | null;
  /** Provider estimate of the message size in bytes, when known. */
  sizeEstimate: number | null;
  /**
   * The full raw header bag from a plain `format=metadata` fetch, keyed by
   * header name as the provider supplied it (any case), value the raw header
   * value. Classification (§8) tests these for *presence* only — notably
   * `List-Id` / `List-Unsubscribe` drive `is_list`. The §8 pitfall forbids a
   * restricted (`metadataHeaders`) projection, so adapters MUST hand over the
   * complete bag; an empty object means "the provider returned no headers",
   * never "headers were filtered". Optional so legacy fixtures without a header
   * bag still satisfy the shape (classification then falls back to labels).
   */
  headers?: Record<string, string>;
}

/**
 * The `format=full` shape phase-2 enrich promotes a Message to (PLAN §7 phase
 * 2): everything in {@link MessageMetadata} plus the message body. The body is
 * returned *as the provider gave it* (raw text and/or HTML); the ingest layer
 * distills it (CONTEXT.md "Enrichment"). Adapters do no stripping.
 */
export interface MessageFull extends MessageMetadata {
  /** Plain-text body part, when the provider supplied one. */
  bodyText: string | null;
  /** HTML body part, when the provider supplied one. */
  bodyHtml: string | null;
  /** MIME type the body was sourced from, for the distiller's benefit. */
  mimeType: string | null;
  attachments?: AttachmentMetadata[];
}

export interface AttachmentMetadata {
  attachmentId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  inline: boolean;
  inlineDataBase64?: string;
}

/** Metadata for one provider-hosted message attachment. */
export interface MessageAttachment {
  /** Provider attachment id, unique within the parent Message. */
  id: string;
  filename: string;
  mimeType: string;
  size: number | null;
}

/** Raw attachment bytes, encoded for safe transport through JSON/MCP. */
export interface MessageAttachmentData {
  /** Standard RFC 4648 base64 (not Gmail's base64url variant). */
  data: string;
  size: number;
}

/** Maximum raw attachment size returned inline through MCP (25 MiB). */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/**
 * Thrown by {@link MailSource.modify} when the provider rejects the write for
 * lack of a mutating scope (the default `gmail.readonly` install). Carries a
 * ready-to-run `remedy` command so the surface can tell the user exactly how to
 * opt in. Provider-neutral so CLI and MCP can catch one type across adapters.
 */
export class InsufficientScopeError extends Error {
  override name = 'InsufficientScopeError';
  /** The provider that rejected the write (e.g. `gog`). */
  readonly provider: string;
  /** A shell command the user can run to grant the needed scope. */
  readonly remedy: string;
  constructor(provider: string, remedy: string, detail?: string) {
    super(
      `${provider}: mailbox write rejected — the current grant is read-only. ` +
        `Re-authorize with write scope:\n  ${remedy}` +
        (detail ? `\n(provider said: ${detail})` : ''),
    );
    this.provider = provider;
    this.remedy = remedy;
  }
}

/**
 * One provider label: its opaque id, its human-readable name, and whether the
 * provider owns it ({@link MailSource.listLabels}). For Gmail, system labels
 * (`INBOX`, `STARRED`, `CATEGORY_*`) have id === name; user labels have an
 * opaque id (`Label_123…`) and a distinct display name.
 */
export interface ProviderLabel {
  /** Provider label id, as it appears in a message's `labels` array. */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** `system` | `user` when the provider distinguishes them. */
  type?: string;
}

/**
 * A label mutation to apply to one message ({@link MailSource.modify}). Mirrors
 * the Gmail `messages.modify` body: ids to add and/or remove. Archive is just
 * `{ removeLabelIds: ['INBOX'] }`. Either field may be omitted/empty.
 */
export interface LabelChange {
  /** Label ids/names to add (e.g. `['STARRED']` or a user label name). */
  addLabelIds?: string[];
  /** Label ids/names to remove (e.g. `['INBOX']` to archive). */
  removeLabelIds?: string[];
}

/**
 * The provider seam. An adapter implements this; the ingest layer is the only
 * caller for the read methods. Read-only by contract for everything EXCEPT the
 * one opt-in mutation seam {@link MailSource.modify} — which is absent on
 * read-only adapters and only reached through mail-index's explicit, opt-in
 * archive/label surface (never the sync/enrich path). See
 * docs/adr/0007-opt-in-mailbox-writes.md.
 *
 * Methods are async — every real adapter is network-bound (the bottleneck per
 * D5). {@link MailSource.listIds} returns an `AsyncIterable` so an adapter can
 * page lazily over a large mailbox without buffering every id in memory; a
 * fixture-backed fake may simply yield from an array.
 */
export interface MailSource {
  /** Stable identifier for the underlying provider (e.g. `gws`, `imap`). */
  readonly provider: string;

  /**
   * Auth/identity probe. Resolves to {@link SourceIdentity}; never throws for
   * an ordinary auth failure (it reports `ok:false` instead) so callers can
   * decide how to surface it. May throw only for programmer errors.
   */
  check(): Promise<SourceIdentity>;

  /**
   * Enumerate the provider message ids in `scope`, newest-first by the
   * provider's natural order. Lazy: yields ids (or id pages flattened to ids)
   * so the sync loop can start work before the full list is known.
   */
  listIds(scope?: MailScope): AsyncIterable<string>;

  /**
   * Fetch the metadata record for each id, in input order. Ids the provider
   * cannot return (deleted, inaccessible) are omitted from the result rather
   * than represented as holes — callers match on `id`.
   */
  getMetadata(ids: readonly string[]): Promise<MessageMetadata[]>;

  /** Fetch the full record (metadata + body) for one id, or null if missing. */
  getFull(id: string): Promise<MessageFull | null>;

  /** List attachment metadata for one Message. Optional when unsupported. */
  listAttachments?(id: string): Promise<MessageAttachment[]>;

  /**
   * Fetch one attachment's raw bytes. Optional when unsupported.
   *
   * Returns base64 rather than an ArrayBuffer because the same bytes serve two
   * consumers with opposite needs: the MCP tool hands them to an agent through
   * JSON, and the Deployment's R2 store decodes them back to binary.
   */
  getAttachment?(id: string, attachmentId: string): Promise<MessageAttachmentData | null>;

  /**
   * List the mailbox's label catalogue (id → name → type). Optional: adapters
   * that can't enumerate labels omit it, and label rendering falls back to raw
   * ids. The result is small and stable; callers cache it (the index `labels`
   * table, refreshed each sync) rather than calling per message.
   */
  listLabels?(): Promise<ProviderLabel[]>;

  /**
   * OPT-IN mutation seam (the ONLY method that writes to the mailbox). Apply a
   * label {@link LabelChange} to message `id`. Absent on read-only adapters, so
   * callers MUST feature-detect (`typeof source.modify === 'function'`).
   *
   * Requires a provider scope that permits modification (for Gmail,
   * `gmail.modify` — the default `gmail.readonly` install cannot call this and
   * the adapter surfaces a typed insufficient-scope error). Reached only from
   * the explicit `mail-index archive`/`label` CLI commands and the
   * `archive_message`/`modify_labels` MCP tools — never from sync or enrich.
   */
  modify?(id: string, change: LabelChange): Promise<void>;
}
