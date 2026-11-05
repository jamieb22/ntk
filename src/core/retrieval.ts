/**
 * NTK core retrieval pipeline (NTK-016: runs on every applicable model
 * dispatch; there is no phrasing-based firing classifier):
 *
 * query terms → PMI expansion → BM25 search → native exclusion
 * → score gate + content gate → inclusion level → compression
 * → token budget → render.
 *
 * All thresholds live in RetrievalOptions so tuning experiments can dial
 * them. Withholding is decided by the retrieval gates themselves: the
 * absolute score floor (minScore) and the content gate (user-term coverage,
 * optional rare-term IDF floor) — queries with no qualifying documentation
 * return zero items, and the plugin injects nothing.
 */
import type { NTKIndex } from "../index-store.js";
import type {
  ContextItem,
  InclusionLevel,
  RetrievalContext,
  RetrievalOptions,
  RetrievalResult,
  RetrievalTrace,
  SectionRecord,
} from "./types.js";
import { compressSection, DEFAULT_COMPRESS } from "./compress.js";
import { expandQuery, queryTerms as stemQueryTerms } from "./expansion.js";
import { identifiers, identifiersExact, isStopword, ordinalSelectors, stem, tokenize, words } from "./tokenize.js";

export type {
  ContextItem,
  RetrievalOptions,
  RetrievalResult,
  RetrievalTrace,
} from "./types.js";

/** Retrieval options with every knob present (the DEFAULTS shape). */
export type RequiredRetrievalOptions = Required<RetrievalOptions>;

/** Dev-only overrides for tuning experiments (NTK_* env); unset in normal
 *  operation — selection thresholds stay internal, benchmarked defaults.
 *  `min` is parameter-specific: dials with 0 = off semantics (headingBonus,
 *  minCoverage, minRareIdf, minScore, threshold, expansionTermWeight,
 *  redundancyMax) accept 0 so ablation runs can disable them — the old
 *  `v > 0` check silently fell back to defaults, which corrupted zero-vs-
 *  nonzero benchmark comparisons (P0 audit). Structural dials (counts and
 *  budgets) require ≥ 1. (minSegTerms is the exception: its anti-vacuity
 *  floor is a hard 3, so any dial value below 3 disables the span path.) */
function envNum(name: string, fallback: number, min: 0 | 1 = 0): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < min) return fallback;
  return v;
}

export const DEFAULTS: RequiredRetrievalOptions = {
  adaptiveBudget: true,
  minBudget: envNum("NTK_MIN_BUDGET", 500, 1),
  budgetPerSource: envNum("NTK_BUDGET_PER_SOURCE", 350, 1),
  mmr: true,
  redundancyMax: envNum("NTK_REDUNDANCY_MAX", 0.75),
  headingBonus: envNum("NTK_HEADING_BONUS", 4),
  /** Rare-term content gate as a fraction of the corpus's max attainable IDF
   *  (raw IDF grows with section count, so a fraction transfers across
   *  corpora; size-sensitive — off by default, the coverage leg is the
   *  portable discriminator). 0 = off. */
  minRareIdf: envNum("NTK_MIN_RARE_IDF", 0),
  /** User-content-word coverage floor of the content gate (see above).
   *  Gold-style queries structurally cover ~1.0 of their own content words
   *  (heading ≈ query); template-word negatives top out near 0.5. */
  minCoverage: envNum("NTK_MIN_COVERAGE", 0.8),
  /** P0-7: minimum content terms in a query span (sentence/line) for it to
   *  carry gate evidence; the gate passes when ONE span reaches minCoverage,
   *  not the whole multi-paragraph query. Values below 3 disable the span
   *  path (a 1–2-term "span" at coverage 1.0 would un-gate every query). */
  minSegTerms: envNum("NTK_MIN_SEG_TERMS", 3, 1),
  /** Content-gate overrides (audit item 1; P0-8 EXPERIMENTAL, default off):
   *  a low coverage score is a CONSERVATIVE signal, not a hard rejection —
   *  STRUCTURAL CITATION passes: a dotted member/file reference, an
   *  explicit document path, a `code` citation (section-level match), or a
   *  contiguous heading phrase. 0 = off (gate stays a hard rule), 1 = on. */
  gateOverride: envNum("NTK_GATE_OVERRIDE", 0),
  minScore: envNum("NTK_MIN_SCORE", 3),
  threshold: envNum("NTK_THRESHOLD", 0.5),
  /** Relative selection floor (fraction of the top candidate's score).
   *  Default baked by bench:run + bench:adv sweeps, 2026-11-01. */
  minTopFraction: envNum("NTK_MIN_TOP_FRACTION", 0.05),
  /** C2 sibling promotion (see types.ts). 1 = on, 0 = off (ablation). */
  siblingPhrase: envNum("NTK_SIBLING_PHRASE", 1),
  topK: 20,
  maxItems: envNum("NTK_MAX_ITEMS", 4, 1),
  tokenBudget: envNum("NTK_TOKEN_BUDGET", 800, 1),
  perDocMax: envNum("NTK_PER_DOC_MAX", 1, 1),
  fusion: { keyword: 1.0, recency: 0.15 },
  expansionTermsMax: 8,
  expansionMinScore: 0.55,
  /** BM25 weight for PMI-expanded terms vs. user words (0 = drop, 1 = full). */
  expansionTermWeight: envNum("NTK_EXPANSION_WEIGHT", 0.4),
  /** EXPERIMENTAL (Experiments B-S1/S2/S3) — default off: production
   *  H2+B1+C2 unaffected until validated. */
  termSalience: envNum("NTK_TERM_SALIENCE", 0),
  salienceSubset: envNum("NTK_SALIENCE_SUBSET", 0),
  gateSalience: envNum("NTK_GATE_SALIENCE", 0),
};

/* ---------------------------------------------------------------- gate */

export interface GateResult {
  pass: false;
  reason: string;
}

/**
 * Score gate over the ranked candidates (SPEC v1.2 / §387): a SINGLE
 * absolute section-level floor. No minimum candidate count, no
 * top-vs-median dominance ratio — those abstain on legitimate single-doc
 * answers and vague-but-unique tasks. An isolated weak match is excluded by
 * the floor; everything at or above it selects.
 *
 * Returns null when the gate passes.
 */
export function scoreGate(
  candidates: Array<{ score: number }>,
  opts?: Partial<RetrievalOptions>,
): GateResult | null {
  const o = { ...DEFAULTS, ...opts } as RequiredRetrievalOptions;
  if (candidates.length === 0) {
    return { pass: false, reason: "no candidates scored above the gate" };
  }
  const top = Math.max(...candidates.map((c) => c.score));
  if (top < o.minScore) {
    return { pass: false, reason: `below min score (${top.toFixed(2)} < ${o.minScore})` };
  }
  return null;
}

/* ----------------------------------------------------------- retrieval */

interface Scored {
  section: SectionRecord;
  /** Score after fusion/recency/activity boosts. */
  score: number;
  /** Raw BM25 score before boosts (for trace). */
  base: number;
  matched: string[];
  /** Exact title/path reference match (《文档名》 path) — bypasses the
   *  content gate; user-supplied evidence, not lexical luck. (A boosted
   *  BM25 hit can reach 99+, so this flag is the only reliable marker.) */
  exactTitle?: boolean;
  /** Candidate entered from a recently touched source file (activity terms). */
  activity?: boolean;
}

