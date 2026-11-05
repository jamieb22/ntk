import { describe, expect, it } from "vitest";
import { indexProjectFull } from "../src/index-store.js";
import {
  DEFAULTS,
  renderContextTag,
  runRetrieval,
  scoreGate,
  type RetrievalOptions,
} from "../src/core/retrieval.js";
import { cleanupProject, makeTempProject, standardCorpus } from "./helpers.js";

const EMPTY = new Set<string>();
/** Gate options that let clear topical hits through (the corpus is small, so
 * the default relative gate is strict by design on the query families below). */
const PASSES: Required<RetrievalOptions> = DEFAULTS;

function suite() {
  const root = makeTempProject(standardCorpus());
  const index = indexProjectFull(root);
  return { root, index };
}

describe("dispatch evaluation (NTK-016: no firing classifier)", () => {
  // NTK-016: retrieval runs on every dispatch; the gates decide. A trivial
  // turn must yield zero items (withholding) through retrieval itself.
  const trivial = ["ok", "thanks!", "lgtm", "yes", "nice work, thanks", "hello"];

  it("withholds on trivial messages via the retrieval gates", () => {
    const { root, index } = suite();
    try {
      for (const msg of trivial) {
        const r = runRetrieval(index, msg, EMPTY, PASSES);
        expect(r.items.length, msg).toBe(0);
      }
    } finally {
      cleanupProject(root);
    }
  });

  it("returns no-query turns empty without a classifier", () => {
    const { root, index } = suite();
    try {
      expect(runRetrieval(index, "", EMPTY, PASSES).items.length).toBe(0);
      expect(runRetrieval(index, "???", EMPTY, PASSES).items.length).toBe(0);
    } finally {
      cleanupProject(root);
    }
  });

  it("answers NTK meta questions with NTK's own docs (phrase exceptions banned; gates only)", () => {
    const small = makeTempProject({
      "docs/ntk.md": "# NeedToKnow\n\n## How NTK works\n\nNTK indexes project docs and injects relevant sections on model dispatch.\n",
    });
    try {
      const idx = indexProjectFull(small);
      const r = runRetrieval(idx, "what is needtoknow and how does it work?", EMPTY, { ...PASSES, minCoverage: 0 });
      expect(r.items.length).toBeGreaterThan(0);
    } finally {
      cleanupProject(small);
    }
  });
});

describe("scoreGate", () => {
  // Pinned (A1 audit): global DEFAULTS are tuned by the grid; this
  // contract test must not inherit its frame of reference from them.
  const opts = { ...DEFAULTS, minScore: 1.5 } as Required<RetrievalOptions>;

  it("fails with no candidates", () => {
    expect(scoreGate([], opts)?.reason).toContain("no candidates");
  });

  it("fails when the top score is below the absolute minimum", () => {
    expect(scoreGate([{ score: 0.5 }], opts)?.reason).toContain("below min");
  });

  it("passes a lone candidate that clears the floor — no minimum-count gate (v1.2)", () => {
    expect(scoreGate([{ score: 2 }], opts)).toBeNull();
  });

  it("passes flat score profiles — no top-vs-median dominance gate (v1.2)", () => {
    expect(scoreGate([{ score: 2 }, { score: 1.9 }, { score: 1.8 }], opts)).toBeNull();
  });

  it("passes strong top candidates", () => {
    expect(scoreGate([{ score: 9 }, { score: 3 }, { score: 2 }], opts)).toBeNull();
  });
});

