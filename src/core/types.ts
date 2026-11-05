/** Core data model for the NTK offline core (see docs/design.md §4–§6). */

/** A discovered document file. */
export interface DiscoveredFile {
  /** Repo-relative path, e.g. "docs/AUTHENTICATION_PAC4J.md". */
  path: string;
  /** Absolute path on disk. */
  absolutePath: string;
  /** Last-modified time in epoch ms (from stat). */
  mtimeMs: number;
  /** Byte size. */
  size: number;
}

/** One indexed section: a heading-delimited chunk of a document. */
export interface SectionRecord {
  /** Stable id: `${docPath}::${ordinal}`. */
  id: string;
  docPath: string;
  /** Doc title (front matter title, first H1, or filename). */
  docTitle: string;
  /** The section's own heading text ("" for the preamble before any heading). */
  heading: string;
  /** Heading trail leading to this section, outermost first. */
  headings: string[];
  /** Section heading level (1-6); 0 for preamble. */
  level: number;
  /** Human breadcrumb: "ParentHeading > ChildHeading > …" (outermost first). */
  sectionPath: string;
  /** 1-based line of the section heading (0 for preamble). */
  startLine: number;
  /** 1-based last line of the section (NTK-011 decision-log evidence). */
  endLine: number;
  /** Index of this section within its document. */
  ordinal: number;
  /** Number of sections in the parent document (structure bonus). */
  docSections: number;
  /** Raw section text after Layer-0 stripping (markdown). */
  text: string;
  /** Atomic blocks of `text`: sentences, code blocks, tables, list items. */
  blocks: Block[];
  /** Identifier-like terms extracted at parse time (unstemmed). */
  terms: string[];
  /** Searchable field bags (stemmed where applicable). */
  fields: SectionFields;
  /** Estimated token count of full text (3.0 chars/token). */
  tokens: number;
}

export interface SectionFields {
  /** Stemmed words from the doc/section title. */
  title: string[];
  /** Stemmed words from the heading trail. */
  headings: string[];
  /** Lowercased identifier terms + camel/snake parts (not stemmed). */
  terms: string[];
  /** Stemmed body words. */
  body: string[];
}

/** An atomic unit of section text — never split by the compressor. */
export interface Block {
  kind: "sentence" | "code" | "table" | "list" | "quote" | "heading";
  text: string;
}

export interface DocMeta {
  path: string;
  title: string;
  mtimeMs: number;
  size: number;
  /** SHA-256 of file content; used for dedupe against native instructions. */
  hash: string;
  sections: number;
  /** Lowercase basename without extension, for dedupe matching. */
  nameKey: string;
  frontMatter: Record<string, unknown>;
  /** Repo-relative docs this document cross-references (markdown links). */
  links?: string[];
}

export interface IndexStats {
  indexedFiles: number;
  sections: number;
  skipped: number;
  files: number;
  indexMs: number;
}

export interface PersistedIndex {
  version: number;
  root: string;
  builtAt: number;
  stats: IndexStats;
  docs: DocMeta[];
  sections: SectionRecord[];
  /** MiniSearch serialized index (JSON string). */
  bm25: string;
  /** PMI co-occurrence dictionary: term -> [coTerm, score][] (capped). */
  expansion: Record<string, [string, number][]>;
  /** Inverse document frequency snapshot for compression scoring. */
  idf: Record<string, number>;
}

export type InclusionLevel = "overview" | "excerpt" | "full";

/** One selected + compressed section ready for injection. */
export interface ContextItem {
  docPath: string;
  docTitle: string;
  heading: string;
  headings: string[];
  /** Breadcrumb of the selected section. */
  sectionPath: string;
  /** Rendered markdown excerpt (compressed at the chosen level). */
  content: string;
  tokens: number;
  score: number;
  level: InclusionLevel;
  /** Doc mtime at selection time — version info for diagnostics (NTK-009). */
  docMtime?: number;
  /** Sentence stats for status (excerpt level). */
  compression?: { kept: number; total: number };
  matchedTerms: string[];
  /** 1-based source-line range of the section in the original document
   *  (NTK-011 decision-log evidence). */
  startLine: number;
  endLine: number;
  /** BM25 base score before heading/recency/activity boosts (audit rationale). */
  base: number;
  /** Rendered content end was cut by the per-section token cap (sentinel). */
  budgetTruncated?: boolean;
  /** Selected on the gates alone: no title/quote/echo/spread/activity evidence. */
  gateOnly?: boolean;
}

/** A BM25 hit enriched with section metadata. */
export interface QueryHit {
  id: string;
  score: number;
  /** Terms that matched (for the status view). */
  terms?: string[];
  docPath: string;
  heading: string;
}

