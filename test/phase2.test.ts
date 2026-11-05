/** Phase 2 mechanisms: recency weighting, bounded spreading activation,
 *  stable-selection hysteresis, source-file activity, relevance-only
 *  classification, and two-speed task memory. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { indexProjectFull } from "../src/index-store.js";
import { runRetrieval, DEFAULTS, type RetrievalOptions } from "../src/core/retrieval.js";
import { extractDocLinks } from "../src/core/scanner.js";
import {
  updateTask,
  newTaskMemory,
  isChatter,
  DEFAULT_TRANSITION_SIM,
} from "../src/core/task-memory.js";
import { cleanupProject, makeTempProject, standardCorpus, type Corpus } from "./helpers.js";

const EMPTY = new Set<string>();
const PASSES: Required<RetrievalOptions> = DEFAULTS;

function suite(files: Corpus) {
  const root = makeTempProject(files);
  return { root, index: indexProjectFull(root) };
}

describe("guidanceKind removal regression (relevance-only inclusion)", () => {
  it("no document-kind classification exists in the pipeline (types + index)", async () => {
    // The concept is gone, not merely bypassed: DocMeta carries no kind and
    // indexes record none.
    const types = await import("node:fs").then((m) => m.readFileSync("src/core/types.ts", "utf8"));
    expect(types).not.toMatch(/guidanceKind/);
    const { indexProjectFull } = await import("../src/index-store.js");
    const root = makeTempProject({ "docs/x.md": "# X\n\n## Y\n\ny content about deploy and service pipeline.\n" });
    try {
      const idx = indexProjectFull(root, { force: true });
      for (const d of idx.persisted.docs) expect((d as Record<string, unknown>)["guidanceKind"]).toBeUndefined();
    } finally {
      cleanupProject(root);
    }
  });

  it("selection is unchanged; general-kind docs are no longer overview-capped", () => {
    const { root, index } = suite({
      "docs/CONTRIBUTING.md":
        "# Contributing Guide\n\n## Ship rules\n\nDeploy deploy deploy the deployment deploys the pipeline service.\n",
      "docs/deployment.md":
        "# Deployment Guide\n\n## Ship\n\nDeploy deploy deploy deploy deploy the deployment deploys service pipeline.\n",
      "docs/api.md": "# API\n\n## Auth\n\nOAuth tokens authenticate the api client refresh token.\n",
      "docs/test.md": "# QA\n\n## Unit\n\nUnit tests cover pure functions vitest runner coverage.\n",
    });
    try {
      const r = runRetrieval(index, "deploy the pipeline", EMPTY, PASSES);
      // SELECTION regression: both docs still chosen (ranking/gates untouched).
      expect(r.items.length).toBeGreaterThan(1);
      const gen = r.items.find((i) => i.docPath === "docs/CONTRIBUTING.md");
      const task = r.items.find((i) => i.docPath === "docs/deployment.md");
      expect(gen).toBeDefined();
      expect(task).toBeDefined();
      // CONTENT regression (the expected change): CONTRIBUTING was "general"
      // → overview-capped under the old model. Its level is now score +
      // size + budget only — a small high-scoring section includes in full.
      expect(gen!.level).not.toBe("overview");
      expect(gen!.tokens).toBeGreaterThan(8); // overview floor was ~8 tokens
      expect(task!.level).not.toBe("overview");
    } finally {
      cleanupProject(root);
    }
  });
});

describe("cross-reference links", () => {
  it("extracts repo-relative document links from markdown", () => {
    const links = extractDocLinks(
      "docs/a.md",
      "See [runbook](beta.md), [top](../top.md), [ext](https://x.com/y.md), [sec](#s), ![i](img.png).",
    );
    expect(links).toContain("docs/beta.md");
    expect(links).toContain("top.md");
    expect(links.some((l) => l.includes("http") || l.includes("#") || l.includes("img.png"))).toBe(false);
  });

  it("bounded spreading activation pulls linked docs into the selection", () => {
    const { root, index } = suite({
      "docs/alpha.md":
        "# Alpha\n\n## Deploy alpha\n\nThe alpha deploy pipeline runs the deployment with cluster config. See the [beta runbook](beta.md).\n\n## Alpha scale\n\nAlpha alpha deploy scaling keeps the deployment healthy under load.\n",
      "docs/beta.md":
        "# Beta\n\n## Zeta protocol\n\nZeta protocol steps for the beta service: run zeta ctl start, check zeta logs, verify zeta status.\n",
      "docs/other.md": "# Other\n\n## Misc\n\nNothing relevant here at all, just filler prose about zeppelins and docks.\n",
    });
    try {
      const r = runRetrieval(index, "deploy alpha", EMPTY, PASSES);
      expect(r.items.some((i) => i.docPath === "docs/alpha.md")).toBe(true);
      expect(r.trace.spreadAdded).toBeGreaterThan(0);
      expect(r.items.some((i) => i.docPath === "docs/beta.md")).toBe(true); // one hop
      // the linked doc is the only non-seed doc in items (no second hop)
      const nonSeed = r.items.filter((i) => i.docPath !== "docs/alpha.md");
      expect(nonSeed.length).toBeGreaterThan(0);
      expect(nonSeed.every((i) => i.docPath === "docs/beta.md")).toBe(true);
    } finally {
      cleanupProject(root);
    }
  });
});

describe("stable-selection hysteresis", () => {
  it("keeps previously selected sections at the retention floor and drops them on task change", () => {
    const { root, index } = suite(standardCorpus());
    try {
      // threshold 1.8: onboarding (score ~1.1, mostly expansion-driven) is
      // below inclusion…
      const strict = { ...PASSES, threshold: 1.8 };
      const a = runRetrieval(index, "How do I deploy the service?", EMPTY, strict);
      expect(a.items.some((i) => i.docPath === "docs/onboarding.md")).toBe(false);
      // …but it is retained if it was selected last turn (floor = 1.8 × 0.6 = 1.08)…
      const b = runRetrieval(index, "How do I deploy the service?", EMPTY, strict, undefined, {
        previouslySelected: ["docs/onboarding.md#Onboarding"],
      });
      expect(b.items.some((i) => i.docPath === "docs/onboarding.md")).toBe(true);
      expect(b.trace.retained).toContain("docs/onboarding.md#Onboarding");
      // …retention is overridden by a clear task change.
      const c = runRetrieval(index, "How do I deploy the service?", EMPTY, strict, undefined, {
        previouslySelected: ["docs/onboarding.md#Onboarding"],
        taskChanged: true,
      });
      expect(c.items.some((i) => i.docPath === "docs/onboarding.md")).toBe(false);
    } finally {
      cleanupProject(root);
    }
  });
});

describe("recency weighting", () => {
  it("lifts the more recently modified document on equal lexical scores", () => {
    const body = "# Guide\n\n## Deploy\n\nThe deploy of the widget needs the config in the repo pipeline.\n";
    const { root, index } = suite({ "docs/a.md": body, "docs/b.md": body });
    try {
      const touch = (rel: string, mtimeMs: number) => {
        const t = new Date(mtimeMs);
        fs.utimesSync(path.join(root, rel), t, t);
      };
      const now = Date.now();
      touch("docs/a.md", now - 40 * 86400000); // 40 days old
      touch("docs/b.md", now - 86400000); // yesterday
      indexProjectFull(root, { force: true }); // re-index to pick up mtimes
      const fresh = indexProjectFull(root);
      const r = runRetrieval(fresh, "deploy the widget pipeline", EMPTY, PASSES);
      expect(r.items[0]!.docPath).toBe("docs/b.md");
    } finally {
      cleanupProject(root);
    }
  });
});

describe("source-file activity (NTK-004)", () => {
  it("pulls docs matching recently touched source into the selection", () => {
    const { root, index } = suite({
      "docs/a.md": "# Alpha\n\n## Deploy\n\nThe deploy deploy deploy deploy deployment deploys service pipeline.\n",
      "docs/w.md":
        "# Widget\n\n## Panel\n\nWidget widget widget widget panel builder notes for the widget factory.\n",
      "docs/x.md": "# Xylo\n\n## Misc\n\nNothing here about deploys, just xylophone factory notes.\n",
    });
    try {
      const base = runRetrieval(index, "deploy", EMPTY, PASSES);
      expect(base.items.some((i) => i.docPath === "docs/w.md")).toBe(false); // docTitle w?
      const r = runRetrieval(index, "deploy", EMPTY, PASSES, undefined, {
        activityFiles: ["src/widgets/gadget/WidgetPanel.ts"],
      });
      expect(r.items.some((i) => i.docPath === "docs/w.md")).toBe(true);
    } finally {
      cleanupProject(root);
    }
  });
});

describe("two-speed task memory (SPEC §5.8)", () => {
  it("anchors the objective and keeps it through low-similarity follow-ups", () => {
    let m = newTaskMemory();
    const first = updateTask(m, "Implement OAuth token refresh for the mobile API client");
    expect(first.changed).toBe(true);
    expect(first.memory.objective).toContain("OAuth");
    m = first.memory;

    // A near-duplicate instruction (shares "api", "token") keeps the anchor.
    const follow = updateTask(m, "Also refresh the api token cache");
    expect(follow.changed).toBe(false);
    expect(follow.similarity).toBeGreaterThan(0);
    expect(follow.memory.objective).toContain("OAuth");

    // A debugging turn sharing no words is a clear task change.
    const switchTo = updateTask(m, "Fix the flaky database connection pool timeout");
    expect(switchTo.similarity).toBeLessThan(DEFAULT_TRANSITION_SIM);
    expect(switchTo.changed).toBe(true);
    expect(switchTo.memory.objective).toContain("database");
  });

  it("a long idle gap starts a new task", () => {
    const a = updateTask(newTaskMemory(), "Implement OAuth token refresh", 1_000);
    const b = updateTask(a.memory, "Implement OAuth token refresh", 1_000 + 60 * 60 * 1000);
    expect(b.changed).toBe(true);
  });

  it("preserves the objective on an uncertain transition (P1-7)", () => {
    let m = updateTask(newTaskMemory(), "Implement OAuth token refresh for the mobile API client").memory;
    // Low (not hard-broken) overlap, changed terminology: keep the anchor.
    const u = updateTask(m, "The client returns 401 on expiry");
    expect(u.similarity).toBeGreaterThanOrEqual(0.05);
    expect(u.similarity).toBeLessThan(DEFAULT_TRANSITION_SIM);
    expect(u.changed).toBe(false);
    expect(u.ambiguous).toBe(true);
    expect(u.memory.objective).toContain("OAuth");
    expect(u.memory.pending).toContain("401");
  });

  it("commits a switch when the new topic recurs (P1-7 multi-turn)", () => {
    let m = updateTask(newTaskMemory(), "Implement OAuth token refresh for the mobile API client").memory;
    m = updateTask(m, "The client returns 401 on expiry").memory; // ambiguous, pending
    // The 401/expiry topic recurs → the transition is real, adopt it.
    const u = updateTask(m, "401 expiry errors keep happening after the token update");
    expect(u.changed).toBe(true);
    expect(u.memory.objective).toContain("401");
  });

  it("a hard topical break switches immediately (P1-7)", () => {
    let m = updateTask(newTaskMemory(), "Implement OAuth token refresh for the mobile API client").memory;
    const u = updateTask(m, "Tune the rocket launcher ignition timing");
    expect(u.similarity).toBeLessThan(0.05);
    expect(u.changed).toBe(true);
  });

  it("short technical instructions are not chatter (P1-7)", () => {
    expect(isChatter("Refactor auth middleware")).toBe(false);
    expect(isChatter("Fix stripe-webhook.ts handler")).toBe(false); // identifier
    expect(isChatter("Add rate limiting")).toBe(false);
    expect(isChatter("ok thanks")).toBe(true);
    expect(isChatter("yes")).toBe(true);
    expect(isChatter("nice work, good job")).toBe(true);
    expect(isChatter("continue")).toBe(true);
  });
});
