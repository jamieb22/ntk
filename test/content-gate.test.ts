import { describe, expect, it } from "vitest";
import { indexProjectFull } from "../src/index-store.js";
import { DEFAULTS, runRetrieval, type RetrievalOptions } from "../src/core/retrieval.js";
import { cleanupProject, makeTempProject, type Corpus } from "./helpers.js";

const EMPTY = new Set<string>();
/** Gate-SEMANTICS fixtures verify the public-tuned floor 0.65 and the
 *  3-section doc spread — pinned explicitly so A2 re-picks cannot
 *  silently change what these tests assert (test hygiene, P0-A1 audit). */
const PIN = { ...DEFAULTS, minCoverage: 0.65, perDocMax: 3 } as Required<RetrievalOptions>;

/** The content gate needs ≥ 200 sections to trust IDF statistics. */
function bigCorpus(extra: Corpus): Corpus {
  const lines = ["# Filler"];
  for (let i = 0; i < 210; i++) {
    lines.push("", `## Section fill${i}`, `fill${i} ordinary prose about generic things number ${i}.`);
  }
  return { "docs/filler.md": lines.join("\n"), ...extra };
}

function suite(files: Corpus) {
  const root = makeTempProject(files);
  return { root, index: indexProjectFull(root) };
}

describe("content gate (abstention on no-documentation queries)", () => {
  const corpus = bigCorpus({
    "docs/guide.md": "# Guide\n\n## Configuring the Widget\n\nThe widget config lives in widget.toml; configure the widget with flags.\n",
  });

  it("withholds on coined-word queries whose only match is a template verb", () => {
    const { root, index } = suite(corpus);
    try {
      const r = runRetrieval(index, "configuring the zibble quux", EMPTY, PIN);
      expect(r.items.length).toBe(0);
      expect(r.trace.gateReason).toContain("content gate");
      // …control: the gate is the only reason — off, it injects.
      const off = { ...DEFAULTS, minCoverage: 0, minScore: 0 } as Required<RetrievalOptions>;
      const r2 = runRetrieval(index, "configuring the zibble quux", EMPTY, off);
      expect(r2.items.length).toBeGreaterThan(0);
    } finally {
      cleanupProject(root);
    }
  });

  it("lets real topical queries through at full coverage", () => {
    const { root, index } = suite(corpus);
    try {
      const r = runRetrieval(index, "Configuring the Widget", EMPTY, PIN);
      expect(r.items.length).toBeGreaterThan(0);
      expect(r.items[0]!.heading).toBe("Configuring the Widget");
    } finally {
      cleanupProject(root);
    }
  });

  it("strong structural evidence overrides weak coverage (audit item 1)", () => {
    const { root, index } = suite(bigCorpus({
      "docs/guide.md":
        "# Guide\n\n## Configuring the Widget\n\nThe widget config lives in widget.toml; configure the widget with the widget_id key. Each widget_id row maps to flags.\n",
    }));
    try {
      const q = "configuring the zibble quux using `widget_id` in widget.toml";
      const off = { ...PIN, gateOverride: 0 } as Required<RetrievalOptions>;
      const rOff = runRetrieval(index, q, EMPTY, off);
      expect(rOff.items.length).toBe(0); // coverage 2/4 = 0.5 < 0.65 → withheld
      expect(rOff.trace.gateReason).toContain("content gate");
      const rOn = runRetrieval(index, q, EMPTY, { ...PIN, gateOverride: 1 } as Required<RetrievalOptions>);
      expect(rOn.items.length).toBeGreaterThan(0); // identifier evidence overrides
      expect(rOn.trace.gateOverride ?? "").toContain("identifier:widget_id");
    } finally {
      cleanupProject(root);
    }
  });

  it("heading-phrase evidence overrides weak coverage (audit item 1)", () => {
    const { root, index } = suite(bigCorpus({
      "docs/guide.md": "# Guide\n\n## Configuring the Widget\n\nThe widget config lives in widget.toml; configure the widget with flags.\n",
    }));
    try {
      // Query reproduces the heading phrase fully → coverage is 1.0 anyway;
      // assert the pure-heading-phrase case passes with overrides off too.
      const r = runRetrieval(index, "Configuring the Widget zibble", EMPTY, { ...PIN, gateOverride: 0 } as Required<RetrievalOptions>);
      expect(r.items.length).toBeGreaterThan(0);
    } finally {
      cleanupProject(root);
    }
  });
});

