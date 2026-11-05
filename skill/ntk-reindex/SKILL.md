---
name: ntk-reindex
description: Rebuild the NeedToKnow documentation index after bulk doc changes (git pull, rewrites, new docs/ trees). Use when the user asks to reindex docs, refresh the NTK index, or when injected doc excerpts look stale.
---

# ntk-reindex

NeedToKnow (NTK) indexes project documentation and injects relevant sections
into model context. Normal edits auto-reindex; use this skill after bulk
changes.

Steps:

1. Call the `ntk_index` tool.
   - Whole project: `{}` (full rebuild).
   - One file: `{ "path": "docs/relative/path.md" }`.
   - The full rebuild ignores incremental fingerprints (equivalent to force).
2. Report the tool's summary line (files, sections, duration) to the user.
3. If the tool is unavailable (plugin not loaded), tell the user NTK is not
   active for this project; do not attempt manual index edits — the index is
   generated (`​.ntk/index.json` is machine-owned).
