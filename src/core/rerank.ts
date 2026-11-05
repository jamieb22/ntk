/** TinyBERT-L2 cross-encoder demotion + rerank (validated H2 policy).
 *
 * Production role: BM25 ranking and the lexical admission gates are unchanged.
 * AFTER admission, admitted sections are scored by the cross-encoder; sections
 * below THRESHOLD are dropped, survivors are ordered by model relevance, and
 * maxItems/token budgets are re-applied. B1 demotion guard: sections lexically
 * evidenced by the current user query (≥2 user terms incl. one rare) are
 * exempt from demotion — never promoted (see lexicallyEvidenced). If the
 * model, the runtime, or inference is unavailable for ANY reason, the original
 * lexical order and set pass through untouched (fallback) — the plugin must
 * never disrupt OpenCode.
 *
 * Validated (frozen NTK-bench, 2026-11-02): goldHit parity 97.9%,
 * gold density 28.7% → 67.1%, adversarial abstention 100%, ~13 ms/query warm.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RERANK_THRESHOLD = 0.05; // validated demotion floor (dev-calibrated)
const MAX_PAIR_LEN = 112;            // tokens per pair (truncation budget)
const MAX_CACHE = 2000;

export interface RerankItem {
  docPath: string;
  sectionPath: string;
  tokens: number;
}
export interface RerankTrace {
  mode: "applied" | "fallback" | "cache";
  threshold: number;
  scored: number;
  dropped: string[];
  ms: number;
  reason?: string;
  /** B1: admitted items shielded from demotion by lexical evidence. */
  protectedCount?: number;
  /** Experiment A observability: final-kept B1 probabilities (applied/cache). */
  keptScores?: number[];
}
export interface RerankResult<T extends RerankItem> {
  items: T[];
  trace: RerankTrace;
}

