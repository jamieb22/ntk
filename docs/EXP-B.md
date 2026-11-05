# EXP-B — Corpus-statistical verbose-query salience (REJECTED)

Status: **REJECT** all three mechanisms (S1/S2/S3). Code stays merged as default-OFF
experimental options (`NTK_TERM_SALIENCE`, `NTK_SALIENCE_SUBSET`, `NTK_GATE_SALIENCE`) —
production H2+B1+C2 byte-identical (84 unit tests, FROZEN-271, adv control all reproduce).
Two permanent gains kept: (1) gate-rejected runs now record pre-gate `trace.candidates`
+ `trace.scored` (observability fix — the nlab eval had silently misattributed gated
runs as `not_retrieved` because `trace.scored` never existed); (2) the miss-class
taxonomy below.

## 1. Literature (mechanism → assumption → evidence → applicability)
- **Croft & Harper 1979**, "On the use of standard distributions in term weighting" (JASIS 30:346) —
  importance I(t)=log2(N/df)+log2(p/0.4)+log2((N−n)/n·0.6/0.4); assumes collection stats predict
  relevance-conditional behaviour. NTK fit: corpus IDF is the dominant, locally available term;
  we used the IDF component only (no external "standard distribution" — none transferable).
- **Bendersky & Croft 2008**, "Discovering Key Concepts in Verbose Queries" (SIGIR) — subset-
  distribution model: key concepts = terms whose subsets retain score, estimated from corpus
  statistics. +4–8% NDCG on TREC-8; assumes web-scale corpus for co-occurrence stability.
  NTK fit: approximated by top-IDF subsets in small (200–10k section) corpora — the assumption
  we tested; small-corpus noise is a stated limitation (Xue et al. below).
- **Xue, Huston & Croft 2010**, "Improving Verbose Queries using Subset Distribution" (CIKM) +
  **Huston & Croft 2010** (SIGIR) "Evaluating verbose query processing techniques" — gains
  concentrate on queries ≥10–15 terms; **BM25's built-in IDF already captures most of the
  effect for scoring** — extra query-side weighting adds little. NTK fit: NTK *is* BM25 —
  predicts small gains, matching our GR-BENCH result.
- **Tao & Wu 2006**, "On Reducing Query Length" (CIKM) — head-3 + weighted tail reduction beats
  random/positional reduction on TREC long titles; reduction applied to the SCORED query.
- **Abney 2004**, "Corpus-based term weighting for IR" (CIKM) — importance = drop-term score
  delta from corpus co-occurrence; the unifying theory: weighting > pruning (keeps evidence,
  re-scales it). Motivated S1 as weighting, not removal.
- **Lioma et al. 2015** (JASIST 66:2215), "Term importance weighting revisited" — many importance
  measures correlate weakly with true drop-term importance; importance is context-dependent
  (posterior). Explains why IDF-only salience misfires on GR-BENCH's domain-diverse turns.

## 2. NTK failures targeted
Verbose natural-language turns (median 83, max 897 chars; NLAB verbatim issues): golds
absent from the candidate pool (`not_retrieved`), and the coverage gate's whole-query
denominator false-abstaining on template tails (probe: k8s-57675, qt=32, coverage 0.72).

