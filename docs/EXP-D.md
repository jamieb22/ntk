# EXP-D — Sparse corpus-derived lexical translation (REJECT: insufficient evidence)

Status: **REJECT at the feasibility gate.** No production code changed.
Terminology-miss recovery via repository-internal lexical evidence is not
achievable at NTK corpus scales. Branch `exp-d` @ head; artifacts
`bench/out/d-evidence.json`, `bench/d/{harvest.ts,evidence.mts,coverage.mts}`.

## 1. Literature (mechanism → assumption → evidence → NTK applicability)
- **Berger & Lafferty 1999** (SIGIR, IR as statistical translation) — query→doc
  term translation via EM over initial rankings + relevance feedback.
  Assumptions: collection-wide term-alignment statistics, per-query EM.
  NTK: no relevance feedback, corpora of 21–9805 sections → unidentifiable
  parameters. Liu, Xu & Lin 2022 (SIGIR, "Another Look at IR as Statistical
  Translation") re-validates: IRST gains require large collections and rich
  alignment evidence; degrades in sparse regimes.
- **Abdul-Jaleel et al. 2002** (SIGIR, Biterm Language Models) — biterm
  co-occurrence translation matrix; the paper's own limitation: sparsity of
  biterms in small collections forces aggressive smoothing (→ topical pairs).
- **Brown, Della Pietra, Mercer, Roukos 1990/1993** (Comput. Linguistics) —
  class-based n-grams/SMT parameter estimation: cluster stability needs
  ≥10⁵–10⁶ tokens. NTK projects: 10³–10⁵ tokens of docs.
- **Fung & Yee 1995/1998** (VLC/ACL, non-parallel gloss mining) — apposition/
  parenthetical "X (Y)" extraction; precision high **per pair**, yield
  requires news-scale corpora.
- **Taghva & Gilbreth 1999; Yaar et al. 2002 (WWW)** — acronym↔expansion from
  billion-word webs; pattern precision 90%+ at 10⁴+ occurrences.
- **Lu, Chen et al. 2002 (COLING)** — anchor-text as comparable corpus; 109,416
  pages mined for usable pairs; explicit finding: "in a small collection, the
  frequencies of strings are very often too low" for the statistical methods.
- **Vulić & Moens 2012** (EACL, highly-confident translations without prior
  knowledge, comparable corpora) — needs thousands of contextual occurrences
  per word for distributional consistency.
- **Karpinska & Iyyer 2023** (PTKB, ACL) — Wikipedia link-title↔anchor =
  the same structural evidence NTK has, at 11M pairs: authors must filter
  heavily because anchors are **topical, not equivalent** — the user-stated
  constraint confirmed at the largest natural scale; at 10² pairs the noise
  dominates.
- **Farooqu & Manandhar 2007** (ECIR/SIGIR, query translation in IR) —
  translation models without clean parallel corpora give ≈zero gains;
  corpus-derived associations frequently inject noise.

Shared assumptions: large corpora, many occurrences per association,
(top for biterm/ident-ctx patterns) distributional consistency. None hold
in a per-project software repo of 21–9805 sections.

## 2. NTK failure targeted (the genuine class)
Verbatim-issue terminology misses, NLAB-4: k8s-57675 (issue "Korean 404
links" → doc "translation…broken links"; `translation` absent from issue,
`404` present in doc, coverage 0.72 gated); httpx-203 (issue "http proxies"
→ doc "Environment variables"; no shared content word); fastapi-4719 (async
issue → Dependencies section; score dilution, B's class); k8s-53971/58015
(prometheus/adapter, YAML/config-map). GR-BENCH pool bias hides the class
(judged pool ⊇ baseline top-14); the class was surfaced by A's forensics.

## 3. Proposed mechanism (and why it differs from Exp-B's PMI expansion)
Harvest repository-internal evidence **structurally**, six pattern families
over the project's own docs (no dictionaries, no models, deterministic,
index-time): gloss parens `X (Y)`, acronym↔initials-expansion,
code-citation↔clause context, markdown anchor↔target slug, cross-reference
sentences ("see the rollback section in deploy.md"), heading↔filename.
Evidence floor BEFORE any translation: count ≥2 AND files ≥2. Translation
would feed retrieval as a third expansion channel, admission unchanged
(gate numerator still requires USER terms — no global relaxation, per rules).
Differs from prior attempts: B weighted the *given* vocabulary (query side);
D bridges to the *documentation's* vocabulary (lexicon side), using only
naturally occurring evidence.

## 4. Falsifiable hypothesis
"If repository docs contain ≥3 reliable bridge pairs per corpus with
files≥3, the translation channel recovers ≥2 of the 4 NLAB-4 gold misses
independently-judged, without new false injections at adv/FROZEN venues."
— **Falsified in stage 1.**

## 5. Feasibility study (gate; 3 s runtime, no production change)
Harvest across 8 corpora (243–9805 sections) with the floor applied:
| corpus | sections | eq-fam pairs (gloss+acr+anchor+title) | ident-ctx (topical, excluded) |
|---|---|---|---|
| self | 243 | 12 | 7 |
| Effect-TS (sparse clone) | 21 | **0** | 0 |
| httpx | 185 | **2** | 39 |
| googletest | 501 | 14 | 193 |
| rust-book | 547 | 2 | 945 |
| fastapi | 1163 | 48 | 709 |
| tanstack | 1088 | 50 | 920 |
| k8s-docs | 9805 | 167 | 2723 |

Pair quality (eyeballed, k8s top-30): clean equivalence examples exist
(`selector (label query)` gloss: selector↔label/query, n=35, f=29 — a true
definitional pair; acronym pairs n=2), and the structural patterns are
precision-viable **in principle**. Yield is the killer: 167 pairs across
9805 sections = 0.017 pairs/section; the high-volume channel (ident-ctx) is
exactly the topical co-occurrence the constraints forbid (k8s: `spec↔pod`,
tanstack `TError↔TData` co-listed in signature tables, rust `main↔list`
listing-caption boilerplate).

**Bridge test (decisive):** for each NLAB-4 gold, gap = gold content terms
∖ issue terms; a bridge = harvested pair (a∈issue, b∈gap):
| case | gap terms | eq bridges found | verdict |
|---|---|---|---|
| k8s-53971 | 431 | update↔object, update↔metadata (f2, topical) | none usable |
| k8s-58015 | 50 | configur↔yaml, pod↔run (title-slug, topical) | none usable |
| k8s-57675 | 25 | **NONE** (404→translation absent; the doc's own link pattern [404s](../troubleshooting.md#404s) is self-referential) | 0 |
| fastapi-4719 | 20 | **NONE** | 0 |
| httpx-203 | 56 | **NONE** (corpus yields 2 pairs total) | 0 |

## 6. Results vs H2+B1+C2
No mechanism was built (gate: "if the repository does not contain enough
reliable evidence, stop rather than inventing associations"). Baseline
unchanged; NLAB/GR-BENCH/adv/FROZEN rows = §EXP-A baselines.

## 7. Costs
Feasibility study: 3.0 s (cached indexes), zero memory beyond one pass,
zero index-time addition (nothing shipped). Harvest at index time would
cost ~10% (pattern regex over section texts) — moot.

## 8. Failure analysis (why the class is not solvable this way)
- The misses are **one-shot, corpus-unique** terminology gaps (Korean 404s →
  translation broken-links). Statistical translation needs recurrence: the
  evidence floor (≥2 files) that makes the channel *reliable* also excludes
  the single-gloss evidence these cases have.
- Structural evidence density in software docs is ~0.02 pairs/section;
  100× below the regime where the literature's precision numbers hold.
- The only dense channel (ident-ctx) is topically confounded by design
  (co-listing in API signature tables, captions) — PTKB's 11M-pair filtering
  lesson: co-occurrence ≠ equivalence; at 10² pairs there is no filter that
  restores precision.
- Admission interplay (per rules): any discovery-only gain must survive the
  unchanged coverage gate; translated-only matches add no USER-term coverage,
  so D-T would die at admission exactly as B's S2 recoveries did — the
  venue math made a full implementation measurably pointless before building.

## 9. Verdict
**REJECT — insufficient natural evidence in software-repository corpora
(NTK's design domain).** This is a real limitation, not a tuning failure:
genuine terminology-miss recovery requires semantic knowledge that is not
present in repository text at usable density. The one true equivalence
success observed (k8s selector↔label-query gloss) is the pattern ceiling:
~167 pairs in a 9805-section corpus, zero of them on the miss path.
Do not re-attempt corpus-derived translation without: (a) click/relevance
feedback (Berger-Lafferty EM), (b) an external lexicon (forbidden by
design), or (c) a semantically dense cross-reference structure (docs at
Wikipedia scale). Remaining honest lever for the class: B's S3
(gate denominator over the salient subset) — sign-inconsistent, would need
the A-venue volume first.

## Reproduction
`git worktree .scratch/exp-d`, branch `exp-d`:
`npx tsx bench/d/evidence.mts && npx tsx bench/d/coverage.mts` (3 s each,
indexes cached; NLAB/adv/GR-BENCH rows inherited from Exp-A §6 baselines).
