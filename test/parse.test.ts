import { describe, expect, it } from "vitest";
import { parseDocument } from "../src/core/parse.js";

function doc(lines: string[], relPath = "guide.md", fallback = "Guide"): ReturnType<typeof parseDocument>["sections"] {
  return parseDocument(lines.join("\n"), relPath, fallback).sections;
}

describe("parseDocument", () => {
  it("prefers the front matter title, then the first H1, then fallback", () => {
    const fm = doc(["---", "title: Front Matter Title", "---", "", "# Real Heading", "", "Body text long enough to be indexed here."]);
    expect(fm[0]!.docTitle).toBe("Front Matter Title");
    // Front matter is stripped from indexed text.
    expect(fm.some((s) => s.text.includes("Front Matter Title"))).toBe(false);

    const h1 = doc(["# H1 Title", "", "Body text long enough to be indexed here."]);
    expect(h1[0]!.docTitle).toBe("H1 Title");

    const plain = doc(["Just a paragraph of body text long enough to index."], "notes.txt", "Notes Fallback");
    expect(plain[0]!.docTitle).toBe("Notes Fallback");
  });

  it("builds heading trails and section paths", () => {
    const s = doc([
      "# Top",
      "",
      "Top level body text that is long enough for indexing.",
      "",
      "## Middle",
      "",
      "Middle body text that is also long enough for indexing.",
      "",
      "### Leaf",
      "",
      "Leaf body text that is also long enough for indexing.",
    ]);
    const byHeading = new Map(s.map((x) => [x.heading, x]));
    const leaf = byHeading.get("Leaf")!;
    expect(leaf.sectionPath).toBe("Top > Middle > Leaf");
    expect(leaf.headings).toEqual(["Top", "Middle", "Leaf"]);
    expect(leaf.level).toBe(3);
    expect(byHeading.get("Middle")!.sectionPath).toBe("Top > Middle");
  });

  it("the preamble section uses the doc title as its section path", () => {
    const s = doc(["Intro paragraph before any heading, long enough to index.", "", "# Later", "", "Text under the heading, long enough to be indexed."]);
    const preamble = s.find((x) => x.heading === "")!;
    expect(preamble.sectionPath).toBe(preamble.docTitle);
    expect(preamble.text).toContain("Intro paragraph");
  });

  it("drops short container sections and noise subtrees", () => {
    const s = doc([
      "# Guide",
      "",
      "## Table of Contents",
      "",
      "- [Intro](#intro) and more navigation text long enough",
      "",
      "## Empty",
      "",
      "tiny",
      "",
      "## References",
      "",
      "- [Link](https://example.com) entry long enough to index",
      "",
      "## Real",
      "",
      "Real content with enough text to be indexed by the section filter.",
    ]);
    const headings = s.map((x) => x.heading);
    expect(headings).not.toContain("Table of Contents");
    expect(headings).not.toContain("Empty");
    expect(headings).not.toContain("References");
    expect(headings).toContain("Real");
  });

  it("assigns sequential ids and ordinal/docSections", () => {
    const s = doc([
      "# A",
      "",
      "First section body text long enough for the index filter.",
      "",
      "## B",
      "",
      "Second section body text long enough for the index filter.",
    ]);
    s.forEach((sec, i) => {
      expect(sec.id).toBe(`guide.md::${i}`);
      expect(sec.ordinal).toBe(i);
      expect(sec.docSections).toBe(s.length);
      expect(sec.docPath).toBe("guide.md");
    });
  });

  it("keeps code fences, tables, and lists as atomic blocks", () => {
    const s = doc([
      "# Code Sample",
      "",
      "An intro sentence long enough to keep this section alive.",
      "",
      "```ts",
      "const a = 1;",
      "const b = 2;",
      "```",
      "",
      "- first item",
      "- second item",
      "",
      "| a | b |",
      "| - | - |",
      "| 1 | 2 |",
    ]);
    const sec = s.find((x) => x.heading === "Code Sample")!;
    const kinds = sec.blocks.map((b) => b.kind);
    expect(kinds).toContain("code");
    expect(kinds).toContain("list");
    // Markdown tables are atomic list-like blocks: the first `|` row starts
    // the block and the delimiter row extends it (isListContinuation accepts
    // table rows), so the table groups with the preceding list.
    expect(kinds.filter((k) => k === "list")).toHaveLength(2);
    const code = sec.blocks.find((b) => b.kind === "code")!;
    expect(code.text).toContain("const a = 1;");
    expect(code.text).toContain("const b = 2;"); // the whole fence is one block
    const list = sec.blocks.find((b) => b.kind === "list")!;
    expect(list.text).toContain("first item");
    expect(list.text).toContain("second item"); // consecutive items group together
  });

  it("populates derived fields: text, terms, fields, tokens", () => {
    const s = doc(["## Pipeline Config", "", "Configure the pipeline in the config file for pipelines."]);
    const sec = s.find((x) => x.heading === "Pipeline Config")!;
    expect(sec.text).toContain("Configure the pipeline");
    // Derived lexical fields from headings/body (natural's stemmer keeps
    // "pipeline" as-is; "configure"/"config" stem to "configur").
    expect(sec.terms.length).toBeGreaterThan(0);
    expect(sec.headings).toContain("pipeline");
    expect(sec.headings).toContain("config");
    expect(sec.fields.body.length).toBeGreaterThan(0);
    expect(sec.fields.title.length).toBeGreaterThan(0);
    expect(sec.tokens).toBeGreaterThan(0);
    expect(sec.startLine).toBeGreaterThanOrEqual(1);
  });

  it("does not emit sections for files with no content", () => {
    const s = doc([]);
    expect(s).toHaveLength(0);
  });
});
