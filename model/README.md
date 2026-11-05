# TinyBERT-L2-MARCO cross-encoder (optional rerank model)

The NTK H2 demotion policy (see `docs/design.md`) can re-score admitted
sections with a small cross-encoder. The model is **optional**: retrieval is
fully lexical when these files are absent (`src/core/rerank.ts` degrades
silently), and the 4.5 MB binary is shipped only in the npm package, not in
the git repo (`.gitignore` excludes `model/*`).

Place the two files in this directory:

| File | What | Size |
|---|---|---|
| `tinybert-l2-marco-int8.onnx` | Quantized TinyBERT-L2 cross-encoder (MS-MARCO finetune), ONNX | ~4.4 MB |
| `vocab.txt` | Matching WordPiece vocabulary | ~230 KB |

Export from the reference checkpoint (`cross-encoder/ms-marco-MiniLM-L-2-v2`
architecture, INT8-quantized) with your preferred ONNX export toolchain, then
restart OpenCode — NTK picks the model up on the next dispatch.

`npm run fetch-model` (CI/publish only) downloads the canonical export from
the project releases; set `NTK_MODEL_URL` to point at a mirror.
