// The version is written in three places and shown to users from two of them:
// Lumiverse reads spindle.json, and the debug report and live log print the
// constant in the frontend. A release that bumps two of the three ships a
// debug report claiming the wrong version, which is exactly what a bug report
// is meant to tell you.
import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const manifest = JSON.parse(read("spindle.json")).version;
const pkg = JSON.parse(read("package.json")).version;
const inCode = (read("src/frontend.ts").match(/const VERSION = "([^"]+)"/) || [])[1];
const inBuild = (read("dist/frontend.js").match(/const VERSION = "([^"]+)"/) || [])[1];

describe("version", () => {
  test("spindle.json and package.json agree", () => {
    expect(pkg).toBe(manifest);
  });

  test("and so does the constant the debug report prints", () => {
    expect(inCode).toBe(manifest);
  });

  test("and the built file that Lumiverse actually loads", () => {
    expect(inBuild).toBe(manifest);
  });

  test("it looks like a version", () => {
    expect(manifest).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("the changelog has an entry for it", () => {
    expect(read("CHANGELOG.md")).toContain("\n## " + manifest + "\n");
  });

  test("and that entry carries a date", () => {
    const after = read("CHANGELOG.md").split("\n## " + manifest + "\n")[1] || "";
    expect(after.slice(0, 40)).toMatch(/_\d{4}-\d{2}-\d{2}_/);
  });
});
