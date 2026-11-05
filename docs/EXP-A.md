# EXP-A — QPP features and calibrated selective admission (INCONCLUSIVE)

Status: **INCONCLUSIVE** — no production change. The rare-term signal is real
(AUC 0.79 on genuine queries, direction reproduces dev→train) but has **no
operating point that is gold-safe across all venues**, and the sealed holdout
shows zero effect at the dev-frozen threshold. The `minRareIdf` leg stays at
its shipped default (off). Branch `exp-a`, artifacts `bench/out/a-feats.jsonl`.

## 1. Literature (mechanism → assumption → evidence → NTK applicability)
- **Chow 1970** (IEEE T-IT 16:41) — optimal reject rule: abstain iff posterior
  confidence below likelihood-ratio-derived threshold; assumes a calibrated
  posterior. NTK has scores, not posteriors → the rule applies to a
  monotone confidence surrogate only, no guarantees.
- **El-Yaniv & Wiener 2010** (JMLR 11:1605, "Noise-free SC") — risk–coverage
  trade-off formalization: the language we report gains in (FP-reduction vs
  utility-loss), not accuracy claims.
- **Geifman & El-Yaniv 2017** (NeurIPS, selective DNNs) — calibrated risk
  control needs hundreds of labeled calibration samples **per risk level**;
  NTK's graded set has 24 fired turns (15 TP/9 FP). We therefore report
  empirical RC points and make NO risk-guarantee claim (per experiment rules).
- **He & Ounis 2004** (SPIRE, pre-retrieval QPP) — maxIDF/AvQC/SCS correlate
  ρ≈0.30–0.51 with AP; predicts our top3-IDF and rarest features' direction.
  Pre-retrieval-only.
- **Hauff, Hiemstra & de Jong 2008** (CIKM survey) — pre-retrieval predictors
  are cheap but weak; post-retrieval score/Clarity features stronger.
- **Confalonconi et al. 2023** ("QPP for Neural IR: Are We There Yet?") —
  post-retrieval ≈25.6% vs pre-retrieval ≈6.2% correlation for neural ranks:
  motivated using NTK's POST signals (gateCoverage/rarest over retrieved
  candidates, B1 probabilities), which is exactly what the AUC table shows.
- **Shtok et al. 2012** (IP&M 43(4), feature-based QNN) — LR over score-
  distribution + language-model features; needs n≫features. Ruled out at
  n=9 dev (overfit guarantee); 2-feature grid used instead.
- **Clarke 2012 EVD-QPP** — tail extrapolation of score distributions needs
  ~1000 scored per query; NTK caps at 60 candidates. Ruled out (assumption
  violated).
- **Manning/Raghavan Schütze Clarity (2004→2007)** — KL(top‖collection):
  our gateRarest + coverage are the cheap single-section approximations
  already computed by the gate.

## 2. NTK failures targeted
- **FP injections** (fired, all judged labels ≤1): 9/24 fired train+dev —
  the prec@10(≥2)=0.324 deficit from GR-BENCH §3.
- **FN** (useful docs gated out): the class the restored tree exposes:
  NLAB-4 golds gate-rejected at coverage 0.46–0.72 with high top scores.

## 3. Mechanisms tested (one at a time, default-off, identical ranking)
- **A1 score-relative floor**: replace absolute minScore=3 with
  top/(2.2·Σidf top3-rarest query terms) ≥ ρ. **Rejected on forensics before
  tuning: no minScore-FNs exist on the restored tree** — every NLAB gold
  case clears minScore by 3–4 orders of magnitude (top≥9840; the Nov-1
  "4719 minScore" diagnosis was a gutted-tree artifact, retracted); all
  scoreRel values ≥ 2.5 (TP min). ρ has no rescue role.
- **A2 rare-term admission leg** (the shipped `minRareIdf` gate leg,
  calibrated): reject turn iff gateRarest < θ (rarest covered user-term IDF
  as max-attainable fraction; corpus-normalized, P1-9-clean). Post-retrieval
  Clarity/maxIDF family (He & Ounis; Clarity).
- **A3 diffuse-selection (NQC-style) rejection**: nSources ≥ σ among top-12.
  AUC 0.285 (inverse), grid shows no clean point (σ=8: dev FP 2/4 TP 0;
  train FP 4/5 TP 5/10 — kills half of train golds). Rejected on grid.
- **A4 B1 (TinyBERT) as admission signal** (keptMin/keptMean/
  nDropped): AUC 0.729/0.667 (keptMean) — dev 0.5, train 0.94 = sign
  inversion at n=5/6 → overfit noise; b1min=0 appears in TPs (all-demoted
  safety net + lexical protection). Rejected without tuning (unstable
  direction).
- **A5 calibrated LR (Shtok-style)**: ruled out by sample-size assumption
  (9 dev fired turns; ≥100s required) — not run.

## 4. Hypothesis (A2)
"There exists θ such that enabling the rare-term leg cuts ≥30% of FP
injections while cutting 0% of TP injections across GR-BENCH train,
FROZEN-271, NLAB-4, adv-k8s (all venues), with the sealed holdout
confirming." — **Falsified**: the safe-θ interval is empty (below).

