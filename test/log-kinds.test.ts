// Every Log line has a kind, and every kind has its own switch under Show in
// the log. A line with no kind could not be hidden, so each call to log in the
// source has to name one of the kinds in LOG_KINDS.
//
// Run with: bun test

import { expect, test, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { __testing } from "../src/frontend";

const { LOG_KINDS, CONFIG, SCHEMA } = __testing as any;
const SRC = readFileSync(new URL("../src/frontend.ts", import.meta.url), "utf8");
const IDS = new Set<string>(Object.keys(LOG_KINDS));

// What each call passes first, up to the comma after the kind.
const calls = [...SRC.matchAll(/(?<![\w.])log\(\s*([^,]*),/g)]
  .map((m) => m[1].trim())
  .filter((first) => !/^kind: LogKind/.test(first));

describe("every Log line can be hidden", () => {
  test("the calls were found at all", () => {
    expect(calls.length).toBeGreaterThan(60);
  });

  test("every call names a kind from the list", () => {
    expect(calls.filter((first) => !/^"[a-z]+"$/.test(first) || !IDS.has(first.slice(1, -1)))).toEqual([]);
  });

  test("every kind in the list is used", () => {
    const used = new Set(calls.map((first) => first.slice(1, -1)));
    expect([...IDS].filter((id) => !used.has(id))).toEqual([]);
  });

  test("every kind has a switch in the settings, on by default", () => {
    const fields = new Map<string, any>();
    for (const g of SCHEMA) for (const f of g.fields) fields.set(f.key, f);
    for (const id of IDS) {
      const key = LOG_KINDS[id];
      expect({ id, field: fields.has(key), on: CONFIG[key] }).toEqual({ id, field: true, on: true });
      expect(fields.get(key).run).toBe("logShow");
    }
  });
});

// Two switches with one name read as one setting, and a change made to the
// wrong one looks like a setting that does not save.
describe("every setting has its own name", () => {
  test("no two settings share a label", () => {
    const seen = new Map<string, string[]>();
    for (const g of SCHEMA)
      for (const f of g.fields) {
        const label = String(f.label).toLowerCase();
        seen.set(label, (seen.get(label) || []).concat(f.key));
      }
    expect([...seen.entries()].filter(([, keys]) => keys.length > 1)).toEqual([]);
  });
});
