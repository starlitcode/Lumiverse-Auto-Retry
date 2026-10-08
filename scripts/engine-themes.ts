// Writes test/lumiverse-themes.json: the colours Lumiverse's own theme engine
// gives a purple theme, dark and light. The browser checks read every panel on
// both, because a hand-written test theme sets every colour to suit itself and
// the engine does not.
//
//   bun scripts/engine-themes.ts [path to a Lumiverse clone]
//
// The clone defaults to $LUMIVERSE_SRC, then ~/lumiverse-src, which setup.sh
// makes. Run this again after a Lumiverse update that changes its theme engine.

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const root = join(import.meta.dir, "..");
const src = process.argv[2] || process.env.LUMIVERSE_SRC || join(homedir(), "lumiverse-src");
const engine = join(src, "frontend", "src", "theme", "engine.ts");
if (!existsSync(engine)) {
  console.error("No Lumiverse theme engine at " + engine + ".");
  console.error("Clone it first: git clone --depth 1 https://github.com/prolix-oc/Lumiverse " + src);
  process.exit(1);
}
// The engine imports with an "@/" path. A clone holds no settings that say
// where that points, so one is written beside it.
const tsconfig = join(src, "frontend", "tsconfig.json");
if (!existsSync(tsconfig))
  writeFileSync(tsconfig, JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } }));

let generate: any;
try {
  ({ generateThemeVariables: generate } = await import(engine));
} catch (e: any) {
  console.error("Could not load the theme engine: " + ((e && e.message) || "no reason given"));
  process.exit(1);
}
if (typeof generate !== "function") {
  console.error("The theme engine has no generateThemeVariables any more. Its name or shape has changed in Lumiverse.");
  process.exit(1);
}

const out: Record<string, string> = {};
for (const mode of ["dark", "light"] as const) {
  const vars = generate(
    { id: "test", name: "test", mode, accent: { h: 285, s: 70, l: 65 }, radiusScale: 1, enableGlass: true, fontScale: 1, uiScale: 1 },
    mode,
  );
  out[mode] = ":root{" + Object.entries(vars).map(([k, v]) => k + ":" + v).join(";") + "}";
}
writeFileSync(join(root, "test", "lumiverse-themes.json"), JSON.stringify(out));
console.log("Wrote test/lumiverse-themes.json from " + src + ".");
