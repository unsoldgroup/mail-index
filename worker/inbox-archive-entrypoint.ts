/// <reference types="@cloudflare/workers-types" />
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Env } from './index.js';
import { archiveInboxMessage, type InboxArchiveResult } from './inbox-archive.js';
/** Named RPC only, no HTTP or MCP route. Reached by a service binding from the
 * EI email-gateway after it replies (EXP-5030); gated by INBOX_ARCHIVE_ACCOUNTS. */
export class InboxArchive extends WorkerEntrypoint<Env> {
  async archive(input: { account: string; rfcMessageId: string }): Promise<InboxArchiveResult> {
    return archiveInboxMessage(this.env, input);
  }
}