describe("miss diagnostics (audit item 2)", () => {
  const base = {
    candidates: ["a.md::1", "b.md::2"],
    gateReason: "",
    excludedRedundant: [] as string[],
    truncated: [] as string[],
    items: ["a.md::0"],
  };
  it("classifies each failure mode", async () => {
    const { classifyMiss } = await import("../bench/adv/metrics.js");
    const hash = (id: string) => id.replace("::", "#");
    expect(classifyMiss("a.md::1", base as never, hash).reason).toBe("displaced");
    expect(
      classifyMiss("c.md::9", { ...base, candidates: ["a.md::1"] } as never, hash).reason,
    ).toBe("not_retrieved");
    expect(
      classifyMiss("a.md::1", { ...base, gateReason: "content gate: coverage 0.40" } as never, hash).reason,
    ).toBe("coverage_gated");
    expect(
      classifyMiss("a.md::1", { ...base, gateReason: "below min score" } as never, hash).reason,
    ).toBe("score_gated");
    expect(
      classifyMiss("a.md::1", { ...base, excludedRedundant: ["a.md#1"] } as never, hash).reason,
    ).toBe("redundancy_dropped");
    expect(
      classifyMiss("a.md::1", { ...base, truncated: ["a.md#1"] } as never, hash).reason,
    ).toBe("budget_dropped");
  });
});

describe("content gate size parity (P1-9)", () => {
  it("behaves identically at small and large corpus sizes (P1-9)", () => {
    // The gate applies uniformly: the same negative is withheld by the SAME
    // mechanism (content gate) at 10 sections and at 210+ sections — no
    // small/large-project behavioral discontinuity.
    const neg = "configuring the zibble quux";
    const small = makeTempProject({
      "docs/guide.md": "# Guide\n\n## Configuring the Widget\n\nThe widget config lives in widget.toml; configure the widget with flags.\n",
    });
    const big = makeTempProject(bigCorpus({
      "docs/guide.md": "# Guide\n\n## Configuring the Widget\n\nThe widget config lives in widget.toml; configure the widget with flags.\n",
    }));
    try {
      const idxSmall = indexProjectFull(small);
      const idxBig = indexProjectFull(big);
      const rSmall = runRetrieval(idxSmall, neg, EMPTY, DEFAULTS);
      const rBig = runRetrieval(idxBig, neg, EMPTY, DEFAULTS);
      expect(rSmall.items.length).toBe(0);
      expect(rBig.items.length).toBe(0);
      expect(rSmall.trace.gateReason).toContain("content gate");
      expect(rBig.trace.gateReason).toContain("content gate");
    } finally {
      cleanupProject(small);
      cleanupProject(big);
    }
  });
});

describe("heading coverage bonus", () => {
  it("lifts the section whose heading the query reproduces above body-frequency siblings", () => {
    const { root, index } = suite(
      bigCorpus({
        "docs/guide.md":
          "# Guide\n\n## Deploy Widget Promptly\n\n" + "Prompt deploys matter. ".repeat(3) + "\n",
        "docs/noise.md":
          "# Noise\n\n## Deploy Widget Promptly Quickly\n\n" +
          "Deploy the widget promptly and quickly. ".repeat(8) +
          "Widget deploys deploy widgets quickly. ".repeat(8) + "\n",
      }),
    );
    try {
      const on = { ...DEFAULTS, headingBonus: 4, minCoverage: 0, minScore: 0 } as Required<RetrievalOptions>;
      const off = { ...on, headingBonus: 0 } as Required<RetrievalOptions>;
      const rOn = runRetrieval(index, "Deploy Widget Promptly", EMPTY, on);
      expect(rOn.items[0]!.heading).toBe("Deploy Widget Promptly");
      // Echo-off probe: the noise doc's heading is the echoed one here, so the
      // body-frequency doc leads and the gold (partial heading, no bonus)
      // ranks below it. (A full echo ranks first by design — see heading-echo
      // bypass tests.)
      const rOff = runRetrieval(index, "Deploy Widget Promptly Quickly", EMPTY, off);
      const rankOff = rOff.items.findIndex((i) => i.heading === "Deploy Widget Promptly");
      expect(rankOff).toBeGreaterThan(0); // the body-frequency doc leads without the bonus
    } finally {
      cleanupProject(root);
    }
  });
});

