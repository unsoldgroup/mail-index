# Benchmark — mail-index vs a stock Gmail-API MCP

A reproducible, side-by-side **token** benchmark. It measures the two taxes any
MCP server imposes on an agent's context window:

1. **Fixed schema tax** — every server injects all its tool definitions
   (names + descriptions + input JSON schemas) into the context on *every turn*,
   before any work happens. Counted from each server's `tools/list`.
2. **Per-task result tax** — the tokens each tool *returns* to answer a real
   question. This is where mail-index's ranked, snippet-first, distilled results
   diverge from the Gmail API's raw payloads (header arrays + base64 MIME parts).

## Why this is a fair fight (not a strawman)

- The Gmail side uses **real Gmail API payloads** fetched via the `gws` CLI — the
  exact JSON a stock Gmail MCP (`messages.list` + `messages.get`) hands the model.
- We model the Gmail "find → read" path **generously to Gmail**: `messages.list`
  returns ids only (no snippet — that's the real API), so to *identify* the answer
  the agent must `messages.get` candidates. We charge only the **top-3 at
  `format=metadata`** per recall + **one `format=full`** per read. Real agents
  guess the query several times and fetch more, so the true gap is larger.
- mail-index is charged for its real MCP calls: one `search` (ranked snippets),
  plus one `get_message` for a read.
- Token counting uses a **local `chars/4` approximation** for both sides.
  Counts and ratios are estimates, not model-specific tokenizer measurements.
  Provider credentials do not change this behavior or transmit text for counting.

## Run it

```sh
pnpm run build                      # ensure dist/ is current
node bench/run.mjs                  # defaults: --account personal
node bench/run.mjs --account unsold-group
# point at a LIVE Gmail MCP's tools/list for an exact schema-tax line:
node bench/run.mjs --gmail-tools /path/to/that-servers-tools.json
# the 100 inbox-question suite (8 research-backed categories):
node bench/run.mjs --suite inbox100
```

Two suites ship via `--suite`:
- **`default`** (30) — a tight cross-section across the four cost models.
- **`inbox100`** — the 100 questions from
  [`../docs/research/top-100-inbox-questions.md`](../docs/research/top-100-inbox-questions.md),
  grouped into the 8 research categories (retrieval, finance, logistics,
  summarization, commitments, scheduling, relationship, account). Writes to
  `bench/RESULTS-INBOX100.md`.

Output:
- **stdout** — aggregate, shareable summary (schema tax + per-task totals + ratio).
- **`bench/results.local.md`** — the full per-task table. Gitignored
  (`*.local.md`) because token counts are derived from your real mailbox.

## Accuracy: can a smarter query save Gmail? (`accuracy.mjs`)

`run.mjs` measures tokens. `accuracy.mjs` measures whether a **distilled** Gmail
query can answer *"list my purchases over 6 months"* accurately at all — running
a matrix of Gmail query variants (simple → keyword → distilled → broad) and
scoring each on **recall** (vs a transaction-sender reference set) *and* **tokens
to answer** (you must read every match to verify it), versus a single mail-index
phrase.

```sh
node bench/accuracy.mjs --account personal
```

Two findings fall out (see [RESULTS.md](RESULTS.md)): hand-distilling the query
is unreliable (precision constraints can *lower* recall — you're guessing blind),
and on Gmail recall and token cost rise together, so accuracy is bought with
tokens. mail-index returns a scannable snippet set in one call (~20–25× fewer
tokens) and closes the recall gap for free via sender/category structure.
Aggregate table → [`RESULTS.md`](RESULTS.md) (committed, no PII); the missed-
message detail → `results-accuracy.local.md` (gitignored).

## Files

- `run.mjs` — token harness (mail-index MCP over stdio vs Gmail API via `gws`);
  runs the **30 common-use-case suite** (`default`) or the **100 inbox-question
  suite** (`--suite inbox100`).
- `accuracy.mjs` — recall × token matrix (query distillation vs one mail-index phrase).
- `RESULTS-USECASES.md` — committed 30-use-case token table (regenerate with `run.mjs`).
- `RESULTS-INBOX100.md` — committed 100-question token table (regenerate with
  `run.mjs --suite inbox100`).
- `RESULTS.md` — committed aggregate recall/token table (regenerate with `accuracy.mjs`).
- `gmail-mcp-tools.json` — a representative stock Gmail MCP tool surface, used
  only for the fixed schema-tax line. Swap in a live server's `tools/list` via
  `--gmail-tools` for an exact figure. Not affiliated with any project.

## Interpreting the result

mail-index wins on both axes, for one structural reason: **it answers from a
local index built for recall, so a question costs one compact, ranked call** —
where the Gmail API forces a round-trip dance (list → get → get …) that ships raw
message envelopes into the context just to *find* what you meant. See
[../docs/COMPARISON.md](../docs/COMPARISON.md).
