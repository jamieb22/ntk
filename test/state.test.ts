import { describe, expect, it } from "vitest";
import {
  RetrievalStateManager,
  computeStateFingerprint,
  type StateInput,
} from "../src/core/state.js";

function input(over: Partial<StateInput> = {}): StateInput {
  return {
    userText: "How do I deploy the service to production?",
    turnCount: 2,
    taskFingerprint: "fp-task-1",
    episodeId: "e1",
    indexRevision: 1,
    nativeSignature: "",
    compactionSeq: 0,
    ...over,
  };
}

describe("Retrieval State Manager (SPEC §5.9 / NTK-016)", () => {
  it("cache hits when nothing in the retrieval state changed", () => {
    const m = new RetrievalStateManager();
    const a = m.check(input());
    expect(a.kind).toBe("miss"); // first dispatch has no cached selection
    m.store(input(), { itemIds: ["doc1#S1"], empty: false });
    const b = m.check(input());
    expect(b.kind).toBe("hit");
    expect(b.cached?.itemIds).toEqual(["doc1#S1"]);
    expect(m.stats().hits).toBe(1);
    expect(m.stats().misses).toBe(1);
  });

  it("invalidates on a new user instruction even with similar wording (NTK-010)", () => {
    const m = new RetrievalStateManager();
    m.check(input());
    m.store(input(), { itemIds: ["doc1#S1"], empty: false });
    // A NEW instruction with similar wording (same task anchor, same user
    // text, turn counter advanced) must be a cache miss and re-retrieve.
    const next = m.check(input({ turnCount: 3 }));
    expect(next.kind).toBe("miss");
    expect(next.invalidation).toBe("input");
    expect(next.revision).toBe(2);
    // …and the cached selection is gone.
    expect(m.check(input({ turnCount: 3 })).kind).toBe("miss");
  });

  it("invalidates when the knowledge index changes (NTK-010)", () => {
    const m = new RetrievalStateManager();
    m.check(input());
    m.store(input(), { itemIds: ["doc1#S1"], empty: false });
    const next = m.check(input({ indexRevision: 2 }));
    expect(next.kind).toBe("miss");
    expect(next.invalidation).toBe("knowledge");
  });

  it("invalidates on context-window compaction", () => {
    const m = new RetrievalStateManager();
    m.check(input());
    m.store(input(), { itemIds: ["doc1#S1"], empty: false });
    const next = m.check(input({ compactionSeq: 1 }));
    expect(next.kind).toBe("miss");
    expect(next.invalidation).toBe("compaction");
  });

  it("invalidates when the task anchor changes and resets the cache", () => {
    const m = new RetrievalStateManager();
    m.check(input());
    m.store(input(), { itemIds: ["doc1#S1"], empty: false });
    m.invalidate("task");
    expect(m.check(input()).kind).toBe("miss");
  });

  it("caches empty results — a verified-empty state is reused, not recomputed (NTK-011)", () => {
    const m = new RetrievalStateManager();
    m.check(input());
    m.store(input(), { itemIds: [], empty: true });
    expect(m.check(input()).kind).toBe("hit");
    expect(m.check(input()).cached?.empty).toBe(true);
  });

  it("the fingerprint ignores display formatting and text position", () => {
    const a = computeStateFingerprint(input({ userText: "hello   world" }));
    const b = computeStateFingerprint(input({ userText: "hello world" }));
    expect(a).toBe(b);
  });

  it("invalidates when source-file activity changes (P0-4)", () => {
    const m = new RetrievalStateManager();
    m.check(input());
    m.store(input(), { itemIds: ["doc1#S1"], empty: false });
    // Opening a new component (activity list grows/reorders) must invalidate:
    // activity terms feed retrieval, so reuse would serve a stale selection.
    const next = m.check(input({ activityFingerprint: "src/billing/StripeSync.ts|docs/spec.md" }));
    expect(next.kind).toBe("miss");
    expect(next.invalidation).toBe("input");
    m.store(input({ activityFingerprint: "src/billing/StripeSync.ts|docs/spec.md" }), {
      itemIds: ["doc1#S1", "doc2#S2"],
      empty: false,
      knowledge: true,
    });
    // Same activity, same everything → hit; reorder is a change (recency matters).
    expect(m.check(input({ activityFingerprint: "src/billing/StripeSync.ts|docs/spec.md" })).kind).toBe("hit");
    expect(m.check(input({ activityFingerprint: "docs/spec.md|src/billing/StripeSync.ts" })).kind).toBe("miss");
  });
});

describe("external doc edits between dispatches (P1-11)", () => {
  it("a knowledge-revision change forces recomputation with the new content", async () => {
    const { makeTempProject, cleanupProject } = await import("./helpers.js");
    const { indexProjectFull, reindexFile, indexRevision } = await import("../src/index-store.js");
    const { DEFAULTS, runRetrieval } = await import("../src/core/retrieval.js");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const root = makeTempProject({
      "docs/guide.md": "# Guide\n\n## Deploy Steps\n\nDeploy the service with `make deploy`.\n",
    });
    try {
      const index = indexProjectFull(root, { force: true });
      const m = new RetrievalStateManager();
      const query = "deploy the service";
      const st: StateInput = {
        userText: query,
        turnCount: 1,
        taskFingerprint: "",
        nativeSignature: "",
        episodeId: "e",
        indexRevision: indexRevision(root),
        compactionSeq: 0,
        activityFingerprint: "",
      };
      m.check(st);
      const r1 = runRetrieval(index, query, new Set<string>(), DEFAULTS);
      m.store(st, { itemIds: r1.trace.items, empty: false });
      expect(r1.items[0]!.content).toContain("make deploy");

      // The file changes on disk outside the agent's tools (git pull, editor).
      fs.writeFileSync(
        path.join(root, "docs", "guide.md"),
        "# Guide\n\n## Deploy Steps\n\n" +
          "Deploy the service with `npm run ship`. The service now ships via npm run ship. " +
          "Deploy the service with `npm run ship` and verify the service responds.\n",
      );
      const before = indexRevision(root);
      reindexFile(root, "docs/guide.md"); // freshness probe / self-edit path
      expect(indexRevision(root)).toBeGreaterThan(before); // knowledge changed

      const st2: StateInput = { ...st, indexRevision: indexRevision(root) };
      const check = m.check(st2);
      expect(check.kind).toBe("miss");
      expect(check.invalidation).toBe("knowledge");
      const r2 = runRetrieval(indexProjectFull(root), query, new Set<string>(), DEFAULTS);
      expect(r2.items[0]!.content).toContain("npm run ship");
      expect(r2.items[0]!.content).not.toContain("with `make deploy`");
      m.store(st2, { itemIds: r2.trace.items, empty: false });
      expect(m.check(st2).kind).toBe("hit");
    } finally {
      cleanupProject(root);
    }
  });
});
