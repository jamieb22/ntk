/**
 * OpenCode native-instruction awareness (spec §4.3 / NTK-004).
 *
 * OpenCode already injects instruction files (AGENTS.md / CLAUDE.md chains,
 * global config) into the system prompt. NTK indexing those same files would
 * duplicate content and waste budget. This module:
 *
 *  - collects the project-relative paths of native instruction files so the
 *    scanner can exclude them;
 *  - computes a content signature so the plugin can hash-dedupe at runtime
 *    even when a file is not on the native list (defence in depth, design §4).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { toPosixRel } from "./util.js";

/** File names OpenCode (and compatible agents) treat as instruction files. */
const NATIVE_NAMES = ["AGENTS.md", "CLAUDE.md"];

function scanDirs(root: string): string[] {
  const dirs: string[] = [];
  let cur = path.resolve(root);
  for (;;) {
    dirs.push(cur);
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return dirs;
}

/** Absolute paths of native instruction files visible to the project. */
export function nativeInstructionFiles(root: string): string[] {
  const out: string[] = [];
  for (const dir of scanDirs(root)) {
    for (const name of NATIVE_NAMES) {
      const p = path.join(dir, name);
      try {
        if (fs.statSync(p).isFile()) out.push(p);
      } catch {
        /* not present */
      }
    }
  }
  // Global instruction file (project-independent).
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (home) {
    const p = path.join(home, ".config", "opencode", "AGENTS.md");
    try {
      if (fs.statSync(p).isFile()) out.push(p);
    } catch {
      /* not present */
    }
  }
  return out;
}

/**
 * Given the project root and the candidate document relative paths, return
 * the subset that OpenCode's native instruction system already injects and
 * that NTK must therefore not re-serve:
 *   - instruction files inside the project (AGENTS.md / CLAUDE.md, at any
 *     depth — OpenCode merges the chain from cwd upward);
 *   - any file whose full text is inlined by an `import` directive is left
 *     to the runtime signature check.
 */
export function collectNativeInstructionPaths(
  root: string,
  relPaths: string[],
): Set<string> {
  const rootAbs = path.resolve(root);
  const natives = new Set(nativeInstructionFiles(rootAbs).map((p) => path.resolve(p)));
  const out = new Set<string>();
  for (const rel of relPaths) {
    const abs = path.resolve(rootAbs, rel);
    const base = path.basename(abs);
    if (!NATIVE_NAMES.includes(base)) continue;
    // In-project native file, or a global/chain file that resolves into the
    // scan set: exclude from NTK serving.
    if (natives.has(abs) || abs.startsWith(rootAbs + path.sep)) {
      out.add(toPosixRel(root, rel));
    }
  }
  return out;
}

/**
 * Stable content signature of the native instruction chain for a root:
 * `name:sha256(16)` per file, joined. The plugin hashes the instruction text
 * it is about to inject and, on a signature match, skips its own duplicate
 * section (hash-first dedupe, design §4).
 */
const sigMemo = new Map<string, { stamp: string; sig: string }>();
export function nativeInstructionsSignature(root: string): string {
  // EXP-R D10: per-dispatch signature must not re-read+re-hash every
  // instruction file (O(corpus) on the cache-hit path — measured p95 ~150ms
  // on large roots). Memoize on the (path, mtime, size) tuple: stat-only
  // fast path, recomputed on knowledge change.
  const rootAbs = path.resolve(root);
  const files = nativeInstructionFiles(rootAbs);
  const stamp = files.map((f) => {
    try {
      const st = fs.statSync(f);
      return `${f}:${Math.round(st.mtimeMs)}:${st.size}`;
    } catch {
      return f + ":x";
    }
  }).join("|");
  // Keyed on the RESOLVED root: relative and absolute spellings of the same
  // project must not accumulate duplicate memo entries.
  const memo = sigMemo.get(rootAbs);
  if (memo && memo.stamp === stamp) return memo.sig;
  const h = createHash("sha256");
  for (const f of files) {
    let text = "";
    try {
      text = fs.readFileSync(f, "utf8");
    } catch {
      text = "";
    }
    h.update(`${f}\u0000${text}\n`);
  }
  const sig = h.digest("hex").slice(0, 16);
  if (sigMemo.size > 64) sigMemo.clear(); // bounded: roots churn in long-lived servers
  sigMemo.set(rootAbs, { stamp, sig });
  return sig;
}