/* ----------------------------------------------------------- tokenizer -- */
let vocab: Map<string, number> | null = null;
function loadVocab(modelDir: string): Map<string, number> {
  if (vocab) return vocab;
  const v = new Map<string, number>();
  readFileSync(path.join(modelDir, "vocab.txt"), "utf8")
    .split("\n")
    .forEach((line, i) => {
      const w = line.trim();
      if (w) v.set(w, i);
    });
  vocab = v;
  return v;
}
const CJK = /[㐀-䶿一-鿿豈-﫿]/;
const PUNCT = /[!-/:-@[-`{-~\u2013\u2014]/;
function basicTokens(text: string): string[] {
  let t = text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  t = t.replace(CJK, (c) => ` ${c} `);
  t = t.replace(PUNCT, (c) => ` ${c} `);
  return t.split(/\s+/).filter(Boolean);
}
function wordpiece(tok: string, v: Map<string, number>): string[] {
  if (tok.length > 100) tok = tok.slice(0, 100);
  const out: string[] = [];
  let s = 0;
  while (s < tok.length) {
    let e = tok.length;
    let found = -1;
    while (s < e) {
      const piece = (s > 0 ? "##" : "") + tok.slice(s, e);
      if (v.has(piece)) { found = e - s; out.push(piece); break; }
      e--;
    }
    if (found < 0) return ["[UNK]"];
    s += found;
  }
  return out;
}
function ids(text: string, v: Map<string, number>, max: number): number[] {
  const out = [101];
  for (const w of basicTokens(text).slice(0, 300)) {
    for (const p of wordpiece(w, v)) {
      if (out.length >= max - 1) break;
      out.push(v.get(p) ?? v.get("[UNK]") ?? 100);
    }
    if (out.length >= max - 1) break;
  }
  out.push(102);
  return out;
}
/** Official pair encoding: [CLS] q [SEP] t [SEP] with segment ids 0/1.
 *  Validated against the model card (Berlin pairs +7.21 / −11.56, INT8). */
export function encodePair(q: string, t: string, v: Map<string, number>, maxLen = MAX_PAIR_LEN): [number[], number[]] {
  const a = ids(q, v, 48);
  const b = ids(t, v, maxLen).slice(1); // drop [CLS]
  const idsOut = [...a, ...b, 102];
  const seg = [...a.map(() => 0), ...b.map(() => 1), 1];
  return [idsOut, seg];
}
export function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/* ------------------------------------------------------- session cache -- */
type OutT = { data: Float32Array; dims: number[] };
type Session = { run(feeds: Record<string, unknown>): Promise<unknown>; Tensor: unknown };
let sessionPromise: Promise<Session> | null = null;
async function getSession(modelDir: string): Promise<Session> {
  if (sessionPromise) return sessionPromise;
  const model = path.join(modelDir, "tinybert-l2-marco-int8.onnx");
  if (!existsSync(model)) throw new Error(`model not found: ${model}`);
  const ort = await import("onnxruntime-node");
  const s = (await ort.InferenceSession.create(model, {
    graphOptimizationLevel: "all",
    intraOpNumThreads: 2,
    interOpNumThreads: 1,
  })) as unknown as Session;
  (s as unknown as { Tensor: unknown }).Tensor = ort.Tensor;
  sessionPromise = Promise.resolve(s);
  return sessionPromise;
}

/* -------------------------------------------------- inference result cache -- */
const scoreCache = new Map<string, number>();
function cacheGet(key: string): number | undefined {
  const v = scoreCache.get(key);
  if (v !== undefined) { scoreCache.delete(key); scoreCache.set(key, v); } // LRU bump
  return v;
}
function cachePut(key: string, v: number): void {
  if (scoreCache.size >= MAX_CACHE) scoreCache.delete(scoreCache.keys().next().value as string);
  scoreCache.set(key, v);
}

/* ------------------------------------------------------ B1 demotion guard -- */
/**
 * TinyBERT-L2 systematically rejects NEGATED design statements ("no embedding
 * vector store") even when the answer sentence is fully visible (measured
 * 2026-11-02: logit ≈ −10 with the answer supplied directly; frozen-set
 * adversarial recall −9 pts vs lexical concentrated in confusable sections).
 * Demotion must not override strong lexical anchoring on the ORIGINAL CURRENT
 * user query: at least TWO matched user terms (the A5 content-gate evidence
 * floor) AND at least one at IDF fraction ≥ 0.5 of the corpus's max attainable
 * IDF (the content gate's own rare-term metric — a single high-IDF hit, e.g. a
 * stray acronym overlap, is NOT protected). Both signals are the ones the
 * retrieval gate already uses; expansion and task-anchor terms are excluded by
 * construction (the plugin supplies current-turn user terms only).
 * Exemption is from DEMOTION ONLY — ordering, perDocMax and budgets are
 * untouched, so a protected item never rises above a model-preferred survivor.
 */
export function lexicallyEvidenced(
  matchedTerms: readonly string[],
  userTerms: ReadonlySet<string>,
  idf: Record<string, number>,
  sectionsTotal: number,
): boolean {
  const maxIdf = Math.log(1 + (sectionsTotal + 1) / 1.5);
  const mu = matchedTerms.filter((t) => userTerms.has(t));
  return mu.length >= 2 && mu.some((t) => (idf[t] ?? 0) / maxIdf >= 0.5);
}

/* ------------------------------------------------------ pure post-rank -- */
/** Filter admitted items by score, order by score (ties keep lexical order),
 *  re-apply maxItems/token budget AFTER reranking (perDocMax already holds).
 *  protectedFlags[i] === true exempts item i from the demotion floor only. */
export function applyRerank<T extends RerankItem>(
  items: T[],
  scores: number[],
  threshold = RERANK_THRESHOLD,
  maxItems = 4,
  tokenBudget = 800,
  protectedFlags?: boolean[],
): { kept: T[]; dropped: string[]; keptP: number[] } {
  const isProt = (i: number): boolean => protectedFlags?.[i] === true;
  const tagged = items.map((it, i) => ({ it, p: scores[i] ?? 1, i }));
  const dropped = tagged.filter((t) => t.p < threshold && !isProt(t.i)).map((t) => `${t.it.docPath}#${t.it.sectionPath.slice(0, 40)}`);
  const kept = tagged
    .filter((t) => t.p >= threshold || isProt(t.i))
    .sort((a, b) => b.p - a.p || a.i - b.i);
  const keptP = kept.map((t) => t.p);
  const keptItems = kept.map((t) => t.it);
  const out: T[] = [];
  const docs = new Set<string>();
  let tok = 0;
  for (const it of keptItems) {
    if (out.length >= maxItems) break;
    if (docs.has(it.docPath)) continue;
    if (out.length && tok + it.tokens > tokenBudget) continue;
    out.push(it);
    docs.add(it.docPath);
    tok += it.tokens;
  }
  for (const it of keptItems) if (!out.includes(it)) dropped.push(`${it.docPath}#${it.sectionPath.slice(0, 40)}(budget)`);
  // keptP is reported for the FINAL kept set (Experiment A observability).
  const finalP = out.map((it) => keptP[keptItems.indexOf(it)] ?? 1);
  return { kept: out, dropped, keptP: finalP };
}

/* ------------------------------------------------------------- driver -- */
export interface RerankDeps {
  modelDir: string;
  query: string;
  items: RerankItem[] & { docMtime?: number }[];
  textOf: (item: RerankItem) => string;
  hash: (s: string) => string;
  maxItems?: number;
  tokenBudget?: number;
  /** B1: item-level demotion exemption (see lexicallyEvidenced). */
  isProtected?: (item: RerankItem) => boolean;
}
export async function rerankAdmitted<T extends RerankItem>(deps: RerankDeps & { items: T[] }): Promise<RerankResult<T>> {
  const { items, query, modelDir, textOf, hash } = deps;
  const t0 = Date.now();
  const fail = (reason: string): RerankResult<T> => ({ items, trace: { mode: "fallback", threshold: RERANK_THRESHOLD, scored: 0, dropped: [], ms: Date.now() - t0, reason } });
  if (!items.length) return { items, trace: { mode: "applied", threshold: RERANK_THRESHOLD, scored: 0, dropped: [], ms: 0, keptScores: [] } };
  try {
    const v = loadVocab(modelDir);
    const scores: number[] = [];
    const todo: { i: number; text: string; key: string }[] = [];
    items.forEach((it, i) => {
      const key = hash(`${query}\u0000${it.docPath}\u0000${it.sectionPath}\u0000${(it as { docMtime?: number }).docMtime ?? ""}`);
      const c = cacheGet(key);
      if (c !== undefined) scores[i] = c;
      else todo.push({ i, text: textOf(it), key });
    });
    if (todo.length) {
      const session = await getSession(modelDir);
      const evs = todo.map((t) => encodePair(query, t.text.slice(0, 1200), v));
      const L = Math.max(...evs.map((e) => e[0].length));
      const n = evs.length;
      const inputIds = new BigInt64Array(n * L);
      const att = new BigInt64Array(n * L);
      const seg = new BigInt64Array(n * L);
      evs.forEach(([idsOut, segIds], r) => {
        for (let c = 0; c < L; c++) {
          inputIds[r * L + c] = BigInt(idsOut[c] ?? 0);
          att[r * L + c] = BigInt(idsOut[c] ? 1 : 0);
          seg[r * L + c] = BigInt(segIds[c] ?? 0);
        }
      });
      const T = (session as unknown as { Tensor: new (t: string, d: unknown, dims: number[]) => unknown }).Tensor;
      const mk = (data: BigInt64Array) => new T("int64", data, [n, L]);
      const feeds: Record<string, unknown> = {
        input_ids: mk(inputIds),
        attention_mask: mk(att),
        token_type_ids: mk(seg),
      };
      const res = (await session.run(feeds)) as unknown;
      const out = (Array.isArray(res) ? res[0] : Object.values(res as Record<string, OutT>)[0]) as OutT | undefined;
      if (!out?.data) throw new Error("empty inference output");
      const rowLen = Number(out.dims[1] ?? 1) || 1;
      for (let r = 0; r < n; r++) {
        const td = todo[r]!;
        const p = sigmoid(Number(out.data[r * rowLen]) || 0);
        scores[td.i] = p;
        cachePut(td.key, p);
      }
    }
    const flags = deps.isProtected ? items.map((it) => deps.isProtected!(it)) : undefined;
    const protectedCount = flags ? flags.filter(Boolean).length : 0;
    const { kept, dropped, keptP } = applyRerank(items, scores, RERANK_THRESHOLD, deps.maxItems, deps.tokenBudget, flags);
    if (kept.length === 0 && items.length > 0) {
      // All-demoted safety net: never let H2 silently blank an admitted
      // injection (measured inert on dev+val: zero positives fully demoted).
      return { items, trace: { mode: todo.length === 0 ? ("cache" as const) : ("applied" as const), threshold: RERANK_THRESHOLD, scored: items.length, dropped: [], ms: Date.now() - t0, protectedCount, reason: "all-demoted → lexical kept", keptScores: [] } };
    }
    const mode = todo.length === 0 ? "cache" : "applied";
    return { items: kept, trace: { mode, threshold: RERANK_THRESHOLD, scored: items.length, dropped, ms: Date.now() - t0, protectedCount, keptScores: keptP } };
  } catch (e) {
    return fail(String((e as Error)?.message ?? e).slice(0, 160));
  }
}

/** Default model directory: <package root>/model (works from src/ and dist/). */
export function defaultModelDir(): string {
  return fileURLToPath(new URL("../../model/", import.meta.url));
}
