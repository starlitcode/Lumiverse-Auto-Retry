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

// A list as it is written in the source, read back as a pattern.
function read(name: string): RegExp {
  const m = new RegExp("const " + name + " =\\s*\\/([\\s\\S]*?)\\/(i?);").exec(SRC);
  if (!m) throw new Error(name + " was not found");
  return new RegExp(m[1], m[2]);
}
const STATED_STATUS = read("STATED_STATUS");
const GATEWAY_STATUS = read("GATEWAY_STATUS");
const WAIT_STATUS = read("WAIT_STATUS");
const HARD_STATUS = read("HARD_STATUS");
const HARD_SURE = read("HARD_SURE");
const HARD_LOOSE = read("HARD_LOOSE");
const WAIT_ERROR = read("WAIT_ERROR");

// The function as it is written in the source, run on the lists above.
const errorKind: (text: string) => string = (() => {
  const at = SRC.indexOf("\nfunction errorKind(text: string): string {");
  if (at < 0) throw new Error("errorKind was not found");
  const end = SRC.indexOf("\n}\n", at);
  const body = SRC.slice(SRC.indexOf("{", at) + 1, end);
  // eslint-disable-next-line no-new-func
  return new Function(
    "STATED_STATUS", "GATEWAY_STATUS", "WAIT_STATUS", "HARD_STATUS", "HARD_SURE", "HARD_LOOSE", "WAIT_ERROR",
    "return function (text) {" + body + "\n}",
  )(STATED_STATUS, GATEWAY_STATUS, WAIT_STATUS, HARD_STATUS, HARD_SURE, HARD_LOOSE, WAIT_ERROR);
})();

// The whole block, from its heading to the end of errorKind, with the two
// kinds of quotation mark read as one. The mark is the same in both
// extensions, so a list changed in one and not the other changes it.
describe("the error lists are the same as in the other extension", () => {
  test("their mark matches", () => {
    const at = SRC.indexOf("// ---- which errors are worth trying again ----");
    const end = SRC.indexOf("\n}\n", SRC.indexOf("\nfunction errorKind(", at));
    expect(at).toBeGreaterThan(0);
    const all = SRC.slice(at, end).replace(/'/g, '"');
    let h = 2166136261;
    for (let i = 0; i < all.length; i++) {
      h ^= all.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    expect(h.toString(16)).toBe("315b75bd");
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
  // A daily limit: waiting minutes does not bring it back, only the next day.
  "429 You have reached your daily request limit",
  "Today’s quota is used up, come back tomorrow",
  "Quota exceeded for metric: GenerateRequestsPerDay",
  "429: limit reached, it resets at midnight UTC",
  // As Lumiverse writes a failed call, with the status in parentheses.
  "Lantern stream failed (401): Unauthorized",
  "Lantern stream failed (404): The model `lantern-9` does not exist",
  "Lantern request failed (400): Bad Request",
  "Lantern stream failed (429): You exceeded your current quota, please check your plan and billing details",
  "Lantern stream failed (500): upstream said the model was not found",
  // The account is the problem, whatever the gateway's status.
  "Lantern stream failed (502): insufficient balance on the upstream account",
  "Lantern stream failed (503): Invalid API key",
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
  "529 overloaded",
  "Bad Gateway",
  "Service Unavailable",
  "Internal Server Error",
  "Provider returned error",
  "terminated",
  "Unable to connect. Is the computer able to access the url?",
  "The socket connection was closed unexpectedly",
  "The provider connection closed before the full response arrived. The network dropped the stream.",
  // As Lumiverse writes a failed call.
  "Lantern (OpenAI-compatible) stream failed (504): Gateway Timeout",
  "Lantern (OpenAI-compatible) stream failed (502): Bad Gateway",
  "Lantern request failed (500): Internal Server Error",
  "Lantern stream failed (503): no healthy upstream",
  "upstream connect error or disconnect before headers",
  "no healthy upstream",
  "Lantern stream failed (520): Web server is returning an unknown error",
  "Lantern stream failed (529): Overloaded",
  "Lantern stream failed (530): Origin DNS error",
  "Lantern stream failed (507): Insufficient Storage",
  "Lantern stream failed (409): Conflict",
  "Lantern stream failed (425): Too Early",
  "Lantern request failed: The socket connection was closed unexpectedly",
  // A gateway's own page, which says "not found" or "permission" about itself.
  "Lantern stream failed (502): 404 page not found",
  "Lantern stream failed (504): the upstream host was not found",
  "Lantern stream failed (503): this gateway does not have permission to reach the origin",
  // A number in the detail is not a status.
  "Lantern stream failed (429): Rate limit reached. Please try again in 2.404 seconds",
  "Lantern stream failed (429): Limit 400, Used 400, Requested 1",
];
// Neither: nothing in these says the call can or cannot work next time.
const NOT_KNOWN = ["Lantern generation failed: the answer could not be read", "Something went wrong", "the upstream sent back a malformed answer"];
// Not hard: a timeout is not a context error.
const NOT_HARD = ["The request took too long to respond", "Request timed out", "429 rate limit: 20 requests per minute"];

describe("each error is read the same way in both extensions", () => {
  for (const e of WONT_FIX) test("will not fix itself: " + e, () => expect(errorKind(e)).toBe("hard"));
  for (const e of WAIT_IT_OUT) test("worth waiting out: " + e, () => expect(errorKind(e)).toBe("wait"));
  for (const e of NOT_KNOWN) test("neither: " + e, () => expect(errorKind(e)).toBe(""));
  for (const e of NOT_HARD) test("not a hard failure: " + e, () => expect(errorKind(e)).not.toBe("hard"));
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