/** Exponential recency factor in [0, 1]: 14-day half-life on doc mtime. */
const RECENCY_HALF_LIFE_MS = 14 * 24 * 3600 * 1000;
function recencyFactor(mtimeMs: number, now: number): number {
  if (!mtimeMs) return 0;
  const age = Math.max(0, now - mtimeMs);
  return Math.pow(2, -age / RECENCY_HALF_LIFE_MS);
}

/** Stable-selection hysteresis (spec): previously selected sections are
 *  retained at 0.6× the inclusion threshold, overriding on task change. */
const RETAIN_RATIO = 0.6;
/** Bounded one-hop spreading activation over cross-references (NTK-007). */
const SPREAD_SEEDS = 3;
const SPREAD_DECAY = 0.35;
const SPREAD_MAX = 6;

/** Stems extracted from a source file path for activity matching. */
function activityTermsFromFile(file: string): string[] {
  const base = (file.split("/").pop() ?? file).replace(/\.[a-z]+$/i, "");
  const parts = base
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((p) => p.length >= 3);
  return parts.map((p) => stem(p.toLowerCase()));
}

function normalizeQuery(text: string): string {
  // Strip code fences and URLs (with paths) from the query text.
  let s = text.replace(/```[\s\S]*?```/g, " ");
  s = s.replace(/https?:\/\/\S+\/\S+/g, " ");
  return s.toLowerCase();
}

function extractQuotedTitles(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/《([^》]+)》/g)) {
    out.push(m[1]!.replace(/文档|使用说明书|说明书|手册/g, "").trim());
  }
  return out.filter(Boolean);
}

/** Raw (unstemmed) content words of the query, for trace display. */
function rawContentWords(norm: string): string[] {
  const seen = new Set<string>();
  for (const w of tokenize(norm)) {
    if (w.length >= 2 && !isStopword(stem(w))) seen.add(w);
  }
  return [...seen];
}

/**
 * Pick the native-exclusion keys (lowercased) for a doc: its basename,
 * nameKey, content hash, and — for AGENTS.md-style docs — a normalized form
 * of the front-matter `name:` value (e.g. "CLAUDE.md" → "claude").
 */
function nativeKeysForDoc(index: NTKIndex, docPath: string): string[] {
  const keys: string[] = [];
  const base = docPath.split("/").pop() ?? docPath;
  const noExt = base.replace(/\.(md|mdx|txt|adoc)$/i, "").toLowerCase();
  keys.push(noExt);
  const meta = index.docMeta(docPath);
  if (meta) {
    if (meta.nameKey) keys.push(meta.nameKey.toLowerCase());
    if (meta.hash) keys.push(meta.hash.toLowerCase());
    const fmName = (meta.frontMatter as Record<string, unknown> | undefined)?.name;
    if (typeof fmName === "string" && fmName.trim()) {
      const n = fmName.toLowerCase();
      keys.push(n, n.replace(/\.(md|mdx|txt|adoc)$/i, ""));
    }
  }
  return [...new Set(keys.filter(Boolean))];
}

/** Choose inclusion level from section size + score (design.md §5.3). */
export function chooseLevel(score: number, tokens: number): InclusionLevel {
  if (tokens <= 100 && score >= 4) return "full";
  if (tokens <= 400) return score >= 6 ? "full" : "excerpt";
  return "excerpt";
}

/**
 * Fraction of the section's own heading content words covered by the query
 * (0..1). Stemmed, stopword-filtered. A near-exact heading match is the
 * strongest structural relevance signal a user's task phrasing can carry —
 * the benchmark's dominant near-miss was the gold heading ranked under
 * sibling sections of the same document.
 */
function headingCoverage(heading: string, qStems: Set<string>): number {
  if (!heading) return 0;
  const hs = new Set<string>();
  for (const w of words(heading.toLowerCase())) {
    if (w.length >= 2 && !isStopword(stem(w))) hs.add(stem(w));
  }
  if (hs.size === 0) return 0;
  let hit = 0;
  for (const t of qStems) if (hs.has(t)) hit++;
  return hit / hs.size;
}

/**
 * Ordinal heading selector (Phase-2 structural signal): a query word directly
 * followed by a digit ("what is in phase 2") is title-citation evidence for
 * numbered sibling sections — the bare digit is a 1-char stopword and the
 * word stem ties every sibling, so without the pair "phase 1/2/3" are
 * indistinguishable and the tiebreak takes the earlier section.
 * Returns the multiplier for this candidate: >1 on an exact word+digit heading
 * pair, <1 on a conflicting digit (Phase 1 heading vs a "phase 2" query),
 * 1 when the heading states no pair for the cited word.
 */
export function headingOrdinalBoost(
  heading: string,
  qPairs: Array<{ word: string; num: string }>,
): number {
  if (!heading || !qPairs.length) return 1;
  // Same hyphen normalization as the query side ("Phase-2" = "Phase 2") and
  // the same 1–2-digit width as ordinalSelectors: a 3-digit heading number
  // can never match a query pair, so accepting it here only ever produced a
  // spurious conflict demote.
  const ws = words(heading.replace(/(\p{L})-(?=\d)/gu, "$1 "));
  for (let i = 0; i + 1 < ws.length; i++) {
    const d = ws[i + 1]!;
    if (!/^\d{1,2}$/.test(d)) continue;
    const w = ws[i]!;
    const s = stem(w);
    if (w.length < 2 || isStopword(s)) continue;
    for (const p of qPairs) {
      if (p.word !== s) continue;
      return p.num === d ? 2 : 0.4;
    }
  }
  return 1;
}

/**
 * Full heading echo: the query reproduces a candidate section's heading
 * word-for-word ("What Is gMock?" -> heading "What Is gMock?"). User-supplied
 * selection evidence on par with a 《title》 reference (A3 gate: 1–2-content-
 * word heading queries were withheld by the content gates). Guards (A5 live
 * finding, "And now?"): >=2 tokens and >=1 non-stopword — bare chatter never
 * unlocks the bypass. NTK-018: leading heading numbering stripped on both
 * sides ("12. Definition of Done" is echoable). Ablation-baked; unit-tested
 * (heading-echo bypass).
 */
function headingEcho(norm: string, candidates: Scored[]): Scored | null {
  const q = tokenize(stripNum(norm)).filter((w) => w.length >= 2);
  if (q.length < 2) return null;
  if (!q.some((w) => !isStopword(stem(w)))) return null;
  const key = [...q].sort().join(" ");
  for (const c of candidates.slice(0, 40)) {
    const h = tokenize(stripNum(c.section.heading.toLowerCase())).filter((w) => w.length >= 2);
    if (h.sort().join(" ") === key) return c;
  }
  return null;
}

/** Leading heading numbering ("12. X", "3.4.1 X"): a position marker, not
 *  title content (NTK-018: it made numbered headings unmatchable by verbatim
 *  echo and blocked the phrase rescue for every numbered corpus). */
export function stripNum(heading: string): string {
  return heading.replace(/^[\d.]+\s+/, "");
}

/** Negation-clause parsing: excl = content stems naming the excluded subject;
 *  clause = ALL stems inside the clause (coverage denominator); affirmative =
 *  query with clause spans excised (citation precedence: terms the affirmative
 *  part also uses stay positive evidence). Language-general cues only. */
