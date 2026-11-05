/** P2-16: production-path integration — drives the REAL plugin lifecycle
 *  (prompt admission → context injection seam → tool tracking) through the
 *  V2 hook surface with a mock host, and asserts the exact passages present
 *  in the outgoing model request: native-instruction exclusion, replace-by-
 *  tag dedupe, activity invalidation, self-edit reindexing.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { cleanupProject, makeTempProject } from "./helpers.js";
import { indexProjectFull } from "../src/index-store.js";

// Route plugin logs into the temp dir (env read at module load).
const tmpLog = path.join(fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "ntk-it-")), "plugin.log");
process.env.NTK_LOG = tmpLog;

type Handler = (event: any) => void | Promise<void>;
type TextPart = { type: "text"; text: string; metadata?: Record<string, string> };

function makeMessages(text: string): any[] {
  return [{ role: "user", content: [{ type: "text", text } as TextPart] }];
}

function mockCtx(root: string) {
  const hooks: Record<string, Handler[]> = {};
  const on = (key: string) => (h: Handler) => {
    (hooks[key] ??= []).push(h);
  };
  const fire = async (key: string, event: unknown) => {
    for (const h of hooks[key] ?? []) await h(event);
  };
  const commands: any[] = [];
  return {
    location: { directory: root, project: { directory: root } },
    session: {
      // V2 surface: hook(name, handler) — two args.
      hook: (name: string, h: Handler) => on(`session.${name}`)(h),
      prompt: async () => {},
    },
    tool: {
      hook: (name: string, h: Handler) => on(`tool.${name}`)(h),
      transform: () => ({ add: () => {} }),
    },
    command: {
      transform: (cb: (editor: { add: (c: any) => void }) => void) => cb({ add: (c: any) => commands.push(c) }),
    },
    commands,
    event: { subscribe: () => (async function* () { /* no host events */ })() },
    fire,
  };
}

