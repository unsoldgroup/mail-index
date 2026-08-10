import { D1Driver } from '../src/index/drivers/d1.js';
import { runMigrations } from '../src/index/migrations.js';
import { CrmChangeFeed } from './crm-feed.js';
import { enqueueSyncJob, jobStatus } from './jobs.js';
import type { Env } from './index.js';

function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

export async function handleCrmRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const driver = new D1Driver(env.DB);
  await runMigrations(driver);

  const attachmentPath = /^\/crm\/v1\/attachments\/(.+)$/.exec(url.pathname);
  if (request.method === 'GET' && attachmentPath) {
    if (!env.ATTACHMENTS?.get) return jsonError('attachments_not_configured', 503);
    const storageKey = decodeURIComponent(attachmentPath[1]!);
    const object = await env.ATTACHMENTS.get(storageKey);
    if (!object) return jsonError('attachment_not_found', 404);
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('etag', object.httpEtag);
    headers.set('cache-control', 'private, max-age=300');
    return new Response(object.body, { headers });
  }

  if (request.method === 'GET' && url.pathname === '/crm/v1/sources') {
    const rows = await driver.prepare(
      'SELECT account,address,scopes FROM google_tokens ORDER BY account',
    ).all() as Array<{ account: string; address: string; scopes: string }>;
    return Response.json({
      sources: rows.map((row) => ({
        key: row.account,
        address: row.address,
        scopes: row.scopes.split(/\s+/).filter(Boolean),
      })),
    });
  }

  if (request.method === 'GET' && url.pathname === '/crm/v1/changes') {
    const rawLimit = url.searchParams.get('limit');
    const limit = rawLimit == null ? undefined : Number(rawLimit);
    if (limit != null && (!Number.isInteger(limit) || limit < 1)) return jsonError('invalid_limit', 400);
    try {
      return Response.json(await new CrmChangeFeed(driver).read({
        ...(url.searchParams.get('after') ? { after: url.searchParams.get('after')! } : {}),
        ...(limit == null ? {} : { limit }),
      }));
    } catch (error) {
      if (error instanceof Error && error.message === 'invalid CRM cursor') {
        return jsonError('invalid_cursor', 400);
      }
      throw error;
    }
  }

  const refresh = /^\/crm\/v1\/sources\/([^/]+)\/refresh$/.exec(url.pathname);
  if (request.method === 'POST' && refresh) {
    const account = decodeURIComponent(refresh[1]!);
    const source = await driver.prepare('SELECT account FROM google_tokens WHERE account=?').get(account);
    if (!source) return jsonError('source_not_found', 404);
    const jobId = await enqueueSyncJob(env, account);
    return Response.json({ jobId, account, status: 'queued' }, { status: 202 });
  }

  const status = /^\/crm\/v1\/sources\/([^/]+)\/status$/.exec(url.pathname);
  if (request.method === 'GET' && status) {
    return Response.json(await jobStatus(env, decodeURIComponent(status[1]!)));
  }

  return jsonError('not_found', 404);
}
