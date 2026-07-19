# Seed a remote Deployment

Export earned local state without credentials or Worker operational rows:

```sh
mail-index export --out mail-index.ndjson
```

Run the one-shot importer against the operator-owned D1 binding (the importer
entrypoint is not part of the deployed Worker), then POST the dump to its local
Wrangler address:

```sh
npx wrangler dev worker/import-seed-entry.ts --config worker/wrangler.jsonc --remote
curl --data-binary @mail-index.ndjson 'http://127.0.0.1:8787/?max_batches=1'
```

Replay is idempotent and bounded to 500 rows per batch. If a response reports a
non-final `nextLine`, retry with `?start_line=<nextLine>`. The header schema must
exactly match the target. FTS is rebuilt from the canonical projection; Google
tokens, Jobs, Trigger rules, and webhook consumers are never exported.
