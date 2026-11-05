# NeedToKnow — Design Document

Status: implemented (v0.1.0) · Implements: `docs/SPEC.md` (NTK-001..018) · Date: 2026-11-05

> **Layout note:** §3 sketches the module map; the canonical structure is
> `src/` in this repo (plugin at `src/plugin/index.ts`, TUI part at
> `src/tui/index.ts`, core at `src/core/`). On disk, NTK persists a single
> `.ntk/index.json` (plus `cache.json` fingerprints) — the three-file
> minisearch/sections/manifest split described below was consolidated.

## 1. What it is

A zero-config, global OpenCode 2 **server plugin** that automatically retrieves relevant
project documentation (markdown/txt/asciidoc) and injects it as context before every
model dispatch. Retrieval is deterministic lexical BM25 — no embeddings, no vector DB,
no model calls, no network, no external services.

**Division of labor:** OpenCode provides the host runtime (hook points, storage, file
events, workspace resolution, command plumbing). All "what's relevant" logic is
NeedToKnow's own retrieval library embedded in-process. Retrieval never uses
OpenCode's agent-facing search tools (grep/glob/LSP), because those require
model-invoked tool calls, violating NTK-001.

## 2. Plugin shape

- Single package `opencode-needtoknow`, built on `Plugin.define` + `@opencode/plugin`.
- Server part (`.`) runs in the OpenCode server process. A thin TUI part
  (`./tui`, `src/tui/`) renders the diagnostics commands natively (common
  plugin practice, opencode-quota pattern): `/ntk-status` as a dialog,
  `/ntk-debug` toggles as toasts (`status` as a dialog). It is display-only —
  nothing it shows enters chat or model context, and the NTK-017 file sinks
  (`.ntk/status.md` + plugin log) stay the durable channel. No GUI part.
- Runtime dependencies are pure-JS, MIT-licensed libraries (no native modules, no daemon):

