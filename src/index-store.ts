/**
 * Index persistence + the in-memory query facade (design.md §4).
 *
 * Everything lives under `<root>/.ntk/` (gitignore target; NTK never modifies
 * project files — spec NTK-006). Serialized format is `PersistedIndex`.
 *
 * Canonical API (used by cli.ts, retrieval.ts, plugin):
 *   indexProjectFull(root)  → NTKIndex (incremental via file fingerprints)
 *   loadIndex(root)         → NTKIndex | null (from disk cache, mtime-keyed)
 */
import fs from "node:fs";
import path from "node:path";
import MiniSearch from "minisearch";
import type {
  DocMeta,
  IndexStats,
  PersistedIndex,
  QueryHit,
  SectionRecord,
} from "./core/types.js";
import { Bm25Index, SEARCH_BASE } from "./core/bm25.js";
import { indexProject, listDocumentFiles, type ScanResult } from "./core/scanner.js";
import { toPosixRel } from "./core/util.js";

const INDEX_VERSION = 3; // v3: sections carry endLine (NTK-011 decision log)

function ntkDir(root: string): string {
  return path.join(root, ".ntk");
}
function indexPath(root: string): string {
  return path.join(ntkDir(root), "index.json");
}
function cachePath(root: string): string {
  return path.join(ntkDir(root), "cache.json");
}

/* ------------------------------------------------------------------ */
/* In-memory index                                                     */
/* ------------------------------------------------------------------ */

export class NTKIndex {
  /** section id → record */
  readonly sections: Map<string, SectionRecord>;
  /** docPath → front matter */
  readonly frontMatter: Map<string, Record<string, unknown>>;
  readonly idf: Record<string, number>;
  readonly expansion: Record<string, [string, number][]>;
  readonly stats: IndexStats;
  readonly builtAt: number;
  readonly docCount: number;

  private ms: MiniSearch;
  /** Lazily materialized list (status/bench). */
  private _sectionList: SectionRecord[] | null = null;

  constructor(
    /** Public for plugin diagnostics (/ntk-status). Read-only. */
    readonly persisted: PersistedIndex,
  ) {
    this.stats = persisted.stats;
    this.builtAt = persisted.builtAt;
    this.docCount = persisted.docs.length;
    this.idf = persisted.idf;
    this.expansion = persisted.expansion;
    this.sections = new Map(persisted.sections.map((s) => [s.id, s]));
    // Only store non-empty front matter; `get()` returns undefined otherwise.
    this.frontMatter = new Map(
      persisted.docs
        .filter((d) => d.frontMatter && Object.keys(d.frontMatter).length > 0)
        .map((d) => [d.path, d.frontMatter]),
    );
    this.ms = MiniSearch.loadJSON(persisted.bm25, {
      fields: ["title", "headings", "terms", "body"],
      storeFields: [],
      // One source of truth for search params (bm25.ts SEARCH_BASE) — a copy
      // here drifting from build silently changes scoring.
      searchOptions: { ...SEARCH_BASE },
    });
  }

  get sectionList(): SectionRecord[] {
    if (!this._sectionList) this._sectionList = [...this.sections.values()];
    return this._sectionList;
  }

  private _docsByPath: Map<string, DocMeta> | null = null;
  /** Document metadata (title, hash, normalized name) for dedupe + display. */
  docMeta(relPath: string): DocMeta | undefined {
    if (!this._docsByPath) {
      this._docsByPath = new Map(this.persisted.docs.map((d) => [d.path, d]));
    }
    return this._docsByPath.get(relPath);
  }

  /** IndexAccessor: all indexed section records. */
  allSections(): SectionRecord[] {
    return this.sectionList;
  }

  /** IndexAccessor: all indexed document records. */
  allDocs(): DocMeta[] {
    return this.persisted.docs;
  }

  private _docGroups: Map<string, SectionRecord[]> | null = null;
  /** IndexAccessor: sections grouped by document path. */
  docsByFile(docPath: string): SectionRecord[] {
    if (!this._docGroups) {
      this._docGroups = new Map();
      for (const s of this.sectionList) {
        const arr = this._docGroups.get(s.docPath);
        if (arr) arr.push(s);
        else this._docGroups.set(s.docPath, [s]);
      }
    }
    return this._docGroups.get(docPath) ?? [];
  }

