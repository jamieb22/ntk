# NeedToKnow
## Technical Specification — Version 1.3

*The right knowledge, at the right moment.*

Status: Implemented (v0.1.0) — revised from v1.2; aligned with shipped code  
Initial platform: OpenCode 2  
Implementation: TypeScript  
Deployment: OpenCode plugin (npm package / local directory)  
Operating model: Local-first, zero configuration

Where this document states numbers marked *shipped*, they are the implemented
defaults (`src/core/retrieval.ts` `DEFAULTS`, `src/plugin/index.ts`); they are
internal constants, not user configuration (NTK-001).

---

## 1. Overview

NeedToKnow is an automatic, task-aware context retrieval and injection plugin for AI coding agents.

It ensures that agents receive relevant knowledge from their current project without requiring users to manually identify documents, explicitly request file reads, or maintain additional configuration.

NeedToKnow operates on a need-to-know basis: it discovers project knowledge broadly but selectively supplies the information relevant to the agent's current task.

The plugin functions as an external working-memory layer between the project and the AI model.

### Primary objective

Automatically deliver relevant, source-grounded project knowledge into the model's working context throughout a development session.

### Non-objectives

NeedToKnow is not:

- A coding agent.
- A rules enforcement engine.
- A code review tool.
- A replacement for existing project instructions.
- A permanent conversational memory system.
- A document management system.

Its responsibility is context selection and delivery, not guaranteeing that the model obeys every requirement.

---

## 2. Design Principles

1. Zero configuration — Works immediately after installation.
2. Automatic — No explicit commands or agent-initiated retrieval required.
3. Generic — Independent of programming language, project structure, and documentation naming.
4. Local-first — No external AI services, vector databases, or embeddings required.
5. Task-aware — Context changes as the agent's work evolves.
6. Applicability-aware — General guidance is handled differently from task-specific knowledge.
7. Source-faithful — Original document content remains authoritative.
8. Efficient — Context is selected and compressed without unnecessary processing.
9. Transparent — The developer can see exactly what was injected.
10. Nonintrusive — Existing permissions, tools, source code, and project files remain unchanged.
11. Conversation-aware — Relevance reflects the ongoing task, not only the latest prompt.
12. Stable and broad — Avoid context churn and redundant passages while retaining important constraints.
13. Dispatch-consistent — Revalidate context on every applicable model dispatch; never assume past injection persists.
14. Evidence-driven — Select knowledge using retrieval evidence, not fixed vocabularies of task words.

---

## 3. Functional Requirements

### NTK-001 — Zero Configuration

NeedToKnow shall operate immediately after installation.

It must not require:

- Project-specific configuration files.
- Document path mappings.
- Manually maintained indexes.
- Relevance thresholds supplied by users.
- Token-budget configuration.
- Additional model installations.
- Cloud services.
- Changes to `AGENTS.md` or other project instructions.

The plugin shall derive its operating behavior from the workspace, available documentation, agent activity, and model context.

Internal heuristics and limits may be used, but shall not require user configuration.

### NTK-002 — Workspace Discovery

NeedToKnow shall identify the active project workspace through OpenCode.

It shall:

- Discover documents recursively throughout the workspace.
- Recognize documentation regardless of filenames.
- Respect `.gitignore`.
- Avoid dependency, build, generated, and cache directories.
- Respect existing filesystem permissions.
- Follow internal document references.
- Detect newly added, modified, and deleted documents.

Initial supported formats:

- Markdown (`.md`, `.mdx`)
- Plain text (`.txt`)
- AsciiDoc (`.adoc`)

*Shipped:* discovery uses layered ignore rules — a default set covering dependency/build/cache/IDE directories (node_modules, dist, build, out, target, coverage, .venv, __pycache__, .cache, .ntk, .git/.hg/.svn, .idea/.vscode, vendor) plus the repo's own `.gitignore` at every level, and standard test-fixture locations (`tests/`, `test/resources/`, `fixtures/`, `__tests__/`). Files dot-basenamed (e.g. `.hidden.md`), minified JS, larger than 512 KB, and beyond 5,000 files per project are skipped. The plugin state directory (`.ntk/`) is excluded from its own scan.

The plugin must not scan outside the active workspace without authorization.

### NTK-003 — Knowledge Indexing

NeedToKnow shall build a local, incremental index of project documentation.

For each document, record:

- Relative path
- Title
- Section hierarchy
- Original section content
- Keywords and technical identifiers
- References to other documents
- Content hash
- Modification metadata

Documents shall be divided into logical sections, preserving heading hierarchy and surrounding context.

Large sections may be subdivided at paragraph boundaries.

*Shipped:* sections are heading-delimited, keyed `${docPath}::${ordinal}` (capped at 200 sections per document); identifiers are extracted at parse time (max 80, top 24 stored per section as terms); markdown cross-references are recorded per doc. The index is persisted in the project's gitignored state directory (`.ntk/index.json`, versioned; file fingerprints in `.ntk/cache.json`) and reused across sessions. A live in-memory copy is revalidated on a TTL (30 s) and by the change signals of NTK-010.

Changes to documents shall incrementally update the index.

### NTK-004 — Knowledge Relevance

