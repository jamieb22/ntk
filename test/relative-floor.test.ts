/** Relative selection floor (dogfood 2026-11-01, "What is in phase 2").
 *
 *  Incident: the task anchor ("is ntk debug ok?") + PMI expansion blended a
 *  ubiquitous project-name term into the query; the global gates passed on
 *  the gold section (heading-ordinal rescue), and greedy per-doc fill then
 *  injected two bench READMEs at 2-3% of the top score — sections whose only
 *  match was the anchor term and an expansion term.
 *
 *  Guarantee under test: a NEW candidate claiming a slot must reach
 *  minTopFraction × the top candidate's score. Retentions (hysteresis),
 *  exact 《title》 references, and spreading-activation additions are exempt
 *  (user evidence / stability / seeded decay). 0 = off = the old behavior.
 */
import { describe, expect, it } from "vitest";
import { indexProjectFull } from "../src/index-store.js";
import { DEFAULTS, runRetrieval, type RetrievalOptions } from "../src/core/retrieval.js";
import { cleanupProject, makeTempProject, standardCorpus, type Corpus } from "./helpers.js";

const EMPTY = new Set<string>();
/** Production dial values: the test env pins (env-pins.ts) loosen perDocMax
 *  and minCoverage for topical fixtures; this leak only exists with the
 *  shipped dials — perDocMax 1 is what forces per-doc diversity onto slots
 *  3-4, and the incident ran under the 0.8 coverage floor. */
const PASSES: Required<RetrievalOptions> = { ...DEFAULTS, perDocMax: 1, minCoverage: 0.8 };

/** Corpus mirroring the incident's shape:
 *  - gold sections for a "phase 2" query (docs/spec.md, docs/design.md);
 *  - anchor-polluted noise: the project name "NTK" is high-DF/low-IDF,
 *    sprinkled through every filler doc (title + body) so it carries almost
 *    no signal; two bench docs whose sections match ONLY anchor + expansion
 *    terms (title-field repetition + one body mention), landing at 2-7% of
 *    the top score;
 *  - 20 filler docs so IDF statistics approach the dogfood corpus (a
 *    ubiquitous term must not be discriminative). */
function incidentCorpus(): Corpus {
  const vocab = [
    "grommet", "spanner", "caltrops", "dovetail", "escarpment", "filigree", "gantlet", "heliotrope", "ictiocentric", "jasperite",
    "keratoplasty", "labyrinthodon", "mesoglea", "noctilucence", "ophicleide", "pantography", "quincunxial", "raticide", "sclerosome", "tintinnabulation",
  ];
  const filler = (v: string) =>
    `# ${v[0]!.toUpperCase()}${v.slice(1)} Notes\n\nThe ${v} module coordinates ${v} scheduling across ${v} workers; ${v} failures retry the ${v} queue. NTK indexes these notes.\n\n## ${v[0]!.toUpperCase()}${v.slice(1)} Config\n\nSet ${v}.level to tune ${v} batching; the ${v} daemon reads ${v}.ttl for ${v} expiry.\n`;

  const corpus: Corpus = {
    "docs/spec.md": `# NeedToKnow\n\n## 11. Implementation Phases\n\n### Phase 1 — Core Context Retrieval\n\nPhase 1 ships core context retrieval: indexing, gates, budgets, injection.\n\n### Phase 2 — Task and Code Awareness\n\nPhase 2 implements task and code awareness: source-file activity tracking, spreading activation, two-speed task memory, stable-selection hysteresis, incremental reindexing, revision invalidation, and the mechanism diagnostics that expose them.\n\n### Phase 3 — Adaptive Working Memory\n\nPhase 3 adds adaptive working memory: eviction, consolidation, and budget learning.\n`,
    "docs/design.md": `# NeedToKnow Design Document\n\n## 8. Phasing\n\nPhase 1 is the retrieval core. Phase 2 layers task and code awareness mechanisms over it: every phase-2 mechanism ships with a phase owner, a phase gate, a phase checklist, and a warm activation path for the phase transition. The phase 2 design makes each phase observable, testable, and cheap; the phases gate each phase release. Phase 3 adapts on top of phase 2.\n`,
    // The leak pair: top-of-doc sections whose only query signal is the
    // anchor term in the title field (+ the body mention) and the expansion
    // term — the incident's `matched: [ntk, mechan]` / `[ntk]`.
    "harness/README.md": `# NTK-harness corpus and split tuning (dev-only)\n\nThis harness is the tuning bench for the NTK project. It builds NTK corpora, NTK splits, and NTK gold labels, and it runs NTK sweeps over the NTK grid so that NTK defaults are NTK-baked. The NTK pipeline mines sections, scores candidates, and reports NTK metrics per split.\n\nThe harness exists so that NTK tuning stays reproducible: every NTK number in the NTK report is produced by the same NTK code path on a frozen NTK snapshot of the NTK corpus. NTK splits are leakage-aware; NTK dev and NTK holdout never share NTK documents. The NTK grid search evaluates NTK ablations against NTK baselines, and NTK review gates NTK releases. See the NTK design doc for the NTK mechanism behind NTK retrieval quality.\n\nRun NTK sweeps with the NTK runner; the NTK output lands in NTK/out. NTK fixtures, NTK cases, and NTK labels are all dev-only; none of this NTK tooling ships to end users.\n`,
    "harness/adv/README.md": `# NTK adversarial benchmark\n\n## Reading the report\n\nThe tokens field is injection size; baselines use raw sizes. Read the report table.\n`,
  };
  for (const v of vocab) corpus[`docs/f-${v}.md`] = filler(v);
  return corpus;
}

