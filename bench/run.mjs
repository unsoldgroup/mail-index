#!/usr/bin/env node
/**
 * mail-index vs. a stock Gmail-API MCP — token benchmark.
 *
 * Measures the two token taxes an MCP server imposes on an agent's context:
 *   1. FIXED schema tax — the tool definitions injected every turn (tools/list).
 *   2. PER-TASK result tax — the tokens each tool RETURNS to answer a question.
 *
 * The mail-index side calls the real MCP server over stdio. The Gmail side uses
 * REAL Gmail API payloads (fetched via the `gws` CLI) — the exact JSON a stock
 * Gmail MCP (e.g. messages.list + messages.get) hands the model — so this is a
 * faithful comparison, not a strawman. We model the Gmail "find then read" path
 * honestly (see GMAIL MODEL below) and document every assumption.
 *
 * Token counts are local chars/4 approximations, not model-specific tokenizer
 * counts. No benchmark text is sent to a model provider for counting.
 *
 * Usage:
 *   node bench/run.mjs [--account personal] [--gmail-tools bench/gmail-mcp-tools.json]
 * Real subjects/senders may appear in results → written to bench/results.local.md
 * (gitignored). Aggregate ratios are printed to stdout (safe to share).
 *
 * GMAIL MODEL (per search/recall task), kept deliberately GENEROUS to Gmail:
 *   - messages.list(q) returns {id, threadId} ONLY (no snippet) — real gws output.
 *   - To identify the answer among hits, the agent must messages.get each
 *     candidate. We charge the top-3 candidates at format=metadata + ONE
 *     format=full for the chosen answer. (Real agents often fetch more / guess
 *     the query several times; we charge the best case.)
 *   - mail-index search returns ranked snippet rows in ONE call; get_message is
 *     one compact (optionally body-level) call.
 */

import { spawn } from 'node:child_process';
import { countTokens, COUNT_MODE } from './token-count.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const NODE = process.execPath;
const MCP_ENTRY = join(REPO, 'dist', 'mcp', 'index.js');

const args = parseFlags(process.argv.slice(2));
const ACCOUNT = args.account ?? 'personal';
const GMAIL_TOOLS_PATH = args['gmail-tools'] ?? join(HERE, 'gmail-mcp-tools.json');
const CONFIG_DIR = resolveConfigDir(ACCOUNT);

// ---- mail-index MCP stdio client ------------------------------------------

function mcpSession() {
  const child = spawn(NODE, [MCP_ENTRY], { stdio: ['pipe', 'pipe', 'ignore'] });
  let buf = '';
  const waiters = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id != null && waiters.has(msg.id)) {
        waiters.get(msg.id)(msg);
        waiters.delete(msg.id);
      }
    }
  });
  let id = 0;
  const rpc = (method, params) =>
    new Promise((resolve) => {
      const myId = ++id;
      waiters.set(myId, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
    });
  const notify = (method, params) =>
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  return {
    async init() {
      await rpc('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'bench', version: '1' },
      });
      notify('notifications/initialized', {});
    },
    listTools: () => rpc('tools/list', {}),
    call: (name, a) => rpc('tools/call', { name, arguments: a }),
    close: () => child.kill(),
  };
}

function toolResultText(msg) {
  const c = msg?.result?.content;
  return Array.isArray(c) ? c.map((p) => p.text ?? '').join('') : JSON.stringify(msg?.result ?? {});
}

// ---- Gmail API via gws ----------------------------------------------------

function gws(params) {
  return new Promise((resolve, reject) => {
    const child = spawn('gws', ['gmail', 'users', 'messages', ...params], {
      env: { ...process.env, GOOGLE_WORKSPACE_CLI_CONFIG_DIR: CONFIG_DIR },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`gws exited ${code}: ${err.slice(0, 200)}`)),
    );
  });
}

const gmailList = (q, max = 10) =>
  gws(['list', '--params', JSON.stringify({ userId: 'me', q, maxResults: max })]);
const gmailGet = (id, format) =>
  gws(['get', '--params', JSON.stringify({ userId: 'me', id, format })]);

// ---- the task suite (generic; queries derive real ids at runtime) ---------

