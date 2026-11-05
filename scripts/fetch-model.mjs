#!/usr/bin/env node
// Fetch the optional TinyBERT-L2 cross-encoder into model/ (npm/CI publishing
// path; git ships model/README.md only). NTK is fully lexical without it.
import { mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const base = process.env["NTK_MODEL_URL"] ?? "";
const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "model");
const FILES = ["tinybert-l2-marco-int8.onnx", "vocab.txt"];

if (!base) {
  console.error(
    "fetch-model: set NTK_MODEL_URL to the canonical model export base URL\n" +
      "(files: " + FILES.join(", ") + " -> model/). Skipping; NTK runs lexical-only.",
  );
  process.exit(0);
}
mkdirSync(dir, { recursive: true });
for (const f of FILES) {
  const dest = join(dir, f);
  if (existsSync(dest)) {
    console.log(`model/${f}: present`);
    continue;
  }
  const res = await fetch(`${base.replace(/\/$/, "")}/${f}`);
  if (!res.ok) {
    console.error(`model/${f}: fetch failed (${res.status}); NTK runs lexical-only.`);
    continue;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  (await import("node:fs")).writeFileSync(dest, buf);
  console.log(`model/${f}: ${(buf.length / 1024 / 1024).toFixed(1)} MB`);
}