/** The incident call: anchor + current turn blend, currentText tail,
 *  .ntk/* activity files (source of the "debug" term). */
function incidentRun(opts: Partial<RetrievalOptions>) {
  const root = makeTempProject(incidentCorpus());
  try {
    return runRetrieval(indexProjectFull(root), "is ntk debug ok?\nWhat is in phase 2", EMPTY, { ...PASSES, ...opts }, undefined, {
      currentText: "What is in phase 2",
      activityFiles: [".ntk/debug.jsonl", ".ntk/status.md"],
    });
  } finally {
    cleanupProject(root);
  }
}

describe("relative selection floor (dogfood: phase-2 bench leak)", () => {
  it("reproduces the leak with the floor off: anchor-matched bench docs fill slots 3-4", () => {
    const r = incidentRun({ minTopFraction: 0 });
    expect(r.trace.passedGate).toBe(true);
    expect(r.trace.gateOverride).toContain("heading-ordinal");
    // Gold present (the gates earned the injection)...
    expect(r.items.some((i) => i.docPath === "docs/spec.md" && i.heading.includes("Phase 2"))).toBe(true);
    expect(r.items.some((i) => i.docPath === "docs/design.md" && i.heading.includes("Phasing"))).toBe(true);
    // ...and greedy per-doc fill injects the anchor-only matches at the tail
    // of the distribution (the dogfood incident).
    expect(r.items.some((i) => i.docPath.startsWith("harness/"))).toBe(true);
    const top = Math.max(...r.items.map((i) => i.score));
    const leak = r.items.filter((i) => i.docPath.startsWith("harness/"));
    expect(leak.length).toBeGreaterThan(0);
    expect(leak[0]!.score / top).toBeLessThan(0.15); // tail, not peer
  });

  it("the floor rejects the anchor-only tail while keeping gold sections and the gate", () => {
    const r = incidentRun({});
    expect(r.trace.passedGate).toBe(true);
    expect(r.trace.gateOverride).toContain("heading-ordinal"); // gate unchanged
    expect(r.items.some((i) => i.docPath === "docs/spec.md" && i.heading.includes("Phase 2"))).toBe(true);
    expect(r.items.some((i) => i.docPath === "docs/design.md" && i.heading.includes("Phasing"))).toBe(true);
    expect(r.items.some((i) => i.docPath.startsWith("harness/adv"))).toBe(false);
    // Rejection is auditable per candidate, with the reason bucket.
    expect(r.trace.excludedRelative.some((id) => id.startsWith("harness/adv/README.md"))).toBe(true);
  });

  it("a stronger floor clears the whole bench tail", () => {
    const r = incidentRun({ minTopFraction: 0.15 });
    expect(r.items.every((i) => !i.docPath.startsWith("harness/"))).toBe(true);
    expect(r.items.length).toBeGreaterThanOrEqual(2); // gold pair intact
  });

  it("invariant: every newly selected item reaches the fraction of top (off-exemptions)", () => {
    for (const frac of [0.05, 0.1]) {
      const r = incidentRun({ minTopFraction: frac });
      const top = Math.max(...r.items.map((i) => i.score));
      for (const it of r.items) {
        // new selections (not retained this call — fixtures pass none)
        expect(it.score / top, `${it.docPath}#${it.heading} @${frac}`).toBeGreaterThanOrEqual(frac - 1e-9);
      }
    }
  });

  it("injected tokens: the floor frees budget for the top sections (no cap-bump side effect)", () => {
    const off = incidentRun({ minTopFraction: 0 });
    const on = incidentRun({});
    // The leak consumed slots; the floor must not shrink the gold pair.
    expect(on.items.length).toBeLessThan(off.items.length);
    expect(on.items.length).toBeGreaterThanOrEqual(2);
    // NTK-015 source count follows floor-clearing docs, not every positive hit.
    expect(on.trace.allocatedSources).toBeLessThan(off.trace.allocatedSources);
  });
});

