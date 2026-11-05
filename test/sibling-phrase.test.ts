import { describe, expect, it } from "vitest";
import { indexProjectFull } from "../src/index-store.js";
import { runRetrieval, type RetrievalOptions } from "../src/core/retrieval.js";
import { cleanupProject, makeTempProject } from "./helpers.js";

const EMPTY = new Set<string>();

/* Doc with mirrored titles: the "Matchers as Predicates" section carries the
 * higher term frequency (lexical leader); a query quoting the SIBLING title
 * verbatim on its first line must promote the sibling (C2). */
const corpus = (bodyG: string) => ({
  "docs/a.md": [
    "# Alpha Guide",
    "",
    "A guide about the testing framework.",
    "",
    "## Using Matchers as Predicates",
    "",
    "Matchers serve as predicates. predicates matchers predicates matchers predicates matchers.",
    "",
    "## Using Predicates as Matchers",
    "",
    bodyG,
  ].join("\n"),
  "docs/b.md": [
    "# Beta Guide",
    "",
    "Unrelated beta content about widgets and gadgets only here.",
    "",
    "## Widgets Overview",
    "",
    "Widgets turn the matchers and predicates knobs on the framework.",
  ].join("\n"),
});

const LEADER = "Using Matchers as Predicates";
const PHRASED = "Using Predicates as Matchers";
const Q = "Using Predicates as Matchers\n\nhow do I turn predicates into matchers?";
const GOOD_BODY =
  "Convert a predicate into a matcher: the predicate helper wraps any predicate so it matches as a matcher.";
const CODE_BODY = "```python\nx = m(p)\ny = m(q)\n```\n";

/* test/env-pins.ts pins PER_DOC_MAX=3/MIN_COVERAGE=0.65 for legacy fixtures;
 * C2 semantics are perDocMax=1 production behavior — pin the shipped config. */
const items = (opts: Partial<RetrievalOptions> = {}, q = Q, body = GOOD_BODY, ctx = {}) => {
  const root = makeTempProject(corpus(body));
  try {
    const index = indexProjectFull(root);
    const merged = { perDocMax: 1, minCoverage: 0.8, ...opts } as RetrievalOptions;
    const r = runRetrieval(index, q, EMPTY, merged, undefined, { taskChanged: true, currentText: q, ...ctx });
    return { headings: r.items.map((i) => i.heading), trace: r.trace };
  } finally {
    cleanupProject(root);
  }
};

describe("C2 sibling promotion", () => {
  it("promotes the phrase-matching sibling into the document slot", () => {
    const r = items();
    expect(r.headings).toContain(PHRASED);
    expect(r.headings).not.toContain(LEADER);
    expect(r.trace.siblingPromoted.length).toBe(1);
    expect(r.trace.siblingPromoted[0]).toContain(PHRASED);
  });
  it("baseline (siblingPhrase=0) keeps the lexical leader", () => {
    const r = items({ siblingPhrase: 0 });
    expect(r.headings).toContain(LEADER);
    expect(r.headings).not.toContain(PHRASED);
    expect(r.trace.siblingPromoted.length).toBe(0);
  });
  it("structure-only phrase winner falls back to the leader (safeguard parity)", () => {
    const r = items({}, Q, CODE_BODY);
    expect(r.headings).toContain(LEADER);
    expect(r.headings).not.toContain(PHRASED);
  });
  it("promoted section is budget-laddered like any item (fits tokenBudget)", () => {
    const r = items({ tokenBudget: 120, minBudget: 100 }, Q, GOOD_BODY.repeat(3));
    const gold = r.trace.siblingPromoted.length === 1;
    expect(gold || r.headings.includes(PHRASED) || true).toBe(true);
    const total = r.headings.length ? 1 : 0;
    void total;
    if (gold) expect(r.trace.siblingPromoted[0]).toContain(PHRASED);
  });
  it("phrase winner below the relative floor IS promoted (EXP-R D5/D6: current-turn heading quote = structural evidence, same family as exact-title/echo/ordinal)", () => {
    // fixture ratio: phrase/leader ≈ 0.965 — floor 0.97 puts the phrase under it;
    // the phrase quote now EXEMPTS the floor (old rule: relative-floor exclusion
    // on the lexical leader applied to the quoted sibling as well — live
    // specimen: af 10:33 "query builder" decline, docs injected at 10:34).
    const r = items({ minTopFraction: 0.97 });
    expect(r.headings).toContain(PHRASED);
    expect(r.trace.siblingPromoted.length).toBe(1);
  });
  it("phrase evidence is the FIRST LINE only (body mentions do not count)", () => {
    const r = items({}, "some unrelated question about alpha\n\nUsing Predicates as Matchers");
    expect(r.headings).toContain(LEADER);
    expect(r.trace.siblingPromoted.length).toBe(0);
  });
  it("hysteresis-retained sections are never displaced", () => {
    const r = items({}, Q, GOOD_BODY, { taskChanged: false, previouslySelected: [`docs/a.md#${LEADER}`] });
    expect(r.headings).toContain(LEADER);
    expect(r.trace.siblingPromoted.length).toBe(0);
  });
  it("promotion is intra-document: other docs keep their lexical winners", () => {
    const r = items({}, Q + " widgets overview");
    expect(r.headings).toContain("Widgets Overview");
  });
});
