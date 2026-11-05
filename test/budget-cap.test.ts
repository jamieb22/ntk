import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { cleanupProject, makeTempProject } from "./helpers.js";
import { indexProjectFull } from "../src/index-store.js";

/** Ceremony accounting: the tokenBudget caps CONTENT (the ladder enforces
 *  that inside runRetrieval); the ceremony (tag, preamble, Source lines,
 *  footer) rides ON TOP, bounded by maxItems, and the block is declined only
 *  when the ceremony alone exceeds the budget (pathological tiny budgets). */

type Handler = (event: any) => void | Promise<void>;
type TextPart = { type: "text"; text: string; metadata?: Record<string, string> };

function mockCtx(root: string) {
  const hooks: Record<string, Handler[]> = {};
  const on = (key: string) => (h: Handler) => {
    (hooks[key] ??= []).push(h);
  };
  const fire = async (key: string, event: unknown) => {
    for (const h of hooks[key] ?? []) await h(event);
  };
  return {
    location: { directory: root, project: { directory: root } },
    session: {
      hook: (name: string, h: Handler) => on(`session.${name}`)(h),
      prompt: async () => {},
    },
    tool: {
      hook: (name: string, h: Handler) => on(`tool.${name}`)(h),
      transform: () => ({ add: () => {} }),
    },
    command: { transform: () => ({ add: () => {} }) },
    event: { subscribe: () => (async function* () { /* no host events */ })() },
    fire,
  };
}

const tmpLog = path.join(fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "ntk-cap-")), "plugin.log");
process.env.NTK_LOG = tmpLog;

const corpus = () => {
  const body = (w: string) =>
    Array.from(
      { length: 14 },
      (_, i) =>
        `${w} report metrics pipeline zulu yankee topic ${i} extra words here to stretch the sentence.`,
    ).join(" ");
  return {
    "docs/alpha.md": `# Alpha\n\n## Alpha overview\n\n${body("alpha")}\n`,
    "docs/bravo.md": `# Bravo\n\n## Bravo overview\n\n${body("bravo")}\n`,
    "docs/charlie.md": `# Charlie\n\n## Charlie overview\n\n${body("charlie")}\n`,
  };
};

async function boot(root: string, budget: string) {
  process.env.NTK_TOKEN_BUDGET = budget;
  vi.resetModules(); // fresh registry so DEFAULTS re-reads the env budget
  const plugin = (await import("../src/plugin/index.js")).default as {
    setup: (ctx: unknown) => Promise<() => void>;
  };
  const ctx = mockCtx(root);
  await plugin.setup(ctx as never);
  return ctx;
}

function ntkText(messages: any[]): string {
  const parts: TextPart[] = messages[0]?.content ?? [];
  const block = parts
    .map((p) => (p.text || "").match(/<needtoknow_context>[\s\S]*?<!-- ntk-status:.*?-->/)?.[0])
    .filter(Boolean);
  return block.join("\n");
}

async function dispatch(ctx: ReturnType<typeof mockCtx>, text: string, sessionID: string) {
  await ctx.fire("session.prompt", { sessionID, prompt: { text } });
  const event = { sessionID, system: [] as TextPart[], messages: [{ role: "user", content: [{ type: "text", text } as TextPart] }] };
  await ctx.fire("session.context", event);
  return event.messages;
}

describe("ceremony accounting (budget 260: content capped, ceremony additive)", () => {
  let root: string;
  let ctx: Awaited<ReturnType<typeof boot>>;

  beforeAll(async () => {
    root = makeTempProject(corpus());
    indexProjectFull(root, { force: true });
    ctx = await boot(root, "260");
  });
  afterAll(() => {
    delete process.env.NTK_TOKEN_BUDGET;
    cleanupProject(root);
  });

  it("ships content up to the budget with the ceremony riding on top", async () => {
    const messages = await dispatch(ctx, "alpha overview metrics", "cap1");
    const text = ntkText(messages);
    expect(text).toContain("needtoknow_context");
    expect(text).toContain("Alpha overview"); // section body present, not squeezed out
    // Block ≤ content budget + bounded ceremony (maxItems×~20 + fixed ~50).
    expect(Math.round(text.length / 3)).toBeLessThanOrEqual(260 + 170);
  });
});

describe("ceremony guard (budget 30: ceremony alone busts the cap)", () => {
  let root: string;
  let ctx: Awaited<ReturnType<typeof boot>>;

  beforeAll(async () => {
    root = makeTempProject(corpus());
    indexProjectFull(root, { force: true });
    ctx = await boot(root, "30");
  });
  afterAll(() => {
    delete process.env.NTK_TOKEN_BUDGET;
    cleanupProject(root);
  });

  it("declines the injection when the ceremony exceeds the budget", async () => {
    const messages = await dispatch(ctx, "bravo overview metrics", "cap2");
    expect(ntkText(messages)).toBe("");
  });
});