describe("relative floor exemptions (recall guards)", () => {
  it("spreading activation keeps linked docs below the bare-match floor", () => {
    // phase2 fixture, one hop: the linked section scores seed × SPREAD_DECAY
    // (0.35), far above a 0.05 floor and far below any BM25 peer check.
    const root = makeTempProject({
      "docs/alpha.md":
        "# Alpha\n\n## Deploy alpha\n\nThe alpha deploy pipeline runs the deployment with cluster config. See the [beta runbook](beta.md).\n",
      "docs/beta.md":
        "# Beta\n\n## Zeta protocol\n\nZeta protocol steps for the beta service: run zeta ctl start, check zeta logs, verify zeta status.\n",
      "docs/other.md": "# Other\n\n## Misc\n\nNothing relevant here at all, just filler prose about zeppelins and docks.\n",
    });
    try {
      const r = runRetrieval(indexProjectFull(root), "deploy alpha", EMPTY, PASSES);
      expect(r.trace.spreadAdded).toBeGreaterThan(0);
      expect(r.items.some((i) => i.docPath === "docs/beta.md")).toBe(true);
    } finally {
      cleanupProject(root);
    }
  });

  it("hysteresis retention survives the floor (stability beats freshness)", () => {
    const root = makeTempProject(standardCorpus());
    try {
      const index = indexProjectFull(root);
      const strict = { ...PASSES, threshold: 1.8 };
      // onboarding scores ~1.1: above the retention floor (1.08), deep below
      // any relative floor (top ~40+ → 0.05×top = 2+).
      const off = runRetrieval(index, "How do I deploy the service?", EMPTY, strict);
      expect(off.items.some((i) => i.docPath === "docs/onboarding.md")).toBe(false);
      const kept = runRetrieval(index, "How do I deploy the service?", EMPTY, strict, undefined, {
        previouslySelected: ["docs/onboarding.md#Onboarding"],
      });
      expect(kept.items.some((i) => i.docPath === "docs/onboarding.md")).toBe(true);
      expect(kept.trace.retained).toContain("docs/onboarding.md#Onboarding");
    } finally {
      cleanupProject(root);
    }
  });

  it("exact 《title》 references bypass the floor (user-named evidence)", () => {
    const root = makeTempProject(incidentCorpus());
    try {
      const r = runRetrieval(indexProjectFull(root), "《NTK-harness》", EMPTY, PASSES);
      expect(r.items.some((i) => i.docPath === "harness/README.md")).toBe(true);
    } finally {
      cleanupProject(root);
    }
  });

  it("compound multi-source queries keep every genuinely matched doc", () => {
    // Each clause matches a different doc on REAL query terms (not an anchor
    // residue): all top sections share the same score order of magnitude, so
    // the floor must not cut them (spec P0-7 "PART of the task" at selection).
    const root = makeTempProject(standardCorpus());
    try {
      const r = runRetrieval(indexProjectFull(root), "rolling deploys to the cluster, LRU cache eviction, and the endpoint json api rate limits", EMPTY, PASSES, undefined, {
        currentText: "rolling deploys to the cluster, LRU cache eviction, and the endpoint json api rate limits",
      });
      const docs = new Set(r.items.map((i) => i.docPath));
      expect(docs.has("docs/deployment.md")).toBe(true);
      expect(docs.has("docs/architecture.md")).toBe(true);
      expect(docs.has("docs/api.md")).toBe(true);
      expect(r.items.length).toBeGreaterThanOrEqual(3);
    } finally {
      cleanupProject(root);
    }
  });
});
