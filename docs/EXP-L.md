# EXP-L — Hybrid Synonym Dictionary (offline diagnostic)

**Verdict: REJECT.** Pre-registered gate G1 required ≥6 of 34 failure-cohort
discovery-miss turns recovered into top-20 by any dictionary arm; the
measured value is **0/34 (all arms, both dictionary tiers)** — the
pre-registered minimum is not met, and G3 (noise ratio) fails on top of it.
§7 pipeline injection was therefore not run (protocol: only on discovery
gain). Production behavior unchanged; `src/` diff vs main = 0. The protocol
(§3 acquisition, §4 gates, frozen expansion policy) was committed at 6c836d6
before any evaluation; nothing here was tuned after seeing the outcome
(the WN tier robustness re-run was pre-planned, both builds reported).

Decisive question — can general-English + software-tag synonyms recover what
NTK cannot find, without net harm? **No, at this yield.** The mechanism fails
in the layer EXP-K pointed at: these dictionaries do not contain the
technical-sense vocabulary the missed documentation uses.

## 1. Source and licensing analysis (as acquired)

**A. Stack Overflow approved tag synonyms** — official Stack Exchange API
v2.3 `GET /tags/synonyms?site=stackoverflow` (2026-11-03): 2,500 ACTIVE
APPROVED synonyms (anonymous pagination cap 25×100, newest-first; full
table ≈10k+ needs an app key). License: content CC BY-SA 4.0 (share-alike
applies to a derivative database — bundling into NTK's MIT package requires
a copyleft analysis; recorded, not shipped). Direction preserved:
`from_tag → to_tag` canonicalization, one-way. Relationship type: community
approved tag identity (posts retagged) — interchangeable as a retrieval
target for SO vocabulary, not general synonymy. Multi-word: hyphen-joined
tag forms preserved (1,517 multiword). Acquisition attempts (all official,
all documented failures): SEDE web export (Cloudflare 403 JS challenge);
IA item `stackoverflow` 2019 dump ("Item not available"); the current
official quarterly dump (IA `stackexchange`, 2024-04; via profile
Data-dump-access, login-gated) **no longer publishes the TagSynonyms table**
— Tags.xml ships 0 synonym attributes.

**B. Open English WordNet 2022** — official
https://en-word.net/static/english-wordnet-2022.xml.gz, version-pinned
(11.9 MB gz; 161,221 words / 120,068 synsets; CC BY 4.0 + legacy WNDB
notice in the WNDB-format files). Synset membership = interchangeable in
that sense; sense id recorded. Multiword lemmas preserved
(`inversion_of_control` → "inversion of control", 140,444 multiword pairs).
Proper nouns excluded; POS filter n/v/a/s.

## 2. Dictionary construction and filtering

Common record: {from, to, src, rel, dir, tier, senses}; dedup
(from,to,src) with provenance. Never expanded (protocol §2): code-shaped
tokens (dotted/camel/snake/digit-bearing), file paths, URLs, versions,
<4-char tokens, stopword heads. Construction inputs = the two raw sources
only; no EXP-K golds, no project vocabulary, no benchmark-targeted mappings
(auditable: build-dict.mts reads src-data/ exclusively).

| stage | SO | WN |
|---|---|---|
| raw | 2,500 | 313,720 synset pairs |
| after dedup | 2,013 | 302,530 |
| eligible (len/shape/POS) | 2,013 | 230,054 |
| primary tier (senses≤3, ≤4 targets/from) | 2,013 | ~228k → grouped |
| compiled dict.json | — | **7.05 MB** (110,272 from-lemmas; robustness build senses≤1: 6.60 MB, 208,774 pairs) |

Both builds pass the ≤10 MB disk gate; results reported for both (they
differ only in WN breadth, and both score 0 recovery).

## 3. Baseline verification

- Production pipeline inspected at @6ced4bd: MiniSearch classic BM25 d:0,
  boosts 4/3/2/1; PMI expansion (build-time, corpus-internal, ≤8 terms
  weight 0.4) — the dictionary targets a *disjoint* vocabulary class (tag
  canonicalization, cross-lemma English synonyms; PMI offers neither,
  measured overlap: PMI terms never include the 8 dictionary-present oracle
  terms). Gates/selection/compression: DEFAULTS as shipped.
- H2/B1 confirmed inactive: `src/plugin` has zero rerank references
  (grep); rerank.ts bench-only (EXP-H runtime audit re-verified).
- **EXP-K discovery reproduction: EXACT** — trace.mts rerun on live corpora
  reproduced the frozen first-loss table 1:1: B 685 (raw100 587 + pool 98),
  C 56, D 33, delivered 15 (65 turns, replayOk 65/65).
- Frozen inputs: EXP-K lock `62f9eb90e3f0…`, labels.json (789 golds,
  cap-400 full-corpus), suite 204/2 (2 pre-existing anchor reds).

