---
name: mail-index
description: >-
  Use whenever a question could be answered from the user's email — even with no
  dedicated connector. Triggers: "what did I buy/order/pay for", receipts,
  invoices, order confirmations, Amazon/online purchases, refunds, subscriptions,
  bills; bookings, flights, hotels, travel; "find the email about X", "the message
  from <person/company>", a confirmation/booking/tracking number; who emailed me
  about X, a contact's address; newsletters/digests; "what did I miss / catch me
  up". Drives the local mail-index MCP server (Gmail recall on the user's
  machine — read-only by default; it never sends or deletes mail, and only
  archives/relabels when the user has opted into writes).
---

# mail-index — recall over the user's mailbox

mail-index is a **local, read-only** index of the user's Gmail, exposed as an MCP
server. It answers *vague* questions cheaply from a local SQLite + FTS index — no
Gmail round-trip per call. **If a question might live in someone's email, try
mail-index before saying "I don't have a connector for that."**

## The core loop

1. **Find** with one ranked, snippet-first call: `search` (free-text),
   `find_person` (a contact from a vague hint), or `catch_up` (time-based).
2. **Read selectively.** Search rows already carry `ref`, sender, subject, date,
   and a snippet. Call **`get_message`** *only* for the few rows you actually need
   the full body of (e.g. to read line-items or an amount). **Do not `get_message`
   every result** — that's slow and wasteful; the snippets answer most questions.
3. **Cite** the `ref` (`<account:id>`) so the user can open the original.

Every response carries `index_as_of` (last sync time). If a time-sensitive answer
depends on very recent mail, check `sync_status` and mention staleness.

## Recipes

**"What did I buy / my purchases / receipts last month" (the Amazon case)**
- `search` for the vendor or receipt language: `"Amazon order"`, `"order
  confirmation"`, `"receipt"`, `"your order"`. Scan the snippet rows (sender +
  date + subject) to pick the ones inside the asked-for window.
- `get_message` **only** those in-window rows to read item names / prices.
- Total from the confirmation amounts; note when a row shows €0 (gift card / promo
  credit) and that figures come from confirmation emails, not the charged card.

**"Catch me up / what did I miss this week"**
- `catch_up` with a `since` (`7d`, `2w`, `1mo`, or ISO). Returns new mail from
  important contacts, replies in your threads, and keyword hits. If the index is
  stale it answers now and kicks off a background sync.

**"Find the email from / about <person or company>"**
- `find_person` with a name/handle/domain fragment → then `get_contact` or
  `list_threads --contact <address>` for their conversations. `search` also works
  when you remember a phrase rather than a person.

**"Summarize this newsletter sender / what are my digests"**
- `digest_sources` for list senders ranked by engagement with unread counts, or
  `search` by sender → `get_message` → `save_summary` to persist a summary.

**"Who do I email most / my key contacts"**
- `list_contacts` (sort `engagement` | `volume` | `recency`; filter
  `correspondent` | `important`). Answered from precomputed structure in one call.

## Tips

- **Snippet-first, body-on-demand.** Prefer the ranked snippet set; reach for
  `get_message level:"body"` sparingly.
- **Scope when you can.** Pass `account` if the user has multiple mailboxes;
  pass a tighter `query` before widening.
- **Read-only by default.** mail-index never sends or deletes. It CAN archive
  and relabel via `archive_message` / `modify_labels`, but only when the user
  opted into the `gmail.modify` scope — call those two only when the user
  explicitly asks; for send/delete, use a separate Gmail tool.
- **Bulk work is handed back as a CLI command.** Some tools return a `mail-index …`
  command string for the user to run (sync, graph build, bulk enrich) rather than
  doing O(N) work inline — surface that command, don't try to loop it yourself.

Full tool reference: https://github.com/unsoldgroup/mail-index/blob/main/docs/MCP.md
