/** Paste isolation (turn-7 audit): a clear question following a large pasted
 *  block is the retrieval query; the paste is data. Structural rules only —
 *  no vocabulary, no thresholds (tokenize.ts:isolatePastedRequest). */
import { describe, expect, it } from "vitest";
import { isolatePastedRequest } from "../src/core/tokenize.js";

const MENU =
  "SubagentsShellTerminalsescshow inactive ctrl+atabs ←/→… Switch agent… One-shot answer from the session's context without adding to the conversation… Change working directory… Clear session… Compact session… Connect an integration… Switch session… Copy last assistant message… View debug info… Open diff viewer… Open editor… Switch model variant… Exit the app… Export session transcript… Fork session… keep working until an objective is met [pause|resume|clear]… Help… Show release highlights… guided AGENTS.md setup… MCP servers… Switch model… New session… NeedToKnow debug mode: file-only decision audit (.ntk/debug.jsonl + plugin log) (on | off | status)… NeedToKnow diagnostics (index, cache, retrieval preview) → plugin log + .ntk/status.md.… Plugins… Reload configuration… Rename session… Restart service… review changes [commit|branch|pr], defaults to uncommitted… Open settings… Skills… Usage statistics… New terminal… Switch theme… Jump to message… Undo previous message… Update OpenCode… Manage workspaces";
const QUESTION = "When will this project be considered complete?";

describe("paste isolation (menu-paste + trailing question)", () => {
  it("isolates the trailing question from a large menu paste", () => {
    const out = isolatePastedRequest(`${MENU}\n${QUESTION} "`);
    expect(out).not.toBeNull();
    expect(out!).toContain("considered complete");
    // menu noise is out of the query
    expect(out!).not.toMatch(/Switch agent|Pair device|Usage statistics/);
    // citations from the paste survive (identifiers; leading dot is a
    // boundary, so the code token is preserved as `ntk/debug.jsonl`)
    expect(out!).toContain("debug.jsonl");
  });

  it("menu-only prompt: no trailing question → full text kept (gate declines)", () => {
    expect(isolatePastedRequest(MENU)).toBeNull();
  });

  it("short prompts are untouched (zero-config: never fires on normal turns)", () => {
    const q = "When will this project be considered complete?";
    expect(isolatePastedRequest(q)).toBeNull();
    expect(isolatePastedRequest("What is in phase 2?")).toBeNull();
  });

  it("questions ABOUT pasted code keep the paste (deictic + code bulk)", () => {
    const code = [
      "```python",
      "def compute(a, b):",
      "    return a / b - ConnectionPool.max_items",
      "",
      "class StripeSync:",
      "    def run(self, x):",
      "        return x.invalid_method()",
      "```",
      "x".repeat(420),
    ].join("\n");
    expect(isolatePastedRequest(`${code}\nWhy does this code crash?`)).toBeNull();
    // fenced block below the code shape, deictic phrase in the question
    const prose = "a".repeat(420);
    expect(isolatePastedRequest(`${prose}\nWhat does the above error mean?`)).toBeNull();
  });

  it("preserves quoted 《titles》 from the paste", () => {
    const bulk = ("menu item… ".repeat(50) + "See 《Deployment Guide》 for setup… ").repeat(3);
    const out = isolatePastedRequest(`${bulk}\nWhen will this project be considered complete?`);
    expect(out).not.toBeNull();
    expect(out!).toContain("Deployment Guide");
  });

  it("a long second paragraph of prose (no paste shape) is kept whole", () => {
    const prose = "The retrieval design blends anchors. ".repeat(20); // no ?-tail, no ellipsis bulk
    expect(isolatePastedRequest(`${prose}\nDoes caching preserve order?`)).toBeNull();
  });
});
