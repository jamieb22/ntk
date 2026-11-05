# EXP-K — Retrieval discovery vs admission trade-off (diagnostic)

**Verdict: DISCOVERY-LIMITED (mixed).** 86.8% of all relevant-section losses
occur before the admission gates ever see them (absent from raw BM25 top-100,
or absent from the production candidate pool). Gate relaxation is measurable
but not cost-effective: the best arm gains +15.8pp useful-evidence turns on
the failure cohort (McNemar exact p = 0.031, zero severe regressions) at a
1 : 3.1 useful:harm ratio on confirmed injections (1 : 9.5 including
unjudged) — failing the pre-registered ≥ 3 : 1 harm-bounded criterion by an
order of magnitude. **No gate change ships.** The protocol below was frozen
and committed (0d97ce0) before any Stage-2+ result existed.

Diagnostic per the task directive: EXP-G/EXP-H found limited gate-failure
evidence on their populations; EXP-K confirms this on a deliberately
failure-enriched population and locates the dominant loss upstream, at
vocabulary discovery (Stage 6 oracle: 82% of fully-missed golds are
recoverable with ≤10-word doc-terminology queries — i.e. the gap is real
lexical mismatch, which admission thresholds cannot bridge).

---

## 1. Protocol and dataset provenance (Stage 1)

Protocol as pre-registered (committed 0d97ce0; arms table in §4, decision
criteria in §5 of that commit). Dataset facts:

- Source: `~/.local/share/opencode/opencode.db` (read-only), v2 tables
  (`session_v2`/`session_message`) merged with legacy tables, sessions
  created before 2026-11-03T00:00+13:00, top-level sessions only, 1–3 user
  turns each, queries verbatim (redacted with the GR-BENCH pattern set;
  audit: 157 items scanned, 0 leaks).
- Contamination control: all 54 GR-BENCH session ids excluded (deterministic;
  e.g. the 7 murmur sessions in GR-BENCH are excluded, its 2 survivors are
  eligible). GR-BENCH sealed holdout untouched. No synthetic rewrites
  anywhere.
- Selection is fully deterministic (seed 20261103, mulberry32; ≤2 turns per
  session, no project >40% of a cohort) and frozen:
  `eval/exp-k/frozen.json` sha256 `62f9eb90e3f0…`.
- Cohorts (units merge by case: turns from a session already taken by FAIL
  join that case, so emitted counts are lower than pool quotas):
  **K-FAIL** 28 cases / 38 turns — enriched on production *pipeline signals
  only* (gate abstention with ≥3 candidates; fired-with-weak-coverage);
  **K-REP** 15 cases / 18 turns — uniform sample of eligible doc-bearing
  turns (7 quota turns merged, 25→18);
  **K-NEG** 18 cases / 25 turns — projects with <10 indexed sections plus
  short conversational turns.
- Query-type mix (K-FAIL, deepseek classifier, descriptive): procedural 10,
  concept 9, terse 9, identifier 7, paraphrase 2, other 1 — the requested
  coverage classes are present.
