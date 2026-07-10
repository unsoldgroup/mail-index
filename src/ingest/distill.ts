/**
 * Body distillation (SCOPE 1.1, PLAN §7 phase 2, CONTEXT.md "Enrichment",
 * ADR-0003). Turns a raw provider {@link MessageFull} body into the compact,
 * plain-text form the index stores — bodies are ALWAYS stored DISTILLED; raw
 * provider bytes are never persisted.
 *
 * This is the SIZE LEVER of the whole index: a newsletter's HTML body is mostly
 * markup, tracking pixels, and footer chrome; distilling it down to its real
 * prose is what keeps a full mailbox a few tens of MB. Everything here is
 * deterministic and dependency-free (no DOM, no network, no clock) so it stays
 * unit-testable and cheap — a small hand-rolled stripper, per the project's
 * no-heavy-deps rule.
 *
 * Pipeline ({@link distill}):
 *   1. Pick the source: prefer `bodyText` when the provider supplied one;
 *      otherwise strip `bodyHtml` to text.
 *   2. De-boilerplate: drop quoted reply history (`>` lines, "On … wrote:",
 *      gmail_quote blocks), signatures, and unsubscribe/list footers.
 *   3. Normalise whitespace so the result is stable and compact.
 *
 * The distiller is conservative about REAL content: it removes structurally
 * recognisable boilerplate, not arbitrary prose, so the message's actual body
 * survives while quotes/sigs/footers go.
 */

/**
 * Invisible code points that pad body text but carry no prose meaning (soft
 * hyphen, zero-width spaces/joiners, BOM, word joiner). These arrive via
 * quoted-printable bytes (e.g. `=E2=80=8B` → U+200B) or HTML entities
 * (`&shy;`, `&zwnj;`, `&#8203;`) and would otherwise inflate the distilled
 * text. Mirrors {@link meaningfulTextLength}'s set so OCR/image-only detection
 * and distillation agree on what counts as "no text". Stripped via numeric
 * code points (not a literal regex char class) to satisfy the lint rules
 * no-irregular-whitespace / no-misleading-character-class.
 */
const INVISIBLE_CODEPOINTS = new Set<number>([
  0x00ad, // soft hyphen (&shy;)
  0x034f, // combining grapheme joiner
  0x200b, 0x200c, 0x200d, 0x200e, 0x200f, // zero-width space/joiners/marks (&zwnj; = 200c)
  0x2060, // word joiner
  0xfeff, // BOM / zero-width no-break space
]);

/** Drop invisible/zero-width code points (via numeric Set, never a literal
 * regex char class — keeps eslint no-irregular-whitespace happy). */
function stripInvisibles(s: string): string {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp != null && INVISIBLE_CODEPOINTS.has(cp)) continue;
    out += ch;
  }
  return out;
}

/**
 * Decode quoted-printable transfer encoding (RFC 2045 §6.7) in a body string:
 * remove soft line breaks (`=` at end of line) and decode `=XX` hex escapes.
 * Runs of consecutive `=XX` are collected into a byte buffer and decoded as
 * one UTF-8 sequence, so multibyte characters (e.g. `=E2=80=93` → "–") come
 * back correctly rather than as three mojibake bytes. Bytes that don't form
 * valid UTF-8 are left as their raw `=XX` token (conservative: never corrupts
 * text that merely contains a stray `=`).
 */
export function decodeQuotedPrintable(s: string): string {
  // Soft line breaks: an `=` immediately before CRLF/LF is a wrap artefact.
  const t = s.replace(/=\r?\n/g, '');

  // Both options at their spec defaults; spelled out because workers-types
  // (the Cloudflare worker build shares this module) declares them required.
  const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: false });
  // Match one or more consecutive =XX escapes and decode them together.
  return t.replace(/(?:=[0-9A-Fa-f]{2})+/g, (run) => {
    const bytes = new Uint8Array(run.length / 3);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(run.slice(i * 3 + 1, i * 3 + 3), 16);
    }
    return decoder.decode(bytes);
  });
}

/**
 * Does this body look quoted-printable? We only QP-decode when there's a strong
 * signal, so a plain-text body that merely contains `=42` ("result=42") is never
 * mangled into `resultB`. The hallmarks of real QP that don't occur in ordinary
 * prose: a soft line break (`=` at end of line) or a run of >=2 consecutive
 * `=XX` escapes (the shape of a QP-encoded multibyte char). The provider strips the
 * `Content-Transfer-Encoding` header before we see the body, so this heuristic
 * stands in for it — conservatively biased toward NOT decoding.
 */
