import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  indexProjectFull,
  loadIndex,
  reindexFile,
  type PersistedIndex,
} from "../src/index-store.js";
import { stem } from "../src/core/tokenize.js";
import { cleanupProject, makeTempProject, standardCorpus } from "./helpers.js";

function futureTouch(file: string): void {
  const t = new Date(Date.now() + 5000);
  fs.utimesSync(file, t, t);
}

describe("indexProjectFull", () => {
  it("builds and persists a queryable index", () => {
    const root = makeTempProject(standardCorpus());
    try {
      const index = indexProjectFull(root);
      const indexFile = path.join(root, ".ntk", "index.json");
      expect(fs.existsSync(indexFile)).toBe(true);
      expect(fs.existsSync(path.join(root, ".ntk", "cache.json"))).toBe(true);

      expect(index.docCount).toBeGreaterThanOrEqual(5);
      expect(index.stats.indexedFiles).toBeGreaterThanOrEqual(5);
      expect(index.stats.sections).toBe(index.sectionList.length);
      expect(index.sectionList.length).toBeGreaterThan(10);

      const dep = index.docMeta("docs/deployment.md");
      expect(dep?.title).toBe("Deployment Guide");
      expect(dep?.nameKey).toBe("deployment");
      const api = index.docMeta("docs/api.md");
      expect(api?.title).toBe("api"); // no front-matter title and no H1 → basename fallback
      // no front matter in the corpus → nothing stored
      expect(index.frontMatter.get("docs/api.md")).toBeUndefined();

      // section ids are `${docPath}::${ordinal}`
      const sec = index.sectionList.find((s) => s.docPath === "docs/deployment.md")!;
      expect(sec.id).toBe(`${sec.docPath}::${sec.ordinal}`);
      expect(index.sections.get(sec.id)).toBe(sec);

      // BM25 search expects stemmed terms (the index stores stems)
      const hits = index.search([stem("deploy")], 5);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]!.docPath).toBe("docs/deployment.md");
      expect(hits[0]!.score).toBeGreaterThan(0);
      expect(hits[0]!.terms!.length).toBeGreaterThan(0);

      // empty query, unknown term, and (disabled) prefix search
      expect(index.search([], 5)).toEqual([]);
      expect(index.search(["zzqxnotaterm"], 5)).toEqual([]);
      expect(index.search(["dep"], 5)).toEqual([]);
      // fuzzy & prefix search are disabled
      expect(index.search(["deploymen"], 5)).toEqual([]);
    } finally {
      cleanupProject(root);
    }
  });

  it("writes a versioned index.json", () => {
    const root = makeTempProject(standardCorpus());
    try {
      indexProjectFull(root);
      const raw = JSON.parse(
        fs.readFileSync(path.join(root, ".ntk", "index.json"), "utf8"),
      ) as PersistedIndex;
      expect(raw.version).toBe(3); // v3: sections carry endLine (NTK-011 decision log)
      expect(raw.root).toBe(path.resolve(root));
      expect(typeof raw.builtAt).toBe("number");
      expect(typeof raw.bm25).toBe("string");
      expect(raw.bm25.startsWith("{")).toBe(true);
      expect(Array.isArray(raw.sections)).toBe(true);
      expect(raw.sections.length).toBe(raw.stats.sections);
      expect(raw.docs.map((d) => d.path)).toContain("docs/deployment.md");
      expect(raw.idf[stem("deploy")]).toBeGreaterThan(0);
      expect(raw.expansion).toBeTruthy();
    } finally {
      cleanupProject(root);
    }
  });

  it("reuses the persisted index while fingerprints are fresh", () => {
    const root = makeTempProject(standardCorpus());
    try {
      const first = indexProjectFull(root);
      const second = indexProjectFull(root);
      // cache reuse → same builtAt, not a fresh build
      expect(second.persisted.builtAt).toBe(first.persisted.builtAt);
      expect(second.sectionList.length).toBe(first.sectionList.length);
    } finally {
      cleanupProject(root);
    }
  });

  it("reindexFile rebuilds a single file (unknown paths are idempotent no-ops)", () => {
    const root = makeTempProject(standardCorpus());
    try {
      indexProjectFull(root);
      const file = path.join(root, "docs", "deployment.md");
      fs.appendFileSync(file, "\n## Canary checks\n\nRun the canary smoke tests first.\n");
      futureTouch(file);
      expect(reindexFile(root, "docs/deployment.md")).toBe(true);

      const index = loadIndex(root);
      expect(index).not.toBeNull();
      expect(index!.docMeta("docs/deployment.md")).toBeDefined();
      expect(
        index!.sectionList.some((s) => s.docPath === "docs/deployment.md" && s.heading.includes("Canary")),
      ).toBe(true);

      /// A5 semantics: unindexed path in an indexed project is an idempotent no-op success.
      expect(reindexFile(root, "nope.md")).toBe(true);
    } finally {
      cleanupProject(root);
    }
  });

  it("detects edits and deletions through fingerprints", () => {
    const root = makeTempProject(standardCorpus());
    try {
      const first = indexProjectFull(root);

      // a new file at the root is discovered and indexed
      const readme = path.join(root, "readme.md");
      fs.writeFileSync(readme, "# Readme\n\n## Release checklist\n\nTag the release and announce it.\n");
      const second = indexProjectFull(root);
      expect(second.stats.sections).toBeGreaterThan(first.stats.sections);
      expect(
        second.sectionList.some((s) => s.docPath === "readme.md" && s.heading.includes("Release checklist")),
      ).toBe(true);

      fs.rmSync(path.join(root, "docs", "testing.md"));
      const third = indexProjectFull(root);
      expect(third.docMeta("docs/testing.md")).toBeUndefined();
      expect(third.sectionList.some((s) => s.docPath === "docs/testing.md")).toBe(false);
      expect(third.docCount).toBe(second.docCount - 1);
    } finally {
      cleanupProject(root);
    }
  });
  it("detects a rename through fingerprints (count-preserving change)", () => {
    const root = makeTempProject(standardCorpus());
    try {
      const before = indexProjectFull(root);
      expect(before.docMeta("docs/testing.md")).toBeDefined();
      fs.renameSync(path.join(root, "docs", "testing.md"), path.join(root, "docs", "qa.md"));
      const after = indexProjectFull(root); // same file count: only the per-path check catches it
      expect(after.docMeta("docs/testing.md")).toBeUndefined();
      expect(after.docMeta("docs/qa.md")).toBeDefined();
      expect(after.docCount).toBe(before.docCount);
    } finally {
      cleanupProject(root);
    }
  });
});

