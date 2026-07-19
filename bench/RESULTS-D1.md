# D1 FTS parity benchmark

The deterministic benchmark corpus and assertions live in
`test/storage-driver.test.js`. It runs the same porter-stemmed query built by
`buildMatch`, with the canonical `bm25(messages_fts, 10, 8, 4, 1)` expression,
against node:sqlite and a Miniflare D1 database. It checks identical hit order
and scores (within `1e-12`).

## 2026-07-18 run

| Engine | Corpus | Query | Outcome |
|---|---:|---|---|
| node:sqlite | 3 fixed rows | `refunds` + expansion | Pass |
| D1 (Miniflare) | 3 fixed rows | `refunds` + expansion | Pass — identical hit order and bm25 scores within `1e-12` |

Reproduce after installing development dependencies with:

```sh
node --test test/storage-driver.test.js
```

Measured with Miniflare `4.20260301.1` on Node.js 24. The shared parity test
completed against both engines without skips.
