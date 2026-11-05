import { describe, expect, it } from "vitest";
import {
  contentWords,
  estimateTokens,
  identifiers,
  isStopword,
  sentences,
  sha256,
  similarity,
  stem,
  words,
} from "../src/core/tokenize.js";

describe("stem", () => {
  it("applies Porter stemming", () => {
    expect(stem("indexing")).toBe(stem("indexed"));
    expect(stem("indexes")).toBe("index");
    expect(stem("running")).toBe("run");
    expect(stem("deployment")).toBe("deploy");
  });

  it("stems every word of a phrase", () => {
    const parts = "retrieving documents".split(/\s+/).map(stem);
    expect(parts).toEqual([stem("retrieve"), stem("document")]);
  });

  it("is stable for short words", () => {
    expect(stem("run")).toBe("run");
    expect(stem("a")).toBe("a");
  });
});

describe("isStopword", () => {
  it("recognizes English stopwords and the extra doc-noise list", () => {
    expect(isStopword("the")).toBe(true);
    expect(isStopword("doc")).toBe(true);
    expect(isStopword("documentation")).toBe(true);
    expect(isStopword("configuration")).toBe(false);
  });

  it("matches lowercased stems (callers lowercase before stemming)", () => {
    expect(isStopword("the")).toBe(true);
    expect(isStopword("The")).toBe(false);
  });
});

describe("words / contentWords", () => {
  it("keeps lowercased word tokens, stopwords included", () => {
    expect(words("Deploy the App!")).toEqual(["deploy", "the", "app"]);
  });

  it("contentWords strips stopwords and 1-char tokens", () => {
    expect(contentWords("Deploy the app in a second")).toEqual(["deploi", "app", "second"]);
  });

  it("includes digit-initial tokens", () => {
    expect(contentWords("uses 2fa flows")).toContain("2fa");
  });
});

describe("identifiers", () => {
  it("extracts camelCase, snake_case, and SCREAMING identifiers plus their parts", () => {
    const ids = identifiers("use oauthToken and refresh_token and MAX_RETRY and oauthConsumerKey");
    expect(ids).toContain("oauthtoken");
    expect(ids).toContain("oauth");
    expect(ids).toContain("token");
    expect(ids).toContain("refresh_token");
    // Distinguishes oauthToken from oauthConsumerKey: `token` is a part of the
    // former only.
    expect(ids.filter((i) => i === "token")).toHaveLength(1);
  });

  it("keeps hyphenated technical terms whole and lowercased", () => {
    expect(identifiers("zero-config setup")).toContain("zero-config");
  });
});

describe("similarity", () => {
  it("is Jaro-Winkler over two strings", () => {
    expect(similarity("deploy", "deploy")).toBe(1);
    expect(similarity("deploy", "deployment")).toBeGreaterThan(0.9);
    expect(similarity("zebra", "deployment")).toBeLessThan(0.6);
    expect(similarity("", "")).toBeGreaterThanOrEqual(0);
  });

  it("ranks near-miss typos above unrelated words", () => {
    const typo = similarity("configuraton", "configuration");
    const unrelated = similarity("banana", "configuration");
    expect(typo).toBeGreaterThan(unrelated);
    expect(typo).toBeGreaterThan(0.9);
  });
});

describe("sha256", () => {
  it("is a stable hex digest", async () => {
    expect(await sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(await sha256("abc")).toBe(await sha256("abc"));
    expect(await sha256("abd")).not.toBe(await sha256("abc"));
  });
});

describe("estimateTokens", () => {
  it("estimates ~1 token per 3 chars with a ceil", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abc")).toBe(1);
    expect(estimateTokens("abcd")).toBe(2);
    const long = "x".repeat(400);
    expect(estimateTokens(long)).toBe(Math.ceil(400 / 3));
  });
});

describe("sentences", () => {
  it("splits on sentence boundaries", () => {
    expect(sentences("Hi. A longer valid sentence.")).toEqual(["Hi.", "A longer valid sentence."]);
  });

  it("does not split on embedded dots (versions, abbreviations)", () => {
    expect(sentences("Release v2.0 is out. Enjoy")).toEqual(["Release v2.0 is out.", "Enjoy"]);
    expect(sentences("See Dr. No. Run the tool. Done")).toEqual(["See Dr. No. Run the tool.", "Done"]);
  });

  it("keeps text with no terminator as a single sentence", () => {
    expect(sentences("no terminator here")).toEqual(["no terminator here"]);
  });
});