NeedToKnow shall treat ALL indexed documentation as potentially task-relevant
knowledge. It shall not classify documents by kind (general, scoped,
task-specific), apply filename- or path-based treatment rules, or restrict
inclusion depth based on document type.

How much of a selected section is included is determined solely by its
relevance score, the section's structure, and the context budget.

NeedToKnow must avoid duplicating content already supplied through OpenCode's
native instructions system; OpenCode handles native instructions.

### NTK-005 — Lightweight Source-Code Awareness

NeedToKnow shall observe source files accessed or modified during the current agent task and use them as retrieval signals — establishing relationships between implementation areas and project knowledge.

*Shipped:* NTK indexes **no source code content**. The implementation is tool-activity observation: file paths from read/edit/write tool events are tracked per session (bounded, most-recent-first; the top entries feed retrieval), filename stems become mid-weight query terms (recency-weighted, discounted below the primary query), and doc-file writes trigger immediate single-file reindexing. No source metadata index, no AST parsing, no language-server integration, no embeddings.

### NTK-006 — Task-Aware Retrieval

NeedToKnow shall identify relevant knowledge using:

- The current user request and persistent active-task objective.
- Earlier user instructions and clarifications, weighted by recency.
- Mentioned files and technical identifiers.
- Recently inspected and modified source files.
- Explicit documentation references and existing document relationships.
- Narrow signals (paths, symbols, errors) extracted from relevant tool activity.

Retrieval shall combine:

- BM25 full-text ranking.
- Filename and heading matching.
- Keyword matching.
- Exact technical identifier matching.
- Explicit references.
- Lightweight source relationships.
- Relevant cross-document traversal.
- Recency-weighted signal aggregation and stable context selection, as specified in NTK-012 through NTK-015.

The retrieval process shall prioritize:

1. Sections most relevant to the current task (relevance score).
2. Directly applicable specifications, procedures, and decisions.
3. Related documentation necessary for interpretation.
4. Cross-referenced supporting material.

No additional AI model call shall be necessary for retrieval.

The agent must not have to initiate document retrieval itself.

Retrieval eligibility shall not depend on a predefined vocabulary of development verbs, domain nouns, special-case user phrases, or a minimum number of keyword matches. The retrieval process shall evaluate the active task signals available at each applicable model dispatch as described in NTK-016.

One strongly evidenced section shall be eligible for selection. The pipeline shall not require multiple candidates or a dominant winner over the score distribution; several similarly relevant sections may all be applicable. Calibrated section-level relevance and applicability criteria may reject weak or unrelated evidence. BM25 tokenization, stopwords, stemming, exact identifiers and internal scoring heuristics remain permissible.