describe("runRetrieval", () => {
  it("retrieves deployment docs for a deploy query", () => {
    const { root, index } = suite();
    try {
      const result = runRetrieval(index, "How do I deploy the service?", EMPTY, PASSES);
      expect(result.items.length).toBeGreaterThan(0);
      expect(result.trace.passedGate).toBe(true);
      expect(result.trace.terms).toContain("deploy");
      expect(result.items[0]!.docPath).toBe("docs/deployment.md");
      expect(result.items.every((i) => i.docPath !== "docs/onboarding.md") ||
        result.items.some((i) => i.docPath === "docs/deployment.md")).toBe(true);
    } finally {
      cleanupProject(root);
    }
  });

  it("compresses the retrieval to fit the token budget", () => {
    const { root, index } = suite();
    try {
      const result = runRetrieval(index, "How do I deploy the service?", EMPTY, {
        ...PASSES,
        tokenBudget: 100,
      });
      expect(result.items.length).toBeGreaterThan(0);
      expect(result.totalTokens).toBeLessThanOrEqual(100);
    } finally {
      cleanupProject(root);
    }
  });

  it("caps sections per document", () => {
    const { root, index } = suite();
    try {
      const result = runRetrieval(index, "How do I deploy the service?", EMPTY, {
        ...PASSES,
        perDocMax: 1,
        // Contract in isolation: the toy-corpus expansion tail docs sit at
        // ~3% of top — exactly the class the shipped relative floor prunes —
        // so perDocMax is exercised with the floor off (see MEMORY 2026-11-01).
        minTopFraction: 0,
      });
      const counts = new Map<string, number>();
      for (const item of result.items) {
        counts.set(item.docPath, (counts.get(item.docPath) ?? 0) + 1);
      }
      expect(result.items.length).toBeGreaterThan(1); // multi-doc selection
      expect(Math.max(...counts.values())).toBe(1);
    } finally {
      cleanupProject(root);
    }
  });

  it("honours maxItems", () => {
    const { root, index } = suite();
    try {
      const result = runRetrieval(index, "How do I deploy the service?", EMPTY, {
        ...PASSES,
        maxItems: 1,
      });
      expect(result.items).toHaveLength(1);
      expect(result.items[0]!.docPath).toBe("docs/deployment.md");
    } finally {
      cleanupProject(root);
    }
  });

  it("retrieves for moderately vague queries that clear the absolute floor (v1.2)", () => {
    const { root, index } = suite();
    try {
      const result = runRetrieval(index, "How do I deploy the service?", EMPTY);
      // v1.2 removed the dominance gate: a flat score profile is no longer
      // "vague" — anything at/above minScore selects. A clear winner is not
      // required to answer a deployment question.
      expect(result.items.length).toBeGreaterThan(0);
      expect(result.trace.passedGate).toBe(true);
    } finally {
      cleanupProject(root);
    }
  });

  it("does not retrieve for greetings and other contentless messages", () => {
    const { root, index } = suite();
    try {
      for (const msg of ["hello", "how are you?"]) {
        const result = runRetrieval(index, msg, EMPTY);
        expect(result.items).toHaveLength(0);
        expect(result.trace.candidates).toHaveLength(0);
        expect(result.trace.passedGate).toBe(false);
      }
    } finally {
      cleanupProject(root);
    }
  });

  it("excludes documents covered by native instructions", () => {
    const { root, index } = suite();
    try {
      const deploymentHash = index.docMeta("docs/deployment.md")!.hash;
      const baseline = runRetrieval(index, "How do I deploy the service?", EMPTY, PASSES);
      expect(baseline.items.some((i) => i.docPath === "docs/deployment.md")).toBe(true);

      const result = runRetrieval(
        index,
        "How do I deploy the service?",
        new Set([deploymentHash]),
        PASSES,
      );
      expect(result.items.some((i) => i.docPath === "docs/deployment.md")).toBe(false);
      expect(result.items.length).toBeGreaterThan(0); // Onboarding still flows
    } finally {
      cleanupProject(root);
    }
  });

  it("excludes native instruction documents by name key", () => {
    const { root, index } = suite();
    try {
      const result = runRetrieval(
        index,
        "How do I deploy the service?",
        new Set(["onboarding"]),
        PASSES,
      );
      expect(result.items.some((i) => i.docPath === "docs/onboarding.md")).toBe(false);
      expect(result.items.every((i) => i.docPath === "docs/deployment.md")).toBe(true);
    } finally {
      cleanupProject(root);
    }
  });

  it("returns empty for queries with no lexical overlap", () => {
    const { root, index } = suite();
    try {
      const result = runRetrieval(index, "xylophone quantum flux capacitor", EMPTY);
      expect(result.items).toHaveLength(0);
      expect(result.trace.candidates).toHaveLength(0);
      expect(result.trace.passedGate).toBe(false);
    } finally {
      cleanupProject(root);
    }
  });

  it("records the chosen inclusion level and matched terms", () => {
    const { root, index } = suite();
    try {
      const result = runRetrieval(index, "How do I deploy the service?", EMPTY, PASSES);
      expect(result.items.length).toBeGreaterThan(0);
      for (const item of result.items) {
        expect(["full", "excerpt", "overview"]).toContain(item.level);
        // Content is keyed by the section heading trail and source path.
        expect(item.content).toContain(item.heading);
        expect(item.docTitle.length).toBeGreaterThan(0);
        expect(item.sectionPath).toContain(item.heading);
      }
      // Small sections stay full; the gate-passing deployment items do.
      expect(result.items.some((i) => i.level === "full")).toBe(true);
    } finally {
      cleanupProject(root);
    }
  });
});