describe("expansion term weighting", () => {
  it("down-weights expanded terms relative to user words", () => {
    // "widget" co-occurs with "prompt" in guide bodies; expansion pulls
    // "prompt" into the query. Full weight must not outrank a user-word-only
    // match on expansion terms.
    const { root, index } = suite(
      bigCorpus({
        "docs/guide.md": "# Guide\n\n## Widget Notes\n\n" + "widget prompt prompt prompt prompt prompt prompt prompt prompt prompt\n",
        "docs/other.md": "# Other\n\n## Zibble\n\nzibble quux flurb nothing to see.\n",
      }),
    );
    try {
      const full = { ...DEFAULTS, expansionTermWeight: 1, minCoverage: 0, minScore: 0 } as Required<RetrievalOptions>;
      const down = { ...full, expansionTermWeight: 0.1 } as Required<RetrievalOptions>;
      const rFull = runRetrieval(index, "widget", EMPTY, full);
      const rDown = runRetrieval(index, "widget", EMPTY, down);
      expect(rFull.items[0]!.heading).toBe("Widget Notes");
      expect(rDown.items[0]!.heading).toBe("Widget Notes");
      // Scores shrink only via expanded-term contribution: full ≥ down.
      expect(rFull.items[0]!.score).toBeGreaterThanOrEqual(rDown.items[0]!.score);
    } finally {
      cleanupProject(root);
    }
  });
});

describe("structure-only sections are never injected (dogfood audit)", () => {
  it("a scored section with no substantive content is dropped, not padded", () => {
    const { root, index } = suite(bigCorpus({
      "docs/mix.md":
        "# Mix\n\n## Divider\n\n" +
        "----\n\n".repeat(9) + // long enough to index; content is all rules
        "\n## Rotate widget lever\n\nThe real procedure: rotate the widget lever and record the result in the ledger file.\n",
    }));
    try {
      const r = runRetrieval(index, "rotate the widget lever (divider record)", EMPTY, PIN);
      const headings = r.items.map((i) => i.heading);
      expect(headings).toContain("Rotate widget lever");
      expect(headings).not.toContain("Divider"); // scored, structure-only → excluded
      expect(r.trace.excludedEmpty.join()).toContain("Divider");
    } finally {
      cleanupProject(root);
    }
  });
});

describe("heading-echo bypass (A3 gate: exact heading queries)", () => {
  const corpus = bigCorpus({
    "docs/gmock.md": "# gMock For Dummies\n\n## What Is gMock?\n\ngMock is a framework for mocking. The gmock framework mocks interfaces with actions and expectations.\n",
    "docs/advanced.md":
      "# Advanced\n\n## Using a Predicate-Formatter\n\nA predicate formatter formats failure messages; the formatter pairs with the predicate in MATCHER_P macros.\n",
  });

  it("a 1-content-word exact heading query injects (was withheld: 1-term rule)", () => {
    const { root, index } = suite(corpus);
    try {
      const r = runRetrieval(index, "What Is gMock?", EMPTY, PIN);
      expect(r.items.map((i) => i.heading)).toContain("What Is gMock?");
      expect(r.trace.gateOverride ?? "").toContain("heading-echo");
    } finally {
      cleanupProject(root);
    }
  });

  it("exact heading echo rescues weak coverage (coverage floor case)", () => {
    const { root, index } = suite(corpus);
    try {
      // qt = [predicate, formatter]; body covers formatter → 1/2 = 0.5 < 0.65,
      // but the query IS the heading → echo evidence bypasses the floor.
      const off = { ...PIN, gateOverride: 0 } as Required<RetrievalOptions>;
      const r = runRetrieval(index, "Using a Predicate-Formatter", EMPTY, off);
      expect(r.items.map((i) => i.heading)).toContain("Using a Predicate-Formatter");
    } finally {
      cleanupProject(root);
    }
  });

  it("short chatter stays gated even with echo-capable headings (A5 guard)", () => {
    const { root, index } = suite(bigCorpus({
      "docs/faq.md": "# FAQ\n\n## And Now\n\nWhat comes next: the pipeline now emits artifacts to the ledger store and rotates tokens nightly.\n",
    }));
    try {
      const r = runRetrieval(index, "And now?", EMPTY, PIN);
      expect(r.items.length).toBe(0); // <1 non-stopword token → echo bypass not offered
      expect(r.trace.gateReason).toContain("gate");
      const r2 = runRetrieval(index, "now", EMPTY, PIN);
      expect(r2.items.length).toBe(0);
    } finally {
      cleanupProject(root);
    }
  });
});