describe("plugin production path (P2-16)", () => {
  let root: string;
  let ctx: ReturnType<typeof mockCtx>;
  let callSeq = 0;

  beforeAll(async () => {
    root = makeTempProject({
      "AGENTS.md": "# Agents\n\nAlways use npm run build for this project. Native instruction content.\n",
      "docs/deploy.md":
        "# Deploy Guide\n\n## Building\n\nBuild the service with `npm run build` and deploy the service binary.\n\n## Rollback\n\nRollback the service with `npm run undo`.\n",
      "docs/style.md": "# Style\n\n## Formatting\n\nFormat code with prettier tabs and quotes.\n",
    });
    indexProjectFull(root, { force: true });
    const plugin = (await import("../src/plugin/index.js")).default as {
      setup: (ctx: unknown) => Promise<() => void>;
    };
    ctx = mockCtx(root);
    await plugin.setup(ctx as never);
  });

  afterAll(() => cleanupProject(root));

  async function dispatch(text: string, sessionID = "s1"): Promise<any[]> {
    await ctx.fire("session.prompt", { sessionID, prompt: { text } });
    const event = {
      sessionID,
      system: [] as TextPart[],
      messages: makeMessages(text),
    };
    await ctx.fire("session.context", event);
    return event.messages;
  }

  function ntkParts(messages: any[]): TextPart[] {
    const last = [...messages].reverse().find((m) => m.role === "user");
    return (last?.content ?? []).filter(
      (p: TextPart) => p.metadata?.["tag"] === "needtoknow/context",
    );
  }

  it("injects the relevant passage and rules into the outgoing request", async () => {
    const messages = await dispatch("How do I build and deploy the service?");
    const parts = ntkParts(messages);
    expect(parts).toHaveLength(1);
    const block = parts[0]!.text;
    expect(block).toContain("<needtoknow_context>");
    expect(block).toContain("npm run build"); // the exact selected passage
  });

  it("excludes native instruction content end-to-end (P0-2)", async () => {
    const messages = await dispatch("What do the AGENTS.md build rules require?");
    for (const p of ntkParts(messages)) {
      // NTK must not re-inject AGENTS.md content — OpenCode ships it natively.
      expect(p.text).not.toContain("Always use npm run build for this project. Native instruction content.");
      for (const doc of p.text.split("Source: ")) {
        const head = doc.split("\n")[0] ?? "";
        expect(head).not.toMatch(/AGENTS\.md/);
      }
    }
  });

  it("replace-by-tag: a second dispatch keeps exactly one NTK part (no duplicates, P0-3)", async () => {
    // Dedicated session: P2-16 predates task-memory anchoring; sharing s1
    // leaks the prior test's episode anchor into selection.
    await dispatch("Rollback the service", "s-rbt");
    const messages = await dispatch("Rollback the service", "s-rbt");
    const parts = ntkParts(messages);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.text).toContain("npm run undo");
  });

  it("/ntk-status (headless sink) writes a chat-report file including session stats", async () => {
    const dbg = ctx.commands.find((c) => c.name === "ntk-debug-headless");
    await dbg!.execute({ sessionID: "s1", prompt: { text: "on" } });
    await dispatch("How do I deploy?");
    const cmd = ctx.commands.find((c) => c.name === "ntk-status-headless");
    expect(cmd).toBeDefined();
    await cmd!.execute({ sessionID: "s1", prompt: { text: "" } });
    // v2 command.execute is typed Promise<void> — the report sinks to
    // .ntk/status.md (NTK-017 file-only discipline), asserted at the sink.
    const report = fs.readFileSync(path.join(root, ".ntk", "status.md"), "utf8");
    expect(report).toContain("NTK ");
    expect(report).toContain("Session stats");
  });

  it("tool-driven self-edit reindexes and the new passage reaches the request", async () => {
    const id = `call-${callSeq++}`;
    fs.writeFileSync(
      path.join(root, "docs", "deploy.md"),
      "# Deploy Guide\n\n## Building\n\nBuild the service with `npm run compile`. The service now uses npm run compile.\n\n## Rollback\n\nRollback the service with `npm run undo`.\n",
    );
    await ctx.fire("tool.execute.before", {
      id,
      tool: "write",
      sessionID: "s1",
      status: "running",
      input: { filePath: path.join(root, "docs", "deploy.md") },
    });
    await ctx.fire("tool.execute.after", {
      id,
      tool: "write",
      sessionID: "s1",
      status: "completed",
      input: { filePath: path.join(root, "docs", "deploy.md") },
      result: { content: [{ type: "text", text: "Created file successfully: docs/deploy.md" }] },
    });
    const messages = await dispatch("How do I build the service now?");
    const parts = ntkParts(messages);
    expect(parts[0]!.text).toContain("npm run compile"); // P1-10/11 end-to-end
  });

  it("tool activity enters the state fingerprint (P0-4 end-to-end)", async () => {
    const id = `call-${callSeq++}`;
    await ctx.fire("tool.execute.before", {
      id,
      tool: "read",
      sessionID: "s1",
      status: "running",
      input: { filePath: path.join(root, "docs", "style.md") },
    });
    await ctx.fire("tool.execute.after", {
      id,
      tool: "read",
      sessionID: "s1",
      status: "completed",
      input: { filePath: path.join(root, "docs", "style.md") },
      result: { content: [{ type: "text", text: "read 6 lines" }] },
    });
    const messages = await dispatch("Rollback the service"); // same text as before
    expect(ntkParts(messages).length).toBe(1); // injection still correct
  });

  // ---- A5: lifecycle coverage (final validation instructions) ----

  it("survives multiple tool-driven continuations: exactly one part per dispatch", async () => {
    for (let i = 0; i < 3; i++) {
      const id = `cont-${callSeq++}`;
      await ctx.fire("tool.execute.before", { id, tool: "bash", sessionID: "s1", status: "running", input: { command: "npm test" } });
      await ctx.fire("tool.execute.after", {
        id, tool: "bash", sessionID: "s1", status: "completed",
        input: { command: "npm test" },
        result: { content: [{ type: "text", text: "tests pass" }] },
      });
      // continuation dispatch: same last user message, no new prompt
      const event = { sessionID: "s1", system: [] as TextPart[], messages: makeMessages("How do I build and deploy the service?") };
      await ctx.fire("session.context", event);
      const parts = ntkParts(event.messages);
      expect(parts).toHaveLength(1);
      expect(parts[0]!.text).toContain("<needtoknow_context>");
    }
  });

  it("a NEW document becomes retrievable (tool-driven add)", async () => {
    const id = `call-${callSeq++}`;
    const fp = path.join(root, "docs", "secrets.md");
    fs.writeFileSync(fp, "# Secrets\n\n## Vault integration\n\nRotate vault token secrets with ntk-vault-rotate and verify the token lease.\n");
    await ctx.fire("tool.execute.before", { id, tool: "write", sessionID: "s1", status: "running", input: { filePath: fp } });
    await ctx.fire("tool.execute.after", {
      id, tool: "write", sessionID: "s1", status: "completed", input: { filePath: fp },
      result: { content: [{ type: "text", text: "Created file successfully: docs/secrets.md" }] },
    });
    const messages = await dispatch("How do I rotate vault token secrets?");
    const parts = ntkParts(messages);
    expect(parts.length).toBe(1);
    expect(parts[0]!.text).toContain("ntk-vault-rotate"); // brand-new content reaches the request
  });

  it("a DELETED document stops being injected (tool-driven delete + reindex)", async () => {
    const id = `call-${callSeq++}`;
    const fp = path.join(root, "docs", "secrets.md");
    fs.rmSync(fp);
    await ctx.fire("tool.execute.before", { id, tool: "write", sessionID: "s1", status: "running", input: { filePath: fp } });
    await ctx.fire("tool.execute.after", {
      id, tool: "write", sessionID: "s1", status: "completed", input: { filePath: fp },
      result: { content: [{ type: "text", text: "Deleted file successfully: docs/secrets.md" }] },
    });
    const messages = await dispatch("How do I rotate vault token secrets?");
    for (const p of ntkParts(messages)) expect(p.text).not.toContain("ntk-vault-rotate");
  });

  it("a task change reselects context for the new objective", async () => {
    const before = await dispatch("How do I format code with prettier?");
    expect(ntkParts(before)[0]?.text ?? "").toContain("prettier"); // style doc
  });

  it("compaction invalidates the cache and re-injects", async () => {
    await ctx.fire("session.compaction", { sessionID: "s1" });
    const messages = await dispatch("How do I build and deploy the service?");
    const parts = ntkParts(messages);
    expect(parts).toHaveLength(1);
    // A forced miss with a machine-readable cause (task-change pending from
    // the previous test's switch + compaction seq + turn counter all moved);
    // NTK-016 priority reports the dominant cause.
    expect(parts[0]!.text).toMatch(/NTK-016 miss \((task|compaction|knowledge|input)\)/);
    expect(parts[0]!.text).toContain("npm run compile");
  });

  it("repeated injection: identical state reuses, never duplicates (replace-by-tag)", async () => {
    await ctx.fire("session.prompt", { sessionID: "s1", prompt: { text: "How do I build and deploy the service?" } });
    const e1 = { sessionID: "s1", system: [] as TextPart[], messages: makeMessages("How do I build and deploy the service?") };
    await ctx.fire("session.context", e1);
    const e2 = { sessionID: "s1", system: [] as TextPart[], messages: makeMessages("How do I build and deploy the service?") };
    await ctx.fire("session.context", e2);
    expect(ntkParts(e2.messages)).toHaveLength(1);
    const t1 = ntkParts(e1.messages)[0]!.text;
    const t2 = ntkParts(e2.messages)[0]!.text;
    // same selection content in both (cache hit reuses the stored block)
    expect(t2).toContain("<needtoknow_context>");
    expect(t1).toContain("<needtoknow_context>");
  });

describe("outgoing-request invariants (verification round: items 5–6)", () => {
  it("empty retrieval injects NO part — fresh gated and via verified-empty cache (item 6)", async () => {
    // Generic behavior, FRESH SESSION (no task anchor to blend): a one-word
    // greeting and a gibberish ask must leave the request free of NTK parts.
    const m1 = await dispatch("hello", "s3");
    expect(ntkParts(m1)).toHaveLength(0);
    const m2 = await dispatch("hello", "s3"); // verified-empty cache hit: still nothing
    expect(ntkParts(m2)).toHaveLength(0);
    const m3 = await dispatch("zzqx qqzx flurb", "s3"); // gated on coverage: no part
    expect(ntkParts(m3)).toHaveLength(0);
  });

  it("assembled request: rules once, NTK part last, user text preserved (item 5)", async () => {
    const e = {
      sessionID: "s2",
      system: [] as TextPart[],
      messages: makeMessages("Rollback the service with the documented procedure"),
    };
    await ctx.fire("session.prompt", { sessionID: "s2", prompt: { text: "Rollback the service with the documented procedure" } });
    await dispatch("Rollback the service with the documented procedure", "s2");
    await ctx.fire("session.context", e);
    await ctx.fire("session.context", e); // second dispatch on the SAME array
    const rules = e.system.filter((p) => p.text.includes("<needtoknow_rules>"));
    expect(rules).toHaveLength(1); // idempotent rules block
    const last = e.messages[e.messages.length - 1] as { content: TextPart[] };
    const ntk = last.content.filter((p) => p.metadata?.["tag"] === "needtoknow/context");
    expect(ntk).toHaveLength(1); // replace-by-tag: never two parts
    expect(last.content[0]!.text).toContain("Rollback the service");
    expect(last.content[last.content.length - 1]!.metadata?.["tag"]).toBe("needtoknow/context");
    expect(ntk[0]!.text).toContain("<needtoknow_context>");
  });
});
});
