# EXP-L2 — Correct synonym query integration (targeted correction of EXP-L)

**Verdict: REJECT** — with a material correction to EXP-L's record. The
central question has a split answer, and both halves are quantified below:

1. **EXP-L's headline 0/34 at top-20 was fusion-structural, not coverage.**
   Under append-only fusion (original top-100 first, synonyms appended,
   list truncated at 100), no synonym hit can occupy ranks ≤35+ and top-20
   was **unreachable on all 38 FAIL turns** (min pool size 35, 31/38 at
   cap; turns with base<20: 0). EXP-L §4/§8 claims of the form "expansion
   fired and retrieved nothing in top-100" are **retracted for the
   14 coverage-present turns** — they were never scored inside the cap.
   The EXP-L §8 coverage probe (needed vocabulary absent 20/34, 59%)
   is fusion-independent and stands.
2. **Fair fusion lifts recovery from a structural 0 to a real 3–4 of 34
   at top-20** (best arm E/RRF, 4 golds; exact lookup) and **28/34 golds
   into top-100** — so the append implementation did suppress what the
   dictionaries *do* contain. **But no arm reaches the pre-registered
   ≥6-turn recovery gate, and every arm that surfaces deeper golds fails
   the pre-registered safety gates** (displacement, top-20 noise).
   REJECT: correctly merged synonyms still fail to recover meaningful
   evidence *in-situ* at acceptable drift; the binding constraint is the
   dictionaries' sense inventory (7/34 phrase-standalone ≤20, FF1b),
   not the join.

Production untouched (src diff 0); experimental code on branch `exp-l2`,
**not merged**, per directive. Protocol frozen at 486bdae before evaluation;
the §1 structural/syntax findings are code/data facts, not outcome-tuned.

## 1. §1 investigation (as requested)

- Code read: `bench/l/expand-eval.mts` merges `base(=raw top-100)` then
  appends expansion hits, `slice(0,100)` — verified above; EXP-L §4's lone
  "golds100=1" is exactly the one below-cap turn.
- Controls reproduced: exact-key and stem-key dictionaries rebuilt from the
  frozen sources (6.49 MB, same stats); arm B reproduces EXP-L (0/34 ≤20,
  3 golds ≤100 in exact mode incl. the original 1@100 case).
- MiniSearch 7.2.0 semantics probe-verified (protocol §2): string queries
  combineWith OR/AND/AND_NOT; structured nested AND-of-OR supported;
  per-term `boostTerm` (string path) and per-group `boostTerm` work and
  are the mechanism used (production's expansion weighting precedent,
  weight 0.4); **no positional phrase support** — multiword synonyms enter
  as token sets; the task's `(A∨A′)∧(B∨B′)` form is expressible and was
  measured over-restrictive in probes, so C/D use the single combined
  Boolean-OR expression per the task's own "do not blindly require every
  group" caveat.

## 2. Implementation (exact, per §2 of task)

One expanded MiniSearch query: distinct terms = original stems ∪ synonym
tokens, `combineWith: 'OR'`, `boostTerm(t) = 1` for original terms and
`{1, 0.4}` for synonyms in arms C/D. Original terms retain normal BM25
contribution; multiword phrases contribute their tokens (engine limit,
recorded); code identifiers/paths/versions/package names/numbers/URLs are
filtered from the key side before lookup (identical EXP-L filters), so
exact technical terms are never synonymized. No string-concatenation
without verification: string mode's single-operator semantics and the
structured API's group behavior were probed first (§1.2). All arms K=100,
identical bm25 d:0, identical field boosts.

## 3. Four-arm comparison (frozen EXP-K/EXP-L data; × {SO, WN, both} × {exact, stem})

34 FAIL oracle-eligible turns — gold sections at rank ≤20 / ≤50 / ≤100
(turns with ≥1 gold ≤20 / gold count):

