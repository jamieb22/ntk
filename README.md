# NeedToKnow (NTK)

**Automatic, task-aware documentation context for OpenCode.**

NTK indexes your project's documentation and, before each model dispatch, injects the sections relevant to the current task — sourced, selective, bounded. The agent gets the knowledge it needs from your docs without pasting, prompting, or any external retrieval service.

## See it in action

```
You: Why do our ADRs mention "column order" and is there a decision about it?

NeedToKnow — Design Document > 6. Retrieval & scoring (excerpt; 6/13; updated 2026-11-05)
  ### 6. Retrieval & scoring
  Per context-hook dispatch:
  1. full — high score and ≤400 tokens
  ...
```

The agent receives the injected passage as a tagged part on your message, with a `Source:` line (doc path, section, inclusion level, freshness) per excerpt. When the gates decide nothing qualifies, **nothing is injected**.

> *Illustrative example* — the shape above is a real NTK injection; the wording is abbreviated for display. A terminal recording from a real session (e.g. an ADR lookup over a public Apache Archiva corpus) will replace this section in a future release. NTK's audit trail makes every injection reproducible: run `/ntk-debug on` to see the exact decision record for each dispatch (see [Troubleshooting](#troubleshooting--observability)).

## Key features

- **Automatic discovery** — finds project documentation (Markdown/AsciiDoc/txt) on install and keeps the index fresh as files change; no configuration, no include-lists to maintain.
- **Context-aware retrieval** — scores sections against the current request blended with the active task objective and your recently edited source files, so follow-up turns stay on-task.
- **Selective injection** — injects matching sections (max 4, ≤1 per document), not whole files; the full text of a doc is only quoted when it's small and a strong match.
- **Local, lexical, private** — BM25 over a local index; no embeddings, no model calls for retrieval, no network, no external services.
- **Bounded context use** — an adaptive token budget (by default ≤ 800 tokens, scaled to how many documents qualify) with a ceremony cap and verified-empty caching, so NTK never floods the conversation.
- **Automatic reindexing** — edits through the agent reindex instantly; external changes (git pull, manual edits) are caught by a throttled freshness probe; `/ntk-status` shows index age.

## Installation

**Requirements:** OpenCode 2 (plugin API v2), Node ≥ 20. The plugin ships a server part (injection) and a TUI part (status/debug UI).

