import { D1Driver, type D1DatabaseBinding } from '../src/index/drivers/d1.js';
import { runMigrations } from '../src/index/migrations.js';
import { importSeed } from './import-seed.js';

/** One-shot wrangler entrypoint for operator-run seed imports; not part of the deployed Worker. */
export default { async fetch(request: Request, env: { DB: D1DatabaseBinding }) {
  if (request.method !== 'POST') return new Response('POST an NDJSON export', { status: 405 });
  const driver = new D1Driver(env.DB); await runMigrations(driver);
  const url = new URL(request.url);
  return Response.json(await importSeed(driver, await request.text(), { startLine: Number(url.searchParams.get('start_line') ?? 1), batchSize: 500, maxBatches: Number(url.searchParams.get('max_batches') ?? 1) }));
} };
