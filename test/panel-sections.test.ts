// How the settings panel is divided up. A section's heading, whether it starts
// shut, and anything hand-built underneath it used to be one thing: the panel
// worked out all three by matching the title text, so "Advanced" in a heading
// was what made a section collapse, and a rename could silently stop the
// refusal tester or the preset bar from being built at all. They are separate
// fields now, which is safer but lets the two drift apart instead. These read
// the schema and check they still agree.
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

  test('"Advanced" in a heading and starting shut are still the same set', () => {
    // Not because one causes the other any more, but because a section that
    // reads as advanced and opens anyway, or one that reads as basic and has
    // to be opened before it can be read, is a surprise either way.
    const advanced = secs.filter((s) => /^Advanced\b/.test(s.title)).map((s) => s.title);
    const shut = secs.filter((s) => /\n\s*collapsed: true,/.test(s.body)).map((s) => s.title);
    expect(shut).toEqual(advanced);
  });

  test("the switch you reach for first is in the first section", () => {
    // Basics holds the master switch and every way of reaching or watching it.
    // The on-screen panel used to sit under an Advanced heading of its own,
    // which meant opening a collapsed section to find a switch that is not
    // advanced and that people are told to turn on when reporting a bug.
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
