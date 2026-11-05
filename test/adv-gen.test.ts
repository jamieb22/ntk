/** Generator self-tests (task §11): label correctness, split isolation,
 *  reproducibility, metric math — on a synthetic fixture with planted
 *  confusables, doc↔code citations and a git-free environment. */
import { describe, expect, it } from "vitest";
import { indexProjectFull } from "../src/index-store.js";
import { cleanupProject, makeTempProject, type Corpus } from "./helpers.js";
import { buildInventory } from "../bench/adv/inventory.js";
import { buildConfusionGraph } from "../bench/adv/graph.js";
import { generateCases } from "../bench/adv/generate.js";
import { scoreCases, type Sel } from "../bench/adv/metrics.js";
import type { AdvCase } from "../bench/adv/labels.js";

const SHARED =
  "The retry request failure policy must be described consistently: every request may fail, and the retry policy governs how the request is repeated after a failure. " +
  "Attempts are logged, the policy applies to every request, repeated failures trip the circuit, and the retry counter resets after success. " +
  "Operators read these rules before changing timeouts, and the gateway enforces the policy on every request path. ";

const fixture: Corpus = {
  "docs/payments.md":
    "# Payments\n\n" +
    "## Retries\n\n" +
    SHARED +
    "Charges must never be duplicated. The charge ledger records each settlement uniquely, so a repeated payment attempt reuses the stored charge record and the duplicate charge is prevented.\n",
  "docs/network.md":
    "# Network\n\n" +
    "## Retry Policy\n\n" +
    SHARED +
    "Transport backoff doubles the interval between connection attempts. The socket layer exposes connection metrics, and the connection pool bounds concurrent transports per host.\n",
  "docs/architecture.md":
    "# Architecture\n\n" +
    "## Overview\n\n" +
    SHARED +
    "The processPayments pipeline composes network and ledger layers; the settlement ledger lives behind the charge module boundary.\n\n" +
    "## Data Flow\n\n" +
    "Requests flow through the gateway; `processPayments` dispatches charges to the settlement ledger, and the gateway records transport metrics for each attempt.\n",
  "src/payments.ts": "export function processPayments() { return null; }\nexport const settlementLedger = 1;\n",
  "src/network.ts": "export function createTransport() { return null; }\nexport const connectionPool = 2;\n",
  "src/app.ts": "export function main() { return 0; }\n",
};

function suite() {
  const root = makeTempProject(fixture);
  const index = indexProjectFull(root, { force: true });
  const inv = buildInventory(index, root);
  const graph = buildConfusionGraph(index, inv);
  return { root, index, inv, graph };
}
describe("adversarial generator (fixture)", () => {
  it("is reproducible from the fixed seed", () => {
    const { root, index, inv, graph } = suite();
    try {
      const a = generateCases(index, inv, graph, { perCategory: 4 });
      const b = generateCases(index, inv, graph, { perCategory: 4 });
      expect(JSON.stringify(a.cases)).toBe(JSON.stringify(b.cases));
      expect(a.cases.length).toBeGreaterThan(0);
    } finally {
      cleanupProject(root);
    }
  });

  it("builds a confusion graph linking the planted confusables", () => {
    const { root, inv, graph } = suite();
    try {
      const pay = inv.sections.find((s) => s.heading === "Retries")!;
      expect(pay).toBeDefined();
      expect(graph.edges.has(pay.id)).toBe(true); // payments#Retries has neighbours
      const edge = graph.edges.get(pay.id)![0]!;
      expect(edge.sharedTerms).toContain("retri"); // shared vocabulary recorded (stemmed)
      expect(edge.to).toContain("docs/"); // lexical similarity ≠ semantic equality: labels validated separately
    } finally {
      cleanupProject(root);
    }
  });

  it("labels are establishable: unique terms separate gold from distractors (P2 §4)", () => {
    const { root, index, inv, graph } = suite();
    try {
      const g = generateCases(index, inv, graph, { perCategory: 4 });
      const positives = g.cases.filter((c) => c.gold.length > 0 && c.distractors.length > 0);
      expect(positives.length).toBeGreaterThan(0);
      for (const c of positives) {
        expect(c.uniqueTerms.length).toBeGreaterThan(0);
        const goldSec = inv.byId.get(c.gold[0]!);
        expect(goldSec).toBeDefined();
        const goldTerms = new Set([...goldSec!.fields.body, ...goldSec!.fields.headings]);
        for (const t of c.uniqueTerms) expect(goldTerms.has(t)).toBe(true);
        for (const dId of c.distractors) {
          const d = inv.byId.get(dId);
          if (!d) continue;
          const dTerms = new Set([...d.fields.body, ...d.fields.headings]);
          for (const t of c.uniqueTerms) expect(dTerms.has(t)).toBe(false);
        }
      }
      // D negatives: absent topics really absent
      for (const c of g.cases.filter((x) => x.category === "D")) {
        const absent = c.evidence.filter((e) => e.startsWith("absent:")).map((e) => e.slice(7));
        expect(absent.length).toBeGreaterThanOrEqual(2);
        const df = (t: string) => inv.sections.filter((s) => s.fields.body.includes(t) || s.terms.map((x) => x.toLowerCase()).includes(t)).length;
        for (const t of absent) expect(df(t)).toBe(0);
      }
    } finally {
      cleanupProject(root);
    }
  });

  it("split isolation: confusable sections never straddle dev/holdout (§5)", () => {
    const { root, index, inv, graph } = suite();
    try {
      const g = generateCases(index, inv, graph, { perCategory: 4 });
      const splitOf = new Map<string, string>();
      for (const c of g.cases) for (const id of c.gold) splitOf.set(id, c.split);
      for (const c of g.cases) {
        for (const id of c.distractors) {
          const s = splitOf.get(id);
          if (s !== undefined) expect(s).toBe(c.split); // connected → same side
        }
      }
      expect(g.cases.some((c) => c.split === "holdout")).toBe(true);
    } finally {
      cleanupProject(root);
    }
  });
});