- Gold labels: **full-corpus judging** — every section of the project's
  production-scoped index (doc round-robin, cap 400 sections/turn —
  archiva3's 1,496 sections are 27% covered; gold counts are therefore
  lower bounds), judged by `deepseek/deepseek-v4.1-flash-1017` via
  OpenRouter, T=0, GR-BENCH 0–3 rubric, raw responses cached
  (`eval/exp-k/raws/`, 2,629 files), content-hash resume cache. No
  self-judging (not NTK's serving model). Consent: user judge-policy directive
  2026-11-02 + this task. 65 turns fully labeled, 789 gold sections
  (label ≥2).
- Cross-model audit (Claude Sonnet 4.6, 319 batches, n=2,516): exact
  agreement 78.5%, within-1 **97.8%**; gold-boundary (≥2) flips 6.1% —
  the principal label-noise source (§8).
- Human verification: `eval/exp-k/gold-review.md` (81 rows: every DISPUTED
  gap ≥2 and every label-3 gold on a FAIL turn) prepared for the user's
  spot-check; not consumed by any metric below.
- Genuine negatives: 25 K-NEG turns (9 with fully-judged small corpora, 12
  from projects with an empty doc corpus, 4 short-chat turns in doc-bearing
  projects at protocol label 0, recorded) + 3 positive-cohort turns whose
  **entire judged corpus** contains no label ≥2 section = 28.

## 2. Production baseline verification

Arm A is the untouched shipped pipeline: bare `runRetrieval` with `DEFAULTS`
(H2+B1+C2, ladder, budget 800, perDocMax 1, C2 on, expansion on), executed
by the frozen `src/` at 2845bb4 in worktree `.scratch/exp-k` (branch exp-k;
zero production diff — `src/` untouched, verified). Gate-replay used by the
arm-D counterfactual was validated against the production trace on all 65
labeled turns: **replayOk 65/65**. K-FAIL firing rate 15/38 = 39.5% (by
construction gate-enriched; K-REP 11/18 = 61%; deployment reference ≈ 28%
from GR-BENCH — the enriched cohort is not a real-world estimate).

## 3. Stage-by-stage failure taxonomy (Stage 2/5)

Per gold section (label ≥2), first stage of loss; K=100 raw BM25 = user
stem terms, no expansion, no boosts (MiniSearch classic BM25 as shipped):

| first loss | FAIL (636 golds) | REP (150 golds) | pooled (789) |
|---|---|---|---|
| B: not in raw BM25 top-100 | 476 (74.8%) | 109 (72.7%) | **587 (74.4%)** |
| B: raw-discovered, not in production pool (searchLimit 60, boosts, RC1 net) | 82 (12.9%) | 16 (10.7%) | 98 (12.4%) |
| C: in pool, content-gate rejected (turn-level) | 52 (8.2%) | 3 (2.0%) | 56 (7.1%) |
| D: admitted, selection-dropped (score < threshold 0.5 tail) | 19 (3.0%) | 14 (9.3%) | 33 (4.2%) |
| E: delivered under A (content grading in §7) | 7 (1.1%) | 8 (5.3%) | 15 (1.9%) |

Raw-pool discovery grades (FAIL): in top-10 32/636, top-20 48, top-50 101,
top-100 160. **Indexing failures (A): 0** — every gold exists in the parsed
index (scanner root-scope was not the bottleneck). The gold-miss population
is not a gate artifact: the majority of relevant sections are never
retrieved as candidates, so no gate decision can affect them.
Not-in-raw-top-10 at K=10/20/50 is flat across (604/588/535/476): the misses
score under every sensible depth — BM25 vocabulary, not truncation depth.

## 4. Exact gate counterfactuals (Stage 3)

Frozen inputs per turn: identical query terms, expansion, BM25 pool (the
arms re-run the identical deterministic search — gates sit after ranking),
ranking/boosts, C2, threshold, relFloor 5%, MMR, perDocMax, ladder,
compression, budget, root scoping, native exclusions, negation net, A5
anti-vacuity floor. Only the named admission leg changes:

| arm | change | mechanism |
|---|---|---|
| A | production | DEFAULTS |
| B | coverage threshold only | minCoverage 0.8 → 0.5 |
| C | minimum matched-span terms only | minSegTerms 3 → 2 |
| D | section-span requirement only | single-candidate span → union over boosted top-3 (0.8 kept, replayed; A5 preserved) |
| E | content gates off (upper bound) | coverage/rarest/span disabled; scoreGate, A5, rescues, exclusions kept |

Arm C finding (mechanism, not noise): in production code `minSegTerms < 3`
**disables the span-evidence path entirely** (anti-vacuity guard, retrieval.ts
`if (o.minSegTerms >= 3)`) — the intended relaxation (2-term spans count) is
not expressible through that knob; measured effect is a tightening (REP fires
10 vs A 11, one severe regression). The "minimum matched terms" leg as
implemented has only the A5 ≥2-content-term floor, which B/E/D all keep and
which produced zero gold losses attributable to it (no FAIL turn is
A5-rejected with gold in the pool).
Arm D finding: zero newly-eligible turns — no gate-rejected turn had a
≥3-term span whose terms were covered only as a union over the top-3
candidates. The single-candidate-span requirement is not where the losses
are; coverage magnitude is (FAIL gate-rejections cluster at coverage 0.55–0.75,
just under the 0.8 floor — see per-case table, `eval/exp-k/report-tables.md`).

## 5. Precision–recall and abstention trade-off (Stage 4)

Paired per case-turn (artifacts: `arm-results.json`, `arm-pairs.json`; full
table in `report-tables.md`):

| cohort | arm | fired (abstention) | turns w/ useful evidence (label ≥2 gold delivered) | gold sections delivered | +useful items | +harm items (confirmed) | severe | inj tokens | useful-token share |
|---|---|---|---|---|---|---|---|---|---|
| FAIL 38 | A | 15 (60.5%) | 4 (10.5%) | 7/636 | — | — | — | 10,130 | 11% |
| FAIL | B | 37 (2.6%) | 10 (26.3%) **+15.8pp** | 15 | +8 | +25 | 0 | 25,513 | 9% |
| FAIL | C | 14 (63.2%) | 4 (10.5%) | 7 | 0 | 0 | 0 | 9,383 | 11% |
| FAIL | D | 15 | 4 | 7 | 0 | 0 | 0 | 10,130 (=A) | 11% |
| FAIL | E | 38 (0%) | 10 (26.3%) | 15 | +8 | +26 | 0 | 25,916 | 9% |
| REP 18 | A | 11 (38.9%) | 6 (33.3%) | 8/150 | — | — | — | — | 20% |
| REP | B | 15 | 7 (38.9%) +5.6pp | 9 | +1 | +4 (11 unjudged) | 0 | +40% | 15% |
| REP | C | 10 | 5 (27.8%) | 7 | 0 | 0 | **1** | −6% | 17% |
| REP | E | 16 | 7 | 9 | +1 | +4 (15 unjudged) | 0 | +49% | 14% |
| NEG 25 | A | 0 (false-inj 0.0%) | — | — | — | — | — | 0 | — |
| NEG | B | 1 (4.0%) | — | — | — | +1 | — | — | — |
| NEG | C | 0 | — | — | — | — | — | — | — |
| NEG | D | 0 | — | — | — | — | — | — | — |
| NEG | E | 7 (**28.0%**) | — | — | — | +15 | — | — | — |

Latency: A median 2 ms (p95 74) → B/E median 12–13 ms (p95 ~135) — the cost
of firing on ~2.4× the turns, not of the gate arithmetic.

**Primary trade-off (per additional useful injection, how many irrelevant?):**
- FAIL/B: 8 useful : 25 confirmed-harmful (Poisson 95% CI on useful ≈ [3.7, 14.9]
  at the observed harm → ratio between 1:1.7 and 1:6.8) → **1 : 3.1**;
  counting the 51 harm items outside the judged corpus cap as harmful
  (upper bound): 1 : 9.5.
- FAIL/E: 8 : 26 confirmed → 1 : 3.3.
- REP is descriptively identical (1 : 4) and under the pre-registered n ≥ 25
  sign-test gate (n = 18 after case-merge): +1/−0 pairs, exact p = 0.5.
- On the 28 genuine negatives: A 0 injections, B +4pp (NEG 1/25) and 3/3 on
  zero-gold turns (12 items), E +28pp and 3/3.

Pre-registered gates vs results: FAIL/B passes recovery-effectiveness
(+15.8pp ≥ +10pp; McNemar b+ = 6, b− = 0, exact p = 0.031), passes NEG
false-injection (4.0% ≤ +5pp), passes severe (0 ≤ 1) — and **fails**
harm-bounded (needs ≥ 3 useful : 1 harmful; measured 0.32). E fails two
gates (NEG 28%; 1:3.3). Nothing is recovery-effective *at acceptable cost*.

## 6. Per-case gains and losses

The 8 gold sections B/E newly deliver (all also reached by E, FAIL cohort):
DATABASE_REFACTORING_PLAN#Database Layer Refactoring (L2, 182 tok),
UI_UX_DESIGN_GUIDE (L3, 387), ADR-058 kotlin/ktor (L2, 38),
CODE_PATTERNS>Import P (L2, 276), .clinerules/coding.md (L3, 204),
UI_REVIEW_CHECKLIST (L3, 116), ARCHITECTURE>Signal-First (L2, 67),
CODE_PATTERNS>Moderniz (L3, 55) — 6 of 8 on 3 turns; 6 of 8 are label 2
(SUPPORTING), 2 label 3.
Every B/E firing turn that gained also gained on average 3–10 co-injected
label ≤1 items (turn 1bb92698#1: 0 useful, 4 harms incl. a 226-tok
Solr-research section that shares only the word "search"). Zero gold
delivered under A is lost under B/E (severe 0 — the gate is a pure
loosening, so this is structural).
Deltas by cohort: FAIL useful-turns 4→10 all on gate-rejection class C
turns; REP 6→7 (single, n.s.).

## 7. Negative controls and evidence delivered to the agent

- Negative controls: K-NEG A = 0/25 (gate abstention intact on near-docless
  projects); B = 1/25; E = 7/25. Zero-gold positive-cohort turns (3):
  A 0, B/E 3/3. C/D = A. The production content gate is doing real
  abstention work; E shows what removing it costs (28% false-fire).
- Delivered-evidence grading (exact injected text, 195 items across arms,
  A-arm shown, 89 of 101 items judged): content label 0: 34, 1: 31, 2: 19,
  3: 5 → **73% of A-arm injections carry no task value as delivered**
  (FAIL 42/55 = 76%, REP 23/34 = 68%; enriched cohorts — see §8).
  Section→delivered downgrades: content label < section label on 11/37
  A-arm items — the section→excerpt law reappears, but as a *minority*
  channel next to discovery.

## 8. Statistical uncertainty and limitations

- n: FAIL 38 turns (≥ pre-registered 25 — confirmatory); REP 18 (descriptive
  only, sign test pre-registered n ≥ 25 unmet due to case-merge).
- Label noise: single primary judge (deepseek-flash class, calibration FAIL
  on record for grading bands); cross-model audit n = 2,516 within-1 97.8%,
  gold-boundary flips 6.1%. A 6.1% flip rate on ~789 golds is ±~1.5 golds per
  turn-level statistic — it cannot flip the 87% vs 7% taxonomy, but it is
  compatible with the +8-gold recovery being a handful of noise units;
  the harm side (25 confirmed + 51 unjudged) is robust.
- Corpus cap 400/turn (archiva3 27% coverage): gold inventories are lower
  bounds; unjudged arm injections counted pessimistically-as-harmful in
  tables (label null) and reported separately (confirmed vs unjudged).
- Cohort enrichment deliberately over-samples gate-suspicious turns; the
  unbiased view is K-REP/GR-BENCH (abstention 70.7%, goldHit@2 0.794) — no
  pooled real-world accuracy claim is made.
- Projects are the deployment reality: history outside GR-BENCH is
  concentrated in archiva3 / archiva_frontend (+spaceinvaders/TizenBrew
  doc-poor negatives); murmur/natshell/lucide sessions were GR-BENCH-internal
  or over-length-excluded. Diversity of *projects* is 5 roots (3 substantive).
- Arm D's "top-3" uses the boosted production ranking (trace.prodTop);
  RC1 exclusion and the expansion-pollution fallback are mirrored in the
  replay (validated 65/65).
- The oracle annotator is a single subagent with gold text in view — a
  deliberate upper bound, not an autonomous-NTK claim (protocol §6).

## 9. Stage 6 — oracle query-expansion diagnostic (trigger met: 34 ≥ 8 turns)

34 K-FAIL turns whose top gold is in no raw-BM25 top-100 slot; independent
annotator (fresh subagent, gold section text + redacted task in view, no
pipeline access) wrote one ≤10-word task-faithful query per turn using the
document's own terminology. Re-running raw BM25:
**28/34 (82.4%) recovered into top-10** (6 remain, incl. 2 label-2 weak
golds); ranks land 1–11, mostly ≤7. Reading: the discovery misses are a
true vocabulary gap — a doc-terminology query finds the section; the user's
words do not. Admission relaxation cannot bridge it (the sections are not
in the pool the gate evaluates). This is the same conclusion EXP-D reached
from the corpus side (0.02 translation pairs/section) and EXP-G from the
model side (net-new useful 0.118/turn vs 0.5 gate) — EXP-K closes the loop
from the failure side: the misses are real, numerous (74.4% of golds), and
lexical-bridgeable only with semantics, which the current constraint set
(zero-config, one model) excludes.

## 10. Decision (Stage 7, criteria pre-registered in §5 of the frozen protocol)

- **DISCOVERY-LIMITED — primary.** First-loss at B = 86.8% of gold sections
  (FAIL 87.7%, REP 83.3%), ≥ 60% threshold; raw@100 misses flat in K ⇒
  not a depth/truncation artifact; indexing failures 0.
- **Admission: NOT the limiter.** C = 7.1% of losses (FAIL 8.2%). Single-leg
  relaxation B is recovery-effective (+15.8pp, p = 0.031, severe 0, NEG +4pp)
  at 1 : 3.1 confirmed useful:harm (fails ≥ 3 : 1 by ~10×). E (upper bound,
  all content gates off) buys nothing beyond B and pushes NEG false-injection
  to 28%. The gate subpopulation is small, its recovery cheap relative to
  its noise, exactly as EXP-A/G/H predicted.
- **Downstream (selection/compression): minor channels.** D losses 4.2%
  (score-floor tail), E-delivered 1.9%; section→excerpt downgrades affect
  30% of A-arm items — real, second-order, and already owned by EXP-F/J.
- Verdict is a mixed report; the dominant term is DISCOVERY-LIMITED.
  Sample sizes supported the pre-registered FAIL test; REP is inconclusive
  by design-gate (n < 25), consistent in direction.

## 11. Recommended next action

1. **Ship nothing.** No threshold change qualifies under the pre-registered
   harm gate; production gates (minCoverage 0.8, A5, single-span rule,
   scoreGate) stand as-is. EXP-A's "FP fires at high rarest" and EXP-G/H's
   limited-gate-failure findings are corroborated on a failure-enriched
   population.
2. Do not re-open admission calibration on this axis; with 74% of losses
   upstream of the gate, further θ search has a bounded ceiling (~8% of
   losses at ≤1:3 cost).
3. The discovery gap is vocabulary, quantified with an 82% recoverability
   ceiling (oracle). Within the program's constraint set (zero-config,
   one model, no new inference), the remaining honest lever for this class
   is none — EXP-G (semantic discovery) is the mechanism class this data
   points to, and it is closed at yield 0.118/turn. Re-opening it would
   require the user to lift the semantic-model constraint and re-price the
   envelope.
