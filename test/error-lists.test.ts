// Which provider errors are worth trying again, which are not, and what reads
// as a refusal.
//
// Auto Retry and Auto Refine keep the same lists, so the two agree. This file
// is the same in both repositories. A change to any of these lists goes into
// both, and into the samples and the mark below.
//
// Run with: bun test

import { expect, test, describe } from "bun:test";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../src/frontend.ts", import.meta.url), "utf8");

// The list as it is written in the source, read back as a pattern.
function read(name: string): RegExp {
  const m = new RegExp("const " + name + " =\\s*\\/([\\s\\S]*?)\\/i;").exec(SRC);
  if (!m) throw new Error(name + " was not found");
  return new RegExp(m[1], "i");
}
const HARD = read("HARD_ERROR");
const WAIT = read("WAIT_ERROR");

// The text of each list, the same in both extensions.
const HARD_TEXT =
  "\\b(?:400|401|402|403|404|405|406|411|413|415|422|invalid[_ ]?api[_ ]?key|authentication|unauthorized|forbidden|permission|not allowed|not found|does not exist|model missing|insufficient[_ ](?:balance|credits?|funds|quota)|billing|context[_ ]length(?:[_ ]exceeded)?|maximum context|(?:prompt|input|context|messages?) (?:is |are )?too long)\\b";
const WAIT_TEXT =
  "\\b(?:408|429|500|502|503|504|520|521|522|523|524)\\b|rate.?limit|too many requests|quota|overloaded|capacity|try again later|temporar(?:y|ily)|time(?:d ?| |-)?out|network|connection reset|socket hang up|econnrefused|econnreset|fetch failed";

describe("the two lists are the same as in the other extension", () => {
  test("errors that will not fix themselves", () => {
    expect(HARD.source).toBe(HARD_TEXT);
  });
  test("errors worth waiting out", () => {
    expect(WAIT.source).toBe(WAIT_TEXT);
  });
});

// Made-up errors in the shapes providers send.
const WONT_FIX = [
  "401 Unauthorized",
  "Invalid API key provided",
  "invalid_api_key",
  "403 Forbidden: permission denied for this model",
  "404 model not found",
  "The model `lantern-9` does not exist",
  "402 Payment Required",
  "429 You exceeded your current quota: insufficient_quota",
  "insufficient credits on this account",
  "This model's maximum context length is 8192 tokens",
  "context_length_exceeded",
  "prompt is too long: 210000 tokens",
  "billing hard limit reached",
];
const WAIT_IT_OUT = [
  "429 Too Many Requests",
  "Rate limit reached for requests",
  "503 Service Unavailable: the model is loading",
  "502 Bad Gateway",
  "The server is overloaded, try again later",
  "Request timed out",
  "ETIMEDOUT",
  "socket hang up",
  "ECONNRESET",
  "fetch failed",
  "524 A timeout occurred",
  "Model is at capacity",
];
// Neither: a timeout is not a context error, and these stay worth waiting out.
const NOT_HARD = ["The request took too long to respond", "Request timed out", "529 overloaded"];

describe("each error is read the same way in both extensions", () => {
  for (const e of WONT_FIX) test("will not fix itself: " + e, () => expect(HARD.test(e)).toBe(true));
  for (const e of WAIT_IT_OUT) {
    test("worth waiting out: " + e, () => {
      expect(WAIT.test(e)).toBe(true);
      expect(HARD.test(e)).toBe(false);
    });
  }
  for (const e of NOT_HARD) test("not a hard failure: " + e, () => expect(HARD.test(e)).toBe(false));
});

// The refusal lists: the strong patterns, the subjects, the phrases, and the
// pattern for a refusal sent as an error. The mark is worked out from their
// text, with comments and indentation left out, and is the same in both
// extensions. A list changed in one and not the other changes the mark.
describe("the refusal lists are the same as in the other extension", () => {
  const listText = (name: string) => {
    const at = SRC.indexOf("\nconst " + name);
    if (at < 0) throw new Error(name + " was not found");
    const end = SRC.indexOf(";\n", SRC.indexOf("=", at));
    return SRC.slice(at, end).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("//")).join("\n");
  };
  test("their mark matches", () => {
    const all = ["REFUSAL_STRONG", "REFUSED_SUBJECT", "REFUSAL_SUBJECT", "REFUSAL_PHRASES", "REFUSAL_ERROR"].map(listText).join("\n");
    let h = 2166136261;
    for (let i = 0; i < all.length; i++) {
      h ^= all.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    expect(h.toString(16)).toBe("ee763962");
  });
});