| arm | stem/both ≤20 | ≤50 | ≤100 | confirmed noise ≤20 | displaced A-golds (out of ≤20) |
|---|---|---|---|---|---|
| A production BM25 | 0 | 0 | 0 | 0 | 0 |
| B EXP-L append (control) | 0 | 0 | 0 | 0 | 0 |
| C combined OR, equal weight | 0 (1 exact) | 1 (5) | 5 (12) | 30 (34) | 3 (2) |
| D combined OR, synonyms 0.4 | 0 | 0 (2) | 7 (11) | 28 (29) | 5 (2) |
| E separate + RRF k=60 | 3 (4 exact) | 22 (25) | 28 (34) | **57 (74)** | **18 (21)** |

(FAIL numbers on the 34 population; parentheses = exact lookup. Per-source
split, stem: E r20 — SO 1, WN 1, both 2 golds; C/D all 0.)

Representative (18) and negative (9) cohorts, confirmed label ≤1 items in
top-20 (stem/both): B 5 / C 12 / D 14 / **E 37** on REP; 4/4/4/4 on NEG
(SO tag forms fire on conversational turns). DISPLACEMENT: E pushes 25
gold sections (A-delivered set incl. REP) out of top-20 — it degrades the
very sections production ranks correctly today.

**Standalone synonym-query recall (coverage vs fusion separator,
frozen-policy phrases, stem/both): 7 of 34 turns have their gold at ≤20 in
the phrase's own query** (ranks: 1,2,2,3,5,7,26,27,29,96…), and only those
7 turns carry any fusion path to top-20: C/D land 0, E lands 2 of the 7
(the auth→authentication and component-part cases, Ranks 3 and 5 stand-
alone → RRF 20; equal/weighted combined BM25 buries them under
multi-original-term matches). Phrase-level: of 14 dictionary-present turns
(EXP-L §11), 7 retrieve their gold ≤20 standalone; 7 do not (the near-miss
sense problem).

## 4. Gate outcomes (pre-registered)

- FF1 (≥6/34 recovered ≤20, any C/D/E): **best 4 (E, exact) → fail
  (marginal band 4–5 → per frozen rules FF1 alone maps to the
  INCONCLUSIVE path)**.
- FF1b (≥4/14 phrase-standalone ≤20): **7/34 — passes** (dictionary has
  real coverage pockets; the failure is not purely source-absence).
- FF2 (≤1 A-gold displaced out of ≤20): C 3, D 5, **E 18 → fail**.
- FF3 (REP new confirmed noise ≤3, NEG ≤2, FAIL noise:useful ≤2.5:1):
  C 12, D 14, **E 37 REP → fail** (FAIL E ratio 57:3 = 19:1 → fail).
- §5 pipeline: **not run** (FF1 gate unmet). I1–I4 unmeasured; the
  E-arm displacement profile (25/15 A-delivered golds broken) predicts
  severe>0, and the gate exists precisely to avoid spending judging on
  arms that destroy A's delivered set.

## 5. §6 per-case diagnosis (the 34; full table `eval/exp-l2/percase.md`)

- 20/34 — **no dictionary vocabulary** (needed oracle term unmapped;
  EXP-L §11 probe).
- 7/34 — **coverage + standalone retrieval**: phrase query ranks gold ≤20;
  C/D bury it (in-query additive BM25: synonym-only docs score under the
  100 original-term matches — this is the fusion penalty the task
  suspected, and it is real: 7 → 0 in-quest); E recovers 2/7.
- 7/34 — dictionary present, **phrase retrieved, gold outside standalone
  ≤20** (wrong sense lands elsewhere: "bind"/"wired" for "attach",
  "air/adjudicate" for a license-check task, "chang jiang" for "change"):
  the expansion fires, retrieval returns, ranking finds the wrong
  sections — sense failure, not fusion.
- 0/34 — downstream (gate/selection/compression): never reached (pipeline
  gate unmet; EXP-K showed these stages are not the bottleneck).

## 6. §7 performance and correctness

- One combined query (C/D) vs 3 standalone (E/B): single fused
  ms.search call vs 3; median per-turn arm-time (A–E group incl.
  dictionary lookup, archiva3-scale): **~1–3 ms with the combined query**,
  RRF ≈ 3 separate searches. The combined query is the *cheaper*
  integration — and the *weaker* outcome (0/34 ≤20). Fusion cost is not
  the constraint; fusion benefit for recovery is (equal-weight helps
  recovery: C ≥ D; weighting synonyms down at 0.4 measurably suppresses
  recovery vs C and adds displacement: D displ 5 vs C 3).
