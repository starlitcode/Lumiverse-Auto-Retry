// Runs only some sections of the browser checks.
//
//   bun run test:ui:only "tries at once" "reduce motion"
//
// Each section of test/ui.mjs starts with a console.log("\n<title>") line at
// the left margin. A name matches a section when it is part of that title.
// The setup at the top of the file and the closing lines at the bottom are
// kept, and every section that matches is run in the order it appears in the
// file. The full suite takes several minutes, and one section takes seconds.

import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = join(import.meta.dir, "..");
const names = process.argv.slice(2);
if (!names.length) {
  console.error('Name at least one section, for example: bun run test:ui:only "reduce motion"');
  process.exit(2);
}

const lines = readFileSync(join(root, "test", "ui.mjs"), "utf8").split("\n");
const starts = [];
lines.forEach((line, i) => {
  if (line.startsWith('console.log("\\n')) starts.push(i);
});
let end = -1;
lines.forEach((line, i) => {
  if (/^(await browser\.close|} finally)/.test(line)) end = i;
});
if (!starts.length || end < 0) {
  console.error("Could not find the sections in test/ui.mjs. Its layout has changed, so run the full suite instead.");
  process.exit(2);
}

const title = (i) => lines[i].slice('console.log("\\n'.length).replace(/"\);\s*$/, "");
const picked = [];
starts.forEach((start, k) => {
  if (names.some((n) => title(start).includes(n))) picked.push([start, k + 1 < starts.length ? starts[k + 1] : end]);
});
if (!picked.length) {
  console.error("No section matches. The sections are:\n  " + starts.map(title).join("\n  "));
  process.exit(2);
}

const body = picked.flatMap(([a, b]) => lines.slice(a, b));
const out = join(root, "test", "_only.mjs");
writeFileSync(out, lines.slice(0, starts[0]).concat(body, lines.slice(end)).join("\n"));
console.log("Running " + picked.length + " section(s): " + picked.map(([a]) => title(a)).join(", "));
let code = 1;
try {
  code = spawnSync("bun", [out], { stdio: "inherit", cwd: root }).status ?? 1;
} finally {
  rmSync(out, { force: true });
}
process.exit(code);
