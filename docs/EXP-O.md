# EXP-O — Context-aware passage retrieval (isolated research)

Status: **PROTOCOL FROZEN before embedding/eval.** Branch `exp-o` @
552c02d (production pure; suite 204/2, 2 pre-existing reds; EXP-K
baseline reproduced exactly: B 683/587, C 57, D 33, delivered 16). Model:
potion-retrieval-32M rev 6fc8051f, safetensors sha256 `07609e5b…` (same
artifact as M/N — no new model). Central question: can smaller,
structurally-contextualized passage representations make Model2Vec's
TOP results reliable (N's failure) at acceptable vector/latency cost?

## §2 Literature applicability (summary; full in report)

DAPR (ACL24): title/prefix conditioning helps lexical+dense retrieval on
short corpora → applicable as deterministic prefix (arm C). Dense-X
(EMNLP24): finer granularity (propositions) beats sections for
knowledge-intensive recall → partially applicable (paragraphs; no
propositionizer without a model). Contextual Retrieval (Anthropic24):
LLM-generated context prefixes → **not permitted** (§4: no LLM); its
ablation shows cheap deterministic context (headings/path) recovers part
of the gain — arm C is that constrained analogue. Late Chunking (2024):
contextualized embeddings via post-attention mean pooling — **not
applicable**: Model2Vec is static (bag-of-subword-vectors, no attention).
ColBERT/PLAID: token-level late interaction — **not applicable** (static
mean-pool destroys token structure; multi-vector arm D is the
degenerate static analogue).

## §4 Arms (same query text, model, corpus per population)

A sections — M/N representation (2000-char production view).
B passages — deterministic block extraction (§5), raw text.
C heading-aware — same passages, prefix `DocTitle > H1 > H2 (relpath)`
  (prefix ≤ 200 chars, deterministic truncation head-kept, count reported).
D multi-vector — per section: {docTitle vector, heading-trail vector,
  body passages (B)}; section score = max over its vectors.

## §5 Passage extraction (deterministic, project-agnostic)

Blocks on blank lines; fenced code blocks atomic; heading line + its
following block bound; blocks < 80 chars merge with neighbor when the
merge ≤ 1600, else kept whole; per-project exact-duplicate passages
deduped (whitespace-normalized; count reported); offsets preserved
(section.startLine + block line offset). No gold labels, no project
rules. Length distribution + vectors/project recorded.

## §6 Ranking

Exact cosine, project-root-scoped. Passage-level: direct top-K of
passages (dedup by passage id). Section-level: max-passage-score
aggregation (+ top-2-mean control); dedup by section; length-bias
measure = rank vs passage-count per section (report Spearman).
No fusion, no admission, no expansion in ranking stages.

## §7 Data

K-34 (inspected diagnostic; 636 gold sections judged @cap-400) +
N-31 (independent DEV: 24 labeled docy, 79 golds @cap-300; N1: 13
abstain/8 with gold; 7 docless S5 negatives). New passage-level
judgments (deepseek T=0, cached, blinded — prompt contains no arm
identity; consent line; est. ≤250 pairs ≤$0.15): passage rank-1 (A
included — its top-1 on K-34 was never judged), ranks 3, 5 on B/C/D.
Section judgments inherited from EXP-K/N labels. Section grades are NOT
propagated to passages.

## §13 Gates (pre-registered; O2→O4 sequence)

- **O2-G1 primary:** arm C judged-relevant (L≥2) rate at passage
  **rank-1** over K34+N31 ≥ **30%** and ≥ 2× arm A rank-1 (A expected
  ≈0–5% from N's 0/14; K's A top-1 judged this run). B reported; D
  reported. Fail → STOP, verdict REJECT (INCONCLUSIVE if n<40 judged
  rank-1 pairs).
- O2-G2 recovery: section-level (C, max-agg) gold ≤20 on K34 ≥ 12
  (no material loss vs M's 15); on N31 A-gold-8 ≥ 3 (vs N 2/8).
- O2-G3 no-regression: on lexical-success strata (N S1, K fired turns),
  C rank-1 judged-relevant ≥ A rank-1 − 2pp.
- O2-G4 top-rank noise: C rank-1 judged L0 rate ≤ 40% (N baseline:
  71% of judged top-1s were L0).
- O3 (diagnostic only): boilerplate = passages whose exact text occurs
  in ≥3 sections/projects; L0-vs-L≥2 score distributions; single
  duplicate-frequency-discount arm reported, NOT gate-bearing.
- O4 (only if O2-G1..G4 pass): trace where C's rank-1 passages would
  enter production (pool position, coverage, slots) under unchanged
  gates; delivered-content judging of a controlled comparison only if
  the trace shows reachability; discovery-improvement + downstream
  blockage reported separately; NO admission changes.
- O5 (only if O4 shows reachability): N-31 is the only untouched-ish
  population (new sessions; K-roots) — treated as independent DEV, not
  validation (NI limitation stands from N): SHIP CANDIDATE capped at
  INCONCLUSIVE by §14 (a discovery experiment cannot authorize
  integration; verdict max = promising-INC) — recorded.
- Resource: index ≤ 60 MB/project-scale, query p95 ≤ 30 ms CPU,
  incremental reindex ≤ 5 s/10 sections, vectors ≤ 15× sections;
  measured (report even if missed).

## Reproduction

`bench/o/{extract.mts,embed.py,run-arms.mts,judge-p.mts}`; artifacts
`eval/exp-o/`. API used only for cached passage judging.
