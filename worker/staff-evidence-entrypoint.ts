/// <reference types="@cloudflare/workers-types" />
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Env } from './index.js';
import { readStaffSentEvidence } from './staff-evidence-reader.js';
/** No fetch handler or public route. Only deployment-controlled service props
 * authorize this entrypoint; request fields never supply caller authority. */
export class StaffSentEvidence extends WorkerEntrypoint<Env> {
  async readSentEvidence(request: unknown) {
    return readStaffSentEvidence(this.env, this.ctx.props, request);
  }
}