## 5. Design
Features dumped once (bench/a/feats.mts, 20 s; B1 applied to fired turns;
labels = frozen pool medians, coverage 1.00 on control fires — A2's fires are
a pure subset, so no top-up judging is required: the gate acts per-turn
before selection). Calibration grid on DEV only (θ 0.6→0.95; σ 3→8;
AUC dev/train split report). Mechanism+θ frozen (0.60) → live venues →
single sealed-holdout run.

## 6. Results vs restored H2+B1+C2 (θ = minRareIdf)
Feature AUC (TP=15 vs FP=9, fired train+dev): gateRarest **0.793** (dev 0.95,
train 0.71), top3QidfSumFrac 0.763, b1keptMean 0.729 (inverted), qtLen 0.644,
nSources 0.285, margin12 0.511, scoreRel 0.393 (inverted).
| venue | control | θ=0.57 | θ=0.60 | θ=0.65 | θ=0.70 |
|---|---|---|---|---|---|
| GR-BENCH t+d fired / goldHit@2 / prec@10≥2 | 24 / 0.625 / 0.326 | 23 / 0.652 / 0.341 | 22 / 0.682 / 0.356 | 18 / 0.722 / 0.366 | 16 / 0.813 / 0.411 |
| TP cuts (t+d, n=15) | — | 0 | **0** | 2 | 4 |
| FP cuts (t+d, n=9) | — | 2 | 2 | 6 | 6 |
| FROZEN-271 goldHitRate | 0.990 | 0.985 | **0.985 (−1 gold, rarest 0.575)** | 0.985 | 0.985 |
| NLAB-4 goldHit / leaks | 20% / 10 | — | 20% / 10 | 20% / 10 | 20% / ≤8 |
| adv-k8s dev/holdout (all rows) | 0.800/0.267 · 1.000/0.294 | — | identical | identical | identical |
| **HOLDOUT (sealed, single shot @0.60)** | 10 fired / goldHit@2 0.600 | — | **0 cuts / 0.600 / no change** | cuts 1 gold (2@0.605) | — |
Per-case: dev cuts 1318#2 (0.636, label 0), 1318#3 (0.579, label 0); train cuts 1924441#2 (0.569, label 1), ec0e2150#2 (0.601, label 1) and, at θ≥0.65, gold-3 turns ec14946#2/ec18f20d#2 (0.615/0.605). FROZEN cut: 1 mined gold at rarest 0.575 (all θ>0.57). NLAB FP (leaks) all fire at rarest ≥0.6689 — the leg is blind to recipe negatives (they carry the rarest terms by construction).

## 7. Costs
Zero runtime (one float compare, precomputed), zero memory, zero index cost
(latency: 32→31/110→112 ms adv-k8s p50 — noise; FROZEN meanTokens 678→637
at 0.60 = −6%). Calibration harness: 20 s dump + <1 s rescore; live venues
≤160 s total.

## 8. Failure analysis
- **The overlap is structural, not tuning:** TP rarest min = 0.6049 (gold-3
  turns at 0.605/0.615) vs FP rarest max = 0.99986. Any θ in (0.57, 0.6049]
  cuts exactly the two dev/train FPs (22 fires, +5.7pt goldHit@2), and
  simultaneously the FROZEN-271 gold at 0.575 (SPEC §9.2 95%-recall gate:
  passes at 0.985, −1 hit = −0.5pt). Every venue with more labels (FROZEN,
  holdout) removes the gain: the sealed holdout's FP fires sit at
  0.682/1.000 — **the FP class at deployment scale is high-rarest**,
  i.e. the generic-vocabulary FP story is the dev/train set's local shape.
- The NLAB-4 FN class (coverage-gated golds, cov 0.46–0.72, rarest 0.78–1.0)
  is untouchable by any score/confidence admission rule studied here: their
  top scores are the HIGHEST in the dump (7553–9840) — confidence-based
  abstention would reject them last. This is terminology mismatch (Exp D's
  target) plus the coverage denominator's verbosity behavior (B's S3, whose
  sign flips — measured), not a calibration gap.
- B1 (the only semantic signal) is direction-unstable at n=15 — as Lioma
  et al. (2015) warn, importance/confidence is context-dependent; small
  samples cannot establish it.

## 9. Verdict
**INCONCLUSIVE.** Signals carry real information (gateRarest AUC 0.79; post>
pre, matching the QPP literature) — the discriminative power NTK would need
lives in features NTK already computes, but at available label volume
(24 fired turns; 9 FP) the RC curve has no point that is gold-safe across
venues, and the one frozen-θ sealed-holdout shot shows no effect. Enabling
the leg at 0.60 = buying −2 dev/train FPs with −1 FROZEN gold and +0.0
holdout: not a reproducible improvement. Recommendation: keep minRareIdf
off; do not pursue calibrated admission further **until the graded corpus
grows** (≥100 fired turns with labels; then LR/Platt scaling on the frozen
feature dump, no new inference). The FN class routes to Exp D.

## Reproduction
Branch `exp-a`: `INCLUDE_HOLDOUT=1 npx tsx bench/a/feats.mts && node
bench/a/analyze.mjs && node bench/a/rescore.mjs`; venues:
`NTK_MIN_RARE_IDF=θ npx tsx bench/{run.ts,nlab/eval.mjs,adv/run-adv.ts
--root ../../bench/repos/k8s-docs}` (each ≤45 s).
