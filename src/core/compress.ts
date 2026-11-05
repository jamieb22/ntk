/** Layer-1 compression: extractive, query-conditioned sentence selection
 *  (design.md §6). Never abstractive — content is verbatim from the doc.
 *
 *  Rules:
 *  - atomic blocks (code/tables/lists/quotes) are kept whole or dropped, never split;
 *  - the section's first sentence is always kept (heading lead-in → anaphora mitigation);
 *  - top-k query-matching sentences kept, floors 2–8;
 *  - a kept sentence expands to its full surrounding list/code block.
 */
import type { Block, ContextItem, InclusionLevel, SectionRecord } from "./types.js";
import { contentWords, estimateTokens } from "./tokenize.js";

export interface CompressOptions {
  /** Sentence floors (excerpt level). */
  minSentences: number;
  maxSentences: number;
}

export const DEFAULT_COMPRESS: CompressOptions = { minSentences: 2, maxSentences: 8 };


/** Max attainable IDF over the vocabulary (memoized per idf object:
 *  recomputed only when the snapshot identity changes). */
let idfCache: { idf: Record<string, number>; max: number } | null = null;
function maxIdfOf(idf: Record<string, number>): number {
  if (idfCache && idfCache.idf === idf) return idfCache.max;
  let max = 1;
  for (const v of Object.values(idf)) if (Number.isFinite(v) && v > max) max = v;
  idfCache = { idf, max };
  return max;
}

/** Score a block against query terms (idf-weighted term overlap, +identifier bonus). */
function blockScore(block: Block, query: Map<string, number>, matched: Set<string>): number {
  let score = 0;
  const text = block.text.toLowerCase();
  // Use contentWords for both CJK and non-CJK blocks to ensure consistent
  // token-based matching (same as retrieval's queryTerms).
  const tokens = new Set(contentWords(text));
  for (const [term, w] of query) {
    if (term.length < 3) continue;
    if (tokens.has(term)) {
      score += w;
      matched.add(term);
    }
  }
  if (block.kind === "code") score *= 1.3; // code anchors are high-value
  if (block.kind === "table") score *= 1.15;
  return score;
}

/** Fit blocks within token budget, keeping atomic blocks whole or dropping them.
 *  EXP-R D1/D2: reports drops so `kept` counts SURVIVORS, and list blocks
 *  truncate at line boundaries (no bullet cut mid-item). */
function fitContent(header: string, blocks: Block[], maxTokens: number, dropped: { n: number; tail: boolean }): string {
  let content = "";
  for (let idx = 0; idx < blocks.length; idx++) {
    const block = blocks[idx]!;
    // Atomic blocks must be kept whole or dropped
    const isAtomic = block.kind === "code" || block.kind === "table";
    const candidate = content ? `${content}\n\n${block.text}` : block.text;
    if (estimateTokens(header + candidate) <= maxTokens) {
      content = candidate;
      continue;
    }
    // For atomic blocks that don't fit, drop them entirely
    if (isAtomic) {
      dropped.n++;
      continue;
    }
    // For prose blocks, try binary search to find longest prefix that fits.
    // With content already assembled we stop here — and must report the
    // current block and the untouched tail as dropped, so `kept` counts
    // survivors truthfully and the sentinel marks a mid-section cut.
    if (content) {
      dropped.n += blocks.length - idx;
      dropped.tail = true;
      break;
    }
    const units = block.kind === "list" ? block.text.split(/\n/) : block.text.split(/(\s+)/);
    const join = block.kind === "list" ? (a: string[]) => a.join("\n") : (a: string[]) => a.join("");
    // A lone oversized block is kept whole: the cap is a safety valve on
    // sections, not a content gate, and a cut-to-prefix lone block reads as
    // the section's full text. (Sentinel fires on multi-block tails below.)
    if (blocks.length === 1) return header + block.text;
    let lo = 0;
    let hi = units.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      const candidate = join(units.slice(0, mid));
      if (estimateTokens(header + candidate) <= maxTokens) lo = mid;
      else hi = mid - 1;
    }
    content = join(units.slice(0, lo)).trimEnd();
    if (lo < units.length) dropped.tail = true; // budget cut mid-block → sentinel
    break;
  }
  return header + content;
}