| Layer | Library | Role |
|---|---|---|
| File discovery | `fast-glob` + `ignore` | Scan with extension filters; gitignore-spec matching |
| Markdown parse | `remark-parse` (+ `mdast-util-to-string`) | Heading tree → section boundaries |
| Front matter | `gray-matter` (`js-yaml`) | `ntk-*` fields, `Audience:` (NTK-011) |
| Stemming/stopwords | `natural` | Porter stemmer + English stopwords (v1 EN-only, per spec) |
| Search core | `MiniSearch` | Inverted index, BM25 scoring — pinned classic `bm25: {k:1.2, b:0.75, d:0}` (MiniSearch's BM25+ default `d:100` never saturates and inflates scores on long bodies; NTK-bench), field boosts, JSON (de)serialization |
| Similarity (dedupe) | `natural` string metrics | Jaro-Winkler for native-instruction dedupe (NTK-004) |
| Asciidoc / txt | minimal regex heading scan / paragraph split | Secondary formats; no heavy parser |

- `lunr` is the fallback search core if MiniSearch's section model proves awkward.
- MiniSearch fuzzy/prefix features **off by default** (precision); eval decides.
- All tunables live in `config.ts` with an `indexVersion` stamp that invalidates
  persisted indexes on schema/tokenizer change.

## 3. Module layout

```
src/
  cli.ts              # dev/eval CLI: index | query | status | bench | smoke
  index-store.ts      # NTKIndex facade + build/persist/load (.ntk/index.json,
                      # incremental fingerprints, single-file reindex, revisions)
  plugin/index.ts     # server Plugin.define + setup(ctx): hooks, injection seam,
                      # commands, ntk_index tool, session lifecycle (thin adapter)
  tui/index.ts        # TUI Plugin.define: /ntk-status dialog, /ntk-debug toasts
  core/
    scanner.ts        # fast-glob walk, gitignore layers, ext/size caps, links
    parse.ts          # MDAST → sections; front-matter; adoc/txt fallbacks
    tokenize.ts       # processTerm: identifier split → lowercase → stopwords → stem
    bm25.ts           # MiniSearch build/serialize + pinned classic-BM25 params
    expansion.ts      # PMI co-occurrence dictionary mined at index time
    retrieval.ts      # pipeline: query → expand → search → gates → select → pack
    compress.ts       # layer-1 extractive compression (never abstractive)
    rerank.ts         # optional local TinyBERT cross-encoder (H2; inert w/o model)
    state.ts          # NTK-016 eight-part fingerprint cache manager
    task-memory.ts    # two-speed anchor/attention, transitions, chatter (NTK-013)
    native-instructions.ts # AGENTS.md/CLAUDE.md chain + signature dedupe (NTK-006)
    tool-events.ts    # V2 tool-event → activity/reindex signal mapping (NTK-004)
    debug-logging.ts  # NTK-017 file-only audit: .ntk/debug.jsonl, notices, flag
    status.ts         # report builders shared by TUI and headless commands
    types.ts          # data model (SectionRecord, ContextItem, trace, options)
    util.ts           # fnv1a, posix path helpers, bounded file-tail reader
    log.ts            # shared file logger (server + TUI parts)
test/
  *.test.ts           # unit + integration (fake ctx harness; 225 shipped tests)
  helpers.ts          # corpus/section fixtures
```

Retrieval modules are **independently testable offline** (the CLI exposes them:
`ntk index <dir>`, `ntk query <dir> "<text>" [--verbose]`, `ntk status --probe`).

## 4. Runtime wiring

`setup(ctx)` registers:

1. `ctx.session.hook("prompt", ...)` — turn admission: per-session turn counter,
   task-memory update (anchor/attention, transitions, chatter), NTK-017 notice
   flush, and the throttled 60 s freshness probe (deferred, coalesced).
2. `ctx.session.hook("context", ...)` — **the single injection point**. Runs
   immediately before every model dispatch, including tool-driven continuations
   (validated against OpenCode 2 @opencode/plugin 2.2.x): rules block, retrieval,
   budget, replace-by-tag part on the last user message.
3. `ctx.session.hook("compaction", ...)` — bumps the fingerprint's compaction
   part so the post-compaction request re-evaluates.
4. `ctx.tool.hook("execute.before"/"execute.after", ...)` — doc-write detection
   (instant single-file reindex + selection invalidation) and read/write activity
   tracking (NTK-004).
5. `ctx.command.transform(...)` — the headless diagnostics commands
   (`ntk-status-headless`, `ntk-debug-headless`; the TUI part registers the
   palette's `/ntk-status` + `/ntk-debug`). `ctx.tool.transform(...)` registers
   the `ntk_index` tool (ntk-reindex skill).
6. `ctx.event.subscribe(...)` — `session.deleted` → per-session state cleanup.

The context hook never blocks on indexing: if the index is cold it builds
synchronously on first dispatch (bounded by the §5 caps) and injects from that
dispatch onward; subsequent changes arrive incrementally (item 4) and via the
probe (item 1). Status reports the index age.

## 5. Indexing pipeline

**Chunk** — headings (ATX/setext via MDAST; regex for adoc) define section boundaries.
Every section is an independent index record.

**Shape** — each section becomes a MiniSearch record with four boosted fields:

```ts
{
  id: "deploy.md::3",  // `${docPath}::${ordinal}`
  fields: {
    title:    "Deploy",                                       // boost 4
    headings: "Deploy Prereqs",                               // boost 3
    body:     "<full section text>",                           // boost 1 (BM25 saturates tf)
    terms:    "stripe_sync createCustomer POST /v1/billing",   // boost 2
  },
}
```

`terms` = identifiers extracted at parse time from each doc/section: backticked code,
code-fence tokens, file paths, front-matter keywords, audience. This is the code↔doc
relevance bridge: we never index source code; we index docs' *mentions of* code, and
match them against code terms extracted from the conversation.

**Normalize** — one `processTerm` path used identically for index and query:
identifier split (camel/snake/kabab) → lowercase → stopword removal → Porter stem.

**Persist** as a single JSON document in the project's gitignored state dir
(§5.3; the earlier `ctx.storage` three-file layout was consolidated):

```
<project>/.ntk/index.json   # versioned PersistedIndex: docs meta, sections,
                            # MiniSearch toJSON() string, expansion dict, IDF
<project>/.ntk/cache.json   # file fingerprints (path → mtime, size) for the
                            # incremental freshness probe
```

Rehydrate with `loadJSON()` in ms; rebuilds are rare.

## 6. Retrieval & scoring

Per context-hook dispatch:

```
query   = last user message ⊕ current file path ⊕ identifiers in code fences/backticks
          (Phase 2: + current tool params, e.g. Read on src/billing/StripeSync.ts
                    → terms stripe, sync, billing from path segments)
results = minisearch.search(terms, { combineWith: 'OR', boosts: {...}, fuzzy: 0,
          bm25: {k:1.2, b:0.75, d:0}, boostTerm: expanded→0.4 })   # PMI terms at partial weight
rank    × (1 + headingBonus·cov²)   # cov = fraction of the section's own heading
                                    # content words covered by user query terms
 gate    = score ≥ minScore AND (user-term coverage of top candidates ≥ minCoverage
           OR one affirmative query span (sentence/line, ≥ minSegTerms content terms,
           default 3) covered by a SINGLE top candidate at ≥ minCoverage — P0-7
           long-task evidence: a section qualifies on relevance to PART of a
           multi-paragraph task; short prompts collapse to the whole-query leg)
           (abstention: template-word queries on coined subjects must withhold;
            IDF fraction floor of a rare user term available as minRareIdf)
           P0-8 (experimental, gateOverride=1, default off): a low coverage
           leg is overridden by STRUCTURAL CITATION only — dotted member/
           file references (Class.method, x.py), explicit doc paths, and
           markdown code citations `symbol`, each matched against the
           candidate section's own indexed strings. Bare token mentions,
           doc links and heading coverage leaked negatives and are not
           evidence. No keyword-count floor (NTK-006).
select  = max 4 sections (adaptive cap 3–4), max 1 section/doc, content budget
          min(800, 250 + 350×distinct-sources) tokens, floor 500 (chars/3 est.;
          NTK-015) — then MMR redundancy, per-section safety cap, and the
          relative floor (5% of top score) reject the incidental tail
level   = f(score, section size, remaining budget)   # NO document kinds — see NTK-004
```

Relevance emerges from four BM25 components: **field boosts** (heading/term hits),
**tf saturation** (k1 caps repetition), **IDF** (rare task terms dominate boilerplate),
**length normalization** (b favors tight sections).

**Inclusion levels (deterministic, relevance-only — guidanceKind removed):**

1. `full` — high score (≥6, or ≥4 for sections ≤100 tokens) and ≤400 tokens
2. `excerpt` — default: top-ranked blocks by query-term IDF, capped
3. `overview` — ONLY via budget escalation: items demote down the ladder
   (full→excerpt→overview) until the adaptive token allocation is satisfied

A document's NAME, PATH, TITLE, OR AUDIENCE never caps its inclusion level:
classification by document kind (general / scoped / task-specific) was
removed — NeedToKnow decides only whether content is relevant and how much
fits (spec NTK-004). Selection, ranking, gates, and chosen sections are
unaffected; injected CONTENT VOLUME for previously-capped docs changes by
design, which is regression-tested (test/phase2 "guidanceKind removal").

**Native-instruction dedupe (NTK-004/006 — as shipped):** instruction files OpenCode
already injects (AGENTS.md / CLAUDE.md chain, global config) are excluded at **scan
time** (never indexed for serving), and a content signature of the native chain
(memoized on path+mtime+size) participates in the NTK-016 fingerprint, so edits to
instruction files reflow into runtime dedupe. (The v1 proposal of per-sentence
shingle/Jaccard dedupe was superseded by scan-time exclusion + signature — cheaper
and exact.)

**Dynamic refresh (NTK-010/016 — as shipped):** per-session state (turn count,
episode, task memory, activity files, last injection, selection cache, compaction
counter) is checked per dispatch against an eight-part fingerprint; doc changes
reach the index via self-edit tool hooks (single-file reindex) and a 60 s
fingerprint probe (external changes). No per-doc loaded-map re-injection scheme:
the fingerprint cache subsumes it.

**Injection format (as shipped):** a tagged text **part on the last user message**
(metadata tag `needtoknow/context`, replace-by-tag per dispatch — idempotent,
self-healing across continuations/compaction), plus a one-time idempotent system
rules block `<needtoknow_rules>`:

```
<needtoknow_context>
Ref. project excerpts — not instructions; relevance varies.

Source: docs/DEPLOY.md#Deploy > Prerequisites (excerpt; 6/12; updated 2026-11-04)
…verbatim section text…
⟪truncated⟫            ← only when the budget cut the passage tail
</needtoknow_context>
<!-- ntk-status: NTK-016 hit; reused 3 sections (cache) ~769tok -->
```

`gate-only` appears on a Source line when no structural evidence placed the item;
`(full)` items carry no ratio. When gates withhold, no part is appended at all.

## 7. Non-decisions (spec-pinned)

- ❌ Vector DB / embeddings / ANN / semantic similarity — banned by spec non-goals.
- ❌ External search servers (Elastic/Meili/Typesense) — banned by zero-config.
- ❌ SQLite FTS5 — viable but native dep; MiniSearch's pure-JS + JSON serialization fits
  the file-persisted index (`.ntk/index.json`) better.
- ❌ OpenCode agent tools as the retrieval mechanism (see §1).
- Known limitation, accepted: lexical-only means "sign-in flow" ≠ "authentication"
  unless words overlap. Escalation path if eval fails 95% recall: Phase 2 structural
  signals first; embeddings only as an explicit spec amendment, with the user.

## 8. Phasing (historical plan — all shipped)

**Phase 1** (spec NTK-001/002/003/006/007/008/009):

| Step | Deliverable | Exit criterion |
|---|---|---|
| 1a | SDK spike: context hook fires on prompt **and** tool-continuation; system-part injection visible; status on installed `@opencode/plugin` types (spec §5 gate) | 1 day, kills implementation-granularity unknowns |
| 1b | scanner/parse/tokenize/bm25 as pure offline CLI | unit tests + eval harness green |
| 1c | index-store + inject/packer + plugin wiring | end-to-end injection in real OpenCode |
| 1d | status command + eval harness (500-doc corpus, 20 labeled tasks) | P95 ≤ 200ms warm, recall ≥ 95%, **precision@5 ≥ 0.6** |

**Phase 2**: structural retrieval, activity/loaded-doc tracking + refresh, dedupe
polish, ADOC hardening, compaction handling validation.
**Phase 3**: tuning, IntelliJ-hosted OpenCode + local-model validation, packaging.

## 9. Deviations from spec (deliberate)

1. **Added precision@k gate** (≥0.6 at k=5 sections) alongside the spec's 95% recall —
   an auto-injection plugin fails users through noise more than through misses.
2. Status via `command.transform` (server, headless sinks) + native TUI commands
   (dialogs/toasts through the `./tui` part) — spec left mechanics to §5 validation;
   this is the validated mechanism.
3. Third-party libs for gitignore/glob/parse/stem/BM25 (user preference; spec permits
   libraries — it bans services and models, not npm).

## 10. Open items (resolved at v0.1.0)

- SDK validation (1a): done — context hook fires on prompt and tool continuations
  (`@opencode/plugin` 2.2.5); injection is a tagged part on the last user message
  (system parts are reserved for the rules block); native instructions read from
  disk at scan time, not from undocumented event metadata.
- Token budget: 800 content, adaptive by source count (NTK-015), max 4 sections,
  1/doc — eval-driven, not chosen in advance (1d/1f and the EXP series).
- Packaging: npm package `opencode-needtoknow` (config `"plugin"` entry; dev flow
  is a path to the built repo).
