# EXP-Q — Injection-Stage Delivery Benchmark (A vs B) — DRAFT, NOT FROZEN

Status: **P0.1 FAIL (spaceinvaders corpus deleted — N31 anchored rates capped;
cohort design excludes that root), P0.2/3/4 GREEN after the SQLite correction**
(P0-FINDINGS.md). Path 1 harvester deployed; queue live. Freeze at P2 when
Q40/controls/attachment gates show ✓✓✓.

## Objective
Measure whether raw-passage indexing (EXP-O arm B) delivers more relevant documentation
content in **final injected context** than production NTK (arm A), for real OpenCode
requests, under identical token budgets. C (heading prefix) is not re-run; EXP-O numbers
(B 58.3% > C 50.0% rank-1 gold, n=24) cited as closed diagnostic.

## Safety
Isolated worktree `exp-q`; preserve all prior worktrees and EXP-O @ d600205; no production
modification, merge, push, or deletion; stop if provenance fails; external judging of
document text requires explicit recorded user authorization (EXP-O precedent: ~8% of judged
units contain fenced code; NTK never transmits source files — attachments arrive redacted).

## Pre-flight (P0) — blocking, no spend
1. Corpus completeness: 100% request-root coverage at index time. (Current status: FAIL.)
2. Injection fidelity: offline replay pipeline must byte-match production K34 traces ≥90%
   (harness: bench/k/trace.mts, replayOk 65/65 at base). (Status: feasible.)
3. Compression determinism: if compression is model-driven, freeze model+prompt at T=0,
   cache per (arm,request); no live generation during judging. (Status: feasible.)
4. Power pre-flight: fresh cohort n≥40 with ≥1 grade-2/3 snippet. (Current status: FAIL.)

## Dataset (P1)
Fresh cohort **Q40** (n≥40) via DB harvester (P0.4 correction: 763 unexposed turns
queued at first run; window 2026-10-27→), plus 20 no-relevance controls and ≥3
attachment/file-reference requests (relaxed from 8: in-window corpus of attachment
requests is ~3; documented amendment). K34/N31/EXP-O
pools = previously exposed diagnostics only. Ground truth: grade-2/3 snippet labels judged
from snippet text (blinded deepseek T=0, EXP-O rubric, fences retained), frozen before
injections; ≤400 pairs, ≤$0.25; judge-output validation gate (non-empty content, all-ID
parse, bs≤10 fallback per EXP-O incident). No invented requests or labels.

## Systems
A: production NTK pipeline unchanged (offline replay, fidelity-gated).
B: EXP-O raw passages (v3 extraction, spaceinvaders gap closed or cohort excluded).
No silent changes to admission/selection/compression; any adapter documented with deviations.
Same token budgets, same snapshot, same requests.

## Primary metric — Q1 gate
**RSDR@Q40**: fraction of grade-2/3 snippets whose information content (not title/vague
reference) appears in the arm's final injected text; binary, blinded, 2 runs, T=0
adjudication. **PASS iff B − A ≥ +15pp and request-clustered bootstrap CI lower bound > 0**;
n<40 → INCONCLUSIVE (hard).

## Secondary
Hit-rate@≥1 per arm; injection precision (2/3 share); false injections on controls
(B ≤ A + 5pp); median/p95 added tokens (≥2× inflation at equal RSDR = FAIL); p95 scoring
latency + index size vs EXP-O §10 resource gates (60MB, 30ms, 5s/10 sections).

## Failure analysis
Per snippet: first responsible stage ∈ {discovery, ranking, admission, selection/budget,
compression}, from traces. Required in report regardless of Q1.

## Integrity & Decision
Same snapshot for arms; exposed cohorts labeled; no tuning on frozen set; report both
conditional-on-injection and all-requests (abstention = miss). Q1 PASS ⇒ *candidate*,
never ship authorization (standing directive). Report and STOP; no follow-on experiment
without authorization.

## Execution
P0 probe (done, blocked) → authorized unblock → P1 harvest+labels → P2 freeze (commit) →
P3 injections (A,B) → P4 delivery judging → P5 metrics+failure table → P6 report, STOP.

## Path 1 deployment status (2026-11-03, user-authorized)
- Continuous harvester `bench/q/harvest-q.mts` deployed: local-only, 0 API calls,
  appends to `harvest-queue.jsonl`; excludes 78 exposed K/N ids, `.scratch` worktrees,
  pre-2026-11-03 sessions, and in-progress sessions (<10 min idle).
- NTK-017 debug audit enabled (`.ntk/debug.json` = true) on 15 configured roots
  (`eval/exp-q/roots.json`); file-only, content-free channel.
- **Deviation (verified):** injected `<needtoknow_context>` blocks are NOT persisted
  in storage parts. Arm-A injected text is RECONSTRUCTED at analysis time from audit
  `items` (docPath, lines, compression kept/total) against the per-root corpus
  snapshot recorded in each queue row. P3 fidelity gate is therefore mandatory, not
  optional.
- Scheduling: `eval/exp-q/dev.needtoknow.expq-harvest.plist` (launchd, every 6h) —
  install manually: `launchctl load -w ~/Library/LaunchAgents/dev.needtoknow.expq-harvest.plist`
  (copy first). Unattended cadence is the user's system change; not auto-installed.
- Gate to P2 freeze: ≥40 queue rows with audit INJECTED-with-items (Q40), ≥20
  DECLINED controls, ≥8 attachment rows; judge budget re-checked against ≤400 pairs.
