# Remote Deployment tickets (docs/PLAN-worker.md)

Staged for `gh issue create` once GitHub auth is available — one issue per
file, title = the file's H1, body = the rest.

| # | Ticket | Depends on |
|---|--------|------------|
| 001 | M1: Extract async StorageDriver | — |
| 002 | M1: Add the D1 StorageDriver with migrations and FTS contract verification | 001 |
| 003 | M1: Add the Gmail REST MailSource adapter behind an injectable fetch seam | — |
| 004 | M2: Create the worker/ entry and wrangler config serving streamable-HTTP MCP | 001, 002 |
| 005 | M2: Build the Google OAuth connect flow with encrypted token storage | 003, 004 |
| 006 | M2: Wire cron sync and the queued Job engine | 001, 002, 003, 004, 005 (hard — account list = `google_tokens` rows) |
| 007 | M3: Add MCP OAuth via workers-oauth-provider with operator allowlist | 004, 005 |
| 008 | M3: Reach full MCP tool parity on the Worker | 004, 006, 007, 005 |
| 009 | M3: Run the intelligence layer (graph, cadence, interest) within Worker CPU limits | 008, 006 (continuation mechanism) |
| 010 | M4: Implement Trigger rules with signed webhook delivery | 006, 008 |
| 011 | M4: Expose a minimal A2A surface (agent card + message/send) | 010 (shares engine), 007, 008 |
| 012 | M4: Build the seed path — mail-index export and D1 import | 002, 006 (soft — incremental-first-sync AC) |
| 013 | M4: Ship remote ops and docs — threat model, install guide, status polish, push design note | 001–012 (last) |

Dependency graph (PLAN-worker.md): 1→2→(4,6); 3→(5,6); 4→7→8; 6→(8,10);
8→9; 10→11; 12 after 2; 13 last.

## GitHub issue mapping

001→#12 002→#13 003→#14 004→#15 005→#16 006→#17 007→#18 008→#19 009→#20 010→#21 011→#22 012→#23 013→#24