// 30 common use cases. kind drives the Gmail cost model:
//   recall  — find one message: list + top-3 metadata gets to identify it.
//   read    — read one message fully: list + 1 format=full get.
//   scan    — aggregate over many ("list all X"): list + one metadata get PER MATCH
//             (sampled avg × match count). You must read each to answer.
//   relational — contacts/graph/"what did I miss": the stock Gmail MCP has no
//             primitive, so it must scan + aggregate the mailbox (modeled as a
//             scan over the broad query). mail-index answers from precomputed
//             structure in one compact call.
const S = 200; // mail-index search limit for scan/relational
const TASKS = [
  // ---- A. Aggregation / "list all …" (scan) ----
  { cat: 'aggregate', kind: 'scan', label: 'all supplier / vendor emails (6mo)', mi: { tool: 'search', args: { query: 'invoice OR purchase order OR quote OR supplier OR vendor OR shipment OR delivery', limit: S } }, gmailQ: 'invoice OR "purchase order" OR quote OR supplier OR vendor OR shipment newer_than:6m' },
  { cat: 'aggregate', kind: 'scan', label: 'all purchases & receipts (6mo)', mi: { tool: 'search', args: { query: 'receipt OR order OR invoice OR payment OR purchase OR dispatched OR refund', limit: S } }, gmailQ: 'receipt OR order OR invoice OR payment OR purchase OR dispatched OR refund newer_than:6m' },
  { cat: 'aggregate', kind: 'scan', label: 'all invoices received (6mo)', mi: { tool: 'search', args: { query: 'invoice OR bill OR amount due OR statement', limit: S } }, gmailQ: 'invoice OR bill OR "amount due" OR statement newer_than:6m' },
  { cat: 'aggregate', kind: 'scan', label: 'all newsletters / subscriptions (6mo)', mi: { tool: 'search', args: { query: 'newsletter OR digest OR weekly OR briefing OR unsubscribe', limit: S } }, gmailQ: 'unsubscribe OR newsletter OR digest newer_than:6m' },
  { cat: 'aggregate', kind: 'scan', label: 'all meetings / calendar invites (6mo)', mi: { tool: 'search', args: { query: 'invite OR meeting OR calendar OR scheduled OR rsvp', limit: S } }, gmailQ: 'invite OR meeting OR calendar OR rsvp newer_than:6m' },
  { cat: 'aggregate', kind: 'scan', label: 'all travel / flight / hotel confirmations (6mo)', mi: { tool: 'search', args: { query: 'flight OR booking OR reservation OR itinerary OR hotel OR check-in', limit: S } }, gmailQ: 'flight OR booking OR reservation OR itinerary OR hotel newer_than:6m' },
  { cat: 'aggregate', kind: 'scan', label: 'all shipping / delivery notifications (6mo)', mi: { tool: 'search', args: { query: 'shipped OR dispatched OR delivery OR tracking OR out for delivery', limit: S } }, gmailQ: 'shipped OR dispatched OR delivery OR tracking newer_than:6m' },
  { cat: 'aggregate', kind: 'scan', label: 'all bank / financial statements (6mo)', mi: { tool: 'search', args: { query: 'statement OR balance OR deposit OR transaction OR account summary', limit: S } }, gmailQ: 'statement OR balance OR deposit OR transaction newer_than:6m' },
  { cat: 'aggregate', kind: 'scan', label: 'all recruiter / job emails (6mo)', mi: { tool: 'search', args: { query: 'role OR position OR opportunity OR recruiter OR hiring OR interview', limit: S } }, gmailQ: 'role OR position OR opportunity OR recruiter OR hiring newer_than:6m' },
  { cat: 'aggregate', kind: 'scan', label: 'all customer-support threads (6mo)', mi: { tool: 'search', args: { query: 'support OR ticket OR case OR enquiry OR help OR issue', limit: S } }, gmailQ: 'support OR ticket OR case OR enquiry OR issue newer_than:6m' },
  { cat: 'aggregate', kind: 'scan', label: 'all password-reset / security alerts (6mo)', mi: { tool: 'search', args: { query: 'security alert OR password OR verify OR login OR sign-in OR code', limit: S } }, gmailQ: '"security alert" OR password OR verify OR login OR "sign-in" newer_than:6m' },
  { cat: 'aggregate', kind: 'scan', label: 'all event invitations (6mo)', mi: { tool: 'search', args: { query: 'invited OR join us OR event OR webinar OR rsvp OR you are invited', limit: S } }, gmailQ: 'invited OR event OR webinar OR rsvp newer_than:6m' },
  { cat: 'aggregate', kind: 'scan', label: 'all subscription / recurring charges (6mo)', mi: { tool: 'search', args: { query: 'subscription OR renew OR auto-renew OR billed OR your plan OR membership', limit: S } }, gmailQ: 'subscription OR renew OR billed OR membership newer_than:6m' },
  { cat: 'aggregate', kind: 'scan', label: 'everything about insurance (6mo)', mi: { tool: 'search', args: { query: 'insurance OR policy OR coverage OR claim OR premium', limit: S } }, gmailQ: 'insurance OR policy OR coverage OR claim newer_than:6m' },
  { cat: 'aggregate', kind: 'scan', label: 'all messages mentioning a contract (6mo)', mi: { tool: 'search', args: { query: 'contract OR agreement OR signature OR terms OR sign here', limit: S } }, gmailQ: 'contract OR agreement OR signature OR terms newer_than:6m' },

  // ---- B. Recall / find-one (generic real-world intents) ----
  { cat: 'recall', kind: 'recall', label: 'a payment / account deposit confirmation', mi: { tool: 'search', args: { query: 'deposit confirmation payment', limit: 5 } }, gmailQ: 'deposit OR "payment confirmation"' },
  { cat: 'recall', kind: 'recall', label: 'a security alert email', mi: { tool: 'search', args: { query: 'security alert', limit: 5 } }, gmailQ: '"security alert"' },
  { cat: 'recall', kind: 'recall', label: 'an event invitation', mi: { tool: 'search', args: { query: 'event invitation rsvp', limit: 5 } }, gmailQ: 'invitation OR rsvp OR event' },
  { cat: 'recall', kind: 'recall', label: 'a refund notification', mi: { tool: 'search', args: { query: 'refund order', limit: 5 } }, gmailQ: 'refund' },
  { cat: 'recall', kind: 'recall', label: 'a recruiter / job-opportunity message', mi: { tool: 'search', args: { query: 'role opportunity recruiter', limit: 5 } }, gmailQ: 'role OR recruiter OR opportunity' },
  { cat: 'recall', kind: 'recall', label: 'a recent order / dispatch confirmation', mi: { tool: 'search', args: { query: 'order dispatched confirmation', limit: 5 } }, gmailQ: 'order OR dispatched OR confirmation' },
  { cat: 'recall', kind: 'recall', label: 'an appointment / booking confirmation', mi: { tool: 'search', args: { query: 'appointment booking confirmed', limit: 5 } }, gmailQ: 'appointment OR booking OR confirmed' },
  { cat: 'recall', kind: 'recall', label: 'a news / market briefing', mi: { tool: 'search', args: { query: 'market economy briefing', limit: 5 } }, gmailQ: 'market OR economy OR briefing' },
  { cat: 'recall', kind: 'recall', label: 'a payment receipt', mi: { tool: 'search', args: { query: 'receipt payment', limit: 5 } }, gmailQ: 'receipt OR "payment to"' },
  { cat: 'recall', kind: 'recall', label: 'a login / verification-code notice', mi: { tool: 'search', args: { query: 'login verification code new device', limit: 5 } }, gmailQ: '"new device" OR "verification code" OR "login attempt"' },

  // ---- C. Read / relationship / "what did I miss" ----
  { cat: 'read', kind: 'read', label: 'read the single most relevant invoice', mi: { tool: 'read-top', args: { query: 'invoice amount due', limit: 1 } }, gmailQ: 'invoice OR "amount due"' },
  { cat: 'read', kind: 'read', label: 'read the latest order/shipping update', mi: { tool: 'read-top', args: { query: 'order shipped delivery', limit: 1 } }, gmailQ: 'order OR shipped OR delivery' },
  { cat: 'relational', kind: 'relational', label: 'who do I correspond with most (top contacts)', mi: { tool: 'list_contacts', args: { sort: 'engagement', limit: 25 } }, gmailQ: 'newer_than:6m' },
  { cat: 'relational', kind: 'relational', label: 'which companies do I have back-and-forth with', mi: { tool: 'list_contacts', args: { filter: 'correspondent', limit: 25 } }, gmailQ: 'newer_than:6m -category:promotions' },
  { cat: 'relational', kind: 'relational', label: 'catch me up on what I missed this week', mi: { tool: 'catch_up', args: { since: '7d' } }, gmailQ: 'newer_than:7d' },
];

