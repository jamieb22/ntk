# NeedToKnow — Design Document

Status: proposed (v0.1) · Implements: `docs/spec.md` (NTK-001..011) · Date: 2026-10-31

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
  index.ts          # Plugin.define + setup(ctx): wiring only (thin adapter)
  config.ts         # thresholds, boosts, budgets, caps, indexVersion
  scanner.ts        # fast-glob walk, gitignore, ext/size limits, exclusions
  parse.ts          # MDAST → sections; front-matter; adoc/txt fallbacks
  tokenize.ts       # processTerm: identifier split → lowercase → stopwords → stem
  index-store.ts    # build/persist/load MiniSearch + section store via ctx.storage
  watcher.ts        # ctx.event("file.edited") + throttled mtime revalidation
  retrieve/
    bm25.ts         # query construction + MiniSearch.search wrapper
    structural.ts   # code-term extraction from conversation (Phase 2)
    select.ts       # score floor, per-doc caps, relevance-only level, token budget
  inject/
    packer.ts       # render <needtoknow-context> system part
    dedupe.ts       # native-instruction + loaded-docs dedupe (NTK-004)
  tracker.ts        # per-session loaded docs + activity (NTK-002/005)
  status.ts         # /ntk-status command + ntk_status tool
test/
  corpus/           # generated 500-doc corpus + labeled task/required-doc set
  *.test.ts         # unit tests per module
  eval/             # recall + precision@k + P95 latency harness
```

Retrieval modules are **independently testable offline** (Phase 1b exposes them as a
CLI: `ntk index <dir>`, `ntk search <query>`, `ntk explain <query>`).

## 4. Runtime wiring

`setup(ctx)` registers four things:

1. `ctx.session.hook("context", ...)` — **the single injection point**. Runs
   immediately before every model dispatch, including tool-driven continuations
   (validated against OpenCode 2 docs; spec §5 gate requires re-validation against
   the installed SDK in spike 1a).
2. `ctx.event.on("file.edited", ...)` — instant doc invalidation + session
   activity stamp.
3. `ctx.command.transform("ntk", ...)` + `ctx.tool.register("ntk_status", ...)` —
   status surfaces (model reads tool output and presents it).
4. Per-workspace **index manager** with a mutex. The context hook never blocks on
   indexing: if the index is cold, it schedules the build, injects nothing this
   dispatch, and injects from the next dispatch onward. Status shows `warming`.

## 5. Indexing pipeline

**Chunk** — headings (ATX/setext via MDAST; regex for adoc) define section boundaries.
Every section is an independent index record.

**Shape** — each section becomes a MiniSearch record with four boosted fields:

```ts
{
  id: "deploy.md#3",   // docId#sectionIdx
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

**Persist** via `ctx.storage` (outside the repo, NTK non-goal):

```
ntk/index/<wsKey>/minisearch.json   # MiniSearch toJSON() (postings, term table, IDF)
ntk/index/<wsKey>/sections.json     # section store: id → {headingPath, text, hashes}
ntk/index/<wsKey>/manifest.json     # file → {mtime, size, hash, docId, sectionIds}
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
select  = max 5 sections, max 2 sections/doc, ≤ ~1200 token budget (chars/4 est.)
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

**Native-instruction dedupe (NTK-004):** read instruction sources from the context
event's system part (`metadata.experimental.instructions`, `{key, text}`); fingerprint
their normalized sentence shingles; drop candidate sections with >0.85 Jaccard
similarity (fallback: content-hash exclusion of AGENTS.md-class files).

**Loaded-docs / dynamic refresh (NTK-002/005):** per session,
`Map<docPath, {contentHash, sectionIds, injectedAtTurn}>`. Re-inject a changed doc if:
(a) the last user message mentions its path/basename/title terms, (b) it was edited
after the session's last user message, (c) >10 turns since injection, (d) it's newly
relevant. All checks are in-memory map lookups; no IO on the hot path.

**Injection format** (system part, tagged `metadata.key: "needtoknow/context"`,
replaced by key every dispatch — idempotent and self-healing across compaction):

```
<needtoknow-context>
Automatically retrieved project documentation. Prefer it over guessing.
<ntk-doc path="docs/deploy.md" section="Deploy > Prerequisites" hash="a1b2c3">
…
</ntk-doc>
</needtoknow-context>
```

## 7. Non-decisions (spec-pinned)

- ❌ Vector DB / embeddings / ANN / semantic similarity — banned by spec non-goals.
- ❌ External search servers (Elastic/Meili/Typesense) — banned by zero-config.
- ❌ SQLite FTS5 — viable but native dep; MiniSearch's pure-JS + JSON serialization fits
  `ctx.storage` better.
- ❌ OpenCode agent tools as the retrieval mechanism (see §1).
- Known limitation, accepted: lexical-only means "sign-in flow" ≠ "authentication"
  unless words overlap. Escalation path if eval fails 95% recall: Phase 2 structural
  signals first; embeddings only as an explicit spec amendment, with the user.

## 8. Phasing

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
2. Status via `command.transform` + registered `ntk_status` tool (spec left mechanics
   to §5 validation; this is the validated mechanism).
3. Third-party libs for gitignore/glob/parse/stem/BM25 (user preference; spec permits
   libraries — it bans services and models, not npm).

## 10. Open items

- Confirm on installed SDK (1a): system-part `metadata.experimental.instructions`
  availability; `ctx.storage` size limits; event payload shapes for file events.
- Decide token-budget number (1200) and max-sections (5) via eval, not in advance.
- Package naming/registry, dev-loading flow (symlink into global plugin dir vs config path).
