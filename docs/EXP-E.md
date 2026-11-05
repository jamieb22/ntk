# EXP-E — Document-conditioned unique sibling evidence (INCONCLUSIVE: Stage-1 gate)

Status: **INCONCLUSIVE — stop at Stage 1.** No mechanism implemented; no
production code touched (verified: `git diff exp-e -- src/` empty at head).
The audit found **zero credible sibling-selection injection failures** in
independently judged data, so an improvement over C2 is not measurable.
Branch `exp-e`, artifacts `bench/e/audit.mts`, `bench/out/e-audit.json`.

## 1. Literature (assumptions → applicability; and what is NOT new here)
- **Ren, Feng, Marchionini, Li, Shaw et al. 2002** (SIGIR, document-conditioned
  term weighting) — weight terms by P(t|section) against P(t|document);
  assumes dense per-document term statistics; hierarchical indexing gains at
  TREC volumes (GB-scale).
- **Feng, White, Manmatha, Drasoo 2007** (CIKM, hier2Hier) — score sections
  conditioned on document scores; document prior helps when sections are long
  and documents are few per collection.
- **Fang, Tao, Hui 2006/2009** (document prior in passage retrieval) — the
  "document-shared content" discount needs a passage pool per document
  (full-doc section sets scored jointly).
- **Li & Zhai 2008+ (discriminative LM / PDC line)** — contrast section vs
  its siblings as the uniqueness signal: exactly the proposed E-DCW form.
  Requirement: many competing passages; the contrast is noisy for 2–3-section
  documents (their Fig. 3 degradation at small n per document).
- **Manning/Schütze intro-anchoring; content+structure (Liu & Yu 2004)** —
  boilerplate/introduction discounting: NTK already strips Layer-0 noise and
  caps via `isStructuralOnly`.
- Novelty check vs prior rejections (this program + METHODS-REPORT): E-DCW
  (score × (1+λ·unique-term-ratio over the doc's eligible pool) at the
  perDocMax slot) is a *document-conditioned re-rank of the within-doc
  fight*. METHODS-REPORT's generalizable finding: sibling selection must be
  a TIE-BREAK over the production score, not a replacement — Psg (evidence
  replacement) lost −15.4 on mined golds; SDM/BM25F rejected. E-DCW is a
  multiplier (tie-break-compatible) and thus not already-rejected in form —
  it is rejected here on **target absence**, not on form.

## 2. Stage-1 audit (the gate) — bench/e/audit.mts, 43 s
Definition (strict): a failure exists iff (i) the turn fired, (ii) an
injected section X (label Lx, judged median) has a same-document sibling Y
in the top-12 eligible pool (score ≥ threshold — the same pool C2 fights
over) with label Ly ≥ 2 > Lx. Exclusions per instructions: admission
failures, discovery failures, token-budget truncation, label artifacts.

Results, GR-BENCH train+dev (93 turns, 24 fires; pool coverage 1.00 — every
injected section and every top-14 sibling is independently judged):
| class | n |
|---|---|
| fired sections with a better (≥2) same-doc sibling ANYWHERE in judged pool | 4 |
| …of which the sibling was **eligible** (top-12, floor-clearing) → real C2 target | **0** |
| …of which the sibling lost the slot to **budget/cap truncation** | 4 |
| adv k8s-45 (Nov-1 frozen): confusables | 1.000 (0 failures) |
| adv k8s-20 (regenerated): confusables 0.857 — B-001 forensics: gold INJECTED at slot 1; "failure" = twin ranked higher in the scored list; twin heading is NEGATED in the query (C2 requires positive ordered-phrase citation); heading-derived labels | 0 injection-impacting |
| NLAB-4 C2 gain cases (ts-12, gmock-115) | selected correctly (0 residual) |

The 4 truncation-class cases (e.g. dev f95fdbb: injected[0] vs sibling
label 2; train ec1db458: injected[1] vs sibling label **3**) are C's
"truncated 34/34" finding re-appearing at selection level: the better
section existed, was ranked in-candidate, and died at the budget
(adaptiveBudget: overview-compression overflow — MEMORY 2026-11-01
"MONEY.md::1 lost slot 3 at budget: 276-tok overview > 258 remaining").
That is a **budget-allocation problem**, explicitly out of E's scope, and
it is the natural next investigation.

## 3. Why Stage 2/3 were not run
The gate instruction: "If there are too few credible sibling-selection
failures to evaluate an improvement, stop and report INCONCLUSIVE."
n(credible natural failures) = 0; n(natural truncation-class) = 4;
n(adversarial, heading-derived, injection-clean) = 1. A mechanism with a
measurable target does not exist in the independently judged data. E-DCW
would be tuned against adv-confusables (heading-derived — forbidden as the
ship basis) or the 2-case mined C2-gain set (structural labels, saturation:
1.000 on the frozen set), i.e. exactly the venues the rules disqualify.
Implementing it would manufacture the target, not find it.

## 4. Costs
Audit: 43 s (cached indexes), zero production runtime (no code shipped),
zero memory/index overhead. The Stage-2 probe (evidence.mts analogue for
within-doc term uniqueness density) was not required: the eligible-pool
count (0) upper-bounds any mechanism's benefit at 0.

## 5. Verdict
**INCONCLUSIVE (Stage-1 gate: no credible target).** C2 stands as shipped.
Conditions that would re-open E: (a) ≥5 judged sibling failures with the
better sibling eligible (needs ~4× GR-BENCH fired-turn volume: labels, not
code); (b) budget study (see next) revealing within-doc slot mis-allocation
where the truncation class IS the mechanism's target — at which point the
right literature is the budget/constraint-satisfaction line, not passage
scoring.

## Reproduction
`.scratch/exp-e` @ exp-e head: `npx tsx bench/e/audit.mts` (43 s);
baselines reverified at head: suite 214/216 (2 pre-existing), FROZEN 0.990,
NLAB-4 20%/41.2%/10, GR-BENCH eval exact.