export interface RetrievalResult {
  items: ContextItem[];
  /** Full per-stage diagnostics for /ntk-status. */
  trace: RetrievalTrace;
  totalTokens: number;
}

export interface FusionWeights {
  keyword: number;
  recency: number;
}

/** Tunable knobs for the retrieval pipeline (all present in DEFAULTS). */
export interface RetrievalOptions {
  /** NTK-015: allocate budget/items from distinct gate-clearing sources. */
  adaptiveBudget: boolean;
  minBudget: number;
  budgetPerSource: number;
  /** NTK-014: near-duplicate exclusion (Jaccard over section body terms). */
  mmr: boolean;
  redundancyMax: number;
  /** Heading-coverage rank bonus (NTK-bench): multiply the score by
   *  `1 + headingBonus × cov²`, where cov is the fraction of the section's
   *  own heading content words covered by the query. Fixes the dominant
   *  near-miss pattern: right document, sibling heading ranked above gold. */
  headingBonus: number;
  /** Rare-term content gate (NTK-bench v3): the top candidates must include
   *  at least one *user* query term whose corpus IDF is ≥ this fraction of
   *  the corpus's max attainable IDF. On real corpora template words
   *  ("configure", "deploy", "using") match doc prose, so the absolute score
   *  floor alone injects on queries with no relevant doc (abstention 0.53 →
   *  ~1.0). Corpus statistics, no dictionaries (SPEC v1.2 NTK-006). 0 = off. */
  minRareIdf: number;
  /** User-content-word coverage floor of the content gate (0 = off). */
  minCoverage: number;
  /** P0-7: min content terms in a query span (sentence/line) that grants
   *  gate evidence on its own coverage (long-task support; values < 3
   *  disable the span path — see retrieval.ts, anti-vacuity floor). */
  minSegTerms: number;
  /** Content-gate overrides (1 = on; EXPERIMENTAL, default off): STRUCTURAL
   *  CITATION evidence — dotted member/file references (Class.method, x.py),
   *  explicit doc paths, markdown code citations `symbol` — matched at
   *  section level, beats weak lexical coverage. Bare mentions, doc links
   *  and heading coverage are not citations (they leaked negatives; P0-8).
   *  0 = gate is a hard rule. */
  gateOverride: number;
  minScore: number;
  /** Compat-only: v1.2's gate is a single absolute threshold (SPEC §5.5). */
  /** Absolute section-level floor (v1.2: the ONLY score gate). */
  threshold: number;
  /** Compat-only: v1.2's gate has no relative top-vs-median check. */

  topK: number;
  maxItems: number;
  tokenBudget: number;
  perDocMax: number;
  fusion: FusionWeights;
  expansionTermsMax: number;
  expansionMinScore: number;
  /** BM25 weight for PMI-expanded terms vs. user words (1 = full). */
  expansionTermWeight: number;
  /** Relative selection floor: a NEW candidate must reach this fraction of
   *  the top candidate's score to enter selection. The absolute floor alone
   *  (0.5) makes greedy multi-source fill inject any positive-scoring
   *  document once the cap allows (dogfood: anchor term "ntk" injected bench
   *  READMEs at score 11 against a top of 580). Relative-to-top transfers
   *  across corpus sizes (audit P1-9: no size-sensitive absolute floors).
   *  Exempt: hysteresis retentions, exact title references, spread additions
   *  (user evidence / stability / seeded decay). 0 = off. */
  minTopFraction: number;
  /** C2: promote the doc-slot section whose heading the first line quotes as
   *  an ordered phrase (score x 1.5 evidence). 1 = on (default), 0 = off
   *  (ablation). Zero-config: the constant is baked, not user-facing. */
  siblingPhrase: number;
  /** EXPERIMENT B-S1 (default off): corpus-IDF salience weighting of query
   *  terms — each user term's BM25 contribution is scaled by
   *  clamp(idf/maxIdf, 0.25, 1), so rare technical identifiers outweigh
   *  template boilerplate in verbose queries (Croft-Harper 1979 importance,
   *  Bendersky & Croft 2008 key concepts, IDF proxy). Corpus statistics only. */
  termSalience: number;
  /** EXPERIMENT B-S2 (default off): complementary salience-subset search —
   *  when the query has >8 content terms, also run the top-6 IDF terms and
   *  union the hits into the candidate pool (scale-aligned), recovering golds
   *  the full verbose query buries (Xue/Huston/Croft 2010 subset model). */
  salienceSubset: number;
  /** EXPERIMENT B-S3 (default off): gate coverage measured over the salient
   *  term subset (top-50% by IDF, floor 3, cap 8) for queries with >8 terms —
   *  the template tail of a verbose request cannot be covered by any doc, so
   *  the whole-query denominator false-abstains. All gate legs/floors kept. */
  gateSalience: number;
}

