# EXP-N — Conservative semantic fallback (isolated experimental implementation)

**Verdict: REJECT at Stage N2 (stop rule), with NI (independent-root
validation) structurally unmet.** The protocol (§ frozen commit, this
file's first version) required a rule (top-1 similarity ≥ t ∧
separation ≥ g) with DEV specificity ≥95% and sensitivity ≥40% before any
N3 admission path was built. Measured on the newly harvested independent
DEV population: **potion's semantic top-1 was judged relevant on 0 of 14
judged instances (10 irrelevant, 4 topical-only, 0 relevant)**, trigger-A
with-gold top-1 similarity **inverted** below zero-gold (median 0.319 vs
0.381), and every grid cell reached sens 0%. A single-candidate fallback
admits on top-1 — that signal does not exist. §10 condition
"similarity cannot safely distinguish useful from irrelevant" is met;
arms N3–N5 were not built, per the frozen stop rule (no threshold-rescue
loops). Production untouched; branch unmerged; suite 204/2 at baseline.

## 1. Baseline (§2)

- Production commit 552c02d, `src` byte-identical (no EXP-M seam in this
  branch), defaults as recorded in EXP-M §1; H2/B1 bench-only (verified).
- EXP-K artifact integrity incident (honesty note): the adapted labeler
  initially wrote N's labels into the tracked `eval/exp-k/labels.json`
  (merge-append, 65+24 keys) and overwrote the summary; N's labels were
  extracted to `eval/exp-n/`, all three EXP-K files restored to HEAD
  (user-approved), K integrity re-verified (65 turns). Judge caches
  content-hash keyed; no cross-contamination.
- Model2Vec artifact: potion-retrieval-32M rev `6fc8051f`, safetensors
  sha256 `07609e5b…` (copied read-only from EXP-M store), intended static
  inference (load 0.15 s, encode 2,102 sections + 31 queries 0.2 s).

## 2. Population (Stage N0) — independence, strata, and the NI limitation

