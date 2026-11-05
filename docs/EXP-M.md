# EXP-M — Lightweight local semantic retrieval (offline diagnostic)

**Verdict: REJECT for shipping — recorded as a DISCOVERY SUCCESS and an
END-TO-END FAILURE** (the split §7 explicitly anticipates). Under the
pre-registered gates (frozen at commit `930b0dc`-descendant, protocol
committed before model runs): the discovery gates **pass for both models**
— the first positive semantic-retrieval result in this program — and the
injection gates **fail** (I1 FAIL +2.6pp < +5pp; I3 severe 1 > 0). No
production change, no merge; the seam is worktree-only, default-off
(EXP-G precedent); suite 204/2 (2 pre-existing reds), tsc clean,
`git diff main -- src` shows only the inert seam on this branch.

## 1. Baseline verification (§2)

- MiniSearch classic BM25 (k1.2/b.75/d0, boosts 4/3/2/1), PMI expansion,
  gates (scoreGate 3 / A5 / coverage 0.8 / spans ≥3), C2 on, selection
  (0.5, relFloor 5%, MMR .75, perDocMax 1, ladder, budget 800),
  compression — code-verified; H2 TinyBERT (`model/tinybert-l2-marco-int8.
onnx`) + B1 confirmed bench-only (zero plugin imports; EXP-G §1 + EXP-H
  audit re-verified).
- **EXP-K discovery reproduction at this worktree**: first-loss B 683
  (raw100 587 exact, pool 96 — 2 sections of 8-hour corpus drift), C 57,
  D 33, delivered 16; replayOk 65/65.
- Frozen data: EXP-K lock 62f9eb90e3f0 (65 turns, 789 golds, cap-400
  full-corpus labels); population = the 34 FAIL discovery-miss turns
  (prevMissing>0, dev population — §5 respected: validation required for
  any SHIP claim). Corpora embedded: 3,666 production-indexed sections
  (6 roots, root-scoped search, 2000-char production view, G convention);
  81 verbatim queries.

## 2. Models (§3) — revisions verified at download

| model | rev | license | inference | dim |
|---|---|---|---|---|
| `minishlab/potion-retrieval-32M` (A) | 6fc8051fab2a1e0ee76689cf08c853792ac285e7 | Apache-2.0 | Model2Vec **static** encode (intended method; no transformer) | 512 |
| `ibm-granite/granite-embedding-small-english-r2` (B) | 2ab6fa8ea2d674564defd37171ae19079b864b33 | Apache-2.0 | EXP-G chain: torch→ONNX (opset **13** — G's opset-17 artifact predates onnxruntime-node's Split/LayerNormalization constraints encountered here; quantized dynamic int8 per-channel, fp32 acts, G recipe) | 384 |
| Production BM25 (C) | — | — | MiniSearch (control) | — |