export function compressSection(
  section: SectionRecord,
  queryTerms: string[],
  idf: Record<string, number>,
  level: InclusionLevel,
  opts: CompressOptions = DEFAULT_COMPRESS,
): Pick<ContextItem, "content" | "tokens" | "compression" | "matchedTerms" | "budgetTruncated"> {
  const matched = new Set<string>();
  const maxIdf = maxIdfOf(idf);
  const query = new Map<string, number>();
  for (const t of queryTerms) query.set(t.toLowerCase(), (idf[t] ?? maxIdf * 0.5) / maxIdf + 0.1);

  // Score every block against the query up front. This also records the
  // matched terms that the feedback loop consumes, at all inclusion levels.
  const scored = section.blocks.map((b, i) => ({ b, i, s: blockScore(b, query, matched) }));

  let keptBlocks: Block[];
  let kept: number | undefined;
  let total: number | undefined;

  if (level === "full") {
    keptBlocks = section.blocks;
  } else if (level === "overview") {
    // Layer 0 only, truncated to lead content: first sentence-bearing blocks.
    keptBlocks = section.blocks.slice(0, 1);
    if (keptBlocks.length === 0) keptBlocks = section.blocks;
  } else {
    // excerpt: query-conditioned sentence selection.
    const sentences = scored.filter((x) => x.b.kind === "sentence");
    const atomics = scored.filter((x) => x.b.kind !== "sentence");

    // Always-keep: the section's first sentence (lead-in).
    const firstSentenceIdx = sentences.length ? sentences[0]!.i : -1;
    const keepIdx = new Set<number>(firstSentenceIdx >= 0 ? [firstSentenceIdx] : []);

    // Top-k matching sentences beyond the lead-in.
    const ranked = sentences.filter((x) => x.i !== firstSentenceIdx).sort((x, y) => y.s - x.s);
    const kTarget = Math.max(opts.minSentences, Math.min(opts.maxSentences, Math.ceil(ranked.length * 0.4)));
    for (const x of ranked) {
      if (keepIdx.size >= kTarget) break;
      if (x.s <= 0) break;
      keepIdx.add(x.i);
    }
    // Floor: pad with earliest sentences.
    for (const x of sentences) {
      if (keepIdx.size >= opts.minSentences) break;
      keepIdx.add(x.i);
    }
    // Atomic blocks: keep if they match, plus any list block in a "how-to"-ish section.
    const keepAtomics = new Set<number>();
    for (const x of atomics) {
      if (x.s > 0) keepAtomics.add(x.i);
    }
    const procedureish = /how to|steps|procedure|implementation|configuration|setup|migration/i.test(
      section.heading + " " + section.headings.join(" "),
    );
    if (procedureish) {
      const firstList = atomics.find((x) => x.b.kind === "list");
      if (firstList) keepAtomics.add(firstList.i);
    }

    keptBlocks = section.blocks.filter((_, i) => keepIdx.has(i) || keepAtomics.has(i));
    if (keptBlocks.length === 0) keptBlocks = section.blocks.slice(0, 2);
    kept = keepIdx.size + keepAtomics.size || keptBlocks.length; // EXP-R D1: never report 0 for non-empty content
    total = section.blocks.length;
  }

  // Token cap per section (safety valve).
  const MAX_SECTION_TOKENS = 500;
  const header = section.heading ? `### ${section.heading}\n` : "";
  // fitContent includes header in its budget
  const dropped = { n: 0, tail: false };
  const content = fitContent(header, keptBlocks, MAX_SECTION_TOKENS, dropped);
  if (kept !== undefined) kept = Math.max(1, kept - dropped.n); // EXP-R D1: kept = survivors of the budget
  return {
    content,
    tokens: estimateTokens(content),
    compression: kept !== undefined && total !== undefined ? { kept, total } : undefined,
    matchedTerms: [...matched],
    budgetTruncated: dropped.tail,
  };
}
