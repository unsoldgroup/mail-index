/**
 * Graph engine — Graphology centrality + community detection (SCOPE 2.3,
 * PLAN §9, D8/D9/D10, CONTEXT.md "Correspondent").
 *
 * A **lazy, derived, INDEX-ONLY** layer (D8, PLAN §4). `mail-index graph build`:
 *
 *  1. loads contacts and **edges = co-recipiency over `is_list = 0` threads
 *     only** (D9 — bulk-mail cliques are excluded up in {@link Repo.graphThreads}
 *     so they cannot poison community detection) into an in-memory Graphology
 *     graph;
 *  2. runs **PageRank centrality** (→ "who is central to your correspondence")
 *     and **Louvain community detection** (→ social circles);
 *  3. persists `centrality` and `community_id` back onto `contacts`.
 *
 * Graphology is the ONE permitted new dependency and is loaded ONLY here (D8):
 * the core index, ingest, search, and interest layers never import it, so a
 * build that is never run leaves sync / enrich / search fully functional. The
 * import is a normal top-level ESM import — `src/graph/` is its own subtree that
 * nothing in the hot path pulls in, so tree-shaking / module loading of the core
 * never touches graphology.
 *
 * ## Edges (co-recipiency)
 *
 * Each non-list thread contributes a clique over its participant set: every
 * unordered pair of participants who shared a thread gets an (undirected) edge,
 * and the edge weight accumulates the number of distinct threads the pair
 * co-occurred in. Weight feeds both PageRank (a heavily co-corresponded pair
 * pulls more rank) and Louvain (denser sub-graphs become communities). A
 * contact that appears in no non-list thread (or only in single-participant
 * threads) is still added as an isolated node so it receives a (low) centrality
 * and a singleton community rather than vanishing.
 *
 * ## Determinism
 *
 * Louvain is randomized; we pass a seeded RNG so a build over the same index
 * state assigns the same communities every run (idempotent, testable). PageRank
 * is deterministic given the graph.
 */

import { UndirectedGraph } from 'graphology';
import type { Attributes } from 'graphology-types';
import * as pagerankModule from 'graphology-metrics/centrality/pagerank.js';
import * as louvainModule from 'graphology-communities-louvain';

import type { GraphMetricInput, Repo } from '../index/repo.js';

// graphology's algorithm packages ship ESM `export default` type decls over a
// CJS runtime; under NodeNext a namespace import surfaces the callable on
// `.default`. These minimal call signatures pin the only two algorithm APIs we
// use (`.assign` mutates node attributes in place) without depending on the
// upstream interop shape.
interface AssignAlgo<O> {
  assign(graph: UndirectedGraph<NodeAttrs, EdgeAttrs>, options: O): void;
}
const pagerank = (pagerankModule as unknown as { default: AssignAlgo<PagerankOpts> }).default;
const louvain = (louvainModule as unknown as { default: AssignAlgo<LouvainOpts> }).default;

interface PagerankOpts {
  nodePagerankAttribute: string;
  getEdgeWeight: string;
}
interface LouvainOpts {
  nodeCommunityAttribute: string;
  getEdgeWeight: string;
  rng: () => number;
}

type NodeAttrs = { centrality: number; community: number } & Attributes;
type EdgeAttrs = { weight: number } & Attributes;

/** Options for {@link buildGraph} (mostly for deterministic testing). */
export interface GraphBuildOptions {
  /**
   * Seed for Louvain's RNG so community assignment is deterministic across runs.
   * Defaults to a fixed constant — a build over an unchanged index reproduces
   * the same communities, which is what makes the step idempotent and testable.
   */
  seed?: number;
}

/** Outcome of a {@link buildGraph} run. */
export interface GraphBuildResult {
  /** The account whose graph was built. */
  account: string;
  /** Number of contact nodes in the graph. */
  nodes: number;
  /** Number of co-recipiency edges (distinct unordered participant pairs). */
  edges: number;
  /** Number of distinct Louvain communities found. */
  communities: number;
  /** The metrics persisted back onto contacts (centrality + community_id). */
  metrics: GraphMetricInput[];
}

/**
 * A tiny seeded PRNG (mulberry32) so Louvain is reproducible without pulling in
 * another dependency. Returns a function in `[0, 1)`.
 */
function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The undirected edge key for an unordered address pair (stable ordering). */
function edgeKey(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/**
 * Build the co-recipiency graph for one account, run PageRank + Louvain, and
 * persist `centrality` + `community_id` back onto `contacts` (D8/D9, PLAN §9).
 *
 * Reads ONLY the index (the non-list thread participant sets via
 * {@link Repo.graphThreads}) and writes ONLY the derived contact columns via
 * {@link Repo.persistGraphMetrics} — it never touches a `MailSource`. Idempotent:
 * a build over an unchanged index reproduces the same metrics (Louvain seeded).
 *
 * An account with no non-list threads yields an empty graph and persists
 * nothing (a no-op build) — sync / search remain fully functional regardless.
 */
export async function buildGraph(
  repo: Repo,
  account: string,
  options: GraphBuildOptions = {},
): Promise<GraphBuildResult> {
  const threads = await repo.graphThreads(account);

  // Undirected, weighted multigraph collapsed to a simple weighted graph: we
  // accumulate co-occurrence counts into a single edge per unordered pair.
  const graph = new UndirectedGraph<NodeAttrs, EdgeAttrs>({
    allowSelfLoops: false,
  });

  const ensureNode = (addr: string): void => {
    if (!graph.hasNode(addr)) graph.addNode(addr, { centrality: 0, community: 0 });
  };

  for (const thread of threads) {
    const ps = thread.participants;
    for (const p of ps) ensureNode(p);
    // Every unordered pair in the thread is a co-recipiency edge.
    for (let i = 0; i < ps.length; i++) {
      for (let j = i + 1; j < ps.length; j++) {
        const [a, b] = edgeKey(ps[i]!, ps[j]!);
        if (graph.hasEdge(a, b)) {
          graph.updateEdgeAttribute(a, b, 'weight', (w: number | undefined) => (w ?? 0) + 1);
        } else {
          graph.addEdge(a, b, { weight: 1 });
        }
      }
    }
  }

  const nodes = graph.order;
  const edges = graph.size;

  if (nodes === 0) {
    return { account, nodes: 0, edges: 0, communities: 0, metrics: [] };
  }

  // ---- PageRank centrality (weighted) ----
  // Writes `centrality` onto each node; deterministic given the graph.
  pagerank.assign(graph, {
    nodePagerankAttribute: 'centrality',
    getEdgeWeight: 'weight',
  });

  // ---- Louvain community detection (weighted, seeded) ----
  // Edgeless graphs make Louvain a no-op; guard so every node still gets a
  // (singleton) community id.
  if (edges > 0) {
    louvain.assign(graph, {
      nodeCommunityAttribute: 'community',
      getEdgeWeight: 'weight',
      rng: seededRng(options.seed ?? 0x5eed),
    });
  } else {
    let c = 0;
    graph.forEachNode((node) => graph.setNodeAttribute(node, 'community', c++));
  }

  const communitySet = new Set<number>();
  const metrics: GraphMetricInput[] = [];
  graph.forEachNode((address, attrs) => {
    const community = attrs.community;
    communitySet.add(community);
    metrics.push({
      address,
      centrality: attrs.centrality,
      communityId: community,
    });
  });

  await repo.persistGraphMetrics(account, metrics);

  return {
    account,
    nodes,
    edges,
    communities: communitySet.size,
    metrics,
  };
}
