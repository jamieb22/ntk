import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  buildDebugReport,
  buildStatusSummary,
  readIndexSummary,
  tailProjectLines,
  lastRetrieval,
  DEBUG_ON_HELP,
} from "../src/core/status.js";
import { isDebugEnabled, setDebugEnabled } from "../src/core/debug-logging.js";

let tmp: string;
let logFile: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ntk-status-"));
  logFile = path.join(tmp, "ntk-plugin.log");
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function writeIndex(root: string, over: Record<string, unknown> = {}) {
  fs.mkdirSync(path.join(root, ".ntk"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".ntk", "index.json"),
    JSON.stringify({
      version: 3,
      builtAt: Date.now() - 90_000,
      stats: { indexedFiles: 7, sections: 42, skipped: 0, files: 7 },
      docs: Array.from({ length: 7 }, (_, i) => ({ path: `d${i}.md`, sections: 6 })),
      idf: Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`t${i}`, 2])),
      ...over,
    }),
  );
}

describe("readIndexSummary", () => {
  it("counts docs/sections/terms from the persisted index", () => {
    writeIndex(tmp);
    const s = readIndexSummary(tmp)!;
    expect(s.docs).toBe(7);
    expect(s.sections).toBe(42);
    expect(s.terms).toBe(100);
    expect(s.indexKB).toBeGreaterThanOrEqual(0);
  });
  it("null on missing index", () => {
    expect(readIndexSummary(path.join(tmp, "nope"))).toBeNull();
  });
});

describe("tailProjectLines", () => {
  it("filters by bracketed project name, keeps the newest n", () => {
    fs.writeFileSync(
      logFile,
      [
        `2026-11-05T04:00:00.000Z [needtoknow] plugin v0.1.0 loaded (v2)`,
        `2026-11-05T04:00:01.000Z [other] dispatch: injected 9 sections (x) for "y" in 5ms, 100tok content / 120tok block`,
        `2026-11-05T04:00:02.000Z [needtoknow] dispatch: injected 4 sections (a::b:excerpt) for "q" in 21ms, 762tok content / 992tok block`,
        `2026-11-05T04:00:03.000Z [needtoknow] dispatch: injection set unchanged — kept (cache-stable)`,
        `2026-11-05T04:00:04.000Z [needtoknow] dispatch: NTK-016 hit rev 6; reused 4 sections`,
      ].join("\n") + "\n",
    );
    const lines = tailProjectLines(logFile, "needtoknow", 3);
    expect(lines.length).toBe(3);
    expect(lines[0]).toMatch(/injected 4 sections/);
    expect(lines[2]).toMatch(/reused 4 sections/);
  });
});

describe("lastRetrieval", () => {
  it("parses the latest injected dispatch (latency, tokens, revision)", () => {
    const r = lastRetrieval([
      `dispatch: injected 4 sections (a::b:excerpt) for "q" in 21ms, 762tok content / 992tok block`,
      `dispatch: injection set unchanged — kept (cache-stable)`,
      `dispatch: NTK-016 hit rev 6; reused 4 sections`,
    ])!;
    expect(r.kind).toBe("injected");
    expect(r.detail).toContain("injected 4 sections");
    expect(r.detail).toContain("762tok");
    expect(r.ms).toBe("21");
    expect(r.rev).toBe("6");
  });
  it("reused when no injection line present", () => {
    const r = lastRetrieval([`dispatch: NTK-016 hit rev 2; reused 3 sections`])!;
    expect(r.kind).toBe("reused");
    expect(r.rev).toBe("2");
  });
  it("null for empty log", () => {
    expect(lastRetrieval([])).toBeNull();
  });
});

describe("buildStatusSummary", () => {
  it("renders index, retrieval, and log sections", () => {
    writeIndex(tmp);
    fs.writeFileSync(
      logFile,
      `2026-11-05T04:00:02.000Z [${path.basename(tmp)}] dispatch: injected 4 sections (a::b:excerpt) for "q" in 21ms, 762tok content / 992tok block\n`,
    );
    const { report, indexMissing } = buildStatusSummary({
      root: tmp,
      version: "0.1.0",
      logFile,
    });
    expect(indexMissing).toBe(false);
    expect(report).toMatch(/^NeedToKnow v0\.1\.0 — project/);
    expect(report).toMatch(/Index: schema v3 · 7 docs · 42 sections · 100 terms/);
    expect(report).toMatch(/Last reindex: .* \(2 min ago\)/);
    expect(report).toMatch(/Last retrieval: injected — injected 4 sections \(762tok content \/ 992tok block\) · 21ms · cache rev —/);
    expect(report).toMatch(/\.ntk\/status\.md/);
  });
  it("missing index suggests reindex", () => {
    const { report, indexMissing } = buildStatusSummary({
      root: tmp,
      version: "0.1.0",
      logFile,
    });
    expect(indexMissing).toBe(true);
    expect(report).toMatch(/Index: MISSING/);
    expect(report).toMatch(/ntk-reindex/);
  });
});

describe("buildDebugReport", () => {
  it("on toggles the flag and returns the help text + log notices", () => {
    fs.writeFileSync(
      logFile,
      `2026-11-05T04:00:00.000Z [${path.basename(tmp)}] NTK-DEBUG: DECLINED — gate: minScore (0.4 < 1.2)\n`,
    );
    const report = buildDebugReport(tmp, "on", logFile, "0.1.0");
    expect(report).toBe(DEBUG_ON_HELP + `\nLast debug notices (${logFile}):\n  · NTK-DEBUG: DECLINED — gate: minScore (0.4 < 1.2)`);
    expect(isDebugEnabled(tmp)).toBe(true);
  });
  it("on with an empty log tells the user to expect the next turn", () => {
    const report = buildDebugReport(tmp, "on", logFile, "0.1.0");
    expect(report).toMatch(/^NTK-DEBUG: ON/);
    expect(report).toMatch(/No NTK-DEBUG summary lines in the log yet/);
  });
  it("off toggles the flag", () => {
    setDebugEnabled(tmp, true);
    expect(buildDebugReport(tmp, "off", logFile, "0.1.0")).toBe("NTK-DEBUG: OFF.");
    expect(isDebugEnabled(tmp)).toBe(false);
  });
  it("status reports the current flag with version and project", () => {
    setDebugEnabled(tmp, true);
    const report = buildDebugReport(tmp, "status", logFile, "0.1.0");
    expect(report).toMatch(/^NTK-DEBUG: ON \(plugin v0\.1\.0, project /);
    setDebugEnabled(tmp, false);
    expect(buildDebugReport(tmp, "", logFile, "0.1.0")).toBe("NTK-DEBUG: OFF.");
  });
  it("other projects' log lines are ignored", () => {
    fs.writeFileSync(logFile, `2026-11-05T04:00:00.000Z [otherproj] NTK-DEBUG: INJECTED 9 sections\n`);
    setDebugEnabled(tmp, true);
    const report = buildDebugReport(tmp, "status", logFile, "0.1.0");
    expect(report).toMatch(/No NTK-DEBUG summary lines/);
  });
});