const NEGATION_FUNCTION = new Set(["not", "the", "case", "one", "other", "than", "except", "excluding", "avoid", "scenario", "situation"]);
function exclusionClauses(norm: string): { excl: Set<string>; clause: Set<string>; affirmative: string } {
  const excl = new Set<string>();
  const clause = new Set<string>();
  let affirmative = norm;
  for (const re of [
    /\(\s*(?:not|excluding|except|avoid)\b[^)]*\)/gi,
    /\b(?:not|excluding|except)\s+(?:the\s+)?[a-z0-9][a-z0-9'\u2019\s-]{2,60}?(?=[?!.(),;:]|$)/gi,
  ]) {
    affirmative = affirmative.replace(re, " ");
    for (const m of norm.matchAll(re)) {
      for (const w of words(m[0])) {
        const s2 = stem(w);
        clause.add(s2);
        if (w.length >= 3 && !isStopword(s2) && !NEGATION_FUNCTION.has(s2)) excl.add(s2);
      }
    }
  }
  return { excl, clause, affirmative };
}

/** Content-word stream: hyphen compounds split, stopwords dropped. */
function contentStream(text: string): string[] {
  const out: string[] = [];
  for (const w of words(text))
    for (const p of w.split("-")) {
      const s2 = stem(p);
      if (p.length >= 2 && !isStopword(s2)) out.push(s2);
    }
  return out;
}

/** Sentence/line spans of the affirmative query (>= 3 content terms each).
 *  P0-7 (pilot, 2026-11-02): union coverage over the WHOLE query is the
 *  right evidence unit for a short chat prompt, and the wrong one for a
 *  long structured task (multi-paragraph TASK.md, history anchor): the
 *  strongest evidence for a section is a single clause of the task, never
 *  80% of its every paragraph (observed: coverage 0.22–0.56 — all declines,
 *  treatment undelivered, on doc-dependent pilot tasks). A span is the
 *  minimal natural evidence unit; the 3-term floor keeps spans
 *  non-vacuous (A5: 1-term coverage is no evidence). Deterministic split on
 *  sentence terminators and line breaks — no dictionaries, no task patterns. */
function querySpans(
  affirmative: string,
  clause: Set<string>,
  affirm: Set<string> | null,
  minTerms: number,
): string[][] {
  const spans: string[][] = [];
  for (const part of affirmative.split(/(?<=[.!?…])\s+|\n+/)) {
    const stream = contentStream(part).filter((t) => !clause.has(t) || (affirm?.has(t) ?? true));
    if (stream.length >= minTerms) spans.push([...new Set(stream)]);
  }
  return spans;
}

/** Contiguous subsequence (b inside a). */
function hasRun(a: string[], b: string[]): boolean {
  outer: for (let i = 0; i + b.length <= a.length; i++) {
    for (let j = 0; j < b.length; j++) if (a[i + j] !== b[j]) continue outer;
    return true;
  }
  return false;
}

/** Contiguous heading-phrase evidence (>=3 content words, any position).
 *  Ablation (3-arm, knob-fixed): gate-evidence form = k8s dev +0.179 recall,
 *  public dev & natural eval exactly zero; rank-evidence form measured zero
 *  (subsumed by headingBonus at coverage 1.0) and was removed.
 *  NTK-018: heading numbering stripped (see stripNum). */
function headingPhraseRescue(qStream: string[], candidates: Scored[]): Scored | null {
  for (const c of candidates.slice(0, 12)) {
    const hs = contentStream(stripNum(c.section.heading));
    if (hs.length < 3) continue;
    outer: for (let i = 0; i + hs.length <= qStream.length; i++) {
      for (let j = 0; j < hs.length; j++) if (qStream[i + j] !== hs[j]) continue outer;
      return c;
    }
  }
  return null;
}

/**
 * NTK-018: heading-corroborated 2-term current-turn span. A terse follow-up
 * ("phase 2?", "the budget?") carries too few content terms for the P0-7
 * 3-term span floor, yet is unambiguous when the current turn's terms ALL
 * matched inside one candidate and that candidate's heading contains them as
 * a contiguous phrase. 2 terms plus full single-section coverage is the A5
 * anti-vacuity guard that lets 2 terms count where 1 cannot. History spans
 * keep the >=3-term floor; the 0.8 coverage floor is unchanged; abstention is
 * preserved: prose-only overlap, 1-term headings and chatter never satisfy.
 */
export function headCorroborated(
  candidates: Scored[],
  turnStream: string[],
  minSegTerms: number,
): string[] | null {
  const uniq = [...new Set(turnStream)];
  if (uniq.length < 2 || uniq.length >= minSegTerms) return null;
  for (const c of candidates.slice(0, 12)) {
    if (!uniq.every((t) => c.matched.includes(t))) continue;
    const hs = contentStream(stripNum(c.section.heading));
    if (hs.length >= 2 && hasRun(hs, uniq)) return uniq;
  }
  return null;
}

/** Exclusion-filter constants: outside-clause rescue needs corpus-rare
 *  evidence (RC1 leaves the filter as a safety net for non-query paths). */
const EXCL_DISTINGUISHING_IDF = 0.25;

/** Identifier match normalizer: lowercase, punctuation stripped — makes
 *  "ConnectionPool" match "httpcore.ConnectionPool" and "allow_quoted_local"
 *  match "allow-quoted-local" in headings/paths. */
