# GR-BENCH — Experiment C: frozen graded-relevance benchmark + H2+B1+C2 baseline

Status: **SHIPS as evaluation infrastructure** (v2.1, verified against committed artifacts 2026-11-02; v2 rebuilt after the artifact loss; v1 pilot results in the session transcript, superseded).

## 1. Why
All prior NTK evidence (NLAB v1–v4, adv-evidence) was template/synthetic-query based. Experiment C builds the missing foundation for B/A/D/E: a frozen benchmark whose queries are the user's **genuine multi-tool conversation history**, with **independent graded (0–3) relevance labels**, so natural-language recall gains and irrelevance cuts can be measured without tuning on the eval.

Prior-art rationale: TREC deep grading validates graded relevance as the stable signal for sparse labels (Kando; log-score extrapolation, arXiv:1810.10966); LLM judges are validated as near-human agreement instruments (MT-Bench, arXiv:2306.05685 — our 3-then-2-judge median rule); RAG-specific benchmarks (RAG-Bench arXiv:2407.11005; Ranrag arXiv:2407.13883) show real-corpus, real-query evaluation is the only regime that predicts deployment precision. LLM-based query generation and dense retrieval were rejected (protocol: no synthetic queries, no new inference model).

## 2. Design
- **Source**: OpenCode history DB (read-only, `~/.local/share/opencode/opencode.db`), sessions created **before 2026-11-01** (deterministic cutoff). 493 sessions, 8,892 user messages, 225 eligible units, **15 distinct project roots / 16 project pools** (needtoknow itself excluded as corpus target — queries test docs transfer). (Counts from `build-summary.json`; v2 prose said 407/4 — stale.)
- **Units**: verbatim user turns (no paraphrase, real noise: 1–897 chars median 83, ≤3 turns/session selected (≤8 eligible), sessions with assistant replies). Selection seeded (`SEED=20261102`), stratified per project, split by turn quotas 60/36/24 → **27 train / 16 dev / 11 holdout cases** (54 cases, 116 judged case-turns; 4 turns dropped to redaction/parse guardrails). Each turn carries up to 2 prior turns as context (62/116 turns are multi-turn, incl. anaphoric cases like "The entire commit").
- **Redaction**: keys/bearer/emails/phones/SSNs/home-paths replaced pre-storage. Audit: 286 items scanned, **0 leaks** (`redaction-audit.json`).
- **Judged pool (per turn)**: top-10 ranked candidates of the **production pipeline (H2+B1+C2 = current DEFAULTS, no overrides)** ∪ 4 near-miss probes at ranks 11–14 (gate-leak catchers). 334 unique sections; pool = union, identical for both judges (`blocks-by-case.json`).
- **Judges (independent of NTK)**: Claude Sonnet 4.6 + Opus 4.6 via OpenRouter, temp 0, batched K=10, rubric verbatim from `bench/review.ts`, robust parsing + per-block repair pass, sha256(model+prompt) cache. 476 block judgments, **0 neutral fills**.
- **Freeze**: `frozen.json` sha256 over (case ids, splits, turn-key+query-hash, pool ids); the build refuses to re-freeze on drift.
- **Metrics** (`eval.mjs`): meanScore, goldHit@2/@3, prec@10(≥1/≥2), probeLeak, abstention, per split/source. Labels = median of judges.

## 3. Baseline results (H2+B1+C2, K=10)
| metric | value |
|---|---|
| injection rate | 28.3% (real-world target ≈23% ✓; 70.7% turns abstain) |
| meanScore (injected top-10) | **1.09** /3 |
| goldHit@2 | **0.794** |
| goldHit@3 | 0.588 |
| prec@10(≥2) | **0.324** |
| prec@10(≥1) | 0.588 |
| probeLeak | 0.059 |
| truncated (pool>10) | 34/34 injections |
| label distribution (median) | 0:209, 1:124, 2:73, 3:70 |
| judge agreement | exact 0.687, within-1 0.968 (n=476), bias −0.26 |

Reading: on genuine queries the shipped system **fires at the real-world rate**, finds a ≥2-relevant section 79% of the time, **but ~64% of injected slots score ≤1** — the precision problem Experiments B/A target. GoldHit@3 (58.8%) confirms the direct-answer section is present in top-10 more often than it ranks #1 — a reranking headroom signal. ProbeLeak 0.059: near-miss blocks from rank 11–14 leak into top-10 almost never (the gate is not a precision hole at K=10).

## 4. Costs
Build ~50 s (index 15 project roots, 31k sections, 116 retrievals incl. C2-off variant). Judging: 476 blocks / 2 judges / 116 turns, **<6 min total** (concurrency 3, batch 10), ~0.5M prompt tokens. Eval <1 s. Cache file excluded from git (regenerable); judgments committed.

