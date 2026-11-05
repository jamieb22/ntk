# EXP-F — Token Budget & Evidence Preservation (REJECT: no change)

Status: **REJECT both levers.** Production stays: tokenBudget 800,
compression ladder (full→excerpt→overview), adaptiveBudget, perDocMax=1.
Larger budgets do not recover evidence (flat marginal, degrading density);
E1 score-greedy allocation wins dev, **loses the sealed holdout**. Branch
`exp-f`; harness `bench/f/{diag,build,metrics,excerpts*}` (all runs ≤3 min).

## 1. Literature (assumption → evidence → NTK fit)
- **Lin & Bilmes 2010** (NAACL, "Multi-document Summarization via Budgeted
  Maximization of Submodular Functions"): greedy is near-optimal for
  coverage-style objectives under a cost budget — the basis of E1; assumes
  the objective (coverage) is submodular and *costs vary* (their key point —
  sentence/token costs, exactly NTK's blocks). Nemhauser, Wolsey & Fisher
  1978: (1−1/e) bound for greedy.
- **Gillick & Liu 2008** (EMNLP, ILP summarization with budget): exact
  knapsack over sentences; greedy is the standard scalable surrogate.
- **Rothe, Narayan et al. 2020** (SD-KB, ACL, selective disclosure):
  evidence units with costs, generate under token budget — establishes
  budgeted disclosure as a first-class IR-adjacent problem.
- **Carbonell & Goldstein 1998** (MMR): redundancy-aware selection — NTK
  ships it (redundancyMax 0.75), so diversity handling is NOT the gap.
- Rejected on constraints: LLMLingua (Jiang 2023) & passage compressors
  (Cochran et al. 2022) need a second LM — banned (one-model rule).

## 2. Stage 1 — pipeline diagnosis (bench/f/diag.mts, 94 fired items)
Mechanism facts (all real, some NOT what the headline suggested):
- `DEFAULTS.compress` (overviewTokens/excerptTokens/excerptSentences) is
  **dead config** — every call site passes `DEFAULT_COMPRESS`
  ({minSentences 2, maxSentences 8}). Documented, not changed (cleanup task).
- overview = first block **uncapped** (the MEMORY-documented 276-tok
  overview; observed: 499>478, 491>172, 498>316) → ladder cliff: sections
  whose first block exceeds remaining budget are **skipped whole** (61
  budget-skip events across 24 fires), not shrunk.
- 31/94 items consumed >50% of the remaining allocation ("cliffs"); 14
  ladder escalations; item loss to compression >80 tok on 35 items (10 of
  them useful).
- C's "34/34 truncated" = candidates beyond top-10 (a CAP metric), not
  mid-section loss — the premise needed this correction.
- 56% of control items ship at **full** level at 800 tok: the budget binds
  the TAIL, not the delivered content, on this benchmark.

## 3. Stage 2 — excerpt-level ground truth (the key instrument)
New independent judgment (2 Claude judges, excerpt-sufficiency rubric:
3=sufficient-as-delivered / 2=useful-incomplete / 1=topical / 0=irrelevant)
over the EXACT delivered text (ContextItem.content), 133+94 items, 0
neutrals. Full-section labels are NOT reused as evidence (rubric grades the
excerpt alone). Decisive finding: full-section relevance overstates delivered
value — of 28 useful (≥2) sections at control, **21 excerpts score lower
than their full label, 6 severe (3→≤1)**; `AGENTS.md#Build/Test/Lint` ships
at FULL level (nothing truncated) yet scores 1 — the section itself doesn't
contain the requested specifics. Truncation is NOT the dominant evidence
loss channel; **selection of the wrong section for the request's granularity** is.

## 4. Stage 3 — budget scaling (control item set frozen; exact delivered text re-rendered)
| budget | delivered (t+d) | sufficiency | useful ≥2 | suf-tok/1k | severe | Δpt/100 tok |
|---|---|---|---|---|---|---|
| 800 (prod) | 16,048 | 4.3% | 13.8% | 38 | 6 | — |
| 1200 | 16,496 (+3%) | 3.5% | 14.1% | 33 | 8 | 0.00 |
| 1600 | 17,239 (+7%) | 3.5% | 14.1% | 31 | 8 | 0.00 |
| 2400 | 17,156 (+7%*) | 3.6% | 14.3% | 31 | 8 | +0.1 (sat.) |
*2400 < 1600: budget-fill admissions (9-11 slots, ~3.3k tok) take cap
slots from control items. Larger budgets preserve more text (items already
full at 800 saturate) and buy **no** sufficiency; useful evidence per 1k
tokens falls 18%. Verdict: bigger budget = more boilerplate, as the user
hypothesized to test. NLAB/adv unchanged (content-only).

## 5. Stage 4 — E1: budgeted score-greedy allocation (800 tok, identical selection/gates)
compressBudgeted: lead sentence ≤25% of item allocation (anti-intro-bias),
then blocks by query-idf score desc (submodular coverage, variable cost —
Lin & Bilmes; greedy (1−1/e) Nemhauser), atomics whole-or-dropped, in-order
fill of remainder; post-pass water-fills shares over SELECTED items
(selection byte-identical to control: fill-admits = 0). Cost: +5 ms median
(16→21), zero index/memory, zero new state.
| venue | control@800 | E1@800 | control@2400 |
|---|---|---|---|
| train+dev sufficiency | 4.3% | **5.3%** | 3.6% |
| train+dev useful/1k tok | 38 | **54** | 31 |
| severe (full=3→ex≤1) | 6 | 7 | 8 |
| **HOLDOUT (sealed, single shot) sufficiency** | **12.8%** | **10.3%** | — |
| **HOLDOUT useful ≥2 rate** | **20.5%** | **12.8%** | — |
| HOLDOUT severe | 1 | 2 | — |
Per-item union: UP 12 / DOWN 13 (sign p≈1.0). Real losses ≥2: 7 (pattern:
TASK_HISTORY/narrative sections — score-first strips the connective context
the answer lives in: 3→1 cases); real gains ≥2: 5 (spec/parameter sections —
exactly where score-greedy shines). E1 beats control@2400 at 64% of the
tokens on train+dev, and the dev win is a venue artifact: the sealed holdout
fires in the opposite direction (its injections are heading-matched specs
where lead-in + first sentences (the ladder's shape) are the sufficient
evidence). 276-tok overview cliff fix (cap) remains a free, uncontested
diagnostic — proposed as a follow-up hygiene change, not shipped here.

## 6. Per-case (E-audit four + severe/gains above): E1 is selection-preserving,
so all four budget-skipped better-siblings (CLUSTER_MASTER §4.5–4.7,
SEARCH_SOLR §2.2) remain skipped — filling them requires selection-level
two-pass re-selection (changes admission order; beyond the authorized
"content-only" scope; its own risk: +11 items/turn at fill-admit avg 37 tok
measured at b1200 — marginal value, unjudged).

## 7. Verdict
**REJECT.** No budget increase (Stage 3: flat marginal, −18% density) and
no allocation rule (Stage 4: dev sign ≠ sealed-holdout sign, severe +1,
real-loss pattern on narrative sections) demonstrates reproducible
improvement in delivered evidence. Production 800/ladder stands. The
excerpts-level instrument built here (rubric + cache + 2-judge protocol,
~2.5 min/133 blocks) is the reusable asset: any future compression change
must now clear excerpt-sufficiency on both dev and sealed holdout —
full-section labels alone are no longer acceptable proof (Stage 2: 21/28
useful sections overstate their delivered value).
Diminishing returns confirmed: truncation losses concentrate in tail/low-
score slots; the 56% full-level majority is budget-unbound at 800.

## Reproduction
`.scratch/exp-f` @ exp-f: `npx tsx bench/f/diag.mts` (40 s) →
`F_BUDGET=B [F_ALLOC=1] npx tsx bench/f/build.mts` (10 s each) →
`F_TAG=… node bench/f/judge-excerpts.mjs --judge sonnet,opus` (≤3 min) →
`node bench/f/metrics.mjs`; latency: `.scratch/lat.mts` (1 min).
Suite at E1 head: 214/216 (2 pre-existing); FROZEN 0.990/density 28.7,
NLAB 20%/leaks 10 (selection-preserving, as designed).
