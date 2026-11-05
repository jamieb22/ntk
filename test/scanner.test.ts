import { describe, it, expect } from "vitest";
import { indexProject } from "../src/core/scanner.js";
import {
  standardCorpus,
  makeTempProject,
  cleanupProject,
} from "./helpers.js";

describe("indexProject", () => {
  it("indexes the markdown corpus (cap-excluded files are not skipped)", () => {
    const root = makeTempProject(standardCorpus());
    try {
      const result = indexProject(root);
      const paths = result.files.map((f) => f.path);
      expect(paths).toContain("docs/deployment.md");
      expect(paths).toContain("docs/testing.md");
      expect(paths).toContain("docs/api.md");
      expect(paths).toContain("docs/architecture.md");
      expect(paths).toContain("docs/onboarding.md");
      expect(paths).toContain("docs/code-sample.md");
      // oversized.md exceeds the 512KB cap: never indexed, never counted skipped
      expect(paths).not.toContain("docs/oversized.md");
      expect(result.skipped).toBe(0);
      expect(result.indexedFiles).toBe(6);
      expect(
        result.docMetas.find((d) => d.path === "docs/deployment.md")?.title,
      ).toBe("Deployment Guide");
      expect(result.sections.some((s) => s.docPath === "docs/deployment.md")).toBe(true);
      expect(result.indexMs).toBeGreaterThanOrEqual(0);
    } finally {
      cleanupProject(root);
    }
  });

  it("applies .gitignore at the root and in subdirectories", () => {
    const root = makeTempProject({
      ".gitignore": "generated/\n",
      "generated/spec.md": "# Generated\n",
      "docs/.gitignore": "draft.md\n",
      "docs/draft.md": "# Draft\n",
      "docs/final.md": "# Final\n",
    });
    try {
      const result = indexProject(root);
      const paths = result.files.map((f) => f.path);
      expect(paths).not.toContain("generated/spec.md");
      expect(paths).not.toContain("docs/draft.md");
      expect(paths).toContain("docs/final.md");
    } finally {
      cleanupProject(root);
    }
  });

  it("excludes default directories", () => {
    const root = makeTempProject({
      "node_modules/pkg/readme.md": "# No\n",
      ".next/build.md": "# No\n",
      "dist/bundle.md": "# No\n",
      "docs/real.md": "# Real\n\nOnly this one counts.\n",
    });
    try {
      const result = indexProject(root);
      expect(result.files.map((f) => f.path)).toEqual(["docs/real.md"]);
    } finally {
      cleanupProject(root);
    }
  });

  it("honours negation rules (!pattern)", () => {
    const root = makeTempProject({
      ".gitignore": "generated/*\n!generated/keep.md\n",
      "generated/keep.md": "# Kept\n",
      "generated/skip.md": "# Skipped\n",
      "docs/a.md": "# A\n",
    });
    try {
      const result = indexProject(root);
      const paths = result.files.map((f) => f.path).sort();
      expect(paths).toEqual(["docs/a.md", "generated/keep.md"]);
    } finally {
      cleanupProject(root);
    }
  });

  it("onlyFiles restricts indexing; [] is not a restriction", () => {
    const root = makeTempProject(standardCorpus());
    try {
      const restricted = indexProject(root, { onlyFiles: ["docs/api.md"] });
      expect(restricted.files.map((f) => f.path)).toEqual(["docs/api.md"]);
      const unrestricted = indexProject(root, { onlyFiles: [] });
      // an empty allow-list IS restrictive: it selects nothing
      expect(unrestricted.files.length).toBe(0);
    } finally {
      cleanupProject(root);
    }
  });

  it("collects PMI expansion terms for heavily co-occurring stems", () => {
    // PMI needs co-occurrence ≥ MIN_CO=3 and pmi > MIN_PMI=1.2 bits, so the
    // two stems must co-occur in 3 of 8 sections (log2(3·8/9) ≈ 1.41) while
    // every other section avoids them.
    const pair = (n: number) =>
      `## Pair ${n}\n\nWibbly widgets require wobbling tools before run ${n}.\n`;
    const filler = (n: number) =>
      `## Filler ${n}\n\nThe glorp${n} flumes the quine${n} under the zolm${n}.\n`;
    const root = makeTempProject({
      "docs/widget.md":
        "# Widget\n\n" +
        [1, 2, 3].map(pair).concat([4, 5, 6, 7, 8].map(filler)).join("\n"),
    });
    try {
      const result = indexProject(root);
      // ExpansionDict is a plain object keyed by stem; values are [term, pmi][] pairs.
      expect(typeof result.expansion).toBe("object");
      const entries = Object.entries(result.expansion);
      expect(entries.length).toBeGreaterThan(0);
      for (const [stem, pairs] of entries) {
        expect(typeof stem).toBe("string");
        expect(Array.isArray(pairs)).toBe(true);
        for (const [term, pmi] of pairs) {
          expect(typeof term).toBe("string");
          expect(pmi).toBeGreaterThan(0);
        }
      }
      // The two co-occurring stems must be linked in at least one direction.
      const linked = Object.entries(result.expansion).some(
        ([stem, pairs]) =>
          pairs.some(
            ([term]) =>
              (stem.startsWith("wibbli") && term.startsWith("wobbl")) ||
              (stem.startsWith("wobbl") && term.startsWith("wibbli")),
          ),
      );
      expect(linked).toBe(true);
    } finally {
      cleanupProject(root);
    }
  });
});
