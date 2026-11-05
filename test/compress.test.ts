import { describe, expect, it } from "vitest";
import { compressSection, DEFAULT_COMPRESS } from "../src/core/compress.js";
import { Bm25Index } from "../src/core/bm25.js";
import { estimateTokens } from "../src/core/tokenize.js";
import { makeSection, standardCorpus } from "./helpers.js";
import type { Block, InclusionLevel, SectionRecord } from "../src/core/types.js";

function sent(text: string): Block {
  return { kind: "sentence", text };
}

const sections: SectionRecord[] = [
  makeSection("doc/a.md#Overview:1", "doc/a.md", "Widget > Overview", [
    sent("Widget overview explains the core spinning assembly."),
    sent("The widget casing is machined from aluminum."),
    sent("Operators should inspect the bearings weekly."),
    sent("The zeppelin docking bay requires clearance permits."),
    sent("Unrelated logistics notes about shipping crates."),
    sent("More unrelated notes about warehouse inventory."),
    sent("Appendix notes on packaging materials."),
    sent("Final appendix notes on labeling."),
  ]),
];
const idf = Bm25Index.build(sections).idfSnapshot(sections);
const target = sections[0]!;

describe("compressSection", () => {
  it("full level keeps every block verbatim and reports matched terms", () => {
    const r = compressSection(target, ["zeppelin"], idf, "full");
    expect(r).not.toBeNull();
    expect(r!.content).toBe(`### ${target.heading}\n${target.blocks.map((b) => b.text).join("\n\n")}`.trim());
    // The full level renders everything verbatim, so no compression stats are reported.
    expect(r!.compression).toBeUndefined();
    expect(r!.tokens).toBe(estimateTokens(r!.content));
    expect(r!.matchedTerms).toContain("zeppelin");
  });

  it("overview level keeps only the first block", () => {
    const r = compressSection(target, [], idf, "overview");
    expect(r).not.toBeNull();
    expect(r!.content).toBe("### Overview\nWidget overview explains the core spinning assembly.");
    expect(r!.compression).toBeUndefined();
  });

  it("excerpt level always keeps the lead sentence and top matches, floored at 2", () => {
    const r = compressSection(target, ["zeppelin"], idf, "excerpt", { minSentences: 1, maxSentences: 3 });
    expect(r).not.toBeNull();
    // lead (first sentence) + the zeppelin sentence.
    expect(r!.content).toContain("Widget overview explains");
    expect(r!.content).toContain("zeppelin docking bay");
    expect(r!.content).not.toContain("packaging materials");
    expect(r!.compression!.kept).toBeGreaterThanOrEqual(2);
    expect(r!.compression!.total).toBe(8);
  });

  it("excerpt level pads to the min-sentence floor with highest-scoring remaining blocks", () => {
    const r = compressSection(target, ["zeppelin"], idf, "excerpt", { ...DEFAULT_COMPRESS, minSentences: 4 });
    expect(r!.compression!.kept).toBeGreaterThanOrEqual(4);
  });

  it("atomic code and table blocks are kept whole when they score", () => {
    const s = makeSection("doc/b.md#Guide:1", "doc/b.md", "Guide", [
      sent("The intro explains the config flow."),
      sent("Unrelated filler sentence one."),
      { kind: "code", text: "```\nntk_index({\n  watch: true,\n})\n```" },
      { kind: "table", text: "| a | b |\n|---|---|\n| 1 | 2 |" },
    ]);
    const idx = Bm25Index.build([s]);
    const r = compressSection(s, ["ntk_index"], idx.idfSnapshot([s]), "excerpt");
    expect(r!.content).toContain("watch: true"); // code block kept whole, not split
    expect(r!.compression!.kept).toBeLessThan(r!.compression!.total);
  });

  it("matches CJK terms by substring", () => {
    const s = makeSection("doc/c.md#中文:1", "doc/c.md", "中文", [
      sent("系统配置说明文档。"),
      sent("这是一段无关内容。"),
    ]);
    const idx = Bm25Index.build([s]);
    const r = compressSection(s, ["系统配置"], idx.idfSnapshot([s]), "excerpt");
    expect(r!.content).toContain("系统配置说明文档");
  });

  it("an empty section degenerates to just the heading", () => {
    const r = compressSection(makeSection("doc/d.md#Empty:1", "doc/d.md", "Empty", []), [], idf, "full");
    expect(r.content).toBe("### Empty\n");
    expect(r.matchedTerms).toEqual([]);
  });

  it("the oversized-section valve trims to the token budget", () => {
    const blocks: Block[] = Array.from({ length: 60 }, (_, i) =>
      sent(`Filler sentence number ${i} with plenty of extra words to consume tokens ${"padding ".repeat(20)}`),
    );
    const s = makeSection("doc/e.md#Big:1", "doc/e.md", "Big", blocks);
    const r = compressSection(s, [], idf, "full");
    expect(r.tokens).toBeLessThan(800);
    expect(r.content).not.toContain("number 59");
  });

  it("keeps the lone block in full when it alone exceeds the budget", () => {
    const s = makeSection("doc/f.md#Single:1", "doc/f.md", "Single", [
      sent("Oversized ".repeat(300) + "single block content"),
    ]);
    const r = compressSection(s, [], idf, "full");
    expect(r.content).toContain("Oversized");
    expect(r.content).toContain("single block content");
    expect(r.budgetTruncated).not.toBe(true); // kept whole → no sentinel
  });

  it("flags a mid-block tail cut by the section token cap (multi-block)", () => {
    const s = makeSection("doc/f.md#Two:1", "doc/f.md", "Two", [
      "Oversized ".repeat(600),
      "second block",
    ]);
    const r = compressSection(s, [], idf, "full");
    expect(r.budgetTruncated).toBe(true);
    expect(estimateTokens(r.content)).toBeLessThan(600);
  });
});
