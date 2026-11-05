# EXP-R — Live-audit defect fixes (D1–D13)

**Verdict: ACCEPT (7 atomic commits, e066e55..a7efe5c).** The Exp-O/Exp-P live
audit harvest (Q40, rev 552c02d) surfaced defects D1–D13; 11 received code
fixes (D4/D11 are absent from the landed commit set). Every published validation gate reproduces the
baseline: unit parity 224/226 (the same 2 pre-existing reds), adversarial
control byte-identical baseline↔fixed (ADV FAILURES IDENTICAL), and the K34
GR-BENCH replay holds published quality — so the fixes are hygiene, not
behavior change, on the validated path.

## 1. Defects and fixes

| Defect | Specimen | Fix (commit) |
|---|---|---|
| D1/D2 | compression honesty: `kept` counted pre-truncation (README 0/1 at 496 tok); list blocks cut mid-line | `c48c4cd` — kept = budget SURVIVORS; truncate at line boundaries; atomic drops counted |
| D3 | 4× identical "Acceptance" boilerplate survived MMR | `768be12` — MMR bag is body-only, catches cross-file boilerplate |
| D5/D6 | generic structural evidence declined by relative floor (af 10:33 query-builder) | `768be12` — current-turn heading-phrase quote exempts the floor (family: exact-title/echo/ordinal) |
| D7 | NTK-012 self-injection: quoted pastes fed the retrieval loop | `2d7aa92` — strip injected-context blocks before query/anchor/task-memory; cache-path audit records latencyMs (D12) |
| D8 | index scope polluted by test fixtures (archiva3: 654 docs / 4,547 sections) | `d54b521` — scanner excludes `src/test/resources`, `fixtures`, `__tests__`; treatment layers stay doc-blind (NTK-004) |
| D9 | tokenizer matched `'t` fragments | `e066e55` — contraction normalization (`don't` → `dont`), single-letter fragments dropped |
| D10 | per-dispatch full re-read of instruction files (cache dispatch p95 154 ms at archiva3 scale) | `5b640c9` — signature memoized on (path, mtime, size); stat-only fast path → **0.06 ms/call measured** |
| D12/D13 | audit persistence caps truncated ctx (Q40 A-replay fidelity 33%); REUSED rows had null latency; localReport log-fallback fragile | `a7efe5c` — caps 8000/3000, latencyMs on REUSED/verified-empty rows, file-first localReport |

## 2. Validation (all re-verified on a7efe5c)

- **Unit:** 224/226 — parity with baseline, same 2 pre-existing reds.
- **ADV control:** per-category cells byte-identical baseline↔fixed (A 1.0,
  B 1.0/.25, C .125, F 1.0/.25); 15 recorded failures unchanged.
- **D8 scope:** archiva3 force-rebuild 654→**148 docs**, 4,547→**1,561
  sections** (−65%), build 3.8 s.
- **K34 GR-BENCH replay (fixed code, 271 runs):** goldHitRate **0.99** (baseline
  published 0.990), abstain 76/76 (1.0), meanItems 2.48, meanTokens 644,
  medianTokens 727 (budget discipline). Firing rate 0.794→0.720: the drop is
  fixture junk eliminated from the pool — negatives all gated, gold coverage
  unchanged, i.e. precision gain by design (D8).
- **Judge leg:** the env-runs `meanRelevance: 0` (150 judged, runsWithNeeded 0)
  was a runner-side join/parse failure — empty content responses — not a
  quality signal; the polluted judge-cache was restored from git. The published
  baseline (meanScore 1.09, prec@10 0.324) stands as the comparison.

## 3. Q40 re-replay (EXP-Q, rev bdb65a1)

p345 re-run on fixed code: **byte-identical** (fidelity 33.1%, A-RSDR 83.3%,
B 16.7%, CI [−100, 60], controls 0/20). Mechanism: the frozen manifest's B arm
replays materialized v3 passages with ctx truncated at the *old* caps, so
D3/D5/D12 act on future harvests, not on this snapshot; zero new judge prompts
(all P4 cache hits, no spend). Q1 gate NOT MET — diagnostic only, as frozen.
The next Q40 freeze, harvested on rev ≥ a7efe5c with full-ctx audits, is the
first clean fidelity test.

## 4. Cost

P1 labeling ≈ $0.04 (deepseek, T=0); P4 judging $0 (cache); bench:judge 150/150
cache hits; ADV/bench local. LLM budget remaining ≈ $0.21 of $0.25.

## 5. Provenance note

The Exp-O continuation session exhausted the provider context window
(486,300 > 485,882 tok) and its compaction request overflowed identically, so
the session is unrecoverable; this report was written by a successor session
from the captured session log, and every number above was re-verified against
the repo and the Q40 re-replay re-executed on 2026-11-04.
