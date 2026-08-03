// Some settings do nothing while a switch is off, and the panel hides those
// rows so what is on screen is what is in use. The wiring is a key written out
// as a string, which nothing else checks: a typo, or a rename of the switch it
// points at, would leave a row hidden forever with no error anywhere.
//
// These read the source rather than the built panel, because the fault they
// are looking for is a name that does not match, not a behaviour.
import { expect, test, describe } from "bun:test";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../src/frontend.ts", import.meta.url), "utf8");

// Every `needs: [...]` in the schema, with the key of the field it sits under.
function dependencies(): Array<{ key: string; needs: string[] }> {
  const out: Array<{ key: string; needs: string[] }> = [];
  const re = /key:\s*"([A-Za-z0-9_]+)",\s*\n\s*needs:\s*\[([^\]]*)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(SRC))) {
    out.push({
      key: m[1],
      needs: m[2].split(",").map((s) => s.trim().replace(/"/g, "")).filter(Boolean),
    });
  }
  return out;
}

// The CONFIG block at the top of the file, as key -> the literal it defaults to.
function defaults(): Record<string, string> {
  const block = SRC.slice(SRC.indexOf("const CONFIG"), SRC.indexOf("type FieldType"));
  const out: Record<string, string> = {};
  const re = /^\s{2}([A-Za-z0-9_]+):\s*([^,\n]+)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block))) out[m[1]] = m[2].trim();
  return out;
}

describe("a row that hangs off a switch", () => {
  const deps = dependencies();
  const CONFIG = defaults();

  test("there are some, so the rest of this is checking something", () => {
    expect(deps.length).toBeGreaterThanOrEqual(9);
  });

  test("every switch named is a real setting", () => {
    const missing = deps.flatMap((d) =>
      d.needs.filter((n) => !(n in CONFIG)).map((n) => d.key + " needs " + n),
    );
    expect(missing).toEqual([]);
  });

  test("and every one of them is a switch, not a box", () => {
    // Hanging a row off a number or a text box would hide it whenever that box
    // held something falsy, which for a number means zero.
    const notBool = deps.flatMap((d) =>
      d.needs
        .filter((n) => CONFIG[n] !== "true" && CONFIG[n] !== "false")
        .map((n) => d.key + " needs " + n + ", which defaults to " + CONFIG[n]),
    );
    expect(notBool).toEqual([]);
  });

  test("nothing hangs off itself", () => {
    expect(deps.filter((d) => d.needs.indexOf(d.key) >= 0)).toEqual([]);
  });

  test("and no switch is itself hidden behind another one", () => {
    // A chain would mean a row that cannot be reached: turning the outer switch
    // on would reveal a switch that is itself still hidden.
    const dependent = new Set(deps.map((d) => d.key));
    const chained = deps.flatMap((d) =>
      d.needs.filter((n) => dependent.has(n)).map((n) => d.key + " -> " + n),
    );
    expect(chained).toEqual([]);
  });

  test("the notes rows hang off the note switch", () => {
    // The three that make up the note feature, named because they are the ones
    // that were asked for by name.
    for (const k of ["refusalNotes", "refusalNotePlacement", "refusalNoteFromTry"]) {
      const d = deps.find((x) => x.key === k);
      expect(d && d.needs).toEqual(["refusalNote"]);
    }
  });
});
