// How the settings panel is divided up. A section's heading, whether it starts
// shut, and anything hand-built underneath it are three separate fields rather
// than one thing derived from the title text. Deriving them means the word
// "Advanced" in a heading decides whether a section collapses, and a rename can
// stop the refusal tester or the preset bar being built at all. Separate fields
// can drift apart instead, so these read the schema and check they agree.
import { expect, test, describe } from "bun:test";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../src/frontend.ts", import.meta.url), "utf8");
const SCHEMA = (() => {
  const i = SRC.indexOf("const SCHEMA: Group[] = [");
  return SRC.slice(i, SRC.indexOf("\n];", i));
})();

interface Section {
  title: string;
  body: string;
  fields: string[];
}

function sections(): Section[] {
  const heads: Array<{ title: string; at: number }> = [];
  const re = /^ {4}title: "([^"]+)",$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(SCHEMA))) heads.push({ title: m[1], at: m.index });
  return heads.map((h, i) => {
    const body = SCHEMA.slice(h.at, i + 1 < heads.length ? heads[i + 1].at : undefined);
    return {
      title: h.title,
      body: body,
      fields: [...body.matchAll(/^ {8}key: "([A-Za-z0-9_]+)",$/gm)].map((x) => x[1]),
    };
  });
}

describe("the sections of the settings panel", () => {
  const secs = sections();

  test("there are some, and they were really parsed", () => {
    expect(secs.length).toBeGreaterThanOrEqual(5);
    expect(secs.map((s) => s.title)).toContain("Basics");
    for (const s of secs) expect(s.fields.length).toBeGreaterThan(0);
  });

  test("no section is one row with a heading over it", () => {
    // A heading over a single row is a heading that says nothing the row does
    // not already say, and it costs a line of the panel to say it. Two sections
    // were exactly that and their rows have gone to the sections they belong
    // with. Anything new that would be one row belongs in an existing section.
    const lonely = secs.filter((s) => s.fields.length < 2).map((s) => s.title);
    expect(lonely).toEqual([]);
  });

  test("the sections that start shut are named, not guessed at", () => {
    // A flag rather than a title starting with "Advanced", which would make the
    // name decide the behaviour and label things that are not advanced. Saving
    // settings to a file and building a bug report are ordinary. They start
    // shut because nothing in them is needed to use the extension, which is a
    // different claim, and the caret is the one making it. Listed here so
    // adding a section to that set is a deliberate decision.
    const shut = secs.filter((s) => /\n\s*collapsed: true,/.test(s.body)).map((s) => s.title);
    expect(shut).toEqual([
      "Refusal tuning",
      "Find and replace (beta)",
      "Buttons it clicks",
    ]);
    // And nothing calls itself advanced any more, in a heading or out of one.
    for (const sec of secs) expect(sec.title).not.toMatch(/advanced/i);
  });

  test("the switch you reach for first is in the first section", () => {
    // Basics holds the master switch and every way of reaching or watching it.
    // A closed section of its own for the on-screen panel would mean opening
    // one to find a switch people are told to reach for the moment they want to
    // report a bug.
    expect(secs[0].title).toBe("Basics");
    for (const key of ["enabled", "toast", "liveLog"]) expect(secs[0].fields).toContain(key);
  });

  test("tuning a check sits next to the check it tunes", () => {
    const at = (t: RegExp) => secs.findIndex((s) => t.test(s.title));
    const trigger = at(/^When to count a reply as bad$/);
    const tuning = at(/refusal tuning/i);
    expect(trigger).toBeGreaterThanOrEqual(0);
    expect(tuning).toBe(trigger + 1);
  });

  test("everything built by hand is asked for by name, exactly once", () => {
    const asked = [...SCHEMA.matchAll(/^ {4}extra: "([A-Za-z]+)",$/gm)].map((m) => m[1]);
    expect(asked.sort()).toEqual(["refusalTester", "swapPresets"]);
    // And the panel builds each of them off that field, not off the title.
    for (const name of asked)
      expect(SRC).toContain('group.extra === "' + name + '"');
  });

  test("the preset split is asked for by name too, and only where presets exist", () => {
    const split = secs.filter((s) => /\n\s*splitByPreset: true,/.test(s.body));
    expect(split.length).toBe(1);
    expect(split[0].fields).toContain("replaceEnabled");
    expect(SRC).toContain("if (!group.splitByPreset)");
  });

  test("every labelled run inside a section names a run that exists", () => {
    const runs = (() => {
      const i = SRC.indexOf("const RUNS: Record<string, { title: string; note: string }> = {");
      const block = SRC.slice(i, SRC.indexOf("\n};", i));
      return [...block.matchAll(/^ {2}([A-Za-z]+): \{$/gm)].map((m) => m[1]);
    })();
    expect(runs.length).toBeGreaterThan(0);
    const used = [...SCHEMA.matchAll(/^ {8}run: "([A-Za-z]+)",$/gm)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(0);
    for (const r of used) expect(runs).toContain(r);
    // And nothing is defined that nothing uses.
    for (const r of runs) expect(used).toContain(r);
  });

  test("the rows of a run are consecutive, or the heading splits in two", () => {
    // A run is drawn as one heading over the rows that follow it, so rows
    // naming the same run with something else in between would get a second
    // copy of the heading rather than joining the first.
    let runsChecked = 0;
    for (const s of secs) {
      // The run a row names sits anywhere among that row's own fields, so the
      // section is cut into rows first rather than read line by line.
      const rows = s.body.split(/^ {6}\{$/m).slice(1);
      expect(rows.length).toBe(s.fields.length);
      const seen: string[] = [];
      let last = "";
      for (const row of rows) {
        const m = row.match(/^ {8}run: "([A-Za-z]+)",$/m);
        const r = m ? m[1] : "";
        if (r) runsChecked++;
        if (r === last) continue;
        expect(seen).not.toContain(r);
        seen.push(r);
        last = r;
      }
    }
    // Proof this looked at anything: every run row in the schema went through
    // the loop above, not past it.
    expect(runsChecked).toBe(
      [...SCHEMA.matchAll(/^ {8}run: "[A-Za-z]+",$/gm)].length,
    );
  });
});

// A field can ask to apply as it is edited rather than waiting for Save. That
// was wired up for number boxes only, so a dropdown asking for it was accepted
// by the schema and then quietly did nothing. Both honour it now, and this
// fails if a third kind of field asks for something no handler acts on.
describe("applying a setting as it is edited", () => {
  const HONOURED = ["num", "pick"];

  function liveFields(): Array<{ key: string; type: string }> {
    const out: Array<{ key: string; type: string }> = [];
    for (const row of SCHEMA.split(/^ {6}\{$/m).slice(1)) {
      if (!/^ {8}live: true,$/m.test(row)) continue;
      const key = row.match(/^ {8}key: "([A-Za-z0-9_]+)",$/m);
      const type = row.match(/^ {8}type: "([a-z]+)",$/m);
      out.push({ key: key ? key[1] : "?", type: type ? type[1] : "?" });
    }
    return out;
  }

  test("only the kinds of field that act on it ask for it", () => {
    const live = liveFields();
    expect(live.length).toBeGreaterThan(0);
    const wrong = live.filter((f) => HONOURED.indexOf(f.type) < 0);
    expect(wrong).toEqual([]);
  });

  test("and both of those kinds really do act on it", () => {
    // The check above is worth nothing if a handler stops calling onLiveEdit,
    // so the two call sites are named here as well.
    const calls = [...SRC.matchAll(/onLiveEdit\(String\(f\.key\)\)/g)].length;
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(SRC).toContain("if (f.live) onLiveEdit(String(f.key));");
  });

  test("every key it acts on is one that asks for it", () => {
    const body = SRC.slice(SRC.indexOf("function onLiveEdit"), SRC.indexOf("function syncLiveLog"));
    const handled = [...body.matchAll(/key === "([A-Za-z0-9_]+)"/g)].map((m) => m[1]);
    expect(handled.length).toBeGreaterThan(0);
    const asking = liveFields().map((f) => f.key);
    for (const k of handled) expect(asking).toContain(k);
  });
});
