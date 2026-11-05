import { describe, expect, it } from "vitest";
import { Bm25Index } from "../src/core/bm25.js";
import { makeSection, standardCorpus } from "./helpers.js";
import { parseDocument } from "../src/core/parse.js";
import { contentWords } from "../src/core/tokenize.js";

function corpusSections() {
  const corpus = standardCorpus();
  const sections = Object.entries(corpus)
    .filter(([, c]) => c !== null)
    .flatMap(([rel, content]) =>
      parseDocument(content!, rel, rel).sections.map((s, i) => ({
        ...s,
        id: `${rel}::${i}`,
        docPath: rel,
        ordinal: i,
      })),
    );
  return sections;
}

function sectionOf(sections: ReturnType<typeof corpusSections>, id: string) {
  const s = sections.find((x) => x.id === id);
  if (!s) throw new Error(`unknown section id ${id}`);
  return s;
}

describe("Bm25Index", () => {
  it("ranks the deployment docs for a deploy query", () => {
    const sections = corpusSections();
    const idx = Bm25Index.build(sections);
    const terms = contentWords("how does the deploy pipeline work");
    const hits = idx.search(terms, 10);
    expect(hits.length).toBeGreaterThan(0);
    // The deployment doc must lead, and its Pipelines section carries the vocab.
    const top = sectionOf(sections, hits[0]!.id);
    expect(top.docPath).toBe("docs/deployment.md");
    expect(top.sectionPath).toContain("Pipelines");
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score);
    }
  });

  it("scores title matches above body matches", () => {
    const a = makeSection("a.md::0", "a.md", "Plumbus Tuning", [
      "The widget spins at a steady rate under normal conditions today.",
    ]);
    const b = makeSection("b.md::0", "b.md", "Widget Maintenance", [
      "The plumbus tuning process requires care and a steady hand today.",
    ]);
    const idx = Bm25Index.build([a, b]);
    const hits = idx.search(["plumbus", "tune"], 5);
    expect(hits[0]!.id).toBe("a.md::0");
  });

  it("returns nothing for a term that is absent", () => {
    const idx = Bm25Index.build(corpusSections());
    expect(idx.search(["zzzqqq"], 5)).toHaveLength(0);
  });

  it("returns nothing for an empty query", () => {
    const idx = Bm25Index.build(corpusSections());
    expect(idx.search([], 5)).toHaveLength(0);
  });

  it("survives a toJSON/fromJSON roundtrip", () => {
    const sections = corpusSections();
    const idx = Bm25Index.build(sections);
    const terms = contentWords("oauth token refresh expiry");
    const before = idx.search(terms, 5);
    expect(before.length).toBeGreaterThan(0);
    const json = idx.toJSON();
    expect(typeof json).toBe("string");
    const revived = Bm25Index.fromJSON(json);
    const after = revived.search(terms, 5);
    expect(after.map((h) => [h.id, h.score.toFixed(6)])).toEqual(
      before.map((h) => [h.id, h.score.toFixed(6)]),
    );
  });

  it("termCount reports the number of indexed sections", () => {
    const sections = corpusSections();
    const idx = Bm25Index.build(sections);
    expect(idx.termCount()).toBe(sections.length);
  });

  it("idfSnapshot separates near-universal structural terms from rare ones", () => {
    // 9 sections all share "workflow" (near-universal → tiny idf); only the
    // rare section mentions "zephyr".
    const sections = Array.from({ length: 9 }, (_, i) =>
      makeSection(`common${i}.md::0`, `common${i}.md`, "Team Guide", [
        "Every team follows the workflow guidance in this team guide.",
      ]),
    );
    sections.push(
      makeSection("rare.md::0", "rare.md", "Team Guide", [
        "The zephyr protocol is documented only in this team guide.",
      ]),
    );
    const idx = Bm25Index.build(sections);
    const idf = idx.idfSnapshot(sections);
    expect(idf["workflow"]).toBeDefined();
    expect(idf["workflow"]!).toBeLessThan(0.3);
    expect(idf["zephyr"]!).toBeGreaterThanOrEqual(0.3);
    // Absent terms have no idf entry (callers treat them as 0).
    expect(idf["ghostterm"]).toBeUndefined();
  });
});
