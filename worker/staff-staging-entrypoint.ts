/// <reference types="@cloudflare/workers-types" />
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Env } from './index.js';
import { probeStaffIdentity, provisionStaffLink } from './staff-staging.js';
/** Private deployment-bound capabilities, no HTTP or MCP route. Authority comes
 * only from service-binding props; the probe and the staging journal are
 * separate entrypoints with separate permissions. */
export class StaffIdentityProbe extends WorkerEntrypoint<Env> {
  async probe(request: unknown) { return probeStaffIdentity(this.env, this.ctx.props, request); }
}
export class StaffLinkStaging extends WorkerEntrypoint<Env> {
  async provision(request: unknown) { return provisionStaffLink(this.env, this.ctx.props, request); }
}
