/** Shared micro-utilities (single home for primitives that were duplicated
 *  across the plugin, TUI, core, and index store). */
import fs from "node:fs";
import path from "node:path";

/** FNV-1a: tiny, fast, dependency-free content hash (cache keys, signatures). */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** Project-relative path in index-canonical form: posix separators.
 *  The index, scanner, and fingerprint maps key on posix paths; every
 *  crossing from an OS path (Windows "\") into that space goes through here. */
export function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/** Absolute (or relative) file path → project-relative posix path. */
export function toPosixRel(root: string, p: string): string {
  return toPosix(path.isAbsolute(p) ? path.relative(root, p) : p);
}

/** Read the last `maxBytes` of a file as UTF-8 ("" when unreadable).
 *  Bounded tail read shared by the log tail (status.ts) and the audit
 *  analytics (plugin debugStats). */
export function tailFile(p: string, maxBytes = 262_144): string {
  try {
    const size = fs.statSync(p).size;
    const cap = Math.min(size, maxBytes);
    const fd = fs.openSync(p, "r");
    try {
      const b = Buffer.alloc(cap);
      fs.readSync(fd, b, 0, cap, size - cap);
      return b.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}
