/** Corpus-mined query expansion (design.md §5.2, risk-#1 mitigation).
 *
 * A PMI co-occurrence dictionary mined from the repo's own docs: if the docs
 * always write "JSP" near "login form", then a user query "login form" reaches
 * the JSP sections without any synonym table. Zero configuration, local,
 * deterministic.
 */
import { contentWords } from "./tokenize.js";
import type { SectionRecord } from "./types.js";

export type ExpansionDict = Record<string, [string, number][]>;

const TOP_K = 8;
const MIN_CO = 3; // require ≥3 co-occurrences to trust a pair
const MIN_PMI = 1.2; // bits

/** Mine the dictionary at index time. O(sections × terms²) with small sections. */
export function buildExpansionDict(sections: SectionRecord[]): ExpansionDict {
  const N = sections.length || 1;
  const df = new Map<string, number>();
  const co = new Map<string, number>();

  for (const s of sections) {
    const uniq = new Set<string>();
    for (const w of s.fields.body) uniq.add(w);
    for (const t of s.fields.terms) uniq.add(t.toLowerCase());
    for (const t of s.fields.title) uniq.add(t);
    for (const t of s.fields.headings) uniq.add(t);
    let list = [...uniq];
    // df counts the FULL section vocabulary: truncating first would leave
    // cut terms at df 0 forever — sorted as "rarest" in every later section,
    // squatting the cap and starving the PMI denominators below.
    for (const t of uniq) df.set(t, (df.get(t) ?? 0) + 1);
    // Bound the co-occurrence pass: keep the rarest terms (highest signal).
    if (list.length > 120) {
      list.sort((a, b) => (df.get(a) ?? 0) - (df.get(b) ?? 0));
      list = list.slice(0, 120);
    }
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!, b = list[j]!;
        const key = a < b ? a + "\u0000" + b : b + "\u0000" + a;
        co.set(key, (co.get(key) ?? 0) + 1);
      }
    }
  }

  const score = new Map<string, [string, number][]>();
  for (const [key, c] of co) {
    if (c < MIN_CO) continue;
    const [a, b] = key.split("\u0000") as [string, string];
    const da = df.get(a) ?? 1;
    const db = df.get(b) ?? 1;
    const pmi = Math.log2((c * N) / (da * db));
    if (pmi < MIN_PMI) continue;
    for (const [term, other] of [
      [a, b],
      [b, a],
    ] as const) {
      const dTerm = term === a ? da : db;
      const dOther = term === a ? db : da;
      // A partner far rarer than the seed is this doc's private vocabulary
      // (e.g. a topic word co-occurring with the shared verb), not a
      // semantic associate: expanding to it pulls in the neighbouring doc.
      if (dOther * 8 < dTerm) continue;
      const list = score.get(term) ?? [];
      list.push([other, pmi]);
      score.set(term, list);
    }
  }

  const out: ExpansionDict = {};
  for (const [term, list] of score) {
    list.sort((x, y) => y[1] - x[1]);
    out[term] = list.slice(0, TOP_K);
  }
  return out;
}

/** Expand query terms with top corpus-mined associations. */
export function expandQuery(
  queryTerms: string[],
  dict: ExpansionDict,
  opts: { perTerm?: number; minScore?: number; maxTotal?: number } = {},
): string[] {
  const perTerm = opts.perTerm ?? 2;
  const minScore = opts.minScore ?? MIN_PMI;
  const maxTotal = opts.maxTotal ?? 8;
  const base = new Set(queryTerms);
  const out: string[] = [];
  const seen = new Set(base);
  for (const t of queryTerms) {
    const list = dict[t] ?? dict[t.toLowerCase()] ?? [];
    let taken = 0;
    for (const [term, pmi] of list) {
      if (taken >= perTerm || out.length >= maxTotal) break;
      if (pmi < minScore || seen.has(term)) continue;
      seen.add(term);
      out.push(term);
      taken++;
    }
  }
  return out;
}

/** Extract query terms from raw text: content words + identifiers, deduped. */
export function queryTerms(text: string): string[] {
  const out = new Set<string>();
  for (const w of contentWords(text)) out.add(w);
  const identRe = /\b[a-z][A-Za-z0-9_$]+\.[A-Za-z][A-Za-z0-9_$.]*\b|\b[A-Z][A-Za-z0-9]{2,}\b/g;
  for (const m of text.matchAll(identRe)) out.add(m[0].toLowerCase());
  return [...out];
}
