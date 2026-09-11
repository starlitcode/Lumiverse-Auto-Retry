// Every call into Lumiverse, and whether it survives Lumiverse being different.
//
// Nothing here runs against the real host. The checks drive a stub, and a stub
// is a copy of what the host was understood to do at the time it was written.
// So the thing worth holding the code to is not "the stub matches" but "an
// unguarded call does not exist": a Lumiverse that renames a method, drops one,
// or hands back a shape nobody expected should cost one feature rather than
// taking the extension down with it.
import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

function unguarded(file: string): string[] {
  const lines = readFileSync(join(root, file), "utf8").split("\n");
  const bare: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(\/\/|\*)/.test(line)) continue;
    if (!/\b(spindle|ctx)\.[a-zA-Z_]+\.[a-zA-Z_]+\s*\(/.test(line)) continue;
    // Guarded on its own line, by a typeof or by a truthiness chain.
    let ok = /typeof\s/.test(line) || /&&\s*\w+\./.test(line);
    // Or inside a try, counting catches on the way back so a closed one does
    // not read as an open one.
    let closed = 0;
    for (let j = i; j >= 0 && j > i - 60 && !ok; j--) {
      const l = lines[j];
      if (/^\s*\}\s*catch/.test(l)) closed++;
      else if (/^\s*try\s*\{/.test(l)) {
        if (closed === 0) ok = true;
        else closed--;
      } else if (/typeof\s+[\w.]+\s*[=!]==?\s*['"]function/.test(l)) ok = true;
    }
    if (!ok) bare.push(file + ":" + (i + 1) + "  " + line.trim().slice(0, 80));
  }
  return bare;
}

describe("nothing calls Lumiverse without a way to survive it answering differently", () => {
  test("the backend", () => {
    expect(unguarded("src/backend.ts")).toEqual([]);
  });

  test("the panel", () => {
    expect(unguarded("src/frontend.ts")).toEqual([]);
  });

  test("and this would notice one, or it is checking nothing", () => {
    // The probe run against a line it must object to. Without this the two
    // checks above pass just as well on a reader that never matches anything.
    const lines = ["async function x() { return await spindle.chat.getMessages('c1'); }"];
    const seen = lines.filter((l) => /\b(spindle|ctx)\.[a-zA-Z_]+\.[a-zA-Z_]+\s*\(/.test(l));
    expect(seen.length).toBe(1);
  });
});
