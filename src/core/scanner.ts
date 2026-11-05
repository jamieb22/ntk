/** Document discovery + indexing pipeline (design.md §4).
 *
 * Walks the repo with fast-glob, applies layered .gitignore rules (repo root,
 * subdirectories, and a default set covering common build/dependency dirs),
 * enforces size/count caps, and feeds each file through parseDocument to
 * produce section records. `indexProject` is the canonical entry point;
 * index-store.ts consumes its ScanResult contract.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import fg from "fast-glob";
import ignore, { type Ignore } from "ignore";
import { parseDocument } from "./parse.js";
import { buildExpansionDict, type ExpansionDict } from "./expansion.js";
import { toPosix } from "./util.js";

import type { DiscoveredFile, DocMeta, SectionRecord } from "./types.js";

/** Indexable extensions (spec NTK-001) + a few adjacent text formats. */
const DOC_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".adoc"]);

const MAX_FILE_BYTES = 512 * 1024; // 512 KB
const MAX_FILES = 5_000;
/** Max sections contributed by a single document (keeps huge docs in check). */
const MAX_SECTIONS_PER_DOC = 200;

const DEFAULT_IGNORES = [
  "node_modules",
  // Zero-config defaults (NTK-001): scratch areas and fixture corpora are
  // test data, not workspace knowledge. .gitignore layering still applies.
  ".scratch",
  "testproject",
  // EXP-R D8: standard test-fixture locations are index scope, not
  // workspace knowledge (NTK-001 hygiene; treatment layers stay doc-blind
  // per NTK-004 — exclusion happens at scan time only).
  "**/test/resources/**",
  "**/tests/**",
  "**/fixtures/**",
  "**/__tests__/**",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  ".ntk",
  "vendor",
  ".idea",
  ".vscode",
  "*.min.js",
  "*.min.css",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "LICENSE",
];

interface IgnoreManager {
  /** Relative dir ("" for root) → compiled ignore filter. */
  filters: Map<string, Ignore>;
}

function loadIgnores(root: string): IgnoreManager {
  const filters = new Map<string, Ignore>();
  const add = (dir: string, file: string) => {
    let filt = filters.get(dir);
    if (!filt) {
      filt = ignore().add(DEFAULT_IGNORES.join("\n"));
      filters.set(dir, filt);
    }
    try {
      filt.add(fs.readFileSync(path.join(root, dir, file), "utf8"));
    } catch {
      /* missing/unreadable ignore file is fine */
    }
  };
  add("", ".gitignore");
  // Subdirectory .gitignore files (bounded depth).
  try {
    const subs = fg.sync("**/.gitignore", {
      cwd: root,
      dot: true,
      onlyFiles: false,
      deep: 4,
      ignore: ["**/node_modules/**", "**/.git/**"],
    });
    for (const sub of subs) {
      const dir = path.posix.dirname(sub).replace(/^\.$/, "");
      add(dir, ".gitignore");
    }
  } catch {
    /* ignore */
  }
  return { filters };
}

function isIgnored(mgr: IgnoreManager, rel: string): boolean {
  const posix = toPosix(rel);
  const dir = path.posix.dirname(posix).replace(/^\.$/, "");
  const base = path.posix.basename(posix);
  // Dot-basename files are hidden/editor detritus (e.g. an empty-named
  // ".md") — never documents.
  if (base.startsWith(".")) return true;
  // Check the file against the filter of its directory, then ancestors.
  const parts = dir === "" ? [] : dir.split("/");
  for (let i = parts.length; i >= 0; i--) {
    const d = parts.slice(0, i).join("/");
    const filt = mgr.filters.get(d);
    if (filt && filt.ignores(path.posix.join(...parts.slice(i), base))) return true;
  }
  const rootFilt = mgr.filters.get("");
  if (rootFilt && rootFilt.ignores(posix)) return true;
  return false;
}

/** A discovered document file, with stat info for fingerprinting. */
function discover(root: string, opts: { onlyFiles?: string[]; ignoreDirs?: string[] }): DiscoveredFile[] {
  if (opts.onlyFiles) {
    // NTK-002: self-edit reindex is not a discovery bypass — the ignore layer
    // (DEFAULT_IGNORES + .gitignore) applies to explicit paths too, so edits
    // under .scratch / node_modules / testproject never enter the index.
    const mgr = loadIgnores(root);
    return opts.onlyFiles
      .filter((rel) => !isIgnored(mgr, rel))
      .map((rel) => {
        // Self-edit reindex must respect NTK-002: docs only. Non-document
        // files (e.g. the agent editing a .ts source) return null, which
        // drops any stale sections for that path — source code never enters
        // the index (live bug: bench/tune.ts got injected after an edit).
        if (!DOC_EXTENSIONS.has(path.extname(rel).toLowerCase())) return null;
        const abs = path.join(root, rel);
        try {
          const st = fs.statSync(abs);
          return {
            path: toPosix(rel),
            absolutePath: abs,
            mtimeMs: st.mtimeMs,
            size: st.size,
          };
        } catch {
          return null;
        }
      })
      .filter((f): f is DiscoveredFile => f !== null);
  }
  const exts = [...DOC_EXTENSIONS].map((e) => e.slice(1));
  const found = fg.sync(`**/*.{${exts.join(",")}}`, {
    cwd: root,
    dot: true,
    onlyFiles: true,
    followSymbolicLinks: false,
    deep: 12,
    ignore: (opts.ignoreDirs ?? []).map((d) => `**/${d}/**`),
  });
  const mgr = loadIgnores(root);
  const out: DiscoveredFile[] = [];
  for (const rel of found) {
    if (isIgnored(mgr, rel)) continue;
    const abs = path.join(root, rel);
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      continue;
    }
    if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
    out.push({
      path: rel,
      absolutePath: abs,
      mtimeMs: st.mtimeMs,
      size: st.size,
    });
    if (out.length >= MAX_FILES) break;
  }
  return out;
}