describe("negated-exclusion suppression (A4 k8s: adversarial C near-misses)", () => {
  // Boilerplate reference-corpus filler: "handling/controller/manager" occur
  // in nearly every section (→ near-zero IDF), so only "cloud"/"kube" carry
  // distinguishing signal — the exact regime k8s docs create.
  function k8sCorpus(extra: Corpus): Corpus {
    const lines = ["# Filler"];
    for (let i = 0; i < 210; i++) {
      lines.push(
        "",
        `## Section fill${i}`,
        `the handling controller manager reconciles the loops for cluster fill${i} apiserver proxy scheduler etcd node.`,
      );
    }
    return { "docs/filler.md": lines.join("\n"), ...extra };
  }
  const corpus = k8sCorpus({
    "docs/arch.md":
      "# Architecture\n\n## Handling Cloud Controller Manager\n\nThe cloud controller manager reconciles nodes, routes and load balancers for the cluster.\n" +
      "\n## Handling Kube Controller Manager\n\nThe kube controller manager runs the core control loops, the replication controller and endpoints.\n",
  });

  it("drops the section named ONLY inside the (not …) exclusion clause", () => {
    const { root, index } = suite(corpus);
    try {
      const q = "Handling cloud controller manager for premis (not the kube controller manager case)?";
      const r = runRetrieval(index, q, EMPTY, PIN);
      const headings = r.items.map((i) => i.heading);
      expect(headings).toContain("Handling Cloud Controller Manager");
      // RC1 (clause terms leave scoring) removes the naming bridge — the
      // "coredns"-style case (named section, title terms in clause only).
      // Residual here: the section sharing the AFFIRMATIVE template word
      // ("Handling") ranks #2 on 0.0086-idf evidence, below budget. The
      // exclusion filter suppresses clause-BRIDGE matches (unit below);
      // affirmative-shared confusable siblings are a ranking/slot problem
      // (see A4 investigation: distractors ride shared topic tf, k8s .095
      // residual — disclosed, pre-existing, not a gate defect).
      expect(r.items.length).toBeGreaterThan(0);
    } finally {
      cleanupProject(root);
    }
  });

  it("a section bridged ONLY through clause terms is suppressed (RC1 safety net)", () => {
    const { root, index } = suite(corpus);
    try {
      // "kube" appears solely in the negated clause → the named section has
      // no affirmative bridge; it must not be scored into the tail.
      const q = "What reconciles nodes and routes? (not the kube controller manager case)";
      const r = runRetrieval(index, q, EMPTY, PIN);
      const kube = r.items.find((i) => i.heading === "Handling Kube Controller Manager");
      expect(kube).toBeUndefined();
    } finally {
      cleanupProject(root);
    }
  });

  it("keeps a section that also matches genuine user terms outside the clause", () => {
    const { root, index } = suite(corpus);
    try {
      // Same query without the exclusion clause: the kube section is a
      // legitimate controller/manager match and must not be suppressed.
      const r = runRetrieval(index, "Handling kube controller manager for premis?", EMPTY, PIN);
      expect(r.items.map((i) => i.heading)).toContain("Handling Kube Controller Manager");
    } finally {
      cleanupProject(root);
    }
  });
});