// ---- the 100 inbox questions (opt-in: `--suite inbox100`) -----------------
//
// The top-100 inbox questions from docs/research/top-100-inbox-questions.md,
// translated into runnable, PII-free generic queries. Each question's research
// tag maps to a cost-model `kind`: [R] retrieval → recall/read, [S] synthesis →
// scan/relational (where a query-based Gmail MCP has the weakest or no answer).
// `cat` is the research category; the report groups by it. Kept separate from
// TASKS so the committed 30-use-case numbers stay stable.
const INBOX_100 = [
  // ---- 1 · Retrieval & refinding (find a known item) ----
  { cat: 'retrieval', kind: 'recall', label: 'a message from a sender about a topic', mi: { tool: 'search', args: { query: 'meeting notes follow up', limit: 5 } }, gmailQ: 'meeting OR notes' },
  { cat: 'retrieval', kind: 'recall', label: 'the latest attachment someone sent', mi: { tool: 'search', args: { query: 'attached document file', limit: 5 } }, gmailQ: 'has:attachment' },
  { cat: 'retrieval', kind: 'recall', label: 'a half-remembered message by a phrase', mi: { tool: 'search', args: { query: 'as we discussed last time', limit: 5 } }, gmailQ: '"as discussed"' },
  { cat: 'retrieval', kind: 'recall', label: 'the most recent message in a project thread', mi: { tool: 'search', args: { query: 'project update status', limit: 5 } }, gmailQ: 'project OR update' },
  { cat: 'retrieval', kind: 'recall', label: 'a contract / PDF someone sent', mi: { tool: 'search', args: { query: 'contract agreement attached', limit: 5 } }, gmailQ: 'contract OR agreement has:attachment' },
  { cat: 'retrieval', kind: 'recall', label: 'a login code / verification link', mi: { tool: 'search', args: { query: 'verification code login link', limit: 5 } }, gmailQ: '"verification code" OR "log in"' },
  { cat: 'retrieval', kind: 'recall', label: 'a confirmation / reference number', mi: { tool: 'search', args: { query: 'confirmation number reference', limit: 5 } }, gmailQ: 'confirmation OR reference' },
  { cat: 'retrieval', kind: 'recall', label: "someone's new address / phone / bank details", mi: { tool: 'search', args: { query: 'new address phone number', limit: 5 } }, gmailQ: '"new address" OR "phone number" OR IBAN' },
  { cat: 'retrieval', kind: 'scan', label: 'everything from a frequent sender (recent)', mi: { tool: 'search', args: { query: 'notification update message', limit: S } }, gmailQ: 'newer_than:4w' },
  { cat: 'retrieval', kind: 'recall', label: 'the video-call link for a meeting', mi: { tool: 'search', args: { query: 'zoom meet teams join link', limit: 5 } }, gmailQ: 'zoom.us OR meet.google OR teams.microsoft' },
  { cat: 'retrieval', kind: 'recall', label: 'a discount / promo code I never used', mi: { tool: 'search', args: { query: 'promo code discount offer', limit: 5 } }, gmailQ: 'promo OR "discount code" OR coupon' },
  { cat: 'retrieval', kind: 'recall', label: 'the newsletter issue mentioning a topic', mi: { tool: 'search', args: { query: 'newsletter digest featured', limit: 5 } }, gmailQ: 'newsletter OR digest' },
  { cat: 'retrieval', kind: 'recall', label: 'the wifi / building / gate code', mi: { tool: 'search', args: { query: 'wifi password access code', limit: 5 } }, gmailQ: 'wifi OR "access code" OR passcode' },
  { cat: 'retrieval', kind: 'recall', label: 'directions / parking info for an event', mi: { tool: 'search', args: { query: 'directions parking venue', limit: 5 } }, gmailQ: 'directions OR parking' },
  { cat: 'retrieval', kind: 'recall', label: 'a resume / job description / offer letter', mi: { tool: 'search', args: { query: 'resume job description offer', limit: 5 } }, gmailQ: 'resume OR "job description" OR offer' },
  { cat: 'retrieval', kind: 'recall', label: 'a thread I starred / flagged', mi: { tool: 'search', args: { query: 'important follow up flagged', limit: 5 } }, gmailQ: 'is:starred' },
  { cat: 'retrieval', kind: 'recall', label: 'a shared Drive / Dropbox doc link', mi: { tool: 'search', args: { query: 'shared document drive link', limit: 5 } }, gmailQ: 'drive.google OR dropbox.com OR "shared a"' },
  { cat: 'retrieval', kind: 'recall', label: 'a recommendation someone emailed (book/tool)', mi: { tool: 'search', args: { query: 'you should check out recommend', limit: 5 } }, gmailQ: 'recommend OR "you should"' },

  // ---- 2 · Finance, invoices & purchases ----
  { cat: 'finance', kind: 'recall', label: 'the invoice from a vendor for a month', mi: { tool: 'search', args: { query: 'invoice amount due', limit: 5 } }, gmailQ: 'invoice' },
  { cat: 'finance', kind: 'scan', label: 'every invoice / receipt in a quarter', mi: { tool: 'search', args: { query: 'invoice receipt bill', limit: S } }, gmailQ: 'invoice OR receipt OR bill newer_than:6m' },
  { cat: 'finance', kind: 'scan', label: 'total spend at a vendor over months', mi: { tool: 'search', args: { query: 'order total charged payment', limit: S } }, gmailQ: 'order OR payment OR charged newer_than:6m' },
  { cat: 'finance', kind: 'scan', label: 'all receipts for an expense report', mi: { tool: 'search', args: { query: 'receipt expense reimbursement', limit: S } }, gmailQ: 'receipt OR expense newer_than:6m' },
  { cat: 'finance', kind: 'recall', label: 'the bill/statement from a utility or bank', mi: { tool: 'search', args: { query: 'statement bill due', limit: 5 } }, gmailQ: 'statement OR bill' },
  { cat: 'finance', kind: 'scan', label: "subscriptions I'm paying for (renewals)", mi: { tool: 'search', args: { query: 'subscription renew membership', limit: S } }, gmailQ: 'subscription OR renew OR membership newer_than:6m' },
  { cat: 'finance', kind: 'scan', label: 'recurring charges renewing in 30 days', mi: { tool: 'search', args: { query: 'auto-renew renews billed', limit: S } }, gmailQ: 'auto-renew OR renews OR "will be billed" newer_than:6m' },
  { cat: 'finance', kind: 'recall', label: 'a payment confirmation for a purchase', mi: { tool: 'search', args: { query: 'payment confirmation paid', limit: 5 } }, gmailQ: '"payment confirmation" OR "you paid"' },
  { cat: 'finance', kind: 'recall', label: 'the status of a refund', mi: { tool: 'search', args: { query: 'refund processed returned', limit: 5 } }, gmailQ: 'refund' },
  { cat: 'finance', kind: 'recall', label: 'a credit-card / bank statement attachment', mi: { tool: 'search', args: { query: 'statement attached pdf', limit: 5 } }, gmailQ: 'statement has:attachment' },
  { cat: 'finance', kind: 'scan', label: 'tax documents this year (1099 / receipts)', mi: { tool: 'search', args: { query: 'tax document 1099 receipt', limit: S } }, gmailQ: 'tax OR 1099 OR "tax document" newer_than:1y' },
  { cat: 'finance', kind: 'recall', label: 'warranty / proof of purchase for a product', mi: { tool: 'search', args: { query: 'warranty proof of purchase', limit: 5 } }, gmailQ: 'warranty OR "proof of purchase"' },
  { cat: 'finance', kind: 'scan', label: "a project/contractor's total cost across invoices", mi: { tool: 'search', args: { query: 'invoice project contractor', limit: S } }, gmailQ: 'invoice newer_than:6m' },
  { cat: 'finance', kind: 'scan', label: 'unpaid / overdue invoices in my inbox', mi: { tool: 'search', args: { query: 'overdue unpaid amount due', limit: S } }, gmailQ: 'overdue OR unpaid OR "amount due" newer_than:6m' },

  // ---- 3 · Logistics, travel & deliveries ----
  { cat: 'logistics', kind: 'recall', label: 'my next flight (time / terminal / code)', mi: { tool: 'search', args: { query: 'flight departure confirmation', limit: 5 } }, gmailQ: 'flight OR boarding' },
  { cat: 'logistics', kind: 'read', label: 'summarize my whole upcoming trip', mi: { tool: 'read-top', args: { query: 'trip itinerary flight hotel', limit: 1 } }, gmailQ: 'itinerary OR trip' },
  { cat: 'logistics', kind: 'recall', label: 'my hotel reservation (address / check-in)', mi: { tool: 'search', args: { query: 'hotel reservation check-in', limit: 5 } }, gmailQ: 'hotel OR reservation' },
  { cat: 'logistics', kind: 'recall', label: 'my car-rental / train / bus booking', mi: { tool: 'search', args: { query: 'car rental train booking', limit: 5 } }, gmailQ: 'rental OR train OR bus booking' },
  { cat: 'logistics', kind: 'recall', label: 'the status of an order from a retailer', mi: { tool: 'search', args: { query: 'order status shipped', limit: 5 } }, gmailQ: 'order OR shipped' },
  { cat: 'logistics', kind: 'recall', label: 'a package tracking number and carrier', mi: { tool: 'search', args: { query: 'tracking number carrier shipped', limit: 5 } }, gmailQ: 'tracking OR "tracking number"' },
  { cat: 'logistics', kind: 'scan', label: 'everything due to be delivered this week', mi: { tool: 'search', args: { query: 'out for delivery arriving', limit: S } }, gmailQ: 'delivery OR "out for delivery" newer_than:2w' },
  { cat: 'logistics', kind: 'recall', label: 'the boarding pass / e-ticket for a flight', mi: { tool: 'search', args: { query: 'boarding pass e-ticket', limit: 5 } }, gmailQ: 'boarding OR "e-ticket"' },
  { cat: 'logistics', kind: 'recall', label: 'whether a flight changed or got cancelled', mi: { tool: 'search', args: { query: 'flight change cancelled rebooked', limit: 5 } }, gmailQ: 'cancelled OR "schedule change" OR delayed' },
  { cat: 'logistics', kind: 'recall', label: 'seat / baggage / class info on a booking', mi: { tool: 'search', args: { query: 'seat baggage booking', limit: 5 } }, gmailQ: 'seat OR baggage' },
  { cat: 'logistics', kind: 'scan', label: 'all confirmations for an event / conference', mi: { tool: 'search', args: { query: 'registration confirmation event', limit: S } }, gmailQ: 'registration OR confirmation newer_than:6m' },
  { cat: 'logistics', kind: 'recall', label: 'rental / Airbnb check-in instructions', mi: { tool: 'search', args: { query: 'check-in instructions arrival', limit: 5 } }, gmailQ: 'check-in OR "checking in"' },
  { cat: 'logistics', kind: 'scan', label: 'my schedule of reservations next weekend', mi: { tool: 'search', args: { query: 'reservation booking confirmed', limit: S } }, gmailQ: 'reservation OR booking newer_than:2w' },
  { cat: 'logistics', kind: 'recall', label: 'event tickets (concert / game / theater)', mi: { tool: 'search', args: { query: 'tickets event admission', limit: 5 } }, gmailQ: 'tickets OR admission' },

  // ---- 4 · Summarization & catch-up ----
  { cat: 'summarize', kind: 'read', label: 'summarize this thread / where it stands', mi: { tool: 'read-top', args: { query: 'thread discussion update', limit: 1 } }, gmailQ: 'newer_than:3m' },
  { cat: 'summarize', kind: 'read', label: 'what decisions were made in this thread', mi: { tool: 'read-top', args: { query: 'decision agreed final', limit: 1 } }, gmailQ: 'decision OR agreed' },
  { cat: 'summarize', kind: 'read', label: 'what actions were suggested / assigned', mi: { tool: 'read-top', args: { query: 'action item next steps', limit: 1 } }, gmailQ: '"action item" OR "next steps"' },
  { cat: 'summarize', kind: 'read', label: 'TL;DR a long thread before I reply', mi: { tool: 'read-top', args: { query: 'long thread reply', limit: 1 } }, gmailQ: 'newer_than:1m' },
  { cat: 'summarize', kind: 'relational', label: 'what did I miss while away', mi: { tool: 'catch_up', args: { since: '7d' } }, gmailQ: 'newer_than:7d' },
  { cat: 'summarize', kind: 'scan', label: 'everything from a person this week', mi: { tool: 'search', args: { query: 'update message this week', limit: S } }, gmailQ: 'newer_than:1w' },
  { cat: 'summarize', kind: 'read', label: 'key points in a long email to act on', mi: { tool: 'read-top', args: { query: 'important please review', limit: 1 } }, gmailQ: 'important OR review' },
  { cat: 'summarize', kind: 'relational', label: "digest of today's inbox by priority", mi: { tool: 'catch_up', args: { since: '1d' } }, gmailQ: 'newer_than:1d' },
  { cat: 'summarize', kind: 'read', label: 'latest in a project thread since a date', mi: { tool: 'read-top', args: { query: 'project update latest', limit: 1 } }, gmailQ: 'project newer_than:1m' },
  { cat: 'summarize', kind: 'read', label: "summarize the back-and-forth, what's unresolved", mi: { tool: 'read-top', args: { query: 'open question pending', limit: 1 } }, gmailQ: 'pending OR unresolved' },
  { cat: 'summarize', kind: 'relational', label: 'which emails this week need a response', mi: { tool: 'catch_up', args: { since: '7d' } }, gmailQ: 'newer_than:7d -category:promotions' },
  { cat: 'summarize', kind: 'read', label: 'boil a newsletter down to one topic', mi: { tool: 'read-top', args: { query: 'newsletter featured topic', limit: 1 } }, gmailQ: 'newsletter' },

  // ---- 5 · Commitments, follow-ups & waiting-on ----
  { cat: 'commitments', kind: 'relational', label: 'what did I promise to do this week', mi: { tool: 'catch_up', args: { since: '7d' } }, gmailQ: 'newer_than:7d in:sent' },
  { cat: 'commitments', kind: 'relational', label: 'who is waiting on a reply from me', mi: { tool: 'catch_up', args: { since: '14d' } }, gmailQ: 'newer_than:14d -in:sent' },
  { cat: 'commitments', kind: 'relational', label: 'what am I waiting on from other people', mi: { tool: 'catch_up', args: { since: '14d' } }, gmailQ: 'newer_than:14d in:sent' },
  { cat: 'commitments', kind: 'scan', label: 'threads gone silent I should follow up on', mi: { tool: 'search', args: { query: 'following up checking in', limit: S } }, gmailQ: '"following up" OR "checking in" newer_than:3m' },
  { cat: 'commitments', kind: 'recall', label: 'whether someone got back to me on a topic', mi: { tool: 'search', args: { query: 'any update following up', limit: 5 } }, gmailQ: '"any update" OR "following up"' },
  { cat: 'commitments', kind: 'relational', label: 'open action items buried in email', mi: { tool: 'catch_up', args: { since: '14d' } }, gmailQ: 'newer_than:14d' },
  { cat: 'commitments', kind: 'scan', label: 'deadlines mentioned in recent mail', mi: { tool: 'search', args: { query: 'deadline due by EOD', limit: S } }, gmailQ: 'deadline OR "due by" newer_than:1m' },
  { cat: 'commitments', kind: 'recall', label: 'whether I confirmed / replied to an invite', mi: { tool: 'search', args: { query: 'rsvp confirm invitation', limit: 5 } }, gmailQ: 'rsvp OR invitation' },
  { cat: 'commitments', kind: 'scan', label: "commitments to a client I haven't delivered", mi: { tool: 'search', args: { query: 'will send deliver promised', limit: S } }, gmailQ: '"will send" OR "I will" newer_than:3m in:sent' },
  { cat: 'commitments', kind: 'scan', label: "emails I'm CC'd on that expect something", mi: { tool: 'search', args: { query: 'please action requested', limit: S } }, gmailQ: 'newer_than:1m' },
  { cat: 'commitments', kind: 'scan', label: "follow-ups I said I'd send 'next week'", mi: { tool: 'search', args: { query: 'next week will follow up', limit: S } }, gmailQ: '"next week" newer_than:2m in:sent' },
  { cat: 'commitments', kind: 'scan', label: 'unanswered questions directed at me', mi: { tool: 'search', args: { query: 'can you let me know question', limit: S } }, gmailQ: '"can you" OR "could you" newer_than:1m' },

  // ---- 6 · Scheduling & appointments ----
  { cat: 'scheduling', kind: 'recall', label: 'my appointment with someone (when / where)', mi: { tool: 'search', args: { query: 'appointment scheduled confirmed', limit: 5 } }, gmailQ: 'appointment' },
  { cat: 'scheduling', kind: 'scan', label: 'meetings confirmed by email this week', mi: { tool: 'search', args: { query: 'meeting invite calendar', limit: S } }, gmailQ: 'meeting OR invite newer_than:1w' },
  { cat: 'scheduling', kind: 'recall', label: 'the thread where we settled on a meeting time', mi: { tool: 'search', args: { query: 'works for me time meeting', limit: 5 } }, gmailQ: '"works for me" OR "how about"' },
  { cat: 'scheduling', kind: 'recall', label: 'the dial-in / link for an appointment', mi: { tool: 'search', args: { query: 'dial-in conference link', limit: 5 } }, gmailQ: 'dial-in OR "conference link" OR zoom' },
  { cat: 'scheduling', kind: 'recall', label: 'whether a date got finalized for an event', mi: { tool: 'search', args: { query: 'confirmed date finalized event', limit: 5 } }, gmailQ: 'confirmed OR finalized' },
  { cat: 'scheduling', kind: 'relational', label: 'cross-check invitations vs my calendar', mi: { tool: 'catch_up', args: { since: '14d' } }, gmailQ: 'invite OR meeting newer_than:14d' },
  { cat: 'scheduling', kind: 'recall', label: 'a reschedule / cancellation notice', mi: { tool: 'search', args: { query: 'rescheduled cancelled meeting', limit: 5 } }, gmailQ: 'rescheduled OR cancelled' },
  { cat: 'scheduling', kind: 'read', label: 'agenda / pre-read for an upcoming meeting', mi: { tool: 'read-top', args: { query: 'agenda pre-read meeting', limit: 1 } }, gmailQ: 'agenda' },

  // ---- 7 · Relationship & cross-thread context ----
  { cat: 'relationship', kind: 'scan', label: 'what I agreed with a client (pricing / scope)', mi: { tool: 'search', args: { query: 'agreed pricing scope terms', limit: S } }, gmailQ: 'agreed OR pricing OR scope newer_than:6m' },
  { cat: 'relationship', kind: 'relational', label: 'summarize my history with a contact', mi: { tool: 'list_contacts', args: { sort: 'engagement', limit: 25 } }, gmailQ: 'newer_than:6m' },
  { cat: 'relationship', kind: 'recall', label: 'the last thing a person and I discussed', mi: { tool: 'search', args: { query: 'last discussed update', limit: 5 } }, gmailQ: 'newer_than:3m' },
  { cat: 'relationship', kind: 'relational', label: 'who do I correspond with most', mi: { tool: 'list_contacts', args: { sort: 'engagement', limit: 25 } }, gmailQ: 'newer_than:6m' },
  { cat: 'relationship', kind: 'scan', label: 'what a person committed to in past emails', mi: { tool: 'search', args: { query: 'will commit promised agreed', limit: S } }, gmailQ: 'newer_than:6m' },
  { cat: 'relationship', kind: 'relational', label: 'context before a call with a contact', mi: { tool: 'catch_up', args: { since: '30d' } }, gmailQ: 'newer_than:30d' },
  { cat: 'relationship', kind: 'scan', label: 'status of a deal across all threads', mi: { tool: 'search', args: { query: 'deal proposal contract status', limit: S } }, gmailQ: 'deal OR proposal OR contract newer_than:6m' },
  { cat: 'relationship', kind: 'scan', label: 'whether a person mentioned a topic to me', mi: { tool: 'search', args: { query: 'mentioned regarding about', limit: S } }, gmailQ: 'newer_than:6m' },
  { cat: 'relationship', kind: 'scan', label: 'open issues between me and a vendor', mi: { tool: 'search', args: { query: 'issue concern outstanding', limit: S } }, gmailQ: 'issue OR concern newer_than:6m' },
  { cat: 'relationship', kind: 'scan', label: 'every email referencing a project / case number', mi: { tool: 'search', args: { query: 'project case reference number', limit: S } }, gmailQ: 'newer_than:6m' },
  { cat: 'relationship', kind: 'scan', label: 'history of complaints / requests from a customer', mi: { tool: 'search', args: { query: 'complaint request issue', limit: S } }, gmailQ: 'complaint OR request newer_than:6m' },
  { cat: 'relationship', kind: 'relational', label: 'which companies I have back-and-forth with', mi: { tool: 'list_contacts', args: { filter: 'correspondent', limit: 25 } }, gmailQ: 'newer_than:6m -category:promotions' },

  // ---- 8 · Account, security, admin & grounded replies ----
  { cat: 'account', kind: 'recall', label: 'the latest password-reset / 2FA / alert', mi: { tool: 'search', args: { query: 'password reset security code', limit: 5 } }, gmailQ: '"password reset" OR "security code"' },
  { cat: 'account', kind: 'scan', label: 'accounts with suspicious-login notices', mi: { tool: 'search', args: { query: 'suspicious login new device alert', limit: S } }, gmailQ: '"new sign-in" OR suspicious newer_than:6m' },
  { cat: 'account', kind: 'recall', label: 'a terms-of-service / privacy update', mi: { tool: 'search', args: { query: 'terms of service privacy update', limit: 5 } }, gmailQ: '"terms of service" OR "privacy policy"' },
  { cat: 'account', kind: 'scan', label: 'renewals / expirations coming up (domain / license)', mi: { tool: 'search', args: { query: 'expires renew expiration', limit: S } }, gmailQ: 'expires OR expiration OR renew newer_than:6m' },
  { cat: 'account', kind: 'recall', label: 'the welcome email with account details', mi: { tool: 'search', args: { query: 'welcome account getting started', limit: 5 } }, gmailQ: 'welcome OR "getting started"' },
  { cat: 'account', kind: 'read', label: 'draft a reply grounded in the thread', mi: { tool: 'read-top', args: { query: 'reply thread context', limit: 1 } }, gmailQ: 'newer_than:1m' },
  { cat: 'account', kind: 'read', label: 'write a follow-up referencing the last exchange', mi: { tool: 'read-top', args: { query: 'follow up previous email', limit: 1 } }, gmailQ: 'newer_than:1m in:sent' },
  { cat: 'account', kind: 'recall', label: 'whether a sender emailed me before', mi: { tool: 'search', args: { query: 'previous email history sender', limit: 5 } }, gmailQ: 'newer_than:1y' },
  { cat: 'account', kind: 'scan', label: 'whether an email is likely phishing / spam', mi: { tool: 'search', args: { query: 'verify account suspended urgent', limit: S } }, gmailQ: 'urgent OR verify OR suspended newer_than:3m' },
  { cat: 'account', kind: 'relational', label: 'senders I never open (unsubscribe candidates)', mi: { tool: 'list_contacts', args: { sort: 'engagement', limit: 25 } }, gmailQ: 'unsubscribe newer_than:6m' },
];