  /** BM25 candidate search over sections. `expanded`: PMI-expanded terms
   *  scored at `expandedWeight` so expansion aids vocabulary match without
   *  diluting the user's own words (NTK-bench: expanded drift polluted top
   *  hits). Weighted by exact term string, immune to token positions. */
  search(
    terms: string[],
    limit = 30,
    expanded?: ReadonlySet<string>,
    expandedWeight = 1,
    termWeight?: (term: string) => number,
  ): QueryHit[] {
    if (terms.length === 0) return [];
    const hits = this.ms.search(terms.join(" "), {
      ...SEARCH_BASE,
      boostTerm: (term: string) =>
        (expanded?.has(term) ? expandedWeight : 1) * (termWeight ? termWeight(term) : 1),
    });
    const out: QueryHit[] = [];
    for (const h of hits.slice(0, limit)) {
      const sec = this.decodeId(h.id as string);
      if (!sec) continue;
      out.push({
        id: sec.id,
        score: h.score,
        terms: h.terms ? [...h.terms] : undefined,
        docPath: sec.docPath,
        heading: sec.heading,
      });
    }
    return out;
  }

  /** Section ids are `${docPath}::${ordinal}` (parse.ts) and MiniSearch ids
   *  equal section ids (bm25.ts), so the map lookup always resolves. */
  private decodeId(id: string): SectionRecord | undefined {
    return this.sections.get(id);
  }
}



/* ------------------------------------------------------------------ */
/* Building & caching                                                  */
/* ------------------------------------------------------------------ */

interface Fingerprints {
  /** path → [mtimeMs, size] */
  files: Record<string, [number, number]>;
}

function fingerprintsFromScan(scan: ScanResult): Fingerprints {
  const files: Record<string, [number, number]> = {};
  for (const f of scan.files) files[f.path] = [f.mtimeMs, f.size];
  return { files };
}

/** Cheap freshness probe: returns true when the cached index matches disk. */
function cachedIsFresh(root: string, cache: Fingerprints): boolean {
  // Fingerprints alone can't see brand-new files, so first compare the current
  // document set against the set the index was built from.
  const current = listDocumentFiles(root);
  if (current.length !== Object.keys(cache.files).length) return false;
  for (const rel of current) {
    const fp = cache.files[rel];
    if (!fp) return false; // new file
    const st = safeStat(path.join(root, rel));
    if (!st) return false; // deleted
    // ANY mtime delta counts: a restore (git checkout of an older commit,
    // backup copy-back) sets an OLDER mtime at the same size — a one-sided
    // `>` test judged that fresh and served stale content forever.
    if (Math.abs(st.mtimeMs - fp[0]) > 1 || st.size !== fp[1]) return false;
  }
  return true;
}

function safeStat(p: string): fs.Stats | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

interface BuildOptions {
  /** Skip the freshness probe and rebuild from scratch. */
  force?: boolean;
}

/**
 * Full (incremental-aware) indexing. If every file fingerprint matches the
 * cached index, the cached index is reused; otherwise the project is
 * rescanned, reindexed, and persisted.
 */
export function indexProjectFull(root: string, opts: BuildOptions = {}): NTKIndex {
  const idxPath = indexPath(root);
  const cPath = cachePath(root);
  if (!opts.force) {
    const cached = tryLoadPersisted(idxPath);
    const fps = tryReadJson<Fingerprints>(cPath);
    if (cached && fps && cachedIsFresh(root, fps)) {
      return new NTKIndex(cached);
    }
  }
  const scan = indexProject(root);
  const persisted = buildPersisted(root, scan);
  persist(root, persisted, fingerprintsFromScan(scan));
  return new NTKIndex(persisted);
}

/**
 * Load the persisted index (no rescan). Returns null when absent/corrupt.
 * Instances are cached per root while the index file mtime is unchanged.
 */
const loadCache = new Map<string, { mtimeMs: number; size: number; index: NTKIndex }>();

export function loadIndex(root: string): NTKIndex | null {
  const idxPath = indexPath(root);
  const st = safeStat(idxPath);
  if (!st) {
    loadCache.delete(idxPath);
    return null;
  }
  const prev = loadCache.get(idxPath);
  if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) return prev.index;
  const persisted = tryLoadPersisted(idxPath);
  if (!persisted) {
    loadCache.delete(idxPath);
    return null;
  }
  const idx = new NTKIndex(persisted);
  loadCache.set(idxPath, { mtimeMs: st.mtimeMs, size: st.size, index: idx });
  return idx;
}