CPU-only, offline at query time, no new external services, no generative
calls. (G's BGE-small kept as reference: G goldHit@20 ≤0.527, net-new +5/116.)

## 3. Discovery — semantic-only (the 34 genuine misses, §4)

| measure (frozen: gold = EXP-K label ≥2, unjudged never irrelevant) | potion | granite |
|---|---|---|
| **M1** FAIL turns w/ ≥1 gold at ≤20 (gate ≥6) | **15/34 ✅** | **11/34 ✅** |
| gold sections at ≤20 / R@5 / R@10 / R@20 / R@50 / R@100 (34-pop) | 34 / — | 22 / — |
| **M2** newly-discovered gold sections ≤100 (gate ≥15) | **94 ✅** | **84 ✅** |
| REP cohort golds recovered ≤20 | +3 | 0 |
| NEG cohort (9 turns, root-scoped, no gate) | 0 relevant found | 0 |

This is the experiment's central finding: **EXP-G's REJECT generalized from
a population with essentially no vocabulary-mismatch cases (low-overlap
n=1).** On EXP-K's genuine mismatch population, a 139 MB static-embedding
model with a 0.3 s full-corpus encode recovers golds into the top-20 on
15/34 of previously-unsolvable requests (~0.44 golds/turn, ~20× EXP-G's
measured yield), and granite (transformer) on 11/34. potion ≥ granite
everywhere — the static model is the cost-effective point on this curve.

## 4. Hybrid fusion (RRF k=60, frozen; §6)

**M3 fails decisively for both:** RRF displaces 35–36 of A's top-20 gold
placements (gate ≤1) and lands only 2–3 of the 34 golds at ≤20 —
the semantic list's head out-votes BM25's precise tail on a corpus where
BM25 scores span 9,000→0. Appended-only (EXP-L's structural bug) is dead
at top-20; naive equal-voice RRF is dead on displacement. Fusion is
**unsolved by this run** (a score-calibrated fusion was not pre-registered
and post-hoc tuning on golds is forbidden — reported as the open
engineering gap, not pursued).

## 5. Pipeline with the seam (M5, §7 — injection gates: FAIL, reported per §7)

Seam: semantic top-20 into the ranked pool at 0.4×topScore (pre-registered
expansion precedent); `matched` = the section's real lexical intersection
with user terms (semantic proximity contributes **zero** coverage —
measured as designed); gates/C2/perDocMax/budget/compression untouched.

| metric (gate) | potion | granite |
|---|---|---|
| I1 FAIL turns w/ useful evidence Δ (≥ +5pp) | **+2.6pp (5→6) ✗** | 0pp ✗ |
| I2 NEG false-injection (≤ +2pp) | 0/9 ✅ | 0/9 ✅ |
| I3 severe regressions (=0) | **1 ✗** (budget/cap pressure: +12 items displace 1 REP gold-turn; 1 item content-loss) | 1 ✗ (REP −1) |
| I4 useful tok/1k (≥0.9×A) | 141→152 ✅ | 141→133 ✗ |
| S-new delivered items, content ≥2 / ≤1 / unjudged (blinded deepseek, 129 items) | **6 / 26 / 4** | 0 / 17 / 7 |
| abstention | 27→30 fires | 27→27 |

Why the collapse from 15/34 to +2.6pp: (a) the 34 population is
**by construction mostly gate-abstaining** (EXP-K class G) — semantic
candidates enter pools whose turn-level coverage verdict is unchanged
(semantic matches add no coverage by design) → most recoveries die at the
existing abstention (the §7 end-to-end-failure class, reported separately
as instructed — no gate relaxation performed); (b) on fired turns,
perDocMax 1 + cap (2–5 adaptive) + budget 800 admit ~0.2 net semantic
items/turn, and 0.4×topScore placement outranks BM25's tail → the one
severe regression. Discovery is real; the delivery architecture as frozen
absorbs almost none of it.

## 6. Named probes (§4, synthetic queries — marked as probes)

Mismatched-form probes: DoD ("when is it considered complete?"): BM25 5 /
potion 6 / granite 377. httpx proxy ("requests ignore my system proxy
settings…"): BM25 1 / potion 6 / granite 19. BM25 (with the Nov-1 ordinal
fix) wins where lexical anchors exist; potion is in the conversation;
granite's CLS collapses on the numbered-heading DoD case.

## 7. Overhead (§9, M6)

| measure (target) | potion | granite |
|---|---|---|
| model on disk (≤150 MB) | 139.1 MB (repo 268 MB) ✅ | 49.1 MB int8 ✅ |
| embedding index (3,666 sec) | 7.5 MB | 5.6 MB |
| index build, 3,666 texts | 0.3 s | ~60 s (16.5 ms/text, batch-32) ✅ |
| cold init | 0.2 s | 100–141 ms ✅ |
| query: embed + cosine (p50/p95) | 0.2 ms + 1.25/1.39 ms ✅ | 1.2 ms + 0.95/1.12 ms ✅ |
| total added p95 (≤ +30 ms) | **~1.6 ms** ✅ | **~2.3 ms** ✅ |
| added resident | +25 MB ✅ | +47 MB (peak 554 MB during encode; steady ~250 MB) ✅ |
| incremental reindex (10 secs) | ~2 ms | ~165 ms |
| new deps / runtime network / GPU / LLM | 0 / 0 / 0 / 0 ✅ | 0 / 0 / 0 / 0 |

All resource targets pass — comfortably for potion (static lookup, no
transformer). The binding constraint is not overhead; it is fusion +
admission integration.

## 8. Judging & consent (§10)

deepseek/deepseek-v4.1-flash-1017 T=0, raws cached (`eval/exp-m/raws/`,
26 responses + probe cache), consent line in every prompt; arms blinded
(content + context only); 89 new candidate labels (84% L0 / 5.6% L≥2 at
sem top-20 — the precision cost of pure semantic retrieval on these
queries), 129 delivered-item labels; no self-judging; human-review sheet
for disputed golds = EXP-K's (unchanged).

## 9. Uncertainty & limitations

- 34-dev population inspected in EXP-K/L/L2 → M1 on it is confirmatory
  (pre-registered), **not** validation; the validation cohort is
  unharvestable today (2 new sessions = this program's own meta-sessions).
  Any future SHIP claim requires ≥8 fresh cases per the frozen M7 rule.
- M1 counts require a gold inside the cap-400 judged set (archiva3 ~27%
  corpus coverage) — recovery counts are **lower bounds**.
- 0.4×topScore, RRF k=60, top-20 injection, single-sequence 512-cap
  (557 granite truncations) all frozen before evaluation; calibrated
  fusion (e.g., rank-normalized score blending, top-5 injection, semantic
  coverage-aided admission) is the open engineering question this
  experiment deliberately does not tune on golds.
- potion's prompt/representation is static (no contextual weighting);
  granite's int8 opset-13 graph exported here (not G's opset-17 artifact) —
  quantization parity not re-drift-checked this run (G measured ≤0.0018
  for this recipe).

## 10. Verdict & answer

**REJECT (ship), on the pre-registered injection gates** — while
establishing, for the first time in this program, that **small local
semantic retrieval genuinely recovers BM25-invisible documentation on
real vocabulary-mismatch requests** (15/34 at top-20, +94 golds at ≤100,
~2 ms p95, 139 MB, 0.3 s index). The end-to-end failure is an
**integration** failure (abstention-bound population + fixed slots +
naive fusion), not an evidence failure. Per §7/§11 directives: no semantic
admission path is implemented, no gate tuning initiated, no fusion
parameter swept. Stop; report. The natural successor (NOT started): a
fusion-and-delivery design study (calibrated hybrid + admission-eligible
semantic injection) with the same gates plus fresh validation cases.

## Reproduction

`bench/m/prep.mts` → `run-m.sh` (Granite export/quantize/embed;
potion_embed.py) → `eval.mts` (34-pop arms, judged sets) →
`judge-queue.mts` → `pipeline.mts` (seam, §7) → `judge-items.mts` →
`probes`/`overhead`. API used only for cached judging. Artifacts:
`eval/exp-m/{sem-eval.json,labels.new.json,labels.items.json,pipeline-{potion,granite}.json,probe-embed-potion.json,overhead stats inline}`.
