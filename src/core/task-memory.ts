/** Two-speed task memory (SPEC §5.8, NTK-011).
 *
 * Slow channel — the active objective: the user request that opened the
 * current task. It persists (decays slowly) so debugging chatter and short
 * follow-ups never erase the goal that governs retrieval.
 *
 * Fast channel — the attention span: the last few turns, decaying quickly.
 *
 * A task transition is inferred from a clear topical break between the
 * latest request and the anchor (Jaccard content-word similarity below
 * threshold) or from a long inactivity gap. Ambiguous turns keep both
 * objectives (the anchor is retained for one extra turn before switching).
 *
 * Deterministic, lexical best-effort tracking — no conversation parsing
 * beyond surface text, per the spec.
 */
import { contentWords, identifiers } from "./tokenize.js";

export const DEFAULT_TRANSITION_SIM = 0.12; // Jaccard below this = new task
/** Below this the break is hard (switch immediately). In [HARD_BREAK_SIM,
 *  transitionSim) the transition is ambiguous: the previous objective is
 *  preserved, and the switch commits only when the new topic recurs (audit
 *  P1-7: legitimate follow-ups phrased with different terminology must not
 *  wipe the anchor at a single low-overlap turn). */
export const HARD_BREAK_SIM = 0.05;
export const DEFAULT_GAP_MS = 15 * 60 * 1000; // idle longer than this = new task

export interface TaskMemory {
  /** Slow channel: the active objective (first substantive turn of the task). */
  objective: string;
  objectiveAt: number;
  /** Fast channel: recent user requests, newest first (bounded). */
  attention: string[];
  attentionAt: number[];
  /** Pending objective switch from an ambiguous turn (kept one extra turn). */
  pending: string | null;
}

const MAX_ATTENTION = 4;

export function newTaskMemory(): TaskMemory {
  return { objective: "", objectiveAt: 0, attention: [], attentionAt: [], pending: null };
}

function jaccard(a: string, b: string): number {
  const sa = new Set(contentWords(a));
  const sb = new Set(contentWords(b));
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const w of sb) if (sa.has(w)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/** Generic low-signal words: a turn made of these never displaces the anchor. */
const CHATTER_WORDS = new Set([
  "ok", "okay", "thanks", "thank", "yes", "no", "nice", "good", "great",
  "lgtm", "wow", "oh", "em", "continue", "go", "keep", "going", "now",
  "then", "again", "still", "there", "here", "that", "this", "it", "its",
  "issue", "problem", "error", "bug", "thing", "things", "above", "below",
  "help", "question", "lol", "ty", "yep", "nope", "cool", "awesome",
  "perfect", "sure", "alright", "cache",
]);

/**
 * Fraction of a turn's content words that are generic chatter
 * (acknowledgements, references, debugging noise). 0 = fully specific.
 */
export function chatterScore(text: string): number {
  const words = contentWords(text);
  if (!words.length) return 1;
  const generic = words.filter((w) => CHATTER_WORDS.has(w) || w.length <= 2).length;
  return generic / words.length;
}

/**
 * True when the turn is too short/generic to count as a task statement.
 * Audit P1-7: a fixed ≤3-content-word floor discarded substantive short
 * objectives ("Refactor auth middleware" = 3 words). Now: only ≤2 content
 * words is automatically chatter; a technical identifier (path, snake_case,
 * dotted name) is user-supplied evidence and never chatter; otherwise the
 * genericity ratio must be high (≥0.5) to discard.
 */
export function isChatter(text: string): boolean {
  const words = contentWords(text);
  if (words.length <= 2) return true;
  if (identifiers(text).length > 0) return false;
  return chatterScore(text) >= 0.5;
}

export interface TaskUpdate {
  memory: TaskMemory;
  /** True when the objective changed this turn (clear transition). */
  changed: boolean;
  /** True when a transition is suspected and being watched one more turn. */
  ambiguous: boolean;
  similarity: number;
}

/** Fold one user request into the task memory. */
export function updateTask(
  mem: TaskMemory,
  request: string,
  now = Date.now(),
  opts: { transitionSim?: number; gapMs?: number; hardBreakSim?: number } = {},
): TaskUpdate {
  const sim = jaccard(mem.objective, request);
  const gap = now - (mem.attentionAt[0] ?? mem.objectiveAt ?? 0);
  const text = request.trim();
  if (!text) return { memory: mem, changed: false, ambiguous: false, similarity: sim };

  const transitionSim = opts.transitionSim ?? DEFAULT_TRANSITION_SIM;
  const hardBreak = opts.hardBreakSim ?? HARD_BREAK_SIM;
  const gapMs = opts.gapMs ?? DEFAULT_GAP_MS;
  const push = (m: TaskMemory): TaskMemory => {
    // Dedupe by text and MIRROR the removal in attentionAt, so the parallel
    // arrays keep index correspondence (a per-entry decay read needs it).
    const at = [...m.attentionAt];
    for (let i = m.attention.length - 1; i >= 0; i--) {
      if (m.attention[i] === text) {
        at.splice(i, 1);
        break;
      }
    }
    m.attention = [text, ...m.attention.filter((t) => t !== text)].slice(0, MAX_ATTENTION);
    m.attentionAt = [now, ...at].slice(0, MAX_ATTENTION);
    return m;
  };
  const adopt = (): TaskUpdate => ({
    memory: push({ ...mem, objective: text, objectiveAt: now, pending: null }),
    changed: true,
    ambiguous: false,
    similarity: sim,
  });

  // No objective yet, idle gap, or a HARD topical break: switch. (A merely
  // low similarity is handled by the ambiguous path below — an "ambiguous"
  // state inside this branch is unsatisfiable: gap>gapMs/hard-break/new-task
  // are exactly the complement of its guard.)
  if (!mem.objective || gap > gapMs || sim < hardBreak) {
    return adopt();
  }
  if (sim < transitionSim) {
    // Low overlap on an active task. The switch commits when the pending
    // new topic recurs; otherwise keep the anchor and re-mark pending.
    if (mem.pending && jaccard(mem.pending, text) >= transitionSim) return adopt();
    return { memory: push({ ...mem, pending: text }), changed: false, ambiguous: true, similarity: sim };
  }
  // Same task: refresh the fast channel only (slow anchor persists).
  const m = push({ ...mem });
  if (m.pending) {
    // The ambiguous follow-up recurred twice: commit the switch.
    if (jaccard(m.pending, text) >= transitionSim) return adopt();
    m.pending = null;
  }
  return { memory: m, changed: false, ambiguous: false, similarity: sim };
}

/** Retrieval query text: the anchor plus the fast channel, newest first. */
export function taskSignals(mem: TaskMemory): string {
  return [mem.objective, ...mem.attention.filter((t) => t !== mem.objective)]
    .filter(Boolean)
    .join("\n");
}
