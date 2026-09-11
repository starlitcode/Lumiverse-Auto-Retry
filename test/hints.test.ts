// Hints, labels and the macro list are drawn as plain text. Nothing renders
// markdown in them, so a backtick is a backtick on the screen and a pair of
// stars is a pair of stars.
//
// Written as a check because a hint is the easiest place in the codebase to
// reach for a symbol out of habit, and the only way anybody finds out is by
// opening the panel and reading it.
import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const src = readFileSync(join(root, "src/frontend.ts"), "utf8");

// Every string the panel puts in front of somebody, taken from the file rather
// than from a list kept by hand, which would go out of date the first time
// somebody adds a field.
function readerStrings(): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  const lines = src.split("\n");
  let inside = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // A comment is for whoever reads the source, not for the panel.
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
    if (/^\s*(hint|what|label|title|tooltip|why|without)\s*:/.test(line)) inside = true;
    else if (inside && !/^\s*(\+\s*)?["']/.test(line)) inside = false;
    if (!inside) continue;
    for (const m of line.matchAll(/"((?:[^"\\]|\\.)*)"/g))
      if (m[1].length > 3) out.push({ line: i + 1, text: m[1] });
  }
  return out;
}

const shown = readerStrings();

describe("nothing shown to a reader carries markdown", () => {
  test("there are hints to check, or this proves nothing", () => {
    expect(shown.length).toBeGreaterThan(40);
  });

  test("no backticks", () => {
    const bad = shown.filter((s) => s.text.includes("`"));
    expect(bad.map((b) => b.line + ": " + b.text.slice(0, 60))).toEqual([]);
  });

  test("no bold or italic stars", () => {
    const bad = shown.filter(
      (s) => /\*\*[^*]/.test(s.text) || /(^|\s)\*[A-Za-z][^*]*\*/.test(s.text),
    );
    expect(bad.map((b) => b.line + ": " + b.text.slice(0, 60))).toEqual([]);
  });

  test("no markdown links", () => {
    const bad = shown.filter((s) => /\[[^\]]+\]\([^)]+\)/.test(s.text));
    expect(bad.map((b) => b.line + ": " + b.text.slice(0, 60))).toEqual([]);
  });
});
