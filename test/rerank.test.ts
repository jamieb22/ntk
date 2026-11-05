import { describe, it, expect } from "vitest";
import { applyRerank, encodePair, sigmoid, rerankAdmitted, defaultModelDir, lexicallyEvidenced } from "../src/core/rerank.js";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// Research module (model/README.md): encodePair needs vocab.txt; the live
// inference tests need both weights files. Pure policy tests always run.
const MODEL_DIR = path.join(__dirname, "../model");
const HAS_VOCAB = existsSync(path.join(MODEL_DIR, "vocab.txt"));
const HAS_WEIGHTS = HAS_VOCAB && existsSync(path.join(MODEL_DIR, "tinybert-l2-marco-int8.onnx"));

const V = new Map<string, number>();
if (HAS_VOCAB)
  readFileSync(path.join(MODEL_DIR, "vocab.txt"), "utf8").split("\n").forEach((l, i) => { const w = l.trim(); if (w) V.set(w, i); });

describe.skipIf(!HAS_VOCAB)("encodePair (official pair encoding)", () => {
  it("wraps [CLS] q [SEP] t [SEP] with segment ids 0/1", () => {
    const [ids, seg] = encodePair("What is Paris?", "The capital of France is Paris.", V);
    expect(ids[0]).toBe(101);
    expect(seg[0]).toBe(0);
    const sep1 = ids.indexOf(102);
    expect(sep1).toBeGreaterThan(2);
    expect(seg[sep1]).toBe(0);            // query segment ends at first [SEP]
    expect(seg[sep1 + 1]).toBe(1);        // passage segment
    expect(ids[ids.length - 1]).toBe(102);
    expect(ids.length).toBe(seg.length);
  });
  it("continuation pieces keep the ## marker (inhab##itants)", () => {
    const [ids] = encodePair("q", "inhabitants", V);
    expect(ids.length).toBeLessThan(10);
    expect(ids.filter((x) => x > 2).length).toBeGreaterThan(3);
  });
});

describe("applyRerank (H2 policy: demote, order, budget)", () => {
  const I = (d: string, s: string, t = 100) => ({ docPath: d, sectionPath: s, tokens: t });
  it("drops sections below the validated 0.05 threshold", () => {
    const items = [I("a.md", "A"), I("b.md", "B")];
    const { kept, dropped } = applyRerank(items, [0.9, 0.04]);
    expect(kept).toEqual([items[0]]);
    expect(dropped[0]).toContain("b.md");
  });
  it("orders survivors by model score, ties keep lexical order", () => {
    const items = [I("a.md", "A"), I("b.md", "B"), I("c.md", "C")];
    const { kept } = applyRerank(items, [0.6, 0.9, 0.6]);
    expect(kept.map((k) => k.docPath)).toEqual(["b.md", "a.md", "c.md"]);
  });
  it("re-applies maxItems and token budget AFTER reranking", () => {
    const items = [I("a.md", "A", 400), I("b.md", "B", 400), I("c.md", "C", 400)];
    const { kept, dropped } = applyRerank(items, [0.5, 0.9, 0.9], 0.05, 4, 800);
    expect(kept.map((k) => k.docPath)).toEqual(["b.md", "c.md"]);
    expect(dropped.some((d) => d.includes("budget"))).toBe(true);
  });
  it("empty score array keeps everything (no accidental wipe)", () => {
    const items = [I("a.md", "A")];
    expect(applyRerank(items, []).kept.length).toBe(1);
  });
});

describe("B1 demotion guard — applyRerank protectedFlags", () => {
  const I = (d: string, s: string, t = 100) => ({ docPath: d, sectionPath: s, tokens: t });
  it("exempts protected items from the demotion floor; unprotected lows still drop", () => {
    const items = [I("a.md", "A"), I("b.md", "B"), I("c.md", "C")];
    const { kept, dropped } = applyRerank(items, [0.9, 0.01, 0.02], 0.05, 4, 800, [false, true, false]);
    expect(kept.map((k) => k.docPath)).toEqual(["a.md", "b.md"]);
    expect(dropped.length).toBe(1);
    expect(dropped[0]).toContain("c.md");
  });
  it("protection never promotes: protected item ranks after model-preferred survivors", () => {
    const items = [I("a.md", "A"), I("b.md", "B"), I("c.md", "C")];
    // lexical order a,b,c; model: b strongest, a weak-but-above-floor, c demoted+protected
    const { kept } = applyRerank(items, [0.06, 0.9, 0.001], 0.05, 4, 800, [false, false, true]);
    expect(kept.map((k) => k.docPath)).toEqual(["b.md", "a.md", "c.md"]);
  });
  it("protected items stay subject to maxItems and the token budget", () => {
    const items = [I("a.md", "A", 400), I("b.md", "B", 400), I("c.md", "C", 400)];
    const { kept, dropped } = applyRerank(items, [0.9, 0.01, 0.001], 0.05, 1, 800, [false, true, true]);
    expect(kept.map((k) => k.docPath)).toEqual(["a.md"]);
    expect(dropped.some((d) => d.includes("budget"))).toBe(true);
  });
  it("undefined flags = exact pre-B1 behaviour", () => {
    const items = [I("a.md", "A"), I("b.md", "B")];
    expect(applyRerank(items, [0.9, 0.01]).kept.length).toBe(1);
  });
});

