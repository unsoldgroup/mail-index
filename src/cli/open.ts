/**
 * `mail-index open <account:message-id>` (SCOPE 1.3, UNS-1218, PLAN §13).
 *
 * Resolves a message reference to its provider web URL and prints it. The
 * contract is *resolve + print* — `open` never reaches the provider (no
 * `getFull`, no auth probe): it maps the ref to a deterministic deep-link URL
 * for the account's adapter. This keeps `open` O(0) and usable on a message that
 * is not even indexed yet (the URL only needs the account's adapter kind + the
 * message id), which is the whole point of a stable provider deep link.
 *
 * URL resolution is adapter-keyed: each adapter knows the URL shape for its
 * provider. For gws (Gmail) the canonical deep link is
 * `https://mail.google.com/mail/u/0/#all/<message-id>` — the `#all` search
 * view resolves the message id regardless of which folder/label it lives in,
 * and `/u/0` targets the first authenticated profile in the browser (the
 * operator's default; Gmail itself redirects to the right `/u/N` for the
 * signed-in identity). If the index already carries a stored `gmail_url` for
 * the row (e.g. a future adapter that records the provider's own permalink), we
 * prefer that over the constructed form.
 *
 * The ref shape and {@link parseRef} are shared with `show` (cli/show.ts).
 */

import { resolveAccount, type AccountConfig, type OperatorConfig } from '../config/index.js';
import type { Repo } from '../index/repo.js';

import { RefError, type MessageRef } from './show.js';

/**
 * Build the provider web URL for a message id under a given adapter binding. The
 * one place CLI `open` knows each adapter's deep-link shape; mirrors the
 * adapter-id switch in {@link buildSource}. Pure + synchronous — no provider
 * round-trip (the deep link is derivable from the id alone).
 */
export function providerUrl(account: AccountConfig, id: string): string {
  switch (account.adapter) {
    case 'gws':
    case 'gog':
    case 'gmail-rest':
      // Gmail `#all` deep link: resolves the message id from any folder/label;
      // `/u/0` = first signed-in profile (Gmail redirects to the right one).
      // Both Gmail-backed adapters share the same web URL shape.
      return `https://mail.google.com/mail/u/0/#all/${id}`;
    default: {
      // Exhaustiveness guard: a new adapter id must add its URL shape here too.
      const unknown: never = account.adapter;
      throw new Error(`no provider URL builder for adapter "${String(unknown)}"`);
    }
  }
}

/** Outcome of {@link runOpen}: the resolved ref + its provider web URL. */
export interface OpenResult {
  ref: MessageRef;
  url: string;
}

/**
 * Resolve a ref to its provider web URL (SCOPE 1.3). Resolves the account label
 * to its adapter binding (throws a clear config error for an unknown account),
 * then prefers a stored `gmail_url` on the indexed row if present, otherwise
 * constructs the canonical deep link via {@link providerUrl}. Does NOT require
 * the message to be in the index — the URL is derivable from the id alone, so a
 * not-yet-synced id still resolves (an agent can hand `open` any provider id).
 */
export async function runOpen(
  config: OperatorConfig,
  repo: Repo,
  ref: MessageRef,
): Promise<OpenResult> {
  const account = resolveAccount(config, ref.account);

  const stored = await repo.getMessageUrl(ref.account, ref.id);
  const url = stored ?? providerUrl(account, ref.id);

  return { ref, url };
}

/** Render the open result: the bare URL on its own line (the print contract). */
export function formatOpen(result: OpenResult): string {
  return result.url + '\n';
}

export { RefError };