// ---- suites (category render order per suite) -----------------------------
const CATS_DEFAULT = [
  ['aggregate', 'A. Aggregation — "list all …" (read every match)'],
  ['recall', 'B. Recall — find one message'],
  ['read', 'C. Read one message in full'],
  ['relational', 'D. Relational — contacts / "what did I miss" (no Gmail primitive)'],
];
const CATS_INBOX100 = [
  ['retrieval', '1. Retrieval & refinding — find a known item'],
  ['finance', '2. Finance, invoices & purchases'],
  ['logistics', '3. Logistics, travel & deliveries'],
  ['summarize', '4. Summarization & catch-up'],
  ['commitments', '5. Commitments, follow-ups & waiting-on'],
  ['scheduling', '6. Scheduling & appointments'],
  ['relationship', '7. Relationship & cross-thread context'],
  ['account', '8. Account, security, admin & grounded replies'],
];
const SUITES = {
  default: { tasks: TASKS, label: 'common use cases', file: 'RESULTS-USECASES.md', cats: CATS_DEFAULT },
  inbox100: { tasks: INBOX_100, label: 'inbox questions', file: 'RESULTS-INBOX100.md', cats: CATS_INBOX100 },
};

const SCAN_SAMPLE = 8; // real gets sampled per scan to derive avg cost, then extrapolate