- Equal caps verified (K=100 all arms; standalone 100). Scores comparable
  within arms; RRF uses ranks only.
- Unit tests: **9/9 green** (`bench/l2/fusion.test.ts`): original-only
  invariance, multiword tokens present, stem join (`reducing`→`reduce`),
  identifier/URL/version non-expansion, senses≤3 tier, zero-expansion
  no-ops (B/E ≡ A), append prefix + dedup, weighting monotonicity,
  docs-reachable-only-via-synonyms.

## 7. Limitations

- DEV population (EXP-K set) is inspected data → per the frozen validation
  rule, SHIP CANDIDATE was structurally unavailable this run; validation
  harvest (≥8 fresh cases) was skipped because the DEV gates (FF2/FF3)
  failed. No shipping claim is made.
- SO arm: newest 2,500 of ≈10k+ synonyms (anonymous API cap); key-side
  structure (tag forms) caps prose matching in the full table too.
- MiniSearch has no phrase operator: multiword synonyms act as token
  groups; true phrase-AND grouping was measured (probe: AND-of-OR
  over-restrictive) and the task's caveat was followed.
- E's ≤100 depth (28/34) is the most interesting *research* signal in this
  experiment — it says: the dictionary-reachable golds do rise to
  candidate-pool depth under rank-fusion; they do not reach top-20, and
  the pool they rise into carries 19:1 top-20 noise. An admission/pipeline
  study of RRF pools is beyond this task's scope and not authorized.

## 8. Answer to the central question

**Both, in sequence.** The append-only implementation made the *top-20
measurement* structurally zero — EXP-L's headline number overstated the
mechanism's in-situ failure on the 14 coverage-present turns and is
corrected here. With fusion fixed: combined-in-query BM25 recovers ≈0–1
(additive scoring suppresses synonym-only matches), RRF recovers 3–4/34
at ≤20 and 28/34 at ≤100 — still below the pre-registered ≥6 bar, at
18–21 gold displacements and 37 REP top-20 noise items. The dictionaries
lack the right vocabulary for 20/34 (structural, EXP-L), retrieval-
disproportionate sense for 7/34, and the surviving 7/34 pockets die under
in-query ranking and are out-voted by noise under rank-fusion. The
REJECT stands on fair grounds. No production, threshold, dictionary, or
fusion change results; per directive, EXP-L2 is final — no further
retrieval experiment is started.

Reproduction (no external APIs; frozen artifacts): `bench/l2/build-dict.mts`
(→ dict.exact.json) → `bench/l2/fuse-eval.mts` (~3 min) →
`node_modules/.bin/vitest run -c bench/l2/vitest.config.ts` (9 tests).
Artifacts: `eval/exp-l2/{fuse.json,judge-queue.json,percase.md}`.

## 9. Integration audit addendum (post-record; user challenge)

Verified synonyms participate in scoring: unit tests place a docs-only-via-
synonym at top rank on production-shaped pre-stemmed fields; live arms C/D
diverge from A (30 confirmed-≤1 into FAIL top-20, 3 A-golds displaced,
5–12 golds ≤100); RRF merges 28–34/34 to ≤100. Integration is real.

Weakness found: `standaloneSearch` used OR over phrase tokens (engine has no
phrase operator) — FF1b audited with AND over content tokens: `component
part` 5→>100, `chang jiang` 1–2→>100 ×2 (WordNet proper-noun junk sense the
POS filter did not catch); valid pockets = **4** (ranks 2,2,3,7: bind,
computer architecture AND-intact, job, authentication, explore). FF1b
7→4/34 (gate ≥4, passes at the edge). All four pockets are single-token (or
AND-intact) — the class flat-OR integrates exactly; their in-situ C/D/E
ranks (0,0,0; 0,0,2; 0,0,0; 0,0,0) are unaffected by the AND fix. FF1
(≤4<6), FF2 (E 18–21), FF3 (E REP 37) stand. Verdict unchanged: REJECT.