describe("loadIndex", () => {
  it("caches instances while the index file is unchanged", () => {
    const root = makeTempProject(standardCorpus());
    try {
      indexProjectFull(root);
      const a = loadIndex(root);
      const b = loadIndex(root);
      expect(a).not.toBeNull();
      expect(a).toBe(b);

      // a rewrite of index.json invalidates the instance cache
      const file = path.join(root, "docs", "architecture.md");
      fs.appendFileSync(file, "\n## Extra\n\nMore architecture text about the pipeline.\n");
      futureTouch(file);
      reindexFile(root, "docs/architecture.md");
      const c = loadIndex(root);
      expect(c).not.toBeNull();
      expect(c).not.toBe(a);
      expect(c!.sectionList.some((s) => s.heading.includes("Extra"))).toBe(true);
    } finally {
      cleanupProject(root);
    }
  });

  it("returns null for missing/corrupt indexes", () => {
    const root = makeTempProject(standardCorpus());
    try {
      expect(loadIndex(root)).toBeNull();
      indexProjectFull(root);
      expect(loadIndex(root)).not.toBeNull();

      fs.writeFileSync(path.join(root, ".ntk", "index.json"), "not json{{{");
      expect(loadIndex(root)).toBeNull();
      expect(reindexFile(root, "docs/testing.md")).toBe(false);

      // deleting the state directory the same way a user would
      fs.rmSync(path.join(root, ".ntk"), { recursive: true, force: true });
      expect(loadIndex(root)).toBeNull();

      // and it rebuilds cleanly afterwards
      expect(indexProjectFull(root).docCount).toBeGreaterThan(0);
    } finally {
      cleanupProject(root);
    }
  });

  it("is a no-op on a directory that was never indexed", () => {
    const root = fs.mkdtempSync(path.join(process.cwd(), ".tmp-ntk-"));
    try {
      expect(loadIndex(root)).toBeNull();
      expect(reindexFile(root, "x.md")).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("reindexFile delete handling (audit A5)", () => {
  it("removes sections when the file is DELETED on disk", () => {
    const root = makeTempProject(standardCorpus());
    try {
      const idx = indexProjectFull(root, { force: true });
      expect(idx.sections.size).toBeGreaterThan(3);
      fs.rmSync(path.join(root, "docs", "testing.md"));
      expect(reindexFile(root, "docs/testing.md")).toBe(true);
      const after = loadIndex(root)!;
      expect(after.sections.size).toBeGreaterThan(0); // survivors intact
      for (const id of after.sections.keys()) expect(id.startsWith("docs/testing.md")).toBe(false);
      // Deleting an unindexed path is an idempotent no-op success.
      expect(reindexFile(root, "docs/never.md")).toBe(true);
    } finally {
      cleanupProject(root);
    }
  });
});

describe("index version migration (guidanceKind removal)", () => {
  it("a v1 index (with kind fields) refuses to load and rebuilds as the current version", () => {
    const root = makeTempProject(standardCorpus());
    try {
      indexProjectFull(root, { force: true });
      const idxFile = path.join(root, ".ntk", "index.json");
      const v1 = JSON.parse(fs.readFileSync(idxFile, "utf8")) as Record<string, unknown>;
      v1.version = 1; // simulate pre-removal index (carried guidanceKind in docs)
      (v1.docs as Array<Record<string, unknown>>)[0]!.guidanceKind = "general";
      fs.writeFileSync(idxFile, JSON.stringify(v1));
      expect(loadIndex(root)).toBeNull(); // version gate: stale index never loads
      const rebuilt = indexProjectFull(root); // non-force: freshness probe sees the file…
      expect((rebuilt.persisted as Record<string, unknown>).version).toBe(3);
      for (const d of rebuilt.persisted.docs) expect((d as Record<string, unknown>).guidanceKind).toBeUndefined();
      expect(rebuilt.sections.size).toBeGreaterThan(0); // content preserved
    } finally {
      cleanupProject(root);
    }
  });
});