/** Per-turn conversation context for stable, task-aware selection. */
export interface RetrievalContext {
  /** Section ids selected on the previous injection (hysteresis). */
  previouslySelected?: Iterable<string>;
  /** True on a clear task change: drop retention, reselect from scratch. */
  taskChanged?: boolean;
  /** Source files touched during the current task (activity tracking). */
  activityFiles?: string[];
  /** Current user turn, verbatim (NTK-018): the retrieval query blends the
   *  persistent task anchor with this turn; the 2-term heading-corroboration
   *  rule at the content gate applies to this tail only. */
  currentText?: string;
}

export type StateCheckKind = "hit" | "miss";

/** Invalidation cause (SPEC §5.9 / NTK-016). */
export type InvalidationReason = "input" | "knowledge" | "compaction" | "task";

export interface RetrievalTrace {
  query: string;
  fired: boolean;
  /** Raw (unstemmed) content words used for the search. */
  terms: string[];
  queryTerms: string[];
  expandedTerms: string[];
  /** Human-readable expansion summary for CLI logging. */
  expanded: string;
  /** Section ids entering the score gate, best first (deduplicated). */
  candidates: string[];
  /** NTK-011: ranked candidates entering the gates (best first, top 12) —
   *  full injection/rejection evidence for the debug decision log. */
  scored: ScoredTraceEntry[];
  /** NTK-011: the thresholds this run's decisions were made against. */
  thresholds?: {    minScore: number;
    minCoverage: number;
    minSegTerms: number;
    maxItems: number;
    tokenBudget: number;
    perDocMax: number;
    redundancyMax: number;
  };
  /** Experiment A: admission features (observability): coverage / rarest-IDF
   *  fraction / best-span values the content gate computed (0 when the gate
   *  block was bypassed by echo/title). */
  gateCoverage?: number;
  gateRarest?: number;
  gateSpan?: number;
  /** H2 cross-encoder demotion (plugin-applied after admission; NTK-011 evidence). */
  rerank?: {
    mode: "applied" | "fallback" | "cache";
    threshold: number;
    scored: number;
    dropped: string[];
    ms: number;
    reason?: string;
  };
  /** Section ids kept by hysteresis (retained at the lower threshold). */
  retained: string[];
  /** Sections added by one-hop spreading activation over cross-references. */
  spreadAdded: number;
  passedGate: boolean;
  /** Withholding reason; "" when the gate passed. */
  gateReason: string;
  /** Content-gate override evidence when weak lexical coverage was
   *  overridden by structural evidence (audit item 1). */
  gateOverride?: string;
  latencyMs: number;
  durationMs: number;
  /** ids of injected items ("doc#section"). */
  items: string[];
  stages: Record<string, number>;
  /** NTK-014: sections skipped as near-duplicates of already-selected ones. */
  excludedRedundant: string[];
  /** Dogfood audit: sections dropped because compression left structure-only content. */
  excludedEmpty: string[];
  /** Relative-floor rejects: scored ≥ threshold but < minTopFraction × top
   *  (irrelevant tail of a top-heavy distribution). */
  excludedRelative: string[];
  /** C2 sibling promotion log: "<from heading> -> <promoted heading>" per
   *  promoted doc-slot. Promotion is an eligibility re-fight inside the
   *  document; all safeguards (MMR, ladder, budget, structure, floor) pass. */
  siblingPromoted: string[];
  /** NTK-013: propagation evidence, "target <- linking seed doc". */
  spreadEvidence: string[];
  /** NTK-015: token budget allocated to this dispatch (adaptive). */
  allocatedBudget: number;
  /** NTK-015: distinct gate-clearing sources behind the allocation. */
  allocatedSources: number;
  /** NTK-015: sections that qualified but were dropped by cap/budget. */
  truncated: string[];
}
/** One ranked candidate as recorded for the NTK-011 decision log. */
export interface ScoredTraceEntry {
  /** "docPath#sectionPath" — matches ContextItem identification. */
  id: string;
  docPath: string;
  sectionPath: string;
  /** 1-based source-line range in the original document. */
  startLine: number;
  endLine: number;
  /** Final score after all boosts; base is the raw BM25 contribution. */
  score: number;
  base: number;
  /** Query terms this section matched (the positive evidence). */
  matched: string[];
  /** Exact title/path citation (score 100 evidence class). */
  exactTitle: boolean;
}
