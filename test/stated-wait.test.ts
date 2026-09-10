// How long a provider said to wait, read out of what it said.
//
// This is the one number in the backoff that is not a guess. A free tier that
// answers "rate limited, retry after 23 seconds" has told us exactly when the
// next try can work, and every wait shorter than that spends a try being told
// the same thing again.
import { expect, test, describe } from "bun:test";
import { __testing } from "../src/frontend";

const { statedWait } = __testing as any;

describe("reading a wait out of an error", () => {
  test("nothing said is nothing read", () => {
    expect(statedWait("")).toBe(0);
    expect(statedWait(null)).toBe(0);
    expect(statedWait("429 too many requests")).toBe(0);
    expect(statedWait("the connection dropped")).toBe(0);
  });

  // The wordings providers actually use.
  test("seconds, in the shapes providers write them", () => {
    expect(statedWait("Rate limited. Retry after 23 seconds.")).toBe(23000);
    expect(statedWait("429: please try again in 5s")).toBe(5000);
    // The header form, which carries no unit and is always seconds.
    expect(statedWait("Too many requests, retry-after: 60")).toBe(60000);
    expect(statedWait("Retry-After: 12")).toBe(12000);
    expect(statedWait("quota exceeded, resets in 30 sec")).toBe(30000);
    expect(statedWait("Model overloaded. Try again in 2.5 seconds")).toBe(2500);
  });

  test("minutes and milliseconds are scaled", () => {
    expect(statedWait("rate limit reached, try again in 3 minutes")).toBe(180000);
    expect(statedWait("retry after 1 min")).toBe(60000);
    expect(statedWait("please wait 800ms")).toBe(800);
  });

  // A daily quota is not a thing to sit on a timer for.
  test("an hour is the ceiling", () => {
    expect(statedWait("quota resets in 20 hours")).toBe(0);
    expect(statedWait("try again in 600 minutes")).toBe(3600000);
  });

  // A number that is not a wait must not be read as one. These are the strings
  // that would break it: they carry a figure and a unit and mean something else.
  test("a figure that is not a wait is left alone", () => {
    expect(statedWait("model gpt-4o-mini-2024 is not available")).toBe(0);
    expect(statedWait("context length 8192 tokens exceeded")).toBe(0);
    expect(statedWait("HTTP 503 after 4 attempts")).toBe(0);
    // "after" on its own is not the header, and the number has a word on it.
    expect(statedWait("retry after 4 attempts")).toBe(0);
  });
});