## 3. Mechanisms (one per change; S3 gate, S1 scoring, S2 discovery)
- **S1** per-term BM25 weight `clamp(idf/maxIdf, .25, 1)` via MiniSearch `boostTerm` (weighting,
  keeps all evidence — Abney's argument).
- **S2** complementary top-6-IDF subset search, unioned into candidates, scale-aligned (Xue/
  Bendersky key-concept subset, IDF proxy).
- **S3** gate coverage over salient subset (top-50% IDF, floor 3, cap 8) for >8-term queries;
  all legs/floors kept.

## 4. Hypothesis
"Flood dilution" (rejected): generic template terms dominate BM25 discovery and gate coverage
for verbose queries, burying rare-identifier golds; salience re-weighting recovers them at
neutral precision cost.

## 5. Miss forensics (the mechanism story)
*(Captured mid-recovery; where this section says "abstain→fire" for k8s-57675, the
control that fired on the restored tree is the NTK-018/headSpan layer — see §6a.)*
- GR-BENCH pool-bias: all 19 gold turns fired, zero golds outside top-14 (by construction).
  Candidate-stage misses are only measurable on pool-independent labels (NLAB-4) — done.
- S1 flips k8s-57675 (32-term query) abstain→fire with the gold as TOP candidate: coverage
  rises *because* hits now match on rare terms (matched-terms set shifts to rare, raising the
  gate's `covered ∩ pos` numerator). 1/5 NLAB golds recovered.
- S2 recovers subset-matching golds into the candidate pool — the 0.72 coverage gate still
  rejects the case (visible only after the trace fix).
- 4719 fails on the absolute `minScore` floor on a sparse corpus — an Experiment-A
  (QPP/calibration) problem, not a salience one.

## 6a. Restored-tree re-verification (the wipe incident, this session)
Mid-Experiment-B, the production layer (C2, relative floor, ordinal selectors, NTK-018,
paste isolation, NTK-011 log) was found destroyed by the 2026-11-02 wipe — it had never
been committed (git log -S: prose only). Restored from the pre-wipe dist/ build (14:22)
guided by the untracked contract tests (relative-floor 9/9, sibling-phrase 8/8,
paste-isolation 6/6; suite 214/216, 2 pre-existing reds; commit "RECOVERY"). B was
re-run on the restored tree:
- **GR-BENCH: identical table** (above) — C2/floor are neutral on real chat turns; the
  salience verdict stands on the true baseline.
- **FROZEN-271: control reproduces the shipped 0.990** (gutted tree measured 0.979);
  s123 = 0.985 (−1 hit, density 28.7→29.6).
- **NLAB-4 attribution is now truthful** (the trace fix + restored tree): control golds
  = 2 `not_retrieved` + 1 `not_in_top12` + 1 `selection` — S1's earlier "recovery" was
  the gutted tree's gate behaviour; on the restored baseline S1 is a **measured no-op**
  (identical attribution). S3's leak cut (10→3) and goldHit 20% hold.
- **Adversarial (self-corpus, dataset regenerated at the recovery commit)**: control and
  s123 rows identical (recall 0.643). The first run's "confusables 1.0→0.0" was a
  C2-ABSENCE artifact (measured on the gutted tree) — retracted. The 33-case self-corpus
  set does not discriminate the salience flag at all; the k8s-corpus adversarial
  evidence (MEMORY: precision 0.278→0.294 at 0.05) remains the floor/C2 record.
First-run contamination noted: §6's adv confusables row is superseded by this section.

## 6b. Results table (identical downstream, K=10; union labels = frozen pool + 451 top-up blocks judged 2×, 0 neutrals, 2m08s; table reproduces on the restored tree)
| cfg | firedRate | meanScore | goldHit@2 | prec@10≥2 | adv recall/confus | FROZEN-271 | NLAB goldHit/leaks |
|---|---|---|---|---|---|---|---|
| control | 0.258 | 1.14 | 0.792 | 0.350 | 0.875 / 1.000 | 0.979 | 20% / 10 |
| S1 | 0.258 | 1.10 | 0.708 | 0.300 | — | 0.979 | 20% / 10 (+1 cand. recovery) |
| S2 | 0.333 | 1.07 | 0.613 | 0.232 | — | — | 20% / 10 |
| S3 | 0.323 | 1.14 | 0.533 | 0.247 | — | — | 20% / **3** |
| S1+S2 | 0.333 | 1.08 | 0.581 | 0.229 | — | — | 20% / 10 |
| S1+S2+S3 | **0.430** | 1.06 | **0.450** | **0.177** | **0.800 / 0.000** | **0.974** | 20% / 3 |

Per-case: **0 gold-hit gains, 1 loss (S1), 6 fire→abstain losses (S3)** on GR-BENCH; every
fired-rate gain adds turns whose top-10 median-score ≈1 (topically related, no task value)
— injections bought with precision. Latency +42% (S123, 15.8→22.5 ms mean), CPU trivial,
zero new state (IDF exists in the index).

## 7. Failure analysis
- **The flood-dilution premise is false for BM25.** BM25 is already IDF-squared-weighted
  (Robertson et al. 2004): rare identifiers dominate document scoring; multiplying by IDF
  again (S1) over-weights single rare coincidences (a template term like "click" with df=1
  in a small corpus outranks broad topical evidence → GR-BENCH top-10 churn, adv confusables
  collapse 1.0→0.0: the confusable sibling is exactly the high-shared-evidence section S1
  penalises). Huston & Croft's "little gain over BM25" prediction held on every venue.
- **S2's discovery gains die at the gate** (coverage over the full verbose denominator) —
  candidate recovery without admission change is unmeasurable downstream; with S3 added, the
  admission gain arrives with +67% injections at half the precision.
- **S3's sign flips with corpus character**: on recipe negatives (all-rare terms absent by
  construction) tightening dominates (leaks −70%); on real multi-domain turns the salient
  denominator *narrows* evidence below the floor on 6 real turns and un-gates template
  noise on new turns. A mechanism whose sign depends on corpus construction is a calibration
  knob, not a fix.
- Small corpora (NLAB-4 n=5 positives; GR-BENCH 24 fired turns) → all deltas reported as
  uncertain; the direction is consistent across three venues (GR-BENCH, adv, FROZEN-271).

## 8. Verdict
**REJECT S1, S2, S3 (and all combinations) for production.** Verbose-query salience, as the
literature predicts for BM25 systems, does not fix NTK's candidate misses: the misses trace to
(a) the absolute `minScore` floor and (b) the coverage-denominator design — both admission-side
(calibration) problems → routed to **Experiment A (QPP-calibrated selective admission)**. The
one genuine retrieval-discovery lever left is terminology translation (Experiment D). Do not
re-run S1/S2/S3 variants without a substantively new mechanism (e.g. subset-distribution
scoring with co-occurrence statistics at corpus scale, which NTK's size budget forbids).

Files: `bench/b/{trace,probe,grb}.mts`, `bench/b/{score,topup-judge}.mjs`,
`bench/out/b-{train,grb,scored,topup-requests,topup-judgments.*}.json`.