## 4. Four-arm retrieval comparison (Stage 6, discovery only)

Frozen policy: original query preserved; expansions (≤3/turn; SO unigram >
SO bigram > WN least-ambiguous) run as secondary raw-BM25 searches; merged
pool = originals, then appended expansion hits (no re-rank of originals);
expansion matches never count as gate coverage. RRF: not needed for the
gate question (appended ranks recorded); sensitivity: golds never entered
top-100 in any arm, so no fusion rule can move them into top-20.

| cohort (turns) | arm | turns w/ recovery top-20 | golds recovered @20/@50/@100 | added candidates | confirmed noise (label ≤1) ≤100 | ≤20 | unjudged |
|---|---|---|---|---|---|---|---|
| FAIL 38 | A | 0 | 0/0/0 | 0 | 0 | 0 | 0 |
| FAIL 38 | B (SO) | 0 | 0/0/0 | 0 | 0 | 0 | 0 |
| FAIL 38 | C (WN≤1 / WN≤3) | 0 / 0 | 0/0/0 → 0/0/**1** | 5 / 89 | 0 / **23** | 0 / 0 | 5 / 65 |
| FAIL 38 | D (both) | 0 | 0/0/0 → 0/0/1 | 5 / 89 | 0 / 23 | 0 / 0 | 5 / 65 |
| REP 18 | C/D | 0 | 0/0/0 | 6 / 13 | 0 / 5 | 0 / 5 | 6 / 8 |
| NEG 9 | all | 0 | 0 | 0 | 0 | 0 | 0 |

- **Recall@5/10/20/50 identical to A** in every arm (the 1 gold enters at
  rank 100 = pool edge). Expansion fire rates: SO 7/65 turns; WN 47/65
  (≤1 tier), 62/65 (≤3 tier).
- Per-project: archiva3 0, archiva_frontend 0.
- Both-dictionaries-help cases: 0. Combined-worse-than-either cases: none
  measurable (all arms tie at zero recovery; D adds WN's noise, i.e. D ≡ C).

## 5. Per-case discovery gains and regressions

Zero gains. The single @100 gold (FAIL, rank 100) is below every gate-relevant
pool depth. No original-ranking regressions (appended-only fusion).

## 6. Complete pipeline and injection results (§7)

Not run — pre-registered gate G1 failed (0 < 6). Reporting injection effects
of a mechanism that never retrieves the gold would be measuring noise.

## 7. Negative-control performance

NEG cohort: no arm added any candidate (9/9 turns, all arms) — the
dictionary is inert on non-documentation requests; noise appeared only
inside doc-bearing positive cohorts (FAIL C: 23 confirmed-irrelevant
candidates at ≤100 vs 1 gold at the pool edge → G3 ratio 23:1 vs the 2.5:1
ceiling; REP: 5 confirmed ≤1-labels, 5 of them inside top-20 —
head-of-pool contamination by generic English: "adherence/adhesion/
affixation" for "attach", "bequest/inquisitive" for "option",
"countersign/parole/watchword" for "password", "transmigrate" for "migrate").

## 8. Failure diagnosis (§8) — the essential result

Coverage probe against the EXP-K oracle terms (independent annotator's
doc-terminology queries, 34 FAIL discovery-miss turns), WN≤3 build:
**needed vocabulary present in dictionary: 8/34 (24%); absent: 26/34 (76%)**
(≤1 tier: 2/34 present). Classification of the 34:
- **No relevant synonym relationship exists: 26/34** — WordNet's sense
  inventory stops at general English; the technical senses are simply not
  in it (crash→break/wreck, not →exception/segfault; migrate→transmigrate,
  not →schema-migration; auth/timeout/upload/config/cache/search have no
  CS entries at all). SO synonyms are tag→tag (from_tag is itself a tag
  form: `nextjs`, `centrifuge`, `sql-server-vnext`), so a prose request
  ("how do I speed up the search?") never matches the key side — fires
  7/65, and its targets (`option-type`, `http-redirect`) are tag vocabulary
  the docs' prose rarely uses verbatim.
- **Correct expansion generated, retrieval still failed: 8/34** — for the
  8 present cases (auth→security, component, …) the expansion queries fired
  (3–4 phrases/turn) and retrieved nothing in top-100: the bridge words
  (e.g. "security") match too generically across a 1,496-section corpus
  (11–89 tail/unjudged additions, 23 confirmed noise), i.e. the synonym
  lands on a *near-miss* of the doc term, not the doc term.
- Sense/ambiguity failures at generation: documented above — monosemy in
  WordNet selects the *non-technical* single sense, the exact wrong sense
  for programming requests; the ≤1-tier sample makes this visible
  (transmigrate/countersign/method acting).
- Downstream (gate/selection/compression) classes: 0 by construction (§7
  not run; EXP-K: those stages have their own small populations).

A zero-gain result caused by **missing dictionary coverage**, not search
integration: the integration fired (62/65 turns), was fast, and found
essentially nothing useful. This is the honest negative the experiment was
built to be capable of returning.

## 9. Overhead

| metric | value | gate | pass |
|---|---|---|---|
| dict.json on disk | 7.05 MB (≤1 tier: 6.60) | ≤10 MB | ✓ |
| cold parse load | 63 ms | ≤100 ms | ✓ |
| warm load | 44 ms | — | ✓ |
| RSS for parsed dict | +36 MB (JS object) | none set — flag: large | ⚠ |
| production retrieval (archiva3, 1,496 secs) | median 26 ms p95 30 ms | — | — |
| +3 expansion searches | median +0 ms p95 +1 ms | ≤+3 ms | ✓ |
| extra searches/request | 3 | ≤4 | ✓ |
| new deps / runtime network / models | 0 / 0 / 0 | 0 | ✓ |

Overhead is NOT the binding constraint; yield is. (RSS note: a
Map-of-small-arrays build would cut the 36 MB; moot at REJECT.)

## 10. Limitations, uncertainty, verdict

- Dev population = EXP-K frozen cases (published); the independent
  validation cohort was mooted by the G1 failure (rule: verdict caps at
  INCONCLUSIVE without validation — with zero DEV recovery, REJECT is the
  rule-set outcome; INCONCLUSIVE requires marginal gains, which were not
  observed: 0 < 4–5 = marginal band).
- SO arm used the newest 2,500 of ≈10k+ active synonyms (API cap, no app
  key): coverage of the *missing* 7.5k is bounded by the same tag-form key
  structure (from side = tag vocabulary) — cannot plausibly lift prose
  key-matching; recorded as a one-sided limitation.
- WordNet 2022 pinned; CS-sense coverage of 2023/2024/2025 editions: the
  project tracks PWN (WordNet has no CS domain lexicon; new synsets are
  general, e.g. "tablet (computer)"), so the 76% absence is structural.
- The oracle's own ceiling (82%) remains the upper bound for *doc-vocabulary*
  expansion; a static general-English/tag dictionary is the wrong instrument
  to reach it. Mechanisms that target this gap remain the ones EXP-G/EXP-D
  closed: semantic encoders (rejected at yield 0.118/turn vs 0.5 gate),
  corpus-scale lexical translation (impossible at project scale), LLM query
  rewriting (new inference on the hot path — excluded by the current
  constraint set).
- Noise counts use judged-corpus denominators (cap 400/turn); unjudged
  additions reported separately (FAIL C: 65 unjudged) and never counted as
  irrelevant.

**Verdict: REJECT — insufficient discovery improvement (0/34 vs gate 6/34),
plus measurable query drift (23:1 confirmed noise; REP top-20 contamination)
at low latency cost. Do not ship the dictionary. No production, threshold,
pipeline, or packaging change results. Per the task directive: stop — no
further dictionary sources, algorithms, or integrations are auto-authorized.**

## 11. Supplement — stem-normalized ("proper dictionary form") lookup

Review question: was the zero result an artifact of a naive exact-surface-
form lookup? Dictionary keys and query lookup re-run stem-normalized (same
Porter stem as production BM25; WN pairs bidirectional; hyphenated bigram
keys; POS n/v/a; multiword preserved). Results:

- Coverage probe: needed vocabulary present 8/34 → **14/34 (41%)** —
  morphology had cost ~6 turns of dictionary presence (e.g. `reducing` →
  key `reduce` now matches). Absence: 20/34 (59%), structural.
- **G1 recovery: 0/34, all arms, top-20/50/100 — unchanged.** The single
  rank-100 gold from the exact-lookup run disappeared.
- Noise got *worse* with the better lookup: REP +21 added, 6 confirmed ≤1
  (5 inside top-20); **NEG cohort false candidates 0 → 4, all confirmed
  label-0, all inside top-20** (stemmed SO key matching fires the tag arm
  on conversational requests and returns only noise).
- Overhead unchanged (6.49 MB, 37 ms, +0/1 ms).

Conclusion: the REJECT is lookup-integration-robust. Proper morphological
matching increases dictionary *coverage* and *fire rate*, adds negative-
control noise, and recovers zero gold — the failure is the source data's
sense inventory, not the join.

## Reproduction (no external API calls; judging reuses the frozen EXP-K caches)

`bench/l/build-dict.mts` (reads `eval/exp-l/src-data/` only) →
`bench/l/expand-eval.mts` (~40 s) → `bench/l/diag.mts` (~2 min, reindexes
archiva3). Baseline check: `bench/k/trace.mts` (3.5 min) reproduces EXP-K
first-loss counts exactly. Protocol: this file §3–§4 as committed at
6c836d6; artifacts: `eval/exp-l/{dict.json,dict-stats.json,discovery.json,
discovery-perproject.json,diag-coverage.md,trace-rerun.log}`.