// ---- run ------------------------------------------------------------------

async function schemaTax(mcp) {
  const mi = await mcp.listTools();
  const miTools = mi.result.tools;
  const miTax = await countTokens(JSON.stringify(miTools));
  let gmailTax = null;
  let gmailCount = null;
  try {
    const g = JSON.parse(readFileSync(GMAIL_TOOLS_PATH, 'utf8'));
    const gTools = g.tools ?? g;
    gmailCount = gTools.length;
    gmailTax = await countTokens(JSON.stringify(gTools));
  } catch {
    /* no fixture — skip */
  }
  return { miCount: miTools.length, miTax, gmailCount, gmailTax };
}

async function runTask(mcp, t) {
  // ---- mail-index side: one (or two, for a read) compact calls ----
  let miText = '';
  let miCalls = 0;
  if (t.mi.tool === 'read-top') {
    const s = await mcp.call('search', t.mi.args);
    miCalls++;
    const stext = toolResultText(s);
    miText += stext;
    const ref = (JSON.parse(stext).hits ?? [])[0]?.ref;
    if (ref) {
      const m = await mcp.call('get_message', { ref, level: 'body' });
      miCalls++;
      miText += toolResultText(m);
    }
  } else {
    const r = await mcp.call(t.mi.tool, t.mi.args);
    miCalls++;
    miText = toolResultText(r);
  }
  const miTok = await countTokens(miText);
  const miHits = safeHitCount(miText);

  // ---- gmail side: real payloads ----
  let gmailTok;
  let gmailCalls;
  let note = '';

  if (t.kind === 'scan' || t.kind === 'relational') {
    // SCAN/RELATIONAL: to ANSWER, the agent must read EVERY match. Gmail list
    // returns ids only, so cost = list + get×(matchN). (For relational tasks —
    // top contacts, "what did I miss" — Gmail has no primitive, so it must scan
    // + aggregate the mailbox; same cost model.) We fetch a real sample for avg
    // get-cost, then extrapolate to the match count (metadata format — generous
    // to Gmail; full would be ~2.5× worse).
    const listRaw = await gmailList(t.gmailQ, 200);
    const ids = (JSON.parse(listRaw).messages ?? []).map((m) => m.id);
    const matchN = ids.length;
    const sampleIds = ids.slice(0, Math.min(SCAN_SAMPLE, matchN));
    let sampleTok = 0;
    for (const id of sampleIds) sampleTok += await countTokens(await gmailGet(id, 'metadata'));
    const avgGet = sampleIds.length ? sampleTok / sampleIds.length : 0;
    const listTok = await countTokens(listRaw);
    gmailTok = Math.round(listTok + avgGet * matchN);
    gmailCalls = 1 + matchN; // 1 list + one get per match
    note = `${matchN} matches × ~${Math.round(avgGet)} tok/get (sampled ${sampleIds.length}, extrapolated)`;
  } else {
    let gmailText = '';
    gmailCalls = 0;
    const listRaw = await gmailList(t.gmailQ, 10);
    gmailCalls++;
    gmailText += listRaw;
    const ids = (JSON.parse(listRaw).messages ?? []).map((m) => m.id);
    if (t.kind === 'read') {
      if (ids[0]) {
        gmailText += await gmailGet(ids[0], 'full');
        gmailCalls++;
      }
    } else {
      // recall: identify the answer among hits — top-3 metadata gets (generous).
      for (const id of ids.slice(0, 3)) {
        gmailText += await gmailGet(id, 'metadata');
        gmailCalls++;
      }
    }
    gmailTok = await countTokens(gmailText);
  }

  return { cat: t.cat, label: t.label, kind: t.kind, miCalls, miTok, miHits, gmailCalls, gmailTok, note };
}