export interface ScanResult {
  root: string;
  /** Every discovered file (for fingerprinting); includes files that failed to parse. */
  files: DiscoveredFile[];
  /** Files that produced at least one indexed section. */
  indexedFiles: number;
  /** Files skipped (oversized/unreadable). */
  skipped: number;
  sections: SectionRecord[];
  docMetas: DocMeta[];
  expansion: ExpansionDict;
  indexMs: number;
}

/** Paths of all indexable, non-ignored files (used by the freshness probe). */
export function listDocumentFiles(root: string): string[] {
  return discover(root, {}).map((f) => f.path);
}

export interface IndexProjectOptions {
  onlyFiles?: string[];
  ignoreDirs?: string[];
}

export function indexProject(root: string, opts: IndexProjectOptions = {}): ScanResult {
  const t0 = performance.now();
  const files = discover(root, opts);
  const sections: SectionRecord[] = [];
  const docMetas: DocMeta[] = [];
  let skipped = 0;
  let indexedFiles = 0;

  for (const file of files) {
    let raw: string;
    try {
      raw = fs.readFileSync(file.absolutePath, "utf8");
    } catch {
      skipped++;
      continue;
    }
    const ext = path.extname(file.path);
    const fallbackTitle = path.basename(file.path, ext);
    let parsed: { sections: SectionRecord[]; frontMatter: Record<string, unknown>; title: string };
    try {
      parsed = parseDocument(raw, file.path, fallbackTitle);
    } catch {
      skipped++;
      continue;
    }
    const fileSections = parsed.sections.slice(0, MAX_SECTIONS_PER_DOC);
    // Truncation changes the document's indexed section count — docSections
    // was fixed up over the UNtruncated list in parseDocument; recount here
    // so surviving sections never claim more sections than the index has.
    for (const s of fileSections) s.docSections = fileSections.length;
    // Ensure ids are set (parse.ts may leave this to the caller for robustness).
    for (let i = 0; i < fileSections.length; i++) {
      const s = fileSections[i]!;
      if (!s.id) s.id = `${file.path}::${s.ordinal}`;
      if (!s.docPath) s.docPath = file.path;
      if (!s.docTitle) s.docTitle = parsed.title;
    }
    if (fileSections.length > 0) {
      indexedFiles++;
      sections.push(...fileSections);
      docMetas.push({
        path: file.path,
        title: parsed.title,
        mtimeMs: file.mtimeMs,
        size: file.size,
        hash: crypto.createHash("sha256").update(raw).digest("hex"),
        sections: fileSections.length,
        nameKey: path.basename(file.path, ext).toLowerCase(),
        frontMatter: parsed.frontMatter,
        links: extractDocLinks(file.path, raw),
      });
    }
  }

  const expansion = sections.length ? buildExpansionDict(sections) : {};
  return {
    root,
    files,
    indexedFiles,
    skipped,
    sections,
    docMetas,
    expansion,
    indexMs: Math.round(performance.now() - t0),
  };
}

/* ---------- document cross-references (relationships, not kinds) ---------- */

const MD_LINK_RE = /!?\[[^\]]*\]\(\s*<?([^)>\s]+)>?[^)]*\)/g;
// Only extensions DOC_EXTENSIONS indexes: a link target NTK never indexes
// is not a relationship it can traverse.
const DOC_EXT_RE = /\.(md|mdx|txt|adoc)$/i;

/**
 * Repo-relative docs referenced by markdown links in `raw`. Anchors,
 * external URLs and non-document targets are skipped; relative paths are
 * resolved against the referencing document's directory. (Moved from
 * applicability.ts when document KINDS were removed — a link is a
 * relationship, not a type.)
 */
export function extractDocLinks(docPath: string, raw: string, max = 30): string[] {
  const out: string[] = [];
  const dir = docPath.includes("/") ? docPath.slice(0, docPath.lastIndexOf("/")) : "";
  for (const m of raw.matchAll(MD_LINK_RE)) {
    const target = m[1]!.trim();
    if (!target || /^(?:https?:|mailto:|#)/i.test(target)) continue;
    let clean: string;
    try {
      clean = decodeURI(target.split("#")[0]!.split("?")[0]!);
    } catch {
      continue; // malformed percent-encoding: skip this link, never sink the doc
    }
    if (!DOC_EXT_RE.test(clean)) continue;
    const rel = clean.startsWith("/")
      ? clean.replace(/^\/+/, "")
      : normalizePosix(dir ? `${dir}/${clean}` : clean);
    if (rel && !rel.startsWith("../") && rel !== docPath && !out.includes(rel)) out.push(rel);
    if (out.length >= max) break;
  }
  return out;
}

function normalizePosix(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") {
      // Underflow = escaping the project root: return a ".."-prefixed marker
      // so the caller's startsWith("../") guard rejects the link (a silent
      // pop would rewrite an escape into a bogus in-root path).
      if (parts.length) parts.pop();
      else return "../";
    } else parts.push(seg);
  }
  return parts.join("/");
}