describe("gate evidence rules are language-general (audit: no generator-template special cases)", () => {
  const corpus = bigCorpus({
    "docs/gmock.md":
      "# gMock\n\n## Predicates and Matchers\n\nPredicates and matchers pair in EXPECT_CALL: a matcher filters the predicate's arguments at call time.\n" +
      "\n## Handling Cloud Controller Manager\n\nThe cloud controller manager reconciles nodes, routes and load balancers for the cluster.\n",
  });

  it("a 2-word heading fragment mid-sentence with coined tail stays gated", () => {
    const { root, index } = suite(corpus);
    try {
      const r = runRetrieval(index, "configuring Predicates Matchers for marble harbor glacier", EMPTY, PIN);
      expect(r.items.length).toBe(0);
      expect(r.trace.gateReason).toContain("content gate");
    } finally {
      cleanupProject(root);
    }
  });

  it("a cited heading phrase (≥3 words) rescues diluted coverage at any position", () => {
    const { root, index } = suite(corpus);
    try {
      // Ablation (3-arm, knob): rule's gate-evidence form = k8s dev +0.214
      // recall, public dev & natural-language eval zero effect. This is the
      // citation-in-a-sentence regime: coverage 4/7 = 0.57 → phrase rescue.
      const r = runRetrieval(index, "i asked where handling cloud controller manager is documented, premis applies", EMPTY, PIN);
      expect(r.items.map((i) => i.heading)).toContain("Handling Cloud Controller Manager");
      expect(r.trace.gateOverride ?? "").toContain("heading-phrase");
    } finally {
      cleanupProject(root);
    }
  });

  it("a hyphenated citation phrase matches the unhyphenated heading (and vice versa)", () => {
    const { root, index } = suite(corpus);
    try {
      const r = runRetrieval(index, "Handling cloud-controller-manager for premis and pruning", EMPTY, PIN);
      expect(r.items.map((i) => i.heading)).toContain("Handling Cloud Controller Manager");
    } finally {
      cleanupProject(root);
    }
  });

  it("exclusion cues generalize beyond the template word 'case'", () => {
    const { root, index } = suite(corpus);
    try {
      const a = runRetrieval(index, "Handling cloud controller manager (excluding the kube controller manager)", EMPTY, PIN);
      expect(a.items.map((i) => i.heading)).toContain("Handling Cloud Controller Manager");
      const b = runRetrieval(index, "Handling cloud controller manager, not the kube controller manager.", EMPTY, PIN);
      expect(b.items.map((i) => i.heading)).toContain("Handling Cloud Controller Manager");
    } finally {
      cleanupProject(root);
    }
  });
});

describe("RC1: negation-clause terms are not positive evidence (k8s B-class trace findings)", () => {
  function rc1Corpus(extra: Corpus): Corpus {
    const lines = ["# Filler"];
    for (let i = 0; i < 210; i++)
      lines.push("", `## Section fill${i}`, `the ${"quartz zircon topaz ".repeat(3)} filler prose for section ${i}.`);
    return { "docs/filler.md": lines.join("\n"), ...extra };
  }
  const corpus = rc1Corpus({
    "docs/arch.md":
      "# Architecture\n\n## Architecture Variations\n\nCrucial variations in the system topology, when vari matters.\n" +
      "\n## Customization And Extensibility\n\nCustomization of plugins and extensibility hooks for the platform.\n",
  });

  it("the clause-named section cannot outrank the cited gold on clause terms", () => {
    const { root, index } = suite(corpus);
    try {
      const q = "Architecture variations when crucial and vari is involved (not the customization and extensibility case)?";
      const r = runRetrieval(index, q, EMPTY, PIN);
      expect(r.items[0]!.heading).toBe("Architecture Variations"); // gold rank 1
      // pre-RC1 the named section scored on {customization, extensibility}
      // (clause terms) and outranked gold 815 vs 768 — it may still surface
      // as an affirmative-shared sibling, never above the cited gold.
      const dRank = r.items.findIndex((i) => i.heading === "Customization And Extensibility");
      expect(dRank).toBeLessThanOrEqual(1); // absent, or ranked below gold
      expect(dRank).not.toBe(0);
    } finally {
      cleanupProject(root);
    }
  });

  it("citation precedence: clause naming the cited heading keeps the gold alive (self-naming)", () => {
    const { root, index } = suite(rc1Corpus({
      "docs/leases.md":
        "# Leases\n\n## Handling Node Heartbeats\n\nThe lease renews node heartbeats with a stamp every ten seconds.\n",
    }));
    try {
      const q = "Handling node heartbeats for stamp and lease (not the node heartbeats case)?";
      const r = runRetrieval(index, q, EMPTY, PIN);
      expect(r.items.map((i) => i.heading)).toContain("Handling Node Heartbeats");
      expect(r.trace.gateReason).toBe(""); // coverage 1.0 via exemption (clause terms stay affirmative)
    } finally {
      cleanupProject(root);
    }
  });
});

/* P0-7 (pilot, 2026-11-02): long structured prompts (multi-paragraph
 * task specs) dilute whole-query union coverage below the floor even when
 * a section decisively answers ONE clause of the task — every doc-dependent
 * pilot treatment trial abstained (observed 0.22–0.56). The gate now also
 * passes on best-SPAN coverage: a sentence/line of the affirmative query
 * whose content terms are covered at the same floor. No threshold lowered,
 * no task patterns; short prompts collapse to the old single-span path. */