## 5. Known limitations / failure analysis
- Pool is baseline-derived → goldHit measures "baseline retrieves gold" (pool completeness bound). New blocks injected by B/A/D/E are unjudged → scored **neutral 1** in `eval.mjs` (understates novel gains; near-miss probes partially offset; a top-up judging pass over B's diff blocks is planned, ≤6 min).
- 2-way judge panel (3rd retired under the 6-min rule; v1 3-way pilot measured exact 0.85).
- 4 project roots after filters (home-dir, indexable, <cutoff) — narrower than the v1 pilot's 40; the frozen dataset is what it is.
- Truncated = 34/34: injections always overflow K=10; budget-metric (mean tokens) tracked in the C2-off variant + plugin telemetry, not here.

## 5a. Verification & spec-conformance record (2026-11-02)
- **Reproduction:** `node scripts/gr-bench/eval.mjs` re-run on committed artifacts reproduces every §3 number exactly (116/116 turns complete, 0 neutral fills). `npm run bench:nlab` and `npm run bench:adv` rerun under the 6-minute bench rule (41 s / 7 s).
- **Freeze integrity:** `frozen.json` sha256 over (case ids, splits, turn-key + query-hash + pool ids); `build.mts` refuses rebuild on drift. Redaction audit: 0 leaks / 286 items.
- **Judge independence:** labels come only from Claude Sonnet 4.6 + Opus 4.6 over verbatim block text with a fixed rubric — no BM25/IDF/grep/heading anchors in labeling. **Caveat:** the *judged pool* is baseline-derived (top-10 ∪ ranks 11–14), so goldHit measures baseline-retrieved gold; novel candidates from B/D need the diff-top-up judging pass before their gains count.
- **Spec gaps (by design, reported honestly):** (1) *Paraphrases*: not added — protocol bans synthetic queries; natural paraphrase pressure comes from real multi-turn anaphora (62/116 turns contextual, e.g. "The entire commit"). (2) *Terminology mismatch*: present as a measured failure class (misses are `not_retrieved` in NLAB-4; low-IDF-overlap turns score 0–1) not as constructed cases. (3) *Long noisy requests*: real distribution, 1–897 chars (median 83, p90 300). (4) *Difficult negatives*: ranks 11–14 near-miss probes (probeLeak 0.059). (5) *Multiple unrelated repositories*: 15 project roots; queries and corpus are the user's real working set, not public repos (privacy + zero-config constraints).

## 6. Audit of prior evidence (full trail: `bench/nlab/docs/{AUDIT-RERUN,SESSION-AUDIT,METHODS-REPORT}.md` — committed, re-verified 2026-11-02)
- **VALID (structural labels, list-free):** FROZEN-271 / adversarial / mined-set selection claims, incl. C2's evidence (gains, zero losses) and B1's core numbers. Adversarial re-run closed this session (7 s, dataset cache-hit): holdout recall 0.875, confusables 1.000, distractors 0.000, abstention 1.000, prec 0.267, tokens 463 — reproduces the historical measurement; `ntk-full − minCoverage` shows the gate's precision role (distractors 0.000→0.273, prec 0.267→0.180).
- **UNRELIABLE (label/gate-dependent):** NLAB v1–v3 abstention rows (40–60%) were inflated by manually-chosen easy-negative gate terms; superseded by the corpus-derived NLAB-4 recipe (true abstention 25–50%). NLAB-3 goldHit 0.0% for ALL systems was a label artifact (over-granular anchors), not a selection signal. Curated vocabulary lists (G/SPEC) influenced benchmark *reporting and case selection*, never production retrieval (grep-verified in AUDIT-RERUN.md).
- **NLAB-4 fresh rerun (this session):** goldHit 20.0% (1/5 positives), abstain 41.2% (7/17 negatives, in the audited band), 4/4 gold misses classified **not_retrieved** — direct corroboration of Experiment B's target failure mode, on the frozen 22-case set (n too small to generalize).
- Historical precision deltas (0.278→0.294 etc.) confirmed as C2-era measurements, consistent with this report's prec@10(≥2)=0.324 scale.

## 7. Incident (2026-11-02, 14:11–14:47)
Untracked artifacts of this session were deleted twice (`eval/gr-bench/*`, pilot/audit outputs; `scripts/gr-bench/build.mts`). Real disk: HEAD stable at `3f3bc2e`, reflog clean, no stash, no plugin git-cleanup code. Prime suspect: the A7 pilot harness — a detached `nohup` pilot (documented breach-cleanup: `reflog expire`/`gc`/force-remove worktrees) active at exactly that window (`ntk-head` snapshot worktree created 14:11). The sandboxed tool-shell view also mirrors stale snapshots (phantom "v3.5f"/"1,279 deletions" — all void). **Mitigation now enforced: commit + out-of-band tar (`~/Documents/backup-ntk-grbench-20261102.tgz`) before any long job.**

## 8. Verdict
**SHIP** (infrastructure). Experiment B may run against the frozen train/dev splits; the holdout stays untouched until B's mechanism is fixed, judged via the diff-top-up protocol.
*(Update 2026-11-02: B ran and was REJECTED — docs/EXP-B.md. Gate for Experiment A open on train/dev; the topup protocol cost 2m08s/451 blocks, within the ≤6-min bench rule.)*

Files: `eval/gr-bench/{frozen,dataset.jsonl,blocks-by-case.json,baseline-h2b1c2.json,redaction-audit.json,build-summary.json,judgments.*,eval-report.json}`, scripts `scripts/gr-bench/{build.mts,judge.mjs,eval.mjs}`.
