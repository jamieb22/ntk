/** Markdown parsing: document → sections (Layer 0 = structural stripping at
 *  parse time; spec NTK-002 forbids anything requiring network/model calls).
 *
 * Layer 0 removes, per design.md §6: front matter, badge lines, TOC blocks,
 * nav-only sections (See also / References / External links), and link-dump
 * list items. Code blocks, tables, and procedures survive as atomic blocks.
 */
import { unified } from "unified";
import remarkParse from "remark-parse";
import matter from "gray-matter";
import type { Block, SectionRecord } from "./types.js";
import { contentWords, identifiers, estimateTokens, sentences } from "./tokenize.js";

const parser = unified().use(remarkParse).freeze();

/** Headings whose whole subtree is navigation noise. */
const NOISE_HEADING =
  /^(?:table of contents|\(?(?:toc|TOC)\)?|see\s+also|references?|external\s+links?|related\s+(?:links?|reading|documentation)|appendix\s*:\s*(?:links|references)|navigation|footnotes?|bibliography|changelog|change\s+log|releases?|license)$/i;

const BADGE_LINE = /^\s*\[?\s*!\[[^\]]*\]\([^)]*\)\s*\]?\s*(?:\([^)]*\))?\s*$/;
const BARE_LINK_ITEM = /^\s*[-*+]\s+(?:\[[^\]]*\]\([^)]*\)\s*[.:;]?\s*)+$/;

interface RawSection {
  /** Heading trail (outermost first); [] = preamble. */
  trail: string[];
  level: number;
  lines: string[];
  /** 1-based start line in the original file. */
  start: number;
  /** 1-based last line seen for this section (inclusive; NTK-011 log). */
  end: number;
  /** True when the section heading matched NOISE_HEADING (drop whole subtree). */
  noise: boolean;
}