/** Self-edit shortcut (design.md §7): reindex one file's sections in place. */
export function reindexFile(root: string, relPath: string): boolean {
  // Canonicalize once: callers hand us OS-native relative paths (Windows
  // "\") and raw model args, the index keys are posix (scanner normalizes).
  const rel = toPosixRel(root, relPath);
  const idxPath = indexPath(root);
  const persisted = tryLoadPersisted(idxPath);
  if (!persisted) return false;
  const abs = path.join(root, rel);
  const st = safeStat(abs);
  if (!st) {
    // DELETED on disk (audit A5): drop its sections/meta and rebuild — the
    // former early `return false` made deletions a silent no-op.
    const present = persisted.sections.some((s) => s.docPath === rel);
    const inDocs = persisted.docs.some((d) => d.path === rel);
    if (!present && !inDocs) return true; // was not indexed: nothing to do
    persisted.sections = persisted.sections.filter((s) => s.docPath !== rel);
    persisted.docs = persisted.docs.filter((d) => d.path !== rel);
    rebuildIndex(persisted);
    const fps = tryReadJson<Fingerprints>(cachePath(root));
    if (fps) delete fps.files[rel];
    persist(root, persisted, fps ?? { files: {} });
    loadCache.delete(idxPath);
    return true;
  }

  // Re-parse the single document through the scanner's per-file pipeline.
  const scan = indexProject(root, { onlyFiles: [rel] });
  // Drop this file's sections first (both branches), then append the fresh
  // ones — a file that is no longer indexable (removed/oversized) keeps none.
  persisted.sections = persisted.sections.filter((s) => s.docPath !== rel);
  persisted.sections.push(...scan.sections);
  persisted.docs = persisted.docs.filter((d) => d.path !== rel);
  const meta = scan.docMetas?.find((d: DocMeta) => d.path === rel);
  if (meta) persisted.docs.push(meta);
  rebuildIndex(persisted);
  persist(root, persisted, fingerprintsFromScan(scan), abs);
  loadCache.delete(idxPath);
  return true;
}

/* ------------------------------------------------------------------ */
/* Serialization helpers                                               */
/* ------------------------------------------------------------------ */

function buildPersisted(root: string, scan: ScanResult): PersistedIndex {
  const sections = scan.sections;
  const bm25 = Bm25Index.build(sections);
  const stats: IndexStats = {
    indexedFiles: scan.indexedFiles ?? scan.files.length,
    sections: sections.length,
    skipped: scan.skipped ?? 0,
    files: scan.files.length,
    indexMs: scan.indexMs ?? 0,
  };
  return {
    version: INDEX_VERSION,
    root: path.resolve(root),
    builtAt: Date.now(),
    stats,
    docs: scan.docMetas ?? [],
    sections,
    bm25: bm25.toJSON(),
    expansion: scan.expansion ?? {},
    idf: bm25.idfSnapshot(sections),
  };
}

function rebuildIndex(persisted: PersistedIndex): void {
  const bm25 = Bm25Index.build(persisted.sections);
  persisted.bm25 = bm25.toJSON();
  persisted.idf = bm25.idfSnapshot(persisted.sections);
  persisted.stats = {
    ...persisted.stats,
    sections: persisted.sections.length,
  };
}

/** Revision of the root's persisted index: the mtime of .ntk/index.json
 *  (0 before the first build). File-keyed, not a process-local counter, so
 *  a reindex from ANOTHER process — the `ntk` CLI, a concurrent session —
 *  changes the NTK-016 fingerprint part `k` too, and a mid-session cache hit
 *  can never re-serve a selection computed against a superseded index. */
export function indexRevision(root: string): number {
  return Math.round(safeStat(indexPath(root))?.mtimeMs ?? 0);
}

function persist(root: string, persisted: PersistedIndex, fps: Fingerprints, singleFile?: string): void {
  fs.mkdirSync(ntkDir(root), { recursive: true });
  writeJsonAtomic(indexPath(root), persisted);
  if (singleFile) {
    // Merge into existing fingerprints for partial updates.
    const existing = tryReadJson<Fingerprints>(cachePath(root)) ?? fps;
    const st = safeStat(singleFile);
    if (st) existing.files[toPosixRel(root, singleFile)] = [st.mtimeMs, st.size];
    writeJsonAtomic(cachePath(root), existing);
  } else {
    writeJsonAtomic(cachePath(root), fps);
  }
}

let tmpSeq = 0;

function writeJsonAtomic(p: string, v: unknown): void {
  // Unique tmp name: the server plugin, the CLI, and concurrent tool hooks
  // may write the same file; a shared ".tmp" name interleaves them and the
  // loser's rename fails (or worse, publishes a torn merge).
  const tmp = `${p}.${process.pid}.${(tmpSeq = (tmpSeq + 1) % 1024).toString(36)}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(v));
    fs.renameSync(tmp, p);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* cleanup is best-effort */
    }
    throw e;
  }
}

function tryLoadPersisted(p: string): PersistedIndex | null {
  const json = tryReadJson<PersistedIndex>(p);
  if (!json || json.version !== INDEX_VERSION || !Array.isArray(json.sections) || typeof json.bm25 !== "string") {
    return null;
  }
  return json;
}

function tryReadJson<T>(p: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as T;
  } catch {
    return null;
  }
}
