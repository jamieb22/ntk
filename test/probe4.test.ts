import { describe, expect, it } from "vitest";
import { indexProjectFull } from "../src/index-store.js";
import { DEFAULTS, renderContextTag, runRetrieval, type RetrievalOptions } from "../src/core/retrieval.js";
import { cleanupProject, makeTempProject, standardCorpus } from "./helpers.js";

describe("probe4", () => {
  it("prints canonical shapes", () => {
    const root = makeTempProject(standardCorpus());
    try {
      const index = indexProjectFull(root);
      const passes: Required<RetrievalOptions> = DEFAULTS;
      const r = runRetrieval(index, "How do I deploy the service?", new Set<string>(), passes);
      console.log("TRACE_KEYS=" + JSON.stringify(Object.keys(r.trace)));
      console.log("TRACE=" + JSON.stringify(r.trace));
      console.log("ITEMS=" + JSON.stringify(r.items.map((i) => ({
        docPath: i.docPath, docTitle: i.docTitle, heading: i.heading, sectionPath: i.sectionPath,
        level: i.level, tokens: i.tokens, compression: i.compression,
        contentInclHeading: i.content.includes(i.heading), contentHead: i.content.slice(0, 60),
      })), null, 1));
      console.log("RENDER=" + JSON.stringify(renderContextTag(r.items).slice(0, 400)));
      const v = runRetrieval(index, "How do I deploy the service?", new Set<string>());
      console.log("VAGUE=" + JSON.stringify({ n: v.items.length, passedGate: v.trace.passedGate, gateReason: (v.trace as Record<string, unknown>)["gateReason"] }));
      const h = runRetrieval(index, "hello", new Set<string>());
      console.log("HELLO=" + JSON.stringify({ n: h.items.length, candidates: (h.trace as Record<string, unknown>)["candidates"] }));
      const x = runRetrieval(index, "xylophone quantum flux capacitor", new Set<string>());
      console.log("XYLO=" + JSON.stringify({ n: x.items.length, candidates: (x.trace as Record<string, unknown>)["candidates"] }));
      expect(true).toBe(true);
    } finally {
      cleanupProject(root);
    }
  });
});