function isFenceOpen(line: string): boolean {
  return /^ {0,3}(`{3,}|~{3,})/.test(line);
}

/**
 * Heading trail plus the split content words of multi-word headings
 * ("Pipeline Config" → also "pipeline", "config") so lexical fields and
 * consumers can match individual trail words. Single-word headings already
 * match as-is and are not duplicated.
 */
function headingTrailWords(trail: string[]): string[] {
  const out = [...trail];
  for (const h of trail) {
    if (!/\s/.test(h)) continue;
    for (const w of contentWords(h)) if (!out.includes(w)) out.push(w);
  }
  return out;
}

export function parseDocument(
  raw: string,
  relPath: string,
  fallbackTitle: string,
): { sections: SectionRecord[]; frontMatter: Record<string, unknown>; title: string } {
  let frontMatter: Record<string, unknown> = {};
  let body = raw;
  try {
    const parsed = matter(raw);
    frontMatter = parsed.data as Record<string, unknown>;
    body = parsed.content;
  } catch {
    /* malformed front matter — treat whole file as content */
  }

  const tree = parser.parse(body);

  // Collect top-level sections from the mdast, tracking line ranges.
  const sections: RawSection[] = [];
  let current: RawSection = { trail: [], level: 0, lines: [], start: 1, end: 1, noise: false };
  const stack: { text: string; level: number }[] = [];

  const children = (tree as { children: unknown[] }).children;
  const bodyLines = body.split("\n"); // split once (was O(nodes × lines) in-loop)
  let prevEnd = 0;
  for (const nodeAny of children) {
    const node = nodeAny as {
      type: string;
      depth?: number;
      children?: { value?: string }[];
      position?: { start: { line: number }; end: { line: number } };
      value?: string;
      lang?: string;
      url?: string;
      ordered?: boolean;
      spread?: boolean;
      depth_?: number;
    };
    const start = node.position?.start.line ?? 1;
    const end = node.position?.end.line ?? start;
    // Preserve blank lines between consecutive nodes: mdast ranges cover only
    // the node's own lines, so the list/table separator below.
    const gap = bodyLines.slice(prevEnd, start - 1).some((l) => l.trim() === "");
    prevEnd = end;

    if (node.type === "heading") {
      const text = (node.children ?? []).map((c) => c.value ?? "").join("").trim();
      const level = node.depth ?? 1;
      flush(sections, current);
      while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
      stack.push({ text, level });
      current = {
        trail: stack.map((s) => s.text),
        level,
        lines: [],
        start,
        end: start,
        noise: NOISE_HEADING.test(text),
      };
      // the heading line itself stays out of body text (we store trail separately)
    } else {
      const lines = bodyLines.slice(start - 1, end);
      if (gap && current.lines.length > 0) current.lines.push(""); // node separator
      current.lines.push(...lines);
      current.end = end;
    }
  }
  flush(sections, current);

  // The preamble (trail=[]) always exists; drop noise subtrees.
  const kept = sections.filter(
    (s, i) =>
      !(s.noise && s.level > 0) &&
      !(s.lines.length === 0 && s.trail.length > 0 && i > 0 && sections[i - 1]?.noise),
  );

  const docTitle = pickTitle(frontMatter, sections, fallbackTitle, relPath);
  const out: SectionRecord[] = [];
  const textBySection = kept.map((s) => layer0(s, body));

  for (let i = 0; i < kept.length; i++) {
    const section = kept[i]!;
    const text = textBySection[i]!;
    if (text.trim().length < 20 && section.trail.length > 0) continue; // empty container heading
    const blocks = toBlocks(text);
    if (blocks.length === 0) continue;
    const { fields, tokens } = computeFields(text, blocks, docTitle, section.trail);
    const heading = section.trail[section.trail.length - 1] ?? "";
    out.push({
      terms: fields.terms.slice(0, 24),
      id: `${relPath}::${out.length}`,
      docPath: relPath,
      docTitle,
      heading,
      headings: headingTrailWords(section.trail),
      level: section.level,
      sectionPath: section.trail.length > 0 ? section.trail.join(" > ") : docTitle,
      startLine: section.start,
      endLine: section.end,
      ordinal: out.length,
      docSections: 0, // fixed up below
      text,
      blocks,
      fields,
      tokens,
    });
  }
  for (const s of out) s.docSections = out.length;
  return { sections: out, frontMatter, title: docTitle };
}

function flush(list: RawSection[], cur: RawSection): void {
  if (cur.lines.length > 0 || cur.trail.length === 0) list.push(cur);
  // reset handled by caller via new object
}

function pickTitle(
  fm: Record<string, unknown>,
  sections: RawSection[],
  fallback: string,
  relPath: string,
): string {
  const t = fm["title"];
  if (typeof t === "string" && t.trim()) return t.trim();
  const h1 = sections.find((s) => s.level === 1);
  if (h1 && h1.trail.length > 0) return h1.trail[h1.trail.length - 1]!;
  if (fallback.trim()) return fallback.trim();
  return relPath;
}

/** Layer 0: structural stripping. Returns cleaned markdown text for a section. */
function layer0(s: RawSection, body: string): string {
  void body;
  const out: string[] = [];
  let inFence = false;
  let fenceChar = "";
  let fenceLen = 0;
  for (const line of s.lines) {
    const fence = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      const run = fence[2]!;
      if (!inFence) {
        inFence = true;
        fenceChar = run[0]!;
        fenceLen = run.length;
      } else if (run[0] === fenceChar && run.length >= fenceLen && !fence[3]?.trim()) {
        inFence = false;
      }
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    if (BADGE_LINE.test(line)) continue;
    if (isTocLine(line)) continue;
    out.push(line);
  }
  // drop link-dump list items: bullets whose content is only links
  const cleaned: string[] = [];
  let bulletRun: string[] = [];
  const flushRun = () => {
    if (bulletRun.length === 0) return;
    const allLinks = bulletRun.every((l) => BARE_LINK_ITEM.test(l));
    if (!allLinks) cleaned.push(...bulletRun);
    bulletRun = [];
  };
  for (const line of out) {
    if (/^\s*[-*+]\s/.test(line)) {
      bulletRun.push(line);
    } else {
      flushRun();
      cleaned.push(line);
    }
  }
  flushRun();
  return cleaned.join("\n").trim();
}

const TOC_ITEM = /^\s*(?:[-*+]\s+|\d+\.\s+|\s{2,})\[[^\]]*\]\(#[^)]*\)\s*(?:\\?[-–]\s.*)?$/;
function isTocLine(line: string): boolean {
  return TOC_ITEM.test(line);
}

function toBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const fence = isFenceOpen(lines[i]!);
    if (fence) {
      const run = /^( {0,3})(`{3,}|~{3,})/.exec(lines[i]!)![2]!;
      const char = run[0]!;
      const len = run.length;
      const start = i++;
      // Scan to the closing fence; the block text is the full fence range
      // captured below via lines.slice(start, i).
      while (i < lines.length) {
        const m = /^( {0,3})(`{3,}|~{3,})\s*$/.exec(lines[i]!);
        i++;
        if (m && m[2]![0] === char && m[2]!.length >= len) break;
      }
      // lines.slice(start, i) already spans the whole fence (open + body +
      // close); appending `code` again duplicated every code block.
      blocks.push({ kind: "code", text: lines.slice(start, i).join("\n") });
      continue;
    }
    const line = lines[i]!;
    if (/^\s*(?:[-*+]\s|\d+\.\s)/.test(line) || /^\s*\|/.test(line)) {
      // One atomic block per consecutive run of list items. Markdown tables
      // are list-like blocks: the first `|` row starts the block and the
      // delimiter row extends it (isListContinuation accepts table rows).
      const item: string[] = [];
      while (i < lines.length) {
        const l = lines[i]!;
        const isItem = /^\s*(?:[-*+]\s|\d+\.\s)/.test(l);
        const isTableRow = /^\s*\|/.test(l);
        const isContinuation = /^\s{2,}\S/.test(l) && !isFenceOpen(l);
        if (item.length > 0 && l.trim() === "") break; // blank line ends the block
        if (item.length === 0 && !isItem && !isTableRow) break;
        if (isItem || isTableRow || isContinuation) {
          item.push(l);
          i++;
          continue;
        }
        break; // paragraph / fence / heading interrupts the list
      }
      blocks.push({ kind: "list", text: item.join("\n") });
      continue;
    }
    if (/^\s*>/.test(line)) {
      const q: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) {
        q.push(lines[i]!);
        i++;
      }
      blocks.push({ kind: "quote", text: q.join("\n") });
      continue;
    }
    if (line.trim() === "") {
      i++;
      continue;
    }
    // paragraph: gather until blank line
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== "" && !/^\s*(?:[-*+]\s|\d+\.\s|>|\|)/.test(lines[i]!) && !isFenceOpen(lines[i]!)) {
      para.push(lines[i]!);
      i++;
    }
    const ptext = para.join("\n").trim();
    for (const sent of sentences(ptext)) blocks.push({ kind: "sentence", text: sent });
  }
  return blocks;
}

function computeFields(
  text: string,
  blocks: Block[],
  docTitle: string,
  trail: string[],
): { fields: SectionRecord["fields"]; tokens: number } {
  const headingText = trail[trail.length - 1] ?? "";
  const codeText = blocks
    .filter((b) => b.kind === "code")
    .map((b) => b.text)
    .join("\n");
  const terms = [...new Set([...identifiers(text), ...identifiers(codeText)])].slice(0, 80);
  const fields = {
    title: contentWords(docTitle + " " + headingText),
    headings: contentWords(trail.join(" ")),
    terms: terms.map((t) => t.toLowerCase()),
    body: contentWords(text),
  };
  return { fields, tokens: estimateTokens(text) };
}