describe("B1 demotion guard — lexicallyEvidenced predicate", () => {
  // maxIdf(1000) = ln(1 + 1001/1.5) ≈ 6.50; frac ≥ 0.5 ⇒ idf ≥ 3.25.
  const idf: Record<string, number> = { vector: 4.2, ntk: 4.0, phase: 3.4, data: 2.0, use: 1.0, retrieval: 1.2, embed: 3.8 };
  const U = new Set(["vector", "data", "ntk", "retrieval"]);
  it("≥2 user terms with one rare (frac ≥ 0.5) → protected", () => {
    expect(lexicallyEvidenced(["vector", "embed", "data"], U, idf, 1000)).toBe(true);
  });
  it("a SINGLE rare user term is not enough (B0 strawman)", () => {
    expect(lexicallyEvidenced(["vector", "embed"], U, idf, 1000)).toBe(false); // embed = expansion, not user
    expect(lexicallyEvidenced(["vector"], U, idf, 1000)).toBe(false);
  });
  it("≥2 user terms that are all common (fracs < 0.5) → not protected", () => {
    expect(lexicallyEvidenced(["data", "retrieval"], U, idf, 1000)).toBe(false);
  });
  it("expansion/anchor terms outside the user-term set never count", () => {
    expect(lexicallyEvidenced(["embed", "warm", "extern"], U, idf, 1000)).toBe(false);
  });
  it("high-IDF match on a corpus with a huge maxIdf (frac < 0.5) → not protected", () => {
    // N = 24000 (k8s scale): maxIdf = ln(1+24001/1.5) ≈ 9.68; idf 4.2 → 0.43 < 0.5
    expect(lexicallyEvidenced(["vector", "data", "ntk"], U, idf, 24000)).toBe(false);
  });
  it("boundary frac exactly 0.5 passes (>= semantics)", () => {
    const N = 1000;
    const maxIdf = Math.log(1 + (N + 1) / 1.5);
    const idfB = { ...idf, edge: 0.5 * maxIdf, other: 1.0 };
    expect(lexicallyEvidenced(["edge", "other"], new Set(["edge", "other"]), idfB, N)).toBe(true);
  });
});

describe("rerankAdmitted driver — graceful degradation (no model, no ONNX)", () => {
  const base = {
    query: "How many people live in Berlin?",
    items: [{ docPath: "b.md", sectionPath: "Berlin", tokens: 100, docMtime: 1 }],
    textOf: () => "Berlin has a population of 3,520,031 registered inhabitants in an area of 891.82 square kilometers.",
    hash: (s: string) => s,
  };
  it("falls back to lexical items when the model is unavailable", async () => {
    const r = await rerankAdmitted({ ...base, modelDir: "/nonexistent-dir-ntk" });
    expect(r.items).toEqual(base.items);
    expect(r.trace.mode).toBe("fallback");
    expect(/model not found|ENOENT/.test(r.trace.reason ?? "")).toBe(true);
  });
});

describe.skipIf(!HAS_WEIGHTS)("rerankAdmitted driver (real INT8 model, 2 threads)", () => {
  const base = {
    query: "How many people live in Berlin?",
    items: [{ docPath: "b.md", sectionPath: "Berlin", tokens: 100, docMtime: 1 }],
    textOf: () => "Berlin has a population of 3,520,031 registered inhabitants in an area of 891.82 square kilometers.",
    hash: (s: string) => s,
  };
  it("scores a card-validated positive above the threshold", async () => {
    const dir = defaultModelDir();
    const r = await rerankAdmitted({ ...base, modelDir: dir });
    expect(r.trace.mode).toBe("applied");
    expect(r.items.length).toBe(1); // Berlin positive: P ≈ 0.999 ≫ 0.05
    const r2 = await rerankAdmitted({ ...base, modelDir: dir });
    expect(r2.trace.mode).toBe("cache"); // same query+doc+mtime → cached
  }, 30000);
  it("demotes an unrelated passage (adversarial shape)", async () => {
    const r = await rerankAdmitted({
      ...base,
      modelDir: defaultModelDir(),
      items: [{ docPath: "x.md", sectionPath: "Random", tokens: 100, docMtime: 2 }],
      textOf: () => "New York City is famous for the Metropolitan Museum of Art.",
    });
    expect(r.items.length, JSON.stringify(r.trace)).toBe(1); // all-demoted safety net
    expect(r.trace.reason).toContain("all-demoted");
  }, 30000);
  it("B1: protected item survives demotion, ranked after survivors; unprotected twin drops", async () => {
    const mk = (mt: string[], mtime: number) => ({
      query: "How many people live in Berlin?",
      modelDir: defaultModelDir(),
      hash: (s: string) => s,
      items: [
        { docPath: "b.md", sectionPath: "Berlin", tokens: 100, docMtime: mtime, matchedTerms: mt },
        { docPath: "x.md", sectionPath: "Random", tokens: 100, docMtime: mtime, matchedTerms: mt },
      ],
      textOf: (it: { docPath: string }) =>
        it.docPath === "b.md"
          ? "Berlin has a population of 3,520,031 registered inhabitants in an area of 891.82 square kilometers."
          : "New York City is famous for the Metropolitan Museum of Art.",
      isProtected: (it: { matchedTerms?: string[] }) =>
        lexicallyEvidenced(it.matchedTerms ?? [], new Set(["berlin", "population"]), { berlin: 5, population: 4 }, 1000),
    });
    const prot = await rerankAdmitted(mk(["berlin", "population"], 11));
    expect(prot.trace.mode).toBe("applied");
    expect(prot.trace.protectedCount).toBe(2);
    expect(prot.items.map((i) => i.docPath)).toEqual(["b.md", "x.md"]); // model order kept; x protected into the last slot
    const unprot = await rerankAdmitted({ ...mk(["berlin", "population"], 12), isProtected: () => false });
    expect(unprot.items.map((i) => i.docPath)).toEqual(["b.md"]); // single rare term (B0 strawman) unprotected → demoted
    expect(unprot.trace.dropped.join()).toContain("x.md");
  }, 30000);
});