function normIdent(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function strongEvidence(
  candidates: Scored[],
  rawQuery: string,
): string[] {
  const ev: string[] = [];
  const rawLower = rawQuery.toLowerCase();
  // P0-8 (citation evidence for paraphrased tasks):
  //  - identifiers are FULL code-shaped tokens only (dotted / snake /
  //    camel / extension); decomposition fragments ("MacOS"→"mac",
  //    "python-email-validator"→"python") are scoring vocabulary, not
  //    references;
  //  - citation legs require STRUCTURAL reference form (dotted member path
  //    Class.method, file/module path x.py, docs/index.md, a markdown code
  //    citation `symbol`): a bare token mention ("setting up initialData
  //    ... cuckoo obsidian", "for fail and hidden_rc") is topical
  //    vocabulary — the adversarial classes name rare bare symbols inside
  //    template framing (measured: bare-token legs leaked NTK-bench
  //    overlap negatives and one frozen-holdout D abstention);
  //  - the linked: leg is corpus structure, not query citation; heading
  //    COVERAGE is not citation evidence (both leaked negatives);
  //  - no content-term-count floor (SPEC NTK-006: eligibility must not
  //    depend on a minimum number of keyword matches).
  const cited = new Set<string>(
    [...rawQuery.matchAll(/`([^`\n]{2,60})`/g)]
      .map((m) => (m[1]!.toLowerCase().match(/^[a-z][a-z0-9_$.]*/) ?? [""])[0])
      .filter((s) => s.length >= 5),
  );
  const idents = identifiersExact(rawQuery).filter((id) => id.includes(".") || cited.has(id));
  const pathM = rawLower.match(/[\w\-/_.]+\.(?:md|mdx|txt|adoc)/);
  const topDoc = candidates[0]?.section.docPath;
  for (const c of candidates.slice(0, 10)) {
    if (pathM && c.section.docPath.toLowerCase().includes(pathM[0].split("/").pop() ?? pathM[0]))
      ev.push(`doc-path:${pathM[0]}`);
    for (const id of idents) {
      // Section-level: the citation must match a token of THIS section's
      // indexed strings (vocabulary, heading, path) — normalized on both
      // sides so "connection_pool.release_all" matches its verbatim token
      // and "ConnectionPool" the heading "httpcore.ConnectionPool".
      const toks = new Set<string>(
        [
          ...c.section.terms,
          ...c.section.heading.split(/[^A-Za-z0-9_]+/),
          ...c.section.docPath.split(/[^A-Za-z0-9_]+/),
        ]
          .map(normIdent)
          .filter(Boolean),
      );
      const segs = id.includes(".") ? id.split(".").filter((s) => s.length >= 5) : [id];
      if (segs.some((s) => toks.has(normIdent(s)))) {
        ev.push(`identifier:${id}`);
        break;
      }
    }
    // linked: and heading-coverage legs removed (P0-8): topical-overlap
    // negatives rode them into injection (abstain 1.0→0.605 / overlap
    // 1.0→0.679). Contiguous heading PHRASES stay — headingPhraseRescue.
    if (ev.length >= 4) break;
  }
  return [...new Set(ev)].slice(0, 4);
}

/**
 * True when compressed content is structure only — heading text, horizontal
 * rules, quote markers, whitespace. Such items consume budget and tokens
 * with zero knowledge content (live dogfood finding: `---` injected as a
 * full "section"). A section must leave ≥ 24 characters of substantive
 * text (~4 words) after stripping structure.
 */
function isStructuralOnly(content: string): boolean {
  const body = content
    .replace(/^===.*===\s*$/gm, "") // section header echo
    .replace(/^#{1,6}\s.*$/gm, "") // headings
    .replace(/^\s*>?\s*[-–—=*#]{2,}\s*$/gm, "") // horizontal rules
    .replace(/^\s*>+\s*$/gm, "") // bare quote markers
    .replace(/[\s\p{P}\p{S}]/gu, "");
  return body.length < 24;
}

/**
 * Run the full retrieval pipeline for one turn.
 *
 * @param nativeKeys keys (doc paths / names / hashes) to exclude — native
 *        instructions already cover them. Matching is case-insensitive.
 * @param limit caps the number of injected items (status view widens it).
 */
export function runRetrieval(
  index: NTKIndex,
  query: string,
  nativeKeys: Set<string>,
  opts: Partial<RetrievalOptions> = {},
  limit?: number,
  ctx: RetrievalContext = {},
): RetrievalResult {
  const o: RequiredRetrievalOptions = { ...DEFAULTS, ...opts } as RequiredRetrievalOptions;
  const t0 = Date.now();
  const stages: Record<string, number> = {};
  const norm = normalizeQuery(query);
  // Corpus max attainable IDF (classic BM25, d=0): the rarest possible term
  // sits in 1.5 sections of N+1. Shared by salience weighting, the exclusion
  // safety net and the rare-IDF gate leg — one formula, three consumers.
  const maxAttainableIdf = () => Math.log(1 + ((index.stats?.sections ?? 100) + 1) / 1.5);
  const currentText = ctx.currentText?.trim() || query;
  const titles = extractQuotedTitles(query);
  const qt = stemQueryTerms(norm);
  stages.queryTerms = Date.now() - t0;
  // RC1 (A4 investigation): negation-clause terms are NOT positive evidence —
  // removed from scoring, expansion and coverage; citation precedence keeps
  // clause terms the affirmative query part also uses (self-naming golds).
  const { excl, clause, affirmative } = exclusionClauses(norm);
  const affirm = clause.size ? new Set(contentStream(affirmative)) : null;
  const qtPos = affirm ? qt.filter((t) => !clause.has(t) || affirm.has(t)) : qt;
  const expanded = expandQuery(qtPos, index.expansion, {
    minScore: o.expansionMinScore,
    maxTotal: o.expansionTermsMax,
  });
  const terms = [...qtPos, ...expanded];
  stages.expand = Date.now() - t0;

  const trace: RetrievalTrace = {
    query,
    fired: false,
    scored: [],
    terms: rawContentWords(norm),
    queryTerms: qt,
    expandedTerms: expanded,
    expanded: expanded.length ? expanded.join(", ") : "none",
    candidates: [],
    retained: [],
    spreadAdded: 0,
    excludedRedundant: [],
    excludedEmpty: [],
    excludedRelative: [],
    siblingPromoted: [],
    spreadEvidence: [],
    allocatedBudget: 0,
    allocatedSources: 0,
    truncated: [],
    passedGate: false,
    gateReason: "",
    latencyMs: 0,
    durationMs: 0,
    items: [],
    stages,
  };
  const finish = (items: ContextItem[]): RetrievalResult => {
    // Selection-level duplicate guard: a section can enter as a candidate
    // through several routes (BM25, expansion, activity, spread); the
    // injection set is keyed by section identity — the first entry wins,
    // carrying its evidence flags, and the token total follows.
    const uniq = new Map<string, ContextItem>();
    for (const i of items) {
      const k = `${i.docPath}#${i.heading}`;
      if (!uniq.has(k)) uniq.set(k, i);
    }
    items = [...uniq.values()];
    const totalTokens = items.reduce((s, i) => s + i.tokens, 0);
    trace.latencyMs = Date.now() - t0;
    trace.durationMs = trace.latencyMs;
    trace.fired = items.length > 0;
    trace.items = items.map((i) => `${i.docPath}#${i.heading}`);
    return { items, trace, totalTokens };
  };

  if (terms.length === 0 && titles.length === 0) {
    trace.gateReason = "no candidates scored above the gate";
    return finish([]);
  }
  // Exact doc-title / path matching first (《文档名》 references).
  let candidates: Scored[] = [];
  if (titles.length > 0) {
    for (const sec of index.allSections()) {
      const meta = index.docMeta(sec.docPath);
      const hay = [sec.docTitle, sec.docPath, meta?.nameKey ?? ""].join(" ").toLowerCase();
      for (const t of titles) {
        if (hay.includes(t.toLowerCase())) {
          candidates.push({ section: sec, score: 100, base: 100, matched: [t], exactTitle: true });
          break;
        }
      }
    }
  }
  if (candidates.length === 0) {
    const searchLimit = Math.max(limit ?? o.maxItems, Math.ceil(o.topK / 2), 5) * 6;
    // B-S1: corpus-IDF salience weighting (EXPERIMENTAL, default off).
    const maxIdfS = maxAttainableIdf();
    const salWeight =
      o.termSalience > 0
        ? (t: string) => Math.max(0.25, Math.min(1, (index.idf[t] ?? 0) / maxIdfS))
        : undefined;
    let hits = index.search(terms, searchLimit, new Set(expanded), o.expansionTermWeight, salWeight);
    // If expansion polluted the results, fall back to the plain query stems
    // (RC1: the POSITIVE stems only — clause terms must not re-enter here).
    if (hits.length && hits[0]!.score < o.minScore && terms.length > qtPos.length) {
      hits = index.search(qtPos, searchLimit, undefined, 1, salWeight);
    }
    for (const h of hits) {
      const sec = index.sections.get(h.id);
      if (sec)
        candidates.push({
          section: sec,
          score: h.score * o.fusion.keyword,
          base: h.score,
          matched: h.terms ?? [],
        });
    }
    // B-S2 (EXPERIMENTAL, default off): complementary salience-subset search
    // for verbose queries — union the top-6-IDF-term hits into the pool,
    // scale-aligned to the full-query top-5 so ranks below stay comparable.
    if (o.salienceSubset > 0 && qtPos.length > 8 && candidates.length) {
      const idfOf = (t: string) => index.idf[t] ?? 0;
      const sal = [...qtPos].sort((a, b) => idfOf(b) - idfOf(a)).slice(0, 6);
      const h2 = index.search(sal, 30, undefined, 1, salWeight);
      const sFull = candidates.slice(0, 5).reduce((a, c) => a + c.base, 0) || 1;
      const sSal = h2.slice(0, 5).reduce((a, h) => a + h.score, 0) || 1;
      const scale = sFull / sSal;
      const have = new Set(candidates.map((c) => c.section.id));
      for (const h of h2) {
        const sec = index.sections.get(h.id);
        if (!sec || have.has(sec.id)) continue;
        candidates.push({
          section: sec,
          score: h.score * scale * o.fusion.keyword,
          base: h.score * scale,
          matched: h.terms ?? [],
        });
      }
    }
  }
  stages.search = Date.now() - t0;

  // Exclusion safety net (activity-term path): a candidate matched via the
  // clause's NEGATED content terms (clause-ONLY terms; exempt re-used terms
  // stay positive) is dropped unless rare outside evidence supports it.
  if (excl.size && candidates.length) {
    const qtSet = new Set(qtPos);
    const maxIdf = maxAttainableIdf();
    const exclOnly = (t: string) => excl.has(t) && !(affirm?.has(t) ?? true);
    candidates = candidates.filter((c) => {
      const user = c.matched.filter((t) => qtSet.has(t));
      if (!user.length) return true;
      if (!user.some(exclOnly)) return true;
      const outside = user.filter((t) => !exclOnly(t));
      return outside.some((t) => (index.idf[t] ?? 0) / maxIdf >= EXCL_DISTINGUISHING_IDF);
    });
  }

  // Heading-coverage rank bonus: sections whose own heading the query nearly
  // reproduces rise above body-term-frequency siblings. Quadratic in coverage
  // so partial matches (one shared word in a long heading) barely move.
  // Ordinal selectors ("phase 2") ride the same block: exact word+digit
  // heading pair boosts, conflicting digit demotes (sibling tiebreak).
  const qOrdinals = ordinalSelectors(currentText);
  if (o.headingBonus > 0 && candidates.length && (qtPos.length || qOrdinals.length)) {
    // RC1: positive query stems only — a negated-clause term appearing in a
    // candidate heading must not earn the coverage bonus.
    const qSet = new Set(qtPos);
    for (const c of candidates) {
      if (c.score <= 0) continue;
      const cov = headingCoverage(c.section.heading, qSet);
      if (cov > 0) c.score *= 1 + o.headingBonus * cov * cov;
      c.score *= headingOrdinalBoost(c.section.heading, qOrdinals);
    }
  }

  // Recency (exponential decay on doc mtime, SPEC #15) — weighted by
  // fusion.recency, no extra knobs.
  const now = Date.now();
  if (o.fusion.recency > 0) {
    for (const c of candidates) {
      if (c.score <= 0) continue;
      const meta = index.docMeta(c.section.docPath);
      if (meta?.mtimeMs) c.score *= 1 + o.fusion.recency * recencyFactor(meta.mtimeMs, now);
    }
  }
  // Source-file activity (NTK-004): docs matching recently touched source
  // enter as mid-tier candidates — they inform retrieval, not dominate it.
  const actTerms = (ctx.activityFiles ?? []).flatMap(activityTermsFromFile);
  if (actTerms.length) {
    const have = new Set(candidates.map((c) => c.section.id));
    for (const h of index.search(actTerms, Math.max(6, Math.ceil(o.topK / 2)))) {
      const sec = index.sections.get(h.id);
      if (!sec || have.has(sec.id)) continue;
      candidates.push({
        section: sec,
        score: h.score * o.fusion.recency * 3,
        base: h.score,
        matched: h.terms ?? [],
        exactTitle: false,
        activity: true,
      });
    }
  }
  // Full heading echo: user typed the section's name verbatim — rank it
  // first (《title》-grade evidence; A3: echoed section was budget-truncated).
  const echo = headingEcho(currentText, candidates);
  if (echo) {
    const top = Math.max(0, ...candidates.map((c) => c.score));
    echo.score = Math.max(echo.score, top + 1);
  }
  candidates.sort((a, b) => b.score - a.score);
  stages.boost = Date.now() - t0;
  // NTK-011 decision log: the full ranked evidence entering the gates, and
  // the thresholds the decisions were made against (top 12, best first).
  // Observability (Experiment B fix): recorded BEFORE the gates so
  // gate-rejected runs remain attributable offline.
  const round2 = (x: number) => Math.round(x * 100) / 100;
  trace.scored = candidates.slice(0, 12).map((c) => ({
    id: `${c.section.docPath}#${c.section.sectionPath || c.section.heading || "top"}`,
    docPath: c.section.docPath,
    sectionPath: c.section.sectionPath || c.section.heading || "top",
    startLine: c.section.startLine,
    endLine: c.section.endLine ?? c.section.startLine,
    score: round2(c.score),
    base: round2(c.base),
    matched: c.matched.slice(0, 10),
    exactTitle: !!c.exactTitle,
  }));
  trace.thresholds = {
    minScore: o.minScore,
    minCoverage: o.minCoverage,
    minSegTerms: o.minSegTerms,
    maxItems: o.maxItems,
    tokenBudget: o.tokenBudget,
    perDocMax: o.perDocMax,
    redundancyMax: o.redundancyMax,
  };
  trace.candidates = candidates.map((c) => c.section.id);

  // The score gate runs over all retrieved candidates, before native
  // exclusion: an excluded document must not weaken the gate for the rest.
  const gate = scoreGate(candidates, o);
  if (gate) {
    trace.gateReason = gate.reason;
    return finish([]);
  }
  // Content gate: the top candidates must include at least one *user* query
  // term whose IDF is ≥ minRareIdf × the corpus max attainable IDF (off by
  // default: size-sensitive), and collectively cover ≥ minCoverage of the
  // user's content words. Lexical template words ("configure", "deploy",
  // "using") are themselves doc topics on real corpora, so a score floor
  // alone injects on no-documentation queries: abstention measured 0.53 on
  // NTK-bench negatives → ~1.0 with this gate. Coverage is a query-local
  // fraction — applied uniformly at every corpus size (audit P1-9: the
  // former <200-section bypass created a small/large-project discontinuity
  // with no empirical justification; abstention is verified across sizes in
  // test/content-gate.test.ts). Exact title references bypass.
  // Content gate: withhold when the query carries no selection evidence.
  // Audit A5 (live dogfooding): a query with fewer than 2 user content
  // words ("now?", "ok") makes the coverage floor vacuous (1/1) — require
  // ≥2 evidence terms, counting source-file activity (NTK-004: one word +
  // an opened file is a real signal). Exact title references bypass.
  // A3: a word-for-word heading echo is evidence too. An ordinal selector
  // ("phase 2": content word + adjacent digit) is evidence as well — it is a
  // title citation, the only query form that discriminates numbered siblings.
  // RC1: POSITIVE user stems (qt.length would count negated-clause terms as
  // evidence of a task that explicitly excludes them).
  const activityTermCount = new Set(actTerms).size;
  if (
    o.minCoverage > 0 &&
    qtPos.length + activityTermCount + qOrdinals.length < 2 &&
    !candidates.some((c) => c.exactTitle) &&
    !echo
  ) {
    trace.gateReason = `content gate: insufficient query content (${qtPos.length} user term(s), ${activityTermCount} activity term(s), ${qOrdinals.length} ordinal(s))`;
    return finish([]);
  }
  if (qtPos.length + activityTermCount < 2 && qOrdinals.length) {
    // The ordinal citation is what carried this query over the A5 floor —
    // auditable as gate evidence (a title reference, like heading-echo).
    trace.gateOverride = `ordinal:${qOrdinals.map((p) => `${p.word} ${p.num}`).join(", ")}`;
  }
  if (
    (o.minRareIdf > 0 || o.minCoverage > 0) &&
    !candidates.some((c) => c.exactTitle) &&
    !echo
  ) {
    const maxIdf = maxAttainableIdf();
    const qtSet = new Set(qtPos);
    let rarest = 0;
    // UNION coverage across all candidates: a compound query ("rollback the
    // deploy, shard the cache, rotate tokens") legitimately spans sections,
    // none covering every term; per-candidate coverage would gate it (audit
    // P1-9 review surfaced this). Negatives stay rejected: no section covers
    // the coined terms, so the union over template words stays small.
    const covered = new Set<string>();
    for (const c of candidates) for (const t of c.matched) if (qtSet.has(t)) covered.add(t);
    for (const t of covered) rarest = Math.max(rarest, (index.idf[t] ?? 0) / maxIdf);
    // RC1: negated-clause terms (whole clause, markers included) are not
    // positive coverage evidence; a wholly-negated query withholds.
    const pos = qtPos;
    // B-S3 (EXPERIMENTAL, default off): verbose queries carry a template tail
    // no documentation can cover ("describe the bug", "steps to reproduce",
    // version/platform boilerplate). Measure coverage over the SALIENT subset
    // (top-50% by corpus IDF, floor 3, cap 8) instead of the whole query.
    // Every other gate leg (2-term floor, rare-IDF, spans) is unchanged.
    let salient: Set<string> | null = null;
    if (o.gateSalience > 0 && pos.length > 8) {
      const idfOf = (t: string) => index.idf[t] ?? 0;
      salient = new Set([...pos].sort((a, b) => idfOf(b) - idfOf(a)).slice(0, Math.max(3, Math.min(8, Math.ceil(pos.length / 2)))));
    }
    const posCovered = [...covered].filter((t) => (salient ? salient.has(t) : true)).length;
    // RC1: a wholly-negated query has no positive terms to cover → coverage 0
    // (withhold), matching the stated intent; 1.0 would auto-pass the gate.
    const bestCov =
      posCovered && pos.length ? posCovered / (salient ? salient.size : pos.length) : 0;
    // P0-7: best-span coverage — a section is eligible on strong evidence of
    // relevance to PART of the task (one sentence/line covered at the same
    // floor), not 80% of the whole prompt. The coverage must be carried by a
    // SINGLE candidate section: a sentence is one evidence unit, and a union
    // across sibling sections (each contributing a fragment) is diluted —
    // cross-repo replay probes showed the union path fires on generic
    // engineering prose. Short prompts collapse to the global union (one
    // span, high-scoring sections cover it anyway); negated clauses are
    // excluded from spans exactly as from the global denominator.
    let bestSpan = 0;
    let bestSpanN = 0;
    let bestSpanTerms: string[] = [];
    if (o.minSegTerms >= 3) {
      // Evidence floor: a span must state at least 3 content terms. Values
      // below 3 disable the span path entirely (a 1-term "span" at
      // coverage 1.0 would un-gate every query).
      const spans = querySpans(affirmative, clause, affirm, o.minSegTerms);
      for (const c of candidates) {
        const mt = new Set(c.matched);
        for (const sp of spans) {
          const spE = salient ? sp.filter((t) => salient.has(t)) : sp;
          if (spE.length < 3) continue;
          let hit = 0;
          for (const t of spE) if (mt.has(t)) hit++;
          const cov = hit / spE.length;
          if (cov > bestSpan) { bestSpan = cov; bestSpanN = spE.length; bestSpanTerms = spE; }
        }
      }
    }
    // NTK-018: heading-corroborated 2-term current-turn span (tail only;
    // negation clauses excised exactly as for the P0-7 spans).
    // Use the actual current-turn text, not the last line of a blended query.
    const currentAffirmative = exclusionClauses(normalizeQuery(currentText)).affirmative;
    const headSpan = headCorroborated(candidates, contentStream(currentAffirmative), o.minSegTerms);
    trace.gateCoverage = bestCov;
    trace.gateRarest = rarest;
    trace.gateSpan = bestSpan;
    if (rarest < o.minRareIdf || (bestCov < o.minCoverage && bestSpan < o.minCoverage)) {
      // Audit item 1: coverage is a conservative SIGNAL. Strong structural
      // evidence overrides weak lexical coverage — an exact source-code
      // identifier the query cites, an explicit document path, a linked
      // document, a near-complete heading phrase, or (NTK-018) a cited
      // heading phrase in the current turn.
      const ev =
        o.gateOverride > 0 ? strongEvidence(candidates, query) : [];
      const phrase =
        ev.length === 0 ? headingPhraseRescue(contentStream(affirmative), candidates) : null;
      // Ordinal citation rescue: the current turn cites a numbered sibling
      // heading ("phase 2") and a candidate states that pair — structural,
      // single-section, same anti-vacuity shape as the NTK-018 head span.
      const ordinalCited =
        ev.length === 0 && !phrase && !headSpan && qOrdinals.length
          ? candidates.slice(0, 12).find((c) => headingOrdinalBoost(c.section.heading, qOrdinals) === 2)
          : null;
      if (ev.length === 0 && !phrase && !headSpan && !ordinalCited) {
        trace.gateReason =
          `content gate: rarest user-term idf frac ${rarest.toFixed(2)} / coverage ${bestCov.toFixed(2)}` +
          ` / best span ${bestSpan.toFixed(2)} of ${bestSpanN} term(s)` +
          ` (need ${o.minRareIdf} / ${o.minCoverage})`;
        return finish([]);
      }
      trace.gateOverride = ev.length
        ? ev.join(", ")
        : phrase
          ? `heading-phrase:${phrase.section.heading.slice(0, 42)}`
          : headSpan
            ? `span:heading:${headSpan.join(" ")}`
            : `heading-ordinal:${ordinalCited!.section.heading.slice(0, 42)}`;
    } else if (bestCov < o.minCoverage && bestSpan >= o.minCoverage) {
      // Passed on PART-of-task evidence (P0-7) — auditable in the trace.
      trace.gateOverride =
        `span:coverage ${bestSpan.toFixed(2)} of ${bestSpanN} term(s) [${bestSpanTerms.join(" ")}]`;
    }
  }
  trace.passedGate = true;
  if (echo) trace.gateOverride = `heading-echo:${echo.section.heading.slice(0, 42)}`;
  const promoted = new Set<string>();
  const spreadIds = new Set<string>();

  // Native exclusion (case-insensitive, by docPath / basename / name / hash).
  // P0-2 audit round 2: the plugin supplies exclusion KEYS (rel paths,
  // basenames, nameKey, hashes); a doc is excluded when ANY key of that doc
  // appears in the set — set-intersection alone missed path-vs-key pairs
  // (e.g. key "AGENTS.md" vs path-derived key "agents").
  const excluded = new Set<string>();
  for (const k of nativeKeys) excluded.add(String(k).toLowerCase());
  const keysByDoc = new Map<string, string[]>();
  const isExcludedDoc = (docPath: string): boolean => {
    let keys = keysByDoc.get(docPath);
    if (!keys) {
      keys = nativeKeysForDoc(index, docPath);
      keysByDoc.set(docPath, keys);
    }
    for (const k of keys) {
      if (excluded.has(k)) return true;
      for (const ek of excluded) {
        const ekBase = ek.split("/").pop() ?? ek;
        if (
          (ekBase === k || ekBase === `${k}.md` || ekBase === `${k}.mdx` || ekBase === `${k}.txt` || ekBase === `${k}.adoc`) &&
          ek.includes(".")
        )
          return true;
        if (docPath.toLowerCase() === ek) return true;
      }
    }
    return false;
  };
  candidates = candidates.filter((c) => !isExcludedDoc(c.section.docPath));
  stages.exclude = Date.now() - t0;

  // Bounded one-hop spreading activation (NTK-007): sections of documents
  // cross-referenced by the top seeds enter at a decayed score.
  if (candidates.length > 0) {
    const have = new Set(candidates.map((c) => c.section.id));
    const seeds = [...new Set(candidates.slice(0, SPREAD_SEEDS).map((c) => c.section.docPath))];
    const seedScore = candidates[0]!.score;
    for (const doc of seeds) {
      if (trace.spreadAdded >= SPREAD_MAX) break;
      for (const link of index.docMeta(doc)?.links ?? []) {
        if (isExcludedDoc(link)) continue;
        for (const sec of index.docsByFile(link)) {
          if (trace.spreadAdded >= SPREAD_MAX) break;
          if (have.has(sec.id) || sec.tokens > 400) continue; // keep spreading cheap
          candidates.push({ section: sec, score: seedScore * SPREAD_DECAY, base: 0, matched: [] });
          spreadIds.add(sec.id);
          have.add(sec.id);
          trace.spreadAdded++;
          // A propagated match is identifiable, with its linking evidence (NTK-013).
          trace.spreadEvidence.push(`${sec.id} <- ${doc}`);
        }
      }
    }
    candidates.sort((a, b) => b.score - a.score);
  }
  trace.candidates = candidates.map((c) => c.section.id);

  // Select: hysteresis thresholds (previously selected sections are kept at
  // RETAIN_RATIO × the inclusion threshold; a task change drops retention),
  // score floor, per-doc cap, relevance-only level, strict budget.
  // Cap the retained set at maxItems: retention is the select-stage's main
  // growth axis (long sessions accumulate keeps); the cap bounds the tail.
  const retain = ctx.taskChanged ? new Set<string>() : new Set(Array.from(ctx.previouslySelected ?? []).slice(0, o.maxItems));
  const retainFloor = o.threshold * RETAIN_RATIO;
  // Relative floor (dogfood "What is in phase 2"): the absolute floor is a
  // near-zero entry door, and greedy per-doc fill then injects any document
  // that shares an anchor term. A candidate must reach minTopFraction of the
  // top score to claim a slot. Exemptions carry user-supplied or structural
  // evidence: hysteresis retentions (stability), exact title references
  // (the user named the doc), spread additions (decay 0.35 ≥ the floor by
  // arithmetic, seeded from a top-scoring document).
  const topScore = candidates.length ? candidates[0]!.score : 0;
  const relFloor = o.minTopFraction > 0 ? o.minTopFraction * topScore : 0;
  // C2 sibling promotion: a document's slot goes to the eligible section whose
  // heading the user's FIRST LINE quotes verbatim (word-ordered phrase, >=12
  // chars) when its score x 1.5 beats the lexical leader — confusable mirrored
  // titles ("Using Predicates as Matchers" vs "Using Matchers as Predicates")
  // are indistinguishable to bag-of-words scores; ordered-phrase evidence is
  // the discriminator. Constant 1.5 = measured sibling-rank cap (gmock pair
  // 1615/1135 = 1.42 swaps; adversarial set: zero displacement at this value).
  // Promotion changes the doc-slot FIGHTER only: MMR, ladder, budget,
  // structure-only and relative-floor safeguards run identically on the
  // promoted candidate; hysteresis-retained sections are never displaced.
  const phraseTitleLine = normalizeQuery(currentText || query).split("\n")[0] ?? "";
  const phraseNorm = (h: string) => h.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  const phraseFactor = (c: Scored) =>
    c.section.heading.length > 12 && phraseTitleLine.includes(phraseNorm(c.section.heading)) ? 1.5 : 1;
  const phraseTop = new Map<string, Scored>();
  if (o.siblingPhrase > 0) {
    for (const c of candidates) {
      if (c.score < o.threshold) break;
      const cur = phraseTop.get(c.section.docPath);
      if (!cur || c.score * phraseFactor(c) > cur.score * phraseFactor(cur))
        phraseTop.set(c.section.docPath, c);
    }
  }
  const items: ContextItem[] = [];
  const perDoc = new Map<string, number>();

  // NTK-015 adaptive allocation: small injections for narrow tasks (one
  // source), larger for tasks spanning several gate-clearing documents.
  // `limit` (status preview) opts out — it asks for a fixed view.
  const sourceSet = new Set(
    candidates.filter((c) => c.score >= Math.max(o.threshold, relFloor)).map((c) => c.section.docPath),
  );
  for (const k of retain) sourceSet.add(k.split("#")[0]!); // retained context counts
  const sources = sourceSet.size;
  let cap = limit ?? o.maxItems;
  let budget = o.tokenBudget;
  if (o.adaptiveBudget && limit === undefined) {
    budget = Math.min(
      o.tokenBudget,
      Math.max(o.minBudget, Math.round(o.minBudget / 2 + o.budgetPerSource * sources)),
    );
    cap = Math.min(o.maxItems, Math.max(3, 2 + sources)); // never exceed the caller's cap
  }
  trace.allocatedBudget = budget;
  trace.allocatedSources = sources;

  // NTK-014 MMR: track selected bodies to drop near-duplicates.
  // EXP-R D3: a second, BODY-ONLY bag — cross-file boilerplate (identical
  // body under differing heading trails, e.g. templated task sections) is a
  // near-duplicate by content, which the heading-trail union bag dilutes.
  const selBodies: Set<string>[] = [];
  const selBodyBags: Set<string>[] = [];
  /** [heading-trail ∪ body, body-only] — the two MMR bags of a section. */
  const bagsOf = (sec: SectionRecord): [Set<string>, Set<string>] => [
    new Set([...sec.fields.headings, ...sec.fields.body]),
    new Set(sec.fields.body),
  ];
  /** Inclusion level (relevance only) + the budget escalation ladder, in one
   *  place: selection and the C2 re-fight must compress identically. */
  const fitLadder = (
    sec: SectionRecord,
    score: number,
  ): { level: InclusionLevel; compressed: ReturnType<typeof compressSection> } => {
    let level = chooseLevel(score, sec.tokens);
    let compressed = compressSection(sec, terms, index.idf, level, DEFAULT_COMPRESS);
    // Escalate down the inclusion ladder until the item fits the budget.
    while (compressed.tokens > budget && level !== "overview") {
      level = level === "full" ? "excerpt" : "overview";
      compressed = compressSection(sec, terms, index.idf, level, DEFAULT_COMPRESS);
    }
    return { level, compressed };
  };
  const nearDup = (headingsBag: Set<string>, bodyBag: Set<string>): boolean => {
    if (o.redundancyMax <= 0) return false; // 0 = off (MMR ablation); any overlap must not reject
    const sim = (a: Set<string>, b: Set<string>) => {
      if (a.size < 12 || b.size < 12) return 0; // Jaccard is too noisy on tiny bags
      let inter = 0;
      for (const t of a) if (b.has(t)) inter++;
      const union = a.size + b.size - inter;
      return union > 0 ? inter / union : 0;
    };
    let maxSim = 0;
    for (let i = 0; i < selBodies.length; i++) {
      maxSim = Math.max(maxSim, sim(headingsBag, selBodies[i]!), sim(bodyBag, selBodyBags[i]!));
    }
    return maxSim > o.redundancyMax;
  };
  for (const c of candidates) {
    if (items.length >= cap) break;
    const secKey = `${c.section.docPath}#${c.section.heading}`; // hysteresis key (matches trace.items)
    const kept = retain.has(secKey);
    const floor = kept ? retainFloor : o.threshold;
    if (c.score < floor) continue; // filler scores: not worth injecting
    if (o.mmr && selBodies.length) {
      // Heading trail joins the body bag: structurally identical sections
      // (same heading path, boilerplate body) are near-duplicates even when
      // their samples differ (NTK-bench: triple `#Response` injections).
      const [cur, curBody] = bagsOf(c.section);
      if (nearDup(cur, curBody)) {
        trace.excludedRedundant.push(secKey);
        continue; // near-duplicate of an already-selected section
      }
    }
    const key = c.section.docPath;
    const used = perDoc.get(key) ?? 0;
    if (used >= o.perDocMax) continue;
    if (kept) trace.retained.push(secKey);
    // Inclusion level from RELEVANCE ONLY (guidanceKind removed per user
    // directive): chooseLevel(score, tokens) + the budget escalation ladder
    // (fitLadder). Selection, ranking and gates are untouched; a document's
    // kind never caps how much of it is included — its score and the budget do.
    const { level, compressed } = fitLadder(c.section, c.score);
    if (compressed.tokens > budget) continue; // even the overview doesn't fit
    // Dogfood audit: sections whose compressed content is structure only
    // (heading + rule + whitespace) carry no knowledge — an injected slot
    // spent on "---". Skip them and count in the trace.
    if (isStructuralOnly(compressed.content)) {
      trace.excludedEmpty.push(secKey);
      continue;
    }
    // Relative floor: qualified on the absolute floor alone — an incidental
    // match (anchor/generic term) at the tail of a top-heavy distribution.
    // Runs AFTER redundancy/structure checks: those are more specific audit
    // reasons for the same candidate.
    if (!kept && !c.exactTitle && c.score < relFloor && phraseFactor(c) <= 1) {
      trace.excludedRelative.push(secKey);
      continue;
    }
    // C2 sibling promotion: re-fight this document's slot for the section
    // whose heading the first line quotes verbatim, under the SAME safeguards.
    let chosen = c;
    let chosenCompressed = compressed;
    let chosenLevel = level;
    const w = o.siblingPhrase > 0 ? phraseTop.get(key) : undefined;
    if (
      w &&
      w.section.id !== c.section.id &&
      !promoted.has(w.section.id) &&
      !kept &&
      w.score * phraseFactor(w) > c.score * phraseFactor(c) + 1e-9 &&
      // EXP-R D5/D6 (generic): a section whose heading the current turn quotes
      // verbatim carries structural evidence — exempt from the relative floor,
      // same family as exact-title, echo, ordinal and span citations.
      (w.exactTitle || spreadIds.has(w.section.id) || w.score >= relFloor || phraseFactor(w) > 1)
    ) {
      let ok = true;
      if (o.mmr && selBodies.length) {
        const [cur, curBody] = bagsOf(w.section);
        if (nearDup(cur, curBody)) ok = false;
      }
      if (ok) {
        const { level: wl, compressed: wc } = fitLadder(w.section, w.score);
        if (wc.tokens > budget || isStructuralOnly(wc.content)) ok = false;
        if (ok) {
          chosen = w;
          chosenCompressed = wc;
          chosenLevel = wl;
          promoted.add(w.section.id);
          trace.siblingPromoted.push(`${c.section.docPath}#${c.section.heading} -> ${w.section.heading}`);
        }
      }
    }
    budget -= chosenCompressed.tokens;
    perDoc.set(key, used + 1);
    const [headBag, bodyBag] = bagsOf(chosen.section);
    selBodies.push(headBag);
    selBodyBags.push(bodyBag);
    items.push({
      docPath: chosen.section.docPath,
      docTitle: chosen.section.docTitle,
      heading: chosen.section.heading,
      headings: chosen.section.headings,
      sectionPath: chosen.section.sectionPath,
      content: chosenCompressed.content,
      tokens: chosenCompressed.tokens,
      score: chosen.score,
      level: chosenLevel,
      compression: chosenCompressed.compression,
      matchedTerms: chosenCompressed.matchedTerms,
      docMtime: index.docMeta(key)?.mtimeMs,
      startLine: chosen.section.startLine,
      endLine: chosen.section.endLine ?? chosen.section.startLine,
      base: chosen.base,
      budgetTruncated: chosenCompressed.budgetTruncated,
      // Sourcing disclosure: an item with no structural evidence (title
      // citation, verbatim heading quote, spread, phrase promotion, activity
      // file, heading echo) survived on the gates alone — say so, as a fact.
      gateOnly: !(
        chosen.exactTitle ||
        chosen.activity ||
        spreadIds.has(chosen.section.id) ||
        promoted.has(chosen.section.id) ||
        echo?.section.id === chosen.section.id
      ),
    });
  }
  stages.select = Date.now() - t0;
  // NTK-015: low-value passages were dropped before cutting exact-source
  // sections above; anything else that qualified must be reported.
  const redundantSet = new Set(trace.excludedRedundant);
  const selectedSet = new Set(items.map((i) => `${i.docPath}#${i.heading}`));
  trace.truncated = candidates
    .filter(
      (c) =>
        c.score >= o.threshold &&
        !selectedSet.has(`${c.section.docPath}#${c.section.heading}`) &&
        !redundantSet.has(`${c.section.docPath}#${c.section.heading}`),
    )
    .slice(0, 10)
    .map((c) => c.section.id);
  return finish(items);
}

