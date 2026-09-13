// The note sets that ship with it are named twice: in the code, where the notes
// themselves live, and in docs/detection.md, where the list is written out again
// by hand. Nothing makes the second copy follow the first, so a set added,
// renamed or reordered lands in one and sits in the other until somebody reads
// both. The page said four and listed five for a while on exactly that.
import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const page = readFileSync(join(root, "docs/detection.md"), "utf8");
const code = readFileSync(join(root, "src/frontend.ts"), "utf8");

// Read from the array itself rather than listed again here, so a sixth set is
// covered the day it is added.
const array = code.slice(
  code.indexOf("const BUILT_IN_NOTES"),
  code.indexOf("const builtInNote", code.indexOf("const BUILT_IN_NOTES")),
);
const shipped = [...array.matchAll(/\n\s+name: "([^"]+)",/g)].map((m) => m[1]);

// The section that lists them: everything from its heading to the next heading
// of any depth, so bullets from further down the page are not counted as sets.
const after = page.split("\n").slice(page.split("\n").indexOf("### The sets that ship with it") + 1);
const end = after.findIndex((l) => l.startsWith("#"));
const listed = after
  .slice(0, end < 0 ? after.length : end)
  .filter((l) => l.startsWith("- **"))
  .map((l) => (/^- \*\*(.+?)\*\*/.exec(l) || [])[1]);

describe("the detection page keeps up with the note sets", () => {
  test("the code has sets to check against", () => {
    expect(shipped.length).toBeGreaterThanOrEqual(5);
  });

  test("the page lists every one of them, in the same order", () => {
    expect(listed).toEqual(shipped);
  });

  test("and says how many there are", () => {
    // A count written out in words goes stale the moment a set is added, which
    // is how the page came to say four over a list of five.
    const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
    const wrong = words.filter(
      (w, n) => n !== shipped.length && new RegExp("\\b" + w + " sets\\b", "i").test(page),
    );
    expect(wrong).toEqual([]);
  });
});