Harvest (seed 20261104, frozen `harvest-frozen.json`, 0 redaction leaks):
**31 turns / 115 excluded sessions** (union of GR-BENCH 54, EXP-K 61,
deduped 115; L/L2/M re-used K's sessions). Strata: S1 lexical-success 7
(DEV), S2 lexical-abstain-with-candidates 7, S3 identifier 5,
S4 conceptual 5, S5 genuine negatives 7 (spaceinvaders: empty corpora).
DEV = K-roots (archiva3, archiva_frontend, spaceinvaders; new sessions,
new requests); **VALIDATION = 0 gold-bearing turns**: every
project-disjoint root is exhausted — murmur's 2 non-GR sessions have
zero user messages, chatdlp's 10 are all GR-BENCH, TizenBrew/natshell/
lucide have no sessions, remaining free roots (sandbox, pilot-sandbox,
microsoft.connect, demo) are docless (→ S5 negatives). Fresh post-cutoff
history = this program's 2 meta-sessions (excluded). Recorded: NI gate
(≥8 VAL gold turns) **not met** → §3/§11 cap any positive outcome at
INCONCLUSIVE; negatives (S5 + 5 zero-gold docy turns) supported the false
-injection side. Gold: full-corpus deepseek (cap 300/turn, T=0, cached,
consent; est $0.40), 24 labeled docy turns / 79 golds.

## 3. N1 — trigger frequencies (production signals only)

DEV docy 24 turns: **A (abstains): 13 (54%) — of which 8 (62%) have
relevant documentation in the corpus** (the fallback target population is
real); B (fired, no structural override, coverage<0.9): 5; C (span-only
override): 6. Trigger A fires on over half of representative docy traffic
— a fallback at A would activate meaningfully often, which is exactly
why its admission signal must be trustworthy.

## 4. N2 — similarity distributions (the stop)

All sims: potion cosine, project-scoped, 2,102 sections.

| group (DEV) | n | top-1 sim p10 / p50 / p90 |
|---|---|---|
| top-1 judged relevant (L≥2) | **0** | — |
| top-1 judged topical (L=1) | 4 | 0.426 – 0.433 |
| top-1 judged irrelevant (L=0) | 10 | 0.135 – 0.638 |
| trigger-A with gold (target) | 8 | 0.187 / **0.319** / 0.486 |
| trigger-A zero-gold | 5 | 0.135 / **0.381** / 0.448 |

Two findings, both fatal to the design as frozen:
1. **No relevant top-1s.** The fallback injects one candidate (top-1):
   across 24 docy turns, 14 judged top-1 sections include zero L≥2. The
   EXP-M result that motivated this experiment was **gold-in-top-20
   (pool depth)** — not top-1 quality; the conversion to a single-candidate
   injection loses the effect entirely (M: 15/34 turns; here gold-in-
   top-20 on A-gold: 2/8 = 25%, and those 2 golds sit at ranks ≥2).
2. **Inverted calibration.** On the exact population fallback would fire
   (A with gold), top-1 similarity is *lower* than on A without gold
   (0.319 vs 0.381) — the protocol's warning ("do not assume a similarity
   threshold is calibrated across repositories") confirmed: high-sim
   top-1s in this corpus are near-duplicate template sections (memory-bank
   boilerplate scoring 0.54–0.64 → L0/L1), while genuine mismatched
   golds score below the noise floor.

Grid (frozen family, DEV): every (t,g) cell: spec 0% (of judged),
sens 0% (max n=2). No rule meets spec≥95 ∧ sens≥40 → §5 stop.

## 5. N3–N5 — not run (stop rule)

No semantic admission path implemented, no injection arms, no
delivered-content judging (the N5 queue is empty by construction — the
mechanism never reached a state where an injection existed to judge).
The §8 primary trade-off (useful : harmful injections) is undefined:
0 injections. Reporting the discovery-pool gap honestly: gold-in-sem-
top-20 on this fresh population (2/8, 25%, n=8, CI [3%, 62%]) is not
significantly below M's contaminated-population 44% (15/34, CI [27%, 62%])
— the populations are statistically consistent; the *top-1* quality
result is new and kills the single-candidate fallback regardless of
pool-depth truth.

## 6. N6 — resources (measured to the stop point)

Embedding stage (what was built): model 139 MB disk, python-sidecar load
0.15 s, encode 2,133 texts 0.2 s (potion static lookup), vectors 4.1 MB,
cosine-scan ~1.3 ms/31 queries — consistent with M's +1.6 ms p95 /
+25 MB RSS reference. A production integration (resident sidecar,
incremental reindex on section-change ~3 ms, lazy background warm) was
not built, per stop rule; the resource gate (≤30 ms, ≤150 MB, ≤200 MB)
would have passed on these numbers. Costs spent: ≤$0.50 API (24-turn
full-corpus labeling + 20 top-1 adjudications, all raws cached).

## 7. Per-case appendix (A-triggered turns, DEV)

Table at `eval/exp-n/n1n2.json` (24 rows: top1 id/sim/label, gap,
agreement, stability, gold count, gold-in-sem-top20, trigger, gate
reason). Highlights: abstains-with-gold where sem-top20 missed (6/8:
planning-doc tasks — potion top-1s = README boilerplate, L0 at 0.62
sim); the 2 gold-in-top20 turns had top-1 labels L0/L1 (rank-1 occupied
by topical noise). Identifier stratum (S3): 0 A-triggers (lexical
pipeline wins — fallback correctly idle); conceptual stratum: A 3,
all zero top-1 relevance.

## 8. Limitations

- n small (A-gold 8): the top-1 result (0/14) is exact, the pool-depth
  comparison is underpowered by design (history exhausted).
- Cap-300 full-corpus judging: golds outside the cap invisible (M-convention,
  disclosed); 6 top-1 adjudications unresolvable (multi-root id collision
  in the batcher) — all 8 remaining judged top-1s L0/L1; 10 top-1s
  unjudged (label-0 corpus S5 turns, no fire).
- Single model (potion), single seed, one grid family — the stop
  conditions under §5/§10 do not license expansion.
- The 34 (M/DEV) were not re-injected: §10 forbids rescue; their role
  stays diagnostic.

## 9. Answer to the central question

On fresh, independent, honestly-stratified traffic: **no** — a
Model2Vec fallback at the abstention trigger cannot currently deliver
useful documentation without weakening precision, because (a) its top-1
is not a relevance signal in this setting (0/14), (b) its raw scale
anti-correlates with gold presence on the firing population (inverted
calibration), and (c) a fallback restricted to the single top candidate
— the requirement that keeps lexical precision intact — converts M's
pool-depth recovery into zero delivered evidence. A future design must
change the *unit* (multi-candidate with per-candidate adjudication, e.g.
LLM-verified selection — excluded here by §6/§10) and must re-solve
cross-corpus calibration, with untouched validation roots budgeted in
advance. Stopping per directive; no further experiment started;
production unchanged; this branch unmerged.

Reproduction: `bench/n/{harvest,label-harvest,embed.py,n1n2,judge-top1}.mts|py`
in order; API only for cached judging; artifacts `eval/exp-n/`.