describe("adversarial metrics math (P2 §6)", () => {
  const mk = (over: Partial<AdvCase>): AdvCase =>
    ({
      id: "x", category: "A", repo: "r", commit: "c", query: "q",
      gold: ["doc.md::1"], optional: [], distractors: ["doc.md::2"],
      sourceScope: [], evidence: [], uniqueTerms: ["t"], split: "dev", generator: "g",
      ...over,
    }) as AdvCase;

  it("scores perfect, partial, distractor and abstain selections", () => {
    const cases = [
      mk({ id: "p1" }),
      mk({ id: "p2", gold: ["doc.md::1", "doc.md::3"], category: "C" as const }), // 2/2 mandatory
      mk({ id: "d1", category: "D" as const, gold: [] }),
      mk({ id: "e1", category: "E" as const, gold: [], ambiguous: true, acceptedSet: ["doc.md::1", "doc.md::2"], distractors: [] }),
    ];
    const sel = (ids: string[]): Sel => ({ ids, tokens: 100, latencyMs: 1 });
    const sels = new Map<string, Sel>([
      ["p1", sel(["doc.md::1"])],
      ["p2", sel(["doc.md::1", "doc.md::9"])], // partial: 1 of 2
      ["d1", sel([])], // correct abstention
      ["e1", sel(["doc.md::2"])], // inside accepted set
    ]);
    const m = scoreCases(cases, sels, 10);
    expect(m.goldRecall).toBeCloseTo((1 + 0.5) / 2, 3);
    expect(m.mandatoryCoverage).toBeCloseTo(1 / 2, 3); // only p1 fully covered
    expect(m.abstainHard).toBe(1);
    expect(m.ambiguityOk).toBe(1);
    expect(m.distractorRate).toBeCloseTo(0, 3); // p1/p2 injected no distractors
    expect(m.precision).toBeCloseTo(3 / 4, 3); // p1:1, p2:1, others none
  });

  it("punishes inject-everything selections via precision and distractorRate", () => {
    const cases = [mk({ id: "p1" })];
    const m = scoreCases(cases, new Map([["p1", sel2(["doc.md::2", "doc.md::4", "doc.md::5"])] as Sel]), 10);
    expect(m.goldRecall).toBe(0);
    expect(m.distractorRate).toBeCloseTo(1 / 3, 3);
    expect(m.precision).toBe(0);
  });
  const sel2 = (ids: string[]) => ({ ids, tokens: 300, latencyMs: 1 });
});