describe("renderContextTag", () => {
  it("renders labelled passages with source paths and levels", () => {
    const { root, index } = suite();
    try {
      const result = runRetrieval(index, "How do I deploy the service?", EMPTY, PASSES);
      expect(result.items.length).toBeGreaterThan(0);
      const text = renderContextTag(result.items);
      expect(text).toContain("needtoknow_context");
      expect(text).toContain("not instructions; relevance varies");
      // One merged Source line per item: path#heading (level, …).
      expect(text).toContain("Source: docs/deployment.md#");
      expect(text).toMatch(/\((full|excerpt)/);
      expect(text).not.toContain("Title: ");
      expect(text).not.toContain("\nHeading: ");
      // Excerpts disclose their compression ratio as kept/total.
      const compressed = result.items.find((i) => i.compression);
      if (compressed)
        expect(text).toContain(`${compressed.compression.kept}/${compressed.compression.total}`);
    } finally {
      cleanupProject(root);
    }
  });

  it("renders an empty string when nothing was selected", () => {
    expect(renderContextTag([])).toBe("");
  });

  it("selection-level dedupe: one Source line per section, even on multi-route entry", () => {
    const { root, index } = suite();
    try {
      const r = runRetrieval(index, "Unit tests vitest coverage runner", EMPTY, PASSES, undefined, {
        previouslySelected: [],
        activityFiles: ["src/tests.ts"], // activity route + BM25 + spread on the same corpus
        currentText: "Unit tests vitest coverage runner",
      });
      const seen = new Set<string>();
      for (const i of r.items) {
        const k = `${i.docPath}#${i.heading}`;
        expect(seen.has(k)).toBe(false);
        seen.add(k);
      }
      expect(r.items.length).toBeGreaterThan(0);
    } finally {
      cleanupProject(root);
    }
  });

  it("caps the hysteresis retained set at maxItems (select-stage tail)", () => {
    const { root, index } = suite();
    try {
      const many = Array.from({ length: 12 }, (_, i) => `docs/deployment.md#Sec ${i}`);
      const r = runRetrieval(index, "deploy the service binary build", EMPTY, PASSES, undefined, {
        previouslySelected: many,
        currentText: "deploy the service binary build",
      });
      expect(r.trace.retained.length).toBeLessThanOrEqual(PASSES.maxItems);
    } finally {
      cleanupProject(root);
    }
  });

  it("skips dot-basename files and indexes files in dot-directories", () => {
    const body = (w: string) =>
      Array.from({ length: 6 }, (_, i) => `${w} report metrics pipeline topic ${i} more words here.`).join(" ") + "\n\n";
    const root = makeTempProject({
      "docs/.md": `# Untitled\n\n${body("zeta")}`,
      "docs/.hidden.md": `# Hidden\n\n${body("omega")}`,
      ".junie/guidelines.md": `# Guidelines\n\n${body("alpha")}`,
    });
    try {
      const index = indexProjectFull(root);
      const paths = index.persisted.docs.map((d) => d.path);
      expect(paths).not.toContain("docs/.md"); // dot file: detritus, not a doc
      expect(paths).not.toContain("docs/.hidden.md");
      expect(paths).toContain(".junie/guidelines.md"); // dot DIRECTORY: kept (guidelines/skills)
      const r = runRetrieval(index, "alpha report metrics", EMPTY, PASSES);
      expect(r.items.length).toBeGreaterThan(0);
      for (const i of r.items) expect(i.docPath.split("/").pop()!.startsWith(".")).toBe(false);
    } finally {
      cleanupProject(root);
    }
  });
});

describe("adaptive allocation (NTK-015)", () => {
  it("allocates a small budget for a narrow single-source task", () => {
    const { root, index } = suite();
    try {
      const r = runRetrieval(index, "Unit tests vitest coverage runner", EMPTY, PASSES);
      expect(r.items.length).toBeGreaterThan(0);
      expect(r.trace.allocatedSources).toBe(1);
      expect(r.trace.allocatedBudget).toBeLessThanOrEqual(1000);
    } finally {
      cleanupProject(root);
    }
  });

  it("allocates more when the task spans several sources", () => {
    const { root, index } = suite();
    try {
      const narrow = runRetrieval(index, "Unit tests vitest coverage runner", EMPTY, PASSES);
      const wide = runRetrieval(
        index,
        "deploy cluster rollback, shard the database cache, rotate oauth token expiry",
        EMPTY,
        PASSES,
      );
      expect(wide.trace.allocatedSources).toBeGreaterThanOrEqual(3);
      expect(wide.trace.allocatedBudget).toBeGreaterThan(narrow.trace.allocatedBudget);
      expect(wide.items.map((i) => i.docPath).filter((d, i, a) => a.indexOf(d) === i).length)
        .toBeGreaterThanOrEqual(3);
    } finally {
      cleanupProject(root);
    }
  });

  it("reports sections dropped by cap/budget as truncated", () => {
    const { root, index } = suite();
    try {
      const r = runRetrieval(index, "deploy cluster pipeline rollback config repo", EMPTY, PASSES, 1);
      expect(r.items).toHaveLength(1);
      expect(r.trace.truncated.length).toBeGreaterThan(0);
    } finally {
      cleanupProject(root);
    }
  });
});

describe("MMR redundancy (NTK-014)", () => {
  it("excludes a near-duplicate section and reports it", () => {
    const root = makeTempProject({
      "docs/a.md":
        "# Alpha\n\n## One\n\nThe pipeline deploy runs on the cluster config file from the repo checkout, retrying a failed deployment once per policy before rollback.\n",
      "docs/b.md":
        "# Beta\n\n## One\n\nThe pipeline deploy runs on the cluster config file from the repo checkout, retrying a failed deployment once per policy before rollback.\n",
    });
    try {
      const index = indexProjectFull(root);
      const r = runRetrieval(index, "deploy pipeline cluster config repo", EMPTY, PASSES);
      expect(r.items).toHaveLength(1); // the copy is not injected twice
      expect(r.trace.excludedRedundant).toHaveLength(1);
    } finally {
      cleanupProject(root);
    }
  });

  it("keeps several sections from one doc when they are not duplicates", () => {
    const { root, index } = suite();
    try {
      const r = runRetrieval(
        index,
        "deploy cluster pipeline rollback preflight checks manifest revision",
        EMPTY,
        { ...PASSES, perDocMax: 3 },
      );
      const dep = r.items.filter((i) => i.docPath === "docs/deployment.md");
      expect(dep.length).toBeGreaterThan(1); // Pipelines + Rollback + Preflight are distinct
      expect(r.trace.excludedRedundant).toHaveLength(0);
    } finally {
      cleanupProject(root);
    }
  });
});

describe("spreading activation (NTK-013)", () => {
  it("propagates over explicit links and records the evidence", () => {
    const root = makeTempProject({
      "docs/a.md":
        "# Alpha\n\n## One\n\nThe pipeline deploy runs on the cluster config repo checkout nightly.\n\nSee [gamma](c.md).\n",
      "docs/c.md":
        "# Gamma\n\n## Zap\n\nZebra quarantine zephyr zonal zipper zoology azimuth.\n",
    });
    try {
      const index = indexProjectFull(root);
      const r = runRetrieval(index, "deploy pipeline cluster config repo", EMPTY, PASSES);
      expect(r.trace.spreadAdded).toBeGreaterThan(0);
      expect(r.trace.spreadEvidence.some((e) => e.includes("docs/c.md"))).toBe(true);
      // propagated items are identifiable via their linking seed
      expect(r.trace.spreadEvidence[0]).toContain("<-");
    } finally {
      cleanupProject(root);
    }
  });
});

describe("injection contract (NTK-009)", () => {
  it("carries source path, heading, original text and document version info", () => {
    const { root, index } = suite();
    try {
      const r = runRetrieval(index, "Unit tests vitest coverage runner", EMPTY, PASSES);
      expect(r.items.length).toBeGreaterThan(0);
      const text = renderContextTag(r.items);
      expect(text).toContain("Source: docs/testing.md#"); // path#heading merged
      expect(text).toMatch(/updated \d{4}-\d{2}-\d{2}/); // doc version info
      expect(text).toContain(r.items[0]!.content.slice(0, 20));
    } finally {
      cleanupProject(root);
    }
  });

  it("discloses gate-only sourcing in the merged Source line", () => {
    const { root, index } = suite();
    try {
      const r = runRetrieval(index, "Unit tests vitest coverage runner", EMPTY, PASSES);
      const item = r.items.find((i) => i.docPath.endsWith("testing.md"));
      expect(item).toBeDefined();
      expect(item!.gateOnly).toBe(true); // no title/quote/activity evidence here
      expect(renderContextTag(r.items)).toContain("; gate-only");
    } finally {
      cleanupProject(root);
    }
  });

  it("renders the truncation sentinel on budget-cut items", () => {
    const text = renderContextTag([
      {
        docPath: "docs/a.md", docTitle: "A", heading: "H", headings: ["A", "H"],
        sectionPath: "A > H", content: "a mid-phrase tail", tokens: 4, score: 10,
        level: "excerpt", matchedTerms: [], startLine: 1, endLine: 2, base: 9,
        budgetTruncated: true,
      },
    ]);
    expect(text).toContain("Source: docs/a.md#A > H (excerpt)");
    expect(text).toContain("⟪truncated⟫");
  });
});