function safeHitCount(text) {
  try {
    const o = JSON.parse(text);
    return (o.hits ?? o.matches ?? o.results ?? []).length || null;
  } catch {
    return null;
  }
}

function resolveConfigDir(account) {
  const cfgPath = join(
    process.env.XDG_CONFIG_HOME || join(process.env.HOME, '.config'),
    'mail-index',
    'config.json',
  );
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  const a = cfg.accounts?.[account];
  if (!a) throw new Error(`account "${account}" not in ${cfgPath}`);
  return a.configDir.replace(/^~(?=$|\/)/, process.env.HOME);
}

function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      out[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') || argv[i + 1] == null ? true : argv[++i];
    }
  }
  return out;
}

async function main() {
  const suite = SUITES[args.suite] ?? SUITES.default;
  const N = suite.tasks.length;

  const mcp = mcpSession();
  await mcp.init();

  const tax = await schemaTax(mcp);
  const rows = [];
  for (const t of suite.tasks) rows.push(await runTask(mcp, t));
  mcp.close();

  const sumMi = rows.reduce((a, r) => a + r.miTok, 0);
  const sumGm = rows.reduce((a, r) => a + r.gmailTok, 0);
  const ratio = (g, m) => (m > 0 ? (g / m).toFixed(1) + '×' : '—');

  // Task labels are generic and token counts carry no message content, so the
  // table is COMMITTABLE (bench/RESULTS-*.md). Grouped by category.
  const CATS = suite.cats;
  const lines = [];
  lines.push(`# ${N} ${suite.label} — mail-index vs a stock Gmail-API MCP (token cost)`);
  lines.push('');
  lines.push(`Tokens an agent's context pays to **answer** each question. Account \`${ACCOUNT}\` · token count: ${COUNT_MODE} · reproduce: \`node bench/run.mjs${args.suite === 'inbox100' ? ' --suite inbox100' : ''}\`.`);
  lines.push('');
  lines.push('**Fixed schema tax** (every turn): mail-index ' + `${tax.miTax} tok (${tax.miCount} tools)` + (tax.gmailTax != null ? ` · stock Gmail MCP ${tax.gmailTax} tok (${tax.gmailCount} tools)` : '') + '.');
  lines.push('');
  for (const [cat, title] of CATS) {
    const group = rows.filter((r) => r.cat === cat);
    if (!group.length) continue;
    const gMi = group.reduce((a, r) => a + r.miTok, 0);
    const gGm = group.reduce((a, r) => a + r.gmailTok, 0);
    lines.push(`## ${title}`);
    lines.push('');
    lines.push('| Use case | mail-index (calls / tok) | Gmail MCP (calls / tok) | Savings |');
    lines.push('|---|--:|--:|--:|');
    for (const r of group)
      lines.push(`| ${r.label} | ${r.miCalls} / ${r.miTok.toLocaleString()} | ${r.gmailCalls} / ${r.gmailTok.toLocaleString()} | ${ratio(r.gmailTok, r.miTok)} |`);
    lines.push(`| **subtotal (${group.length})** | **${gMi.toLocaleString()}** | **${gGm.toLocaleString()}** | **${ratio(gGm, gMi)}** |`);
    lines.push('');
  }
  lines.push(`## Overall (${rows.length} ${suite.label})`);
  lines.push('');
  lines.push('| | mail-index | Gmail MCP | Savings |');
  lines.push('|---|--:|--:|--:|');
  lines.push(`| total tokens to answer | **${sumMi.toLocaleString()}** | **${sumGm.toLocaleString()}** | **${ratio(sumGm, sumMi)}** |`);
  lines.push('');
  lines.push('> Gmail cost model (generous to Gmail): recall = list + top-3 metadata gets; read = 1 full get; aggregate/relational = list + one *metadata* get per match (sampled avg × match count; full payloads are ~2.5× heavier). Gmail `list` returns ids only, so every match must be fetched to be read. Relational tasks (top contacts, "what did I miss") have no Gmail primitive — the agent must scan + aggregate the mailbox; mail-index answers from precomputed structure in one compact call. Match counts cap at the Gmail API page size, so large aggregations are *under*-counted for Gmail.');
  writeFileSync(join(HERE, suite.file), lines.join('\n') + '\n');

  // stdout summary
  console.log(`\n=== ${N} ${suite.label} — mail-index vs stock Gmail-API MCP (tokens to answer) ===`);
  console.log(`token count: ${COUNT_MODE}`);
  console.log(`schema tax:   mail-index ${tax.miTax} tok (${tax.miCount} tools)` + (tax.gmailTax != null ? `  vs Gmail ${tax.gmailTax} tok (${tax.gmailCount} tools)` : ''));
  for (const [cat, title] of CATS) {
    const g = rows.filter((r) => r.cat === cat);
    if (!g.length) continue;
    const gMi = g.reduce((a, r) => a + r.miTok, 0);
    const gGm = g.reduce((a, r) => a + r.gmailTok, 0);
    console.log(`  ${title.split('—')[0].trim().padEnd(16)} (${g.length})  mail-index ${gMi.toLocaleString().padStart(7)} tok  vs Gmail ${gGm.toLocaleString().padStart(9)} tok  → ${ratio(gGm, gMi)}`);
  }
  console.log(`OVERALL (${rows.length}):  mail-index ${sumMi.toLocaleString()} tok  vs Gmail ${sumGm.toLocaleString()} tok  →  ${ratio(sumGm, sumMi)} less`);
  console.log(`committable table → bench/${suite.file}`);
}

main().catch((e) => {
  console.error('bench failed:', e.message);
  process.exit(1);
});
