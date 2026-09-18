// The line that tells somebody a default moved under them is only as honest as
// the table behind it. A row whose old value is also the value that ships tells
// every reader their setting changed when nothing did, and a row naming a key
// that no longer exists tells nobody anything while still taking up the line.
//
// Both go unnoticed on screen, because the line reads perfectly well either way.
import { expect, test, describe } from "bun:test";
import { __testing } from "../src/frontend";

const { CONFIG, MOVED_DEFAULTS, SCHEMA } = __testing as any;

describe("the defaults said to have moved", () => {
  test("there is a table to check, or this proves nothing", () => {
    expect(Array.isArray(MOVED_DEFAULTS)).toBe(true);
  });

  test("each row names a setting that exists", () => {
    for (const m of MOVED_DEFAULTS) expect(Object.keys(CONFIG)).toContain(m.key);
  });

  test("and an old value that is not the one shipping now", () => {
    // A row that matched the shipped value would put the line in front of
    // everybody, including a fresh install, and offer them the number they are
    // already on.
    for (const m of MOVED_DEFAULTS) expect(CONFIG[m.key]).not.toBe(m.was);
  });

  test("the label is the one on the row it points at", () => {
    // Sent to somebody hunting for the setting the line is about. A label
    // written out by hand drifts from the panel the first time the row is
    // renamed, and the reader is then looking for something that is not there.
    const labels: string[] = [];
    for (const g of SCHEMA) for (const f of g.fields) labels.push(String(f.label || ""));
    for (const m of MOVED_DEFAULTS)
      expect(labels.some((l) => l === m.label || l.indexOf(m.label) === 0)).toBe(true);
  });

  test("and each row says what changed and why", () => {
    for (const m of MOVED_DEFAULTS) {
      expect(String(m.why || "").length).toBeGreaterThan(20);
      expect(String(m.label || "").length).toBeGreaterThan(0);
    }
  });
});
