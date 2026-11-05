import { describe, expect, it } from "vitest";
import {
  WRITE_TOOLS,
  READ_TOOLS,
  extractFilePath,
  looksLikeSuccessfulWrite,
  resultText,
} from "../src/core/tool-events.js";

describe("tool-event tracking (P1-10 / NTK-004)", () => {
  it("extracts paths across known V2 argument shapes", () => {
    expect(extractFilePath({ filePath: "src/a.ts" })).toBe("src/a.ts");
    expect(extractFilePath({ path: "docs/guide.md" })).toBe("docs/guide.md");
    expect(extractFilePath({ file: "x.md" })).toBe("x.md");
    expect(extractFilePath({ pattern: "**/*.md", path: "docs" })).toBe("docs"); // grep/glob
    expect(extractFilePath({ patchText: "..." })).toBeNull(); // apply_patch: no path arg
    expect(extractFilePath({})).toBeNull();
    expect(extractFilePath(undefined)).toBeNull();
  });

  it("recognizes the tools OpenCode V2 actually emits", () => {
    for (const t of ["write", "edit", "apply_patch"]) expect(WRITE_TOOLS.has(t)).toBe(true);
    for (const t of ["read", "grep", "glob"]) expect(READ_TOOLS.has(t)).toBe(true);
    expect(WRITE_TOOLS.has("bash")).toBe(false);
    expect(READ_TOOLS.has("webfetch")).toBe(false);
  });

  it("accepts real write/edit result phrasings (old regex missed lowercase)", () => {
    expect(looksLikeSuccessfulWrite("write", "completed", "Created file successfully: docs/a.md")).toBe(true);
    expect(looksLikeSuccessfulWrite("edit", "completed", "Edited docs/a.md (1 replacement)")).toBe(true);
    expect(looksLikeSuccessfulWrite("apply_patch", "completed", "The tool execution succeeded.")).toBe(true);
    expect(looksLikeSuccessfulWrite("write", "completed", "File created at x")).toBe(true);
  });

  it("rejects failures and non-write tools", () => {
    expect(looksLikeSuccessfulWrite("edit", "completed", '{"error":{"type":"permission"}}')).toBe(false);
    expect(looksLikeSuccessfulWrite("edit", "error", "Permission denied: shell")).toBe(false);
    expect(looksLikeSuccessfulWrite("read", "completed", "Created file successfully")).toBe(false);
    expect(looksLikeSuccessfulWrite("edit", "completed", "no such file or directory")).toBe(false);
  });

  it("flattens content parts to text", () => {
    expect(resultText("plain")).toBe("plain");
    expect(resultText([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("a\nb");
    expect(resultText(null)).toBe("");
  });
});

describe("self-edit reindex respects doc-only scope (item 12)", () => {
  it("source files the agent edits never enter the index", async () => {
    const { makeTempProject, cleanupProject } = await import("./helpers.js");
    const { indexProjectFull, reindexFile } = await import("../src/index-store.js");
    const root = makeTempProject({ "docs/a.md": "# A\n\n## Setup\n\nsetup steps.\n" });
    try {
      const idx = indexProjectFull(root, { force: true });
      const before = idx.sections.size;
      // Simulate the plugin self-edit hook on a TypeScript source file.
      const fs = await import("node:fs");
      const path = await import("node:path");
      fs.mkdirSync(path.join(root, "src"), { recursive: true });
      fs.writeFileSync(path.join(root, "src", "app.ts"), "export const x = 1;\n");
      reindexFile(root, "src/app.ts");
      const after = indexProjectFull(root);
      const tsSections = [...after.sections.keys()].filter((k) => k.startsWith("src/app.ts"));
      expect(tsSections).toHaveLength(0);
      expect(after.sections.size).toBe(before);
    } finally {
      cleanupProject(root);
    }
  });
});
