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
import { readFileSync, readdirSync } from "node:fs";
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
      // Not the fractional half of a decimal. A price is written 0.075, and no
      // default is a fraction with three places on it, so a run of digits
      // sitting behind a point is an example rather than a number this
      // extension ships.
      for (const m of f.hint.matchAll(/(?<![.\d])(\d{3,})\b/g)) {
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

// The same fault one file further out: a default written into the docs by hand.
//
// The docs name a default in prose several times, "(on by default)" and the
// like, and nothing tied those to the settings they describe. A retune moves
// the value and the page goes on stating the old one, which is worse than
// stating none, because a page is where somebody checks what they cannot see in
// the panel.
//
// Reads the real defaults block rather than the source text, and matches a
// claim to a setting by the label the panel shows, so it holds whatever a
// reader is actually told.
describe("defaults quoted in the docs", () => {
  const scalars: Record<string, string> = {};
  {
    const src = readFileSync(new URL("../src/frontend.ts", import.meta.url), "utf8");
    const body = (src.match(/const CONFIG = \{([\s\S]*?)\n\};/) || [])[1] || "";
    for (const line of body.split("\n")) {
      const m = line.match(/^ {2}(\w+):\s*(true|false|-?\d+(?:\.\d+)?|"[^"]*")\s*,/);
      if (m) scalars[m[1]] = m[2];
    }
  }
  const byLabel: Record<string, string> = {};
  for (const f of FIELDS) byLabel[f.label] = f.key;

  const claims: Array<{ file: string; label: string; said: string }> = [];
  // Every page in docs, read off the folder rather than listed here. A written
  // list skips what it does not name and says nothing about it: this one still
  // held word-swaps.md long after that page was deleted, and would have gone on
  // ignoring a new page just as quietly.
  const docFiles = readdirSync(new URL("../docs/", import.meta.url))
    .filter((f) => f.slice(-3) === ".md")
    .sort();
  for (const file of docFiles) {
    const text = readFileSync(new URL("../docs/" + file, import.meta.url), "utf8");
    const re = /\*\*([^*]{3,60})\*\*[^.\n]{0,80}?\((on|off|\d+(?:\.\d+)?) by default\)/g;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      claims.push({ file: file, label: m[1].trim().replace(/\.$/, ""), said: m[2] });
    }
  }

  // Without this the two below pass on an empty list, which is the failure this
  // whole file exists to stop happening quietly.
  test("there are claims to check, and settings to check them against", () => {
    expect(claims.length).toBeGreaterThan(0);
    expect(Object.keys(scalars).length).toBeGreaterThan(20);
    expect(claims.filter((c) => byLabel[c.label]).length).toBeGreaterThan(0);
  });

  test("every default the docs name matches the defaults block", () => {
    const wrong: string[] = [];
    for (const c of claims) {
      const key = byLabel[c.label];
      if (!key) continue;
      const real = scalars[key];
      if (real === undefined) continue;
      const ok =
        (c.said === "on" && real === "true") ||
        (c.said === "off" && real === "false") ||
        c.said === real;
      if (!ok) wrong.push(`${c.file}: "${c.label}" says ${c.said}, ${key} is ${real}`);
    }
    expect(wrong).toEqual([]);
  });
});

// Everything the extension does that a reader might reasonably want to change
// has to be in the panel. A setting that exists in the defaults block but never
// gets a row is one the reader cannot reach: it still changes what the
// extension does, it still rides along in an export, and the only way to find
// it is to read the source.
//
// The other direction matters too. A row for a key with no default has nothing
// to fall back to when a saved copy does not carry it.
describe("every setting is one the reader can reach", () => {
  const rows = new Set<string>();
  for (const g of SCHEMA) for (const f of g.fields) rows.add(f.key);
  const keys = Object.keys(CONFIG);

  // Anything intentionally kept out of the panel goes here with the reason.
  // Empty on purpose: nothing is hidden today, and adding to this list is how
  // hiding something becomes a decision somebody wrote down rather than an
  // oversight.
  const INTENTIONALLY_HIDDEN: string[] = [];

  test("the lists were really read", () => {
    expect(keys.length).toBeGreaterThan(20);
    expect(rows.size).toBeGreaterThan(20);
  });

  test("no setting is missing from the panel", () => {
    const missing = keys.filter((k) => !rows.has(k) && INTENTIONALLY_HIDDEN.indexOf(k) < 0);
    expect(missing).toEqual([]);
  });

  test("no row is for a setting with no default", () => {
    const orphans = [...rows].filter((k) => !(k in (CONFIG as any)));
    expect(orphans).toEqual([]);
  });

  test("nothing on the hidden list has a row, which would make it a lie", () => {
    expect(INTENTIONALLY_HIDDEN.filter((k) => rows.has(k))).toEqual([]);
  });
});