*Shipped:* eligibility is two gates, not a classifier. (1) An absolute section-level BM25 floor (minScore; classic BM25 pinned `d=0` so scores are bounded and the floor transfers across corpora). (2) A content gate: the selection must cover a minimum fraction (0.8, whole-query union; per-span coverage over ≥3-term sentence/line spans for long tasks; a 2-term span corroborated by the candidate's heading for terse follow-ups) of the user's own content terms, and must carry ≥2 evidence terms counting activity and ordinal citations. Exact title/path citations (`《doc》`, file paths, dotted identifiers, verbatim heading echoes, contiguous heading phrases, linked-document propagation) are structural evidence and bypass the coverage floor. The blend is the persistent objective anchor + current turn, with PMI corpus-mined expansion (top 8 terms, BM25 weight 0.4), heading-coverage rank bonus (quadratic in coverage), doc-mtime recency (14-day half-life, ×0.15 weight), activity terms, and a relative floor (5% of the top score) that rejects the incidental tail of a top-heavy run.

### NTK-007 — Knowledge Relationships

NeedToKnow shall identify relationships between documents and source code, including:

- Markdown links.
- Relative file references.
- References to technical decisions.
- Amendments and superseding documents.
- Shared technical identifiers.
- References found in source-code comments.

Relevant relationships shall be followed automatically. Document scores may propagate across explicit relationships using bounded, discounted spreading activation (NTK-013).

The implementation must prevent circular traversal and unbounded expansion.

*Shipped:* markdown cross-references are extracted at index time (per doc, capped) and consumed as one-hop spreading activation: the top 3 seed documents propagate 35% of the seed score to sections of their linked documents, at most 6 propagated sections per dispatch, sections ≤400 tokens, deduplicated against existing candidates; evidence is recorded per propagation (`target <- seed`) in diagnostics.

Explicit document relationships shall receive stronger retrieval priority than speculative textual associations.

The plugin must not assume that every referenced document is relevant.

### NTK-008 — Adaptive Context Compression

NeedToKnow shall minimize context usage through structural selection rather than lossy summarization.

Three inclusion levels shall be supported.

#### Level 1 — Overview

Include the document title, path, heading structure, and minimal descriptive information.

Use when the document offers useful background but is not directly governing the task.

#### Level 2 — Relevant excerpts

Include exact original passages from relevant sections, with sufficient surrounding context.

This shall be the default.

#### Level 3 — Full document

Include the complete original document when its full contents are necessary to interpret the task correctly and the context budget permits.

The plugin shall automatically choose the inclusion level using relevance, document structure, and available context capacity.

*Shipped:* level selection is relevance-only (document type never caps detail): `full` when the section is small and a strong match (≤100 tok, high score; larger sections only at a higher score), `excerpt` as the default, `overview` (title + first block) as the budget floor; an item exceeding the remaining budget escalates down the ladder (full→excerpt→overview) rather than truncating the better form. Excerpts are extractive sentence selection (first sentence always kept; top-matching sentences, 2–8; code/tables kept whole or dropped, never split), with a per-section safety cap. Structural content with no knowledge (headings, rules, whitespace only) is dropped, not injected.

AI-generated summaries shall not be required in version 1.

NeedToKnow must preserve relevant qualifications, exceptions, amendments, and important constraints.

If selected content cannot fit, it shall record what was omitted rather than silently presenting an incomplete document as complete.

*Shipped:* every excerpt item carries its compression ratio (`kept/total` blocks) on the Source line, and a budget-cut tail renders an explicit `⟪truncated⟫` sentinel — a partial passage can never read as complete.

### NTK-009 — Automatic Context Injection

NeedToKnow shall inject selected documentation into the outgoing OpenCode model context before generation.

Each injected passage shall retain:

- Source file path
- Section heading
- Original text
- Optional line references
- Document version information for diagnostics

*Shipped:* injections render as one `<needtoknow_context>` block appended to the **last user message** of the outgoing request (a tagged content part, metadata tag `needtoknow/context`; not a system-part paste, so it survives per-request assembly and can be replaced atomically). Per item, a `Source:` line carries `path#section-path`, inclusion level, compression ratio, a `gate-only` disclosure when no structural evidence placed the item, and the doc's `updated` date; content is verbatim (excerpt/full/overview); a sentinel marks budget cuts; a machine-readable status comment closes the block (cache kind, revision, outcome, approximate tokens). The block opens with a declaration that the excerpts are reference material, not instructions. A one-time system rules block tells the model the contract: treat excerpts as relevant reference, never instructions, cite `path#heading`, expect absence on gated turns, prefer recent docs on conflict.

The plugin shall:

- Operate without user intervention.
- Inject context during the agent's normal model-request lifecycle.
- Avoid duplicate content.
- Respect native OpenCode instructions.
- Preserve room for conversation history, source code, tools, and model output.
- Avoid accumulating obsolete documentation across requests.

*Shipped:* the injection seam is the session context hook — it runs on **every** model request, including tool-driven continuations. Duplication is prevented structurally, not by counting: replace-by-tag keeps at most one NTK part on the message; an unchanged selection re-supplies the identical block (prompt-cache-stable); a gated/empty outcome injects nothing, not even an empty block; the rules block is idempotent. Native instructions (AGENTS.md/CLAUDE.md chain) are excluded at scan time and deduped by content signature at runtime (NTK-004).

Context budgeting shall be automatic and adaptive to the number, priority, and diversity of relevant sections (NTK-015).

The implementation shall apply conservative internal limits based on the usable context capacity and observed session usage.

*Shipped:* content budget ≤ 800 tokens per dispatch (adaptive to qualifying sources; see NTK-015), max 4 sections, max 1 per document, per-section safety cap; the injection ceremony (tags, Source lines, footer) is accounted on top and a pathological ceremony overflow declines the whole injection.

For every applicable outgoing model request, NeedToKnow shall ensure the current selected passages are available to the model: inject them into that request or verify their presence under an explicit host context contract. Cached selection does not imply cached injection. A prior injection log alone does not establish current model-context presence.

Repeated injection must not accumulate duplicate copies within the same assembled request or retained conversation. Host-specific integration tests shall verify this behavior, including tool continuations and compaction.

*Shipped:* covered by construction — the context hook re-supplies the selection on every dispatch (cache-hit deliveries included), the replace-by-tag rebuild of the last user message removes any prior NTK part on that message, and the compaction event bumps the state fingerprint so the post-compaction request re-evaluates from the surviving conversation.

### NTK-010 — Dynamic Context Refresh

NeedToKnow shall automatically reevaluate relevant knowledge when:

- A new task begins.
- The current task changes materially.
- The agent explores another component.
- New source files become relevant.
- Documentation is updated.
- The session is compacted.
- The active project changes.

Context refresh shall be incremental and event-driven. A new user instruction shall invalidate the retrieval selection or trigger a verified reevaluation, even if its wording resembles an earlier message. Relevant file activity, index revisions, workspace changes, task changes and compaction shall likewise invalidate affected state. Unchanged state may reuse a cached selection, including a cached empty selection, but must still satisfy NTK-009 on each applicable dispatch. See NTK-016.

*Shipped:* the refresh triggers map to concrete events: prompt admission (new turn; task-change detection per NTK-013), tool-completion hooks on doc writes (single-file reindex + selection invalidation), tool reads/edits (activity signal), a throttled periodic probe against filesystem fingerprints (60 s — catches git pulls and edits outside the agent), session compaction (counter bump), workspace switch (per-root state), and native-instruction file edits (signature change).

Each session shall maintain its own task-specific selection state.

Previously injected material shall not remain active indefinitely when it ceases to be relevant. Minor score fluctuations must not repeatedly add and remove the same section (NTK-014).

For a cold index, NeedToKnow shall perform a bounded initial discovery and retrieval attempt before the first model dispatch. If coverage is incomplete, it shall report that limitation; it must not silently treat an empty warm-up result as successful retrieval.

### NTK-011 — Diagnostics

NeedToKnow shall provide a read-only diagnostic interface, for example `/ntk-status`.

*Shipped surfaces:* `/ntk-status` and `/ntk-debug [on|off|status]` in the TUI (native dialog/toast), the same commands with `-headless` suffix as server commands for SDK/Web/Desktop/harness use (file sinks only), the full report written to `.ntk/status.md`, an operational log (`NTK_LOG`, default `/tmp/ntk-plugin.log`), and the per-dispatch audit stream (NTK-017: `.ntk/debug.jsonl`). Diagnostic reports are file-only: they never enter chat, a model prompt, or the model view. The `ntk_index` tool (and the companion `ntk-reindex` skill) exposes manual reindexing (full rebuild, single file).

It shall report:

- Active workspace.
- Number of indexed documents.
- Current task signals, including recency and active-task anchors.
- Selected documents and sections.
- Reasons for selection, including BM25 matches, reference propagation and retention hysteresis.
- Content actually injected.
- Estimated context usage.
- Skipped or omitted content.
- Index freshness.
- Retrieval or injection failures.
- Whether selection was recomputed or reused from cache, including the revision or invalidation reason.
- Evidence supporting inclusion or exclusion, including weak matches, budget omissions and stale-source handling.
- Selection latency and model-dispatch injection outcome, reported separately.

The plugin must distinguish between documents that were discovered, selected, and successfully injected.

It must not claim that the model understood or followed an injected document.

### NTK-012 — Recency-Weighted Conversation Retrieval

NeedToKnow shall treat the available conversation as a sequence of meaningful messages or segments, **not** as a single concatenated search query and not as raw lines.

For each relevant segment, it shall extract and cache a compact set of query signals (terms, identifiers, paths and explicit references). Signals shall be weighted by their importance and conversational distance. The default decay model is exponential:

`weight(age, halfLife) = 2 ^ (-age / halfLife)`

`age` is measured in message turns or equivalent events. Half-lives and relative signal weights are internal heuristics calibrated by tests; users shall not need to configure them.

NeedToKnow shall:

- Favor current user instructions over older conversational material.
- Give file modifications, explicit document references and current source symbols strong evidence weight.
- Use narrow paths/symbols from tool outputs rather than indexing entire build logs or stack traces as conversation queries.
- Exclude NeedToKnow's own injected passages from retrieval signals to prevent feedback loops.
- Normalize per-segment BM25 results before combining scores from queries of different lengths.
- Extract new signals incrementally, caching unchanged segments and query results rather than rescanning the full conversation on every model dispatch.

The plugin shall use the available assembled conversation where the host API exposes it. It shall not claim access to history already discarded by compaction. Short follow-up messages shall use retained active-objective and attention signals rather than being treated as standalone lexical queries.

*Shipped:* the conversation is summarized into retrieval signal, not replayed. The query blends the current user turn with the persistent active-objective anchor (NTK-013) under an episode window (a gap of 10 minutes or 60 minutes elapsed ends the episode); short follow-ups are never standalone queries — the anchor carries them. Exponential recency decay is applied to **document mtime** (14-day half-life), which is the durable freshness signal; conversational distance is handled by the anchor/attention structure rather than per-message weight decay. Hygiene on the input side: NTK's own injected blocks and debug ceremonies are stripped from user text before it becomes any retrieval signal (no feedback loop); a clear question after a large pasted block is isolated as the request, the paste treated as data; generic chatter turns ("ok", "thanks") never displace the anchor.

### NTK-013 — Two-Speed Active Memory and Spreading Activation

NeedToKnow shall maintain two categories of session-specific retrieval signals:

1. **Active objective (slow-decay anchor):** the user's current goal and still-applicable requirements. Preserve until a material task change, rather than allowing debugging chatter to erase it.
2. **Current attention (fast decay):** recent messages, tool activity, source paths, identifiers, and transient investigation details.

Task transitions shall be inferred from explicit user requests and significant changes in affected source scope. Where the transition is ambiguous, retain both plausible objectives temporarily rather than confidently dropping one. This is deterministic, best-effort tracking, not semantic understanding of the conversation.

After initial lexical retrieval, relevant source-grounded document links may propagate discounted relevance to related sections or documents (**spreading activation**):

- Explicit links, amendments and source-code references carry stronger connections than inferred co-occurrences.
- Propagation is bounded by depth, damping and cycle detection.
- Highly connected index pages shall not overwhelm directly applicable documents merely because they have many links.
- A propagated match shall be identifiable as such in diagnostics, with the linking evidence.
- Reference expansion shall not make historical or superseded material automatically authoritative.

The plugin shall not require AI inference or embeddings for either memory track or graph propagation.

*Shipped:* the anchor is the first substantive request of a task; transitions are Jaccard content-word similarity against the anchor — below 0.05 (hard break) switches immediately, 0.05–0.12 is ambiguous (anchor kept, switch commits only if the new topic recurs; the pending candidate is tracked), ≥0.12 continues the task; a 15-minute idle gap starts a new task; the attention channel keeps the last few (≤4) requests with timestamps. All thresholds are benchmarked internals.

### NTK-014 — Stable, Coverage-Aware Selection

NeedToKnow shall select a useful **set** of sections, not simply the highest-scoring repetitive hits.

Selection shall balance:

- Relevance to the active task.
- Coverage of distinct applicable areas (such as general guidance, scoped conventions and task-specific documents).
- Preservation of explicitly governing requirements and amendments.
- Redundancy between sections.
- Available context budget.

A deterministic maximal-marginal-relevance-style strategy may combine normalized relevance with a penalty for near-duplicate content. Coverage must not force unrelated documents into context merely to fill categories. Several sections from the same document must remain eligible when genuinely necessary.

To avoid rapid context churn, use **hysteresis**: a new section must meet an inclusion threshold, while an already selected section may be retained at a lower threshold. Retention shall be overridden when the task clearly changes, the source is stale or unavailable, or a more relevant section requires its budget.

Selection thresholds and redundancy measures shall remain internal, benchmarked defaults. Report which sections were retained due to inertia and which were excluded for redundancy. A relevance threshold may exclude an isolated weak match, but selection shall not require a minimum candidate count or a top-score-to-median ratio.

*Shipped:* inclusion threshold 0.5; hysteresis retention floor 0.3 (60% of inclusion), retention dropped on a clear task change and capped at the selection size; near-duplicate filtering is MMR-style Jaccard over term bags (>0.75 rejects) with a dual bag (heading-trail ∪ body, and body-only, so cross-file boilerplate is caught), minimum bag size 12 for a meaningful comparison; the relative floor (5% of top) rejects the incidental tail, exempting retained items, exact citations, propagated matches, and verbatim-heading-quoted items. `retained`, `excludedRedundant` and `excludedRelative` are reported by id in diagnostics and the audit stream.

### NTK-015 — Adaptive Context Allocation

NeedToKnow shall automatically choose the amount of context to inject according to evidence of relevance, the number of distinct applicable sources, and the model's usable context capacity.

It shall:

- Use small injections for clear, narrow tasks and larger injections for tasks spanning several applicable documents.
- Prioritize original text containing direct requirements, constraints, exceptions, and linked amendments over low-relevance overviews.
- Reserve space for user instructions, existing conversation, tool results, and output.
- Apply conservative internal upper bounds, even when model metadata advertises a large context window.
- Drop low-value or redundant passages before cutting important exact source sections; report any unavoidable omission.
- Recompute the selection for each outgoing request from cached retrieval state, avoiding unnecessary indexing and re-ranking work.

Adaptive allocation means **selecting and packing original text**, not generating a model summary. Packing may be recalculated when usable context capacity changes even if retrieval candidates remain cached.

*Shipped:* the allocation is computed from the count of distinct gate-clearing source documents (`sources`): budget = min(800, 250 + 350 × sources) tokens of content, floor 500; item cap = min(4, max(3, 2 + sources)); a fixed-view caller (the status preview) opts out. Packing fills document slots greedily in rank order; near-duplicates, structure-only content and relative-floor rejects are dropped **before** any qualifying section is cut; the ceremony guard declines when the wrapper alone cannot fit the budget.

Example values for half-life, hysteresis thresholds, graph damping and token limits are implementation parameters to validate against retrieval benchmarks, not requirements for users to configure.


### NTK-016 — Event-Driven Retrieval Evaluation and Cache Consistency

NeedToKnow shall evaluate documentation availability at every applicable OpenCode model dispatch without relying on a separate vocabulary-based firing classifier. Evaluation means verifying retrieval-state freshness and context availability; it does not require repeating BM25 ranking on every dispatch.

The lifecycle shall be:

1. Resolve the current workspace, session, active objective and incremental retrieval signals.
2. Compare a deterministic retrieval-state revision or fingerprint against the cached state.
3. Recompute retrieval and selection only when relevant input has changed, a cached result is stale, or no valid cache exists; otherwise reuse the cached selection, including an empty result.
4. Apply current applicability, source-freshness and context-budget constraints, recalculating packing when needed.
5. Supply the current selection on the outgoing request according to NTK-009; if nothing qualifies, supply nothing.

Relevant state includes, as available through the supported SDK:

- Workspace identity and session identity.
- Current user instructions and revisions to the persistent active objective.
- Relevant conversation segments and recency/attention revisions.
- Recently inspected or modified source paths, identifiers, and associated activity revisions.
- Applicable documentation and relationship-index revisions, including additions, deletions and content changes.
- Context compaction, model/context-capacity changes and changes in native instructions that affect inclusion or deduplication.

Cache fingerprints shall be based on stable normalized inputs or monotonically maintained revisions, rather than classification of message phrasing. Inputs shall be ordered deterministically where order has no meaning. Cache entries shall be isolated by workspace and session and shall not retain stale document text after updates or deletion. Conservative invalidation is preferred to falsely reusing stale context.

*Shipped:* the fingerprint joins eight ordered parts — normalized instruction hash, task-anchor hash, native-instruction signature, episode id, turn counter, knowledge-index revision (the persisted index's file mtime, so cross-process reindexes count), compaction counter, and activity-file list hash. Misses classify their cause by part priority (knowledge > compaction > task > input); explicit invalidations (task change, doc reindex) queue a labeled miss. The cache stores only section ids and the outcome flag (including the verified-empty flag) — never document text. Per-session managers, all dropped on session deletion.

The plugin shall not require task-verb lists, domain-noun dictionaries, meta-question phrase exceptions, a minimum number of candidate sections, or a top-vs-median dominance gate to decide whether retrieval is performed. Ordinary stopword removal, stemming, token normalization, section-level thresholds and query terms derived from actual workspace/conversation evidence remain allowed.

A new user instruction shall cause reevaluation even when a short follow-up adds little lexical information. During tool-driven continuations, changed source activity shall cause reevaluation; unchanged state shall reuse cached selection. Task-transition detection remains best effort under NTK-013 and shall not be represented as semantic certainty.

Diagnostics shall report the state revision, cache hit or miss, invalidation reason, selected sections and actual outgoing injection outcome. If the SDK does not expose enough information to prove presence on a dispatch, diagnostics shall disclose that limitation instead of claiming a verified injection.

No additional model installation, AI inference call, cloud service or project configuration shall be required.

### NTK-017 — File-Only Decision Audit

NeedToKnow shall provide a per-dispatch decision audit that is strictly file-only: audit output shall never enter chat, a model prompt, or the model view.

*Shipped:* enabled by `/ntk-debug on` (`.ntk/debug.json` flag, read live): one JSON record per dispatch to `.ntk/debug.jsonl` (size-rotated) — cache kind + invalidation + revision, the exact blended query, thresholds, ranked candidates with final and base scores and matched terms, injected items with lines/level/tokens/compression, and every rejection by reason; one summary notice line per user turn to the operational log; command reports to `.ntk/status.md`. Records carry section names and numbers only — never document content.

### NTK-018 — Numbered-Heading Matching

NeedToKnow shall treat leading heading numbering ("12. Definition of Done") as a position marker, not title content: verbatim-echo and phrase-citation matching shall compare stripped headings on both sides, so numbered documents (numbered ADRs, books) are matchable by their titles.

---

## 4. Architecture

```text
OpenCode model dispatch
        |
        v
Session task signals + source activity + document index
        |
        v
Retrieval state revision / cache check
        |
        +-- unchanged --> Reuse cached selection --------+
        |                                                |
        +-- changed --> BM25 + relationship expansion     |
                               |                          |
                               v                          |
                     Applicability + coverage            |
                               |                          |
                               v                          |
                      Hysteresis / selection ------------+
                                                          |
                                                          v
                                           Current budget / source checks
                                                          |
                                                          v
                                           Per-dispatch context injection
                                                          |
                                                          v
                                               Model working context
```

### Logical Components

| Component | Responsibility |
|---|---|
| Workspace Resolver | Identify active project |
| Document Scanner | Discover project knowledge |
| Document Indexer | Extract sections and references |
| Source Metadata Indexer | Connect code locations to documentation (shipped: tool-activity observation; no code content indexed) |
| Task Tracker | Maintain slow active-objective and fast-decay attention signals |
| Retrieval State Manager | Track state revisions, invalidate per-session caches and reuse valid selections |
| Relevance Engine | Combine normalized recency-weighted BM25 matches |
| Reference Resolver | Apply bounded activation through explicit document links |
| Coverage Selector | Limit redundancy and cover distinct applicable guidance |
| Stability Manager | Retain useful context through small ranking fluctuations |
| Context Packer | Adapt detail level and token budget to the task |
| OpenCode Adapter | Integrate with model lifecycle and verify per-dispatch injection semantics |
| Diagnostics | Expose retrieval and injection behavior |

These are logical responsibilities, not a requirement to build separate services.

---

## 5. OpenCode 2 Integration

NeedToKnow shall be implemented as a TypeScript plugin using the OpenCode 2 plugin SDK.

It should use supported extension points for:

- Context injection before model requests.
- Observing session activity.
- Observing file-access operations.
- Tracking conversation segments, current-task anchors and task changes.
- Refreshing context following compaction.
- Verifying model-context availability or reinjecting selected passages on each applicable dispatch.

Integration tests must verify the actual conversation and metadata available through the installed SDK; retrieval must degrade gracefully if some historical messages or tool arguments are unavailable. Session-local injected content must not be used as a search input.

The exact interfaces must be validated against the installed OpenCode 2 SDK before implementation.

*Shipped mapping (OpenCode 2 plugin API, `@opencode/plugin` 2.2.x):*

| Need | OpenCode 2 hook |
|---|---|
| Model-request lifecycle (turn admission, task signals) | `session.hook("prompt")` |
| Context injection seam (per-dispatch) | `session.hook("context")` (system rules block + last-user-message part) |
| Compaction awareness | `session.hook("compaction")` |
| File-access observation, self-edit reindex, activity | `tool.hook("execute.before"/"execute.after")` |
| Diagnostics commands | `command.transform` (TUI part registers the palette entries; server part the headless sinks) |
| Manual reindex tool | `tool.transform` (`ntk_index`) |
| Session cleanup | `event.subscribe` (`session.deleted`) |
| TUI rendering (dialogs, toasts) | TUI part `context.keymap.layer` + `context.ui.dialog` |

The plugin shall support OpenCode launched through:

- Terminal
- IntelliJ IDEA integrations
- Other compatible OpenCode clients

Workspace identity must come from the OpenCode server rather than assumptions about the IDE's project directory.

NeedToKnow shall not modify OpenCode's own code or bypass its permissions.

---

## 6. Zero-Configuration Operation

After installation:

1. The plugin identifies the workspace.
2. It discovers and indexes documentation.
3. It observes tool activity on project files (source paths as signals; no code indexing).
4. It maintains a two-speed view of the active task and recent activity.
5. On each model dispatch, it checks whether retrieval-relevant state has changed.
6. When needed, it ranks passages using recency-weighted BM25 and explicit reference relationships; otherwise it reuses a valid cached selection.
7. It selects a stable, diverse set of applicable sections and allocates context adaptively.
8. It supplies original passages to the outgoing request, without duplicating already present material.
9. It invalidates and refreshes affected selections as the task, source activity, documentation or model context changes.

No additional setup is required.

Existing project conventions, including `.gitignore` and agent instruction files, are respected automatically.

The plugin must not create configuration files or modify the repository.

---

## 7. Performance Requirements

NeedToKnow shall:

- Use incremental indexing.
- Avoid full rescanning on every request.
- Reuse indexes across sessions.
- Minimize model-request latency.
- Avoid external inference calls.
- Limit memory and CPU consumption.
- Support repositories with hundreds of documentation files.
- Limit source-code indexing to useful metadata.
- Avoid injecting irrelevant content.
- Update task signals incrementally; do not reparse the entire conversation for every model call.
- Cache normalized retrieval scores and graph relationships where possible.
- Reuse valid per-workspace, per-session selection results, including empty results.
- Make dispatch-time freshness checking inexpensive; distinguish cache-hit overhead from retrieval recomputation latency.
- Invalidate on new user instructions and pertinent task, source, index, context-capacity or compaction events.
- Keep activation depth and candidate sets bounded.

Initial performance objective: cached retrieval and selection within 200 milliseconds for a typical project containing up to 500 documentation files, measured under defined benchmark conditions.

*Shipped (measured, typical corpora):* cache-hit dispatch a few milliseconds, fresh retrieval tens of milliseconds — inside the objective; cold index build takes seconds proportional to corpus size (bounded by the NTK-002/003 caps) and runs once.

Initial index creation may take longer. Measure cache-hit dispatch overhead, cache-miss retrieval latency, and injection overhead separately; report median and tail latency.

This is a performance target rather than a guaranteed runtime.

---

## 8. Security and Privacy

NeedToKnow shall:

- Respect workspace boundaries and existing OpenCode permissions.
- Avoid scanning external directories without permission.
- Avoid indexing credentials and secrets by default.
- Store indexes locally.
- Make no external network requests.
- Keep concurrent projects isolated.
- Treat document contents as untrusted retrieval material.
- Prevent symlink traversal outside authorized locations.
- Avoid modifying project files.

NeedToKnow does not provide a filesystem sandbox or security policy enforcement.

---

## 9. Testing and Acceptance Criteria

### 9.1 Functional Tests

Verify that NeedToKnow:

1. Works immediately after installation.
2. Discovers documentation in arbitrary project structures.
3. Recognizes coding conventions and general project guidance.
4. Selects relevant design decisions and technical specifications.
5. Uses source-code activity to improve document selection.
6. Discovers related documents through explicit references.
7. Injects original source passages.
8. Uses overview, excerpt, and full-document inclusion appropriately.
9. Avoids duplicating native instructions.
10. Refreshes context when tasks or documentation change.
11. Preserves relevant context across compaction.
12. Does not exceed its context budget.
13. Operates without external models or services.
14. Produces accurate diagnostic reports.
15. Uses exponential recency decay without letting short-lived tool output displace the active task objective.
16. Preserves relevant old instructions across a long conversation and correctly reduces their weight after a clear task switch.
17. Retrieves indirectly relevant documentation through explicit references, without runaway propagation through cycles or index pages.
18. Keeps relevant sections stable across minor score changes and replaces them when the task materially changes.
19. Avoids injecting redundant sections while retaining necessary cross-document constraints.
20. Adapts context allocation to narrow and broad tasks without truncating governing text silently.
21. Excludes previously injected NeedToKnow material from future retrieval queries.
22. Does not gate retrieval on hardcoded task-word, domain-noun or special-case phrase dictionaries.
23. Allows a single strongly relevant section, or several similarly relevant sections, without candidate-count or dominance requirements.
24. Reuses valid cached selections (including empty selections), while rechecking on new user instructions and changed source/documentation state.
25. Reinjects or verifies selected content on every applicable model request without accumulating duplicates.
26. Reports cache reuse, invalidation causes and independently verified injection outcomes.

### 9.2 Retrieval Quality

Use a benchmark of development tasks with known relevant documentation.

Measure:

- Required-document recall.
- Section-level recall.
- Retrieval precision.
- Cross-reference coverage.
- Applicable global-guidance coverage.
- Context token consumption.
- Retrieval latency, separated into cache-hit, recomputation and injection overhead.
- Stale-selection rate, cache invalidation correctness and redundant retrieval rate.
- Per-dispatch confirmed injection coverage and duplicate-content rate.
- Required-document recall across multi-turn conversations and task switches.
- Task-anchor retention after extensive debugging output and after compaction.
- Stability/churn rate of selected passages on adjacent turns.
- Coverage diversity and redundant-context rate.
- Reference-propagation contribution and false-positive rate.

Benchmarks shall include single-document tasks, multiple equally applicable documents, no-relevant-document tasks, unfamiliar terminology, short tasks, long conversations, follow-up requests such as "fix that issue", noisy tool logs, abrupt topic changes, referenced amendments, and documents with overlapping content. Compare against a latest-message-only BM25 baseline to establish the benefit of each new mechanism.

Initial quality target: 95% required-document recall on the curated benchmark when sufficient context budget is available.

This is an acceptance target, not a claim of guaranteed retrieval completeness.

### 9.3 Integration Tests

Test:

- OpenCode terminal sessions.
- IntelliJ-hosted sessions.
- Initial user requests.
- Tool-driven model continuations.
- Long-running sessions.
- Context compaction.
- Context hook calls after tool-driven continuations, ensuring active sections are present on each applicable dispatch.
- Cold-index first-dispatch behavior, including partial-coverage diagnostics.
- Documentation updates.
- Concurrent projects.
- Different context-window sizes.
- Local models through llama.cpp.
- Repeated dispatches with unchanged retrieval state, including cached empty selections.
- New user instructions with similar wording and short follow-ups dependent on the active objective.
- Cache invalidation after source activity, document addition/update/deletion and workspace/session changes.
- Confirmed reinjection or host-context preservation on successive dispatches, with no duplicate accumulation.
- A single relevant document and multiple similarly relevant documents without score-gate false negatives.

---

## 10. Out of Scope

Version 1 shall not include:

- Rules or contract enforcement.
- Automated code review.
- Automated test execution.
- Code modification.
- Git operations.
- Vector databases.
- Embeddings.
- Additional AI agents.
- Model-generated summaries.
- Learned embeddings or model-dependent query expansion.
- Project vocabulary learning or inferred synonym graphs (possible later evaluation).
- Cloud services.
- Full semantic source-code indexing.
- Mandatory project metadata or configuration files.
- Guaranteed compliance with natural-language requirements.

---

## 11. Implementation Phases

### Phase 1 — Core Context Retrieval

Implement:

- Plugin registration.
- Workspace discovery.
- Document scanning.
- Section-based indexing.
- BM25 retrieval.
- Initial recency weighting and persistent active-task anchor.
- First-dispatch retrieval and context injection.
- Minimal dispatch-time state checking and per-session cached selection, without vocabulary-based firing.
- Basic diagnostics.

Outcome: Project documentation is automatically selected and inserted based on the current user request.

### Phase 2 — Task and Code Awareness

Implement:

- Guidance applicability classification.
- Lightweight source metadata.
- Source-file activity tracking.
- Cross-reference expansion with bounded spreading activation.
- Two-speed task memory and task-change detection.
- Stable-selection hysteresis.
- Incremental reindexing.
- Revision-based invalidation for conversation, source activity and documentation changes.

Outcome: Context adapts as the agent explores different areas of the project.

### Phase 3 — Adaptive Working Memory

Implement:

- Overview, excerpt, and full-document inclusion.
- Adaptive context allocation.
- Coverage-aware section selection and deduplication.
- Compaction recovery.
- Improved diagnostics, including score explanations.
- Multi-turn retrieval benchmarks and ablation comparisons.
- Cache-hit/miss and injection diagnostics with repeated-dispatch integration tests.

Outcome: Relevant information is supplied efficiently and consistently throughout long development sessions.

---

## 12. Definition of Done

NeedToKnow 1.0 is complete when:

1. It installs globally into a supported OpenCode 2 runtime.
2. It requires no project-specific configuration.
3. It discovers general and task-specific project documentation.
4. It identifies relevant documentation using task and source-code context.
5. It automatically injects original source-grounded passages.
6. It uses recency-weighted retrieval, a persistent active-task anchor and bounded reference propagation.
7. It updates its selections as work evolves without avoidable context churn.
8. It respects model context limitations.
9. It avoids unnecessary duplication and unrelated material.
10. It provides a verifiable record of injected content and its selection rationale.
11. It works with local models and IntelliJ-hosted OpenCode.
12. It operates without modifying project files.
13. It does not interfere with normal OpenCode permissions or coding workflows.
14. It evaluates retrieval-state freshness at each applicable model dispatch without a hardcoded vocabulary firing classifier.
15. It reuses valid per-session selections, invalidates them on meaningful input changes and permits single-document selection.
16. It demonstrably supplies selected context on each applicable dispatch without duplicate accumulation.

## 13. Success Criterion

NeedToKnow succeeds when an AI coding agent consistently receives the project knowledge relevant to its current task, without the developer manually identifying or loading the necessary documents.

The system's performance shall be evaluated through actual retrieval, injection logs, and benchmark results—not through the model's claims that it consulted documentation.

The fundamental principle is:

**Index broadly. Check state on every dispatch. Retrieve when needed. Inject relevant original knowledge.**

