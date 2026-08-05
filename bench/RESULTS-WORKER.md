# Worker intelligence benchmark

Measured 2026-07-19 on Node 24 with Miniflare D1 using
`node bench/worker-intelligence.mjs`. The corpus preserves repeated Threads and
sender/domain fan-out while scaling from 100 Messages to 10×.

| Messages | aggregate | interest | graph + Louvain | cadence | propose | pipeline total |
|---:|---:|---:|---:|---:|---:|---:|
| 100 | 2448.5 ms | 2872.1 ms | 1779.4 ms | 42.3 ms | 51.0 ms | 7193.3 ms |
| 1,000 | 6406.8 ms | 3085.3 ms | 1542.9 ms | 54.6 ms | 64.4 ms | 11153.9 ms |

The configured 30,000 ms paid-Worker CPU limit provides 2.69× headroom over
the 10× measured pipeline. Chunking is therefore not enabled: it would add
state and queue transitions without a measured budget breach. The Job progress
model remains continuation-ready if larger production measurements cross the
budget. Algorithms and deterministic output are unchanged.