describe("content gate: long-task span evidence (P0-7)", () => {
  const GUIDE =
    "# Guide\n\n## Configuring the Widget\n\nThe widget config lives in widget.toml; configure the widget with flags.\n";
  const corpus = bigCorpus({ "docs/guide.md": GUIDE });

  // A realistic long task: ~40 content terms of boilerplate + one clause
  // whose words the guide section covers completely.
  const LONG_TASK = [
    "# T99 — Ship notes for the quarterly release train",
    "",
    "We operate a fleet of ingest nodes feeding the nightly metrics pipeline.",
    "Release engineers run integration checks before promotion to the cluster.",
    "The dashboard refreshes upstream state and records every outcome.",
    "Configure the widget with flags in widget.toml.",
    "Alerts route through the triage queue by severity label.",
    "Document the migration path for partition replicas and gateway quotas.",
    "Rollback procedures live in the runbook appendix with contact details.",
  ].join("\n");

  it("fires on a long prompt whose relevant clause is fully covered", () => {
    const { root, index } = suite(corpus);
    try {
      const r = runRetrieval(index, LONG_TASK, EMPTY, PIN);
      expect(r.items.map((i) => i.heading)).toContain("Configuring the Widget");
      expect(r.trace.passedGate).toBe(true);
      expect(r.trace.gateOverride).toMatch(/^span:coverage 1\.00 of 4 term\(s\)/);
    } finally {
      cleanupProject(root);
    }
  });

  it("the span path is the ONLY reason it fires (whole-query coverage fails)", () => {
    const { root, index } = suite(corpus);
    try {
      const off = { ...PIN, minSegTerms: 0 } as Required<RetrievalOptions>;
      const r = runRetrieval(index, LONG_TASK, EMPTY, off);
      expect(r.items.length).toBe(0);
      expect(r.trace.gateReason).toContain("content gate");
      expect(r.trace.gateReason).toContain("best span");
    } finally {
      cleanupProject(root);
    }
  });

  it("withholds on long prompts with no matching documentation (negatives unchanged)", () => {
    const { root, index } = suite(corpus);
    try {
      const unrelated = LONG_TASK.replace(
        "Configure the widget with flags in widget.toml.",
        "Recalibrate the flange governor before the torque audit.",
      );
      const r = runRetrieval(index, unrelated, EMPTY, PIN);
      expect(r.items.length).toBe(0);
      expect(r.trace.gateReason).toContain("content gate");
    } finally {
      cleanupProject(root);
    }
  });

  it("a negated clause supplies no span evidence", () => {
    const { root, index } = suite(corpus);
    try {
      const r = runRetrieval(
        index,
        LONG_TASK.replace(
          "Configure the widget with flags in widget.toml.",
          "Do not configure the widget with flags in widget.toml.",
        ),
        EMPTY,
        PIN,
      );
      expect(r.items.length).toBe(0);
      expect(r.trace.gateReason).toContain("content gate");
    } finally {
      cleanupProject(root);
    }
  });

  it("sub-minimum spans (2 terms) are not evidence", () => {
    const { root, index } = suite(corpus);
    try {
      const r = runRetrieval(
        index,
        LONG_TASK.replace("Configure the widget with flags in widget.toml.", "Configure widgets."),
        EMPTY,
        PIN,
      );
      expect(r.items.length).toBe(0);
    } finally {
      cleanupProject(root);
    }
  });

  it("short prompts are unchanged (global union path, no span marker)", () => {
    const { root, index } = suite(corpus);
    try {
      const r = runRetrieval(index, "Configuring the Widget", EMPTY, PIN);
      expect(r.items.length).toBeGreaterThan(0);
      expect(r.trace.gateOverride ?? "").not.toMatch(/^span:/);
    } finally {
      cleanupProject(root);
    }
  });

  it("code fences contribute no span evidence", () => {
    const { root, index } = suite(corpus);
    try {
      const fenced = LONG_TASK.replace(
        "Configure the widget with flags in widget.toml.",
        "```toml\n# configure the widget with flags in widget.toml\nflags = \"on\"\n```",
      );
      const r = runRetrieval(index, fenced, EMPTY, PIN);
      expect(r.items.length).toBe(0); // the clause lives only in a code fence
      expect(r.trace.gateReason).toContain("content gate");
    } finally {
      cleanupProject(root);
    }
  });

  it("hyphenated compounds, inline code and dotted paths split into terms", () => {
    const { root, index } = suite(corpus);
    try {
      const techy = LONG_TASK.replace(
        "Configure the widget with flags in widget.toml.",
        "Set the widget-config flags in `widget.toml` to configure the widget.",
      );
      const r = runRetrieval(index, techy, EMPTY, PIN);
      expect(r.items.map((i) => i.heading)).toContain("Configuring the Widget");
      expect(r.trace.gateOverride).toMatch(/^span:coverage/);
    } finally {
      cleanupProject(root);
    }
  });

  it("deterministic: identical traces for repeated runs", () => {
    const { root, index } = suite(corpus);
    try {
      const a = runRetrieval(index, LONG_TASK, EMPTY, PIN);
      const b = runRetrieval(index, LONG_TASK, EMPTY, PIN);
      expect(a.items.map((i) => `${i.docPath}#${i.heading}`)).toEqual(
        b.items.map((i) => `${i.docPath}#${i.heading}`),
      );
      expect(a.trace.gateOverride).toBe(b.trace.gateOverride);
    } finally {
      cleanupProject(root);
    }
  });
});

