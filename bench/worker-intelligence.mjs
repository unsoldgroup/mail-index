import { performance } from 'node:perf_hooks';
import { Miniflare } from 'miniflare';
import { D1Driver } from '../dist/index/drivers/d1.js';
import { Repo } from '../dist/index/repo.js';
import { runMigrations } from '../dist/index/migrations.js';
import { aggregateAccount } from '../dist/intelligence/aggregate.js';
import { interestPass } from '../dist/intelligence/interest.js';
import { buildGraph } from '../dist/graph/build.js';
import { computeCadence } from '../dist/intelligence/cadence.js';
import { propose } from '../dist/curation/index.js';

for (const size of [100, 1000]) {
  const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ['DB'] });
  const driver = new D1Driver(await mf.getD1Database('DB')); await runMigrations(driver); const repo = new Repo(driver);
  for (let i = 0; i < size; i++) await repo.upsertMessage({ account: 'bench', gmailMessageId: `m${i}`, threadId: `t${Math.floor(i / 3)}`, internalDate: Date.now() - i * 60_000, fromAddr: `person${i % 40}@domain${i % 12}.example`, toAddr: 'you@example.com', subject: `Benchmark message ${i}`, labels: ['INBOX'], direction: 'received', bodyState: 'meta' });
  const timed = async (fn) => { const start = performance.now(); const value = await fn(); return { ms: performance.now() - start, value }; };
  const aggregate = await timed(() => aggregateAccount(repo, 'bench', ['you@example.com']));
  const interest = await timed(() => interestPass(repo, 'bench'));
  const graph = await timed(() => buildGraph(repo, 'bench'));
  const cadence = await timed(() => computeCadence(repo, 'bench'));
  const proposal = await timed(() => propose(repo, 'bench'));
  console.log(JSON.stringify({ size, aggregate_ms: +aggregate.ms.toFixed(1), interest_ms: +interest.ms.toFixed(1), graph_louvain_ms: +graph.ms.toFixed(1), cadence_ms: +cadence.ms.toFixed(1), propose_ms: +proposal.ms.toFixed(1), graph_nodes: graph.value.nodes }));
  await mf.dispose();
}
