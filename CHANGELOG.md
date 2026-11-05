# Changelog

All notable changes to NeedToKnow are documented here.

## v0.1.0 — 2026-11-05

First public release.

- Zero-config per-dispatch documentation retrieval: BM25 (classic, pinned params) + PMI corpus expansion + content gates, with verified-empty caching (state fingerprint per dispatch).
- Injection surfaces: TUI dialog commands (`/ntk-status`, `/ntk-debug`) + headless file-sink commands (`ntk-status-headless`, `ntk-debug-headless`) for SDK/Web/Desktop; `ntk_index` tool + `ntk-reindex` skill.
- Two-speed task memory, activity signals, bounded one-hop spreading activation, sibling-phrase promotion, adaptive multi-source budget.
- Audit trail (NTK-017): `.ntk/debug.jsonl` per-dispatch decision records, `.ntk/status.md` reports, one notice line per user turn.
- Full source audit pass: code-block duplication, URI decode doc-drop, Windows path normalization, fingerprint key-list divergence, negation-leak in gates, and ~30 dead-code items removed; shared `util`/`log` modules consolidate duplicated primitives.