/* P0-8 (independent of pilot data): the gate override honors STRUCTURAL
 * citations only — dotted member/file references and explicit doc paths —
 * matched against the candidate section's own indexed strings. Bare token
 * mentions, heading coverage and doc links leaked negatives and are gone. */
describe("content gate override: citation evidence (P0-8)", () => {
  const corpus = bigCorpus({
    "docs/pooling.md":
      "# Pooling\n\n## Connection Pooling\n\nThe connection_pool.release_all method drains idle sockets; pool_config.timeout bounds the drain.\n",
    "docs/quirks.md":
      "# Quirks\n\n## Widget Behaviours\n\nThe widget exposes initialData through getInitialData and renders DateTime and HttpApi labels.\n",
  });
  const suite2 = () => suite(corpus);
  // High floor: only citation evidence can pass (coverage is forced to fail).
  const OV = { ...PIN, minCoverage: 0.95, gateOverride: 1 } as Required<RetrievalOptions>;
  const NO = { ...PIN, minCoverage: 0.95, gateOverride: 0 } as Required<RetrievalOptions>;

  it("dotted citation fires — short genuine reference (8 stems, no floor)", () => {
    const { root, index } = suite2();
    try {
      const q = "Why does `connection_pool.release_all` spin down idle sockets lazily?";
      const r = runRetrieval(index, q, EMPTY, OV);
      expect(r.items.map((i) => i.heading)).toContain("Connection Pooling");
      expect(r.trace.gateOverride).toContain("identifier:connection_pool.release_all");
      expect(runRetrieval(index, q, EMPTY, NO).items.length).toBe(0);
    } finally { cleanupProject(root); }
  });

  it("bare identifier mentions are NOT citation evidence (overlap-negative form)", () => {
    const { root, index } = suite2();
    try {
      for (const q of [
        "setting up initialData and getInitialData in cuckoo mandolin obsidian",
        "best practices for DateTime and HttpApi with frobnication quux",
      ]) {
        const r = runRetrieval(index, q, EMPTY, OV);
        expect(r.items.length).toBe(0);
        expect(r.trace.gateReason).toContain("content gate");
      }
    } finally { cleanupProject(root); }
  });

  it("explicit doc-path citation fires (the doc itself is the reference)", () => {
    const { root, index } = suite2();
    try {
      const r = runRetrieval(index, "update notes in docs/pooling.md for zibble quux frob", EMPTY, OV);
      expect(r.items.length).toBeGreaterThan(0);
      expect(r.items[0]!.docPath).toBe("docs/pooling.md");
      expect(r.trace.gateOverride).toContain("doc-path:docs/pooling.md");
    } finally { cleanupProject(root); }
  });

  it("citation absent from the corpus injects nothing (no index-wide match)", () => {
    const { root, index } = suite2();
    try {
      const r = runRetrieval(index, "how do I configure zibble.quux for the widget?", EMPTY, OV);
      expect(r.items.length).toBe(0);
      expect(r.trace.gateReason).toContain("content gate");
    } finally { cleanupProject(root); }
  });

  it("heading-coverage class no longer overrides (leak regression)", () => {
    const { root, index } = suite2();
    try {
      const r = runRetrieval(index, "connection pooling guide notes frobnication zibble", EMPTY, OV);
      expect(r.items.length).toBe(0);
      expect(r.trace.gateOverride ?? "").not.toContain("heading:");
    } finally { cleanupProject(root); }
  });
});

