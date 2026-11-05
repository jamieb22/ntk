/**
 * Retrieval state manager — the per-dispatch state-fingerprint cache
 * (SPEC §5.9 / NTK-016).
 *
 * Every dispatch we compute a small fingerprint of everything that can
 * change the retrieval result: the user instruction (normalized — content,
 * not display formatting: NTK-010), the task anchor, the native-instruction
 * signature, the knowledge-index revision, the compaction sequence and the
 * turn counter. If the fingerprint is unchanged since the last stored
 * selection, the cached selection (including a verified-EMPTY one) is reused
 * without recomputation; if it changed, the cache is invalidated with a
 * machine-readable cause, the selection is recomputed and re-stored.
 *
 * The manager keeps NO document text — only section ids and outcome flags,
 * so the cache is cheap to keep in-process and safe to surface in status.
 */
import type { InvalidationReason, StateCheckKind } from "./types.js";
import { fnv1a } from "./util.js";

/** Everything the fingerprint is computed from (SPEC §5.9). */
export interface StateInput {
  /** Latest user instruction (raw; normalized before hashing). */
  userText: string;
  /** Turn counter: a new instruction must invalidate even with identical
   *  wording (NTK-010) — it is a new request, not the same one. */
  turnCount: number;
  /** Current task anchor fingerprint (task-memory signals), "" if none. */
  taskFingerprint: string;
  /** Native-instruction signature (hash of AGENTS.md/system prompt set). */
  nativeSignature: string;
  /** Episode id (new conversation episode = new task). */
  episodeId: string;
  /** Knowledge-index revision: any reindex changes it (NTK-010). */
  indexRevision: number;
  /** Compaction sequence: context-window compaction drops injected blocks. */
  compactionSeq: number;
  /** Source-file activity signal (NTK-004): the ordered activity file list
   *  (recency first). Activity feeds retrieval (activity terms enter as
   *  mid-tier candidates), so opening a new component MUST change the
   *  fingerprint — otherwise the cache reuses a selection computed against
   *  stale activity (audit P0-4). Optional: absent = no activity signal. */
  activityFingerprint?: string;
}

/** A stored selection outcome: the ids, and how it was decided. */
export interface CachedSelection {
  /** Injected section ids ("doc#S1"); [] with empty=true on a withheld run. */
  itemIds: string[];
  /** True when the run was gated/empty — a verified-empty state (NTK-016). */
  empty: boolean;
}

/** Result of a per-dispatch check. */
export interface StateCheck {
  kind: StateCheckKind;
  /** Cache generation (bumped on every store and every invalidation). */
  revision: number;
  /** Cause of a forced miss; absent on the first dispatch and plain hits. */
  invalidation?: InvalidationReason;
  /** The reusable selection on a hit. */
  cached?: CachedSelection;
}

/** Cache-health counters for the model-facing status line (NTK-011). */
export interface StateStats {
  hits: number;
  misses: number;
  /** Total checks (hits + misses). */
  checks: number;
  /** Current cache generation. */
  revision: number;
  /** hits / checks, 0 before the first check. */
  hitRate: number;
  /** The currently cached selection, if any. */
  cached: CachedSelection | null;
}

function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Ordered fingerprint parts. Keyed so invalidation can classify the cause. */
const FP_KEYS = ["u", "t", "m", "e", "a", "k", "c", "x"] as const;

function fingerprintParts(s: StateInput): Record<string, string> {
  return {
    // Instruction content: hashed after normalization, so display-only
    // formatting (whitespace runs, case, trailing newlines) never changes it.
    u: fnv1a(normalizeText(s.userText)),
    // Task anchor (raw hash from task-memory), episode, native-signature set:
    t: fnv1a(s.taskFingerprint || ""),
    m: s.nativeSignature || "",
    e: s.episodeId || "",
    // Instruction stream position (a new turn is a new request — NTK-010):
    a: String(s.turnCount),
    // Knowledge base revision: reindexing invalidates (NTK-010):
    k: String(s.indexRevision),
    // Context-window compaction drops injected blocks:
    c: String(s.compactionSeq),
    // Source-file activity (NTK-004): new reads/edits shift candidates.
    x: fnv1a(s.activityFingerprint || ""),
  };
}

/** Join parts into the comparison key — the ONE builder both store() and
 *  check() use, so a part added to fingerprintParts can never enter the
 *  stored fingerprint while the check key silently omits it. */
function joinFp(parts: Record<string, string>): string {
  return FP_KEYS.map((key) => `${key}:${parts[key]}`).join("|");
}

/** Stable string fingerprint of everything that can change the selection. */
export function computeStateFingerprint(s: StateInput): string {
  return joinFp(fingerprintParts(s));
}

/** Which part changed, and therefore why we invalidated.
 *  Priority: knowledge > compaction > task > input. (The turn counter changes
 *  on EVERY dispatch, so checking it first would mask all other causes —
 *  audit A5 surfaced this ordering flaw.) */
function classify(parts: Record<string, string>, prev: Record<string, string>): InvalidationReason {
  if (parts.k !== prev.k) return "knowledge";
  if (parts.c !== prev.c) return "compaction";
  if (parts.x !== prev.x) return "input"; // activity shift rides the input signal
  if (parts.t !== prev.t || parts.m !== prev.m || parts.e !== prev.e) return "task";
  return "input"; // u/a changed (new instruction stream position)
}

export class RetrievalStateManager {
  private cached: CachedSelection | null = null;
  private fp: string | null = null;
  private parts: Record<string, string> | null = null;
  private rev = 0;
  private hits = 0;
  private misses = 0;
  private checks = 0;
  private pending: InvalidationReason | null = null;

  /** Per-dispatch check: reuse the selection iff the fingerprint is unchanged. */
  check(input: StateInput): StateCheck {
    this.checks++;
    const parts = fingerprintParts(input);
    const fp = joinFp(parts);

    if (this.pending) {
      const reason = this.pending;
      this.pending = null;
      this.cached = null;
      this.fp = null;
      this.parts = null;
      this.rev++;
      this.misses++;
      return { kind: "miss", revision: this.rev, invalidation: reason };
    }
    if (this.cached && this.fp === fp) {
      this.hits++;
      return { kind: "hit", revision: this.rev, cached: this.cached };
    }
    const invalidation =
      this.cached && this.parts ? classify(parts, this.parts) : undefined;
    if (invalidation) this.rev++;
    this.cached = null;
    this.fp = fp;
    this.parts = parts;
    this.misses++;
    return { kind: "miss", revision: this.rev, invalidation };
  }

  /** Store the outcome of a fresh computation for this exact state. */
  store(input: StateInput, sel: { itemIds: string[]; empty: boolean }): void {
    this.cached = { ...sel };
    this.fp = computeStateFingerprint(input);
    this.parts = fingerprintParts(input);
    this.pending = null;
    this.rev++;
  }

  /** Force-invalidate (task change, explicit user command, removal hook). */
  invalidate(reason: InvalidationReason): void {
    this.pending = reason;
  }

  /** Drop everything (new conversation). */
  reset(): void {
    this.cached = null;
    this.fp = null;
    this.parts = null;
    this.pending = null;
  }

  stats(): StateStats {
    return {
      hits: this.hits,
      misses: this.misses,
      checks: this.checks,
      revision: this.rev,
      hitRate: this.checks > 0 ? this.hits / this.checks : 0,
      cached: this.cached,
    };
  }
}
