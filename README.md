# NeedToKnow (NTK)

**Automatic, task-aware documentation context for [OpenCode](https://opencode.ai) — zero configuration, fully local.**

NTK indexes your project's documentation (Markdown, AsciiDoc, txt), and before **every model dispatch** it retrieves the sections relevant to the current task and injects them as sourced excerpts. The model gets the knowledge it needs without you pasting docs, and without any embedding model, vector database, or network call.

```
user turn ─→ query terms ─→ PMI expansion ─→ BM25 search ─→ gates ─→ selection ─→ compression ─→ budget ─→ inject
```

## Install

```bash
npm i -D opencode-needtoknow
```

Add to `opencode.json` (project) or `~/.config/opencode/opencode.json` (global):

```jsonc
{ "plugin": ["opencode-needtoknow"] }
```

Restart OpenCode. That's it — the index builds itself on first dispatch and lives at `.ntk/index.json` (add `.ntk/` to your `.gitignore`).

## What you get

- **`<needtoknow_context>` injections** — sourced (`path#heading`, inclusion level, `updated` date, `⟪truncated⟫` sentinel when a budget cut trimmed content), delivered as a tagged part on the user message; replace-by-tag keeps exactly one block per message.
- **Retrieval gates** — an absolute BM25 score floor plus a content-coverage gate: queries with no qualifying documentation inject **nothing** (no noise, no ceremony).
- **Per-dispatch evaluation** — a state-fingerprint cache reuses the selection when nothing that can change it has changed (instruction, task anchor, index revision, compaction, activity), including verified-empty verdicts.
- **Task memory** — a two-speed model keeps the governing objective in scope through follow-ups, and bounded one-hop spreading activation follows doc cross-references.
- **Native-instruction awareness** — AGENTS.md/CLAUDE.md content OpenCode already ships is deduped out of injections.
- **Self-edit reindexing** — doc edits through the agent's own tools are reindexed on completion; a 60 s freshness probe catches external changes (git pull, manual edits).

## Commands & tools

| Surface | TUI (dialog/toast) | Headless (file sinks; SDK, Web/Desktop, `opencode run`) |
|---|---|---|
| Diagnostics | `/ntk-status` | `ntk-status-headless` |
| Debug audit | `/ntk-debug [on\|off\|status]` | `ntk-debug-headless` |

- **`/ntk-status`** — index size/freshness, cache hit rate, retrieval preview for your argument, session stats. Full report: `.ntk/status.md`.
- **`/ntk-debug on`** — per-dispatch decision audit to `.ntk/debug.jsonl`: cache kind + invalidation cause, blended query, ranked candidates with scores, injected/rejected sections with reasons. File-only: reports never ride a model prompt.
- **`ntk_index` tool** — manual reindex (`{ "path": "docs/x.md" }` for one file, `{ "force": true }` for a full rebuild). A ready-made agent skill ships at [`skill/ntk-reindex/SKILL.md`](skill/ntk-reindex/SKILL.md) — copy it into `.opencode/skill/` and ask your agent to "reindex the docs" after bulk doc changes.

## Guarantees

- **Local only.** Lexical BM25 (MiniSearch, pinned classic params) + Porter stemming. No embeddings, no model calls, no network. The optional rerank model is a local ONNX file, inert until present.
- **Read-only on your files.** NTK never modifies project files; its state lives entirely under `.ntk/`.
- **Source code is never context.** Only `.md` / `.mdx` / `.txt` / `.adoc` files are indexed; source paths appear only as a retrieval *signal* (recent activity).
- **Bounded footprint.** Per-dispatch token budget with adaptive allocation across sources; max 4 sections, ≤1 per document; ceremony accounted and capped.
- **Never instructions.** Injected blocks are labeled reference material; the system rules block tells the model to treat them as such.

## CLI (development / evaluation)

```bash
npx tsx src/cli.ts index <root> [--force]
npx tsx src/cli.ts query <root> "how do I roll back" --verbose
npx tsx src/cli.ts status <root> --probe "some query"
npx tsx src/cli.ts bench <root> queries.json
```

Environment levers (all optional): `NTK_DISABLE=1` (no-op load, for A/B harnesses), `NTK_LOG=/path/to/log` (plugin log sink, default `/tmp/ntk-plugin.log`).

## How it works

The design and the measured spec live in [`docs/`](docs/):

- [`docs/SPEC.md`](docs/SPEC.md) — the requirements (NTK-001…018) with acceptance rules.
- [`docs/design.md`](docs/design.md) — architecture, pipeline, and the experiment trail.
- [`docs/EXP-*.md`](docs/) — experiment reports behind every tuned threshold (each dial is benchmark-baked, not hand-set).

## Disable

Remove the entry from `plugin` in your config. NTK leaves no runtime hooks; delete `.ntk/` to drop its state.

## License

MIT
