// Hints that quote a default have to quote the real one.
//
// Five hints spelled their default out by hand, and every one went stale the
// moment the timings were retuned: the panel said the longest wait was 30
// seconds while the extension waited 60, and that a stalled reply got 90
// seconds when it got three minutes. A wrong number in a hint is worse than no
// number, because it is the one thing in the row someone will trust over the
// box beside it, and nothing failed when it drifted.
//
// The hints are built from the defaults block now, and this is what keeps them
// that way. It reads the real form, not the source text, so it holds whatever
// the panel would actually show a person.
//
// Run with: bun test

import { expect, test, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { __testing } from "../src/frontend";

const { CONFIG, SCHEMA } = __testing as any;

const FIELDS: Array<{ key: string; label: string; hint: string }> = [];
for (const g of SCHEMA)
  for (const f of g.fields)
    FIELDS.push({ key: f.key, label: f.label, hint: String(f.hint || "") });

// Every number the defaults block holds, as text, so a hint can be checked
// against the whole set rather than one key at a time.
const DEFAULT_NUMBERS = new Set<string>();
for (const k of Object.keys(CONFIG)) {
  const v = (CONFIG as any)[k];
  if (typeof v === "number") DEFAULT_NUMBERS.add(String(v));
}

// The settings whose hint promises to name their own default. Listed rather
// than inferred: a hint may mention a number that is not a default at all
// ("3 to 5 suits most people"), and only these make that promise.
const QUOTES_ITS_DEFAULT = [
  "retryDelayMs",
  "maxDelayMs",
  "rateLimitDelayMs",
  "stuckTimeoutMs",
  "idleTimeoutMs",
  "floatingToggleSize",
  "breakerRuns",
  "refusalMaxChars",
  "swapWaitSecs",
];

describe("a hint that names a default names the real one", () => {
  test("the form was found at all", () => {
    // Guards the check itself. A rename that emptied this list would otherwise
    // leave every test below passing over nothing.
    expect(FIELDS.length).toBeGreaterThan(30);
    expect(DEFAULT_NUMBERS.size).toBeGreaterThan(10);
  });

  for (const key of QUOTES_ITS_DEFAULT) {
    test(key + " states its shipped value", () => {
      const f = FIELDS.find((x) => x.key === key);
      expect(f).toBeDefined();
      expect(f!.hint).toContain(String((CONFIG as any)[key]));
    });
  }

  // The catch-all, and the one that would have caught the original drift. Any
  // number of three digits or more in any hint has to be a value the extension
  // actually ships. A hand-written 30000 next to a default of 60000 fails here
  // whichever setting it was written under.
  test("no hint carries a number the extension does not ship", () => {
    const bad: Array<{ key: string; number: string }> = [];
    for (const f of FIELDS) {
      for (const m of f.hint.matchAll(/\b(\d{3,})\b/g)) {
        if (!DEFAULT_NUMBERS.has(m[1])) bad.push({ key: f.key, number: m[1] });
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("the timings read the way a person would say them", () => {
  // Rendered the same way the panel renders it, so a change that made
  // "180000 = 180 seconds" reach a user shows up here.
  const human = (ms: number) => {
    if (ms >= 60000 && ms % 60000 === 0) {
      const m = ms / 60000;
      return m + (m === 1 ? " minute" : " minutes");
    }
    const s = ms / 1000;
    return s + (s === 1 ? " second" : " seconds");
  };

  const shown = (key: string) =>
    FIELDS.find((f) => f.key === key)!.hint;

  test("each millisecond setting is also given in plain words", () => {
    for (const key of ["retryDelayMs", "maxDelayMs", "rateLimitDelayMs", "stuckTimeoutMs", "idleTimeoutMs"]) {
      expect(shown(key)).toContain(human(Number((CONFIG as any)[key])));
    }
  });

  test("and the plain words are the ones we expect to ship", () => {
    expect(human(CONFIG.retryDelayMs)).toBe("2 seconds");
    expect(human(CONFIG.maxDelayMs)).toBe("1 minute");
    expect(human(CONFIG.rateLimitDelayMs)).toBe("15 seconds");
    expect(human(CONFIG.stuckTimeoutMs)).toBe("3 minutes");
    expect(human(CONFIG.idleTimeoutMs)).toBe("90 seconds");
  });
});

// dist is the file Lumiverse loads. A default changed in src and not mirrored
// would ship the old timing behind a source that reviews as correct, and the
// panel would then describe a value the running code does not use.
describe("dist ships the same defaults", () => {
  const DIST = readFileSync(new URL("../dist/frontend.js", import.meta.url), "utf8");
  const block = DIST.slice(DIST.indexOf("const CONFIG = {"));
  for (const key of ["retryDelayMs", "maxDelayMs", "rateLimitDelayMs", "stuckTimeoutMs", "idleTimeoutMs", "maxRetries"]) {
    test(key, () => {
      expect(block).toMatch(
        new RegExp("\\b" + key + ":\\s*" + (CONFIG as any)[key] + "\\b"),
      );
    });
  }
});

// The written table in docs/settings.md is the other place a default is spelled
// out, and it drifted for the same reason the hints did.
describe("the settings table matches what ships", () => {
  const DOC = readFileSync(new URL("../docs/settings.md", import.meta.url), "utf8");
  const rows: Record<string, string> = {};
  for (const m of DOC.matchAll(/^\|\s*(\w+)\s*\|\s*([^|]+?)\s*\|/gm)) rows[m[1]] = m[2];

  test("the table was found at all", () => {
    expect(Object.keys(rows).length).toBeGreaterThan(30);
  });

  for (const key of Object.keys(CONFIG)) {
    const v = (CONFIG as any)[key];
    if (typeof v !== "number" && typeof v !== "boolean") continue;
    test(key, () => {
      expect(rows[key]).toBeDefined();
      expect(rows[key]).toBe(String(v));
    });
  }
});
