/** Tokenization, stemming, identifier extraction, sentence splitting.
 *
 * Lexical normalization only — no embeddings, no model calls (spec NTK-002/003).
 */
import natural from "natural";

const porter = natural.PorterStemmer as unknown as { stem: (w: string) => string };
// natural v8 exports the English stopword list as a plain array; v7 had a
// Stopwords class. Support both shapes.
const swExport = (natural as unknown as Record<string, unknown>).stopwords;
const swClass = (natural as unknown as Record<string, unknown>).Stopwords as
  | (new (lang: string) => { getWords: () => string[] })
  | undefined;
const enWords: string[] = Array.isArray(swExport)
  ? (swExport as string[])
  : swClass
    ? new swClass("en").getWords()
    : [];
const stoplist = new Set<string>();
for (const w of enWords) {
  stoplist.add(w);
  // Content words are checked in stem form ("are" → "ar"), so index the
  // stemmed spelling as well.
  stoplist.add(porter.stem(w));
}
// A few extra terms that appear constantly in these docs and carry no signal.
for (const w of ["doc", "docs", "document", "documentation", "page", "file", "use", "using", "new", "one", "two", "project", "section"]) {
  stoplist.add(w);
  stoplist.add(porter.stem(w));
}

export function stem(word: string): string {
  const w = word.toLowerCase();
  const s: string = porter.stem(w) ?? w;
  // Porter over-strips two classes we need stable for corpus terms:
  // "-ine" nouns ("pipeline" → "pipelin") and final-y adjectives
  // ("wibbly" → "wibbl"). Restore the canonical (y→i) form.
  if (w.length >= 5 && s === w.slice(0, -1)) {
    if (/ine$/.test(w)) return w;
    if (/[bcdfghjklmnpqrstvwxz]y$/.test(w)) return s + "i";
  }
  return s;
}

export function isStopword(stemmed: string): boolean {
  return stoplist.has(stemmed) || stemmed.length <= 1;
}