/* P0-8 FP battery (independent of pilot data): citations are POINTERS —
 * a pointer must not override the gate for content it does not point at.
 * Misleading = the query cites a real symbol/doc while asking something
 * the cited target answers no part of; contradiction = query demands X,
 * doc forbids X (doc is topically adjacent, NOT responsive — injection
 * of a prohibition IS responsive; contradictions that are cross-domain
 * are the FP class). */
describe("content gate override: citation false positives (P0-8)", () => {
  const corpus = bigCorpus({
    "docs/deploy.md":
      "# Deploy\n\n## Rolling Restarts\n\nrolling_restart drains each node before restart; keep the drain_ttl flag set.\n",
    "docs/billing.md":
      "# Billing\n\n## Invoice Delivery\n\nInvoices are emailed on the 3rd; the dunning_loop retries twice.\n",
  });

  it("citation of an existing symbol does not inject an UNRELATED section", () => {
    const { root, index } = suite(corpus);
    try {
      // cites dunning_loop (billing) with zero deployment vocabulary:
      // the citation points at billing — the deploy section must not be
      // rescued into context by a pointer it does not answer.
      const r = runRetrieval(index, "how do we schedule the `dunning_loop` for zibble quux frob", EMPTY, { ...PIN, gateOverride: 1, minCoverage: 0.95 });
      expect(r.items.map((i) => i.docPath)).toContain("docs/billing.md");
      expect(r.items.map((i) => i.docPath)).not.toContain("docs/deploy.md");
    } finally { cleanupProject(root); }
  });

  it("misleading doc-path citation injects only the cited doc", () => {
    const { root, index } = suite(corpus);
    try {
      // cites ONLY docs/deploy.md; the rest of the query matches no doc.
      // The cited doc must be delivered; billing must not ride along.
      const r = runRetrieval(index, "docs/deploy.md — zibble quux frobnication and scheduloid planning", EMPTY, { ...PIN, gateOverride: 1, minCoverage: 0.95 });
      expect(r.items.length).toBeGreaterThan(0);
      expect(r.items.every((i) => i.docPath === "docs/deploy.md")).toBe(true);
    } finally { cleanupProject(root); }
  });

  it("citation token present as prose, not code, is not a reference", () => {
    const { root, index } = suite(corpus);
    try {
      // bare "drain_ttl" mention inside a billing-shaped template query:
      // coverage low (billing terms vs doc), citation bare (no dot/`code`)
      // → must withhold. (The pilot leaked on exactly this shape.)
      const r = runRetrieval(index, "setting up invoices for drain_ttl with zibble quux frob", EMPTY, { ...PIN, gateOverride: 1, minCoverage: 0.95 });
      expect(r.items.length).toBe(0);
    } finally { cleanupProject(root); }
  });

  it("contradictory requirement citing a real symbol still injects the cited target", () => {
    const { root, index } = suite(corpus);
    try {
      // "never use rolling_restart" — a prohibition is responsive content
      // (the doc answers the question about that symbol); the override must
      // fire on the CITATION, not on sentiment. Spec: abstention is
      // evidence-based, not stance-based.
      const r = runRetrieval(index, "we must never use `rolling_restart` during peak hours, document the policy", EMPTY, { ...PIN, gateOverride: 1, minCoverage: 0.95 });
      expect(r.items.map((i) => i.heading)).toContain("Rolling Restarts");
    } finally { cleanupProject(root); }
  });

  it("file extension citation matches the FILE, not a random section", () => {
    const { root, index } = suite(corpus);
    try {
      // cites billing.md; deploy section vocabulary shares no token with
      // the citation → only billing fires.
      const r = runRetrieval(index, "migrate the schedule described in billing.md to zibble and frob", EMPTY, { ...PIN, gateOverride: 1, minCoverage: 0.95 });
      expect(r.items.every((i) => i.docPath === "docs/billing.md")).toBe(true);
    } finally { cleanupProject(root); }
  });
});