export function looksQuotedPrintable(s: string): boolean {
  // A soft line break, or a run of >=2 consecutive =XX (the shape of a
  // QP-encoded multibyte char, e.g. =E2=80=93). A lone =42 matches neither.
  return /=\r?\n/.test(s) || /(?:=[0-9A-Fa-f]{2}){2,}/.test(s);
}

/** QP-decode only when the body actually looks quoted-printable. */
function maybeDecodeQuotedPrintable(s: string): string {
  return looksQuotedPrintable(s) ? decodeQuotedPrintable(s) : s;
}

/** Strip HTML to plain text: remove script/style/head, drop tags, decode
 * entities, and turn block-level boundaries into line breaks. Deterministic and
 * dependency-free. */
export function htmlToText(html: string): string {
  let s = html;

  // Remove whole non-content elements (and their contents) first.
  s = s.replace(/<!--[\s\S]*?-->/g, ' '); // comments
  s = s.replace(/<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');

  // Tracking pixels / spacer images and standalone media leave no text — the
  // tag removal below already drops them, but normalise <br> and block edges to
  // newlines so paragraph structure survives as line breaks.
  s = s.replace(/<\s*br\s*\/?\s*>/gi, '\n');
  s = s.replace(/<\s*\/\s*(p|div|tr|li|h[1-6]|table|ul|ol|blockquote|section|article|header|footer)\s*>/gi, '\n');
  s = s.replace(/<\s*(p|div|tr|li|h[1-6]|table|ul|ol|blockquote|section|article|header|footer)\b[^>]*>/gi, '\n');

  // Drop every remaining tag.
  s = s.replace(/<[^>]+>/g, '');

  // Decode the handful of entities that actually matter for prose.
  s = decodeEntities(s);

  return s;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  copy: '©',
  reg: '®',
  trade: '™',
  middot: '·',
  bull: '•',
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  sbquo: '‚',
  bdquo: '„',
  laquo: '«',
  raquo: '»',
  deg: '°',
  euro: '€',
  pound: '£',
  cent: '¢',
  yen: '¥',
  sect: '§',
  para: '¶',
  dagger: '†',
  Dagger: '‡',
  permil: '‰',
  prime: '′',
  Prime: '″',
  // Decode to invisible code points; {@link stripInvisibles} then removes them.
  shy: '­', // soft hyphen
  zwnj: '‌', // zero-width non-joiner
  zwj: '‍', // zero-width joiner
  lrm: '‎', // left-to-right mark
  rlm: '‏', // right-to-left mark
};

/**
 * Decode named + numeric HTML entities relevant to prose, then drop any
 * invisible code points the decode produced (e.g. `&shy;`, `&zwnj;`,
 * `&#8203;`). Stripping happens here so a single decode pass cleans both the
 * named and numeric forms of zero-width padding.
 */
function decodeEntities(s: string): string {
  const decoded = s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (m, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
  return stripInvisibles(decoded);
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/** Whether a decoded entity value is made up only of invisible code points. */
function isAllInvisible(value: string): boolean {
  if (value === '') return false;
  for (const ch of value) {
    const cp = ch.codePointAt(0);
    if (cp == null || !INVISIBLE_CODEPOINTS.has(cp)) return false;
  }
  return true;
}

/**
 * Remove ONLY invisible-padding entities (`&shy;`, `&zwnj;`, `&#8203;`, …) and
 * raw invisible code points from a string, leaving every *visible* entity
 * (`&amp;`, `&lt;`, `&#39;`, …) untouched. Used on the text/plain path: a genuine
 * plain-text body must keep its literal `&amp;`/`<tag>` — those are content, not
 * markup — but preview-text padding made of zero-width entities should still go.
 */
function stripPaddingEntities(s: string): string {
  const decoded = s
    .replace(/&#x([0-9a-f]+);/gi, (m, hex: string) =>
      INVISIBLE_CODEPOINTS.has(parseInt(hex, 16)) ? '' : m,
    )
    .replace(/&#(\d+);/g, (m, dec: string) => (INVISIBLE_CODEPOINTS.has(parseInt(dec, 10)) ? '' : m))
    .replace(/&([a-z]+);/gi, (m, name: string) => {
      const value = NAMED_ENTITIES[name.toLowerCase()];
      return value !== undefined && isAllInvisible(value) ? '' : m;
    });
  return stripInvisibles(decoded);
}

/**
 * Markers that begin quoted reply history. A line matching one of these (and
 * everything after it) is dropped — the quoted thread is already its own
 * indexed Message, so re-storing it bloats the index and poisons FTS ranking.
 */
const QUOTE_HEADER_PATTERNS: RegExp[] = [
  // "On Tue, 28 May 2024 at 14:40, Jordan <…> wrote:" and locale variants.
  /^\s*On\b.*\bwrote:\s*$/i,
  // "On Tue, 28 May 2024, Jordan wrote:" without "at".
  /^\s*On\b.*,.*\bwrote:\s*$/i,
  // Outlook-style "-----Original Message-----".
  /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/i,
  // "From: …" block that Outlook prepends to quoted replies.
  /^\s*From:\s.+$/i,
];

/**
 * Markers that begin a signature block. A line matching one of these (and
 * everything after it) is dropped.
 */
const SIGNATURE_PATTERNS: RegExp[] = [
  // The conventional "-- " sig delimiter (RFC 3676), with or without trailing space.
  /^--\s*$/,
];

/**
 * Markers that begin a list/unsubscribe/footer block — common newsletter
 * chrome. A line matching one of these (and everything after it) is dropped.
 */
const FOOTER_PATTERNS: RegExp[] = [
  /\bunsubscribe\b/i,
  /\bupdate (your )?(email )?preferences\b/i,
  /\bmanage (your )?(email )?(subscription|preferences)\b/i,
  /\bview (this email )?in (your )?browser\b/i,
  /\byou (are )?receiv(e|ing) this (email|message)\b/i,
  /\bsent to you by\b/i,
  /^\s*©\s*\d{4}\b/,
  /\ball rights reserved\b/i,
];

/** A line that is just a quote prefix (`>`), optionally repeated/nested. */
const QUOTE_LINE = /^\s*>+/;

/**
 * Remove quoted reply history, signatures, and footers from already-plain text.
 * The strategy is line-based and truncating: once a quote-header / signature /
 * footer marker is hit, everything from that line onward is dropped (these
 * blocks always sit at the tail of a real message). Standalone `>`-quoted lines
 * are also dropped even when interleaved.
 */
export function deboilerplate(text: string): string {
  const lines = text.split('\n');
  const kept: string[] = [];

  for (const line of lines) {
    // A quoted-history header, a signature delimiter, or a footer marker ends
    // the real content — stop here.
    if (QUOTE_HEADER_PATTERNS.some((re) => re.test(line))) break;
    if (SIGNATURE_PATTERNS.some((re) => re.test(line))) break;
    if (FOOTER_PATTERNS.some((re) => re.test(line))) break;
    // A bare quoted line (`> …`) is reply history — skip it but keep scanning.
    if (QUOTE_LINE.test(line)) continue;
    kept.push(line);
  }

  return kept.join('\n');
}

/** Collapse runs of blank lines and trailing whitespace into a stable, compact form. */
export function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n') // CRLF / CR → LF
    .replace(/[ \t\u00A0]+/g, " ") // runs of spaces/tabs/nbsp -> single space
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n') // collapse 3+ blank lines to one
    .trim();
}

/** Minimal subset of {@link MessageFull} the distiller needs. */
export interface DistillInput {
  bodyText: string | null;
  bodyHtml: string | null;
  mimeType?: string | null;
}

/**
 * Distil a raw provider body into compact plain text for storage. Prefers
 * `bodyText` when present; otherwise strips `bodyHtml`. Always de-boilerplates
 * and normalises. Returns an empty string when there is no usable body (the
 * caller still records the enrichment; a bodyless message just has no body
 * text).
 */
export function distill(input: DistillInput): string {
  let source: string;
  if (input.bodyText && input.bodyText.trim() !== '') {
    // Plain-text path: QP-decode ONLY when the body looks quoted-printable (so a
    // literal `=42` survives), and strip ONLY invisible-padding entities — a real
    // plain-text body's `&amp;`/`<tag>` are content and must stay literal. The
    // HTML path below does full entity decoding inside htmlToText (entities are
    // markup there).
    source = stripPaddingEntities(maybeDecodeQuotedPrintable(input.bodyText));
  } else if (input.bodyHtml) {
    // QP-decode BEFORE HTML stripping (only when it looks QP) so soft line breaks
    // that split tags/words (`o=\n ur` → `our`) and multibyte `=XX` escapes are
    // resolved before tags and entities are processed.
    source = htmlToText(maybeDecodeQuotedPrintable(input.bodyHtml));
  } else {
    source = '';
  }

  return normalizeWhitespace(deboilerplate(source));
}
