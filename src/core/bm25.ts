/** BM25 via MiniSearch over section records (design.md §5).
 *
 * Field boosts: title 4, headings 3, terms 2, body 1. Fuzzy/prefix disabled
 * for determinism. Serialized with toJSON(); IDF snapshot kept for diagnostics.
 *
 * MiniSearch's default scoring is BM25+ with `d: 100`, a per-occurrence bonus
 * that never saturates: on long book chapters raw scores reach the thousands
 * (NTK-bench, real corpora), so the absolute gate floors (minScore/threshold)
 * stop discriminating and body term-frequency drowns heading matches. We pin
 * classic BM25 (`d: 0`): scores are bounded per query term by
 * boost × idf × (k + 1), so one set of tuned thresholds transfers across
 * corpora and document lengths.
 */
import MiniSearch from "minisearch";
import type { SectionRecord } from "./types.js";

export const FIELD_BOOSTS = { title: 4, headings: 3, terms: 2, body: 1 } as const;

/** Classic BM25 (saturating, length-normalized) — not MiniSearch's BM25+ default. */
export const BM25_PARAMS = { k: 1.2, b: 0.75, d: 0 } as const;

/** Single source of truth for MiniSearch search options — index-store loads
 *  and queries with this, so build-time and query-time params cannot drift. */
export const SEARCH_BASE = {
  boost: { ...FIELD_BOOSTS },
  fuzzy: false,
  prefix: false,
  combineWith: "OR" as const,
  bm25: { ...BM25_PARAMS },
};

export interface Bm25Hit {
  id: string;
  score: number;
  terms: string[];
}

export class Bm25Index {
  private ms: MiniSearch;

  private constructor(ms: MiniSearch) {
    this.ms = ms;
  }

  static build(sections: SectionRecord[]): Bm25Index {
    const ms = new MiniSearch({
      fields: ["title", "headings", "terms", "body"],
      storeFields: [],
      searchOptions: { ...SEARCH_BASE },
    });
    ms.addAll(
      sections.map((s) => ({
        id: s.id,
        title: s.fields.title.join(" "),
        headings: s.fields.headings.join(" "),
        terms: s.fields.terms.join(" "),
        body: s.fields.body.join(" "),
      })),
    );
    return new Bm25Index(ms);
  }

  search(terms: string[], limit = 30): Bm25Hit[] {
    if (terms.length === 0) return [];
    const hits = this.ms.search(terms.join(" "), { ...SEARCH_BASE });
    return hits.slice(0, limit).map((h) => ({
      id: String(h.id),
      score: h.score,
      terms: Object.keys(h.match),
    }));
  }

  /** IDF per indexed term, for compression scoring and diagnostics. */
  idfSnapshot(sections: SectionRecord[]): Record<string, number> {
    const df = new Map<string, number>();
    for (const s of sections) {
      const uniq = new Set([...s.fields.body, ...s.fields.title, ...s.fields.headings, ...s.fields.terms.map((t) => t.toLowerCase())]);
      for (const t of uniq) df.set(t, (df.get(t) ?? 0) + 1);
    }
    const n = sections.length || 1;
    const out: Record<string, number> = {};
    for (const [t, d] of df) out[t] = Math.log(1 + (n - d + 0.5) / (d + 0.5));
    return out;
  }

  toJSON(): string {
    return JSON.stringify(this.ms.toJSON());
  }

  static fromJSON(json: string): Bm25Index {
    const ms = MiniSearch.loadJSON(json, {
      fields: ["title", "headings", "terms", "body"],
      storeFields: [],
      searchOptions: { ...SEARCH_BASE },
    });
    return new Bm25Index(ms);
  }

  termCount(): number {
    return this.ms.documentCount;
  }
}
