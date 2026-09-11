// The note sets that ship with the extension.
//
// These had no check at all, four of them for several versions and a fifth
// added on top. They are data rather than code, which is exactly why nothing
// caught a wrong role or a try number out of range: a set with a role the
// loader does not know becomes a system note without a word about it, and a set
// nobody notices is broken is one somebody loads and quietly gets nothing from.
import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const src = readFileSync(join(root, "src/frontend.ts"), "utf8");

// Read out of the source rather than imported, because they sit inside setup
// where a test cannot reach them.
function shippedNotes(): Array<{ name: string; notes: Array<{ text: string; role: string; fromTry: number }>; placement: string }> {
  const start = src.indexOf("const BUILT_IN_NOTES");
  const end = src.indexOf("\n  const builtInNote", start);
  const blob = src.slice(start, end);
  const out: Array<any> = [];
  for (const m of blob.matchAll(/name: "([^"]+)",\s*\n\s*values: \{([\s\S]*?)\n      \},/g)) {
    const body = m[2];
    const placement = (body.match(/refusalNotePlacement: "([^"]+)"/) || [])[1] || "";
    // One pattern, not two. The first version had a second for notes written on
    // one line, and both matched those, so every one-line note was read twice
    // and the checks ran over duplicates.
    const notes: Array<any> = [];
    for (const n of body.matchAll(/text: "((?:[^"\\]|\\.)*)",\s*\n?\s*role: "(\w+)",\s*\n?\s*fromTry: (\d+)/g))
      notes.push({ text: n[1], role: n[2], fromTry: Number(n[3]) });
    out.push({ name: m[1], placement, notes });
  }
  return out;
}

const ROLES = ["system", "user", "assistant"];
const PLACEMENTS = ["before", "after", "system", "end"];
const sets = shippedNotes();

describe("the note sets that ship with it", () => {
  test("there are some, and this found them", () => {
    expect(sets.length).toBeGreaterThanOrEqual(5);
  });

  test("each one has a name and at least one note", () => {
    for (const s of sets) {
      expect(s.name.length).toBeGreaterThan(2);
      expect(s.notes.length).toBeGreaterThan(0);
    }
  });

  test("every role is one the loader knows", () => {
    // A role it does not know is turned into a system note without a word, so a
    // set written with the wrong one looks fine and does something else.
    const wrong = sets.flatMap((s) => s.notes.filter((n) => ROLES.indexOf(n.role) < 0).map((n) => s.name + ": " + n.role));
    expect(wrong).toEqual([]);
  });

  test("every placement is one the panel offers", () => {
    const wrong = sets.filter((s) => PLACEMENTS.indexOf(s.placement) < 0).map((s) => s.name + ": " + s.placement);
    expect(wrong).toEqual([]);
  });

  test("no note starts on a try that is out of range", () => {
    const wrong = sets.flatMap((s) =>
      s.notes.filter((n) => !(n.fromTry >= 1 && n.fromTry <= 20)).map((n) => s.name + ": " + n.fromTry),
    );
    expect(wrong).toEqual([]);
  });

  test("none of them is empty text", () => {
    const empty = sets.flatMap((s) => s.notes.filter((n) => !n.text.trim()).map(() => s.name));
    expect(empty).toEqual([]);
  });

  test("every name is different, since the picker finds one by name", () => {
    const names = sets.map((s) => s.name);
    expect(names.length).toBe(new Set(names).size);
  });

  test("each note is written as an out of character aside", () => {
    // Every one of them is an instruction to the model rather than a line of the
    // story, and the OOC marker is what keeps it out of the writing.
    const bare = sets.flatMap((s) => s.notes.filter((n) => !/^\[OOC:/.test(n.text)).map((n) => s.name + ": " + n.text.slice(0, 40)));
    expect(bare).toEqual([]);
  });

  test("and none of them carries markdown, since a note is sent as plain text", () => {
    const marked = sets.flatMap((s) =>
      s.notes.filter((n) => /`|\*\*|(^|\s)\*[A-Za-z]/.test(n.text)).map((n) => s.name + ": " + n.text.slice(0, 40)),
    );
    expect(marked).toEqual([]);
  });
});