**From source** (current path — the npm package `opencode-needtoknow` is being prepared; this README's instructions are verified against a source install):

```bash
git clone https://github.com/jamieb/opencode-needtoknow
cd opencode-needtoknow && npm install && npm run build
```

Add the built package to your OpenCode config — in `opencode.json` (project) or `~/.config/opencode/opencode.json` (global):

```jsonc
{
  "plugin": ["/absolute/path/to/opencode-needtoknow"]
}
```

Restart OpenCode. NTK is active immediately on the next prompt: it builds the index on first dispatch, logs `plugin v0.1.0 loaded` to its log file, and adds a `<needtoknow_rules>` block to the system prompt telling the model how to treat injections. Once published to npm, the entry becomes `"plugin": ["opencode-needtoknow"]`.

## What documentation does NTK use?

NTK indexes **documentation, not code** — by extension and by ignore rules, applied at scan time:

- **Included:** `.md`, `.mdx`, `.txt`, `.adoc` files anywhere in the project: architecture decision records, guides, development guidelines, READMEs, `docs/` trees of any shape. Project context files (AGENTS.md, CLAUDE.md) are indexed for search, and NTK dedupes injections against their content at runtime — OpenCode already ships them, so NTK never re-serves the same passages.
- **Excluded:** dependency/build/IDE directories by default (`node_modules`, `dist`, `build`, `out`, `target`, `coverage`, `.venv`, `__pycache__`, `.cache`, `.idea`, `.vscode`, vendor, VCS dirs), standard test-fixture locations (`**/test/resources/**`, `**/tests/**`, `**/fixtures/**`, `**/__tests__/**`), minified JS, dot-basename files, and `.ntk/` itself. Your `.gitignore` (including nested ones) layers on top — anything git-ignored is not indexed.
- **Caps** (per project, to keep indexing cheap): files ≤ 512 KB, ≤ 5,000 files, ≤ 200 sections per document. Oversized/over-cap files are skipped, not truncated.
- The indexed set is listed by `/ntk-status` — the fastest way to see exactly what NTK knows about your repo.

## How retrieval works

For every model request, NTK searches its local index with terms drawn from the current request (plus the standing task objective and recently touched source files), expands the query with term associations mined from your own docs, and scores the candidate sections. A request qualifies when the matches clear a score floor **and** the content gate — the passages must actually cover the user's own terms. Qualifying sections are compressed (top-matching sentences kept, code and tables kept whole), capped in number, and packed under the token budget. If nothing qualifies, NTK injects nothing.

**Under the hood:** classic BM25 via MiniSearch (pinned saturating parameters, field boosts title > headings > terms > body), Porter stemming + stopword filtering, PMI co-occurrence query expansion mined from the corpus, near-duplicate (MMR) filtering, hysteresis so a doc stays in scope across follow-ups, and a state-fingerprint cache (NTK-016) that reuses a selection — including a verified-empty verdict — when nothing that can change it has changed. Full design: [`docs/design.md`](docs/design.md); measured spec: [`docs/SPEC.md`](docs/SPEC.md); the per-threshold experiments: [`docs/EXP-*.md`](docs/).

## Limitations

Be aware of what NTK does **not** do:

- **No guarantee of recall.** Retrieval is lexical: it works best when your request shares vocabulary with the documentation. A relevant section phrased in entirely different terms can be missed. (PMI expansion from your own corpus mitigates this; it doesn't eliminate it.)
- **Occasional false positives.** A passage can pass the gates and still turn out not to be useful. The rules block tells the model to treat injections as reference, not instructions, and to say so when a passage was unhelpful; `/ntk-debug` records every decision with the reason, so you can inspect (and, from the audit files, tune the project) after the fact.
- **Undocumented knowledge is unreachable.** NTK retrieves project documentation; it cannot recover decisions that live only in code, commit history, or people's heads.
- **Injections enter the model context.** Selection happens locally, on your machine. The *selected* passages become part of the prompt sent to whichever model provider you configured in OpenCode. Documentation you wouldn't send to your provider should stay out of indexed paths (`.gitignore` and the exclusion list above apply).
- **Lexical, not semantic:** no embeddings, no rerank by a hosted service. (An optional local TinyBERT reranker exists in the codebase; it is inert unless model files are present, and it runs fully on-device.)

## Troubleshooting & observability

NTK's diagnostics are file-only: reports never enter chat or model context.

- **Verify it's active:** `/ntk-status` (TUI dialog) prints version, project, index size and age, cache stats, and the indexed doc list. If the command is missing, the plugin didn't load — check `"plugin"` in your config, then the log file.
- **See the log:** default `/tmp/ntk-plugin.log`, override with `NTK_LOG=/path`. Every load, index build, dispatch outcome (`injected N sections … tok`, `DECLINED — reason`), and probe is one line per event, prefixed `[project]`.
- **See what was injected:** injected blocks carry `Source:` lines (path#section, level, tokens, `updated` date, `⟪truncated⟫` sentinel). The last full report is written to `.ntk/status.md`.
- **Inspect retrieval decisions:** `/ntk-debug on` enables `.ntk/debug.jsonl` — one JSON audit record per dispatch: cache kind + invalidation cause, the exact blended query, thresholds, ranked candidates with scores, injected items, and every rejection with its reason (`redundant`, `structure-only`, `relative-floor`, `truncated`). `/ntk-debug` shows the last notice; `/ntk-debug off` disables. Records carry section names and numbers only — never doc content.
- **Diagnose missing injections:** run `/ntk-status your query text` — it renders a live retrieval preview (fired yes/no, gate reason, terms, allocation) without touching your session. If the answer is "no": check `/ntk-status`'s doc list (is the file indexed? under an excluded dir? over the caps?), check `.gitignore`, and reindex explicitly with the `ntk_index` tool (`{"force": true}`) after bulk doc changes.
- **Disable / uninstall:** set `NTK_DISABLE=1` (no-op load, for A/B testing), remove the entry from `"plugin"`, and delete `.ntk/` to clear the index, status report, and audit logs. Nothing is written outside `.ntk/`.

## CLI (development)

```bash
npx tsx src/cli.ts index <root> [--force]
npx tsx src/cli.ts query <root> "how do I roll back" --verbose
npx tsx src/cli.ts status <root> --probe "some query"
npx tsx src/cli.ts bench <root> queries.json
```

Environment: `NTK_DISABLE=1` (no-op), `NTK_LOG=/path` (log file), `NTK_MODEL_URL=…` (model fetch for npm publishing). All retrieval thresholds are benchmark-baked defaults, not config.

## License

MIT