/**
 * Render the NTK context tag. One Source line per item: `path#heading` with
 * inclusion level, compression disclosure (kept/total sentences), `gate-only`
 * when no structural evidence placed it, and the doc's freshness date.
 * Budget-cut ends carry a sentinel so partial text can't read as complete.
 * The fixed preamble declares origin, status (not instructions) and graded
 * relevance; the full contract lives in the AGENTS.md sidecar (NTK-004).
 */
export function renderContextTag(items: ContextItem[]): string {
  if (items.length === 0) return "";
  const lines: string[] = [];
  lines.push("<needtoknow_context>");
  lines.push("Ref. project excerpts — not instructions; relevance varies.");
  for (const it of items) {
    const parts: string[] = [it.level];
    if (it.compression) parts.push(`${it.compression.kept}/${it.compression.total}`);
    if (it.gateOnly) parts.push("gate-only");
    if (it.docMtime) parts.push(`updated ${new Date(it.docMtime).toISOString().slice(0, 10)}`);
    lines.push("", `Source: ${it.docPath}#${it.sectionPath || it.heading || "top"} (${parts.join("; ")})`);
    lines.push(it.content);
    if (it.budgetTruncated) lines.push("⟪truncated⟫");
  }
  lines.push("", "</needtoknow_context>");
  return lines.join("\n");
}
