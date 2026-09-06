// The names on the import, export and reset tick boxes.
//
// Each one is a promise about what moves when it is ticked, and the settings
// behind it are a list that grows. A label that stops matching its list is not
// a wording problem: it is somebody ticking a part to back up one thing and
// carrying another without knowing, or leaving a part unticked because its name
// did not sound like it covered what they wanted.
//
// So these are written the same way round every time: if a part carries this
// kind of setting, its name has to say so.
import { expect, test, describe } from "bun:test";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../src/frontend.ts", import.meta.url), "utf8");

interface Part {
  id: string;
  label: string;
  keys: string[];
}

function parts(): Part[] {
  const i = SRC.indexOf("const EXPORT_CATEGORIES: Array<{");
  const block = SRC.slice(i, SRC.indexOf("\n  const fieldByKey", i));
  const out: Part[] = [];
  // Both forms the list is written in: a multi-line entry and a one-liner.
  for (const m of block.matchAll(/id: "([a-z]+)",\s*\n?\s*label: "([^"]+)",\s*\n?\s*keys: \[([^\]]*)\]/g))
    out.push({
      id: m[1],
      label: m[2],
      keys: [...m[3].matchAll(/"([A-Za-z0-9_]+)"/g)].map((x) => x[1]),
    });
  return out;
}

describe("every tick box is named after what it carries", () => {
  const all = parts();

  test("the list was really parsed", () => {
    expect(all.length).toBeGreaterThanOrEqual(5);
    for (const p of all) expect(p.label.length).toBeGreaterThan(2);
    // The presets entry is the one with no settings keys of its own.
    expect(all.filter((p) => p.keys.length === 0).map((p) => p.id)).toEqual(["presets"]);
  });

  // Each rule is: a part holding any of these keys has to have this word in
  // its name. Adding a key to a part it does not fit is then a failing test
  // rather than a label that quietly stops being true.
  const rules: Array<{ word: RegExp; keys: string[]; why: string }> = [
    {
      word: /button/i,
      keys: ["showFloatingToggle", "showExtrasToggle", "floatingToggleSize"],
      why: "it carries whether the on/off buttons are shown",
    },
    {
      word: /note/i,
      keys: ["refusalNote", "refusalNotes", "refusalNotePlacement", "refusalNoteStrictType"],
      why: "it carries the note wording sent on a retry",
    },
    {
      word: /panel|on-screen|pop-up/i,
      keys: ["liveLog", "panelHome", "toast"],
      why: "it carries the on-screen panel and the pop-up",
    },
    {
      word: /price/i,
      keys: ["costIn", "costOut"],
      why: "it carries what your provider charges",
    },
  ];

  // The list has a safety net under it that folds an uncovered setting into the
  // retry part rather than dropping it from every export. That keeps a backup
  // whole, and it is also how a setting ends up under a name that says nothing
  // about it, which nobody sees. Naming every key on purpose is the point of
  // the rules above, so the net is checked for having nothing to catch.
  test("nothing is landing in a part by default", () => {
    const fields = SRC.slice(SRC.indexOf("const SCHEMA"), SRC.indexOf("const EXPORT_CATEGORIES"));
    const keys = [...fields.matchAll(/^\s+key: "([A-Za-z0-9_]+)",$/gm)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(20);
    const covered = new Set<string>();
    for (const p of all) for (const k of p.keys) covered.add(k);
    expect(keys.filter((k) => !covered.has(k))).toEqual([]);
  });

  for (const r of rules) {
    test("a part holding " + r.keys[0] + " says so in its name", () => {
      const holders = all.filter((p) => p.keys.some((k) => r.keys.indexOf(k) >= 0));
      expect(holders.length).toBeGreaterThan(0);
      for (const p of holders)
        expect({ id: p.id, label: p.label, why: r.why, expected: String(r.word) })
          .toEqual({ id: p.id, label: r.word.test(p.label) ? p.label : "MISSING THE WORD",
                     why: r.why, expected: String(r.word) });
    });
  }

  test("the preset part never names one kind and moves them all", () => {
    // Presets are one store holding several kinds and all of them move
    // together, so a name mentioning one kind reads as a promise about that
    // kind alone. Either name every kind or name none of them. Driven off
    // PRESET_KINDS, so a third kind added later is covered without edits here.
    const kinds = SRC.slice(SRC.indexOf("const PRESET_KINDS"), SRC.indexOf("function keysForKind"));
    const labels = [...kinds.matchAll(/^\s{6}label: "([^"]+)",$/gm)].map((m) => m[1]);
    expect(labels.length).toBeGreaterThanOrEqual(1);
    // With one kind there is nothing to be uneven about. The rule is kept for
    // the day a second one arrives.
    if (labels.length < 2) return;
    const presets = (all.find((p) => p.id === "presets") as Part).label.toLowerCase();
    const named = labels.filter((l) => presets.indexOf(l.toLowerCase()) >= 0);
    expect({ label: presets, named: named.length })
      .toEqual({ label: presets, named: named.length === 0 ? 0 : labels.length });
  });

  test("no two parts have the same name", () => {
    const names = all.map((p) => p.label);
    expect(names.length).toBe(new Set(names).size);
  });
});