4. Deliver the human verification sheet (`eval/exp-k/gold-review.md`,
   81 rows) — disputed/high-impact golds; the 6.1% boundary-flip audit rate
   is the main label risk in this report.
5. Stop here: no threshold tuning, no follow-on retrieval experiment is
   auto-authorized by this diagnostic.

## 12. Reproduction

Worktree `.scratch/exp-k` (branch `exp-k` @ 2845bb4, `src/` untouched).
Run order: `bench/k/mine.mts` → `judge-corpus.mts` → `trace.mts` →
`arms.mts` → `judge-items.mts` → `arms.mts` (refill clabels) →
`judge-corpus.mts --audit` → `oracle.mts --emit` (annotator) →
`oracle.mts` → `gen-review.mts` → `report.mts`.
Artifacts: `eval/exp-k/{frozen.json,units.jsonl,labels.json,trace-a.jsonl,
arm-results.json,arm-pairs.json,labels.items.json,labels.audit.json,
oracle-report.md,gold-review.md,report-tables.md}`, caches
`judge-cache*.json`, `raws/` (content-hash, regenerable).
Wall-time: mining+trace ~4 min; corpus judging 19.4 min (2,247 batches);
audit 1.6 min (319); items ~0.5 min; arms 40 s. API cost: deepseek-flash
~23k section-labels + 195 item-labels + 38 class labels; sonnet audit 2.5k
labels (all T=0, cached, raws retained).
