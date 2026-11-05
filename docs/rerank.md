# TinyBERT-L2-MARCO cross-encoder (research: validated, unwired, not shipped)

`src/core/rerank.ts` implements the NTK H2 demotion policy — a local
cross-encoder that re-scores admitted sections (B1 guard: lexically-evidenced
sections are exempt; demotion-only, never promotion). Validated on the frozen
benchmark 2026-11-02: goldHit parity 97.9%, injection gold density
28.7% → 67.1%, adversarial abstention 100.0%, ~13 ms/query warm; aggregate
precision +0.011 with recall unchanged (+0.000) — the lexical pipeline
(including the C2 sibling-phrase promotion, +0.029) is the product.

Because the gain is narrow and it costs a native runtime plus 4.5 MB of
weights, the policy is **not wired** in the shipped plugin, **not included**
in the npm package (the weights are gitignored and excluded from `files`),
and **not referenced at runtime** — `onnxruntime-node` is a devDependency for
type-checking and tests only; installing and running NTK needs no ONNX.

To run the policy offline (research) — the two weights files, gitignored:

| File | What | Size |
|---|---|---|
| `tinybert-l2-marco-int8.onnx` | Quantized TinyBERT-L2 cross-encoder (MS-MARCO finetune), ONNX | ~4.4 MB |
| `vocab.txt` | Matching WordPiece vocabulary | ~230 KB |

Export from the `cross-encoder/ms-marco-MiniLM-L-2-v2` architecture
(INT8-quantized) with your ONNX toolchain of choice, place them in `model/`,
and `test/rerank.test.ts` exercises encoding + policy end to end
(auto-skipped when the files are absent). Wiring the call site into the
context hook (post-admission demotion) is a documented v0.2 candidate.