const WORD_RE = /[\p{L}\p{N}]+(?:['’_-][\p{L}\p{N}]+)*/gu;
const IDENT_RE =
  /\b(?:[A-Za-z][A-Za-z0-9_$]*(?:[.-][A-Za-z][A-Za-z0-9_$]*)+|[a-z][a-z0-9]*(?=[A-Z])[A-Za-z0-9_$]*|[A-Za-z][a-z0-9]+(?:_[a-zA-Z0-9]+)+|[A-Z][A-Za-z0-9]{2,}|[\w$./-]+\.(?:java|kt|kts|xml|md|mdx|txt|adoc|json|yaml|yml|ts|tsx|js|properties))\b/g;

/** Words of a text, lowercased (raw, unstemmed). */
export function words(text: string): string[] {
  return text.toLowerCase().match(WORD_RE) ?? [];
}

/** Alias used by the fire gate: raw lowercased word tokens. */
export function tokenize(text: string): string[] {
  return words(text);
}

/**
 * Ordinal heading selector (Phase-2 structural signal): a query word directly
 * followed by a digit ("what is in phase 2") is title-citation evidence for
 * numbered sibling sections — the bare digit is a 1-char stopword and the
 * word stem ties every sibling, so without the pair "phase 1/2/3" are
 * indistinguishable and the tiebreak takes the earlier section.
 */
export function ordinalSelectors(text: string): Array<{ word: string; num: string }> {
  // "phase-2" is one WORD_RE token; make it word-adjacent-digit.
  const ws = words(text.replace(/(\p{L})-(?=\d)/gu, "$1 "));
  const out: Array<{ word: string; num: string }> = [];
  for (let i = 0; i + 1 < ws.length; i++) {
    const w = ws[i]!;
    const d = ws[i + 1]!;
    if (!/^\d{1,2}$/.test(d)) continue;
    if (!/\p{L}/u.test(w)) continue; // digit-digit ("11.3") is not a word
    const s = stem(w);
    if (w.length < 2 || isStopword(s)) continue;
    out.push({ word: s, num: d });
  }
  return out;
}

/** Content words: lowercased, stemmed, stopwords and 1-char removed. */
export function contentWords(text: string): string[] {
  const out: string[] = [];
  for (const w of words(text)) {
    const s = stem(w);
    if (!isStopword(s)) out.push(s);
  }
  return out;
}

/** Identifier-like tokens: class/method names, dotted paths, file names,
 *  camelCase/snake_case parts. Kept unstemmed; these drive code↔doc matching. */
export function identifiers(text: string): string[] {
  const out = new Set<string>();
  const idents = text.match(IDENT_RE) ?? [];
  for (const raw of idents) {
    const t = raw.replace(/[.,;:]+$/, "");
    out.add(t.toLowerCase());
    if (t.includes(".")) {
      for (const seg of t.split(".")) out.add(seg.toLowerCase());
    }
    // camelCase / snake_case decomposition
    for (const part of t
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .split(/[^A-Za-z0-9]+/)) {
      if (part.length >= 3) out.add(part.toLowerCase());
    }
  }
  // Inline code spans often contain identifiers the regex misses.
  for (const m of text.matchAll(/`([^`\n]{2,60})`/g)) {
    const inner = m[1]!;
    if (/^[A-Za-z][A-Za-z0-9_$.]*$/.test(inner) && /[A-Z_.]/.test(inner)) {
      out.add(inner.toLowerCase());
      for (const seg of inner.split(/[._]/)) if (seg.length >= 3) out.add(seg.toLowerCase());
    }
  }
  return [...out];
}

/** Full identifier tokens ONLY (no camel/snake/dot decomposition): the
 *  evidence form of `identifiers` for gate overrides. Requires a code-shape
 *  marker (dotted, snake, camel hump, file extension) so prose capitalized
 *  words ("Python", "MacOS" fragments) are not evidence; decomposition
 *  fragments are scoring vocabulary, not references. */
export function identifiersExact(text: string): string[] {
  const out = new Set<string>();
  for (const raw of text.match(IDENT_RE) ?? []) {
    const t = raw.replace(/[.,;:]+$/, "");
    if (t.length < 5) continue;
    if (!/[._]/.test(t) && !/[a-z0-9][A-Z]/.test(t) && !/\.[a-z]+$/i.test(t)) continue;
    out.add(t.toLowerCase());
  }
  for (const m of text.matchAll(/`([^`\n]{2,60})`/g)) {
    const inner = m[1]!;
    if (/^[A-Za-z][A-Za-z0-9_$]*$/.test(inner) && /[A-Z_.]/.test(inner) && inner.length >= 5)
      out.add(inner.toLowerCase());
  }
  return [...out];
}

/**
 * Paste isolation: when a large pasted block (menu, log, captured output) is
 * followed by a clear short question, the QUESTION is the request — the paste
 * is data. Conservative and structural (no vocabulary lists): fires only on
 * >=400 chars, a short question mark-terminated as the LAST line, paste bulk
 * >=60% of the text, paste "shape" (>=4 ellipsis separators of captured
 * blocks — multi-paragraph prose is the user's own task, never excised),
 * 3..16 content terms in the question, no fenced code (a question ABOUT
 * pasted code keeps the paste), no deictic reference to the paste
 * ("why does this code ..."). Returns the question + cited 《titles》 +
 * exact identifiers, or null to keep the whole text.
 */
export function isolatePastedRequest(text: string): string | null {
  if (text.length < 400) return null;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length < 2) return null;
  const question = lines[lines.length - 1]!;
  if (!/\?\s*["'”’)\]]*\s*$/.test(question) || question.length > 200) return null;
  const paste = lines.slice(0, -1).join("\n");
  if (paste.length < text.length * 0.6) return null;
  // Paste shape: captured blocks arrive as delimited fragments (the "…"
  // separators of a copied menu/output). Multi-paragraph prose is the user's
  // own task description — P0-7 spans handle it; never excise it.
  if ((paste.match(/…|\.{3}/g) ?? []).length < 4) return null;
  const contentTerms = (s: string): string[] => {
    const out = new Set<string>();
    for (const w of words(s))
      for (const p of w.split("-")) {
        const st = stem(p);
        if (p.length >= 2 && !isStopword(st)) out.add(st);
      }
    return [...out];
  };
  const qt = contentTerms(question);
  if (qt.length < 3 || qt.length > 16) return null;
  // (c) code bulk: a fenced block is content the user is asking ABOUT —
  // legitimate "why does this crash?" flow: stay whole-query. (An identifier
  // density rule was measured and removed: a UI menu's camelCase token dump
  // reads as code, which is exactly the paste this function must isolate.)
  if (/```/.test(paste)) return null;
  // (d) deictic question (about the paste) — keep the paste
  if (/\b(this|that|these|those|above|following|it)\b.{0,25}\b(code|error|output|log|logs|snippet|excerpt|message|content|text|paste|trace|function|file|list|block|section)\b/i.test(question))
    return null;
  const titles = [...paste.matchAll(/《([^》]{2,60})》/g)].map((m) => m[1]!.trim());
  const idents = identifiersExact(paste).slice(0, 8);
  const keep = [question, ...titles, ...idents].join(" ");
  return keep.length >= 8 ? keep : null;
}

/** Jaro-Winkler similarity (near-duplicate / fuzzy token checks). */
export function similarity(a: string, b: string): number {
  return (
    natural as unknown as { JaroWinklerDistance: (x: string, y: string) => number }
  ).JaroWinklerDistance(a, b);
}

/** SHA-256 hex of a buffer/string (for instruction dedupe and cache keys). */
export async function sha256(text: string | Buffer): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(text).digest("hex");
}

const HEURISTIC_TOKENS_PER_CHAR = 1 / 3.0;
export function estimateTokens(text: string): number {
  return Math.ceil(text.length * HEURISTIC_TOKENS_PER_CHAR);
}

/** Split prose into sentences at .!?/。！？ boundaries, conservatively:
 *  protects common abbreviations, decimals, and ellipses. */
const ABBREV_RE =
  /\b(?:e\.g|i\.e|etc|vs|Dr|Mr|Mrs|Ms|No|Fig|approx|cf|Inc|Ltd|St|v|Jr|Sr|et al)\.$/i;

/** Does `probe` (text-so-far, ellipses stripped) end on a sentence boundary? */
function isBoundary(probe: string): boolean {
  const t = probe.trimEnd();
  if (!/[.!?。！？]["')\]】」』”’]?$/.test(t)) return false;
  if (ABBREV_RE.test(t)) return false;
  if (/(?:\d\.\d*|\.\w)$/.test(t)) return false; // decimals, "v2.", versions
  if (/(?:^|\s)[A-Za-z]\.$/.test(t)) return false; // middle initials "J."
  return true;
}

export function sentences(text: string): string[] {
  let cleaned = text.replace(/\.{3,}/g, "…").replace(/。{2,}/g, "…");
  // CJK sentences often run inline with no spacing; give each terminator
  // its own line so the line loop below sees it as a boundary.
  cleaned = cleaned.replace(/([。！？])(?=\S)/g, "$1\n");
  const out: string[] = [];
  let buf = "";
  const flush = () => {
    const s = buf.trim();
    buf = "";
    if (!s) return;
    // English prose runs many sentences per line; split at mid-line
    // terminators too, at whitespace-token granularity.
    let cur = "";
    for (const tok of s.split(/(\s+)/)) {
      cur += tok;
      if (tok.trim() && isBoundary(cur.replace(/…/g, ""))) {
        out.push(cur.trim());
        cur = "";
      }
    }
    if (cur.trim()) out.push(cur.trim());
  };
  for (const line of cleaned.split("\n")) {
    if (!line.trim()) {
      flush(); // paragraph boundary: a blank line ends the accumulated prose
      continue;
    }
    // Accumulate the paragraph: hard-wrapped sentences must join into one
    // unit (a per-line flush would cut every wrapped sentence at the wrap).
    buf += (buf ? " " : "") + line.trim();
  }
  flush();
  return out.map((p) => p.replace(/…/g, "...")).filter((p) => p.length > 0);
}
