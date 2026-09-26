// Every page under docs/ is reached from the README and leads back to it. A
// page added without the link at its foot leaves a reader who came from GitHub
// with no way back but the browser's own button, and a page the README does not
// link is one nobody finds.
import { test, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const pages = readdirSync(join(root, "docs")).filter((f) => f.endsWith(".md"));
const readme = readFileSync(join(root, "README.md"), "utf8");

test("there are pages to check", () => {
  expect(pages.length).toBeGreaterThan(0);
});

test("every page ends with a link back to the README", () => {
  const missing = pages.filter((f) => {
    const text = readFileSync(join(root, "docs", f), "utf8").trimEnd();
    return !text.endsWith("---\n\n[Back to the README](../README.md)");
  });
  expect(missing).toEqual([]);
});

test("the README links every page", () => {
  const missing = pages.filter((f) => readme.indexOf("(docs/" + f) < 0);
  expect(missing).toEqual([]);
});
