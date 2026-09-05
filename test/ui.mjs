// Panel checks that need a real browser.
//
// The settings panel is the part of this extension most easily broken by a
// well-meaning change: colours come from the user's theme, the list is a scroll
// container, and a hint that expands in the wrong place pushes half the options
// off a phone screen. All three have gone wrong at least once. These drive the
// built dist/frontend.js in headless Chromium against a stub of the host.
//
//   bun run test:ui
//
// Playwright is not a dependency of this project and should not become one: it
// pulls a few hundred megabytes of browsers, and the install path here is
// "Lumiverse clones the repo". If it is not present this skips and exits
// cleanly. To run it:
//
//   bun add -d playwright && bunx playwright install chromium
//
// The pure logic (refusal detection, cut-off detection, contrast maths, the
// word-swap engine) is covered by `bun test`, which needs nothing extra.

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch (_) {
  console.log(
    "playwright is not installed, skipping the browser checks.\n" +
      "  bun add -d playwright && bunx playwright install chromium",
  );
  process.exit(0);
}

const bundle = join(root, "dist", "frontend.js");
if (!existsSync(bundle)) {
  console.error("dist/frontend.js is missing. Run `bun run build` first.");
  process.exit(1);
}
const SOURCE = readFileSync(bundle, "utf8") + "\nwindow.__setup = setup;\n";

// The setting whose description is longest, out of the ones that are on screen
// without turning something on first. Worked out from the schema rather than
// written down, because a name written down here goes stale the moment that
// setting is reworded or moved behind a switch, and it fails as a broken
// popover rather than as a stale test.
function longestHintKey() {
  let best = null;
  let len = -1;
  // Each field is a { ... } run between "key:" markers, so the description and
  // the flags that disqualify it are read out of the same block.
  const blocks = readFileSync(bundle, "utf8").split(/\n\s*\{\s*\n(?=\s*key:)/);
  for (const b of blocks) {
    const k = /^\s*key:\s*"([A-Za-z0-9_]+)"/.exec(b);
    if (!k) continue;
    // Behind a switch, so not on screen by default; or opens above on purpose.
    if (/\n\s*needs:\s*\[/.test(b.split("\n},")[0])) continue;
    if (/\n\s*hintAbove:\s*true/.test(b.split("\n},")[0])) continue;
    const h = /\n\s*hint:\s*"((?:[^"\\]|\\.)*)"/.exec(b.split("\n},")[0]);
    if (!h) continue;
    if (h[1].length > len) {
      len = h[1].length;
      best = k[1];
    }
  }
  if (!best) throw new Error("no hint found in the schema to measure");
  return best;
}

// Lumiverse's stock theme variables. A custom theme overrides these, which is
// exactly why the contrast check below exists.
const THEME = `:root{
--lumiverse-primary:rgba(147,112,219,.9);--lumiverse-primary-hover:rgba(167,132,239,.95);
--lumiverse-primary-text:rgba(186,135,255,.95);--lumiverse-primary-020:rgba(147,112,219,.2);
--lumiverse-primary-050:rgba(147,112,219,.5);--lumiverse-secondary:rgba(128,128,128,.15);
--lumiverse-secondary-hover:rgba(128,128,128,.25);--lumiverse-secondary-border:rgba(128,128,128,.25);
--lumiverse-danger:#ef4444;--lumiverse-success:#22c55e;--lumiverse-bg:rgba(28,24,38,.95);
--lumiverse-bg-elevated:rgba(35,30,48,.9);--lumiverse-border:rgba(147,112,219,.12);
--lumiverse-text:rgba(255,255,255,.9);--lumiverse-text-muted:rgba(255,255,255,.65);
--lumiverse-radius-sm:5px;--lumiverse-radius:8px;--lumiverse-radius-md:10px;
--lumiverse-radius-lg:12px;--lumiverse-shadow-sm:0 2px 8px rgba(0,0,0,.2);
--lumiverse-shadow-md:0 8px 24px rgba(0,0,0,.4);--lumiverse-shadow-xl:0 20px 60px rgba(0,0,0,.5);
--lumiverse-modal-backdrop:rgba(0,0,0,.6);--lumiverse-fill-subtle:rgba(0,0,0,.1);
--lumiverse-fill:rgba(0,0,0,.15);--lumiverse-transition:200ms ease;
--lumiverse-transition-fast:150ms ease;--lumiverse-font-family:system-ui,sans-serif;
--lumiverse-font-mono:ui-monospace,monospace;--lumiverse-font-scale:1;--lumiverse-ui-scale:1;}
body{background:rgb(10,8,18);margin:0}#modal{background:rgb(35,30,48);padding:0;width:456px;max-width:100%}`;
// The width above stands in for the modal Lumiverse hands the panel, and the
// cap is what makes a narrow viewport mean anything: pinned at 456px, a check
// that set a 320px phone still measured a 456px panel and the page scrolled
// sideways to hold it. Anything that has to be true on a phone is true at the
// width a phone actually gives.


// Boots the extension in a page with the settings panel open, and hands the
// callback the same helpers every check needs.
async function inPanel(browser, { css = "", viewport, touch = false, settings = null } = {}, fn) {
  const page = await browser.newPage(
    viewport ? { viewport, hasTouch: touch, isMobile: touch } : {},
  );
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push("console: " + m.text());
  });
  await stage(page, "<div id=modal></div>");
  await page.addStyleTag({ content: THEME + css });
  await page.addScriptTag({ content: SOURCE, type: "module" });
  await page.waitForFunction(() => !!window.__setup);
  await page.evaluate(async (over) => {
    window.__acts = {};
    // Recorded rather than discarded, so a check can drive the lifecycle the
    // host would drive: a generation starting, tokens arriving, one ending.
    window.__handlers = {};
    window.__sent = [];
    window.__backs = [];
    window.__fromBackend = (m) => {
      for (const f of window.__backs.slice()) {
        try {
          f(m);
        } catch (_) {}
      }
    };
    window.__setup(
      {
        events: {
          on: (name, fn) => {
            window.__handlers[name] = fn;
            return () => {
              delete window.__handlers[name];
            };
          },
        },
        // What crosses to the backend, and a way to answer as it would. Every
        // handler is kept rather than only the newest: the panel registers
        // short-lived ones of its own alongside the router, so replacing them
        // would deliver to whichever happened to register last.
        sendToBackend: (m) => window.__sent.push(m),
        onBackendMessage: (fn) => {
          window.__backs.push(fn);
          return () => {
            window.__backs = window.__backs.filter((f) => f !== fn);
          };
        },
        ui: {
          showModal: () => ({
            root: document.getElementById("modal"),
            onDismiss: () => {},
            dismiss: () => {},
          }),
          registerInputBarAction: (o) => {
            const a = {
              onClick: (cb) => {
                a.cb = cb;
                return () => {};
              },
              destroy: () => {},
            };
            window.__acts[o.id] = a;
            return a;
          },
          // Stands in for the host's sidebar. It hands back a root to render
          // into and records the badge, which is all the extension asks of it.
          registerDrawerTab: (o) => {
            const root = document.createElement("div");
            root.id = "drawer-" + o.id;
            document.body.appendChild(root);
            const t = {
              opts: o,
              root,
              badges: [],
              setBadge: (v) => t.badges.push(v),
              activate: () => { t.activated = true; },
              destroy: () => { t.destroyed = true; root.remove(); },
            };
            window.__drawer = t;
            return t;
          },
        },
      },
      over || {},
    );
    window.__acts["auto-retry-settings"].cb();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }, settings);
  const out = await fn(page);
  await page.close();
  return { out, errors };
}


// Decodes a PNG far enough to read its pixels. Only used by the clear button
// check, which cannot be done any other way: the browser will not report a
// pseudo-element's own styles back through getComputedStyle.
function decodePixels(buf) {
  const zlib = require("node:zlib");
  let pos = 8, width = 0, height = 0, depth = 0, colour = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      depth = data[8]; colour = data[9];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (depth !== 8 || (colour !== 6 && colour !== 2)) return null;
  const ch = colour === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * ch;
  const out = Buffer.alloc(height * stride);
  const px = [];
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? out[y * stride + i - ch] : 0;
      const b = y > 0 ? out[(y - 1) * stride + i] : 0;
      const c = i >= ch && y > 0 ? out[(y - 1) * stride + i - ch] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + i] = v & 255;
    }
    for (let x = 0; x < width; x++) {
      const o = y * stride + x * ch;
      px.push({ r: out[o], g: out[o + 1], b: out[o + 2] });
    }
  }
  return px;
}

// The field is whatever colour covers most of the sample; the cross is whatever
// stands out furthest from it. That works whichever way round the theme is,
// which "the brightest thing there" did not: on a light theme the brightest
// thing in the sample is the field itself.
function crossOnField(buf) {
  const px = decodePixels(buf);
  if (!px || !px.length) return null;
  const counts = new Map();
  for (const p of px) {
    const k = p.r + "," + p.g + "," + p.b;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  let fieldKey = null, most = -1;
  for (const [k, n] of counts) if (n > most) { most = n; fieldKey = k; }
  const field = fieldKey.split(",").map(Number);
  const lum = (c) => {
    const ch = c.map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  };
  const ratio = (c) => {
    const x = lum(c), y = lum(field);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  let cross = field, best = 1;
  for (const p of px) {
    const r = ratio([p.r, p.g, p.b]);
    if (r > best) { best = r; cross = [p.r, p.g, p.b]; }
  }
  return { field, cross, ratio: best };
}

// page.setContent() leaves the page on about:blank, where localStorage throws a
// SecurityError. Everything that saves a setting or a preset therefore did
// nothing at all under these checks, silently. Serving the same markup from a
// real origin gives the extension working storage, which is what it has in
// Lumiverse.
const ORIGIN = "http://lumiverse.test/";
async function stage(page, body) {
  await page.route("**/*", (route) =>
    route.fulfill({
      contentType: "text/html",
      // The viewport meta is not decoration. Chromium lays a page out at 980px
      // wide when isMobile is set and the page does not ask for the device
      // width, so a check that sets a 360px phone and forgets this measures a
      // desktop layout shrunk to fit and finds nothing a phone would.
      body:
        '<!doctype html><meta charset=utf-8>' +
        '<meta name="viewport" content="width=device-width, initial-scale=1">' +
        body,
    }),
  );
  await page.goto(ORIGIN);
}

// A light theme, built the way Lumiverse's own variables invert: every value
// the stock dark theme sets, given a light counterpart. Until this existed the
// checks only ever ran on dark surfaces, so nothing held light themes to the
// same standard even though the extension is used on them.
const LIGHT = `:root{
--lumiverse-primary:rgba(124,92,196,.95);--lumiverse-primary-hover:rgba(108,76,180,.95);
--lumiverse-primary-text:rgba(96,64,168,1);--lumiverse-primary-020:rgba(124,92,196,.14);
--lumiverse-primary-050:rgba(124,92,196,.45);--lumiverse-secondary:rgba(0,0,0,.05);
--lumiverse-secondary-hover:rgba(0,0,0,.09);--lumiverse-secondary-border:rgba(0,0,0,.14);
--lumiverse-danger:#dc2626;--lumiverse-success:#16a34a;
--lumiverse-bg:rgba(250,249,253,.95);--lumiverse-bg-elevated:rgba(255,255,255,.9);
--lumiverse-card-bg-solid:rgb(255,255,255);--lumiverse-border:rgba(124,92,196,.18);
--lumiverse-text:rgba(24,22,30,.92);--lumiverse-text-muted:rgba(24,22,30,.6);
--lumiverse-shadow-sm:0 2px 8px rgba(0,0,0,.08);--lumiverse-shadow-md:0 8px 24px rgba(0,0,0,.14);
--lumiverse-shadow-xl:0 20px 60px rgba(0,0,0,.18);--lumiverse-modal-backdrop:rgba(0,0,0,.35);
--lumiverse-fill-subtle:rgba(0,0,0,.035);--lumiverse-fill:rgba(0,0,0,.06);}
body{background:rgb(244,242,249)}#modal{background:rgb(252,251,254)}`;

// A light theme pack that overrides the common variables and not all 92, which
// is what a hand-written theme actually looks like. Every fallback in the
// source is a dark colour, so anything reaching for a variable this leaves
// unset is measured against, or painted in, the wrong one.
const PARTIAL_LIGHT = `:root{
--lumiverse-primary:rgba(124,92,196,.95);--lumiverse-primary-hover:rgba(108,76,180,.95);
--lumiverse-secondary:rgba(0,0,0,.05);--lumiverse-secondary-border:rgba(0,0,0,.14);
--lumiverse-bg-elevated:rgba(252,251,254,.94);--lumiverse-border:rgba(124,92,196,.18);
--lumiverse-text:rgba(24,22,30,.92);--lumiverse-text-muted:rgba(24,22,30,.6);
--lumiverse-fill-subtle:rgba(0,0,0,.035);}
body{background:rgb(244,242,249)}#modal{background:rgb(252,251,254)}`;

// A light page with no light theme behind it at all.
const LIGHT_PAGE = "body{background:rgb(244,242,249)}#modal{background:rgb(252,251,254)}";

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok || detail === undefined ? "" : "  -> " + JSON.stringify(detail)}`);
  if (!ok) failures++;
};

// Playwright can be importable while its browser is not downloaded, so a failed
// launch is a skip too rather than a red run. CHROMIUM_PATH points it at a
// browser you already have instead of one it manages.
let browser;
try {
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
  });
} catch (e) {
  console.log(
    "no browser to run against, skipping the browser checks.\n" +
      "  bunx playwright install chromium   (or set CHROMIUM_PATH)\n" +
      "  " + String((e && e.message) || e).split("\n")[0],
  );
  process.exit(0);
}

// ---- every label must be readable on whatever theme is in play ----
// What every label on the panel measures against what is behind it. Used by
// the theme checks below and by the one that swaps the theme underneath a panel
// that is already drawn.
const CONTRAST_PROBE = () => {
  const lum = (c) => {
    const n = c.match(/[\d.]+/g).map(Number);
    const f = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(n[0]) + 0.7152 * f(n[1]) + 0.0722 * f(n[2]);
  };
  const ratio = (a, b) => {
    const x = lum(a), y = lum(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  // Composite the layers rather than hunting for an opaque one. Looking for
  // the first background over 90% opaque walked straight past a button
  // whose fill is exactly 90%, and measured its label against the panel
  // behind it instead of against the button. Gradients count too: a tinted
  // surface paints a colour its background-color never mentions.
  const solid = (el) => {
    const layers = [];
    let p = el;
    while (p) {
      const cs = getComputedStyle(p);
      const n = (cs.backgroundColor.match(/[\d.]+/g) || []).map(Number);
      let c = n.slice(0, 3);
      let a = n[3] === undefined ? 1 : n[3];
      const stop = (cs.backgroundImage || "").match(/rgba?\([^)]*\)/);
      if (stop) {
        const g = (stop[0].match(/[\d.]+/g) || []).map(Number);
        const ga = g[3] === undefined ? 1 : g[3];
        c = [g[0] * ga + c[0] * (1 - ga), g[1] * ga + c[1] * (1 - ga), g[2] * ga + c[2] * (1 - ga)];
        a = Math.min(1, a + ga * (1 - a));
      }
      if (a > 0) layers.push([c, a]);
      if (a >= 0.999) break;
      p = p.parentElement;
    }
    let base = [0, 0, 0];
    for (let i = layers.length - 1; i >= 0; i--) {
      const [c, a] = layers[i];
      base = [c[0] * a + base[0] * (1 - a), c[1] * a + base[1] * (1 - a), c[2] * a + base[2] * (1 - a)];
    }
    return "rgb(" + base.map((v) => Math.round(v)).join(",") + ")";
  };
  const modal = document.getElementById("modal");
  const paints = [...modal.querySelectorAll("*")].filter((e) => {
    if (/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(e.tagName)) return true;
    return [...e.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim());
  });
  const rows = paints.map((e) => ({
    text: (e.textContent || "").trim().slice(0, 30),
    r: Number(ratio(getComputedStyle(e).color, solid(e)).toFixed(2)),
  }));
  const save = [...modal.querySelectorAll("button")].find((b) => b.textContent === "Save");
  return {
    count: rows.length,
    worst: rows.reduce((a, x) => (x.r < a.r ? x : a), rows[0]),
    under3: rows.filter((x) => x.r < 3).map((x) => x.text),
    saveColour: getComputedStyle(save).color,
    labelPx: parseFloat(getComputedStyle(save).fontSize),
  };
};

console.log("\ncontrast");
for (const [label, css] of [
  ["stock theme", ""],
  // The reported bug: an accent close enough to the text colour that a filled
  // button rendered as a blank rectangle.
  ["light accent", ":root{--lumiverse-primary:#e0c0ff;--lumiverse-primary-hover:#ecd8ff;--lumiverse-text:#e2c8fa}"],
  ["raised text scale", ":root{--lumiverse-font-scale:1.5;--lumiverse-ui-scale:1.5}"],
  // The whole panel on a light theme, held to exactly the same floor as dark.
  ["light theme", LIGHT],
  // A light theme pack that overrides the common variables and not all 92,
  // which is what a hand-written theme actually looks like. Every fallback in
  // the source is a dark colour, so anything reaching for a variable this
  // leaves unset is measured against the wrong surface. The reported bug: the
  // hint popover painted near-white over an unset card-bg-solid, measured as
  // the dark fallback underneath, and had its text repainted white to match.
  ["partial light theme", PARTIAL_LIGHT],
  // The harshest one: a light page with every theme variable left at its dark
  // value. Nothing here can be got right by reading a variable, so anything
  // that still reads on this reads anywhere.
  ["dark variables on a light page", LIGHT_PAGE],
  // And a light theme whose accent has drifted close to its own text colour,
  // which is the light-side version of the bug that started all of this.
  ["light theme, pale accent", LIGHT + ":root{--lumiverse-primary:rgba(196,180,232,.9);--lumiverse-primary-hover:rgba(206,192,240,.95)}"],
]) {
  const { out, errors } = await inPanel(browser, { css }, (page) =>
    page.evaluate(CONTRAST_PROBE),
  );
  check(`${label}: all ${out.count} labels clear 3.0`, out.under3.length === 0, out.under3);
  check(`${label}: no console errors`, errors.length === 0, errors);
  if (label === "raised text scale") {
    // The panel is interface chrome and must not follow the reader's text-size
    // setting; doing so once made it grow until barely one section fitted.
    check("raised text scale: panel text does not grow", out.labelPx === 13, out.labelPx);
  }
}

// ---- the theme swapped under a panel that is already open ----
// Every check above opens the panel on a theme and measures it. This opens it on
// one theme and then changes the theme, which is what happens when somebody
// moves their phone from dark to light with the panel up. The repairs the panel
// made are only right for the theme they measured, and nothing rebuilds the
// panel on a theme change, so without a watch they stay: text repainted white to
// survive a dark card, still white once that card is white.
console.log("\ntheme swapped under an open panel");
for (const [label, before, after] of [
  ["dark to light", "", LIGHT],
  ["light to dark", LIGHT, THEME],
]) {
  const { out, errors } = await inPanel(browser, { css: before }, async (page) => {
    const was = await page.evaluate(CONTRAST_PROBE);
    await page.addStyleTag({ content: after });
    // The watch settles before it re-measures, and the repairs land a frame
    // after that.
    await page.waitForTimeout(500);
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );
    const now = await page.evaluate(CONTRAST_PROBE);
    return { was: was, now: now };
  });
  check(
    `${label}: readable before the swap`,
    out.was.under3.length === 0,
    out.was.under3,
  );
  check(
    `${label}: all ${out.now.count} labels clear 3.0 after it`,
    out.now.under3.length === 0,
    out.now.worst.text + " at " + out.now.worst.r + "; " + out.now.under3.join(", "),
  );
  check(`${label}: no console errors`, errors.length === 0, errors);
}

// ---- a repair has to land on the frame the reader sees ----
// Anything the panel adds is measured against the page once it is in it. Left to
// the next frame, it is drawn once in the theme's own colours and once in the
// repaired ones, so a row appears and then changes colour under the reader.
console.log("\nrepainting on a press");
{
  // A theme that has all but erased its own text, so there is a real repair to
  // watch. Nothing here is wrong with the panel.
  const cruel = ":root{--lumiverse-text-muted:rgba(255,255,255,.1);--lumiverse-text:rgba(255,255,255,.2)}";
  const { out, errors } = await inPanel(browser, { css: cruel }, (page) =>
    page.evaluate(async () => {
      const modal = document.getElementById("modal");
      const read = () => [...modal.querySelectorAll("*")].map((n) => getComputedStyle(n).color);
      const inked = () => modal.querySelectorAll("[data-ar-ink]").length;
      // The + on a rule list, which is the plainest press that puts new rows on
      // the panel rather than changing ones already there.
      const press = [...modal.querySelectorAll("button")].find(
        (b) => b.textContent.trim() === "+",
      );
      const was = modal.querySelectorAll("*").length;
      const inkWas = inked();
      press.click();
      // What the next frame is painted with, read before it gets one.
      const atOnce = read();
      const inkAtOnce = inked();
      await new Promise((r) => setTimeout(r, 400));
      const later = read();
      let moved = 0;
      for (let i = 0; i < Math.min(atOnce.length, later.length); i++)
        if (atOnce[i] !== later[i]) moved++;
      return { moved, was, added: atOnce.length - was, inkWas, inkAtOnce, inkLater: inked() };
    }),
  );
  check("the press puts rows on the panel, or this proves nothing", out.added > 4, out.added);
  check(
    "and this theme leaves them needing a repair, or this proves nothing",
    out.inkLater > out.inkWas,
    out.inkWas + " before, " + out.inkLater + " after",
  );
  check(
    "which they carry on their first frame",
    out.inkAtOnce === out.inkLater,
    out.inkAtOnce + " of " + out.inkLater + " were there in time",
  );
  check(
    "so nothing changes colour after the frame it appeared on",
    out.moved === 0,
    out.moved + " changed colour after the frame",
  );
  check("no console errors", errors.length === 0, errors);
}

// ---- the prompt the model was handed ----
// The one view that is fed entirely from the backend, and until now the stub
// had no bridge at all, so nothing here was covered.
console.log("\nthe prompt view");
{
  const { out, errors } = await inPanel(browser, { settings: { liveLog: true } }, (page) =>
    page.evaluate(async () => {
      const rows = (chatId) => ({
        type: "prompt_snapshot",
        at: Date.now(),
        chatId,
        messages: [
          { role: "system", content: "a wrapper line", history: false, note: false, noteIndex: 0 },
          { role: "user", content: "the words I typed", history: true, note: false, noteIndex: 0 },
        ],
        total: 2,
        notes: 0,
      });
      const wait = () => new Promise((r) => setTimeout(r, 120));
      const said = () => document.body.innerText;
      const tab = (name) =>
        [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === name);
      const asked = () => window.__sent.filter((m) => m.type === "set_prompt_capture");
      const before = asked().length;
      tab("Prompt").click();
      await wait();
      const armed = asked().slice(before);
      // The chat you are in, as the host would say it.
      if (window.__handlers.CHAT_CHANGED) window.__handlers.CHAT_CHANGED({ chatId: "here-1" });
      await wait();
      window.__fromBackend(rows("here-1"));
      await wait();
      const mine = said();
      // One captured somewhere else is withheld, and the two ids are named so a
      // host that says the same chat two ways can be told from a real move.
      window.__fromBackend(rows("elsewhere-2"));
      await wait();
      const other = said();
      return {
        armed,
        mineHasIt: mine.includes("the words I typed"),
        otherHasIt: other.includes("the words I typed"),
        otherNames: other.includes("elsewhere-2") && other.includes("here-1"),
      };
    }),
  );
  check(
    "opening it asks the backend to start capturing",
    out.armed.length === 1 && out.armed[0].on === true,
    JSON.stringify(out.armed),
  );
  check("a prompt for the chat you are in is drawn", out.mineHasIt);
  check("one captured elsewhere is not", !out.otherHasIt);
  check("and it names both chats, so a mismatch can be seen", out.otherNames);
  check("no console errors", errors.length === 0, errors);
}

// ---- a hint must not move the list ----
console.log("\nhints");
{
  const { out, errors } = await inPanel(
    browser,
    { viewport: { width: 480, height: 1030 }, touch: true },
    (page) =>
      page.evaluate(async () => {
        const frame = () =>
          new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const modal = document.getElementById("modal");
        const pops = () => document.querySelectorAll('[role="tooltip"]').length;
        const infos = [...modal.querySelectorAll("button[data-ar-hint]")];
        // The setting's name, which is a label where the row has a control to
        // name and a span where it has none.
        const below = [...modal.querySelectorAll("label,span")].find(
          (s) => s.textContent === "Floating on/off button",
        );
        const before = below.getBoundingClientRect().top;
        infos[0].click();
        // Straight after the press, before the fade has run.
        const early = document.querySelector('[role="tooltip"]');
        const faded = !!early && Number(getComputedStyle(early).opacity) < 1;
        await frame();
        await new Promise((r) => setTimeout(r, 220));
        const moved = Math.round(below.getBoundingClientRect().top - before);
        const el = document.querySelector('[role="tooltip"]');
        const r = el && el.getBoundingClientRect();
        const onScreen = !!r && r.left >= 0 && r.right <= 480 && r.top >= 0 && r.bottom <= 1030;
        const bg = el && getComputedStyle(el).backgroundColor;
        const alpha = bg && bg.match(/[\d.]+/g);
        const opaque = !!alpha && (alpha[3] === undefined || Number(alpha[3]) === 1);
        infos[1].click();
        await frame();
        const afterSecond = pops();
        infos[1].click();
        await frame();
        await new Promise((r) => setTimeout(r, 220));
        const afterRetap = pops();
        infos[0].click();
        await frame();
        document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
        await frame();
        await new Promise((r) => setTimeout(r, 220));
        const afterOutside = pops();
        infos[0].click();
        await frame();
        const scroller = [...modal.querySelectorAll("div")].find(
          (d) => getComputedStyle(d).overflowY === "auto",
        );
        scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
        await frame();
        await new Promise((r) => setTimeout(r, 220));
        const afterScroll = pops();
        // The last row on the page has to flip above its "?" rather than run off.
        infos[infos.length - 1].scrollIntoView();
        await frame();
        infos[infos.length - 1].click();
        await frame();
        const last = document.querySelector('[role="tooltip"]');
        const lr = last && last.getBoundingClientRect();
        return {
          count: infos.length,
          faded,
          moved,
          onScreen,
          afterSecond,
          afterRetap,
          afterOutside,
          afterScroll,
          opaque,
          background: bg,
          lastOnScreen: !!lr && lr.bottom <= 1030 && lr.top >= 0,
        };
      }),
  );
  check("a hint moves nothing below it", out.moved === 0, out.moved);
  check("and fades in rather than appearing", out.faded, out);
  check("the popover lands on screen", out.onScreen);
  // It covers the row it is explaining. At anything under full opacity that
  // row's text reads through the description sitting on top of it, which no
  // contrast measurement catches because both are "correct" colours.
  check("the popover is opaque", out.opaque, out.background);
  check("only one is ever open", out.afterSecond === 1, out.afterSecond);
  check("a second tap closes it", out.afterRetap === 0);
  check("a tap elsewhere closes it", out.afterOutside === 0);
  check("scrolling closes it", out.afterScroll === 0);
  check("the last row's hint flips above", out.lastOnScreen);
  check("no console errors", errors.length === 0, errors);
}

// ---- a hint must never cover the setting it explains ----
// Measured against the row, not the "?" button. That button is 18px tall and
// sits partway down a row that can be two lines high, so anchoring to it drops
// the description on top of the setting being asked about. Reading the row also
// holds at any scale the host applies, since it reads what was painted.
// ---- a note is not thrown away on one press ----
{
  // A note holds writing somebody typed and there is no undo, so it goes the
  // way a preset does. The panel here is carried by the page, which is the
  // layout where a dialog would cost the reader their place, so the question is
  // asked on the button itself.
  const { out, errors } = await inPanel(
    browser,
    { viewport: { width: 480, height: 1030 }, touch: true, settings: { refusalNote: true } },
    (page) =>
      page.evaluate(async () => {
        const frame = () =>
          new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const modal = document.getElementById("modal");
        const notes = () => modal.querySelectorAll("[data-ar-note-drop]").length;
        const add = [...modal.querySelectorAll("button")].find(
          (b) => b.getAttribute("aria-label") === "Add another note",
        );
        if (!add) return { skipped: true };
        // Two of them, since the last one cannot be removed.
        add.click();
        await frame();
        const had = notes();
        const drop = modal.querySelector('[data-ar-note-drop="1"]');
        drop.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
        drop.click();
        await frame();
        await new Promise((r) => setTimeout(r, 200));
        const afterOne = notes();
        const said = (document.getElementById("__lvRetryToast") || {}).textContent || "";
        const again = modal.querySelector('[data-ar-note-drop="1"]');
        if (again) {
          again.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
          again.click();
        }
        await frame();
        // Past the travel that closes its space.
        await new Promise((r) => setTimeout(r, 420));
        return { had, afterOne, said, afterTwo: notes() };
      }),
  );
  check("there are two notes to work with", out.had === 2, out);
  check("one press removes nothing", out.afterOne === out.had, out);
  check("and it says what a second press would do", /press it again/i.test(out.said), out.said);
  check("the second press removes it", out.afterTwo === out.had - 1, out);
  check("no console errors", errors.length === 0, errors);
}

// ---- pointing at a button without freezing the page ----
{
  // The stop button only exists while a reply is generating, and the only way to
  // make one generate is to press send. Catching the next press anywhere meant
  // that press was the one caught, so there was no way to reach the thing being
  // pointed at. A press held is the pick; a press that is not held does what it
  // always does.
  const { out, errors } = await inPanel(
    browser,
    { viewport: { width: 480, height: 1030 }, touch: true },
    (page) =>
      page.evaluate(async () => {
        const frame = () =>
          new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        // The send button and the stop button, as Lumiverse draws them.
        const send = document.createElement("button");
        send.type = "button";
        send.setAttribute("aria-label", "Nudge for a fresh reply");
        send.textContent = "send";
        let sent = 0;
        send.addEventListener("click", () => { sent++; });
        document.body.appendChild(send);

        const stop = document.createElement("button");
        stop.type = "button";
        stop.setAttribute("aria-label", "Stop generating");
        stop.textContent = "stop";
        let stopped = 0;
        stop.addEventListener("click", () => { stopped++; });
        document.body.appendChild(stop);

        const at = (n) => {
          const b = n.getBoundingClientRect();
          return { clientX: b.left + 2, clientY: b.top + 2, bubbles: true, pointerType: "touch" };
        };
        const tap = async (n) => {
          n.dispatchEvent(new PointerEvent("pointerdown", at(n)));
          n.dispatchEvent(new PointerEvent("pointerup", at(n)));
          n.click();
          await frame();
        };
        const hold = async (n) => {
          n.dispatchEvent(new PointerEvent("pointerdown", at(n)));
          await new Promise((r) => setTimeout(r, 640));
          n.dispatchEvent(new PointerEvent("pointerup", at(n)));
          n.click();
          await frame();
        };

        const modal = document.getElementById("modal");
        const row = modal.querySelector('[data-ar-row="stopSelector"]');
        if (!row) return { skipped: true };
        const pick = [...row.querySelectorAll("button")].find((b) => /pick it for me/i.test(b.textContent));
        if (!pick) return { skipped: true };
        pick.click();
        await frame();

        // A normal press on send has to still work: it is how a reply starts.
        await tap(send);
        const afterSend = sent;
        // And a hold on stop is the pick.
        await hold(stop);
        await new Promise((r) => setTimeout(r, 200));
        return {
          afterSend,
          stopped,
          held: (window.__cfgPeek && window.__cfgPeek()) || null,
          sel: (document.querySelector('[data-ar-row="stopSelector"] input') || {}).value,
        };
      }),
  );
  check("a press that is not held still works while picking", out.afterSend === 1, out);
  check("the held press does not also fire the button", out.stopped === 0, out);
  check(
    "and holding it writes a selector that names it",
    /Stop generating/.test(String(out.sel || "")),
    out,
  );
  check("no console errors", errors.length === 0, errors);
}

// ---- what each part of a row answers to ----
{
  // A label with no `for` names the first labelable element inside it, and a
  // button is one, so the "?" on these rows took the label off the setting:
  // pressing a setting's own words opened its description instead of flipping
  // its switch, and the switch was left with only its own small box to press.
  // Invisible from the "?" alone, which is why this presses the words too.
  const { out, errors } = await inPanel(
    browser,
    { viewport: { width: 480, height: 1030 }, touch: true },
    (page) =>
      page.evaluate(async () => {
        const frame = () =>
          new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const press = (n) => {
          n.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
          n.click();
        };
        const modal = document.getElementById("modal");
        const rows = [...modal.querySelectorAll("[data-ar-row]")].filter(
          (r) => r.querySelector("button[data-ar-hint]") && r.querySelector("[data-ar-check]"),
        );
        const out = { n: 0, wrong: [], pressed: 0, bad: [] };
        // Read rather than pressed, so every one of them is covered. The row
        // itself must not be the label: the whole row as one press target made
        // every part of it a press on the switch, the description under it and
        // the boxes of the rows nested inside it included.
        for (const row of rows) {
          out.n++;
          const tick = row.querySelector("[data-ar-check]");
          const name = String(row.getAttribute("data-ar-row") || "").slice(0, 26);
          if (row.tagName === "LABEL") out.wrong.push("the whole row is the label: " + name);
          const words = row.querySelector("label");
          if (!words) out.wrong.push("the words are not a label: " + name);
          else if (words.control !== tick) out.wrong.push("the words name the wrong control: " + name);
        }
        // And pressed, on a few, both ways.
        for (const row of rows.slice(0, 6)) {
          const tick = row.querySelector("[data-ar-check]");
          const q = row.querySelector("button[data-ar-hint]");
          const words = row.querySelector("label");
          if (!words) continue;
          out.pressed++;
          const name = String(row.getAttribute("data-ar-row") || "").slice(0, 26);
          row.scrollIntoView({ block: "center" });
          await frame();
          let was = tick.checked;
          press(words);
          await frame();
          await new Promise((r) => setTimeout(r, 250));
          if (tick.checked === was) out.bad.push("the words did not flip it: " + name);
          if (document.querySelector('[role="tooltip"]'))
            out.bad.push("the words opened the description: " + name);
          press(words);
          await frame();
          await new Promise((r) => setTimeout(r, 250));
          was = tick.checked;
          press(q);
          await frame();
          await new Promise((r) => setTimeout(r, 250));
          if (tick.checked !== was) out.bad.push("the ? flipped it: " + name);
          if (!document.querySelector('[role="tooltip"]'))
            out.bad.push("the ? opened nothing: " + name);
          const pop = document.querySelector('[role="tooltip"]');
          if (pop) press(pop);
          await frame();
          await new Promise((r) => setTimeout(r, 250));
        }
        return out;
      }),
  );
  check("there are tick rows with a ? to check", out.n >= 10, out.n);
  check(
    `on all ${out.n}, the words name the switch and not the ?`,
    out.wrong.length === 0,
    out.wrong.slice(0, 4),
  );
  check(
    `pressing the words on ${out.pressed} of them flips the switch, and the ? opens the description`,
    out.bad.length === 0,
    out.bad.slice(0, 4),
  );
  check("no console errors", errors.length === 0, errors);
}

// ---- the press that closes a hint does only that ----
{
  // Closing happens on the way down, and the click that follows lands on
  // whatever was under the finger, so dismissing a description by tapping the
  // panel also flipped whichever tick it landed on.
  const { out, errors } = await inPanel(
    browser,
    { viewport: { width: 480, height: 1030 }, touch: true },
    (page) =>
      page.evaluate(async () => {
        const frame = () =>
          new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const modal = document.getElementById("modal");
        const info = modal.querySelector("button[data-ar-hint]");
        // A tick well away from the "?" being pressed, so the press that closes
        // the description lands on this and nothing else.
        const tick = [...modal.querySelectorAll('[data-ar-check]')].pop();
        if (!info || !tick) return { skipped: true };
        info.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
        info.click();
        await frame();
        const opened = document.querySelectorAll('[role="tooltip"]').length;
        const was = tick.checked;
        // A finger landing on the tick, the whole gesture as a browser sends it.
        tick.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
        tick.click();
        await frame();
        await new Promise((r) => setTimeout(r, 240));
        const after = tick.checked;
        const stillOpen = document.querySelectorAll('[role="tooltip"]').length;
        // And the press after it works normally, or the guard has outstayed the
        // gesture it was armed for.
        tick.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
        tick.click();
        await frame();
        return { opened, was, after, stillOpen, then: tick.checked };
      }),
  );
  check("a hint was open to close", out.opened === 1, out);
  check("the press that closes it does not flip the setting under it", out.after === out.was, out);
  check("and it did close", out.stillOpen === 0, out);
  check("while the press after it works normally", out.then !== out.was, out);
  check("no console errors", errors.length === 0, errors);

  // A gesture that closes a description without ever producing a click, which is
  // what a drag or a scroll is. The guard must not still be sitting there
  // waiting to eat the next real press.
  const dragged = await inPanel(
    browser,
    { viewport: { width: 480, height: 1030 }, touch: true },
    (page) =>
      page.evaluate(async () => {
        const frame = () =>
          new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const modal = document.getElementById("modal");
        const info = modal.querySelector("button[data-ar-hint]");
        const tick = [...modal.querySelectorAll("[data-ar-check]")].pop();
        info.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
        info.click();
        await frame();
        // A finger going down on the panel and dragging away. No click follows a
        // drag, so nothing arrives to spend the guard on.
        document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
        await frame();
        await new Promise((r) => setTimeout(r, 240));
        const closed = document.querySelectorAll('[role="tooltip"]').length === 0;
        const was = tick.checked;
        tick.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
        tick.click();
        await frame();
        return { closed, was, then: tick.checked };
      }),
  );
  check("a drag closes the description", dragged.out.closed, dragged.out);
  check("and the press after a drag is not eaten", dragged.out.then !== dragged.out.was, dragged.out);
}

console.log("\nhints do not cover their own row");
// The scales below are the range of Lumiverse's own UI Scale slider, which
// runs 0.8 to 1.5. It applies as a zoom on the page, and the popover is
// parented to the page so it gets zoomed too. Zooming only #modal leaves the
// popover and the row in one coordinate space, which passes while the real
// thing is broken at 0.9, so the zoom goes on the page.
for (const [label, css, viewport] of [
  ["normal", ""],
  ["UI Scale 0.8", "body{zoom:0.8}"],
  ["UI Scale 0.9", "body{zoom:0.9}"],
  ["UI Scale 1.5", "body{zoom:1.5}"],
  ["scaled by transform", "body{transform:scale(0.9);transform-origin:top left}"],
  ["larger host text", "#modal{font-size:20px}"],
  // A narrow phone at the top of the scale. The popover's width is a cap in
  // screen pixels written in the element's own units, and a zoom is the
  // difference between the two: at 480 wide the widest it can be still fits
  // after being zoomed, so every case above passes while a smaller phone is
  // broken. 360 is a small phone and 1.5 is the top of Lumiverse's slider.
  ["small phone at UI Scale 1.5", "body{zoom:1.5}", { width: 360, height: 800 }],
]) {
  const { out, errors } = await inPanel(
    browser,
    { css, viewport: viewport || { width: 480, height: 1030 }, touch: true },
    (page) =>
      page.evaluate(async () => {
        const frame = () =>
          new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const modal = document.getElementById("modal");
        const overlaps = (a, b) =>
          !(a.bottom <= b.top || a.top >= b.bottom || a.right <= b.left || a.left >= b.right);
        const infos = [...modal.querySelectorAll("button[data-ar-hint]")];
        const covering = [];
        let offscreen = 0;
        for (const info of infos) {
          info.scrollIntoView({ block: "center" });
          await frame();
          info.click();
          await frame();
          const pop = document.querySelector('[role="tooltip"]');
          if (!pop) {
            covering.push("no popover opened");
            continue;
          }
          const row = info.closest("[data-ar-row]");
          const pr = pop.getBoundingClientRect();
          if (overlaps(pr, row.getBoundingClientRect())) {
            covering.push((row.textContent || "").trim().slice(0, 28));
          }
          if (pr.left < -1 || pr.right > innerWidth + 1 || pr.top < -1 || pr.bottom > innerHeight + 1)
            offscreen++;
          pop.click();
          await frame();
        }
        // Tapping the description itself dismisses it, which is the first thing
        // a thumb reaches for on a phone.
        infos[0].click();
        await frame();
        const wasOpen = !!document.querySelector('[role="tooltip"]');
        const p2 = document.querySelector('[role="tooltip"]');
        if (p2) p2.click();
        await frame();
        await new Promise((r) => setTimeout(r, 220));
        return {
          checked: infos.length,
          covering,
          offscreen,
          tapDismiss: wasOpen && !document.querySelector('[role="tooltip"]'),
        };
      }),
  );
  check(`${label}: none of ${out.checked} hints cover their row`, out.covering.length === 0, out.covering.slice(0, 4));
  check(`${label}: none drift off screen`, out.offscreen === 0, out.offscreen);
  check(`${label}: tapping the description closes it`, out.tapDismiss);
  check(`${label}: no console errors`, errors.length === 0, errors);
}

// ---- keyboard reach, and the search ----
console.log("\nkeyboard and search");
{
  const { out, errors } = await inPanel(browser, {}, (page) =>
    page.evaluate(async () => {
      const frame = () =>
        new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const modal = document.getElementById("modal");
      // A setting's name is a label where its row has a control to name and a
      // span where it has none, so both count as the words on screen.
      const vis = (w) =>
        [...modal.querySelectorAll("label,span")].filter(
          (s) => s.textContent === w && s.offsetParent !== null,
        ).length;
      const heads = [...modal.querySelectorAll('[role="button"][aria-expanded]')];
      const refusal = heads.find((h) => /refusal tuning/i.test(h.textContent || ""));
      refusal.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await frame();
      const afterEnter = { exp: refusal.getAttribute("aria-expanded"), vis: vis("Extra thinking tag names") };
      refusal.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
      // Closing travels, so the body is still on screen for the length of it.
      // The header says shut straight away; the room it took goes as it goes.
      await new Promise((r) => setTimeout(r, 260));
      const afterSpace = { exp: refusal.getAttribute("aria-expanded"), vis: vis("Extra thinking tag names") };
      const search = modal.querySelector('input[type=search]');
      search.value = "blank";
      search.dispatchEvent(new Event("input"));
      const filtered = { hit: vis("It came back blank"), miss: vis("Most tries per message") };
      search.value = "";
      search.dispatchEvent(new Event("input"));
      const cleared = { hit: vis("It came back blank"), miss: vis("Most tries per message") };
      const panel = modal.firstElementChild;
      return {
        sections: heads.length,
        focusable: heads.every((h) => h.getAttribute("tabindex") === "0"),
        afterEnter,
        afterSpace,
        filtered,
        cleared,
        searchAlwaysVisible: search.getBoundingClientRect().width > 100,
        panelHeight: Math.round(panel.getBoundingClientRect().height),
      };
    }),
  );
  // Four sections start shut: refusal tuning, buttons, debug info and
  // import / export. The count is asserted exactly, so a section that quietly
  // stops being collapsible is caught here.
  check("every section header is focusable", out.focusable && out.sections === 4, out.sections);
  check("Enter opens a section", out.afterEnter.exp === "true" && out.afterEnter.vis === 1, out.afterEnter);
  check("Space closes it", out.afterSpace.exp === "false" && out.afterSpace.vis === 0, out.afterSpace);
  check("search filters", out.filtered.hit === 1 && out.filtered.miss === 0, out.filtered);
  check("clearing restores every row", out.cleared.hit === 1 && out.cleared.miss === 1, out.cleared);
  check("the search field is always visible", out.searchAlwaysVisible);
  check("the panel uses the height it is given", out.panelHeight > 500, out.panelHeight);
  check("no console errors", errors.length === 0, errors);
}

// ---- what is reachable without opening anything ----
// Everything checked here has to be readable the moment the panel opens, with
// nothing clicked. Headings over a single row, and a switch behind a collapsed
// heading of its own, both fail that.
console.log("\nwhat is on screen straight away");
{
  const { out, errors } = await inPanel(browser, {}, (page) =>
    page.evaluate(async () => {
      const modal = document.getElementById("modal");
      const shown = (t) =>
        [...modal.querySelectorAll("div,span,label")].some(
          (e) => (e.textContent || "").trim() === t && e.offsetParent !== null,
        );
      const heads = [...modal.querySelectorAll('[role="button"][aria-expanded]')];
      // Open sections are the ones with no caret to press.
      const open = [...modal.querySelectorAll("div")]
        .filter((d) => /^(Basics|How it retries|When to count a reply as bad)$/.test((d.textContent || "").trim()))
        .filter((d) => d.offsetParent !== null && !d.getAttribute("role"));
      return {
        panelSwitch: shown("Show the on-screen panel"),
        rerollSwitch: shown("Retry by adding a new reroll"),
        frozenRun: shown("Replies that freeze"),
        frozenRow: shown("Give up on a reply that froze (ms)"),
        openHeadings: open.map((d) => (d.textContent || "").trim()).sort(),
        shutHeadings: heads.map((h) => (h.textContent || "").trim()).sort(),
      };
    }),
  );
  check("the on-screen panel switch needs no digging", out.panelSwitch, out);
  check("and neither does the reroll choice", out.rerollSwitch, out);
  check("the frozen-reply rows are under their own heading", out.frozenRun && out.frozenRow, out);
  check(
    "three headings are open and four are shut",
    out.openHeadings.length === 3 && out.shutHeadings.length === 4,
    out,
  );
  check("no console errors", errors.length === 0, errors);
}

// ---- the panel in the sidebar drawer ----
// The same panel in the host's own sidebar rather than a box over the chat.
// It is the same panel, not a second one: one body element, so whichever home
// it is not in has to be gone before the other is built, or the three views
// would render into whichever was made last.
console.log("\nthe panel in the drawer");
{
  const { out, errors } = await inPanel(
    browser,
    { settings: { liveLog: true, panelHome: "drawer" } },
    (page) =>
      page.evaluate(async () => {
        const frame = () =>
          new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const t = window.__drawer;
        const root = t && t.root;
        const tabNames = () =>
          [...root.querySelectorAll('[role="tab"]')].map((b) => b.textContent);
        const inDrawer = {
          registered: !!t,
          id: t && t.opts.id,
          named: !!(t && t.opts.title && t.opts.shortName),
          findable: !!(t && t.opts.description && (t.opts.keywords || []).length),
          hasIcon: !!(t && /<svg/.test(t.opts.iconSvg || "")),
          tabs: tabNames(),
          hasStatus: !!root.querySelector("#__lvRetryStatus"),
          hasBody: !!root.querySelector("#__lvRetryLogBody"),
          // The header is not a drag handle here: the sidebar places it.
          draggableHeader: /cursor:\s*move/.test(root.innerHTML),
          floatingToo: !!document.getElementById("__lvRetryLog"),
        };
        // Switching home takes the other one down before building this one.
        const set = (v) => {
          const sel = [...document.querySelectorAll("select")].find((s) =>
            [...s.options].some((o) => o.value === "drawer"),
          );
          sel.value = v;
          sel.dispatchEvent(new Event("change", { bubbles: true }));
        };
        set("float");
        await frame();
        const afterFloat = {
          floating: !!document.getElementById("__lvRetryLog"),
          drawerGone: !!(t && t.destroyed),
          bodies: document.querySelectorAll("#__lvRetryLogBody").length,
        };
        set("drawer");
        await frame();
        const back = {
          drawer: !!(window.__drawer && !window.__drawer.destroyed),
          floatingGone: !document.getElementById("__lvRetryLog"),
          bodies: document.querySelectorAll("#__lvRetryLogBody").length,
        };
        return { inDrawer, afterFloat, back };
      }),
  );
  check("it registers a drawer tab", out.inDrawer.registered && out.inDrawer.id === "auto-retry-panel", out.inDrawer);
  check("with a name, and words to find it by in the palette",
    out.inDrawer.named && out.inDrawer.findable && out.inDrawer.hasIcon, out.inDrawer);
  check("every tab is in it",
    JSON.stringify(out.inDrawer.tabs) === JSON.stringify(["Log", "Prompt", "Stats", "Replaced"]), out.inDrawer);
  check("with the status line and the body", out.inDrawer.hasStatus && out.inDrawer.hasBody, out.inDrawer);
  check("its header does not offer to be dragged", out.inDrawer.draggableHeader === false, out.inDrawer);
  check("and nothing is floating over the chat as well", out.inDrawer.floatingToo === false, out.inDrawer);
  check("switching to floating takes the drawer tab down",
    out.afterFloat.floating && out.afterFloat.drawerGone && out.afterFloat.bodies === 1, out.afterFloat);
  check("and switching back takes the floating one down",
    out.back.drawer && out.back.floatingGone && out.back.bodies === 1, out.back);
  check("no console errors", errors.length === 0, errors);
}

// ---- the live status keeps moving while the model thinks ----
// Every other busy state carries a figure of its own: a reply arriving counts
// characters, a retry counts down. Thinking and waiting said one fixed sentence
// for as long as they lasted, so on a model that thinks for a minute the panel
// was indistinguishable from one that had frozen.
//
// The second half matters more than the first. A token says what it is, builds
// do not agree on the word, and a label this does not recognise is filed as
// reply text: it lands in the buffer that stands in for the reply when the end
// event carries none, and the panel calls the model's working-out a reply.
console.log("\nthe live status moves while the model is thinking");
{
  for (const label of ["reasoning", "thought", "cot"]) {
    const { out, errors } = await inPanel(
      browser,
      { settings: { liveLog: true, panelHome: "float" } },
      (page) =>
        page.evaluate(async (label) => {
          const wait = (ms) => new Promise((r) => setTimeout(r, ms));
          const read = () => {
            const e = document.getElementById("__lvRetryStatus");
            return e ? e.textContent.trim() : "";
          };
          window.__handlers.GENERATION_STARTED({ chatId: "c1", generationId: "g1", messageId: "m1" });
          await wait(60);
          const atStart = read();
          for (let i = 0; i < 9; i++) {
            window.__handlers.STREAM_TOKEN_RECEIVED({ chatId: "c1", generationId: "g1", token: "weighing ", type: label, seq: i });
            await wait(250);
          }
          const thinking = read();
          for (let i = 0; i < 3; i++) {
            window.__handlers.STREAM_TOKEN_RECEIVED({ chatId: "c1", generationId: "g1", token: "0123456789", type: "content", seq: 90 + i });
            await wait(120);
          }
          // The line repaints on a shared quarter-second clock, so a read taken
          // straight after the last token is a tick behind it.
          await wait(400);
          return { atStart, thinking, arriving: read() };
        }, label),
    );
    check(label + ": the model working is not called a reply arriving",
      /thinking/i.test(out.thinking), out);
    check(label + ": and the line carries how long it has been going",
      /\d+s/.test(out.thinking), out.thinking);
    check(label + ": those tokens are not counted as reply text",
      / 30 characters/.test(out.arriving), out.arriving);
    check(label + ": no console errors", errors.length === 0, errors);
  }
}

// ---- the line says the right thing when streaming is off ----
// With streaming on, tokens arrive and the count climbs. With it off, nothing
// arrives until the reply is finished, so "waiting for the reply to start" is
// wrong twice over: it has started, and nothing will turn up before it is done.
// Nothing exposes the setting, so this is learned from what happens: a token
// proves streaming is on, a reply that finished with text and never sent one
// proves it is off, and until a whole generation has gone by neither is known.
console.log("\nthe live line knows whether the build streams");
{
  const run = (label, body) =>
    inPanel(browser, { settings: { liveLog: true, panelHome: "float" } }, (page) => page.evaluate(body));

  const { out: off, errors: offErrors } = await run("off", async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const read = () => (document.getElementById("__lvRetryStatus") || {}).textContent?.trim() || "";
    // The line holds whatever the last repaint wrote, and the elapsed figure
    // only joins it once a second has gone by, so reading at a fixed moment
    // asks whether a tick happened to land in a particular window. On a loaded
    // machine it does not, and the check fails for a reason that has nothing to
    // do with what it is guarding. Waits for the figure instead, with a
    // deadline: a line that never grows one still fails, which is the point.
    const until = async (re, ms) => {
      const stop = Date.now() + ms;
      let seen = read();
      while (Date.now() < stop && !re.test(seen)) {
        await wait(80);
        seen = read();
      }
      return seen;
    };
    const h = window.__handlers;
    h.GENERATION_STARTED({ chatId: "c1", generationId: "g1", messageId: "m1" });
    await wait(1200);
    const first = read();
    h.GENERATION_ENDED({ chatId: "c1", generationId: "g1", messageId: "m1", content: "She stepped into the rain." });
    await wait(300);
    h.GENERATION_STARTED({ chatId: "c1", generationId: "g2", messageId: "m2" });
    const second = await until(/generating the reply.*\d+s/i, 4000);
    return { first, second };
  });
  check("before anything is known it does not guess", /waiting for the reply to start/i.test(off.first), off);
  check("after a whole reply arrives at once it says generating", /generating the reply/i.test(off.second), off);
  check("and still says how long", /\d+s/.test(off.second), off.second);
  check("streaming off: no console errors", offErrors.length === 0, offErrors);

  const { out: on, errors: onErrors } = await run("on", async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const read = () => (document.getElementById("__lvRetryStatus") || {}).textContent?.trim() || "";
    const h = window.__handlers;
    h.GENERATION_STARTED({ chatId: "c1", generationId: "g1", messageId: "m1" });
    h.STREAM_TOKEN_RECEIVED({ chatId: "c1", generationId: "g1", token: "She ", type: "content", seq: 0 });
    await wait(300);
    h.GENERATION_ENDED({ chatId: "c1", generationId: "g1", messageId: "m1", content: "She stepped into the rain." });
    await wait(300);
    h.GENERATION_STARTED({ chatId: "c1", generationId: "g2", messageId: "m2" });
    await wait(1200);
    return { after: read() };
  });
  check("a build that streams is never called generating", !/generating the reply/i.test(on.after), on);
  check("it waits for the reply to start instead", /waiting for the reply to start/i.test(on.after), on);
  check("streaming on: no console errors", onErrors.length === 0, onErrors);
}

// ---- the panel survives everything that re-syncs it ----
// Putting the panel in two possible homes gave each of them a teardown, and
// both were run on every sync: the one being kept was told to take itself
// down, then declined to rebuild because it was already up. It stayed on
// screen with its tab strip, its body handle and its repaint function all
// nulled, so the tabs stopped switching and Copy and Clear did nothing. Saving
// the settings, closing them, loading a preset and switching chat all sync.
console.log("\nthe panel survives a re-sync");
{
  for (const home of ["float", "drawer"]) {
    const { out, errors } = await inPanel(
      browser,
      { settings: { liveLog: true, panelHome: home } },
      (page) =>
        page.evaluate(async (home) => {
          const frame = () =>
            new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          const panel = () =>
            home === "drawer" ? window.__drawer.root : document.getElementById("__lvRetryLog");
          const tab = (name) =>
            [...panel().querySelectorAll('[role="tab"]')].find((b) => b.textContent === name);
          const selected = () =>
            (panel().querySelector('[role="tab"][aria-selected="true"]') || {}).textContent;
          const bodyText = () =>
            (panel().querySelector("#__lvRetryLogBody").textContent || "").trim();
          const press = (label) =>
            [...panel().querySelectorAll("button")]
              .find((b) => new RegExp("^" + label, "i").test(b.textContent.trim()));

          // Working before the sync, so a failure after it is the sync's doing.
          tab("Stats").click();
          await frame();
          const before = { on: selected(), body: bodyText().slice(0, 40) };

          // Save is one of the five things that re-sync the panel.
          [...document.getElementById("modal").querySelectorAll("button")]
            .find((b) => b.textContent.trim() === "Save").click();
          await frame();

          tab("Log").click();
          await frame();
          const afterLog = { on: selected(), body: bodyText().slice(0, 40) };
          tab("Prompt").click();
          await frame();
          const afterPrompt = { on: selected(), body: bodyText().slice(0, 40) };

          // Copy reads whatever the tab is showing, and says so on the button.
          // Both routes are watched: this origin is not secure, so there is no
          // navigator.clipboard here and it takes the execCommand fallback,
          // which copies whatever is selected in the textarea it just made.
          let copied = null;
          try {
            if (navigator.clipboard)
              navigator.clipboard.writeText = (t) => { copied = t; return Promise.resolve(); };
          } catch (_) {}
          document.execCommand = (cmd) => {
            if (cmd === "copy") copied = (document.activeElement || {}).value ?? null;
            return true;
          };
          tab("Stats").click();
          await frame();
          press("Cop").click();
          await new Promise((r) => setTimeout(r, 60));
          const copyOut = { text: copied, label: press("Cop").textContent.trim() };

          // Clear acts on the tab in front of it, and the view redraws after.
          tab("Log").click();
          await frame();
          const logBefore = bodyText();
          press("Clear").click();
          await frame();
          const logAfter = bodyText();

          return {
            before, afterLog, afterPrompt, copyOut,
            cleared: logBefore !== logAfter || /nothing|no activity/i.test(logAfter),
            stillUp: !!panel() && !!panel().querySelector("#__lvRetryLogBody"),
            onlyOne: document.querySelectorAll("#__lvRetryLogBody").length,
          };
        }, home),
    );
    const n = home === "drawer" ? "in the drawer" : "floating";
    check(n + ": it is still on screen after a save", out.stillUp && out.onlyOne === 1, out);
    check(n + ": the tabs still switch", out.afterLog.on === "Log" && out.afterPrompt.on === "Prompt", out);
    check(n + ": and the body follows the tab",
      out.afterLog.body !== out.afterPrompt.body, out);
    check(n + ": Copy still takes what the tab is showing",
      !!out.copyOut.text && /Replies that came back fine/.test(out.copyOut.text), out.copyOut);
    check(n + ": and says it copied", /copied/i.test(out.copyOut.label), out.copyOut);
    check(n + ": Clear still empties the log", out.cleared, out);
    check(n + ": no console errors", errors.length === 0, errors);
  }
}

// ---- and it is still live after a re-sync ----
// The tabs switching again is not the whole of it: the Log appends as things
// happen and the status line counts down, and both go through the handles a
// sync can null. This fires real generations after the sync rather than reading
// the panel as it was left.
console.log("\nthe panel is still live after a re-sync");
{
  for (const home of ["float", "drawer"]) {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
    await stage(page, '<div id=modal></div><button data-testid="regenerate">Regenerate</button>');
    await page.addStyleTag({ content: THEME });
    await page.addScriptTag({ content: SOURCE, type: "module" });
    await page.waitForFunction(() => !!window.__setup);
    const out = await page.evaluate(async (home) => {
      const frame = () =>
        new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const handlers = {};
      const acts = {};
      let drawer = null;
      const teardown = window.__setup(
        { events: { on: (n, fn) => { handlers[n] = fn; return () => {}; } },
          ui: {
            showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
            registerInputBarAction: (o) => {
              const a = { onClick: (cb) => { a.cb = cb; return () => {}; }, destroy: () => {} };
              acts[o.id] = a;
              return a;
            },
            registerDrawerTab: () => {
              const root = document.createElement("div");
              document.body.appendChild(root);
              drawer = { root, badges: [], setBadge: (v) => drawer.badges.push(v),
                         activate: () => {}, destroy: () => root.remove() };
              return drawer;
            },
          } },
        { liveLog: true, panelHome: home, toast: false, retryDelayMs: 90000,
          backoffFactor: 1, maxDelayMs: 90000, jitter: false, maxRetries: 5,
          stuckTimeoutMs: 0, idleTimeoutMs: 0, pauseWhenFailing: false },
      );
      const body = () => document.getElementById("__lvRetryLogBody");
      const status = () => document.getElementById("__lvRetryStatus");

      // The sync most likely to kill it: open the settings and close them.
      acts["auto-retry-settings"].cb();
      await frame();
      [...document.getElementById("modal").querySelectorAll("button")]
        .find((b) => b.textContent.trim() === "Save").click();
      await frame();

      const logBefore = (body().textContent || "").length;
      handlers.GENERATION_STARTED({ chatId: "c", generationId: "g1" });
      await frame();
      const grewOnStart = (body().textContent || "").length > logBefore;

      handlers.GENERATION_ENDED({ chatId: "c", content: "" });
      let counted = false;
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 50));
        if (/Retrying in/.test(status().textContent || "")) { counted = true; break; }
      }
      const firstRead = (status().textContent || "").trim();
      // The countdown has to keep moving, not just say a number once.
      await new Promise((r) => setTimeout(r, 1200));
      const secondRead = (status().textContent || "").trim();
      const res = {
        grewOnStart,
        counted,
        ticking: firstRead !== secondRead,
        firstRead,
        secondRead,
        badges: drawer ? drawer.badges.filter(Boolean).length : null,
      };
      teardown();
      return res;
    }, home);
    await page.close();
    const n = home === "drawer" ? "in the drawer" : "floating";
    check(n + ": the log still appends as things happen", out.grewOnStart, out);
    check(n + ": the status line still reports a pending retry", out.counted, out);
    check(n + ": and the countdown keeps moving", out.ticking, out);
    if (home === "drawer")
      check(n + ": the tab badge is still being set", out.badges > 0, out);
    check(n + ": no console errors", errors.length === 0, errors);
  }
}

// ---- the way into the drawer ----
// One route, and it has to be the one that is there on a phone: Ctrl+K needs
// a keyboard and the floating button is off by default, so neither can be it.
// Extras is a tap away on any device and is where the settings are opened
// from anyway. Checked with the floating button off, which is the default.
console.log("\nthe way into the drawer");
{
  for (const [home, wanted] of [["drawer", true], ["float", false]]) {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
    await stage(page, "<div id=modal></div>");
    await page.addStyleTag({ content: THEME });
    await page.addScriptTag({ content: SOURCE, type: "module" });
    await page.waitForFunction(() => !!window.__setup);
    const out = await page.evaluate(async (home) => {
      const frame = () =>
        new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const acts = {};
      let activated = 0;
      const teardown = window.__setup(
        { events: { on: () => () => {} },
          ui: {
            showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
            registerInputBarAction: (o) => {
              const a = { id: o.id, label: o.label,
                          onClick: (cb) => { a.cb = cb; return () => {}; },
                          destroy: () => { delete acts[o.id]; } };
              acts[o.id] = a;
              return a;
            },
            registerDrawerTab: () => {
              const root = document.createElement("div");
              document.body.appendChild(root);
              return { root, setBadge: () => {}, activate: () => { activated++; },
                       destroy: () => root.remove() };
            },
          } },
        // No floating button, which is the default, so that route is absent.
        { liveLog: true, panelHome: home, showFloatingToggle: false, toast: false },
      );
      const extras = () => Object.keys(acts);
      const openId = "auto-retry-open-panel";
      const offered = extras().indexOf(openId) >= 0;
      if (offered) { acts[openId].cb(); await frame(); }
      const fromExtras = activated;

      const res = { extras: extras(), offered, fromExtras };
      teardown();
      return res;
    }, home);
    await page.close();
    const n = home === "drawer" ? "in the drawer" : "floating";
    check(n + ": the settings entry is always in Extras",
      out.extras.indexOf("auto-retry-settings") >= 0, out);
    check(n + ": the open entry is " + (wanted ? "in Extras too" : "not in Extras"),
      out.offered === wanted, out);
    if (wanted) check(n + ": and it brings the tab forward", out.fromExtras === 1, out);
    // Exactly one way in, so a second never creeps back alongside it.
    check(n + ": and it is the only entry that opens the panel",
      out.extras.filter((id) => /open/.test(id)).length === (wanted ? 1 : 0), out);
    check(n + ": no console errors", errors.length === 0, errors);
  }
}

// ---- the floating panel squeezed to its minimum ----
// It shares its header with the drawer panel, and it can be dragged down to
// 200 wide by its corner grip, which is narrower than any test had it. The
// header's tabs, Copy and Clear need 195px between them, so 200 is the whole
// margin there is: anything added to that row breaks it here first.
console.log("\nthe floating panel at its narrowest");
{
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  await page.setViewportSize({ width: 360, height: 640 });
  await stage(page, "<div id=modal></div>");
  await page.addStyleTag({ content: THEME });
  await page.addScriptTag({ content: SOURCE, type: "module" });
  await page.waitForFunction(() => !!window.__setup);
  const out = await page.evaluate(async () => {
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const teardown = window.__setup(
      { events: { on: () => () => {} },
        ui: { showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
              registerInputBarAction: () => ({ onClick: () => () => {}, destroy: () => {} }) } },
      { liveLog: true, toast: false },
    );
    const panel = document.getElementById("__lvRetryLog");
    // What the resize grip is allowed to take it down to.
    panel.style.width = "200px";
    panel.style.height = "120px";
    await frame();
    const head = panel.firstElementChild;
    const hr = head.getBoundingClientRect();
    const res = {
      headFits: [...head.querySelectorAll("button")].every(
        (b) => b.getBoundingClientRect().right <= hr.right + 1 &&
               b.getBoundingClientRect().left >= hr.left - 1),
      noSideScroll: head.scrollWidth <= head.clientWidth + 1 &&
                    panel.scrollWidth <= panel.clientWidth + 1,
      tabH: Math.round(head.querySelector('[role="tab"]').getBoundingClientRect().height),
      onScreen: (() => { const r = panel.getBoundingClientRect();
        return r.left >= -1 && r.right <= innerWidth + 1; })(),
    };
    teardown();
    return res;
  });
  await page.close();
  check("at 200 wide the header still holds its tabs and buttons", out.headFits, out);
  check("and nothing has to be scrolled sideways", out.noSideScroll, out);
  check("the tabs stay a finger-sized target", out.tabH >= 30, out);
  check("and it is still on screen", out.onScreen, out);
  check("no console errors", errors.length === 0, errors);
}

// ---- the drawer panel at the widths a drawer actually is ----
// The host owns this frame, so the panel has to survive whatever it is given:
// a narrow sidebar on a desktop, the whole screen on a phone, and a drawer
// that sizes itself to its content rather than filling a height.
console.log("\nthe drawer panel on phone and desktop");
{
  for (const [name, vw, vh, drawerW, bounded, hostCss] of [
    // 200px is the narrowest the floating panel can be dragged to, so it is
    // the narrowest the header is held to in either home.
    ["narrow sidebar", 1280, 800, 200, true],
    ["desktop sidebar", 1280, 800, 380, true],
    ["phone, full width", 360, 640, 360, true],
    ["small phone", 320, 568, 320, true],
    ["a drawer sized by its content", 1280, 800, 320, false],
    // A phone drawer with the host's text turned up. Nothing in the panel
    // should move: it sets its own sizes in pixels rather than inheriting, so
    // this passing is the evidence for that rather than a formality.
    ["phone, larger text", 360, 640, 360, true, "font-size:19px"],
  ]) {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
    await page.setViewportSize({ width: vw, height: vh });
    await stage(page, "<div id=modal></div>");
    await page.addStyleTag({ content: THEME });
    await page.addScriptTag({ content: SOURCE, type: "module" });
    await page.waitForFunction(() => !!window.__setup);
    const out = await page.evaluate(async ([w, bounded, hostCss]) => {
      const frame = () =>
        new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      // A stand-in for the host's drawer: a fixed sidebar of the given width,
      // either filling the height or sized by what is put in it.
      const host = document.createElement("div");
      host.id = "fake-drawer";
      host.style.cssText =
        "position:fixed;right:0;top:0;width:" + w + "px;overflow:hidden;" +
        (bounded ? "bottom:0;" : "height:auto;") + (hostCss || "");
      document.body.appendChild(host);
      const handlers = {};
      const teardown = window.__setup(
        { events: { on: (n, fn) => { handlers[n] = fn; return () => {}; } },
          ui: {
            showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
            registerInputBarAction: () => ({ onClick: () => () => {}, destroy: () => {} }),
            registerDrawerTab: () => {
              const root = document.createElement("div");
              host.appendChild(root);
              return { root, setBadge: () => {}, activate: () => {}, destroy: () => root.remove() };
            },
          } },
        { liveLog: true, panelHome: "drawer", toast: false, retryDelayMs: 90000,
          backoffFactor: 1, maxDelayMs: 90000, jitter: false, maxRetries: 5,
          stuckTimeoutMs: 0, idleTimeoutMs: 0, pauseWhenFailing: false },
      );
      // Give the status line the longest thing it ever says, and the log
      // enough in it to need scrolling.
      handlers.GENERATION_STARTED({ chatId: "c", generationId: "g" });
      handlers.GENERATION_ENDED({ chatId: "c", content: "" });
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 50));
        if (/Retrying in/.test(document.getElementById("__lvRetryStatus").textContent || "")) break;
      }
      await frame();
      const status = document.getElementById("__lvRetryStatus");
      const body = document.getElementById("__lvRetryLogBody");
      const head = status.previousElementSibling;
      const hr = head.getBoundingClientRect();
      const hostR = host.getBoundingClientRect();
      const res = {
        text: (status.querySelector("span:last-child").textContent || "").trim(),
        dotW: Math.round(status.querySelector("span").getBoundingClientRect().width),
        // Nothing may stick out of the drawer sideways, and the drawer itself
        // must not have been pushed wider than the host made it.
        hostW: Math.round(hostR.width),
        overflowsSideways: [head, status, body].some((e) => {
          const r = e.getBoundingClientRect();
          return r.left < hostR.left - 1 || r.right > hostR.right + 1;
        }),
        // Every control in the header, tabs included, inside the header's box.
        headFits: [...head.querySelectorAll("button")].every(
          (b) => b.getBoundingClientRect().right <= hr.right + 1 &&
                 b.getBoundingClientRect().left >= hr.left - 1,
        ),
        // No sideways scrolling anywhere: not the header, not the drawer.
        noSideScroll: head.scrollWidth <= head.clientWidth + 1 &&
                      host.scrollWidth <= host.clientWidth + 1,
        tabH: Math.round(head.querySelector('[role="tab"]').getBoundingClientRect().height),
        // The log scrolls inside itself rather than growing the drawer, which
        // only means anything when the drawer has a height to be bounded by.
        bodyScrolls: getComputedStyle(body).overflow === "auto",
        bodyBottomInside: body.getBoundingClientRect().bottom <= hostR.bottom + 1,
      };
      teardown();
      host.remove();
      return res;
    }, [drawerW, bounded, hostCss]);
    await page.close();
    check(name + ": it fills the width it was given, no more", out.hostW === drawerW && !out.overflowsSideways, out);
    check(name + ": the header's tabs and buttons stay inside it", out.headFits, out);
    check(name + ": nothing has to be scrolled sideways to reach", out.noSideScroll, out);
    check(name + ": the tabs stay a finger-sized target", out.tabH >= 30, out);
    check(name + ": the status line still says what it is waiting for", /Retrying in/.test(out.text), out);
    check(name + ": the dot keeps its size", out.dotW >= 6, out);
    check(name + ": the log scrolls inside the panel", out.bodyScrolls, out);
    if (bounded) check(name + ": and does not run past the drawer", out.bodyBottomInside, out);
    check(name + ": no console errors", errors.length === 0, errors);
  }
}

// ---- a host with no drawer keeps the floating panel ----
console.log("\nno drawer to put it in");
{
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await stage(page, "<div id=modal></div>");
  await page.addStyleTag({ content: THEME });
  await page.addScriptTag({ content: SOURCE, type: "module" });
  await page.waitForFunction(() => !!window.__setup);
  const out = await page.evaluate(async () => {
    // No registerDrawerTab on this host at all, which is the older build.
    window.__setup(
      { events: { on: () => () => {} },
        ui: { showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
              registerInputBarAction: () => ({ onClick: () => () => {}, destroy: () => {} }) } },
      { liveLog: true, panelHome: "drawer" },
    );
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return {
      floating: !!document.getElementById("__lvRetryLog"),
      bodies: document.querySelectorAll("#__lvRetryLogBody").length,
    };
  });
  await page.close();
  check("asking for the drawer on a host without one still shows the panel",
    out.floating && out.bodies === 1, out);
  check("no console errors", errors.length === 0, errors);
}

console.log("\nwhole-list note settings");
{
  const { out, errors } = await inPanel(browser, {}, (page) =>
    page.evaluate(async () => {
      const frame = () =>
        new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const modal = document.getElementById("modal");
      for (const h of modal.querySelectorAll('[role="button"][aria-expanded="false"]')) h.click();
      // Sections travel open now, so their contents have no height for the
      // length of that. Waited out here rather than in every check below.
      await new Promise((r) => setTimeout(r, 260));
      await frame();
      const run = () =>
        [...modal.querySelectorAll("div")].find(
          (d) => d.firstElementChild && d.firstElementChild.textContent === "For the whole list");
      const box = (k) =>
        modal.querySelector('[data-ar-row="' + k + '"]').querySelector("input[type=checkbox]");
      box("refusalNote").click();
      await frame();
      const w = run();
      const keys = w
        ? [...w.querySelectorAll("[data-ar-row]")].map((r) => r.getAttribute("data-ar-row"))
        : null;
      const shownWhileOn = !!w && w.offsetParent !== null;
      // The rows hang off the note switch, so the heading has to go with them
      // rather than be left standing over nothing.
      box("refusalNote").click();
      await frame();
      const shownWhileOff = !!w && w.offsetParent !== null;
      return { keys, shownWhileOn, shownWhileOff };
    }),
  );
  const expect = ["refusalNotePlacement", "refusalNoteStrictType"];
  const same = (a, b) => !!a && a.length === b.length && a.every((x, i) => x === b[i]);
  check("the heading is over exactly the two list-wide settings", same(out.keys, expect), out.keys);
  check("it is there while notes are on", out.shownWhileOn === true, out);
  check("and goes with its rows when they do", out.shownWhileOff === false, out);
  check("no console errors", errors.length === 0, errors);
}

// ---- the one switch that is asked about before it is allowed on ----
// Every other tick in this panel changes how a reply is judged. This one
// decides whether a particular message reaches the person reading it, so it
// stands behind a warning, and the warning is worth nothing if the tick can
// slip past it: the box has to stay off through the question, through a no,
// through Escape, and through the panel being shut on it.
console.log("\nthe crisis check asks first");
{
  const { out, errors } = await inPanel(browser, {}, (page) =>
    page.evaluate(async () => {
      const frame = () =>
        new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const modal = document.getElementById("modal");
      for (const h of modal.querySelectorAll('[role="button"][aria-expanded="false"]')) h.click();
      // Sections travel open now, so their contents have no height for the
      // length of that. Waited out here rather than in every check below.
      await new Promise((r) => setTimeout(r, 260));
      await frame();
      const box = () =>
        modal.querySelector('[data-ar-row="refusalCatchCrisis"] input[type=checkbox]');
      const notice = () => document.querySelector("#__lvRetryCrisisNotice");
      const press = (label) => {
        const b = [...notice().querySelectorAll("button")].find(
          (x) => (x.textContent || "").trim() === label);
        b.click();
      };
      const found = !!box();
      const startsOff = box() ? box().checked === false : null;

      // Ticking it opens the question and leaves the box alone until it is
      // answered, so the panel never shows it on while the answer is pending.
      box().click();
      await frame();
      const asked = !!notice();
      const wording = notice() ? (notice().textContent || "") : "";
      const whileAsking = box().checked;

      // Telling somebody to go and read a page, inside a box they have to
      // answer to get out of, is telling them not to bother. It is a link.
      const a = notice().querySelector("a");
      const link = a
        ? { href: a.getAttribute("href"), target: a.getAttribute("target"),
            rel: a.getAttribute("rel"), text: (a.textContent || "").trim() }
        : null;

      press("Leave it off");
      await frame();
      const afterNo = { open: !!notice(), checked: box().checked };

      // Escape is a no as well, since the answer that changes nothing is the
      // safe one to give by accident.
      box().click();
      await frame();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await frame();
      const afterEscape = { open: !!notice(), checked: box().checked };

      box().click();
      await frame();
      press("I understand, turn it on");
      await frame();
      const afterYes = { open: !!notice(), checked: box().checked };

      // And off again without being asked anything, because switching a thing
      // off is never the risky direction.
      box().click();
      await frame();
      const afterOff = { open: !!notice(), checked: box().checked };
      return { found, startsOff, asked, whileAsking, wording, link, afterNo, afterEscape, afterYes, afterOff };
    }),
  );
  check("the switch is in the panel", out.found === true, out);
  check("and it ships off", out.startsOff === true, out);
  check("ticking it asks first", out.asked === true, out);
  check("the box stays off while the question is open", out.whileAsking === false, out);
  check("the warning says the extension cannot tell the two cases apart",
    /cannot tell the difference/i.test(out.wording) &&
      /does not know anything about you/i.test(out.wording) &&
      /safety page/i.test(out.wording), out.wording.slice(0, 300));
  check("the safety page is a link, not an instruction to go and find it",
    !!out.link && /\/docs\/safety\.md$/.test(out.link.href) && out.link.text === "the safety page", out.link);
  check("and it opens away from the chat, without handing the new tab a way back",
    !!out.link && out.link.target === "_blank" && /noopener/.test(out.link.rel || ""), out.link);
  check("answering no leaves it off", out.afterNo.open === false && out.afterNo.checked === false, out.afterNo);
  check("Escape leaves it off too", out.afterEscape.open === false && out.afterEscape.checked === false, out.afterEscape);
  check("only yes turns it on", out.afterYes.open === false && out.afterYes.checked === true, out.afterYes);
  check("and switching it off again asks nothing", out.afterOff.open === false && out.afterOff.checked === false, out.afterOff);
  check("no console errors", errors.length === 0, errors);
}

// ---- the search field's clear button follows the theme ----
// The browser draws that one itself and colours it from the page's colour
// scheme, so on a dark page it came out white while everything around it was
// themed. It is styled through a pseudo-element, which getComputedStyle will
// not report back, so this reads the pixels instead: it screenshots the right
// hand end of the field and checks the brightest thing there is the muted theme
// colour rather than white.
console.log("\nsearch clear button");
{
  // The fallback in that rule is a dark-theme colour, like every fallback in
  // the source. A light theme that sets the common variables but not
  // --lumiverse-text-muted let it through, and the cross came out near-white on
  // a near-white field. So this runs on light themes too, and asks whether the
  // cross can be told apart from the field rather than whether it is bright.
  const NO_MUTED = PARTIAL_LIGHT.replace("--lumiverse-text-muted:rgba(24,22,30,.6);", "");
  for (const [themeName, themeCss] of [
    ["dark", ""],
    ["light", LIGHT],
    ["light, no muted colour set", NO_MUTED],
    // The worst of it: a light page with every theme variable still dark, so
    // the field's own text colour starts out near-white and has to be put
    // right before the cross can inherit anything worth having. Nothing
    // reading a variable could survive this one.
    ["dark variables on a light page", LIGHT_PAGE],
  ]) {
  const page = await browser.newPage({ viewport: { width: 480, height: 200 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await stage(page, "<div id=modal></div>");
  await page.addStyleTag({ content: THEME + themeCss });
  await page.addScriptTag({ content: SOURCE, type: "module" });
  await page.waitForFunction(() => !!window.__setup);
  const box = await page.evaluate(async () => {
    window.__acts = {};
    window.__setup(
      { events: { on: () => () => {} },
        ui: { showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
              registerInputBarAction: (o) => { const a = { onClick: (cb) => { a.cb = cb; return () => {}; }, destroy: () => {} }; window.__acts[o.id] = a; return a; } } },
      {},
    );
    window.__acts["auto-retry-settings"].cb();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const s = document.querySelector("input[type=search]");
    s.value = "zzzzz";
    s.dispatchEvent(new Event("input"));
    // Chromium only paints the clear button while the field has focus.
    s.focus();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const r = s.getBoundingClientRect();
    // Well inside the field's own edge: the focus ring sits on the border and
    // is brighter than the glyph, so sampling that far out would measure the
    // ring instead of the cross.
    return { styled: !!document.getElementById("__lvRetryPanelStyle"),
             id: s.id,
             x: Math.round(r.right - 30), y: Math.round(r.top + 8),
             w: 22, h: Math.round(r.height - 16) };
  });
  const png = await page.screenshot({ clip: { x: box.x, y: box.y, width: box.w, height: box.h } });
  await page.close();
  check(themeName + ": the panel stylesheet is injected", box.styled);
  check(themeName + ": the search field carries the id the rule targets",
    box.id === "__lvRetrySearch", box.id);
  // The field is the colour covering most of the sample and the cross is
  // whatever stands out furthest from it, so this reads the same way round on
  // either kind of theme. A cross that has taken the field's own colour, which
  // is what the leaked fallback amounts to, leaves nothing standing out.
  //
  // Note this cannot prove the untouched button was white: headless Chromium
  // never paints the browser's own clear button, which is why this bug reached
  // a real phone without any check noticing.
  const seen = crossOnField(png);
  check(themeName + ": the clear button stands out from the field",
    !!seen && seen.ratio >= 3, seen);
  check(themeName + ": no console errors", errors.length === 0, errors);
  }
}

// ---- the thing the extension is for ----
// Retrying means clicking a real button in the host's DOM, so it cannot be
// checked without one. This drives the generation events the way Lumiverse
// would and counts the clicks that land on a stand-in regenerate button.
console.log("\nretrying");
{
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await stage(page, '<div id=modal></div><button data-testid="regenerate">Regenerate</button>',);
  await page.addStyleTag({ content: THEME });
  await page.addScriptTag({ content: SOURCE, type: "module" });
  await page.waitForFunction(() => !!window.__setup);
  const out = await page.evaluate(async () => {
    const handlers = {};
    let clicks = 0;
    document.querySelector("[data-testid=regenerate]").addEventListener("click", () => clicks++);
    window.__setup(
      {
        events: { on: (n, fn) => { handlers[n] = fn; return () => {}; } },
        ui: { showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
              registerInputBarAction: () => ({ onClick: () => () => {}, destroy: () => {} }) },
      },
      // Fast and deterministic: no backoff growth, no jitter, no watchdogs.
      { retryDelayMs: 10, backoffFactor: 1, maxDelayMs: 10, jitter: false, maxRetries: 2,
        toast: false, stuckTimeoutMs: 0, idleTimeoutMs: 0, pauseWhenFailing: false },
    );
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    // One message, start to finish. Each case gets its own chat so a budget
    // spent in one does not carry into the next.
    let chatN = 0;
    const run = async (payload) => {
      const chatId = "chat" + ++chatN;
      const before = clicks;
      handlers.GENERATION_STARTED({ chatId, generationId: "g0" });
      handlers.GENERATION_ENDED(Object.assign({ chatId }, payload));
      await wait(60);
      return clicks - before;
    };

    const afterGood = await run({ content: "She opened the door and stepped inside." });
    const afterEmpty = await run({ content: "" });
    // A reply cut off mid-sentence.
    const afterTruncated = await run({ content: 'He said, "wait' });
    // An out-of-character refusal.
    const afterRefusal = await run({ content: "I'm sorry, but I can't create that content." });

    // The cap. A retry click makes the host begin a new generation, and that
    // start is what keeps the budget attached to the same message, so the loop
    // has to emit one or every reply looks like a fresh message with a fresh
    // allowance.
    const b4 = clicks;
    handlers.GENERATION_STARTED({ chatId: "capped", generationId: "x0" });
    for (let i = 0; i < 3; i++) {
      handlers.GENERATION_ENDED({ chatId: "capped", content: "" });
      await wait(40);
      handlers.GENERATION_STARTED({ chatId: "capped", generationId: "x" + (i + 1) });
    }
    const cappedClicks = clicks - b4;

    // A hard failure should be skipped, not retried forever.
    const b5 = clicks;
    handlers.GENERATION_STARTED({ chatId: "hard", generationId: "y1" });
    handlers.GENERATION_ENDED({ chatId: "hard", error: "401 invalid api key" });
    await wait(60);
    const afterHardError = clicks - b5;

    // A user stop must call everything off.
    const b6 = clicks;
    handlers.GENERATION_STARTED({ chatId: "stopped", generationId: "z1" });
    handlers.GENERATION_ENDED({ chatId: "stopped", content: "" });
    handlers.GENERATION_STOPPED({ chatId: "stopped", generationId: "z1" });
    await wait(80);
    const afterStop = clicks - b6;

    return { afterGood, afterEmpty, afterTruncated, afterRefusal, cappedClicks, afterHardError, afterStop };
  });
  await page.close();
  check("a good reply is left alone", out.afterGood === 0, out.afterGood);
  check("an empty reply is retried", out.afterEmpty === 1, out.afterEmpty);
  check("a cut-off reply is retried", out.afterTruncated === 1, out.afterTruncated);
  check("a refusal is retried", out.afterRefusal === 1, out.afterRefusal);
  check("the try limit is respected", out.cappedClicks === 2, out.cappedClicks);
  check("a hard failure is not retried", out.afterHardError === 0, out.afterHardError);
  check("a user stop cancels the pending retry", out.afterStop === 0, out.afterStop);
  check("no console errors", errors.length === 0, errors);
}

// ---- a chat the host does not name ----
// Everything in the extension is keyed by chat, so a reply arriving with no
// chatId used to fall out of every handler: no retry, no watchdog, nothing in
// the log. The host names the chat on every build seen so far, so this guards
// a case nobody has reported. It is checked anyway because the failure was
// silent, which is the kind that reaches users unnoticed.
//
// Each case gets its own page. Sharing one would share the retry budget, and
// the later cases would read as failures for a reason that has nothing to do
// with what they are checking.
console.log("\nchats with no id of their own");
{
  const errors = [];
  const runOne = async (startP, endP, opts = {}) => {
    const page = await browser.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await stage(page, '<div id=modal></div><button data-testid="regenerate">Regenerate</button>');
    await page.addScriptTag({ content: SOURCE, type: "module" });
    await page.waitForFunction(() => !!window.__setup);
    const res = await page.evaluate(async ([startP, endP, opts]) => {
      const handlers = {};
      const sent = [];
      let clicks = 0;
      document.querySelector("[data-testid=regenerate]").addEventListener("click", () => clicks++);
      window.__setup(
        {
          events: { on: (n, fn) => { handlers[n] = fn; return () => {}; } },
          sendToBackend: (m) => sent.push(m),
          onBackendMessage: () => () => {},
          ui: { showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
                registerInputBarAction: () => ({ onClick: () => () => {}, destroy: () => {} }) },
        },
        Object.assign({ retryDelayMs: 10, backoffFactor: 1, maxDelayMs: 10, jitter: false,
          maxRetries: 2, toast: false, stuckTimeoutMs: 0, idleTimeoutMs: 0, pauseWhenFailing: false }, opts),
      );
      handlers.GENERATION_STARTED(startP);
      handlers.GENERATION_ENDED(endP);
      if (opts.__stop) handlers.GENERATION_STOPPED(startP);
      await new Promise((r) => setTimeout(r, 120));
      return { clicks, armed: sent.filter((m) => m && m.type === "arm_refusal_note").length };
    }, [startP, endP, opts]);
    await page.close();
    return res;
  };
  const empty = (extra) => Object.assign({ generationId: "g", content: "" }, extra);
  const noteOn = { refusalNote: true, refusalNotes: [{ text: "stay in character", role: "system", fromTry: 1 }] };

  // The three shapes a build can leave a chat id in. All of them mean the same
  // thing to a reader and used to mean "drop this reply" to the code.
  const absent = await runOne({ generationId: "g" }, empty());
  const isNull = await runOne({ chatId: null, generationId: "g" }, empty({ chatId: null }));
  const isEmpty = await runOne({ chatId: "", generationId: "g" }, empty({ chatId: "" }));
  check("a chat with no id retries when the id is absent", absent.clicks === 1, absent);
  check("a chat with no id retries when the id is null", isNull.clicks === 1, isNull);
  check("a chat with no id retries when the id is an empty string", isEmpty.clicks === 1, isEmpty);

  // Retrying everywhere is not the goal; retrying the same things everywhere
  // is. A version that clicked on any reply at all would pass the three above.
  const good = await runOne({ generationId: "g" },
    { generationId: "g", content: "She opened the door and stepped inside." });
  check("a good reply in a chat with no id is still left alone", good.clicks === 0, good);

  // The one that must not be left behind: standing down is what stops the
  // extension fighting the user, so it has to find the state the retry used.
  const stopped = await runOne({ generationId: "g" }, empty(), { __stop: true });
  check("a user stop in a chat with no id cancels the pending retry", stopped.clicks === 0, stopped);

  // A note is collected by the interceptor for one named chat, and the scope
  // check only bites when both sides carry an id. Arming one with no chat to
  // scope it to would attach it to whichever generation ran next, in any chat.
  const refusal = "I'm sorry, but I can't create that content.";
  const noteNoId = await runOne({ generationId: "g" }, { generationId: "g", content: refusal }, noteOn);
  check("no refusal note is armed for a chat with no id",
    noteNoId.armed === 0, noteNoId);
  check("the retry still happens without the note", noteNoId.clicks === 1, noteNoId);
  const noteWithId = await runOne({ chatId: "c9", generationId: "g" },
    { chatId: "c9", generationId: "g", content: refusal }, noteOn);
  check("a refusal note is still armed for a chat that has one",
    noteWithId.armed === 1, noteWithId);

  check("no console errors", errors.length === 0, errors);
}

// ---- a reply that is streaming is not stuck ----
// The watchdog that waits for a reply to start is armed against the chat the
// start event named, and only text arriving calls it off. A build whose token
// events carry a different chat id than the start, or none at all, used to
// leave that watchdog armed on a chat nobody was going to reach, so it fired
// mid-stream and re-rolled a reply that was writing itself out fine.
//
// The three token shapes are the point of this section. A version that reads
// the token's own chat id passes the first and fails the other two.
console.log("\na reply that is streaming is not stuck");
{
  const errors = [];
  const runOne = async (tokenP) => {
    const page = await browser.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await stage(page, '<div id=modal></div><button data-testid="regenerate">R</button>');
    await page.addScriptTag({ content: SOURCE, type: "module" });
    await page.waitForFunction(() => !!window.__setup);
    const res = await page.evaluate(async (tokenP) => {
      const handlers = {};
      let clicks = 0;
      document.querySelector("[data-testid=regenerate]").addEventListener("click", () => clicks++);
      window.__setup(
        {
          events: { on: (n, fn) => { handlers[n] = fn; return () => {}; } },
          sendToBackend: () => {},
          onBackendMessage: () => () => {},
          ui: { showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
                registerInputBarAction: () => ({ onClick: () => () => {}, destroy: () => {} }) },
        },
        { retryDelayMs: 10, backoffFactor: 1, maxDelayMs: 10, jitter: false, maxRetries: 2,
          toast: false, stuckTimeoutMs: 80, idleTimeoutMs: 0, pauseWhenFailing: false },
      );
      handlers.GENERATION_STARTED({ chatId: "c1", generationId: "g" });
      await new Promise((r) => setTimeout(r, 30));
      handlers.STREAM_TOKEN_RECEIVED(tokenP);
      // Past the point the start watchdog would have fired.
      await new Promise((r) => setTimeout(r, 160));
      return { retriedWhileStreaming: clicks };
    }, tokenP);
    await page.close();
    return res;
  };

  const named = await runOne({ chatId: "c1", generationId: "g", content: "She " });
  const noId = await runOne({ generationId: "g", content: "She " });
  const other = await runOne({ chatId: "c2", generationId: "g", content: "She " });
  check("a token that names the chat calls off the start watchdog",
    named.retriedWhileStreaming === 0, named);
  check("a token that names no chat calls off the start watchdog",
    noId.retriedWhileStreaming === 0, noId);
  check("a token that names a different chat calls off the start watchdog",
    other.retriedWhileStreaming === 0, other);

  check("no console errors", errors.length === 0, errors);
}

// ---- switching off a chat that will not exist tomorrow ----
// A temporary chat has no character card and is discarded on the way out, and
// the next one carries a different id. Remembering an exclusion against it
// would put a line in storage that can never match anything again, so the
// switch works for as long as the chat is open and is not written down.
//
// The stub answers get_active_chat by echoing the requestId it was sent, and
// holds its backend listeners in a list. A single slot drops all but the newest
// and an unmatched requestId is ignored, either of which makes this read as a
// product failure when the fault is in the harness.
console.log("\nswitching off a temporary chat");
{
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await stage(page, '<div id=modal></div><button data-testid="regenerate">R</button>');
  await page.addScriptTag({ content: SOURCE, type: "module" });
  await page.waitForFunction(() => !!window.__setup);
  const out = await page.evaluate(async () => {
    const KEY = "lv-auto-retry:chats-off:v1";
    localStorage.removeItem(KEY);
    window.__acts = {}; window.__handlers = {};
    const sent = [], listeners = [];
    const deliver = (m) => listeners.slice().forEach((f) => { try { f(m); } catch (_) {} });
    const cards = { temp1: false, real1: true };
    const names = { temp1: null, real1: "Wren" };
    window.__setup({
      events: { on: (n, f) => { window.__handlers[n] = f; return () => {}; } },
      sendToBackend: (m) => {
        sent.push(m);
        if (m && m.type === "get_active_chat") {
          const id = m.chatId || window.__cur;
          setTimeout(() => deliver({ type: "active_chat", requestId: m.requestId, chatId: id,
            character: names[id] || null, resolved: true, hasCharacter: !!cards[id] }), 0);
        }
      },
      onBackendMessage: (cb) => {
        listeners.push(cb);
        return () => { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); };
      },
      ui: { showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
            registerInputBarAction: (o) => { const a = { onClick: (cb) => { a.cb = cb; return () => {}; }, destroy: () => {} }; window.__acts[o.id] = a; return a; } },
    }, { toast: false, stuckTimeoutMs: 0, idleTimeoutMs: 0 });

    const tick = () => new Promise((r) => setTimeout(r, 80));
    const enter = async (id) => {
      window.__cur = id;
      window.__handlers.GENERATION_STARTED({ chatId: id, generationId: "g-" + id });
      window.__handlers.GENERATION_ENDED({ chatId: id, generationId: "g-" + id, content: "ok reply here." });
      await tick(); await tick();
    };
    const root = () => document.getElementById("modal");
    const btn = () => [...root().querySelectorAll("button")].find((x) => /Turn (off|on) here/.test(x.textContent));
    const note = () => { const w = root().querySelector("[data-ar-chat-switch]"); return w ? w.innerText.split("\n").pop() : ""; };

    await enter("temp1");
    window.__acts["auto-retry-settings"].cb();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await tick();

    const res = {};
    res.enabled = !btn().disabled;
    res.noteSaysTemporary = /temporary chat/i.test(note());
    btn().click(); await tick();
    res.flipped = /Turn on here/.test(btn().textContent);
    res.storedAfterTemp = localStorage.getItem(KEY);
    res.backendToldTemp = (sent.filter((m) => m.type === "set_chats_off").pop() || {}).chats;

    await enter("real1"); await tick();
    res.realNoteIsOrdinary = !/temporary chat/i.test(note());
    btn().click(); await tick();
    res.storedAfterReal = localStorage.getItem(KEY);
    return res;
  });
  await page.close();
  // The switch is real. A temporary chat is exactly where somebody watching raw
  // model behaviour wants nothing re-rolling it, so this must not be disabled.
  check("the switch still works in a temporary chat", out.enabled && out.flipped, out);
  check("and says it lasts only while that chat is open", out.noteSaysTemporary, out);
  check("an ordinary chat keeps the ordinary wording", out.realNoteIsOrdinary, out);
  // The point of the whole thing.
  check("nothing is written to storage for a temporary chat",
    out.storedAfterTemp === "[]", out.storedAfterTemp);
  // Switched off for the session, so backend word swaps leave it alone too.
  check("the backend is still told, so word swaps skip it",
    Array.isArray(out.backendToldTemp) && out.backendToldTemp.indexOf("temp1") >= 0, out.backendToldTemp);
  // Filtering at the point of writing, not at the point of the change: a later
  // switch in an ordinary chat must not carry the temporary one into storage.
  check("and a later ordinary chat does not drag it into storage",
    out.storedAfterReal === '["real1"]', out.storedAfterReal);
  check("no console errors", errors.length === 0, errors);
}

console.log("\nregeneration feedback");
{
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await stage(page, '<div id=modal></div><button data-testid="regenerate">Regenerate</button>',);
  await page.addStyleTag({ content: THEME });
  await page.addScriptTag({ content: SOURCE, type: "module" });
  await page.waitForFunction(() => !!window.__setup);
  const out = await page.evaluate(async () => {
    const handlers = {};
    const pressed = [];
    let regenClicks = 0;
    let raise = null;

    // The box the host would put up, recording every press it receives.
    const openDialog = (attrs, labels) => {
      const box = document.createElement("div");
      for (const k of Object.keys(attrs)) box.setAttribute(k, attrs[k]);
      for (const label of labels) {
        const b = document.createElement("button");
        b.textContent = label;
        b.addEventListener("click", () => {
          pressed.push(label);
          if (/^skip$/i.test(label)) box.remove(); // as the real one closes
        });
        box.appendChild(b);
      }
      document.body.appendChild(box);
      return box;
    };

    let toolbar = document.querySelector("[data-testid=regenerate]");
    const wireRegen = (btn) => {
      btn.addEventListener("click", () => {
        regenClicks++;
        if (raise) raise();
      });
    };
    wireRegen(toolbar);

    // The host rebuilding its toolbar, which is what a framework does when it
    // re-renders. The button carries the same label but is a different element,
    // so it looks new to anything comparing identity.
    const rerenderToolbar = () => {
      const fresh = document.createElement("button");
      fresh.setAttribute("data-testid", "regenerate");
      fresh.textContent = "Regenerate";
      wireRegen(fresh);
      toolbar.replaceWith(fresh);
      toolbar = fresh;
    };

    window.__setup(
      {
        events: { on: (n, fn) => { handlers[n] = fn; return () => {}; } },
        ui: { showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
              registerInputBarAction: () => ({ onClick: () => () => {}, destroy: () => {} }) },
      },
      { retryDelayMs: 10, backoffFactor: 1, maxDelayMs: 10, jitter: false, maxRetries: 1,
        toast: false, stuckTimeoutMs: 0, idleTimeoutMs: 0, pauseWhenFailing: false },
    );

    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    let chatN = 0;
    // An empty reply is what makes it retry. Each case gets its own chat so a
    // budget spent in one does not carry into the next.
    const retryOnce = async (settleMs) => {
      const chatId = "fb" + ++chatN;
      handlers.GENERATION_STARTED({ chatId, generationId: "g" });
      handlers.GENERATION_ENDED({ chatId, content: "" });
      await wait(settleMs);
    };

    // The real shape: Skip, the box's own Regenerate, and a Cancel that must
    // never be touched. Cancel sits first in the DOM, so picking by document
    // order rather than by preference would press exactly the wrong one.
    raise = () => openDialog(
      { role: "dialog", "data-component": "RegenFeedbackModal" },
      ["Cancel", "Regenerate", "Skip"],
    );
    await retryOnce(500);
    const feedback = { pressed: pressed.slice(), regenClicks };

    // A box holding nothing safe to press must be left alone, and must come
    // back on screen rather than being left invisible.
    pressed.length = 0;
    let stuck = null;
    raise = () => { stuck = openDialog({ role: "dialog" }, ["Cancel", "Delete"]); };
    await retryOnce(1900);
    const refused = {
      pressed: pressed.slice(),
      visible: !!stuck && getComputedStyle(stuck).opacity === "1",
      clickable: !!stuck && getComputedStyle(stuck).pointerEvents !== "none",
    };

    // A box the user already had open before the retry is none of its business.
    pressed.length = 0;
    const mine = openDialog({ role: "dialog" }, ["Confirm"]);
    raise = null;
    await retryOnce(500);
    const preexisting = {
      pressed: pressed.slice(),
      visible: getComputedStyle(mine).opacity === "1",
    };
    mine.remove();

    // Found by the component name alone, with no dialog role and no telltale
    // class, which is how the real box identifies itself.
    pressed.length = 0;
    raise = () => openDialog({ "data-component": "RegenFeedbackModal", class: "wrap" }, ["Skip"]);
    await retryOnce(500);
    const byComponent = pressed.slice();

    // No box at all, just the host rebuilding its toolbar after the click. The
    // fresh Regenerate button carries a label the scan is looking for and was
    // not on screen beforehand, so only its being outside any dialog keeps it
    // from being pressed. Pressing it would re-render again and loop.
    pressed.length = 0;
    const regenBefore = regenClicks;
    raise = () => rerenderToolbar();
    await retryOnce(500);
    const afterRerender = regenClicks - regenBefore;

    // A reply that needs no retry raises no box, so nothing may be pressed.
    pressed.length = 0;
    raise = () => openDialog({ role: "dialog" }, ["Skip"]);
    handlers.GENERATION_STARTED({ chatId: "good", generationId: "g" });
    handlers.GENERATION_ENDED({ chatId: "good", content: "She opened the door and stepped inside." });
    await wait(400);
    const afterGood = pressed.slice();

    return { feedback, refused, preexisting, byComponent, afterRerender, afterGood };
  });
  await page.close();
  check("the feedback box is skipped, never cancelled",
    out.feedback.pressed.length === 1 && out.feedback.pressed[0] === "Skip", out.feedback.pressed);
  check("the toolbar regenerate is pressed once, not looped",
    out.feedback.regenClicks === 1, out.feedback.regenClicks);
  check("a box with nothing safe to press is left alone",
    out.refused.pressed.length === 0, out.refused.pressed);
  check("and is put back on screen afterwards",
    out.refused.visible && out.refused.clickable, out.refused);
  check("a box the user already had open is untouched",
    out.preexisting.pressed.length === 0, out.preexisting.pressed);
  check("and is never hidden", out.preexisting.visible, out.preexisting);
  check("the box is found by its component name alone",
    out.byComponent.length === 1 && out.byComponent[0] === "Skip", out.byComponent);
  check("a rebuilt toolbar button is not mistaken for the box",
    out.afterRerender === 1, out.afterRerender);
  check("a reply needing no retry presses nothing", out.afterGood.length === 0, out.afterGood);
  check("no console errors", errors.length === 0, errors);
}

// ---- the mark is drawn, not typed ----
// A Unicode character would leave the button's shape to whatever font the
// device picks. These check it is an actual drawing, that on and off are told
// apart by more than colour, and that the drawing scales with the button
// instead of staying one size.
console.log("\nicons");
{
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await stage(page, "<div id=modal></div><div id=host></div>");
  await page.addStyleTag({ content: THEME });
  await page.addScriptTag({ content: SOURCE, type: "module" });
  await page.waitForFunction(() => !!window.__setup);
  const out = await page.evaluate(async () => {
    const boot = (over) => {
      const host = document.createElement("div");
      document.getElementById("host").appendChild(host);
      const actions = [];
      window.__setup(
        {
          events: { on: () => () => {} },
          ui: {
            showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
            registerInputBarAction: (o) => { actions.push(o); return { onClick: () => () => {}, destroy: () => {} }; },
            showContextMenu: (o) => { (window.__menus ||= []).push(o); return Promise.resolve({ selectedKey: window.__pick === undefined ? null : window.__pick }); },
            createFloatWidget: () => ({ root: host, destroy: () => {}, setPosition: () => {} }),
          },
        },
        Object.assign({ showFloatingToggle: true, showExtrasToggle: true, toast: false }, over),
      );
      return { host, actions };
    };

    const read = (host) => {
      const btn = host.querySelector("button");
      const svg = btn && btn.querySelector("svg");
      return {
        hasSvg: !!svg,
        // A leftover character would show up as text on the button itself.
        text: btn ? btn.textContent.trim() : "(no button)",
        shapes: svg ? svg.querySelectorAll("rect,circle,line,path").length : 0,
        slashes: svg ? svg.querySelectorAll("line").length : 0,
        // The slash is always in the drawing now and hidden by being drawn at
        // zero length, which is what gives it something to animate along. So
        // whether it shows is the dash offset, not whether the line is there.
        slashShown: (() => {
          const line = svg && svg.querySelector(".lv-ar-slash");
          if (!line) return null;
          const off = parseFloat(getComputedStyle(line).strokeDashoffset) || 0;
          const len = parseFloat(getComputedStyle(line).strokeDasharray) || 0;
          return len > 0 && off < len / 2;
        })(),
        width: svg ? Number(svg.getAttribute("width")) : 0,
      };
    };

    const small = boot({ enabled: true, floatingToggleSize: 28 });
    const large = boot({ enabled: true, floatingToggleSize: 96 });
    const off = boot({ enabled: false, floatingToggleSize: 44 });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    return {
      on: read(small.host),
      big: read(large.host),
      off: read(off.host),
      // Every Extras entry has to carry an icon, or a menu row shows a gap.
      actions: small.actions.map((a) => ({
        id: a.id,
        svg: typeof a.iconSvg === "string" && a.iconSvg.indexOf("<svg") === 0,
      })),
    };
  });
  await page.close();
  check("the float button holds a drawing", out.on.hasSvg && out.on.shapes >= 3, out.on);
  check("and no leftover text character", out.on.text === "", JSON.stringify(out.on.text));
  check("off is marked by a slash, not just colour", out.off.slashShown === true, {
    on: out.on.slashShown, off: out.off.slashShown });
  check("and on is not", out.on.slashShown === false, {
    on: out.on.slashShown, off: out.off.slashShown });
  check("the drawing scales with the button", out.big.width > out.on.width, {
    at28: out.on.width, at96: out.big.width });
  check("it never scales below legible", out.on.width >= 14, out.on.width);
  check("every Extras entry carries an icon",
    out.actions.length > 0 && out.actions.every((a) => a.svg), out.actions);
  check("no console errors", errors.length === 0, errors);
}

// ---- nothing moves, and nothing needs to ----
// The button flips between two states instantly. Transitions on four colour
// properties and a scale dip on every press mean a compositing layer and four
// interpolations for a control that only has to flip. A transition is one line
// to add, and costs a frame every time it runs, so this keeps them out.
{
  const press = async (reducedMotion) => {
    const page = await browser.newPage({ reducedMotion });
    const errs = [];
    page.on("pageerror", (e) => errs.push(e.message));
    await stage(page, "<div id=modal></div><div id=host></div>");
    await page.addStyleTag({ content: THEME });
    await page.addScriptTag({ content: SOURCE, type: "module" });
    await page.waitForFunction(() => !!window.__setup);
    const out = await page.evaluate(async () => {
      const host = document.getElementById("host");
      window.__setup(
        {
          events: { on: () => () => {} },
          ui: {
            showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
            registerInputBarAction: () => ({ onClick: () => () => {}, destroy: () => {} }),
            showContextMenu: (o) => { (window.__menus ||= []).push(o); return Promise.resolve({ selectedKey: window.__pick === undefined ? null : window.__pick }); },
            createFloatWidget: () => ({ root: host, destroy: () => {}, setPosition: () => {} }),
          },
        },
        { enabled: true, showFloatingToggle: true, floatingToggleSize: 44, toast: false },
      );
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const btn = host.querySelector("button");
      const was = btn.style.background;
      btn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      const moved = btn.style.transform;
      // Duration rather than the shorthand: with nothing set, Chromium
      // serializes the shorthand as "all", which reads like something is
      // animating when the duration is what says whether anything is.
      const css = getComputedStyle(btn).transitionDuration;
      // The tap still has to say something, and it says it in colour.
      btn.click();
      await new Promise((r) => requestAnimationFrame(r));
      return { moved, transition: css, recoloured: btn.style.background !== was };
    });
    await page.close();
    return { ...out, errs };
  };
  const normal = await press("no-preference");
  const reduced = await press("reduce");
  for (const [name, r] of [["normally", normal], ["with reduced motion", reduced]]) {
    // The button itself never moves. A press can be the start of a hold that
    // opens the menu, and a dip on the way in would read as a tap that took.
    check(name + ", the button does not move under a press", !r.moved, r.moved);
    check(name + ", a tap still changes its colour", r.recoloured, r);
  }
  // Turning it on and off eases between the two states. Asking for less
  // movement gets the same change with nothing in between.
  check("normally, the colours ease between the two states",
    !/^0s(,\s*0s)*$/.test(String(normal.transition).trim()), normal.transition);
  check("with reduced motion, they change with no animation at all",
    /^0s(,\s*0s)*$/.test(String(reduced.transition).trim()), reduced.transition);
  check("no console errors", normal.errs.length + reduced.errs.length === 0,
    normal.errs.concat(reduced.errs));
}

// ---- holding the float button ----
// The README promised a way to put the button away without opening settings.
// A tap must still toggle, a hold must not, and a drag is the host moving the
// button rather than a hold.
console.log("\nfloat button menu");
{
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await stage(page, "<div id=modal></div><div id=host></div>");
  await page.addStyleTag({ content: THEME });
  await page.addScriptTag({ content: SOURCE, type: "module" });
  await page.waitForFunction(() => !!window.__setup);
  const out = await page.evaluate(async () => {
    const host = document.getElementById("host");
    host.style.cssText = "position:fixed;left:120px;top:120px";
    let widgets = 0;
    const asked = [];
    const acts = {};
    let teardown = window.__setup(
      {
        events: { on: () => () => {} },
        ui: {
          showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
          registerInputBarAction: (o) => {
            const a = { onClick: (cb) => { a.cb = cb; return () => {}; }, destroy: () => {} };
            acts[o.id] = a;
            return a;
          },
          showContextMenu: (o) => { (window.__menus ||= []).push(o); return Promise.resolve({ selectedKey: window.__pick === undefined ? null : window.__pick }); },
          createFloatWidget: (opts) => {
            widgets++;
            asked.push(opts);
            return { root: host, destroy: () => {}, setPosition: () => {} };
          },
        },
      },
      { enabled: true, showFloatingToggle: true, floatingToggleSize: 44, toast: false },
    );
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const btn = () => host.querySelector("button");
    // The menu is the host's now, so what there is to check is what it was
    // asked to show, not what got drawn.
    const shown = () => (window.__menus || []).length;
    const last = () => (window.__menus || [])[(window.__menus || []).length - 1] || null;
    // Entries only. A divider is an item to the host but not a thing anybody
    // can pick, so counting one would make the menu look a row longer than it
    // offers.
    const real = () => (last() ? last().items.filter((i) => i.type !== "divider") : []);
    const items = () => real().map((i) => i.label);
    const down = (el, x, y) => el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: x, clientY: y }));
    // Dispatched at the document, which is what a host that has captured the
    // pointer for its drag would produce. A move aimed at the button would not
    // reach a document listener by bubbling, so this is the harder case.
    const move = (_el, x, y) => document.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: x, clientY: y }));
    const up = (el) => el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));

    // A quick tap toggles and opens nothing.
    const wasOn = btn().getAttribute("aria-pressed");
    down(btn(), 130, 130); await wait(60); up(btn()); btn().click();
    const afterTap = { pressed: btn().getAttribute("aria-pressed"), menu: shown() > 0 };
    btn().click(); // back on

    // A hold opens the menu and does not toggle.
    const before = btn().getAttribute("aria-pressed");
    down(btn(), 130, 130); await wait(620);
    const openedByHold = shown() === 1;
    const entries = items();
    const keys = real().map((i) => i.key);
    up(btn()); btn().click();
    const afterHold = { pressed: btn().getAttribute("aria-pressed"), same: btn().getAttribute("aria-pressed") === before };

    // Anchored to the button, and on screen. The host clamps it from there, so
    // this is about handing it a sensible place rather than about where it ends
    // up drawn.
    const at = last() ? last().position : null;
    const bb = btn().getBoundingClientRect();
    const onScreen = !!at && at.x >= 0 && at.y >= 0 && at.x <= innerWidth && at.y <= innerHeight;
    const onButton = !!at && Math.abs(at.x - (bb.left + bb.width / 2)) <= 1;

    // A drag is not a hold.
    const beforeDrag = shown();
    down(btn(), 130, 130); move(btn(), 190, 175); await wait(620);
    const afterDrag = shown() > beforeDrag;
    up(btn());

    // Resizing rebuilds the widget, and a rebuild that starts where a fresh one
    // starts throws away wherever the button was dragged to. Driven through the
    // panel, which is the path a person takes and exercises the live preview at
    // the same time.
    host.style.left = "300px";
    host.style.top = "260px";
    // Let the settle read record it. Moving the element is not something the
    // extension can see, and no longer something it goes looking for: reading
    // the position back on every rebuild is what let a size change feed its own
    // error in again. A drag says where the button ended up, and this is that.
    up(btn());
    await wait(500);
    const askedBefore = asked.length;
    acts["auto-retry-settings"].cb();
    await wait(30);
    for (const h of document.querySelectorAll('[role="button"][aria-expanded="false"]')) h.click();
      // Sections travel open now, so their contents have no height for the
      // length of that. Waited out here rather than in every check below.
      await new Promise((r) => setTimeout(r, 260));
    await wait(30);
    const sizeBox = document.querySelector('[data-ar-row="floatingToggleSize"] input');
    sizeBox.value = "72";
    // input, not change: a preview is meant to move while it is being typed.
    sizeBox.dispatchEvent(new Event("input", { bubbles: true }));
    await wait(30);
    const resize = {
      rebuilt: asked.length > askedBefore,
      at: asked.length ? asked[asked.length - 1].initialPosition : null,
      size: asked.length ? asked[asked.length - 1].width : null,
      noCircle: !document.querySelector('[data-ar-row="floatingToggleSize"] div[aria-hidden="true"]'),
    };

    // Dismissing it does nothing at all.
    window.__pick = null;
    let held = btn();
    down(held, 130, 130); await wait(620); up(held);
    await wait(30);
    const afterDismiss = { button: !!host.querySelector("button") };

    // Answering "hide" takes the button away. The reference is kept because the
    // answer arrives before the finger lifts, and by then there is no button to
    // look up any more.
    window.__pick = "hide";
    held = btn();
    down(held, 130, 130); await wait(620); up(held);
    await wait(50);
    const gone = { button: !host.querySelector("button") };

    // And teardown after all that leaves nothing of ours behind.
    down(document.body, 1, 1);
    teardown();
    const left = { ours: document.querySelectorAll('[role="menu"],[role="menuitem"]').length };
    return { wasOn, afterTap, openedByHold, entries, keys, afterHold, onScreen, onButton,
             afterDrag, resize, afterDismiss, gone, left };
  });
  await page.close();
  check("a quick tap still toggles", out.afterTap.pressed !== out.wasOn, out.afterTap);
  check("and opens no menu", !out.afterTap.menu);
  check("a hold opens the menu", out.openedByHold);
  // Two, because nothing else is switched on here. The panel button and the
  // two word swap buttons join them when their settings are on, which the
  // "where the ways into the extension live" checks cover. This is the floor.
  check("with its two entries, nothing else being on", out.entries.length === 2, out.entries);
  check("and neither of them offers to move it, since dragging does that",
    !out.entries.some((t) => /corner|move/i.test(t)), out.entries);
  // The thing someone holding this button is most likely to be after, so it is
  // the one their thumb lands on first.
  check("settings is the first of them", /settings/i.test(out.entries[0]), out.entries);
  check("a hold does not also toggle", out.afterHold.same, out.afterHold);
  // The keys are what the answer comes back as, so they are the contract, not
  // the labels.
  check("its entries carry the keys the answer is read from",
    out.keys.join(",") === "settings,hide", out.keys);
  // Hide is last whatever else is in the menu, because it is the only entry
  // that closes the menu for good.
  check("and hide is the last of them", out.keys[out.keys.length - 1] === "hide", out.keys);
  check("it is anchored on screen", out.onScreen, out);
  check("and centred on the button", out.onButton, out);
  check("dragging is not a hold", !out.afterDrag);
  check("resizing rebuilds it too", out.resize.rebuilt, out.resize);
  check("at the new size", out.resize.size === 72, out.resize);
  // The whole point: the rebuild is handed where the button already was, not
  // the corner a fresh one starts in. Worked out from the middle, because the
  // position a host is given is a top-left: carrying that across unchanged
  // pins the corner and lets the button grow away from it, down and to the
  // right, which on an edge is a jump to somewhere it was never put. The old
  // button sits at 300,260 at 44 across, so its middle is 322,282, and a 72
  // across button around that middle starts at 286,246.
  check("and keeps the middle of the button where it was, rather than its corner",
    !!out.resize.at && out.resize.at.x === 286 && out.resize.at.y === 246, out.resize);
  // The button on the chat is the preview. A second one beside the box would
  // reserve space as wide as the largest size the setting allows, in every
  // panel, whether the button is switched on or not.
  check("no preview circle is drawn beside the box", out.resize.noCircle, out.resize);
  check("dismissing it changes nothing", out.afterDismiss.button, out.afterDismiss);
  check("answering hide removes the button", out.gone.button, out.gone);
  check("teardown leaves no menu of ours anywhere", out.left.ours === 0, out.left);
  check("no console errors", errors.length === 0, errors);
}

// ---- the countdown actually counts ----
// Written once, "in 47.3s" would say that for the next forty-seven seconds, so
// the one number anyone watches is the one that never moves. A wait can be a
// minute on the current defaults, and a frozen number reads as a frozen
// extension.
console.log("\nlive countdown");
{
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await stage(page, '<div id=modal></div><button data-testid="regenerate">Regenerate</button>');
  await page.addStyleTag({ content: THEME });
  await page.addScriptTag({ content: SOURCE, type: "module" });
  await page.waitForFunction(() => !!window.__setup);
  const out = await page.evaluate(async () => {
    const handlers = {};
    const teardown = window.__setup(
      { events: { on: (n, fn) => { handlers[n] = fn; return () => {}; } },
        ui: { showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
              registerInputBarAction: () => ({ onClick: () => () => {}, destroy: () => {} }) } },
      // Long enough that the countdown has somewhere to go, short enough that
      // this check is not itself a wait.
      { toast: true, liveLog: true, retryDelayMs: 6000, backoffFactor: 1, maxDelayMs: 6000,
        jitter: false, maxRetries: 3, stuckTimeoutMs: 0, idleTimeoutMs: 0, pauseWhenFailing: false },
    );
    const words = () => {
      const t = document.getElementById("__lvRetryToast");
      const s = t && t.querySelector("span");
      return s ? s.textContent : "";
    };
    const status = () => {
      const el = document.getElementById("__lvRetryStatus");
      return el ? (el.textContent || "").trim() : "(no status line)";
    };
    handlers.GENERATION_STARTED({ chatId: "c", generationId: "g" });
    handlers.GENERATION_ENDED({ chatId: "c", content: "" });
    // The retry is not scheduled the instant the reply ends, so this waits for
    // the pop-up to appear rather than assuming it has.
    for (let i = 0; i < 60 && !words(); i++)
      await new Promise((r) => setTimeout(r, 50));
    // What it says the moment it opens, before any tick has had a chance to
    // fix it up. The countdown is assembled while the timer that fires the
    // retry is still being created, so reading the wrong one of those left the
    // pop-up opening on a bare "Retrying" and only growing its countdown a
    // quarter of a second later. Polling until the countdown appeared hid
    // exactly that, so this does not poll for it.
    const opened = words();
    const first = opened;
    const statusFirst = status();
    // The Cancel button has to be the same element throughout. Rebuilding the
    // box on every tick would swallow a press that landed mid-rebuild.
    const cancelFirst = document.querySelector("#__lvRetryToast button");
    await new Promise((r) => setTimeout(r, 1400));
    const later = words();
    const statusLater = status();
    const cancelLater = document.querySelector("#__lvRetryToast button");
    const num = (s) => {
      const m = /in (?:(\d+)h )?(?:(\d+)m )?(\d+)s/.exec(s || "");
      return m
        ? Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3])
        : null;
    };
    // Cancelling has to stop the clock as well as the retry.
    cancelLater && cancelLater.click();
    // Read at once, not after a wait. Cancel is the press people watch the line
    // for, and a quarter second of it still counting down to a retry that is no
    // longer coming is the line lying.
    const afterCancel = status();
    teardown();
    return {
      first, opened, later, statusFirst, statusLater, afterCancel,
      firstN: num(first), laterN: num(later),
      statusFirstN: num(statusFirst), statusLaterN: num(statusLater),
      sameCancel: cancelFirst === cancelLater && !!cancelFirst,
      // No tenths: a number twitching four times a second is noise, not news.
      noTenths: !/\d\.\ds/.test(first || "") && !/\d\.\ds/.test(later || ""),
    };
  });
  await page.close();
  check("the pop-up says how long is left the moment it opens",
    /Retrying in/.test(out.opened || "") && out.firstN !== null, out);
  check("and that number goes down on its own", out.laterN !== null && out.laterN < out.firstN, out);
  check("it counts in whole seconds", out.noTenths, out);
  check("it says why it is retrying", /empty/i.test(out.first || ""), out);
  check("and which try this is", /try 1 of 3/.test(out.first || ""), out);
  check("the Cancel button survives the ticking", out.sameCancel, out);
  check("the panel carries the same countdown", out.statusFirstN !== null, out);
  check("and it moves too", out.statusLaterN !== null && out.statusLaterN < out.statusFirstN, out);
  check("cancelling stops it counting", !/Retrying in/.test(out.afterCancel || ""), out);
  check("and the panel says it has nothing to do", /nothing to do/i.test(out.afterCancel || ""), out);
  check("no console errors", errors.length === 0, errors);
}

// ---- the panel is where you left it ----
// Updating the extension reloads it, and coming back in the default corner at
// the default size every time undoes whatever the reader set up. Dragging it
// clear of the chat and sizing it is work, and redoing that on every update is
// what makes a panel not worth opening.
console.log("\nlayout is remembered");
{
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await stage(page, "<div id=modal></div>");
  await page.addStyleTag({ content: THEME });
  await page.addScriptTag({ content: SOURCE, type: "module" });
  await page.waitForFunction(() => !!window.__setup);
  const out = await page.evaluate(async () => {
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const host = {
      events: { on: () => () => {} },
      ui: { showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
            registerInputBarAction: () => ({ onClick: () => () => {}, destroy: () => {} }) },
    };
    localStorage.removeItem("lv-auto-retry:layout:v1");
    let teardown = window.__setup(host, { liveLog: true, toast: false });
    const panel = () => document.getElementById("__lvRetryLog");
    const box = () => {
      const r = panel().getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    };
    const opened = box();
    // Drag the header, the way a person moves it.
    const head = panel().firstElementChild;
    const send = (type, x, y) =>
      head.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerId: 1 }));
    send("pointerdown", opened.x + 40, opened.y + 8);
    await frame();
    send("pointermove", opened.x + 40 - 120, opened.y + 8 - 90);
    await frame();
    send("pointerup", opened.x + 40 - 120, opened.y + 8 - 90);
    await frame();
    const dragged = box();
    // Resize by the corner grip.
    const grip = panel().lastElementChild;
    const g = (type, x, y) =>
      grip.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerId: 2 }));
    g("pointerdown", dragged.x + dragged.w, dragged.y + dragged.h);
    await frame();
    g("pointermove", dragged.x + dragged.w + 60, dragged.y + dragged.h + 40);
    await frame();
    g("pointerup", dragged.x + dragged.w + 60, dragged.y + dragged.h + 40);
    await frame();
    const resized = box();
    // The Stats tab, so the tab it reopens on is checked too.
    const stats = [...panel().querySelectorAll('[role="tab"]')]
      .find((b) => (b.textContent || "").trim() === "Stats");
    stats && stats.click();
    await frame();
    const saved = JSON.parse(localStorage.getItem("lv-auto-retry:layout:v1") || "{}");

    // Torn down and set up again, which is what an update looks like.
    teardown();
    await frame();
    teardown = window.__setup(host, { liveTab: undefined, liveLog: true, toast: false });
    await frame();
    const reopened = box();
    const onTab = (() => {
      const b = [...panel().querySelectorAll('[role="tab"]')]
        .find((x) => x.getAttribute("aria-selected") === "true");
      return b ? (b.textContent || "").trim() : null;
    })();
    teardown();

    // A layout saved on a big window must not strand the panel off a small one.
    localStorage.setItem("lv-auto-retry:layout:v1", JSON.stringify({
      panel: { x: 99999, y: 99999, w: 99999, h: 99999 },
    }));
    teardown = window.__setup(host, { liveLog: true, toast: false });
    await frame();
    const clamped = box();
    teardown();
    // Nonsense in the store must not put it somewhere with no way back.
    localStorage.setItem("lv-auto-retry:layout:v1", '{"panel":{"x":"left","y":null,"w":[],"h":{}}}');
    teardown = window.__setup(host, { liveLog: true, toast: false });
    await frame();
    const junk = box();
    teardown();
    localStorage.removeItem("lv-auto-retry:layout:v1");
    return { opened, dragged, resized, reopened, clamped, junk, saved, onTab };
  });
  await page.close();
  const near = (a, b, slack = 4) => Math.abs(a - b) <= slack;
  check("dragging moves it", out.dragged.x < out.opened.x && out.dragged.y < out.opened.y, out);
  check("the grip resizes it", out.resized.w > out.dragged.w && out.resized.h > out.dragged.h, out);
  check("where it ended up is written down", !!out.saved.panel, out.saved);
  check("and which tab was open with it", out.saved.tab === "stats", out.saved);
  check("it comes back in the same place",
    near(out.reopened.x, out.resized.x) && near(out.reopened.y, out.resized.y), out);
  check("at the same size",
    near(out.reopened.w, out.resized.w) && near(out.reopened.h, out.resized.h), out);
  check("and on the same tab", out.onTab === "Stats", out);
  check("a layout too big for the screen is pulled back onto it",
    out.clamped.x >= 0 && out.clamped.y >= 0 &&
    out.clamped.x + out.clamped.w <= 2000 && out.clamped.h <= 2000, out);
  check("and its header stays reachable", out.clamped.y >= 0 && out.clamped.y < 400, out);
  check("nonsense in the store is ignored rather than applied",
    out.junk.w >= 200 && out.junk.h >= 120 && out.junk.x >= 0 && out.junk.y >= 0, out);
  check("no console errors", errors.length === 0, errors);
}

// ---- the status line after a stop, and what the dot is doing ----
// Pressing Stop left the line saying the model was thinking, forever. The flag
// behind it was only ever cleared when a generation ended, and a stop does not
// always end one.
console.log("\nstatus after a stop");
{
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await stage(page, '<div id=modal></div><button data-testid="regenerate">Regenerate</button><button data-testid="stop">Stop</button>');
  await page.addStyleTag({ content: THEME });
  await page.addScriptTag({ content: SOURCE, type: "module" });
  await page.waitForFunction(() => !!window.__setup);
  const out = await page.evaluate(async () => {
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const handlers = {};
    const teardown = window.__setup(
      { events: { on: (n, fn) => { handlers[n] = fn; return () => {}; } },
        ui: { showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
              registerInputBarAction: () => ({ onClick: () => () => {}, destroy: () => {} }) } },
      { liveLog: true, toast: false, stuckTimeoutMs: 0, idleTimeoutMs: 0, pauseWhenFailing: false },
    );
    const line = () => (document.getElementById("__lvRetryStatus").textContent || "").trim();
    const dot = () => document.querySelector("#__lvRetryStatus [data-ar-state]");
    const state = () => { const d = dot(); return d ? d.getAttribute("data-ar-state") : null; };
    const anim = () => { const d = dot(); return d ? getComputedStyle(d).animationName : null; };
    const glow = () => { const d = dot(); return d ? getComputedStyle(d).boxShadow : null; };

    await frame();
    const idleLine = line(), idleState = state(), idleAnim = anim(), idleGlow = glow();

    // A reply starts and the model starts thinking.
    handlers.GENERATION_STARTED({ chatId: "c", generationId: "g" });
    handlers.STREAM_TOKEN_RECEIVED && handlers.STREAM_TOKEN_RECEIVED({ chatId: "c", type: "reasoning", text: "hm" });
    await frame();
    const thinkingLine = line(), busyState = state(), busyAnim = anim();

    // The user presses Stop. The host's own event is what normally arrives.
    handlers.GENERATION_STOPPED && handlers.GENERATION_STOPPED({ chatId: "c", generationId: "g" });
    await frame();
    const afterStop = line(), afterStopState = state();

    // And again with no host event at all, only the click on the Stop button,
    // which is the case the backup exists for.
    handlers.GENERATION_STARTED({ chatId: "c2", generationId: "g2" });
    handlers.STREAM_TOKEN_RECEIVED && handlers.STREAM_TOKEN_RECEIVED({ chatId: "c2", type: "reasoning", text: "hm" });
    await frame();
    const thinkingAgain = line();
    document.querySelector('[data-testid="stop"]').click();
    await frame();
    const afterClick = line(), afterClickState = state();

    // Switched off entirely: dim, no glow, no pulse.
    handlers.GENERATION_STARTED({ chatId: "c3", generationId: "g3" });
    await frame();
    const offBefore = state();
    teardown();
    const t2 = window.__setup(
      { events: { on: (n, fn) => { handlers[n] = fn; return () => {}; } },
        ui: { showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
              registerInputBarAction: () => ({ onClick: () => () => {}, destroy: () => {} }) } },
      { liveLog: true, toast: false, enabled: false },
    );
    await frame();
    const offState = state(), offAnim = anim(), offGlow = glow();
    t2();
    const styleGone = !document.getElementById("__lvRetryStatusStyle");
    return { idleLine, idleState, idleAnim, idleGlow, thinkingLine, busyState, busyAnim,
             afterStop, afterStopState, thinkingAgain, afterClick, afterClickState,
             offBefore, offState, offAnim, offGlow, styleGone };
  });
  await page.close();
  check("with nothing happening it says so", /nothing to do/i.test(out.idleLine), out);
  check("a reply in flight is reported", /thinking|arriving|waiting/i.test(out.thinkingLine), out);
  check("the host's stop event clears it", !/thinking/i.test(out.afterStop), out);
  check("and it goes back to having nothing to do", /nothing to do/i.test(out.afterStop), out);
  check("a stop with no host event clears it too", !/thinking/i.test(out.afterClick), out);
  check("and that one settles as well", /nothing to do/i.test(out.afterClick), out.afterClick);
  // The dot: dim when off, the theme's own colour when on, breathing a ring
  // outward only while working. The same dot as Auto Refine's, which is the
  // point of it: somebody running both reads one panel and then the other.
  check("the dot is lit but still with nothing to do",
    out.idleState === "idle" && out.idleAnim === "none", out);
  check("and breathes while something is happening",
    out.busyState === "busy" && out.busyAnim === "lvRetryBreathe", out);
  check("it stops pulsing once the work does", out.afterStopState === "idle", out);
  check("switched off it is dim, flat and unlit",
    out.offState === "off" && out.offAnim === "none" && out.offGlow === "none", out);
  check("and its stylesheet goes on teardown", out.styleGone, out);
  check("no console errors", errors.length === 0, errors);
}

// ---- Copy takes the whole tab ----
// Both text builders are written out separately from the views they describe,
// so they drift: the Stats copy was missing the note counts, the retry rate,
// the paused notice and the "nothing has needed a retry yet" line, and the
// Prompt copy was missing the summary, where the notes landed, and the marking
// on the messages that carried them. Rather than trust the two to stay in step,
// this reads what is on screen and asks whether the clipboard has it.
console.log("\ncopy takes everything");
{
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await stage(page, "<div id=modal></div>");
  await page.addStyleTag({ content: THEME });
  await page.addScriptTag({ content: SOURCE, type: "module" });
  await page.waitForFunction(() => !!window.__setup);
  const out = await page.evaluate(async () => {
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    let clip = "";
    // The clipboard is not available to a headless page, so the write is caught
    // here instead. What matters is the text handed over, not who took it.
    try {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async (t) => { clip = t; } },
      });
    } catch (_) {}
    document.execCommand = () => { return true; };

    const handlers = {};
    const backend = [];
    // As many listeners as are registered, like the host. Keeping only the last
    // one meant a per-request handler replaced the main one and a prompt sent
    // from here reached nobody.
    let msgCbs = [];
    window.__fromBackend = (m) => { for (const cb of msgCbs.slice()) { try { cb(m); } catch (_) {} } };
    const teardown = window.__setup(
      { events: { on: (n, fn) => { handlers[n] = fn; return () => {}; } },
        sendToBackend: (m) => backend.push(m),
        onBackendMessage: (fn) => { msgCbs.push(fn); return () => { msgCbs = msgCbs.filter((x) => x !== fn); }; },
        ui: { showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
              registerInputBarAction: () => ({ onClick: () => () => {}, destroy: () => {} }) } },
      { liveLog: true, toast: false, refusalNote: true, pauseWhenFailing: false,
        retryDelayMs: 10, backoffFactor: 1, maxDelayMs: 10, jitter: false, maxRetries: 3,
        stuckTimeoutMs: 0, idleTimeoutMs: 0 },
    );
    const panel = () => document.getElementById("__lvRetryLog");
    const body = () => document.getElementById("__lvRetryLogBody");
    const tab = (name) =>
      [...document.querySelectorAll('#__lvRetryLog [role="tab"], #__lvRetryLog button')]
        .find((b) => (b.textContent || "").trim() === name);
    // Matched on either label: pressing it relabels it to "Copied" for a
    // moment, so a second search for "Copy" found nothing.
    const copy = () =>
      [...document.querySelectorAll("#__lvRetryLog button")]
        .find((b) => /^Cop(y|ied)$/.test((b.textContent || "").trim()));

    // Give it something to report: a failure, a retry, a finish.
    handlers.GENERATION_STARTED({ chatId: "c", generationId: "g1" });
    handlers.GENERATION_ENDED({ chatId: "c", content: "" });
    await new Promise((r) => setTimeout(r, 120));
    handlers.GENERATION_STARTED({ chatId: "c", generationId: "g2" });
    handlers.GENERATION_ENDED({ chatId: "c", content: "A finished reply." });
    await frame();

    // Every line the body is showing, so the copy can be held against it.
    const shownLines = () =>
      (body().innerText || body().textContent || "")
        .split("\n").map((x) => x.trim()).filter((x) => x.length > 2);

    const grab = async (name) => {
      if (!tab(name))
        return { shown: ["(tab missing)"], clip: "", missing: ["(tab missing)"],
                 err: "no " + name + " tab; panel=" + !!panel() +
                      " buttons=" + [...document.querySelectorAll("#__lvRetryLog button")]
                        .map((b) => (b.textContent || "").trim()).join(",") };
      tab(name).click();
      await frame();
      const shown = shownLines();
      clip = "";
      if (!copy())
        return { shown: shown, clip: "", missing: shown,
                 err: "no Copy button; buttons=" +
                      [...document.querySelectorAll("#__lvRetryLog button")]
                        .map((b) => JSON.stringify((b.textContent || "").trim())).join(",") };
      copy().click();
      await new Promise((r) => setTimeout(r, 60));
      // Compared without case, because a heading is upper-cased by a style rule
      // rather than in the text, and that is presentation, not content.
      const flat = clip.toLowerCase();
      return { shown, clip, missing: shown.filter((l) => flat.indexOf(l.toLowerCase()) < 0) };
    };

    const log = await grab("Log");
    const stats = await grab("Stats");

    // A prompt, so the Prompt tab has something to show. It arrives the way the
    // backend sends one.
    tab("Prompt").click();
    await frame();
    if (window.__fromBackend)
      window.__fromBackend({
        type: "prompt_snapshot",
        total: 3,
        notes: 1,
        dropped: 0,
        messages: [
          { role: "system", history: true, chars: 12, content: "You are here." },
          { role: "user", history: false, chars: 9, note: true, content: "A note." },
          { role: "user", history: true, chars: 6, content: "Hello." },
        ],
      });
    await frame();
    const prompt = await grab("Prompt");
    teardown();
    return { log, stats, prompt };
  });
  await page.close();
  const report = (r) => ({ err: r.err, missing: r.missing, shown: r.shown.length, clip: (r.clip || "").slice(0, 300) });
  check("the Log tab had something to show", out.log.shown.length > 0, report(out.log));
  check("and Copy took all of it", out.log.missing.length === 0, report(out.log));
  check("the Stats tab had something to show", out.stats.shown.length > 3, report(out.stats));
  check("and Copy took all of it", out.stats.missing.length === 0, report(out.stats));
  check("the Prompt tab had something to show", out.prompt.shown.length > 3, report(out.prompt));
  // The Prompt view draws the same facts as compact chrome, "chat · 12" where
  // the copy writes "(chat) 12 chars", so this asks for the facts rather than
  // for the same words. Every message's text has to be there, whole.
  const p = out.prompt.clip || "";
  check("Copy carries the prompt summary", /3 messages,.*characters,.*tokens/i.test(p), report(out.prompt));
  check("and says where the notes landed", /1 Auto Retry note went with this one, at position 2 of 3/.test(p), report(out.prompt));
  check("and marks the message that carried one", /\(Auto Retry note\)/.test(p), report(out.prompt));
  check("and every message's role and origin", /1 system \(chat\)/.test(p) && /3 user \(chat\)/.test(p), report(out.prompt));
  check("and every message's text",
    ["You are here.", "A note.", "Hello."].every((t) => p.indexOf(t) >= 0), report(out.prompt));
  // The one the old Stats builder left out entirely.
  check("Copy carries the retry breakdown",
    /What it retried for/i.test(out.stats.clip) && /needed a retry/i.test(out.stats.clip), report(out.stats));
  check("no console errors", errors.length === 0, errors);
}

// ---- a dropdown is not marked for having been clicked ----
// The focus tint told you which field was active, which is worth saying for a
// box you are about to type in and worth nothing for a dropdown: clicking one
// opens its menu with the choice already in front of you, and the tint then sat
// there after the choosing was done until something else was clicked.
//
// Driven with a real pointer and real keys rather than dispatched events,
// because :focus-visible is decided by how the focus arrived and a synthetic
// click does not carry that.
console.log("\ndropdown focus");
{
  const SELECT = '[data-ar-row="refusalNotePlacement"] select';
  const TEXT = '[data-ar-row="regenerateSelector"] input[type=text]';
  const { out, errors } = await inPanel(
    browser,
    { settings: { refusalNote: true } },
    async (page) => {
      await page.evaluate(async () => {
        for (const h of document.querySelectorAll('[role="button"][aria-expanded="false"]')) h.click();
        // Sections travel open now, so their contents have no height for the
        // length of that. Waited out here rather than in every check below.
        await new Promise((r) => setTimeout(r, 260));
      });
      // The border eases over 150ms, so each reading waits it out. Measuring
      // straight after a click caught it partway and read a colour that was
      // neither the one it left nor the one it was going to.
      const border = async (sel) => {
        await page.waitForTimeout(320);
        return page.evaluate((x) => {
          const el = document.querySelector(x);
          return el ? getComputedStyle(el).borderTopColor : null;
        }, sel);
      };

      const selectRest = await border(SELECT);
      // A real pointer, not a dispatched event: how the focus arrived is the
      // whole question, and a synthetic click does not carry it.
      await page.click(SELECT);
      await page.keyboard.press("Escape");
      const selectClicked = await border(SELECT);
      const focused = await page.evaluate(
        (x) => document.activeElement === document.querySelector(x), SELECT);

      // Reached with the keyboard instead, which is when the mark earns itself.
      // Tabbed to rather than focused by script, so the focus arrives the way a
      // person's would.
      // Focused without a pointer, which is what tabbing to it amounts to. Tab
      // itself does not reach this row: the panel scrolls and the row sits a
      // long way down it, so pressing Tab sixty times still had not arrived.
      await page.evaluate((x) => document.querySelector(x).blur(), SELECT);
      await page.focus(SELECT);
      await page.waitForTimeout(320);
      const afterTab = await page.evaluate((x) => {
        const el = document.querySelector(x);
        return { onIt: document.activeElement === el, border: getComputedStyle(el).borderTopColor };
      }, SELECT);

      // A text box clicked is still marked, which is where it was helping.
      await page.evaluate((x) => document.querySelector(x).blur(), TEXT);
      const textRest = await border(TEXT);
      await page.click(TEXT);
      const textClicked = await border(TEXT);
      // Resolved on the page rather than written in here, so the check follows
      // the theme instead of a colour copied out of the source.
      const [selectFocusColour, selectHoverColour] = await page.evaluate(() => {
        const of = (v) => {
          const probe = document.createElement("div");
          probe.style.color = v;
          document.body.appendChild(probe);
          const got = getComputedStyle(probe).color;
          probe.remove();
          return got;
        };
        return [
          of("var(--lumiverse-primary,rgba(147,112,219,.9))"),
          of("var(--lumiverse-border-hover,rgba(147,112,219,.25))"),
        ];
      });
      return { selectRest, selectClicked, focused, afterTab, textRest, textClicked,
               selectFocusColour, selectHoverColour };
    },
  );
  check("the dropdown is there to test", out.selectRest !== null, out);
  check("clicking it still focuses it", out.focused === true, out);
  // The point is that clicking a dropdown does not mark it as focused, not that
  // its border never moves at all. A field lifts its border under the pointer
  // now, which a click necessarily is, so what has to hold is that the lift is
  // the hover colour and not the focus one.
  check("but does not mark it as focused", out.selectClicked !== out.selectFocusColour, out);
  check("and lifts only as far as the hover colour", out.selectClicked === out.selectHoverColour, out);
  check("reaching that same dropdown without the pointer does mark it",
    out.afterTab.onIt === true && out.afterTab.border !== out.selectRest, out);
  check("and a text box clicked is still marked", out.textClicked !== out.textRest, out);
  check("no console errors", errors.length === 0, errors);
}

// ---- the retry pop-up goes away when the retry does ----
// It is sticky, so nothing removes it on its own, and it carries the Cancel
// button. Two ways it got stuck: it stopped counting only once the chat had
// nothing to say at all, and a retry that fired successfully has plenty to say,
// so the box stayed up narrating the reply that followed. And standing down
// hid it only when something was still pending, which after a successful retry
// is nothing, so pressing Cancel left it exactly where it was.
console.log("\npop-up goes away");
{
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await stage(page, '<div id=modal></div><button data-testid="regenerate">Regenerate</button>');
  await page.addStyleTag({ content: THEME });
  await page.addScriptTag({ content: SOURCE, type: "module" });
  await page.waitForFunction(() => !!window.__setup);
  const out = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const handlers = {};
    const teardown = window.__setup(
      { events: { on: (n, fn) => { handlers[n] = fn; return () => {}; } },
        ui: { showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
              registerInputBarAction: () => ({ onClick: () => () => {}, destroy: () => {} }) } },
      { toast: true, retryDelayMs: 400, backoffFactor: 1, maxDelayMs: 400, jitter: false,
        maxRetries: 3, stuckTimeoutMs: 0, idleTimeoutMs: 0, pauseWhenFailing: false },
    );
    const box = () => document.getElementById("__lvRetryToast");
    const up = () => { const t = box(); return !!t && t.style.opacity === "1"; };
    const says = () => { const t = box(); const sp = t && t.querySelector("span"); return sp ? sp.textContent : ""; };
    const cancel = () => [...(box() ? box().querySelectorAll("button") : [])]
      .find((b) => (b.textContent || "").trim() === "Cancel");

    // A failure, so a retry is scheduled and the pop-up appears.
    handlers.GENERATION_STARTED({ chatId: "c", generationId: "g1" });
    handlers.GENERATION_ENDED({ chatId: "c", content: "" });
    for (let i = 0; i < 40 && !/Retrying in/.test(says()); i++) await wait(50);
    const whileWaiting = { up: up(), text: says() };

    // The retry fires and a reply starts. This is where the box can stay up and
    // start describing the new generation instead of leaving.
    await wait(700);
    handlers.GENERATION_STARTED({ chatId: "c", generationId: "g2" });
    await wait(400);
    const afterRetryStarted = { up: up(), text: says() };

    // A second round, cancelled by hand from the pop-up itself.
    handlers.GENERATION_ENDED({ chatId: "c", content: "" });
    for (let i = 0; i < 40 && !/Retrying in/.test(says()); i++) await wait(50);
    const secondUp = up();
    const c = cancel();
    const hadCancel = !!c;
    if (c) c.click();
    // Read with nothing awaited. The button takes the box away itself before it
    // runs whatever it was given to do, so the countdown cannot survive the
    // click even for a frame, whatever that action does or fails to do.
    const instantly = { countdownGone: !/Retrying in/.test(says()) };
    await wait(120);
    // Cancel replaces the countdown with a short confirmation, which is not
    // sticky and clears itself. Both halves matter: the countdown has to be
    // gone at once, and what replaces it must not be another thing that stays.
    const afterCancel = { up: up(), text: says(), cancelGone: !cancel() };
    await wait(3600);
    const laterStillUp = up();

    // And the case from the report: cancel again with nothing pending, which is
    // what pressing Stop repeatedly amounts to.
    handlers.GENERATION_STARTED({ chatId: "c", generationId: "g3" });
    handlers.GENERATION_ENDED({ chatId: "c", content: "" });
    for (let i = 0; i < 40 && !/Retrying in/.test(says()); i++) await wait(50);
    handlers.GENERATION_STOPPED && handlers.GENERATION_STOPPED({ chatId: "c", generationId: "g3" });
    await wait(120);
    handlers.GENERATION_STOPPED && handlers.GENERATION_STOPPED({ chatId: "c", generationId: "g3" });
    await wait(120);
    const afterTwoStops = { up: up(), text: says() };
    teardown();
    return { whileWaiting, afterRetryStarted, secondUp, hadCancel, instantly, afterCancel, laterStillUp, afterTwoStops };
  });
  await page.close();
  check("the pop-up counts the wait down", out.whileWaiting.up && /Retrying in/.test(out.whileWaiting.text), out);
  check("and goes once the retry has fired", out.afterRetryStarted.up === false, out);
  check("it does not stay to describe the reply that followed",
    !/Waiting for the reply|Model is thinking|Reply arriving/.test(out.afterRetryStarted.text), out);
  check("it comes back for the next wait", out.secondUp === true, out);
  check("its Cancel button is there", out.hadCancel === true, out);
  check("Cancel takes the box away before it does anything else",
    out.instantly.countdownGone === true, out);
  check("pressing Cancel takes the countdown away",
    !/Retrying in/.test(out.afterCancel.text) && out.afterCancel.cancelGone === true, out);
  check("and says so briefly instead", /stopped/i.test(out.afterCancel.text), out);
  check("and that confirmation clears itself", out.laterStillUp === false, out);
  check("stopping twice does not leave one behind", out.afterTwoStops.up === false, out);
  check("no console errors", errors.length === 0, errors);
}

// ---- the reply it checks when the end event carries no text ----
// Not every build puts the finished text on the end event. When it is missing,
// what actually streamed stands in for it, so the checks still have something
// real to read. That copy is held only while the reply is in flight: it is
// dropped the moment the reply ends, rather than surviving until the next one
// starts, so a stray end event cannot be judged on the reply before it.
console.log("\nwhat streamed stands in for the reply");
{
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await stage(page, '<div id=modal></div><button data-testid="regenerate">Regenerate</button>');
  await page.addStyleTag({ content: THEME });
  await page.addScriptTag({ content: SOURCE, type: "module" });
  await page.waitForFunction(() => !!window.__setup);
  const out = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const handlers = {};
    let clicks = 0;
    document.querySelector('[data-testid="regenerate"]')
      .addEventListener("click", () => { clicks++; });
    const teardown = window.__setup(
      { events: { on: (n, fn) => { handlers[n] = fn; return () => {}; } },
        ui: { showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
              registerInputBarAction: () => ({ onClick: () => () => {}, destroy: () => {} }) } },
      { toast: false, retryDelayMs: 60, backoffFactor: 1, maxDelayMs: 60, jitter: false,
        maxRetries: 3, stuckTimeoutMs: 0, idleTimeoutMs: 0, pauseWhenFailing: false },
    );
    // Stream a reply that stops mid-sentence, and end it with no content field.
    const stream = async (chatId, id, text) => {
      handlers.GENERATION_STARTED({ chatId, generationId: id });
      handlers.STREAM_TOKEN_RECEIVED({ chatId, generationId: id, token: text });
      handlers.GENERATION_ENDED({ chatId, generationId: id, messageId: "m" + id });
      await wait(260);
    };
    const from = clicks;
    await stream("a", "1", "She reached for the door and then");
    const cutOff = clicks - from;

    // The same again with a finished one, which should be left alone.
    const before2 = clicks;
    await stream("b", "2", "She reached for the door and stepped through.");
    const finished = clicks - before2;

    // And an end event with nothing before it, on the chat that streamed the
    // cut-off reply. Its text is long gone, so there is nothing to judge and
    // nothing should fire.
    const before3 = clicks;
    handlers.GENERATION_ENDED({ chatId: "a", generationId: "3", messageId: "m3" });
    await wait(260);
    const stray = clicks - before3;
    teardown();
    return { cutOff, finished, stray };
  });
  await page.close();
  check("a cut-off reply is caught from what streamed", out.cutOff === 1, out);
  check("a finished one is left alone", out.finished === 0, out);
  check("and a stray end event is not judged on the reply before it", out.stray === 0, out);
  check("no console errors", errors.length === 0, errors);
}

// ---- the panel on a phone ----
// The panel is most useful on a phone, where there is no console to open, and
// that is also where there is least room. The status line is one line, so the
// question is whether the part that matters survives the width.
console.log("\nphone panel");
{
  for (const [name, w, h] of [["phone", 360, 640], ["small phone", 320, 568], ["desktop", 1280, 800]]) {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.setViewportSize({ width: w, height: h });
    await stage(page, "<div id=modal></div><button data-testid=\"regenerate\">Regenerate</button>");
    await page.addStyleTag({ content: THEME });
    await page.addScriptTag({ content: SOURCE, type: "module" });
    await page.waitForFunction(() => !!window.__setup);
    const out = await page.evaluate(async () => {
      const handlers = {};
      const teardown = window.__setup(
        { events: { on: (n, fn) => { handlers[n] = fn; return () => {}; } },
          ui: { showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
                registerInputBarAction: () => ({ onClick: () => () => {}, destroy: () => {} }) } },
        { liveLog: true, toast: false, retryDelayMs: 90000, backoffFactor: 1, maxDelayMs: 90000,
          jitter: false, maxRetries: 5, stuckTimeoutMs: 0, idleTimeoutMs: 0, pauseWhenFailing: false },
      );
      // The longest thing the line ever says.
      handlers.GENERATION_STARTED({ chatId: "c", generationId: "g" });
      handlers.GENERATION_ENDED({ chatId: "c", content: "" });
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 50));
        if (/Retrying in/.test(document.getElementById("__lvRetryStatus").textContent || "")) break;
      }
      const panel = document.getElementById("__lvRetryLog");
      const status = document.getElementById("__lvRetryStatus");
      const words = status.querySelector("span:last-child");
      const pr = panel.getBoundingClientRect();
      const res = {
        text: (words.textContent || "").trim(),
        // Nothing may hang off the side of the screen, and the panel has to fit.
        onScreen: pr.left >= -1 && pr.right <= innerWidth + 1 && pr.bottom <= innerHeight + 1,
        panelW: Math.round(pr.width),
        // How much of the line is readable rather than cut off by the ellipsis.
        shownRatio: words.clientWidth / Math.max(1, words.scrollWidth),
        // The dot must not be squeezed away by the text beside it.
        dotW: Math.round(status.querySelector("span").getBoundingClientRect().width),
        // Tabs and buttons still reachable, not overflowing their row.
        headFits: (() => {
          const head = panel.firstElementChild.getBoundingClientRect();
          return [...panel.firstElementChild.querySelectorAll("button")]
            .every((b) => b.getBoundingClientRect().right <= head.right + 1);
        })(),
        // A finger-sized target for the tabs.
        tabH: Math.round(panel.querySelector('[role="tab"]').getBoundingClientRect().height),
      };
      teardown();
      return res;
    });
    await page.close();
    check(name + ": the panel is fully on screen", out.onScreen, out);
    check(name + ": the status line says what it is waiting for", /Retrying in/.test(out.text), out);
    check(name + ": the header's buttons stay inside it", out.headFits, out);
    check(name + ": the dot keeps its size", out.dotW >= 6, out);
    check(name + ": no console errors", errors.length === 0, errors);
    if (w < 400) check(name + ": most of the line is readable", out.shownRatio > 0.75, out);
  }
}

// ---- the Stats clock ----
// "Watching for" counts up on its own, so it has to move on its own. It was
// rounded to the nearest minute and drawn once, which meant it read "1 minute"
// for the first ninety seconds of every session and then never changed again
// until something else happened to redraw the view.
console.log("\nstats clock");
{
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await stage(page, "<div id=modal></div>");
  await page.addStyleTag({ content: THEME });
  await page.addScriptTag({ content: SOURCE, type: "module" });
  await page.waitForFunction(() => !!window.__setup);
  const out = await page.evaluate(async () => {
    const realSet = window.setInterval;
    const realClear = window.clearInterval;
    const live = new Set();
    window.setInterval = function (...a) { const id = realSet.apply(window, a); live.add(id); return id; };
    window.clearInterval = function (id) { live.delete(id); return realClear.call(window, id); };
    const teardown = window.__setup(
      { events: { on: () => () => {} },
        ui: { showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
              registerInputBarAction: () => ({ onClick: () => () => {}, destroy: () => {} }) } },
      { liveLog: true, toast: false },
    );
    const tab = (name) =>
      [...document.querySelectorAll('#__lvRetryLog [role="tab"], #__lvRetryLog button')]
        .find((b) => (b.textContent || "").trim() === name);
    const body = () => {
      const el = document.getElementById("__lvRetryLogBody");
      return el ? el.textContent || "" : "";
    };
    const watched = () => {
      const m = /Watching for\s*((?:\d+h )?(?:\d+m )?\d+s)/.exec(body());
      return m ? m[1] : null;
    };
    const stats = tab("Stats");
    if (!stats) return { err: "no Stats tab" };
    stats.click();
    await new Promise((r) => setTimeout(r, 100));
    const first = watched();
    const onStats = live.size;
    await new Promise((r) => setTimeout(r, 1300));
    const later = watched();
    // Switching away has to take its clock with it, or every tab visited in a
    // session leaves one running against elements that are gone. All of them
    // share one interval, so a leak does not show up as a second interval; what
    // it would show up as is the count creeping past what was already running.
    // Counted against onStats rather than against one, since the extension owns
    // other timers of its own and this is asking about the view's. Switched back
    // and forth enough times that a per-view interval could not hide.
    let peak = live.size;
    for (let i = 0; i < 5; i++) {
      const log = tab("Log");
      log && log.click();
      await new Promise((r) => setTimeout(r, 60));
      peak = Math.max(peak, live.size);
      const back = tab("Stats");
      back && back.click();
      await new Promise((r) => setTimeout(r, 60));
      peak = Math.max(peak, live.size);
    }
    const onLog = live.size;
    // Back on Log for the teardown, so the count that follows is not the Stats
    // view's alone.
    const done = tab("Log");
    done && done.click();
    await new Promise((r) => setTimeout(r, 60));
    teardown();
    await new Promise((r) => setTimeout(r, 100));
    const afterTeardown = live.size;
    window.setInterval = realSet;
    window.clearInterval = realClear;
    const secs = (s) => {
      const m = /(?:(\d+)h )?(?:(\d+)m )?(\d+)s/.exec(s || "");
      return m ? Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3]) : null;
    };
    return { first, later, onStats, onLog, peak, afterTeardown, firstN: secs(first), laterN: secs(later) };
  });
  await page.close();
  check("Stats says how long it has been watching", out.firstN !== null, out);
  check("in seconds, not rounded to a minute", out.firstN < 60, out);
  check("and the number climbs on its own", out.laterN !== null && out.laterN > out.firstN, out);
  check("something is ticking while Stats is up", out.onStats >= 1, out);
  check("switching tabs never stacks up another clock", out.peak === out.onStats, out);
  check("and nothing is ticking after teardown", out.afterTeardown === 0, out);
  check("no console errors", errors.length === 0, errors);
}

// ---- the clock stops when nothing is watching it ----
// A repaint loop is cheap until it is left running in every tab someone has
// open. It has to start when something needs it and stop by itself.
console.log("\nthe clock stops");
{
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await stage(page, "<div id=modal></div>");
  await page.addStyleTag({ content: THEME });
  await page.addScriptTag({ content: SOURCE, type: "module" });
  await page.waitForFunction(() => !!window.__setup);
  const out = await page.evaluate(async () => {
    // Counts the intervals the extension holds, by watching what it asks for.
    const realSet = window.setInterval;
    const realClear = window.clearInterval;
    const live = new Set();
    window.setInterval = function (...a) { const id = realSet.apply(window, a); live.add(id); return id; };
    window.clearInterval = function (id) { live.delete(id); return realClear.call(window, id); };
    const teardown = window.__setup(
      { events: { on: () => () => {} },
        ui: { showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
              registerInputBarAction: () => ({ onClick: () => () => {}, destroy: () => {} }) } },
      { liveLog: true, toast: false },
    );
    await new Promise((r) => setTimeout(r, 120));
    const whileOpen = live.size;
    const hadPanel = !!document.getElementById("__lvRetryStatus");
    teardown();
    await new Promise((r) => setTimeout(r, 120));
    const afterTeardown = live.size;
    window.setInterval = realSet;
    window.clearInterval = realClear;
    return { whileOpen, afterTeardown, hadPanel };
  });
  await page.close();
  check("the panel is up with its status line", out.hadPanel === true, out);
  check("something is ticking while it is", out.whileOpen >= 1, out);
  check("and nothing is ticking after teardown", out.afterTeardown === 0, out);
  check("no console errors", errors.length === 0, errors);
}

// ---- browser-drawn controls follow the theme ----
// An unchecked checkbox is painted by the browser, which picks its colours from
// the page's colour scheme rather than from the theme. Left unset it assumes
// light, and a white block landed on the dark panel. Same fault as the search
// field's clear button.
console.log("\ncolour scheme");
{
  const read = async (css, want) => {
    const { out, errors } = await inPanel(browser, { css }, async (page) =>
      page.evaluate(() => {
        const panel = document.querySelector("#modal > div");
        const box = document.querySelector('input[type=checkbox]');
        return {
          scheme: panel ? getComputedStyle(panel).colorScheme : "(no panel)",
          boxScheme: box ? getComputedStyle(box).colorScheme : "(no checkbox)",
        };
      }),
    );
    check(`${want} theme is declared ${want}`, out.scheme === want, out);
    check(`${want}: checkboxes inherit it`, out.boxScheme === want, out);
    check(`${want}: no console errors`, errors.length === 0, errors);
  };
  await read("", "dark");
  await read("#modal{background:#ffffff} body{background:#fff}", "light");
}

// ---- a number setting has to say what its number means ----
// Read from the setting's own key rather than guessed from its wording, so a
// multiplier like "how much longer each wait gets" is not mistaken for a
// duration. A bare 1200 on screen means nothing without its unit.
console.log("\nunits");
{
  const { out, errors } = await inPanel(browser, {}, async (page) =>
    page.evaluate(() => {
      const bad = [];
      let durations = 0;
      for (const r of document.querySelectorAll("[data-ar-row]")) {
        const key = r.getAttribute("data-ar-row") || "";
        if (!/Ms$|Minutes$/.test(key)) continue;
        durations++;
        const label = (r.textContent || "").replace(/\s+/g, " ").trim();
        if (!/\(ms\)|\(minutes\)|\(seconds\)/.test(label)) bad.push(key);
      }
      return { bad, durations };
    }),
  );
  check("every duration setting names its unit in the label", out.bad.length === 0, out.bad);
  check("and there were durations to check", out.durations >= 5, out.durations);
  check("no console errors", errors.length === 0, errors);
}

// ---- everything that floats over something else has to be solid ----
// A surface painted with --lumiverse-bg-elevated alone is 90% opaque, so the
// content behind it stays legible through it. That has now bitten the hint
// popover, the retry pop-up, the live log and the full-size editor. This checks
// every floating surface at once rather than one at a time.
console.log("\nfloating surfaces");
{
  // Run on light as well as dark. Every fallback colour in the source is a dark
  // one, so a surface that reached for a variable the host does not set would
  // show up here as a dark box on a light panel.
  // wantsDark says what the theme itself asked for, which is not the same as
  // what the page behind it looks like. On a light page whose variables are all
  // still dark, a dark surface is the theme being followed, not a fallback
  // leaking, so that theme is checked for being solid and readable and not for
  // being light.
  for (const [themeName, themeCss, wantsDark] of [
    ["dark", "", true],
    ["light", LIGHT, false],
    ["dark variables on a light page", LIGHT_PAGE, true],
  ]) {
  const { out, errors } = await inPanel(browser, { css: themeCss }, async (page) =>
    page.evaluate(async () => {
      const opaque = (el) => {
        if (!el) return null;
        const bg = getComputedStyle(el).backgroundColor;
        const m = bg.match(/rgba?\(([^)]+)\)/);
        if (!m) return { bg, ok: false };
        const parts = m[1].split(",").map((x) => x.trim());
        const a = parts.length > 3 ? Number(parts[3]) : 1;
        return { bg, ok: a === 1 };
      };
      const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const found = {};

      // the hint popover
      document.querySelector("button[data-ar-hint]").dispatchEvent(new MouseEvent("mouseenter"));
      await frame();
      found.hint = opaque(document.querySelector('[role="tooltip"]'));
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

      // the full-size editor
      for (const h of document.querySelectorAll('[role="button"][aria-expanded="false"]')) h.click();
      // Sections travel open now, so their contents have no height for the
      // length of that. Waited out here rather than in every check below.
      await new Promise((r) => setTimeout(r, 260));
      await frame();
      const ex = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Expand");
      if (ex) ex.click();
      await frame();
      const box = [...document.querySelectorAll("body > div")]
        .filter((d) => d.id !== "modal")
        .map((d) => d.querySelector("textarea") && d.querySelector("textarea").parentElement)
        .find(Boolean);
      found.editor = opaque(box);
      const cancel = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Cancel");
      if (cancel) cancel.click();
      await frame();

      // the live log and the retry pop-up, reached through the module's own
      // entry points rather than by rebuilding them here
      found.log = opaque(document.getElementById("__lvRetryLog"));
      found.toast = opaque(document.getElementById("__lvRetryToast"));
      return found;
    }),
  );
  check(themeName + ": the hint popover is solid", out.hint && out.hint.ok, out.hint);
  check(themeName + ": the full-size editor is solid", out.editor && out.editor.ok, out.editor);
  // A dark fallback leaking onto a light panel would show up as a dark surface.
  const surfaceIsDark = (bg) => {
    const m = bg && bg.match(/rgba?\(([^)]+)\)/);
    if (!m) return false;
    const [r, g, b2] = m[1].split(",").map(Number);
    return (r + g + b2) / 3 < 90;
  };
  check(themeName + ": the surfaces follow the theme rather than a fallback",
    surfaceIsDark(out.hint && out.hint.bg) === wantsDark, {
      hint: out.hint && out.hint.bg, editor: out.editor && out.editor.bg });
  check(themeName + ": no console errors", errors.length === 0, errors);
  }

  // The live log and the retry pop-up only exist once something has happened,
  // so these are driven rather than opened by hand.
  const page = await browser.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await stage(page, '<div id=modal></div><button data-testid="regenerate">Regenerate</button>');
  await page.addStyleTag({ content: THEME });
  await page.addScriptTag({ content: SOURCE, type: "module" });
  await page.waitForFunction(() => !!window.__setup);
  const live = await page.evaluate(async () => {
    const handlers = {};
    window.__setup(
      {
        events: { on: (n, fn) => { handlers[n] = fn; return () => {}; } },
        ui: { showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
              registerInputBarAction: () => ({ onClick: () => () => {}, destroy: () => {} }) },
      },
      { liveLog: true, toast: true, retryDelayMs: 400, backoffFactor: 1, jitter: false, maxRetries: 2,
        stuckTimeoutMs: 0, idleTimeoutMs: 0, pauseWhenFailing: false },
    );
    // An empty reply schedules a retry, and the pop-up counts it down.
    handlers.GENERATION_STARTED({ chatId: "c", generationId: "g" });
    handlers.GENERATION_ENDED({ chatId: "c", content: "" });
    await new Promise((r) => setTimeout(r, 80));
    const opaque = (el) => {
      if (!el) return null;
      const bg = getComputedStyle(el).backgroundColor;
      const m = bg.match(/rgba?\(([^)]+)\)/);
      if (!m) return { bg, ok: false };
      const parts = m[1].split(",").map((x) => x.trim());
      return { bg, ok: (parts.length > 3 ? Number(parts[3]) : 1) === 1 };
    };
    // The log is the fixed panel bottom-right that is not the pop-up.
    const logEl = [...document.querySelectorAll("body > div")].find(
      (d) => d.id !== "modal" && getComputedStyle(d).position === "fixed" && d.id !== "__lvRetryToast",
    );
    return { toast: opaque(document.getElementById("__lvRetryToast")), log: opaque(logEl) };
  });
  await page.close();
  check("the retry pop-up is solid", live.toast && live.toast.ok, live.toast);
  check("the live log is solid", live.log && live.log.ok, live.log);
  check("no console errors on those", errs.length === 0, errs);
}

// ---- a control with nothing to act on is not offered ----
// With no presets saved, Load, Update selected, Delete and Rename selected had
// nothing to work on, Load styled as the primary action. They all guarded on
// click and answered with a message, which is the wrong end to fix it at.
console.log("\npreset controls");
{
  const { out, errors } = await inPanel(browser, {}, async (page) =>
    page.evaluate(async () => {
      for (const h of document.querySelectorAll('[role="button"][aria-expanded="false"]')) h.click();
      // Sections travel open now, so their contents have no height for the
      // length of that. Waited out here rather than in every check below.
      await new Promise((r) => setTimeout(r, 260));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const by = (t) => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === t);
      // The preset dropdown sits in the same row as its Load button. Taken
      // that way rather than as the first select on the page, which is only
      // the preset one for as long as no section above it holds a dropdown.
      const sel = by("Load").parentElement.querySelector("select");
      const names = ["Load", "Update selected", "Delete", "Rename selected"];
      const state = () => names.map((n) => { const b = by(n); return { n, off: !!(b && b.disabled) }; });

      const empty = { picked: sel ? sel.value : null, buttons: state(), options: sel ? sel.options.length : 0 };

      // Save one, which selects it, and everything should come alive.
      document.querySelector('input[placeholder="Preset name"]').value = "trial";
      by("Save as new").click();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const saved = { picked: sel.value, buttons: state(), options: sel.options.length };

      // Back to the placeholder, and they should go quiet again.
      sel.value = "";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const cleared = { picked: sel.value, buttons: state() };

      // Typing a name is the action, so Save as new stays live throughout.
      const saveAlways = !by("Save as new").disabled;
      // If this ever reports blocked, these checks are running on about:blank
      // again and nothing that persists is really being exercised.
      let storage = "works";
      try { localStorage.setItem("__lvProbe", "1"); localStorage.removeItem("__lvProbe"); }
      catch (e) { storage = "BLOCKED: " + e.name; }
      return { empty, saved, cleared, saveAlways, storage };
    }),
  );
  check("with nothing saved, all four are off",
    out.empty.buttons.every((b) => b.off), out.empty);
  check("saving one turns them on",
    out.saved.picked === "trial" && out.saved.buttons.every((b) => !b.off), out.saved);
  check("deselecting turns them off again",
    out.cleared.buttons.every((b) => b.off), out.cleared);
  check("Save as new is never disabled", out.saveAlways);
  check("and these checks have real storage to work with", out.storage === "works", out.storage);
  check("no console errors", errors.length === 0, errors);
}

// ---- what a preset is allowed to touch ----
// The docs promise that loading a preset cannot switch swapping on for you, or
// take away the confirmation step, or move buttons around in your Extras menu.
// This drives a real save and a real load to prove it, which was not possible
// until these checks had working storage.
// Two preset bars now, identical to look at and driving different stores. The
// risk is that they are wired to the same one, which would look completely
// normal until somebody loaded a note set and found their word swaps replaced.
console.log("\none preset bar, holding only its own keys");
{
  const { out, errors } = await inPanel(browser, {}, async (page) =>
    page.evaluate(async () => {
      const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      for (const h of document.querySelectorAll('[role="button"][aria-expanded="false"]')) h.click();
      // Sections travel open now, so their contents have no height for the
      // length of that. Waited out here rather than in every check below.
      await new Promise((r) => setTimeout(r, 260));
      await frame();
      const bar = (kind) => document.querySelector('[data-ar-presets="' + kind + '"]');
      const press = (b, label) =>
        [...b.querySelectorAll("button")].find((x) => x.textContent.trim() === label).click();
      const notes = document.querySelector('[data-ar-row="refusalExtraPhrases"] textarea');
      if (notes) {
        notes.value = "try again";
        notes.dispatchEvent(new Event("change", { bubbles: true }));
      }
      // A preset saves what has been saved, not what is typed, so the panel's
      // own Save goes first. It is not inside the bar.
      [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Save").click();
      await frame();
      const b = bar("notes");
      b.querySelector('input[placeholder="Preset name"]').value = "noteset";
      press(b, "Save as new");
      await frame();
      const store = JSON.parse(localStorage.getItem("lv-auto-retry:presets:v1"));
      return {
        barExists: !!b,
        // The word swap bar went with the feature. Nothing should be left
        // building one, and nothing should be left in the store under it.
        swapBarGone: !bar("swap"),
        swapStoreGone: !(store.swap && store.swap.length),
        noteNames: (store.notes || []).map((p) => p.name),
        noteKeys: Object.keys(((store.notes || [])[0] || {}).values || {}).sort(),
        // The bar saves the settings above it and reads as part of them; the
        // tester is a place to try them and belongs after the lot.
        notesBeforeTester: (() => {
          const tester = document.querySelector('textarea[placeholder="Paste a reply here"]');
          if (!tester || !b) return null;
          return !!(b.compareDocumentPosition(tester) & Node.DOCUMENT_POSITION_FOLLOWING);
        })(),
      };
    }),
  );
  check("the note preset bar is on the panel", out.barExists, out);
  check("and the word swap bar is gone with the feature", out.swapBarGone && out.swapStoreGone, out);
  check("it saves into its own store", out.noteNames.join() === "noteset", out);
  check("a note preset carries the notes and where they go, and nothing else",
    out.noteKeys.join() === "refusalNotePlacement,refusalNotes", out.noteKeys);
  check("the preset bar is above the tester, not below it",
    out.notesBeforeTester === true, out.notesBeforeTester);
  check("no console errors", errors.length === 0, errors);
}

// ---- walking out to the home screen ----
// Nothing announces that reliably. CHAT_SWITCHED carries a null id for it, but
// a build that emits only CHAT_CHANGED says nothing, and the backend answers
// with the account's most recent chat, which on the home screen is the chat
// just left. So the per-chat row went on naming that chat and offering to
// switch Auto Retry off in it, until the user walked back in or reloaded.
// The address bar is what tells them apart, and this drives a real one.
console.log("\nleaving a chat for the home screen");
{
  const CHAT = "b7c41e02-9a3d-4f18-8e55-0d216ac9f730";
  const { out, errors } = await inPanel(browser, {}, async (page) =>
    page.evaluate(async (chat) => {
      const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const row = () => document.querySelector("[data-ar-chat-switch]");
      const state = () => {
        const r = row();
        return {
          button: r.querySelector("button").textContent.trim(),
          off: r.querySelector("button").disabled,
          note: r.querySelector("div + div").textContent.trim().slice(0, 40),
        };
      };
      // In a chat, with the address naming it the way a Lumiverse chat URL does.
      history.pushState({}, "", "/chat/" + chat);
      window.__handlers.CHARACTER_MESSAGE_RENDERED({ chatId: chat, messageId: "m1" });
      await frame();
      const inChat = state();
      // Out to the home screen, with nothing said about it.
      history.pushState({}, "", "/");
      await wait(1200);
      const atHome = state();
      // And back in, which is the path that used to be the only way out of it.
      history.pushState({}, "", "/chat/" + chat);
      window.__handlers.CHARACTER_MESSAGE_RENDERED({ chatId: chat, messageId: "m2" });
      await frame();
      const backIn = state();
      return { inChat, atHome, backIn };
    }, CHAT),
  );
  check("in a chat the switch is live", out.inChat.off === false, out.inChat);
  check("on the home screen it is not", out.atHome.off === true, out.atHome);
  check("and it says no chat is open rather than waiting to find out",
    /^No chat is open/.test(out.atHome.note), out.atHome.note);
  check("walking back in makes it live again", out.backIn.off === false, out.backIn);
  check("no console errors", errors.length === 0, errors);
}

// The live line reads the same held id, so a chat switched off kept the panel
// saying "Off in this chat" on the home screen, where there is no this chat.
console.log("\nthe live line after walking out");
{
  const CHAT = "4f8a1d63-77be-4c20-9351-ea0b5d94c187";
  const { out, errors } = await inPanel(
    browser,
    { settings: { liveLog: true, panelHome: "float", toast: false } },
    async (page) =>
      page.evaluate(async (chat) => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const read = () =>
          (document.getElementById("__lvRetryStatus") || {}).textContent?.trim() || "";
        history.pushState({}, "", "/chat/" + chat);
        window.__handlers.CHARACTER_MESSAGE_RENDERED({ chatId: chat, messageId: "m1" });
        await wait(400);
        // Switched off for this chat alone, from the panel's own row.
        document.querySelector("[data-ar-chat-switch] button").click();
        await wait(400);
        const inChat = read();
        history.pushState({}, "", "/");
        await wait(1400);
        return { inChat: inChat, atHome: read() };
      }, CHAT),
  );
  check("in the chat the line says it is off there",
    /off in this chat/i.test(out.inChat), out.inChat);
  check("on the home screen it does not", !/off in this chat/i.test(out.atHome), out.atHome);
  check("no console errors", errors.length === 0, errors);
}

// ---- an address that never names the chat ----
// The whole check above rests on the id turning up in the address. A build
// whose addresses do not carry it must be left exactly as it was, rather than
// having its chat thrown away every time anything else moves.
console.log("\nan address that never names the chat");
{
  const { out, errors } = await inPanel(browser, {}, async (page) =>
    page.evaluate(async () => {
      const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const row = () => document.querySelector("[data-ar-chat-switch]");
      const live = () => !row().querySelector("button").disabled;
      history.pushState({}, "", "/app");
      window.__handlers.CHARACTER_MESSAGE_RENDERED({ chatId: "c-9931", messageId: "m1" });
      await frame();
      const before = live();
      history.pushState({}, "", "/app/settings");
      await wait(1200);
      return { before: before, after: live() };
    }),
  );
  check("the chat is still known", out.before === true, out);
  check("and moving around does not throw it away", out.after === true, out);
  check("no console errors", errors.length === 0, errors);
}

// ---- a preset bar with nothing to save ----
// The note boxes are hidden while the switch that sends notes is off. The bar
// that saves those boxes was not, so it sat under a heading with nothing to act
// on, and loading a set there would have written wording nobody could see. Both
// headings are checked here too: two bars that look the same need names that
// say which settings each one carries.
console.log("\nthe note preset bar follows the notes switch");
{
  const { out, errors } = await inPanel(browser, { settings: { retryOnRefusal: true } }, async (page) =>
    page.evaluate(async () => {
      const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      for (const h of document.querySelectorAll('[role="button"][aria-expanded="false"]')) h.click();
      // Sections travel open now, so their contents have no height for the
      // length of that. Waited out here rather than in every check below.
      await new Promise((r) => setTimeout(r, 260));
      await frame();
      const root = document.getElementById("modal");
      // The block is the bar's parent: hairline, heading, description and bar.
      const block = (kind) => {
        const bar = root.querySelector('[data-ar-presets="' + kind + '"]');
        return bar && bar.parentElement;
      };
      const shown = (el) => !!el && el.style.display !== "none";
      const headingOf = (kind) => {
        const b = block(kind);
        if (!b) return null;
        // hairline first, heading second.
        return b.children[1] ? b.children[1].textContent.trim() : null;
      };
      const off = shown(block("notes"));
      let flipped = false;
      for (const box of root.querySelectorAll("input[type=checkbox]")) {
        const row = box.closest("[data-ar-row]");
        if (row && /Send a note with a refusal retry/.test(row.textContent)) {
          box.click();
          flipped = true;
          break;
        }
      }
      await frame();
      return {
        off: off,
        on: shown(block("notes")),
        flipped: flipped,
        noteHeading: headingOf("notes"),
      };
    }),
  );
  check("the switch was found and flipped", out.flipped, out);
  check("with notes off the bar is not on screen", out.off === false, out.off);
  check("turning notes on brings it back", out.on === true, out.on);
  check("the note bar says what it saves", out.noteHeading === "Note presets", out.noteHeading);
  check("no console errors", errors.length === 0, errors);
}

// Presets are stored as one object holding every kind, and three places used
// to reach past that into one key. With a second kind that meant note presets
// never followed the account, and the reset that names word swaps deleted them
// as a side effect of writing an object without their key.
console.log("\npresets across both kinds");
{
  const errors = [];
  const fresh = async (fn, arg) => {
    const c = await browser.newContext();
    const page = await c.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("**/*", (r) => r.fulfill({ contentType: "text/html",
      body: '<!doctype html><meta charset=utf-8><div id=modal style="height:900px;overflow:auto"></div>' }));
    await page.goto("http://lumiverse.test/");
    await page.addScriptTag({ content: SOURCE, type: "module" });
    await page.waitForFunction(() => !!window.__setup);
    const out = await page.evaluate(fn, arg);
    await page.close();
    await c.close();
    return out;
  };

  // The account knows about one kind, the browser about the other. Whichever
  // way round, both have to survive.
  const sync = await fresh(async (account) => {
    const KEY = "lv-auto-retry:presets:v1";
    localStorage.setItem(KEY, JSON.stringify({ swap: [{ name: "localswap", values: {} }], notes: [] }));
    const listeners = [];
    window.__setup({
      events: { on: () => () => {} },
      sendToBackend: (m) => {
        if (m && m.type === "load_presets")
          setTimeout(() => listeners.forEach((f) =>
            f({ type: "loaded_presets", requestId: m.requestId, presets: account })), 0);
      },
      onBackendMessage: (cb) => { listeners.push(cb); return () => {}; },
      ui: { showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
            registerInputBarAction: () => ({ onClick: () => () => {}, destroy: () => {} }) },
    }, { toast: false });
    await new Promise((r) => setTimeout(r, 250));
    const s = JSON.parse(localStorage.getItem(KEY));
    return { swap: (s.swap || []).map((p) => p.name), notes: (s.notes || []).map((p) => p.name) };
  }, { swap: [], notes: [{ name: "accountnote", values: {} }] });
  check("a kind the account has arrives", sync.notes.join() === "accountnote", sync);
  check("and a kind only this browser has is not dropped", sync.swap.join() === "localswap", sync);

  // The reset line names presets, so it has to mean all of them: counted,
  // cleared, and with no key left missing for the next read to trip over.
  const del = await fresh(async () => {
    const KEY = "lv-auto-retry:presets:v1";
    localStorage.setItem(KEY, JSON.stringify({
      swap: [{ name: "s", values: {} }], notes: [{ name: "n", values: {} }] }));
    window.__acts = {};
    window.__setup({ events: { on: () => () => {} }, sendToBackend: () => {}, onBackendMessage: () => () => {},
      ui: { showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
            registerInputBarAction: (o) => { const a = { onClick: (cb) => { a.cb = cb; return () => {}; }, destroy: () => {} }; window.__acts[o.id] = a; return a; } },
    }, { toast: false });
    window.__acts["auto-retry-settings"].cb();
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await frame();
    [...document.querySelectorAll("button")].find((x) => /^Reset/.test(x.textContent.trim())).click();
    await frame();
    const line = document.querySelector('[data-ar-reset="presets"]');
    const shown = line.textContent.replace(/\s+/g, " ").trim();
    line.querySelector("input").checked = true;
    [...document.querySelectorAll("#__lvRetryReset button")]
      .find((x) => /^Reset ticked/.test(x.textContent.trim())).click();
    await frame();
    [...document.querySelectorAll("#__lvRetryReset button")]
      .find((x) => /^Yes/.test(x.textContent.trim())).click();
    await frame();
    const s = JSON.parse(localStorage.getItem(KEY));
    return { shown, keys: Object.keys(s).sort(), swap: (s.swap || []).length, notes: (s.notes || []).length };
  });
  check("the count offered covers every kind", /2 saved/.test(del.shown), del.shown);
  check("and deleting clears every kind", del.swap === 0 && del.notes === 0, del);
  // A cleared store that dropped a key reads back as a store with that kind
  // missing, which is how the note presets vanished in the first place.
  check("leaving no kind missing from the store", del.keys.join() === "notes,swap", del.keys);
  check("no console errors", errors.length === 0, errors);
}

console.log("\npreset boundary");
{
  // What a preset owns and what stays yours whatever you load. The word swap
  // kind is gone; the note kind keeps the same contract, expressed the other
  // way round, as a list of what it carries rather than what it leaves out.
  const { out, errors } = await inPanel(browser, { settings: { retryOnRefusal: true, refusalNote: true } }, async (page) =>
    page.evaluate(async () => {
      const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      for (const h of document.querySelectorAll('[role="button"][aria-expanded="false"]')) h.click();
      // Sections travel open now, so their contents have no height for the
      // length of that. Waited out here rather than in every check below.
      await new Promise((r) => setTimeout(r, 260));
      await frame();
      const bar = document.querySelector('[data-ar-presets="notes"]');
      const by = (t) => [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === t);
      const inBar = (t) => [...bar.querySelectorAll("button")].find((x) => x.textContent.trim() === t);
      const ctl = (k) => {
        const r = document.querySelector('[data-ar-row="' + k + '"]');
        return r && (r.querySelector("textarea") || r.querySelector("select") || r.querySelector("input"));
      };
      const set = (k, v) => {
        const i = ctl(k);
        if (!i) return;
        if (i.type === "checkbox") { if (i.checked !== v) i.click(); }
        else { i.value = v; i.dispatchEvent(new Event("input", { bubbles: true })); i.dispatchEvent(new Event("change", { bubbles: true })); }
      };
      const get = (k) => { const i = ctl(k); return i ? (i.type === "checkbox" ? i.checked : i.value) : "(missing)"; };

      // Saved, and saved with wording that could not be mistaken for a default.
      set("refusalNotes", "please try that again");
      by("Save").click(); await frame();
      bar.querySelector('input[placeholder="Preset name"]').value = "A";
      inBar("Save as new").click(); await frame();

      // Changed, and the switch that decides whether notes go at all turned off.
      set("refusalNotes", "something else entirely");
      set("refusalNote", false);
      by("Save").click(); await frame();

      const sel = bar.querySelector("select");
      sel.value = "A";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      inBar("Load").click(); await frame();

      return { notes: get("refusalNotes"), sending: get("refusalNote") };
    }),
  );
  check("a preset restores the wording it saved", out.notes === "please try that again", out);
  // The point of the contract: a saved set of wording decides the wording and
  // nothing about whether the feature runs.
  check("loading one cannot start sending notes for you", out.sending === false, out);
  check("no console errors", errors.length === 0, errors);
}

console.log("\nbackup round trip");
{
  const page = await browser.newPage({ acceptDownloads: true });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await stage(page, "<div id=modal></div>");
  await page.addStyleTag({ content: THEME });
  await page.addScriptTag({ content: SOURCE, type: "module" });
  await page.waitForFunction(() => !!window.__setup);

  // Capture the export without going near the filesystem: the code makes a blob
  // and clicks an anchor, so intercepting the anchor click is enough.
  await page.evaluate(() => {
    window.__exported = null;
    const realClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download) {
        fetch(this.href).then((r) => r.text()).then((t) => { window.__exported = t; });
        return;
      }
      return realClick.apply(this, arguments);
    };
  });

  const out = await page.evaluate(async () => {
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const acts = {};
    window.__setup(
      { events: { on: () => () => {} },
        ui: { showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
              registerInputBarAction: (o) => { const a = { onClick: (cb) => { a.cb = cb; return () => {}; }, destroy: () => {} }; acts[o.id] = a; return a; } } },
      {},
    );
    acts["auto-retry-settings"].cb();
    await frame();
    for (const h of document.querySelectorAll('[role="button"][aria-expanded="false"]')) h.click();
      // Sections travel open now, so their contents have no height for the
      // length of that. Waited out here rather than in every check below.
      await new Promise((r) => setTimeout(r, 260));
    await frame();
    const by = (t) => [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === t);

    // Give every setting a value that is not its default, staying inside each
    // field's own limits so nothing is clamped back on the way out.
    const rows = [...document.querySelectorAll("[data-ar-row]")];
    const wanted = {};
    const unreachable = [];
    for (const r of rows) {
      const key = r.getAttribute("data-ar-row");
      if (!key || key === "1") continue;
      // Every control kind, not just the two this started with. Looking only
      // for textarea and input meant the picker rows added later were skipped
      // in silence, and this check passed while covering 48 settings out of 50.
      const el = r.querySelector("textarea") || r.querySelector("input") || r.querySelector("select");
      if (!el) { unreachable.push(key); continue; }
      // A note list holds several controls and exports an array, so it is set
      // and compared on its own terms rather than as one scalar.
      if (r.querySelectorAll("textarea").length && r.querySelectorAll("select").length) {
        const box = r.querySelector("textarea");
        const who = r.querySelector("select");
        box.value = "probe-" + key;
        box.dispatchEvent(new Event("input", { bubbles: true }));
        const other = [...who.options].map((o) => o.value).find((v) => v !== who.value);
        if (other != null) { who.value = other; who.dispatchEvent(new Event("change", { bubbles: true })); }
        wanted[key] = { list: true, text: "probe-" + key, role: who.value };
        continue;
      }
      if (el.tagName === "SELECT") {
        const other = [...el.options].map((o) => o.value).find((v) => v !== el.value);
        if (other != null) { el.value = other; el.dispatchEvent(new Event("change", { bubbles: true })); }
        wanted[key] = el.value;
      }
      else if (el.type === "checkbox") { el.click(); wanted[key] = el.checked; }
      else if (el.type === "number" || el.inputMode === "numeric") {
        const lo = Number(el.min) || 0;
        const hi = el.max === "" || el.max == null ? Number.MAX_SAFE_INTEGER : Number(el.max);
        const cur = Number(el.value) || lo;
        const next = cur + 1 <= hi ? cur + 1 : Math.max(lo, cur - 1);
        el.value = String(next);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        wanted[key] = String(next);
      } else {
        el.value = "probe-" + key;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        wanted[key] = "probe-" + key;
      }
    }
    by("Save").click();
    await frame();

    // The export category boxes only. querySelectorAll("div") hands back
    // ancestors first, so searching it for a container holding "Export to file"
    // finds the whole panel and every checkbox in it. Walk up from the button
    // instead, and stop at the tightest box that holds the categories.
    const exportBtn = by("Export to file");
    let scope = exportBtn.parentElement;
    while (scope && scope.querySelectorAll("input[type=checkbox]").length < 4) scope = scope.parentElement;
    const boxes = scope ? [...scope.querySelectorAll("input[type=checkbox]")] : [];
    // Anything this scope holds that is also a settings row means we climbed too
    // far and are about to undo the values set above.
    const overreach = scope ? scope.querySelectorAll("[data-ar-row]").length : -1;
    for (const b of boxes) if (!b.checked) b.click();
    exportBtn.click();
    await new Promise((r) => setTimeout(r, 150));
    return { wanted, exported: window.__exported, categories: boxes.length, overreach, unreachable, rows: rows.length };
  });
  await page.close();

  const parsed = (() => { try { return JSON.parse(out.exported); } catch (_) { return null; } })();
  const inFile = new Set();
  if (parsed && parsed.settings) for (const cat of Object.values(parsed.settings)) for (const k of Object.keys(cat)) inFile.add(k);
  const missing = Object.keys(out.wanted).filter((k) => !inFile.has(k));

  check("every settings row could be read, whatever kind of control it holds",
    out.unreachable.length === 0, out.unreachable);
  check("the category boxes were found without catching settings rows", out.overreach === 0, out.overreach);
  check("the export is valid JSON with a version", !!parsed && !!parsed.autoRetry, out.exported && out.exported.slice(0, 60));
  check("every setting in the panel is in the backup", missing.length === 0, missing);
  const matches = (k) => {
    for (const cat of Object.values((parsed && parsed.settings) || {})) {
      if (!(k in cat)) continue;
      const want = out.wanted[k];
      const got = cat[k];
      if (want && want.list) {
        return Array.isArray(got) && got.length >= 1 &&
          got[0].text === want.text && got[0].role === want.role;
      }
      return String(got) === String(want);
    }
    return false;
  };
  check("and the values are the ones on screen",
    !!parsed && Object.keys(out.wanted).every(matches),
    Object.keys(out.wanted).filter((k) => !matches(k)).slice(0, 6));
  check("a note list is backed up with its text and its role, not flattened",
    matches("refusalNotes"),
    (() => { for (const cat of Object.values((parsed && parsed.settings) || {})) if ("refusalNotes" in cat) return cat.refusalNotes; return "(absent)"; })());
  check("no console errors", errors.length === 0, errors);
}

// ---- and a backup has to load back in ----
// Export was covered above. Import is the half that can overwrite a working
// setup with a bad file, so it gets the harder cases: junk, a file from another
// app, unknown keys, out-of-range numbers, and the promise that nothing sticks
// until Save is pressed. Files are fed through the real file input, so the
// reader and the handler run exactly as they do for a person.
console.log("\nbackup restore");
{
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await stage(page, "<div id=modal></div>");
  await page.addStyleTag({ content: THEME });
  await page.addScriptTag({ content: SOURCE, type: "module" });
  await page.waitForFunction(() => !!window.__setup);
  await page.evaluate(async () => {
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    window.__acts = {};
    window.__setup(
      { events: { on: () => () => {} },
        ui: { showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
              registerInputBarAction: (o) => { const a = { onClick: (cb) => { a.cb = cb; return () => {}; }, destroy: () => {} }; window.__acts[o.id] = a; return a; } } },
      {},
    );
    window.__acts["auto-retry-settings"].cb();
    await frame();
    for (const h of document.querySelectorAll('[role="button"][aria-expanded="false"]')) h.click();
      // Sections travel open now, so their contents have no height for the
      // length of that. Waited out here rather than in every check below.
      await new Promise((r) => setTimeout(r, 260));
    await frame();
    window.__by = (t) => [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === t);
    window.__ctl = (k) => { const r = document.querySelector('[data-ar-row="' + k + '"]'); return r && (r.querySelector("textarea") || r.querySelector("input")); };
    window.__get = (k) => { const el = window.__ctl(k); return el ? (el.type === "checkbox" ? el.checked : el.value) : "(missing)"; };
    window.__status = () => {
      const bits = [...document.querySelectorAll("div")].map((d) => d.textContent || "");
      return bits.filter((t) => /Imported|isn't a valid|Nothing matched|Couldn't read/.test(t)).pop() || "";
    };
    // A starting point that the file will contradict.
    window.__ctl("enabled").click();
    const r = window.__ctl("refusalExtraPhrases");
    r.value = "cat => dog"; r.dispatchEvent(new Event("input", { bubbles: true })); r.dispatchEvent(new Event("change", { bubbles: true }));
    window.__by("Save").click();
    await frame();
  });

  const feed = async (name, body) => {
    await page.setInputFiles('input[type=file]', {
      name, mimeType: "application/json", buffer: Buffer.from(body),
    });
    await page.waitForTimeout(120);
  };
  const read = () =>
    page.evaluate(() => ({
      enabled: window.__get("enabled"),
      maxRetries: window.__get("maxRetries"),
      rules: window.__get("refusalExtraPhrases"),
      status: window.__status(),
      stored: (() => { try { return JSON.parse(localStorage.getItem("lv-auto-retry:settings:v1")); } catch (_) { return null; } })(),
    }));

  const before = await read();

  // Junk, then a valid JSON file that is not one of ours.
  await feed("junk.json", "this is not json at all {{{");
  const afterJunk = await read();
  await feed("other.json", JSON.stringify({ someOtherApp: true, version: 3 }));
  const afterForeign = await read();

  // A category name we do not know sits alongside a real one. The unknown one
  // must be skipped without taking the rest of the file down with it.
  await feed("partly-unknown.json", JSON.stringify({
    autoRetry: "test",
    settings: { madeUpCategory: { whatever: 1 }, retry: { maxRetries: 6 } },
  }));
  const afterUnknownCat = await read();

  // A real backup, including an unknown key and a number far out of range.
  await feed("backup.json", JSON.stringify({
    autoRetry: "test",
    settings: {
      retry: { enabled: true, maxRetries: 999999, notASetting: "ignore me" },
      refusal: { refusalExtraPhrases: "hot => cold" },
    },
  }));
  const afterGood = await read();

  // A note list is the one setting that is not a string, a number or a flag, so
  // it is the one a file can be shaped wrongly for. A good one first.
  await feed("notes.json", JSON.stringify({
    autoRetry: "test",
    settings: { refusal: { refusalNotes: [
      { text: "first note", role: "assistant" },
      { text: "second note", role: "user" },
    ] } },
  }));
  const afterNotes = await page.evaluate(() => {
    const row = document.querySelector('[data-ar-row="refusalNotes"]');
    return {
      texts: [...row.querySelectorAll("textarea")].map((t) => t.value),
      roles: [...row.querySelectorAll("select")].map((t) => t.value),
      status: window.__status(),
    };
  });

  // Then every wrong shape at once: not a list, a role that does not exist, an
  // item that is not an object, and more notes than the limit allows.
  await feed("notes-bad.json", JSON.stringify({
    autoRetry: "test",
    settings: { refusal: { refusalNotes: "not a list" } },
  }));
  const afterNotAList = await page.evaluate(() => {
    const row = document.querySelector('[data-ar-row="refusalNotes"]');
    return { count: row.querySelectorAll("textarea").length,
             texts: [...row.querySelectorAll("textarea")].map((t) => t.value) };
  });
  await feed("notes-odd.json", JSON.stringify({
    autoRetry: "test",
    settings: { refusal: { refusalNotes: [
      { text: "kept", role: "sudo" },
      null,
      ...Array.from({ length: 40 }, (_, i) => ({ text: "n" + i, role: "user" })),
    ] } },
  }));
  const afterOdd = await page.evaluate(() => {
    const row = document.querySelector('[data-ar-row="refusalNotes"]');
    return {
      count: row.querySelectorAll("textarea").length,
      firstRole: row.querySelector("select").value,
      firstText: row.querySelector("textarea").value,
    };
  });

  // Nothing is kept until Save.
  await page.evaluate(() => window.__by("Save").click());
  await page.waitForTimeout(60);
  const afterSave = await read();
  await page.close();

  check("junk is refused and nothing changes",
    afterJunk.enabled === before.enabled && afterJunk.rules === before.rules &&
    /isn't a valid/.test(afterJunk.status), afterJunk);
  check("a file from another app is refused too",
    afterForeign.rules === before.rules && /isn't a valid/.test(afterForeign.status), afterForeign);
  check("a category we do not know is skipped, not fatal",
    afterUnknownCat.maxRetries === "6" && /Imported/.test(afterUnknownCat.status), afterUnknownCat.status);
  check("a real backup fills the fields in", afterGood.rules === "hot => cold" &&
    afterGood.enabled === true, afterGood);
  check("a backed-up note list comes back with its text and its roles",
    afterNotes.texts[0] === "first note" && afterNotes.texts[1] === "second note" &&
    afterNotes.roles[0] === "assistant" && afterNotes.roles[1] === "user", afterNotes);
  check("a note list that is not a list leaves one empty note, not a broken panel",
    afterNotAList.count === 1 && afterNotAList.texts[0] === "", afterNotAList);
  check("a role that does not exist falls back rather than being sent",
    afterOdd.firstRole === "system" && afterOdd.firstText === "kept", afterOdd);
  check("and a file with more notes than the limit is cut to the limit",
    afterOdd.count === 10, afterOdd);
  check("an out-of-range number is pulled back to the limit",
    Number(afterGood.maxRetries) > 0 && Number(afterGood.maxRetries) < 1000, afterGood.maxRetries);
  // Two independent layers stop this: applyImport reads only the keys it knows,
  // and saveSaved writes only the keys in the schema. Breaking either on its own
  // leaves the other holding, which is the point of having both. This checks the
  // outcome the user cares about rather than one layer.
  check("an unknown key in the file never reaches your saved settings",
    !afterSave.stored || !("notASetting" in afterSave.stored), afterSave.stored && Object.keys(afterSave.stored).length);
  check("an import is not kept until Save is pressed",
    before.stored && before.stored.refusalExtraPhrases === "cat => dog" &&
    afterGood.stored && afterGood.stored.refusalExtraPhrases === "cat => dog", {
      beforeSave: afterGood.stored && afterGood.stored.refusalExtraPhrases });
  check("and is kept once it is",
    afterSave.stored && afterSave.stored.refusalExtraPhrases === "hot => cold", afterSave.stored && afterSave.stored.refusalExtraPhrases);
  check("no console errors", errors.length === 0, errors);
}

// ---- a saved setting has to come back ----
// The backup checks above cover the file. Nothing covered the ordinary path:
// press Save, come back later, and find the panel showing what you set. It did
// not for every kind of setting. "Where the note goes" was read back through a
// check against the values it is allowed to hold, that check was handed the
// value without the field it belongs to, so the list of allowed values was
// empty, nothing matched, and it fell back to the first option. Whatever you
// picked, every reload put it back to "After the last message", silently.
//
// Written against every row rather than that one setting, because the fault was
// in the shared coercion rather than in the setting, and any field type added
// later goes through the same door.
console.log("\nsaved settings come back");
{
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  await stage(page, "<div id=modal></div>");
  await page.addStyleTag({ content: THEME });
  await page.addScriptTag({ content: SOURCE, type: "module" });
  await page.waitForFunction(() => !!window.__setup);

  const out = await page.evaluate(async () => {
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const boot = () => {
      const acts = {};
      const teardown = window.__setup({
        events: { on: () => () => {} },
        ui: {
          showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
          registerInputBarAction: (o) => {
            const a = { onClick: (cb) => { a.cb = cb; return () => {}; }, destroy: () => {} };
            acts[o.id] = a;
            return a;
          },
        },
      });
      return { acts, teardown };
    };
    const openAll = async (acts) => {
      acts["auto-retry-settings"].cb();
      await frame();
      for (const h of document.querySelectorAll('[role="button"][aria-expanded="false"]')) h.click();
      // Sections travel open now, so their contents have no height for the
      // length of that. Waited out here rather than in every check below.
      await new Promise((r) => setTimeout(r, 260));
      await frame();
    };
    const rows = () => [...document.querySelectorAll("[data-ar-row]")]
      .filter((r) => { const k = r.getAttribute("data-ar-row"); return k && k !== "1"; });
    // A note list holds several controls and is compared on its own terms.
    const isNoteList = (r) =>
      r.querySelectorAll("textarea").length > 0 && r.querySelectorAll("select").length > 0;
    const read = (r) => {
      if (isNoteList(r))
        return { text: r.querySelector("textarea").value, role: r.querySelector("select").value };
      const el = r.querySelector("textarea") || r.querySelector("input") || r.querySelector("select");
      if (!el) return null;
      if (el.type === "checkbox") return el.checked;
      return el.value;
    };

    const first = boot();
    await openAll(first.acts);
    // Move every setting off its default, staying inside each field's own
    // limits so nothing is clamped on the way through.
    const wanted = {};
    const unreachable = [];
    for (const r of rows()) {
      const key = r.getAttribute("data-ar-row");
      if (isNoteList(r)) {
        const box = r.querySelector("textarea");
        const who = r.querySelector("select");
        box.value = "probe-" + key;
        box.dispatchEvent(new Event("input", { bubbles: true }));
        const other = [...who.options].map((o) => o.value).find((v) => v !== who.value);
        if (other != null) { who.value = other; who.dispatchEvent(new Event("change", { bubbles: true })); }
        wanted[key] = { text: box.value, role: who.value };
        continue;
      }
      const el = r.querySelector("textarea") || r.querySelector("input") || r.querySelector("select");
      if (!el) { unreachable.push(key); continue; }
      if (el.tagName === "SELECT") {
        const other = [...el.options].map((o) => o.value).find((v) => v !== el.value);
        if (other != null) { el.value = other; el.dispatchEvent(new Event("change", { bubbles: true })); }
        wanted[key] = el.value;
      } else if (el.type === "checkbox") {
        el.click();
        wanted[key] = el.checked;
      } else if (el.type === "number" || el.inputMode === "numeric") {
        const lo = Number(el.min) || 0;
        const hi = el.max === "" || el.max == null ? Number.MAX_SAFE_INTEGER : Number(el.max);
        const cur = Number(el.value) || lo;
        const next = cur + 1 <= hi ? cur + 1 : Math.max(lo, cur - 1);
        el.value = String(next);
        el.dispatchEvent(new Event("change", { bubbles: true }));
        wanted[key] = String(next);
      } else {
        el.value = "probe-" + key;
        el.dispatchEvent(new Event("change", { bubbles: true }));
        wanted[key] = el.value;
      }
    }
    [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Save").click();
    await frame();
    const stored = JSON.parse(localStorage.getItem("lv-auto-retry:settings:v1") || "null");

    // A fresh instance against the same storage, which is what a reload is.
    first.teardown();
    const second = boot();
    await openAll(second.acts);
    const got = {};
    for (const r of rows()) got[r.getAttribute("data-ar-row")] = read(r);
    second.teardown();
    return { wanted, got, stored, unreachable, count: Object.keys(wanted).length };
  });
  await page.close();

  const same = (a, b) => {
    if (a && typeof a === "object") return !!b && a.text === b.text && a.role === b.role;
    return String(a) === String(b);
  };
  const wrong = Object.keys(out.wanted).filter((k) => !same(out.wanted[k], out.got[k]));
  const storedWrong = Object.keys(out.wanted).filter((k) => {
    const v = out.stored && out.stored[k];
    if (out.wanted[k] && typeof out.wanted[k] === "object")
      return !Array.isArray(v) || !v.length || v[0].text !== out.wanted[k].text || v[0].role !== out.wanted[k].role;
    return String(v) !== String(out.wanted[k]);
  });

  check("every settings row could be driven", out.unreachable.length === 0, out.unreachable);
  check("it covered the whole panel, not a handful of rows", out.count > 40, out.count);
  check("Save writes every setting to storage", storedWrong.length === 0, storedWrong);
  check("and a fresh start shows every one of them back",
    wrong.length === 0,
    wrong.map((k) => ({ key: k, saved: out.wanted[k], got: out.got[k] })).slice(0, 6));
  check("including the one that is picked from a list",
    same(out.wanted.refusalNotePlacement, out.got.refusalNotePlacement),
    { saved: out.wanted.refusalNotePlacement, got: out.got.refusalNotePlacement });
  check("no console errors", errors.length === 0, errors);
}

// ---- the note only gets armed for the right retry ----
// This is the only thing in the extension that changes what the model is asked,
// so when it arms matters as much as what it sends. It must go out for a
// refusal and for nothing else, never before the try it is set to start on, and
// never at all while it is off or its box is empty.
console.log("\nrefusal note");
{
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await stage(page, '<div id=modal></div><button data-testid="regenerate">Regenerate</button>');
  await page.addStyleTag({ content: THEME });
  await page.addScriptTag({ content: SOURCE, type: "module" });
  await page.waitForFunction(() => !!window.__setup);
  const out = await page.evaluate(async () => {
    const runs = [];
    const drive = async (over, ending) => {
      const handlers = {};
      const sent = [];
      const teardown = window.__setup(
        {
          events: { on: (n, fn) => { handlers[n] = fn; return () => {}; } },
          sendToBackend: (m) => sent.push(m),
          onBackendMessage: () => () => {},
          ui: { showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
                registerInputBarAction: () => ({ onClick: () => () => {}, destroy: () => {} }) },
        },
        Object.assign(
          { refusalNote: true, refusalNotes: [{ text: "This was refused by mistake.", role: "system" }],
            refusalNotePlacement: "after",
            retryDelayMs: 10, backoffFactor: 1, maxDelayMs: 10, jitter: false, maxRetries: 4,
            toast: false, stuckTimeoutMs: 0, idleTimeoutMs: 0, pauseWhenFailing: false },
          over,
        ),
      );
      const chatId = "chat" + runs.length;
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      // Each round trip is a generation that ends the same way, so the try
      // counter climbs the way it would in a chat that keeps being refused.
      for (let i = 0; i < 3; i++) {
        handlers.GENERATION_STARTED({ chatId, generationId: "g" + i });
        handlers.GENERATION_ENDED(Object.assign({ chatId }, ending));
        await wait(60);
      }
      teardown();
      const notes = sent.filter((m) => m && m.type === "arm_refusal_note");
      runs.push(notes);
      return notes;
    };

    const REFUSED = { content: "I'm sorry, but I can't create that content." };
    const CUT_OFF = { content: 'He said, "wait' };

    return {
      // Default: try 1 goes out unchanged, the note starts on try 2.
      refusal: (await drive({}, REFUSED)).length,
      // A cut-off reply is not a refusal, so it never carries the note.
      cutOff: (await drive({}, CUT_OFF)).length,
      // Set to 1 and it goes with every refusal retry.
      fromFirst: (await drive({ refusalNotes: [{ text: "This was refused by mistake.", role: "system", fromTry: 1 }] }, REFUSED)).length,
      off: (await drive({ refusalNote: false }, REFUSED)).length,
      empty: (await drive({ refusalNotes: [{ text: "   ", role: "system" }] }, REFUSED)).length,
      // What actually gets sent across the bridge.
      payload: (await drive({ refusalNotePlacement: "start",
        refusalNotes: [{ text: "This was refused by mistake.", role: "user", fromTry: 1 }] }, REFUSED))[0],
      // The panel promises the note goes out exactly as written, so the
      // spacing someone typed has to survive the trip across the bridge.
      // Trimming is only how an empty note is told from a filled one.
      padded: (await drive({
        refusalNotes: [{ text: "  keep\n  my spacing\n", role: "system", fromTry: 1 }] }, REFUSED))[0],
      // A note is armed just before the click, because some builds start the
      // generation off the click itself. When there is no control to click
      // there is no generation to attach one to, so nothing is armed at all.
      // Arming and then taking it back is also correct, but it spends the whole
      // acknowledgement wait getting there, and for that long the backend holds
      // a note for a generation that never comes. Runs last, since it takes the
      // button off the page.
      // Each note carries its own first try, so a list can escalate: a gentle
      // note on the first retry and a firmer one only if that did not work.
      // Three rounds are driven, so the second note is due on the last of them.
      escalate: (await drive({
        refusalNotes: [
          { text: "Gentle.", role: "system", fromTry: 1 },
          { text: "Firmer.", role: "system", fromTry: 3 },
        ],
      }, REFUSED)).map((m) => (m.notes || []).map((n) => n.text).join("+")),
      noControl: await (async () => {
        const btn = document.querySelector('[data-testid="regenerate"]');
        const parent = btn.parentNode;
        btn.remove();
        const msgs = await drive({ refusalNotes: [{ text: "This was refused by mistake.", role: "system", fromTry: 1 }] }, REFUSED);
        parent.appendChild(btn);
        return msgs.map((m) => (m.notes || []).length);
      })(),
    };
  });
  await page.close();
  check("a refusal arms the note", out.refusal > 0, out.refusal);
  check("but not on the first try, by default", out.refusal === 2, out.refusal);
  check("set to 1, it arms on every refusal retry", out.fromFirst === 3, out.fromFirst);
  // The whole reason a note carries its own try rather than the list carrying
  // one for all of them.
  check("a note due later is held back while the earlier one goes",
    out.escalate[0] === "Gentle." && out.escalate[1] === "Gentle.", out.escalate);
  check("and joins it once its own try comes round",
    out.escalate[2] === "Gentle.+Firmer.", out.escalate);
  check("a cut-off reply never arms it", out.cutOff === 0, out.cutOff);
  check("nor does anything while the setting is off", out.off === 0, out.off);
  check("nor while the box is empty", out.empty === 0, out.empty);
  check("the note carries its text, role, placement and chat",
    !!out.payload && out.payload.notes && out.payload.notes.length === 1 &&
    out.payload.notes[0].text === "This was refused by mistake." &&
    out.payload.notes[0].role === "user" && out.payload.placement === "start" && !!out.payload.chatId,
    out.payload);
  check("the spacing someone typed is sent as they typed it",
    !!out.padded && out.padded.notes[0].text === "  keep\n  my spacing\n", out.padded);
  check("with nothing to click, no note is armed at all",
    Array.isArray(out.noControl) && out.noControl.length === 0, out.noControl);
  check("no console errors", errors.length === 0, errors);
}

// ---- switching one chat off ----
// The master switch is all or nothing, which is the wrong shape for a scene
// where the model is meant to refuse in the middle of a day of ordinary chats.
// Turning the whole extension off for that means remembering to turn it back
// on, and forgetting looks exactly like the extension having stopped working.
console.log("\nper-chat switch");
{
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await stage(page, '<div id=modal></div><div id=host></div><button data-testid="regenerate">Regenerate</button>');
  await page.addStyleTag({ content: THEME });
  await page.addScriptTag({ content: SOURCE, type: "module" });
  await page.waitForFunction(() => !!window.__setup);
  const out = await page.evaluate(async () => {
    const host = document.getElementById("host");
    host.style.cssText = "position:fixed;left:120px;top:120px";
    const handlers = {};
    const acts = {};
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const teardown = window.__setup(
      {
        events: { on: (n, fn) => { handlers[n] = fn; return () => {}; } },
        ui: {
          showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
          registerInputBarAction: (o) => {
            const a = { onClick: (cb) => { a.cb = cb; return () => {}; }, destroy: () => {} };
            acts[o.id] = a;
            return a;
          },
          showContextMenu: (o) => { (window.__menus ||= []).push(o); return Promise.resolve({ selectedKey: window.__pick === undefined ? null : window.__pick }); },
          createFloatWidget: () => ({ root: host, destroy: () => {}, setPosition: () => {} }),
        },
      },
      { enabled: true, showFloatingToggle: true, toast: false, retryDelayMs: 10,
        backoffFactor: 1, maxDelayMs: 10, jitter: false, maxRetries: 4,
        stuckTimeoutMs: 0, idleTimeoutMs: 0, pauseWhenFailing: false },
    );
    const btn = () => host.querySelector("button");
    const menu = () => {
      const m = (window.__menus || [])[(window.__menus || []).length - 1];
      // Labels only, and a divider has none, so it never reads as an entry.
      return m ? m.items.filter((i) => i.type !== "divider").map((i) => i.label) : [];
    };
    // The shape of it, dividers included, for the check that they group rather
    // than pad.
    window.__menuShape = () => {
      const m = (window.__menus || [])[(window.__menus || []).length - 1];
      return m ? m.items.map((i) => (i.type === "divider" ? "|" : i.key)) : [];
    };
    const hold = async () => {
      btn().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 130, clientY: 130 }));
      await wait(620);
      const items = menu();
      return items;
    };
    const up = () => btn().dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    // Clicking the host regenerate button is how a retry shows itself.
    let clicks = 0;
    document.querySelector('[data-testid="regenerate"]').addEventListener("click", () => clicks++);

    handlers.GENERATION_STARTED({ chatId: "A", generationId: "a1" });
    await wait(10);
    // The floating button's menu is not where this lives. It sits over the
    // chat and is opened for the button's own business, so a per-chat switch
    // among those entries was clutter. Checked here so it cannot drift back in
    // without somebody meaning it.
    const menuOn = await hold();
    const shape = window.__menuShape();
    up();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await wait(20);
    // Settings, under Basics, is where it lives.
    acts["auto-retry-settings"].cb();
    await wait(30);
    const chatRow = () => document.querySelector("[data-ar-chat-switch]");
    const rowThere = !!chatRow();
    const flip = () => {
      const b = chatRow().querySelector("button");
      b.click();
      return b.textContent;
    };
    const saidBefore = chatRow().querySelector("button").textContent;
    flip();
    await wait(20);
    const saidAfter = chatRow().querySelector("button").textContent;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await wait(20);

    const offNow = { pressed: btn().getAttribute("aria-pressed"), label: btn().getAttribute("aria-label") };
    // A failing reply in a chat that is switched off must not be retried.
    const before = clicks;
    handlers.GENERATION_ENDED({ chatId: "A", error: "boom" });
    await wait(120);
    const retriedWhileOff = clicks > before;

    // Another chat is untouched.
    handlers.GENERATION_STARTED({ chatId: "B", generationId: "b1" });
    await wait(10);
    const otherChatOn = btn().getAttribute("aria-pressed");
    const beforeB = clicks;
    handlers.GENERATION_ENDED({ chatId: "B", error: "boom" });
    await wait(150);
    const retriedElsewhere = clicks > beforeB;

    // It survives a reload, which is the whole reason it is written down.
    const remembered = JSON.parse(localStorage.getItem("lv-auto-retry:chats-off:v1") || "[]");

    // And the panel says which of the two switches is in the way.
    handlers.GENERATION_STARTED({ chatId: "A", generationId: "a2" });
    await wait(10);
    acts["auto-retry-settings"].cb();
    await wait(30);
    const note = document.querySelector("[data-ar-master]");
    const noteShown = note && getComputedStyle(note).display !== "none";
    const noteText = note ? note.textContent : "";
    // The line is words only. It carried its own "Turn it back on here", which
    // was a second button for a switch that already has one, sitting far enough
    // from it to read as a different switch. The row is the way back.
    const noteButtons = note ? note.querySelectorAll("button").length : -1;
    const backBtn = chatRow() ? chatRow().querySelector("button") : null;
    if (backBtn) backBtn.click();
    await wait(20);
    const afterBack = {
      pressed: btn().getAttribute("aria-pressed"),
      stored: JSON.parse(localStorage.getItem("lv-auto-retry:chats-off:v1") || "[]"),
      noteShown: getComputedStyle(document.querySelector("[data-ar-master]")).display !== "none",
    };
    const menuBack = await hold();
    up();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    teardown();
    return { menuOn, shape, offNow, retriedWhileOff, otherChatOn, retriedElsewhere, remembered,
      noteShown, noteText, noteButtons, afterBack, menuBack, rowThere, saidBefore, saidAfter };
  });
  await page.close();
  check("the hold menu keeps to the button's own business",
    !out.menuOn.some((t) => /this chat/i.test(t)), out.menuOn);
  check("and still offers the way to the settings",
    out.menuOn.some((t) => /settings/i.test(t)), out.menuOn);
  // The ways in, then a line, then the one entry that takes the button away.
  check("the button's menu is grouped rather than one column",
    out.shape.indexOf("|") > 0, out.shape.join(" "));
  check("a line never opens or closes it",
    out.shape[0] !== "|" && out.shape[out.shape.length - 1] !== "|", out.shape.join(" "));
  check("hiding the button sits alone under that line",
    out.shape[out.shape.length - 1] === "hide" && out.shape[out.shape.length - 2] === "|",
    out.shape.join(" "));
  check("and a divider is never counted as an entry",
    !out.menuOn.some((t) => !t), out.menuOn);
  check("settings carries the row that switches this chat off", out.rowThere, out);
  check("which says what it will do before and after",
    /off here/i.test(out.saidBefore || "") && /on here/i.test(out.saidAfter || ""),
    { before: out.saidBefore, after: out.saidAfter });
  check("the button shows it as off once it is", out.offNow.pressed === "false", out.offNow);
  check("and says which switch is doing it", /off in this chat/i.test(out.offNow.label), out.offNow.label);
  // The point of the whole thing.
  check("a failed reply in that chat is not retried", !out.retriedWhileOff, out);
  check("but another chat still is", out.retriedElsewhere, out);
  check("and the button reads as on there", out.otherChatOn === "true", out.otherChatOn);
  check("the chat is remembered across a reload", out.remembered.includes("A"), out.remembered);
  // Somebody who switched a chat off and forgot cannot tell that from the
  // extension having broken, unless the panel tells them.
  check("the panel says this chat is switched off", out.noteShown && /off in this chat/i.test(out.noteText), out.noteText);
  check("carrying words and no button of its own", out.noteButtons === 0, out.noteButtons);
  check("and the row is the way back", out.afterBack.pressed === "true", out.afterBack);
  check("which takes it out of the list", !out.afterBack.stored.includes("A"), out.afterBack.stored);
  check("and puts the line away", !out.afterBack.noteShown, out.afterBack);
  check("and the menu still stays out of it",
    !out.menuBack.some((t) => /this chat/i.test(t)), out.menuBack);
  check("no console errors", errors.length === 0, errors);
}

// ---- what it has been doing ----
// The counters behind this already existed for the debug report, which is a
// wall of text you have to ask for and then read. On screen they answer the
// question people actually have, which is whether it is doing anything and what
// it keeps tripping on.
console.log("\nstats view");
{
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await stage(page, '<div id=modal></div><button data-testid="regenerate">Regenerate</button>');
  await page.addStyleTag({ content: THEME });
  await page.addScriptTag({ content: SOURCE, type: "module" });
  await page.waitForFunction(() => !!window.__setup);
  const out = await page.evaluate(async () => {
    const handlers = {};
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const teardown = window.__setup(
      {
        events: { on: (n, fn) => { handlers[n] = fn; return () => {}; } },
        ui: {
          showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
          registerInputBarAction: () => ({ onClick: () => () => {}, destroy: () => {} }),
        },
      },
      { liveLog: true, toast: false, retryDelayMs: 5, backoffFactor: 1, maxDelayMs: 5,
        jitter: false, maxRetries: 2, stuckTimeoutMs: 0, idleTimeoutMs: 0, pauseWhenFailing: false },
    );
    const body = () => document.getElementById("__lvRetryLogBody");
    const tab = (t) => [...document.querySelectorAll('[role="tab"]')].find((b) => b.textContent.trim() === t);

    tab("Stats").click();
    await wait(20);
    const empty = body().textContent;

    // A reply that came back fine, then two that failed differently.
    handlers.GENERATION_STARTED({ chatId: "A", generationId: "g0" });
    handlers.GENERATION_ENDED({ chatId: "A", content: "She opened the door and stepped inside." });
    handlers.GENERATION_STARTED({ chatId: "A", generationId: "g1" });
    handlers.GENERATION_ENDED({ chatId: "A", error: "boom" });
    await wait(80);
    handlers.GENERATION_STARTED({ chatId: "A", generationId: "g2" });
    handlers.GENERATION_ENDED({ chatId: "A", content: 'He said, "wait' });
    await wait(80);
    const shown = body().textContent;
    const bars = body().querySelectorAll("div[style*='width']").length;

    // Clear starts the counting again rather than leaving a stale rate behind.
    [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Clear").click();
    await wait(20);
    const afterClear = body().textContent;

    teardown();
    return { empty, shown, bars, afterClear };
  });
  await page.close();
  check("it says so when nothing has happened", /Nothing has/.test(out.empty), out.empty.slice(0, 80));
  check("a reply that came back fine is counted", /Replies that came back fine/.test(out.shown), out.shown.slice(0, 120));
  check("and so are the retries", /Retries fired/.test(out.shown), out.shown.slice(0, 120));
  // The useful part: not how many, but what for.
  check("it says what it retried for", /What it retried for/i.test(out.shown), out.shown);
  check("naming each reason", /error/.test(out.shown) && /cut off/.test(out.shown), out.shown);
  check("with a bar for each", out.bars >= 2, out.bars);
  check("Clear starts the counting again", /Nothing has/.test(out.afterClear), out.afterClear.slice(0, 80));
  check("no console errors", errors.length === 0, errors);
}

// ---- the host's own widget menu does not open under ours ----
// preventDefault stops the browser drawing its menu and nothing else, so the
// event kept bubbling to the host, which opened Lumiverse's widget menu
// underneath ours. Both were up at once, the lower one clearing when something
// dismissed it. The event has to be stopped, not just prevented.
console.log("\ntwo menus, one press");
{
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  await stage(page, "<div id=modal></div><div id=host></div>");
  await page.addStyleTag({ content: THEME });
  await page.addScriptTag({ content: SOURCE, type: "module" });
  await page.waitForFunction(() => !!window.__setup);
  const out = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const host = document.getElementById("host");
    // The host wires its own menu on the widget root it handed us, which is
    // exactly where a real Lumiverse build puts it.
    let hostMenus = 0;
    host.addEventListener("contextmenu", () => { hostMenus++; });
    let rootMenus = 0;
    const teardown = window.__setup(
      { events: { on: () => () => {} },
        ui: { showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
              registerInputBarAction: () => ({ onClick: () => () => {}, destroy: () => {} }),
              showContextMenu: (o) => { (window.__menus ||= []).push(o); return Promise.resolve({ selectedKey: window.__pick === undefined ? null : window.__pick }); },
              createFloatWidget: () => ({ root: host, destroy: () => {}, setPosition: () => {} }) } },
      { showFloatingToggle: true, floatingToggleSize: 44, toast: false },
    );
    // A late listener on the document, standing in for anything the host has
    // further up the tree.
    document.addEventListener("contextmenu", () => { rootMenus++; });

    const btn = host.querySelector("button");
    // Counted rather than looked for: the menu itself is the host's, and what
    // matters here is that exactly one was asked for and the host's own
    // listeners never heard the press that asked for it.
    const shown = () => (window.__menus || []).length;

    // Right-click, which is the desktop path.
    btn.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
    await wait(40);
    const afterRightClick = { ours: shown() === 1, hostSaw: hostMenus, docSaw: rootMenus };

    // The same again on the padding around the button, which is the host's own
    // element rather than anything we created.
    host.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
    await wait(40);
    const afterRootPress = { ours: shown() === 2, hostSaw: hostMenus, docSaw: rootMenus };

    // A plain tap must still reach the host, or dragging would stop working.
    let pointerSeen = 0;
    host.addEventListener("pointerdown", () => { pointerSeen++; });
    btn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 40, clientY: 40 }));
    btn.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    await wait(20);
    const res = { afterRightClick, afterRootPress, pointerSeen };
    teardown();
    return res;
  });
  await page.close();
  check("our menu opens on a right-click", out.afterRightClick.ours, out);
  check("and the host never sees the event",
    out.afterRightClick.hostSaw === 0 && out.afterRightClick.docSaw === 0, out);
  check("a press on the host's own padding is ours too", out.afterRootPress.ours, out);
  check("and that one does not reach the host either",
    out.afterRootPress.hostSaw === 0 && out.afterRootPress.docSaw === 0, out);
  check("pointer events still reach the host, so dragging survives",
    out.pointerSeen > 0, out);
  check("no console errors", errors.length === 0, errors);
}

// ---- the quick toggle syncs like every other change ----
// Saving the panel sends the settings to the account and to the backend. The
// floating button and the Extras entry flip the same switch, so they have to do
// the same, or the setting people change most often stays in one browser. Word
// swapping reads that switch from the backend, so it would not hear about the
// extension being switched off either.
console.log("\nthe quick toggle syncs");
{
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  await stage(page, "<div id=modal></div><div id=host></div>");
  await page.addStyleTag({ content: THEME });
  await page.addScriptTag({ content: SOURCE, type: "module" });
  await page.waitForFunction(() => !!window.__setup);
  const out = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const host = document.getElementById("host");
    const sent = [];
    const teardown = window.__setup(
      { events: { on: () => () => {} },
        sendToBackend: (m) => sent.push(m),
        ui: { showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
              registerInputBarAction: () => ({ onClick: () => () => {}, destroy: () => {} }),
              showContextMenu: (o) => { (window.__menus ||= []).push(o); return Promise.resolve({ selectedKey: window.__pick === undefined ? null : window.__pick }); },
              createFloatWidget: () => ({ root: host, destroy: () => {}, setPosition: () => {} }) } },
      { enabled: true, showFloatingToggle: true, floatingToggleSize: 44, toast: false },
    );
    const saves = () => sent.filter((m) => m && m.type === "save_settings");
    const before = saves().length;
    host.querySelector("button").click();
    await wait(40);
    const after = saves();
    const res = {
      sentOne: after.length > before,
      // And it carries the new value, not the old one.
      value: after.length ? after[after.length - 1].settings.enabled : null,
      // The off list goes over at startup, or a reload forgets it until the
      // switch is next touched.
      toldChatsOff: sent.some((m) => m && m.type === "set_chats_off"),
    };
    teardown();
    return res;
  });
  await page.close();
  check("flipping it from the button saves to the account", out.sentOne, out);
  check("and sends the value it was flipped to", out.value === false, out);
  check("the off list reaches the backend on startup", out.toldChatsOff, out);
  check("no console errors", errors.length === 0, errors);
}

// ---- one chat is one row, however late its name arrives ----
// The tally was keyed by the name at the moment a retry was counted, so a
// retry before the name came back was filed under a short id and later ones
// under the name: one chat, two rows, neither of them the real total.
console.log("\nretries are tallied per chat, not per label");
{
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  await stage(page, '<div id=modal></div><button data-testid="regenerate">Regenerate</button>');
  await page.addStyleTag({ content: THEME });
  await page.addScriptTag({ content: SOURCE, type: "module" });
  await page.waitForFunction(() => !!window.__setup);
  const out = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const handlers = {};
    // The extension registers a handler per request, so keeping only the last
    // one silently drops the reply the test is trying to deliver.
    const backendCbs = [];
    const asked = [];
    const teardown = window.__setup(
      { events: { on: (n, fn) => { handlers[n] = fn; return () => {}; } },
        sendToBackend: (m) => { if (m && m.type === "get_active_chat") asked.push(m); },
        onBackendMessage: (cb) => { backendCbs.push(cb); return () => {}; },
        ui: { showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
              registerInputBarAction: () => ({ onClick: () => () => {}, destroy: () => {} }) } },
      { liveLog: true, toast: false, retryDelayMs: 50, backoffFactor: 1, maxDelayMs: 50,
        jitter: false, maxRetries: 5, stuckTimeoutMs: 0, idleTimeoutMs: 0, pauseWhenFailing: false },
    );
    // A retry happens before any name has come back.
    handlers.GENERATION_STARTED({ chatId: "c1", generationId: "g1" });
    handlers.GENERATION_ENDED({ chatId: "c1", content: "" });
    await wait(250);

    // The name arrives afterwards, answering the question asked when the chat
    // was first seen.
    const q = asked.find((m) => m.chatId === "c1") || asked[asked.length - 1];
    if (q) for (const cb of backendCbs)
      cb({ type: "active_chat", requestId: q.requestId, chatId: "c1", character: "The Librarian" });
    await wait(60);

    // And a second retry in the same chat, now that the name is known.
    handlers.GENERATION_STARTED({ chatId: "c1", generationId: "g2" });
    handlers.GENERATION_ENDED({ chatId: "c1", content: "" });
    await wait(250);

    // A retry somewhere else, so the block is drawn at all.
    handlers.GENERATION_STARTED({ chatId: "c2", generationId: "g3" });
    handlers.GENERATION_ENDED({ chatId: "c2", content: "" });
    await wait(250);

    [...document.querySelectorAll('[role="tab"]')].find((b) => b.textContent === "Stats").click();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const body = document.getElementById("__lvRetryLogBody");
    const text = (body && body.textContent) || "";
    const rows = [...(body ? body.querySelectorAll("span") : [])]
      .map((e) => (e.textContent || "").trim())
      .filter((t) => /^With |^Chat /.test(t));
    teardown();
    return { text: text.slice(0, 400), rows, named: /With The Librarian/.test(text) };
  });
  await page.close();
  check("the named chat appears once, not split by when its name arrived",
    out.rows.filter((r) => /Librarian/.test(r)).length === 1, out.rows);
  check("and it is named rather than shown as an id", out.named, out.rows);
  check("the unnamed chat still gets a row", out.rows.some((r) => /^Chat /.test(r)), out.rows);
  check("no console errors", errors.length === 0, errors);
}

// ---- the per-chat switch knows which chat you are in ----
// The switch needs a chat id. Taking one only from a chat change or a
// generation leaves the button greyed out when the page loads with a chat
// already open, until the reader leaves and comes back or sends a message. A
// message rendering is what happens when a chat opens, and it carries the id.
console.log("\nthe per-chat switch finds the chat");
{
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  await stage(page, "<div id=modal></div>");
  await page.addStyleTag({ content: THEME });
  await page.addScriptTag({ content: SOURCE, type: "module" });
  await page.waitForFunction(() => !!window.__setup);
  const out = await page.evaluate(async () => {
    const frame = () =>
      new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const handlers = {};
    const acts = {};
    const teardown = window.__setup(
      { events: { on: (n, fn) => { handlers[n] = fn; return () => {}; } },
        ui: { showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
              registerInputBarAction: (o) => {
                const a = { onClick: (cb) => { a.cb = cb; return () => {}; }, destroy: () => {} };
                acts[o.id] = a; return a; } } },
      { toast: false },
    );
    const row = () => document.querySelector("[data-ar-chat-switch]");
    const act = () => row() && row().querySelector("button");
    const state = () => ({
      disabled: act() ? !!act().disabled : null,
      label: act() ? act().textContent.trim() : "",
      note: row() ? (row().textContent || "") : "",
    });

    // The panel is opened having seen nothing at all, which is a fresh load.
    acts["auto-retry-settings"].cb();
    await frame();
    const cold = state();

    // A message renders, which is what happens when a chat is simply open.
    // No CHAT_CHANGED, no generation: this is the case that can stay grey.
    handlers.CHARACTER_MESSAGE_RENDERED &&
      handlers.CHARACTER_MESSAGE_RENDERED({ chatId: "chat-a", messageId: "m1" });
    await frame();
    const afterRender = state();

    // And it still works: switching off names this chat, not another.
    if (act() && !act().disabled) act().click();
    await frame();
    const afterClick = state();

    // Moving to another chat resets the row rather than carrying the state over.
    handlers.CHAT_CHANGED && handlers.CHAT_CHANGED({ chatId: "chat-b" });
    await frame();
    const otherChat = state();

    // Back to the home screen, where there is no chat to switch.
    handlers.CHAT_SWITCHED && handlers.CHAT_SWITCHED({ chatId: null });
    await frame();
    const noChat = state();

    teardown();
    return { cold, afterRender, afterClick, otherChat, noChat };
  });
  await page.close();
  check("with nothing seen yet it says it is waiting, not that you should open a chat",
    out.cold.disabled === true &&
      /waiting to find out which chat/i.test(out.cold.note) &&
      !/open a chat/i.test(out.cold.note), out.cold);
  check("a rendered message is enough to wake it up",
    out.afterRender.disabled === false && /turn off here/i.test(out.afterRender.label), out.afterRender);
  check("and it still switches that chat off",
    /turn on here/i.test(out.afterClick.label), out.afterClick);
  check("another chat starts from on again",
    out.otherChat.disabled === false && /turn off here/i.test(out.otherChat.label), out.otherChat);
  check("and the home screen has nothing to switch",
    out.noChat.disabled === true, out.noChat);
  // No backend in this fixture at all, so this is the host's own word for it.
  // It is as good an answer as the backend's and reads the same way.
  check("and the host saying so is enough for it to say there is no chat",
    /no chat is open/i.test(out.noChat.note), out.noChat.note);
  check("no console errors", errors.length === 0, errors);
}

// ---- the reply a retry threw away is still gettable ----
// Keeping the old reply as a reroll is protection that something else can
// undo: the reader can tidy their rerolls away, and an extension whose whole
// job is tidying them will. So the extension keeps its own copy, which nothing
// outside this tab can reach, and puts it on a tab of its own.
console.log("\nthe reply a retry threw away");
{
  const errors = [];
  const REPLY = "She set the lantern down on the step and looked back at the road one last time.";
  const run = async (opts) => {
    const page = await browser.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await stage(page, '<div id=modal></div><button data-testid="regenerate">R</button><button data-testid="swipe-right">S</button>');
    await page.addScriptTag({ content: SOURCE, type: "module" });
    await page.waitForFunction(() => !!window.__setup);
    const res = await page.evaluate(async ([opts, REPLY]) => {
      const h = {}, acts = {};
      window.__setup(
        { events: { on: (n, f) => { h[n] = f; return () => {}; } },
          ui: { showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
                registerInputBarAction: (o) => { const a = { onClick: (cb) => { a.cb = cb; return () => {}; }, destroy: () => {} }; acts[o.id] = a; return a; } } },
        Object.assign({ toast: false, retryDelayMs: 5, backoffFactor: 1, maxDelayMs: 5, jitter: false,
          maxRetries: 4, stuckTimeoutMs: 0, idleTimeoutMs: 0, pauseWhenFailing: false,
          liveLog: true, retryOnShort: true, minChars: 4000 }, opts),
      );
      // A reply that is fine to read but too short for the reader's setting, so
      // it is thrown away for a reason that names itself.
      h.GENERATION_STARTED({ chatId: "c1", generationId: "g1" });
      h.STREAM_TOKEN_RECEIVED({ chatId: "c1", generationId: "g1", content: REPLY });
      h.GENERATION_ENDED({ chatId: "c1", generationId: "g1", content: REPLY });
      await new Promise((r) => setTimeout(r, 120));

      const panel = document.getElementById("__lvRetryLog");
      const tab = panel && [...panel.querySelectorAll('[role="tab"]')]
        .find((b) => b.textContent.trim() === "Replaced");
      if (tab) tab.click();
      await new Promise((r) => setTimeout(r, 60));
      const body = document.getElementById("__lvRetryLogBody");
      return {
        hasTab: !!tab,
        shown: body ? body.innerText : "",
      };
    }, [opts, REPLY]);
    await page.close();
    return res;
  };

  const kept = await run({});
  const off = await run({ keepReplaced: false });

  check("the panel has a tab for it", kept.hasTab === true, kept);
  check("the reply that was thrown away is on it", kept.shown.indexOf(REPLY) >= 0, kept.shown.slice(0, 120));
  // Why it went, so a reader deciding whether they want it back can see what
  // the extension objected to.
  check("and what it was thrown away for", /short/i.test(kept.shown), kept.shown.slice(0, 120));
  check("switched off, it keeps nothing and says so",
    off.shown.indexOf(REPLY) < 0 && /switched off/i.test(off.shown), off.shown.slice(0, 160));

  // Switching it off after something is already held has to drop that too, or
  // the promise is only about replies that had not happened yet.
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await stage(page, '<div id=modal></div><button data-testid="regenerate">R</button><button data-testid="swipe-right">S</button>');
  await page.addScriptTag({ content: SOURCE, type: "module" });
  await page.waitForFunction(() => !!window.__setup);
  const dropped = await page.evaluate(async (REPLY) => {
    const h = {}, acts = {};
    window.__setup(
      { events: { on: (n, f) => { h[n] = f; return () => {}; } },
        ui: { showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
              registerInputBarAction: (o) => { const a = { onClick: (cb) => { a.cb = cb; return () => {}; }, destroy: () => {} }; acts[o.id] = a; return a; } } },
      { toast: false, retryDelayMs: 5, backoffFactor: 1, maxDelayMs: 5, jitter: false,
        maxRetries: 4, stuckTimeoutMs: 0, idleTimeoutMs: 0, pauseWhenFailing: false,
        liveLog: true, retryOnShort: true, minChars: 4000 },
    );
    h.GENERATION_STARTED({ chatId: "c1", generationId: "g1" });
    h.STREAM_TOKEN_RECEIVED({ chatId: "c1", generationId: "g1", content: REPLY });
    h.GENERATION_ENDED({ chatId: "c1", generationId: "g1", content: REPLY });
    await new Promise((r) => setTimeout(r, 120));
    const show = () => {
      const panel = document.getElementById("__lvRetryLog");
      const tab = panel && [...panel.querySelectorAll('[role="tab"]')]
        .find((b) => b.textContent.trim() === "Replaced");
      if (tab) tab.click();
      const body = document.getElementById("__lvRetryLogBody");
      return body ? body.innerText : "";
    };
    const held = show();
    // Turn it off in the panel and press Save, the way a reader would.
    acts["auto-retry-settings"].cb();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const row = document.querySelector('[data-ar-row="keepReplaced"]');
    const box = row && row.querySelector('input[type="checkbox"]');
    if (box && box.checked) box.click();
    const save = [...document.querySelectorAll("button")]
      .find((b) => b.textContent.trim() === "Save");
    if (save) save.click();
    await new Promise((r) => setTimeout(r, 80));
    return { held, after: show(), flipped: !!box && !box.checked, saved: !!save };
  }, REPLY);
  await page.close();
  check("the check really turned it off and saved",
    dropped.flipped && dropped.saved, dropped);
  check("it was holding the reply first", dropped.held.indexOf(REPLY) >= 0, dropped.held.slice(0, 120));
  check("and switching it off drops what was already held",
    dropped.after.indexOf(REPLY) < 0, dropped.after.slice(0, 160));
  // A generation Lumiverse names no chat for still has its reply kept, and kept
  // somewhere the tab can find again. The store was filed under the sentinel
  // and read back under the empty string, so this was the one case where the
  // reply went in and never came out.
  const noChat = await page2NoChat(browser, REPLY, errors);
  check("a chat with no id of its own keeps its reply too", noChat === true, noChat);

  check("no console errors", errors.length === 0, errors);
}

// One page, one generation carrying no chatId anywhere.
async function page2NoChat(browser, REPLY, errors) {
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await stage(page, '<div id=modal></div><button data-testid="regenerate">R</button><button data-testid="swipe-right">S</button>');
  await page.addScriptTag({ content: SOURCE, type: "module" });
  await page.waitForFunction(() => !!window.__setup);
  const out = await page.evaluate(async (REPLY) => {
    const h = {}, acts = {};
    window.__setup(
      { events: { on: (n, f) => { h[n] = f; return () => {}; } },
        ui: { showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
              registerInputBarAction: (o) => { const a = { onClick: (cb) => { a.cb = cb; return () => {}; }, destroy: () => {} }; acts[o.id] = a; return a; } } },
      { toast: false, retryDelayMs: 5, backoffFactor: 1, maxDelayMs: 5, jitter: false, maxRetries: 4,
        stuckTimeoutMs: 0, idleTimeoutMs: 0, pauseWhenFailing: false, liveLog: true,
        retryOnShort: true, minChars: 4000 },
    );
    h.GENERATION_STARTED({ generationId: "g1" });
    h.STREAM_TOKEN_RECEIVED({ generationId: "g1", content: REPLY });
    h.GENERATION_ENDED({ generationId: "g1", content: REPLY });
    await new Promise((r) => setTimeout(r, 150));
    const panel = document.getElementById("__lvRetryLog");
    const tab = panel && [...panel.querySelectorAll('[role="tab"]')]
      .find((b) => b.textContent.trim() === "Replaced");
    if (tab) tab.click();
    const body = document.getElementById("__lvRetryLogBody");
    return (body ? body.innerText : "").indexOf(REPLY) >= 0;
  }, REPLY);
  await page.close();
  return out;
}

// ---- the swipe default reaches people who already had settings ----
// Saving writes every setting, at its default or not, so a copy saved before
// swiping became the preferred retry pins the old behaviour. Anyone who had
// ever pressed Save would have gone on regenerating, which is the one that can
// take a good reply away, and would never have seen the change.
//
// Turned on once, and once only: turning it back off afterwards has to stick.
// Read off which button a retry actually clicks, because the switch is applied
// to the settings in memory and the stored copy only changes when Save is
// pressed, so reading storage back would prove nothing either way.
console.log("\nturning swiping on for people who already had settings");
{
  const errors = [];
  const OLD = { retryByNewReroll: false, maxRetries: 4, minChars: 24 };
  const run = async (seed, clearMark) => {
    const c = await browser.newContext();
    const page = await c.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("**/*", (r) => r.fulfill({ contentType: "text/html", body:
      '<!doctype html><meta charset=utf-8><div id=modal></div>' +
      '<button data-testid="regenerate">R</button><button data-testid="swipe-right">S</button>' }));
    await page.goto("http://lumiverse.test/");
    await page.addScriptTag({ content: SOURCE, type: "module" });
    await page.waitForFunction(() => !!window.__setup);
    const res = await page.evaluate(async ([seed, clearMark]) => {
      const KEY = "lv-auto-retry:settings:v1", MARK = "lv-auto-retry:swipe-first:v1";
      if (clearMark) localStorage.removeItem(MARK);
      else localStorage.setItem(MARK, "1");
      localStorage.setItem(KEY, JSON.stringify(seed));
      const h = {}; const hits = [];
      for (const id of ["regenerate", "swipe-right"])
        document.querySelector("[data-testid=" + id + "]").addEventListener("click", () => hits.push(id));
      window.__setup(
        { events: { on: (n, f) => { h[n] = f; return () => {}; } },
          ui: { showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
                registerInputBarAction: () => ({ onClick: () => () => {}, destroy: () => {} }) } },
        { toast: false, retryDelayMs: 5, backoffFactor: 1, maxDelayMs: 5, jitter: false,
          stuckTimeoutMs: 0, idleTimeoutMs: 0, pauseWhenFailing: false },
      );
      h.GENERATION_STARTED({ chatId: "c1", generationId: "g1" });
      h.GENERATION_ENDED({ chatId: "c1", generationId: "g1", error: "boom" });
      await new Promise((r) => setTimeout(r, 200));
      return { clicked: hits[0] || null, marked: !!localStorage.getItem(MARK),
               stillStored: JSON.parse(localStorage.getItem(KEY)).minChars };
    }, [seed, clearMark]);
    await c.close();
    return res;
  };

  const migrated = await run(OLD, true);
  const chosen = await run(OLD, false);
  check("an old saved copy retries by swiping now", migrated.clicked === "swipe-right", migrated);
  check("and the once is written down", migrated.marked === true, migrated);
  // Without the marker this would turn itself back on at every reload and the
  // setting would be unusable for anyone who wants the old behaviour.
  check("turning it back off sticks", chosen.clicked === "regenerate", chosen);
  // The settings are read before most of the extension exists. A key declared
  // too late throws in there, and the catch around it hands back an empty
  // object, which loses every saved setting without a word.
  check("and the rest of the saved settings survived being read",
    migrated.stillStored === 24 && chosen.stillStored === 24, [migrated, chosen]);
  check("no console errors", errors.length === 0, errors);
}

// ---- a good reply is never re-rolled out from under the reader ----
// Everything here is a way a finished reply that was fine got thrown away. A
// reader lost one after nineteen tries, on a cap set far below that, so these
// cover both halves: not re-rolling what is fine, and not letting the count of
// tries come loose from what it is supposed to limit.
console.log("\nkeeping a reply that was fine");
{
  const errors = [];
  const REPLY = "She set the lantern down on the step and looked back at the road, and the dog followed her in.";

  // A generation runs because something clicked, and comes back the way the
  // host would report it. Nothing is fed in that a real build would not send.
  const loop = async (mode) => {
    const page = await browser.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await stage(page, '<div id=modal></div><button data-testid="regenerate">R</button>');
    await page.addScriptTag({ content: SOURCE, type: "module" });
    await page.waitForFunction(() => !!window.__setup);
    const res = await page.evaluate(async (mode) => {
      const h = {}; let clicks = 0, gen = 0;
      const bad = (id) => h.GENERATION_ENDED({ chatId: "c1", generationId: id, error: "boom" });
      document.querySelector('[data-testid="regenerate"]').addEventListener("click", () => {
        clicks++;
        if (clicks > 40) return; // the harness's own runaway guard
        const id = "g" + (++gen);
        setTimeout(() => {
          h.GENERATION_STARTED({ chatId: "c1", generationId: id });
          setTimeout(() => {
            bad(id);
            if (mode === "doubleEnd") setTimeout(() => bad(id), 5);
          }, 5);
        }, 5);
      });
      window.__setup(
        { events: { on: (n, f) => { h[n] = f; return () => {}; } },
          ui: { showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
                registerInputBarAction: () => ({ onClick: () => () => {}, destroy: () => {} }) } },
        { toast: false, retryDelayMs: 5, backoffFactor: 1, maxDelayMs: 5, jitter: false,
          maxRetries: 2, stuckTimeoutMs: 0, idleTimeoutMs: 0, pauseWhenFailing: false },
      );
      h.GENERATION_STARTED({ chatId: "c1", generationId: "g0" });
      bad("g0");
      await new Promise((r) => setTimeout(r, 1500));
      return { clicks };
    }, mode);
    await page.close();
    return res;
  };

  const plain = await loop("ordinary");
  const twice = await loop("doubleEnd");
  check("two tries means two tries", plain.clicks === 2, plain);
  // Giving up hands the budget back so the reader's next reply starts fresh.
  // A second ending for the same generation landed after that and took the
  // fresh budget with it, so the cap never held and it ran until something
  // else stopped it.
  check("and still two when the host reports one ending twice",
    twice.clicks === 2, twice);

  // A reply that streamed and is sitting there finished, described three ways
  // by the ending that follows it.
  const ending = async (endPayload) => {
    const page = await browser.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await stage(page, '<div id=modal></div><button data-testid="regenerate">R</button><button data-testid="swipe-right">S</button>');
    await page.addScriptTag({ content: SOURCE, type: "module" });
    await page.waitForFunction(() => !!window.__setup);
    const res = await page.evaluate(async ([endPayload, REPLY]) => {
      const h = {}; let clicks = 0;
      for (const id of ["regenerate", "swipe-right"])
        document.querySelector("[data-testid=" + id + "]").addEventListener("click", () => clicks++);
      window.__setup(
        { events: { on: (n, f) => { h[n] = f; return () => {}; } },
          ui: { showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
                registerInputBarAction: () => ({ onClick: () => () => {}, destroy: () => {} }) } },
        { toast: false, retryDelayMs: 5, backoffFactor: 1, maxDelayMs: 5, jitter: false,
          maxRetries: 2, stuckTimeoutMs: 0, idleTimeoutMs: 0, pauseWhenFailing: false },
      );
      h.GENERATION_STARTED({ chatId: "c1", generationId: "g1" });
      h.STREAM_TOKEN_RECEIVED({ chatId: "c1", generationId: "g1", content: REPLY });
      h.GENERATION_ENDED(Object.assign({ chatId: "c1", generationId: "g1" }, endPayload));
      await new Promise((r) => setTimeout(r, 250));
      return { clicks };
    }, [endPayload, REPLY]);
    await page.close();
    return res;
  };

  const carried = await ending({ content: REPLY });
  const silent = await ending({});
  const blank = await ending({ content: "" });
  check("an ending that carries the reply leaves it alone", carried.clicks === 0, carried);
  check("an ending that carries no text at all leaves it alone", silent.clicks === 0, silent);
  // The one that bit. An empty string is a build saying nothing useful, not a
  // build saying the reply was empty, and the reader is looking at the text.
  check("an ending that reports an empty string leaves it alone too",
    blank.clicks === 0, blank);

  check("no console errors", errors.length === 0, errors);
}

// ---- a retry never clicks the extension's own panel ----
// The button selectors are patterns, not addresses, and the extension's own
// settings are called things like "Retry by adding a new reroll", so its own
// description button for that row matches the built-in swipe pattern exactly.
// With the panel open a retry opened a description instead of retrying, and
// the reader watching the log saw the extension do nothing at all.
//
// Three guards were written for this already, all keyed on an id nothing ever
// set, so all three were doing nothing. The panel is opened here and left
// open, which is what somebody watching the log does.
console.log("\na retry never clicks the extension's own panel");
{
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await stage(page, '<div id=modal></div><button data-testid="regenerate">Regenerate</button>');
  await page.addScriptTag({ content: SOURCE, type: "module" });
  await page.waitForFunction(() => !!window.__setup);
  const out = await page.evaluate(async () => {
    const h = {}, acts = {};
    let clicks = 0;
    document.querySelector('[data-testid="regenerate"]').addEventListener("click", () => clicks++);
    window.__setup(
      { events: { on: (n, f) => { h[n] = f; return () => {}; } },
        ui: { showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
              registerInputBarAction: (o) => { const a = { onClick: (cb) => { a.cb = cb; return () => {}; }, destroy: () => {} }; acts[o.id] = a; return a; } } },
      { toast: false, retryDelayMs: 10, backoffFactor: 1, maxDelayMs: 10, jitter: false,
        maxRetries: 4, stuckTimeoutMs: 0, idleTimeoutMs: 0, pauseWhenFailing: false },
    );
    acts["auto-retry-settings"].cb();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    for (const hdr of document.querySelectorAll('[role="button"][aria-expanded="false"]')) hdr.click();
    await new Promise((r) => setTimeout(r, 60));

    // The panel really does hold something the built-in swipe pattern matches,
    // so this cannot pass by the trap having quietly gone away.
    const SWIPE = '[aria-label="Next swipe"], [data-action="swipe-right"], [data-testid="swipe-right"], ' +
      'button[aria-label*="next swipe" i], button[aria-label*="swipe right" i], ' +
      'button[aria-label*="reroll" i], button[title*="swipe" i]';
    const trap = [...document.querySelectorAll(SWIPE)].filter((e) => e.closest("#modal")).length;

    const before = clicks;
    h.GENERATION_STARTED({ chatId: "B", generationId: "b1" });
    await new Promise((r) => setTimeout(r, 10));
    h.GENERATION_ENDED({ chatId: "B", generationId: "b1", error: "boom" });
    await new Promise((r) => setTimeout(r, 250));
    return { trap, retried: clicks > before, ownUiMarked: !!document.querySelector("[data-ar-ui]") };
  });
  await page.close();
  check("the panel holds something the swipe pattern matches",
    out.trap > 0, out.trap);
  check("and the retry goes to the host's button, not that one",
    out.retried === true, out);
  check("the extension marks what it owns", out.ownUiMarked === true, out);
  check("no console errors", errors.length === 0, errors);
}

// ---- a reply that stopped partway is a cut-off reply ----
// Two different things look like "words were appearing and then stopped", and
// only one of them belongs to the watchdog that watches for it.
//
// Nothing readable arrived: the generation died on its way out, there is
// nothing to lose, and re-rolling it is the whole point of the watchdog.
//
// Real text arrived and then stopped: what the reader has is a reply cut off
// partway, and whether to re-roll one of those is already a setting. Aborting
// regardless went over that setting's head and threw away writing that was
// really there, which is what a reader hit after switching off the one option
// that named what they were seeing.
console.log("\na reply that stopped partway with text in it");
{
  const errors = [];
  const run = async (opts, streamText) => {
    const page = await browser.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await stage(page,
      '<div id=modal></div><button data-testid="regenerate">R</button>' +
      '<button data-testid="swipe-right">S</button><button data-testid="stop">X</button>');
    await page.addScriptTag({ content: SOURCE, type: "module" });
    await page.waitForFunction(() => !!window.__setup);
    const res = await page.evaluate(async ([opts, streamText]) => {
      const h = {};
      const clicks = [];
      for (const id of ["regenerate", "swipe-right", "stop"])
        document.querySelector("[data-testid=" + id + "]")
          .addEventListener("click", () => clicks.push(id));
      window.__setup(
        { events: { on: (n, fn) => { h[n] = fn; return () => {}; } },
          sendToBackend: () => {},
          onBackendMessage: () => () => {},
          ui: { showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
                registerInputBarAction: () => ({ onClick: () => () => {}, destroy: () => {} }) } },
        Object.assign({ retryDelayMs: 10, backoffFactor: 1, maxDelayMs: 10, jitter: false,
          maxRetries: 4, toast: false, pauseWhenFailing: false,
          stuckTimeoutMs: 0, idleTimeoutMs: 120 }, opts),
      );
      h.GENERATION_STARTED({ chatId: "c1", generationId: "g1" });
      // Text arrives, then the stream goes quiet without ever ending.
      h.STREAM_TOKEN_RECEIVED({ chatId: "c1", generationId: "g1", content: streamText });
      await new Promise((r) => setTimeout(r, 400));
      return { clicks };
    }, [opts, streamText]);
    await page.close();
    return res;
  };

  const REAL = "She set the lantern down on the step and looked back at the road, half expecting";
  const withText = await run({ retryOnTruncated: false }, REAL);
  const withTextOn = await run({ retryOnTruncated: true }, REAL);
  // Content-shaped events that carried nothing. sawContent is true for these
  // too, so reading the flag rather than the text would call this a cut-off
  // reply and leave a dead generation sitting there.
  const noText = await run({ retryOnTruncated: false }, "");

  check("with cut-off replies switched off, a reply that stopped partway is left alone",
    withText.clicks.length === 0, withText);
  check("with them switched on it is still re-rolled",
    withTextOn.clicks.indexOf("stop") >= 0 && withTextOn.clicks.length > 1, withTextOn);
  check("and a generation that produced nothing readable is re-rolled either way",
    noText.clicks.indexOf("stop") >= 0 && noText.clicks.length > 1, noText);
  // What the reader loses if this is wrong. A swipe keeps the reply that was
  // there; a regenerate is the one that can take it away.
  check("a retry adds a reroll rather than redoing the reply in place",
    withTextOn.clicks.indexOf("swipe-right") >= 0 &&
      withTextOn.clicks.indexOf("regenerate") < 0, withTextOn);

  check("no console errors", errors.length === 0, errors);
}

// ---- telling the backend again after it restarts ----
// The backend keeps the word swap rules, the on and off switch, and the list of
// chats the reader turned Auto Retry off in. All three arrived over the bridge
// and none of them survives the backend coming back, which happens on its own:
// a tab closed and opened again is enough. It cannot look them up either, since
// its own read runs before it knows whose settings to read.
//
// So the swaps stopped and nothing said why, and a chat switched off started
// being swapped again. It says backend_ready when it comes up, and this is the
// panel answering that.
console.log("\ntelling the backend again after it restarts");
{
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await stage(page, "<div id=modal></div>");
  await page.addScriptTag({ content: SOURCE, type: "module" });
  await page.waitForFunction(() => !!window.__setup);
  const out = await page.evaluate(async () => {
    const sent = [];
    const backs = [];
    const onBack = (m) => { for (const fn of backs.slice()) fn(m); };
    window.__setup(
      {
        events: { on: () => () => {} },
        sendToBackend: (m) => sent.push(m),
        // Every listener, not the last one. The extension registers several and
        // opening the panel adds more, so keeping one drops the handler under
        // test. The host delivers to all of them, and so does this.
        onBackendMessage: (fn) => { backs.push(fn); return () => {}; },
        ui: {
          showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
          registerInputBarAction: () => ({ onClick: () => () => {}, destroy: () => {} }),
        },
      },
      { refusalNote: true, refusalExtraPhrases: "lantern => lamp", toast: false },
    );
    await new Promise((r) => setTimeout(r, 60));
    const types = () => sent.map((m) => m && m.type);
    const atStart = types();
    sent.length = 0;
    // The backend comes back up and announces itself.
    onBack({ type: "backend_ready" });
    await new Promise((r) => setTimeout(r, 60));
    const afterRestart = types();
    const settings = sent.find((m) => m && m.type === "set_settings");
    return {
      atStart,
      afterRestart,
      rulesSent: settings ? settings.settings.refusalExtraPhrases : null,
      swapOn: settings ? settings.settings.refusalNote : null,
    };
  });
  await page.close();

  check("the backend is armed when the panel starts",
    out.atStart.indexOf("set_settings") >= 0 && out.atStart.indexOf("set_chats_off") >= 0,
    out.atStart);
  check("a restart gets the settings again",
    out.afterRestart.indexOf("set_settings") >= 0, out.afterRestart);
  check("and the chats switched off with them",
    out.afterRestart.indexOf("set_chats_off") >= 0, out.afterRestart);
  check("the rules really go, not an empty object",
    out.rulesSent === "lantern => lamp" && out.swapOn === true,
    [out.rulesSent, out.swapOn]);
  // Coming back up is not a reason to write to the account: the stored copy is
  // already right, and another device may be saving over it at the same moment.
  check("nothing is written to the account over it",
    out.afterRestart.indexOf("save_settings") < 0, out.afterRestart);
  check("no console errors", errors.length === 0, errors);
}

// An edit in the open panel changes the settings as it is typed and is rolled
// back if the panel is dismissed. A restart landing in the middle of that would
// hand the backend the edit, which then runs on a setting nobody saved, and
// goes on running on it after the reader closes the panel on it.
console.log("\na restart while the panel has unsaved edits");
{
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await stage(page, "<div id=modal></div>");
  await page.addScriptTag({ content: SOURCE, type: "module" });
  await page.waitForFunction(() => !!window.__setup);
  const out = await page.evaluate(async () => {
    const frame = () =>
      new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const sent = [];
    const backs = [];
    const onBack = (m) => { for (const fn of backs.slice()) fn(m); };
    let openPanel = null;
    window.__setup(
      {
        events: { on: () => () => {} },
        sendToBackend: (m) => sent.push(m),
        // Every listener, not the last one. The extension registers several and
        // opening the panel adds more, so keeping one drops the handler under
        // test. The host delivers to all of them, and so does this.
        onBackendMessage: (fn) => { backs.push(fn); return () => {}; },
        ui: {
          showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
          registerInputBarAction: () => {
            const a = { onClick: (cb) => { openPanel = cb; return () => {}; }, destroy: () => {} };
            return a;
          },
        },
      },
      { refusalNote: false, refusalExtraPhrases: "lantern => lamp", toast: false },
    );
    openPanel();
    await frame();
    // Tick "Send a note with a refusal retry" and do not press Save.
    const root = document.getElementById("modal");
    let ticked = false;
    for (const box of root.querySelectorAll("input[type=checkbox]")) {
      const row = box.closest("[data-ar-row]");
      if (row && /Send a note with a refusal retry/.test(row.textContent)) {
        box.click();
        ticked = true;
        break;
      }
    }
    await frame();
    sent.length = 0;
    onBack({ type: "backend_ready" });
    await frame();
    const msg = sent.find((m) => m && m.type === "set_settings");
    return { ticked, swapOn: msg ? msg.settings.refusalNote : "no message" };
  });
  await page.close();

  check("the box really was ticked", out.ticked, out);
  check("the backend is told what was saved, not what is being typed",
    out.swapOn === false, out.swapOn);
  check("no console errors", errors.length === 0, errors);
}

// ---- the sub-headings on a small phone ----
// The headings that break the long sections up are 11px uppercase with letter
// spacing, which is the widest way to set a short line. On a narrow screen a
// heading that wraps to two lines reads as two headings, and one that runs off
// the side takes the panel's scrollbar sideways with it. Measured at 320px,
// which is the narrowest phone still in use, with every section opened so the
// ones inside a shut section are measured too.
console.log("\nthe sub-headings on a small phone");
{
  const HEADINGS = [
    "When it gives up",
    "How long it waits between tries",
    "Replies that freeze",
    "What counts as one",
    "Wording you supply",
    "How far it looks",
    "For the whole list",
  ];
  const at = async (viewport, touch) => {
    const { out, errors } = await inPanel(
      browser,
      // Both switches on, or the rows these headings cover are hidden and a
      // heading with nothing under it measures zero high and proves nothing.
      { viewport, touch, settings: { retryOnRefusal: true, refusalNote: true } },
      (page) =>
        page.evaluate(async (wanted) => {
          const frame = () =>
            new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          for (const h of document.querySelectorAll('[role="button"][aria-expanded="false"]'))
            h.click();
          await frame();
          const root = document.getElementById("modal");
          const scroller = root.querySelector("div[style*='overflow-y']");
          const right = scroller.getBoundingClientRect().right;
          const rows = [];
          root.querySelectorAll("div").forEach((d) => {
            const t = (d.textContent || "").trim();
            if (wanted.indexOf(t) < 0 || rows.some((r) => r.text === t)) return;
            const cs = getComputedStyle(d);
            const r = d.getBoundingClientRect();
            const note = d.nextElementSibling;
            const nr = note ? note.getBoundingClientRect() : null;
            rows.push({
              text: t,
              lines: Math.round(r.height / parseFloat(cs.lineHeight || cs.fontSize)),
              size: parseFloat(cs.fontSize),
              over: Math.round(Math.max(r.right - right, nr ? nr.right - right : 0)),
            });
          });
          const label = root.querySelector("[data-ar-row] span");
          return {
            rows,
            panel: Math.round(scroller.getBoundingClientRect().width),
            sideways: scroller.scrollWidth - scroller.clientWidth,
            page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            labelSize: label ? parseFloat(getComputedStyle(label).fontSize) : 0,
          };
        }, HEADINGS),
    );
    return { ...out, errors };
  };

  const phone = await at({ width: 320, height: 568 }, true);
  const desk = await at({ width: 1280, height: 900 }, false);

  // If this ever reads near 980 the page has lost its viewport meta and the
  // rest of this block is measuring a desktop layout.
  check("the phone really is laid out as a phone", phone.panel < 340, phone.panel);
  check("every heading is there to measure",
    phone.rows.length === HEADINGS.length,
    phone.rows.map((r) => r.text));
  check("none of them wraps to a second line",
    phone.rows.every((r) => r.lines === 1),
    phone.rows.filter((r) => r.lines !== 1));
  check("none of them runs off the side",
    phone.rows.every((r) => r.over <= 0),
    phone.rows.filter((r) => r.over > 0));
  check("and the panel does not scroll sideways",
    phone.sideways === 0 && phone.page === 0, [phone.sideways, phone.page]);
  // A heading that reads the same size as the rows under it is not a heading.
  check("a heading is smaller than the rows it covers",
    phone.rows.every((r) => r.size < phone.labelSize),
    [phone.rows[0] && phone.rows[0].size, phone.labelSize]);
  check("the same holds on a desktop",
    desk.rows.length === HEADINGS.length &&
      desk.rows.every((r) => r.lines === 1 && r.over <= 0) &&
      desk.sideways === 0,
    desk);
  check("no console errors",
    phone.errors.length === 0 && desk.errors.length === 0,
    phone.errors.concat(desk.errors));
}

// ---- a reply that arrived with none of its events ----
// Everything the extension knows about a generation comes over Lumiverse's
// socket, and a tab in the background can miss those outright. They are not
// held and redelivered, they are gone. A real report: the generation started,
// nothing else ever arrived, and 180 seconds later it was re-rolled as stuck
// while the finished reply sat on the page.
//
// So the page is checked before a watchdog acts. Staged the way it happened:
// a start event, then silence, while the reply appears in the chat behind it.
console.log("\na reply that arrived with none of its events");
{
  const errors = [];
  // landed is the reply turning up on the page during the silence, which is
  // what a backgrounded tab comes back to.
  const run = async ({ landed }) => {
    const page = await browser.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await stage(page,
      '<div id=modal></div><button data-testid="regenerate">R</button>' +
      '<button data-testid="swipe-right">S</button><button data-testid="stop">X</button>' +
      '<div id=chat><div data-component="MessageContent">Marisol waited by the gate.</div></div>');
    await page.addScriptTag({ content: SOURCE, type: "module" });
    await page.waitForFunction(() => !!window.__setup);
    const res = await page.evaluate(async (landed) => {
      const h = {};
      const clicks = [];
      for (const id of ["regenerate", "swipe-right", "stop"])
        document.querySelector("[data-testid=" + id + "]")
          .addEventListener("click", () => clicks.push(id));
      window.__setup(
        { events: { on: (n, fn) => { h[n] = fn; return () => {}; } },
          sendToBackend: () => {},
          onBackendMessage: () => () => {},
          ui: { showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
                registerInputBarAction: () => ({ onClick: () => () => {}, destroy: () => {} }) } },
        { retryDelayMs: 10, backoffFactor: 1, maxDelayMs: 10, jitter: false,
          maxRetries: 5, toast: false, pauseWhenFailing: false, liveLog: true,
          stuckTimeoutMs: 300, idleTimeoutMs: 0 },
      );
      h.GENERATION_STARTED({ chatId: "c1", generationId: "g1" });
      if (landed) {
        // The reply lands. No token event, no ending: the tab was not there to
        // be told, and nothing repeats it afterwards.
        const el = document.createElement("div");
        el.setAttribute("data-component", "MessageContent");
        el.textContent = landed === "placeholder"
          // What a build that fills the bubble while it waits puts there. Not
          // a reply, and counting it as one would stand the watchdog down on
          // every generation.
          ? "..."
          : "She pushed the gate open and the dogs came running.";
        document.getElementById("chat").appendChild(el);
      }
      await new Promise((r) => setTimeout(r, 600));
      const log = document.getElementById("__lvRetryLog");
      return { clicks, log: log ? log.textContent || "" : "" };
    }, landed);
    await page.close();
    return res;
  };

  const arrived = await run({ landed: true });
  const nothing = await run({ landed: false });
  const holding = await run({ landed: "placeholder" });

  check("a reply the tab was never told about is not re-rolled",
    arrived.clicks.length === 0, arrived.clicks);
  check("and the panel says what happened",
    /never heard it arrive/i.test(arrived.log), arrived.log);
  // The other half, or the guard would just be the stuck watchdog switched off.
  check("a generation that really produced nothing is still re-rolled",
    nothing.clicks.indexOf("stop") >= 0 && nothing.clicks.length > 1, nothing.clicks);
  check("and a bubble holding a placeholder is not mistaken for a reply",
    holding.clicks.indexOf("stop") >= 0 && holding.clicks.length > 1, holding.clicks);

  check("no console errors", errors.length === 0, errors);
}

// ---- a reply that finished while the tab was asleep ----
// A watchdog measures a silence, and it can only do that while the page is
// running. A background tab has its timers held back, and a tab the browser
// freezes runs nothing at all and then delivers everything at once when the
// reader comes back. The watchdog then comes due on a generation whose ending
// is still queued behind it, halts a reply that had finished, and re-rolls it.
// Leaving the tab and coming back was enough to lose one.
//
// A frozen tab cannot be staged here, but what it looks like from inside the
// page can: the clock jumps forward while a timer is pending, so the timer
// comes back long after it asked to. That is the whole signal the guard reads.
console.log("\na reply that finished while the tab was asleep");
{
  const errors = [];
  // jumpMs is how far the clock moves while the stuck watchdog is pending.
  // endAfter, when set, is a reply arriving normally once the page is running
  // again, which is the case the reader hit.
  const run = async ({ jumpMs, endAfter }) => {
    const page = await browser.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await stage(page,
      '<div id=modal></div><button data-testid="regenerate">R</button>' +
      '<button data-testid="swipe-right">S</button><button data-testid="stop">X</button>');
    await page.addScriptTag({ content: SOURCE, type: "module" });
    await page.waitForFunction(() => !!window.__setup);
    const res = await page.evaluate(async ([jumpMs, endAfter]) => {
      const h = {};
      const clicks = [];
      const lines = [];
      for (const id of ["regenerate", "swipe-right", "stop"])
        document.querySelector("[data-testid=" + id + "]")
          .addEventListener("click", () => clicks.push(id));
      window.__setup(
        { events: { on: (n, fn) => { h[n] = fn; return () => {}; } },
          sendToBackend: () => {},
          onBackendMessage: () => () => {},
          ui: { showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
                registerInputBarAction: () => ({ onClick: () => () => {}, destroy: () => {} }) } },
        { retryDelayMs: 10, backoffFactor: 1, maxDelayMs: 10, jitter: false,
          maxRetries: 4, toast: false, pauseWhenFailing: false, liveLog: true,
          stuckTimeoutMs: 400, idleTimeoutMs: 0 },
      );
      const readLog = () => {
        const el = document.getElementById("__lvRetryLog");
        return el ? el.textContent || "" : "";
      };
      h.GENERATION_STARTED({ chatId: "c1", generationId: "g1", messageId: "m1" });
      // The page stops running here. From inside, that is the clock moving on
      // while nothing of ours got to run.
      const realNow = Date.now;
      if (jumpMs) Date.now = () => realNow.call(Date) + jumpMs;
      // Long enough for the watchdog to come due late, and short of the fresh
      // wait it starts in place of judging.
      await new Promise((r) => setTimeout(r, 500));
      Date.now = realNow;
      lines.push(readLog());
      const afterSleep = clicks.slice();
      if (endAfter) {
        // Awake again, and the ending that was queued behind the watchdog
        // finally arrives, well inside the fresh wait.
        h.GENERATION_ENDED({ chatId: "c1", generationId: "g1", messageId: "m1",
          content: "Marisol pushed the door open and the cold came in with her." });
      }
      // Past the point the fresh wait would have run out, so a watchdog still
      // armed on a reply that has ended would have shown itself by now.
      await new Promise((r) => setTimeout(r, 600));
      return { afterSleep, clicks, log: lines.join(" ") };
    }, [jumpMs, endAfter]);
    await page.close();
    return res;
  };

  const slept = await run({ jumpMs: 60000, endAfter: true });
  const awake = await run({ jumpMs: 0, endAfter: false });

  check("a reply is not halted over a wait the page slept through",
    slept.afterSleep.length === 0, slept.afterSleep);
  check("and the ending that was queued behind it is taken normally",
    slept.clicks.length === 0, slept.clicks);
  check("the panel says why the wait started again",
    /asleep for part of the wait/i.test(slept.log), slept.log);
  // The other half. A guard that simply switched the watchdog off would pass
  // both checks above and leave a genuinely stuck reply sitting there.
  check("a page that stayed awake still catches a stuck reply",
    awake.clicks.indexOf("stop") >= 0 && awake.clicks.length > 1, awake.clicks);

  check("no console errors", errors.length === 0, errors);
}

// ---- walking out of a chat without the host saying so ----
// The id the row shows is learned from things happening in a chat: a reply, a
// message rendering, a switch event. Going to the home screen is none of those,
// and on a build that says nothing when you leave, the row went on naming the
// chat you had walked away from and offering to switch Auto Retry off in it.
//
// Opening the panel asks outright now, so the answer is what the row shows.
// The stub answers from __cur, which is what the host would be asked, and
// resolved stays true throughout: a backend that could look and found no chat
// open is a different answer from one that could not look, and only the first
// may clear anything.
console.log("\nleaving a chat with nothing said about it");
{
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  await stage(page, '<div id=modal></div><button data-testid="regenerate">R</button>');
  await page.addScriptTag({ content: SOURCE, type: "module" });
  await page.waitForFunction(() => !!window.__setup);
  const out = await page.evaluate(async () => {
    window.__acts = {}; window.__handlers = {};
    const sent = [], listeners = [];
    const deliver = (m) => listeners.slice().forEach((f) => { try { f(m); } catch (_) {} });
    window.__cur = null;
    window.__canLook = true;
    window.__setup({
      events: { on: (n, f) => { window.__handlers[n] = f; return () => {}; } },
      sendToBackend: (m) => {
        sent.push(m);
        if (m && m.type === "get_active_chat") {
          const id = m.chatId || window.__cur;
          setTimeout(() => deliver({ type: "active_chat", requestId: m.requestId,
            chatId: id, character: id === "c-open" ? "Marisol" : null,
            resolved: window.__canLook, hasCharacter: id === "c-open" }), 0);
        }
      },
      onBackendMessage: (cb) => {
        listeners.push(cb);
        return () => { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); };
      },
      ui: { showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
            registerInputBarAction: (o) => { const a = { onClick: (cb) => { a.cb = cb; return () => {}; }, destroy: () => {} }; window.__acts[o.id] = a; return a; } },
    }, { toast: false, stuckTimeoutMs: 0, idleTimeoutMs: 0 });

    const tick = () => new Promise((r) => setTimeout(r, 80));
    const root = () => document.getElementById("modal");
    const row = () => root().querySelector("[data-ar-chat-switch]");
    const act = () => row() && row().querySelector("button");
    const state = () => ({
      disabled: act() ? !!act().disabled : null,
      label: act() ? act().textContent.trim() : "",
      note: row() ? (row().innerText || "") : "",
    });
    const openPanel = async () => {
      window.__acts["auto-retry-settings"].cb();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      await tick(); await tick();
    };
    const shutPanel = () => {
      const x = [...root().querySelectorAll("button")].find((b) => /^(Close|Done)$/i.test(b.textContent.trim()));
      if (x) x.click();
      root().innerHTML = "";
    };

    const res = {};
    // Nothing known yet, which is a fresh load with the chats permission not
    // answering. Kept apart from the home screen below on purpose.
    window.__canLook = false;
    await openPanel();
    res.cold = state();
    shutPanel();
    window.__canLook = true;

    // In a chat, reached the way a reader reaches one.
    window.__cur = "c-open";
    window.__handlers.CHARACTER_MESSAGE_RENDERED({ chatId: "c-open", messageId: "m1" });
    await tick();
    await openPanel();
    res.inChat = state();
    res.namesTheChat = /Marisol/.test(row() ? row().innerText : "");
    shutPanel();

    // Gone to the home screen. The host says nothing at all about it, which is
    // the whole point: no CHAT_CHANGED, no CHAT_SWITCHED, no generation.
    window.__cur = null;
    const before = sent.filter((m) => m.type === "get_active_chat").length;
    await openPanel();
    res.asked = sent.filter((m) => m.type === "get_active_chat").length > before;
    res.homeScreen = state();
    shutPanel();

    // And the other answer: a backend that could not look must change nothing,
    // or a refused chats permission would grey the row out for everybody.
    window.__cur = "c-open";
    window.__handlers.CHARACTER_MESSAGE_RENDERED({ chatId: "c-open", messageId: "m2" });
    await tick();
    window.__canLook = false;
    window.__cur = null;
    await openPanel();
    res.cannotLook = state();
    return res;
  });
  await page.close();
  check("in a chat the row is live and names it",
    out.inChat.disabled === false && /turn off here/i.test(out.inChat.label) && out.namesTheChat, out.inChat);
  check("opening the panel asks which chat is open, even knowing one already",
    out.asked === true, out.asked);
  check("on the home screen the row has nothing to switch",
    out.homeScreen.disabled === true, out.homeScreen);
  check("and it stops naming the chat you left",
    !/Marisol/.test(out.homeScreen.note), out.homeScreen.note);
  // Being told there is no chat and never having been told anything both grey
  // the row out, and they are not the same thing to read. "Waiting to find out
  // which chat this is" in front of somebody on the home screen describes a
  // fault that is not happening.
  check("and says there is no chat rather than that it is still working it out",
    /no chat is open/i.test(out.homeScreen.note) &&
      !/waiting to find out/i.test(out.homeScreen.note), out.homeScreen.note);
  // The guard on the whole thing. "I could not look" is not "no chat".
  check("a backend that cannot look changes nothing",
    out.cannotLook.disabled === false && /turn off here/i.test(out.cannotLook.label), out.cannotLook);
  check("and having been told nothing still says it is working it out",
    /waiting to find out/i.test(out.cold.note) && !/no chat is open/i.test(out.cold.note), out.cold.note);
  check("no console errors", errors.length === 0, errors);
}

// ---- an answer that lands after you have moved on ----
// Asking which chat is open and asking who a named chat is with are the same
// question over the bridge, told apart by what was asked for. Acting on both
// as if they said "you are here" walked the panel back into a chat the user had
// already left, and the answer to a question nobody answers has to stop
// listening at some point or every switch leaves a handler behind.
console.log("\na late answer cannot drag you back");
{
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  await stage(page, "<div id=modal></div>");
  await page.addStyleTag({ content: THEME });
  await page.addScriptTag({ content: SOURCE, type: "module" });
  await page.waitForFunction(() => !!window.__setup);
  const out = await page.evaluate(async () => {
    const frame = () =>
      new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const handlers = {};
    const acts = {};
    const asked = [];
    // Live listeners, counted rather than collected: one that never drops off
    // is the whole point of this block.
    let live = [];
    const teardown = window.__setup(
      { events: { on: (n, fn) => { handlers[n] = fn; return () => {}; } },
        sendToBackend: (m) => { if (m && m.type === "get_active_chat") asked.push(m); },
        onBackendMessage: (cb) => {
          live.push(cb);
          return () => { live = live.filter((x) => x !== cb); };
        },
        ui: { showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
              registerInputBarAction: (o) => {
                const a = { onClick: (cb) => { a.cb = cb; return () => {}; }, destroy: () => {} };
                acts[o.id] = a; return a; } } },
      { toast: false },
    );
    const answer = (m) => { for (const cb of live.slice()) cb(m); };
    const forChat = (id) => asked.find((m) => m.chatId === id);
    const label = () => {
      const row = document.querySelector("[data-ar-chat-switch]");
      const span = row && row.querySelector("span");
      return span ? (span.textContent || "").trim() : "";
    };

    acts["auto-retry-settings"].cb();
    await frame();

    // In one chat, then away to another before the first answer comes back.
    handlers.CHARACTER_MESSAGE_RENDERED({ chatId: "chat-a", messageId: "m1" });
    await frame();
    handlers.CHARACTER_MESSAGE_RENDERED({ chatId: "chat-b", messageId: "m2" });
    await frame();

    // The answer about the chat left behind arrives now.
    const qa = forChat("chat-a");
    answer({ type: "active_chat", requestId: qa && qa.requestId, chatId: "chat-a", character: "The Archivist" });
    await frame();
    const afterLate = label();

    // And the answer about the chat actually open names it.
    const qb = forChat("chat-b");
    answer({ type: "active_chat", requestId: qb && qb.requestId, chatId: "chat-b", character: "The Cartographer" });
    await frame();
    const afterOwn = label();

    // Handlers do not pile up: five switches, five answers, back where it
    // started. The baseline is whatever the extension keeps registered for the
    // life of the session, which this is not trying to count.
    const base = live.length;
    for (const id of ["c1", "c2", "c3", "c4", "c5"])
      handlers.CHARACTER_MESSAGE_RENDERED({ chatId: id, messageId: id });
    await frame();
    const waiting = live.length;
    for (const id of ["c1", "c2", "c3", "c4", "c5"]) {
      const q = forChat(id);
      answer({ type: "active_chat", requestId: q && q.requestId, chatId: id, character: null });
    }
    await frame();
    const settled = live.length;

    // A question nobody ever answers, left outstanding on the way out.
    handlers.CHARACTER_MESSAGE_RENDERED({ chatId: "c9", messageId: "c9" });
    await frame();
    const pending = live.length;
    teardown();
    await frame();
    return { afterLate, afterOwn, base, waiting, settled, pending, after: live.length,
      askedFor: asked.map((m) => m.chatId) };
  });
  await page.close();
  check("an answer about the chat you left does not become where you are",
    out.afterLate === "This chat", out);
  check("and the answer about the chat you are in still names it",
    out.afterOwn === "This chat, with The Cartographer", out);
  check("each switch asks once", out.waiting === out.base + 5, out);
  check("and each answer takes its handler away", out.settled === out.base, out);
  check("an outstanding question was really left open", out.pending === out.base + 1, out);
  check("teardown drops every handler, answered or not", out.after === 0, out);
  check("no console errors", errors.length === 0, errors);
}

// ---- the per-chat switch has to be reachable ----
// It lived only in the floating button's hold menu, and that button is off by
// default, so on a stock install there was no way to reach it at all.
console.log("\nper-chat switch, in the panel");
{
  const { out, errors } = await inPanel(browser, {}, async (page) =>
    page.evaluate(async () => {
      const row = () => document.querySelector("[data-ar-chat-switch]");
      const act = () => row() && row().querySelector("button");
      const present = !!row();
      // With no chat open there is nothing to switch, and it says so rather
      // than offering a button that would do nothing.
      const noChat = { disabled: act() ? act().disabled : null, text: row() ? row().textContent : "" };
      return { present, noChat, label: act() ? act().textContent.trim() : "" };
    }),
  );
  check("the switch is in the panel, not only behind the floating button", out.present, out);
  check("and is not offered when no chat is open", out.noChat.disabled === true, out.noChat);
  check("saying it is waiting, rather than telling you to do what you have done",
    /waiting to find out which chat/i.test(out.noChat.text) &&
      !/open a chat/i.test(out.noChat.text),
    out.noChat.text.slice(0, 90));
  check("no console errors", errors.length === 0, errors);
}

// ---- the search box stays quiet ----
// It sits alone above the scroll area with nothing beside it to be told apart
// from, and it answers every keystroke by filtering the list underneath, so it
// wears none of the marks the rows below it do.
console.log("\nthe search box stays quiet");
{
  const { out, errors } = await inPanel(browser, {}, async (page) =>
    page.evaluate(async () => {
      const settle = () => new Promise((r) => setTimeout(r, 260));
      const search = document.querySelector('input[type="search"]');
      const row = [...document.querySelectorAll('[data-ar-row] input[type="number"], [data-ar-row] input[type="text"]')]
        .find((el) => el.offsetParent !== null);
      const res = { found: !!search };
      if (!search || !row) return res;
      const rest = getComputedStyle(search).borderTopColor;
      search.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true }));
      await settle();
      res.noHoverLift = getComputedStyle(search).borderTopColor === rest;
      search.focus({ preventScroll: true });
      await settle();
      res.noRing = getComputedStyle(search).boxShadow === "none";
      res.noBorderTint = getComputedStyle(search).borderTopColor === rest;
      search.blur();
      // The rows below still take both, so this is the search box being quiet
      // rather than the marks having come off everything.
      row.focus({ preventScroll: true });
      await settle();
      res.rowsStillMarked = getComputedStyle(row).boxShadow !== "none";
      row.blur();
      return res;
    }),
  );
  check("the search box is there to check", out.found, out);
  check("it does not lift under the pointer", out.noHoverLift, out);
  check("it takes no ring on focus", out.noRing, out);
  check("nor a tinted border", out.noBorderTint, out);
  check("while the rows below it still take both", out.rowsStillMarked, out);
  check("no console errors", errors.length === 0, errors);
}

// ---- the browser's spinner is off our number boxes, and only ours ----
// The arrows a browser draws on a number box are its own, not the theme's, so
// on a dark panel they arrive as grey chevrons belonging to no design here. The
// value is typed and a focused box still steps with the arrow keys.
//
// The rule lives in a stylesheet on the host's page, so the half that matters
// is that it is scoped to an attribute of ours and cannot reach a number box
// belonging to Lumiverse.
console.log("\nthe number box spinner");
{
  const { out, errors } = await inPanel(browser, {}, async (page) => {
    await page.evaluate(async () => {
      for (const h of document.querySelectorAll('[role="button"][aria-expanded="false"]')) h.click();
      // Sections travel open now, so their contents have no height for the
      // length of that. Waited out here rather than in every check below.
      await new Promise((r) => setTimeout(r, 260));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      // A number box the host might have, outside anything of ours.
      const theirs = document.createElement("input");
      theirs.type = "number";
      theirs.id = "not-ours";
      theirs.value = "5";
      document.body.appendChild(theirs);
    });
    return page.evaluate(() => {
      const ours = [...document.querySelectorAll('[data-ar-row] input[type="number"]')]
        .find((el) => el.offsetParent !== null);
      const theirs = document.getElementById("not-ours");
      // Read off the input rather than off the spinner pseudo-element, which
      // reports the same thing for both whether the rule applies or not. The
      // input's own appearance is the rule: textfield is a number box with the
      // browser's arrows suppressed, auto is one that still has them.
      const appearance = (el) => getComputedStyle(el).appearance;
      const res = {};
      res.marked = !!ours && ours.getAttribute("data-ar-num") === "1";
      res.oursHidden = appearance(ours) === "textfield";
      res.theirsUntouched = appearance(theirs) !== "textfield";
      // Still a number box: it steps, and the value still clamps.
      const before = ours.value;
      ours.focus({ preventScroll: true });
      ours.stepUp();
      res.stillSteps = ours.value !== before;
      ours.value = before;
      return res;
    });
  });
  check("our number boxes are marked for the rule", out.marked, out);
  check("and the browser's spinner is off them", out.oursHidden, out);
  check("a number box that is not ours keeps its own", out.theirsUntouched, out);
  check("and ours still steps", out.stillSteps, out);
  check("no console errors", errors.length === 0, errors);
}

// ---- the focus ring ----
// A tinted hairline on its own is easy to lose on a busy theme. The mark is
// that tint plus room around it, in the theme's accent, painted outside the box
// so it can never sit on the text or move the row it is in.
console.log("\nthe focus ring");
{
  const { out, errors } = await inPanel(browser, {}, async (page) => {
    await page.evaluate(async () => {
      for (const h of document.querySelectorAll('[role="button"][aria-expanded="false"]')) h.click();
      // Sections travel open now, so their contents have no height for the
      // length of that. Waited out here rather than in every check below.
      await new Promise((r) => setTimeout(r, 260));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    });
    return page.evaluate(async () => {
      // The ring fades in with the border, so it is read after that has run
      // rather than on the frame focus landed.
      const settle = () => new Promise((r) => setTimeout(r, 260));
      // A visible one. Rows behind a switch are in the DOM but hidden, and a
      // hidden element cannot take focus, so picking the first match found one
      // that could never light up.
      const field = [...document.querySelectorAll('[data-ar-row] input[type="number"], [data-ar-row] input[type="text"]')]
        .find((el) => el.offsetParent !== null);
      const btn = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "Save");
      // Measured against the panel rather than the viewport. Focusing scrolls
      // a field into view, which moves it on screen without anything having
      // been laid out again, and that is not what is being asked here.
      const box = (el) => [el.offsetLeft, el.offsetTop, el.offsetWidth, el.offsetHeight].join(",");
      const res = {};
      res.restNoRing = getComputedStyle(field).boxShadow === "none";
      const before = box(field);
      const rowBefore = box(field.closest("[data-ar-row]"));
      field.focus({ preventScroll: true });
      await settle();
      res.ringOnFocus = getComputedStyle(field).boxShadow !== "none";
      // Two layers, so the edge has somewhere to fall off to rather than
      // reading as a smudge or as a second border.
      res.twoLayers = (getComputedStyle(field).boxShadow.match(/rgba?\(/g) || []).length === 2;
      // Nothing inside the box: an inset ring would sit on the text.
      res.notInset = getComputedStyle(field).boxShadow.indexOf("inset") < 0;
      res.fieldDidNotMove = box(field) === before;
      res.rowDidNotMove = box(field.closest("[data-ar-row]")) === rowBefore;
      field.blur();
      await settle();
      res.ringGoesOnBlur = getComputedStyle(field).boxShadow === "none";
      if (btn) btn.blur();
      return res;
    });
  });
  check("a field at rest wears no ring", out.restNoRing, out);
  check("focus puts one on", out.ringOnFocus, out);
  check("built from two layers", out.twoLayers, out);
  check("and none of it inside the box, where the text is", out.notInset, out);
  check("the field does not move when it lands", out.fieldDidNotMove, out);
  check("nor does the row around it", out.rowDidNotMove, out);
  check("blur takes it off", out.ringGoesOnBlur, out);
  check("no console errors", errors.length === 0, errors);
}

// ---- what the floating button takes over ----
// The floating button's own menu holds the ways into the extension, and the
// Extras menu keeps them only when there is no floating button.
//
// Three cases. The middle one is the one that catches mistakes: a Lumiverse
// with no showContextMenu has a button with no menu, so nothing may hide for
// it.
console.log("\nwhere the ways into the extension live");
{
  // The buttons the floating button's menu takes over. The settings one is
  // left out on purpose: it is the one way in that always works, so it stays in
  // the Extras menu in every case below.
  const MOVABLE = ["auto-retry-open-panel"];
  const CASES = [
    { name: "with the button on screen", button: true, menu: true },
    { name: "with a button but no menu API", button: true, menu: false },
    { name: "with no button", button: false, menu: true },
  ];
  for (const mode of CASES) {
    const page = await browser.newPage({ viewport: { width: 412, height: 800 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
    page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
    await stage(page, "<div id=modal></div><div id=host></div>");
    await page.addStyleTag({ content: THEME });
    await page.addScriptTag({ content: SOURCE, type: "module" });
    await page.waitForFunction(() => !!window.__setup);
    const out = await page.evaluate(async (mode) => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const host = document.getElementById("host");
      host.style.cssText = "position:fixed;left:60px;top:60px";
      const acts = {};
      const sent = [];
      const handlers = {};
      let activated = 0;
      window.__menus = [];
      window.__pick = null;
      const ui = {
        showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
        registerInputBarAction: (o) => {
          const a = { onClick: (cb) => { a.cb = cb; return () => {}; }, destroy: () => { delete acts[o.id]; } };
          acts[o.id] = a;
          return a;
        },
        registerDrawerTab: () => {
          const root = document.createElement("div");
          document.body.appendChild(root);
          return { root, setBadge: () => {}, activate: () => { activated++; }, destroy: () => root.remove() };
        },
        createFloatWidget: () => ({ root: host, destroy: () => { host.innerHTML = ""; }, setPosition: () => {} }),
      };
      if (mode.menu) {
        ui.showContextMenu = (o) => { window.__menus.push(o); return Promise.resolve({ selectedKey: window.__pick }); };
      }
      let msgCbs = [];
      const onMsg = (m) => { for (const cb of msgCbs.slice()) { try { cb(m); } catch (_) {} } };
      window.__setup(
        { events: { on: (n, fn) => { handlers[n] = fn; return () => {}; } },
          sendToBackend: (m) => {
            sent.push(m);
            // A swap will not go out unless a chat is open, so this stub
            // answers that question the way a live backend does.
            if (m && m.type === "get_active_chat" && onMsg)
              setTimeout(() => onMsg({ type: "active_chat", requestId: m.requestId, chatId: "chat-A", character: null, resolved: true }), 0);
          },
          onBackendMessage: (cb) => { msgCbs.push(cb); return () => { msgCbs = msgCbs.filter((x) => x !== cb); }; },
          ui },
        {
          liveLog: true,
          panelHome: "drawer",
          showFloatingToggle: mode.button,
          showExtrasToggle: true,
          toast: false,
        },
      );
      // A chat has to be open before a swap can act on one.
      if (handlers.CHARACTER_MESSAGE_RENDERED) handlers.CHARACTER_MESSAGE_RENDERED({ chatId: "chat-A", messageId: "m1" });
      await wait(60);
      const res = {
        inExtras: Object.keys(acts).sort(),
        menuKeys: [],
        opened: 0,
        swapped: 0,
      };
      const b = host.querySelector("button");
      res.hasButton = !!b;
      if (b && mode.menu) {
        // Hold it open once to read the menu, and again to take an entry.
        const hold = async (pick) => {
          window.__pick = pick;
          b.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 80, clientY: 80 }));
          await wait(700);
          b.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
          await wait(60);
          return window.__menus[window.__menus.length - 1];
        };
        const m = await hold("panel");
        res.menuKeys = (m && m.items.map((i) => i.key)) || [];
        res.opened = activated;
      }
      return res;
    }, mode);
    await page.close();
    const carried = mode.button && mode.menu;
    const moved = MOVABLE.filter((id) => out.inExtras.indexOf(id) >= 0);
    check(mode.name + ": the button is " + (mode.button ? "there" : "absent"), out.hasButton === mode.button, out);
    check(mode.name + ": settings stays in Extras either way",
      out.inExtras.indexOf("auto-retry-settings") >= 0, out.inExtras);
    check(mode.name + ": Extras " + (carried ? "leaves the rest to the menu" : "carries the rest"),
      carried ? moved.length === 0 : moved.length === MOVABLE.length, out.inExtras);
    // The on/off button follows the floating button, not its menu, because
    // what replaces it is the button itself: one tap, and its icon shows the
    // state. So it hides even on a Lumiverse that cannot draw a menu at all.
    check(mode.name + ": the on/off entry is " + (mode.button ? "down for the button" : "in Extras"),
      (out.inExtras.indexOf("auto-retry-toggle") >= 0) === !mode.button, out.inExtras);
    if (carried) {
      check(mode.name + ": the menu offers the panel",
        out.menuKeys.indexOf("panel") >= 0, out.menuKeys);
      // The on/off button is the one that does not move into the menu. The
      // floating button is already that switch, in one tap.
      check(mode.name + ": and no on/off entry, which the button already is",
        out.menuKeys.indexOf("toggle") < 0, out.menuKeys);
      check(mode.name + ": hide sits last, under everything that opens or does",
        out.menuKeys[out.menuKeys.length - 1] === "hide", out.menuKeys);
      check(mode.name + ": the panel entry brings the tab forward", out.opened === 1, out);
    }
    check(mode.name + ": no console errors", errors.length === 0, errors);
  }
}

// ---- the "?" is bigger where a thumb has to hit it ----
// 18px is comfortable under a mouse and small under a thumb. On a screen that
// is touched it is 28px, which clears the 24px minimum target size, and a
// computer keeps the smaller one so the panel stays as dense as it was.
//
// The button grows rather than an invisible hit area being laid over it: each
// "?" sits at the end of a row that is one large label, so a hit area reaching
// past the button would take taps meant for the setting.
console.log("\nthe description button is sized for what is pointing at it");
{
  for (const [name, opts, want, rowFloor] of [
    ["with a mouse", { viewport: { width: 1280, height: 800 } }, 18, 26],
    ["with a finger", { viewport: { width: 412, height: 800 }, hasTouch: true, isMobile: true }, 28, 28],
  ]) {
    const page = await browser.newPage(opts);
    const errors = [];
    page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
    page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
    await stage(page, "<div id=modal></div>");
    await page.addStyleTag({ content: THEME });
    await page.addScriptTag({ content: SOURCE, type: "module" });
    await page.waitForFunction(() => !!window.__setup);
    const out = await page.evaluate(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const acts = {};
      window.__setup(
        { events: { on: () => () => {} },
          ui: { showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
                registerInputBarAction: (o) => { const a = { onClick: (cb) => { a.cb = cb; return () => {}; }, destroy: () => {} }; acts[o.id] = a; return a; } } },
        { toast: false },
      );
      acts["auto-retry-settings"].cb();
      await wait(60);
      for (const h of document.querySelectorAll('[role="button"][aria-expanded="false"]')) h.click();
      // Sections travel open now, so their contents have no height for the
      // length of that. Waited out here rather than in every check below.
      await new Promise((r) => setTimeout(r, 260));
      await wait(60);
      const hints = [...document.querySelectorAll("button[data-ar-hint]")]
        .filter((e) => e.getBoundingClientRect().width);
      const sizes = [...new Set(hints.map((e) => Math.round(e.getBoundingClientRect().width)))];
      // It does its job at either size, by the gesture that device makes: a
      // mouse reveals on hover, a finger on tap. Reading the wrong one reports
      // a broken button that was only never pointed at.
      if (matchMedia("(pointer: coarse)").matches) {
        hints[0].dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
        hints[0].click();
      } else {
        hints[0].dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
      }
      await wait(40);
      const opened = !!document.querySelector('[role="tooltip"]');
      // And it never sits on top of another control, which is what a hit area
      // laid over the row would have done.
      const controls = [...document.querySelectorAll("#modal input,#modal select,#modal button")];
      const overlaps = hints.some((h) => {
        const a = h.getBoundingClientRect();
        return controls.some((o) => {
          if (o === h) return false;
          const c = o.getBoundingClientRect();
          return c.width && a.left < c.right && a.right > c.left && a.top < c.bottom && a.bottom > c.top;
        });
      });
      const rowH = [...document.querySelectorAll("[data-ar-row]")]
        .map((e) => Math.round(e.getBoundingClientRect().height)).filter(Boolean);
      return { count: hints.length, sizes, opened, overlaps, rowMin: Math.min(...rowH) };
    });
    await page.close();
    check(name + ": there are description buttons to measure", out.count > 20, out);
    check(name + ": all of them are one size", out.sizes.length === 1, out.sizes);
    check(name + ": that size is " + want + "px", out.sizes[0] === want, out.sizes);
    check(name + ": the rows are no shorter than " + rowFloor + "px", out.rowMin >= rowFloor, out);
    check(name + ": the gesture that device makes still opens its description", out.opened, out);
    check(name + ": and none of them covers another control", out.overlaps === false, out);
    check(name + ": no console errors", errors.length === 0, errors);
  }
}

// ---- every tick box is the same size ----
// The settings rows set 20px. The reset picker and the import and export lists
// set nothing and took the browser default of 13px, so the same control was one
// size on one screen and another size on the next, and the small one was in the
// dialog where a mis-tap deletes saved presets.
console.log("\nthe tick boxes are one size");
{
  const { out, errors } = await inPanel(
    browser, { viewport: { width: 412, height: 800 } },
    async (page) => page.evaluate(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const sizes = (where) => {
        const seen = {};
        for (const el of document.querySelectorAll(where + ' input[type="checkbox"]')) {
          const r = el.getBoundingClientRect();
          if (!r.width) continue;
          const k = Math.round(r.width) + "x" + Math.round(r.height);
          seen[k] = (seen[k] || 0) + 1;
        }
        return seen;
      };
      for (const h of document.querySelectorAll('[role="button"][aria-expanded="false"]')) h.click();
      // Sections travel open now, so their contents have no height for the
      // length of that. Waited out here rather than in every check below.
      await new Promise((r) => setTimeout(r, 260));
      await wait(40);
      const rows = sizes("#modal");
      // The reset picker is its own overlay, and the one that matters most.
      [...document.querySelectorAll("button")].find((b) => /^Reset/.test(b.textContent.trim())).click();
      await wait(40);
      const picker = sizes("#__lvRetryReset");
      return { rows, picker };
    }),
  );
  const all = { ...out.rows, ...out.picker };
  check("the settings rows have tick boxes to measure", Object.values(out.rows).reduce((a, b) => a + b, 0) > 10, out.rows);
  check("so does the reset picker", Object.values(out.picker).reduce((a, b) => a + b, 0) > 2, out.picker);
  check("and every one of them is the same size", Object.keys(all).length === 1, all);
  check("at 20px, not the browser default of 13", Object.keys(all)[0] === "20x20", all);
  check("no console errors", errors.length === 0, errors);
}

// ---- the row says who the chat is with, however you got there ----
// The name was only ever asked for where a chat id arrived through noteChat,
// which is a message rendering. Switching chats and starting a generation both
// make a chat current without going near it, so the two most ordinary ways of
// ending up in a chat left the row reading "This chat" with no name on it.
//
// Asked once per chat, from every path plus the row itself, so a host that
// never names a chat is not asked again on every repaint.
console.log("\nthe chat row names the character");
{
  const WAYS = [
    ["learned at startup", "startup"],
    ["learned from a rendered message", "rendered"],
    ["switched to with CHAT_CHANGED", "switched"],
    ["learned from a generation starting", "generation"],
  ];
  for (const [name, mode] of WAYS) {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
    page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
    await stage(page, "<div id=modal></div>");
    await page.addStyleTag({ content: THEME });
    await page.addScriptTag({ content: SOURCE, type: "module" });
    await page.waitForFunction(() => !!window.__setup);
    const out = await page.evaluate(async (mode) => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const handlers = {}, acts = {}, asks = [];
      let listeners = [];
      const send = (m) => { for (const cb of listeners.slice()) { try { cb(m); } catch (_) {} } };
      // Fixture names, picked to be nobody's: this is test data, not a persona.
      const NAMES = { "chat-A": "Wren", "chat-B": "Tobias" };
      // Which chat the host would name if asked outright, as opposed to the
      // chat whose name is being asked for. The panel asks this every time it
      // opens, so a fixture that always answered the same chat would walk the
      // row back to it. Startup is in chat-A; the other three ways start
      // nowhere and arrive in chat-B through the event under test.
      let here = mode === "startup" ? "chat-A" : null;
      window.__setup(
        { events: { on: (n, fn) => { handlers[n] = fn; return () => {}; } },
          sendToBackend: (m) => {
            if (m && m.type === "get_active_chat") {
              asks.push(m.chatId);
              const about = m.chatId || here;
              setTimeout(() => send({ type: "active_chat", requestId: m.requestId,
                chatId: about, character: NAMES[about] || null, resolved: true }), 0);
            }
          },
          onBackendMessage: (cb) => { listeners.push(cb); return () => { listeners = listeners.filter((x) => x !== cb); }; },
          ui: { showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
                registerInputBarAction: (o) => { const a = { onClick: (cb) => { a.cb = cb; return () => {}; }, destroy: () => {} }; acts[o.id] = a; return a; } } },
        { toast: false },
      );
      await wait(80);
      // Reached several times over, so asking once can be told from asking each
      // time something repaints.
      if (mode !== "startup") here = "chat-B";
      for (let i = 0; i < 4; i++) {
        if (mode === "rendered") handlers.CHARACTER_MESSAGE_RENDERED({ chatId: "chat-B", messageId: "m" + i });
        else if (mode === "switched") handlers.CHAT_CHANGED({ chatId: "chat-B" });
        else if (mode === "generation") handlers.GENERATION_STARTED({ chatId: "chat-B", generationId: "g" + i });
        await wait(20);
      }
      acts["auto-retry-settings"].cb();
      await wait(100);
      const row = document.querySelector("[data-ar-chat-switch]");
      return {
        text: row ? (row.textContent || "") : "",
        asked: asks.filter((x) => x === (mode === "startup" ? null : "chat-B")).length,
      };
    }, mode);
    await page.close();
    const who = mode === "startup" ? "Wren" : "Tobias";
    check(name + ": the row names the character", out.text.indexOf("This chat, with " + who) === 0, out.text.slice(0, 60));
    if (mode !== "startup")
      check(name + ": and asked for that name once, not on every repaint", out.asked === 1, out);
    check(name + ": no console errors", errors.length === 0, errors);
  }
}

// ---- an answer that names nobody is not always the same answer ----
// A backend that looked and found no card has answered: that chat has no name,
// caching it stops the question repeating. A backend that could not look has
// not answered, and caching that would leave the row nameless for the rest of
// the page over a lookup that would have worked a second later. That is what
// the missing name was: a backend still loading when the first ask went out.
console.log("\nno name and could not look are different answers");
{
  // [name, how the backend answers a named ask, asked once only, ends up named]
  const WAYS = [
    ["looked and found no card", "nocard", true, false],
    ["could not look at all", "blind", false, false],
    ["could not look, then could", "waking", false, true],
  ];
  for (const [name, mode, askedOnce, endsNamed] of WAYS) {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
    page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
    await stage(page, "<div id=modal></div>");
    await page.addStyleTag({ content: THEME });
    await page.addScriptTag({ content: SOURCE, type: "module" });
    await page.waitForFunction(() => !!window.__setup);
    const out = await page.evaluate(async (arg) => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const handlers = {}, acts = {}, asks = [];
      let listeners = [];
      const send = (m) => { for (const cb of listeners.slice()) { try { cb(m); } catch (_) {} } };
      // The chat the reader is in, which the switching below moves.
      let here = "chat-A";
      window.__setup(
        { events: { on: (n, fn) => { handlers[n] = fn; return () => {}; } },
          sendToBackend: (m) => {
            if (!m || m.type !== "get_active_chat") return;
            if (m.chatId) asks.push(m.chatId);
            // Which chat is being answered about: the one named in the ask, or
            // the one the reader is in when the ask names none. The panel asks
            // outright every time it opens, so answering that with a fixed chat
            // would walk the row out of the chat under test.
            const about = m.chatId || here;
            // chat-A is the fixture's known-good chat and always answers. What
            // is under test is chat-B, which is the one the backend struggles
            // with.
            if (about === "chat-A") {
              setTimeout(() => send({ type: "active_chat", requestId: m.requestId,
                chatId: "chat-A", character: "Wren", resolved: true }), 0);
              return;
            }
            // "waking" is a backend still loading: the first named ask finds
            // nothing to ask, the next one lands.
            const looked = arg.mode === "nocard" || (arg.mode === "waking" && asks.length > 1);
            setTimeout(() => send({ type: "active_chat", requestId: m.requestId,
              chatId: "chat-B",
              character: arg.mode === "waking" && looked ? "Tobias" : null,
              resolved: looked }), 0);
          },
          onBackendMessage: (cb) => { listeners.push(cb); return () => { listeners = listeners.filter((x) => x !== cb); }; },
          ui: { showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
                registerInputBarAction: (o) => { const a = { onClick: (cb) => { a.cb = cb; return () => {}; }, destroy: () => {} }; acts[o.id] = a; return a; } } },
        { toast: false },
      );
      await wait(80);
      // Switched away and back, the way you would while it stayed nameless.
      for (let i = 0; i < 4; i++) {
        here = i % 2 ? "chat-A" : "chat-B";
        handlers.CHAT_CHANGED({ chatId: here });
        await wait(30);
      }
      here = "chat-B";
      handlers.CHAT_CHANGED({ chatId: "chat-B" });
      await wait(60);
      acts["auto-retry-settings"].cb();
      await wait(100);
      const row = document.querySelector("[data-ar-chat-switch]");
      return { text: row ? (row.textContent || "") : "", asked: asks.filter((x) => x === "chat-B").length };
    }, { mode });
    await page.close();
    const named = out.text.indexOf("This chat, with Tobias") === 0;
    check(name + ": " + (endsNamed ? "the name arrives once it can" : "the row stays nameless"),
      named === endsNamed, out.text.slice(0, 60));
    check(name + ": asked " + (askedOnce ? "once and left alone" : "again rather than given up on"),
      askedOnce ? out.asked === 1 : out.asked > 1, out);
    check(name + ": no console errors", errors.length === 0, errors);
  }
}

console.log("\na finished reply is not re-rolled, a stalled one still is");
{
  const CASES = [
    ["finished cleanly", "clean", false],
    ["finished, no chat id on the end event", "no-chat-id", false],
    ["finished, the end event named a different chat", "retyped", false],
    ["finished, id shaped differently on the token event", "token-retyped", false],
    ["finished, no content field, text only from the stream", "streamed-only", false],
    ["empty reply, no chat id on the end event", "empty-no-id", true],
    ["never produced a token", "never-started", true],
    ["streamed then went silent", "went-silent", true],
    ["finished with an error", "error", true],
    ["finished empty, and nothing streamed either", "empty", true],
    ["finished cut off mid-sentence", "truncated", true],
  ];
  for (const [name, mode, wantRetry] of CASES) {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
    page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
    await stage(page, '<div id=modal></div><button data-testid="regenerate">Regenerate</button>');
    await page.addStyleTag({ content: THEME });
    await page.addScriptTag({ content: SOURCE, type: "module" });
    await page.waitForFunction(() => !!window.__setup);
    const out = await page.evaluate(async (mode) => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const handlers = {};
      let clicks = 0;
      document.querySelector("[data-testid=regenerate]").addEventListener("click", () => { clicks++; });
      window.__setup(
        { events: { on: (n, fn) => { handlers[n] = fn; return () => {}; } },
          ui: { showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
                registerInputBarAction: () => ({ onClick: () => () => {}, destroy: () => {} }) } },
        // Short watchdogs so a false retry, if one is coming, arrives quickly.
        { toast: false, idleTimeoutMs: 250, stuckTimeoutMs: 250, retryDelayMs: 10 },
      );
      const CID = "chat-7", GID = "g1";
      const done = "Hello there, this is a finished reply.";
      // The id shape a host uses can differ from one event to the next, so the
      // token event is given a differently typed one in that case.
      const startId = mode === "token-retyped" ? 7 : CID;
      const tokenId = mode === "token-retyped" ? "7" : CID;
      handlers.GENERATION_STARTED({ chatId: startId, generationId: GID });
      await wait(20);
      if (mode !== "never-started") {
        // An empty reply has to have streamed nothing, or it is not an
        // empty reply: it is a reply the ending described wrongly, and
        // that one is left alone on purpose.
        const streamed = mode === "empty-no-id" || mode === "empty" ? "" : done;
        if (streamed || mode !== "empty-no-id")
          handlers.STREAM_TOKEN_RECEIVED({ chatId: tokenId, generationId: GID, token: streamed });
        await wait(20);
      }
      if (mode === "clean") handlers.GENERATION_ENDED({ chatId: CID, generationId: GID, content: done });
      else if (mode === "no-chat-id") handlers.GENERATION_ENDED({ generationId: GID, content: done });
      else if (mode === "retyped") handlers.GENERATION_ENDED({ chatId: "some-other-chat", generationId: GID, content: done });
      else if (mode === "token-retyped") handlers.GENERATION_ENDED({ chatId: startId, generationId: GID, content: done });
      // No content field at all: the text that streamed has to stand in for it,
      // and that lives on the chat's state. Find the wrong state and a good
      // reply reads as empty and gets thrown away.
      else if (mode === "streamed-only") handlers.GENERATION_ENDED({ chatId: "some-other-chat", generationId: GID });
      else if (mode === "empty-no-id") handlers.GENERATION_ENDED({ generationId: GID, content: "" });
      // Not one of the rate-limited wordings, or the retry would wait out the
      // rate-limit delay and this would read as no retry at all.
      else if (mode === "error") handlers.GENERATION_ENDED({ chatId: CID, generationId: GID, error: "the provider sent back nonsense" });
      else if (mode === "empty") handlers.GENERATION_ENDED({ chatId: CID, generationId: GID, content: "" });
      else if (mode === "truncated") handlers.GENERATION_ENDED({ chatId: CID, generationId: GID, content: 'She turned and said, "wait, I' });
      // never-started and went-silent send no end event at all, which is the point.
      await wait(800);
      return { clicks };
    }, mode);
    await page.close();
    check(name + ": " + (wantRetry ? "is retried" : "is left alone"),
      (out.clicks > 0) === wantRetry, out);
    check(name + ": no console errors", errors.length === 0, errors);
  }
}

// ---- the toast may use the whole width it is allowed ----
// "No reply found to swap in this chat." wrapped onto two lines on a phone and
// left "chat." alone on the second, on a message that fits on one line easily.
//
// The cause was the centring. A fixed box with only a left edge set has a
// containing block running from that edge to the right of the screen, so
// left:50% left it half a viewport to work with: max-width was 379px on a
// 412px phone and the box stopped dead at 206px. It is centred by pinning both
// edges and sharing the remainder between the margins now, so the cap it was
// given is the cap it gets.
console.log("\nthe toast gets the width it was given");
{
  const page = await browser.newPage({ viewport: { width: 412, height: 800 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  await stage(page, "<div id=modal></div>");
  await page.addStyleTag({ content: THEME });
  await page.addScriptTag({ content: SOURCE, type: "module" });
  await page.waitForFunction(() => !!window.__setup);
  const out = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const handlers = {};
    const acts = {};
    window.__setup(
      { events: { on: (n, fn) => { handlers[n] = fn; return () => {}; } },
        ui: {
          showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
          registerInputBarAction: (o) => {
            const a = { onClick: (cb) => { a.cb = cb; return () => {}; }, destroy: () => {} };
            acts[o.id] = a;
            return a;
          },
        } },
      { toast: true, showExtrasToggle: true },
    );
    const read = () => {
      const t = document.getElementById("__lvRetryToast");
      const r = t.getBoundingClientRect();
      const span = t.firstElementChild;
      const node = span.firstChild;
      const tops = [];
      let at = 0;
      for (const word of node.textContent.split(" ")) {
        if (word) {
          const rr = document.createRange();
          rr.setStart(node, at);
          rr.setEnd(node, at + word.length);
          tops.push(Math.round(rr.getBoundingClientRect().top));
        }
        at += word.length + 1;
      }
      const bottom = Math.max(...tops);
      return {
        text: node.textContent,
        width: Math.round(r.width),
        lines: new Set(tops).size,
        lastWords: tops.filter((t) => t === bottom).length,
        // Centred on the viewport, and not hanging off either edge.
        centred: Math.abs(r.left + r.width / 2 - 206) < 2,
        onScreen: r.left >= 0 && r.right <= 412,
      };
    };

    handlers.CHARACTER_MESSAGE_RENDERED({ chatId: "A", messageId: "m1" });
    await wait(20);
    acts["auto-retry-settings"].cb();
    await wait(40);
    // A long one: switching this chat off. Wrapping is fair here, and it must
    // still use the full width it is allowed rather than half of it.
    document.querySelector("[data-ar-chat-switch]").querySelector("button").click();
    await wait(40);
    const long = read();
    // And a short one, which must not be padded out to the cap. The checkbox
    // in the panel raises no toast, so this uses the Extras on/off entry,
    // which is the control that announces the switch.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await wait(20);
    acts["auto-retry-toggle"].cb();
    await wait(60);
    const short = read();
    return { long, short };
  });
  await page.close();
  // 206 is exactly half of this viewport, which is what the old centring
  // capped every message at whatever max-width said.
  check("a long message is wider than half the screen", out.long.width > 206, out.long);
  check("and no wider than the cap it was given", out.long.width <= Math.round(412 * 0.92), out.long);
  check("a short message is not padded out to the cap", out.short.width < 206, out.short);
  for (const [what, m] of [["long", out.long], ["short", out.short]]) {
    check(what + ": centred on the screen", m.centred, m);
    check(what + ": and fully on it", m.onScreen, m);
  }
  check("no console errors", errors.length === 0, errors);
}

// ---- Save does not claim a save that did not happen ----
// The browser copy is what survives a reload, and writing it can fail outright:
// a browser with site data blocked, or with no room left, throws. That throw
// was swallowed, so the panel said "Saved" over settings that were gone the
// next time the page loaded. The presets have always said when this happens;
// the settings did not.
console.log("\nSave tells the truth about the browser copy");
{
  for (const storageWorks of [true, false]) {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
    page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
    await stage(page, "<div id=modal></div>");
    await page.addStyleTag({ content: THEME });
    await page.addScriptTag({ content: SOURCE, type: "module" });
    await page.waitForFunction(() => !!window.__setup);
    const out = await page.evaluate(async (storageWorks) => {
      const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const acts = {};
      window.__setup(
        { events: { on: () => () => {} },
          ui: {
            showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
            registerInputBarAction: (o) => {
              const a = { onClick: (cb) => { a.cb = cb; return () => {}; }, destroy: () => {} };
              acts[o.id] = a;
              return a;
            },
          } },
        { toast: false },
      );
      acts["auto-retry-settings"].cb();
      await frame();
      // Broken only once the panel is up, so opening it is unaffected and the
      // press is the only thing under test.
      if (!storageWorks) {
        Storage.prototype.setItem = function () { throw new Error("site data is blocked"); };
      }
      const save = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Save");
      const pressed = !!save;
      if (save) save.click();
      await frame();
      const el = document.querySelector("[data-ar-save-status]");
      const line = el ? (el.textContent || "").trim() : "";
      return { pressed, line };
    }, storageWorks);
    await page.close();
    const n = storageWorks ? "with storage working" : "with storage blocked";
    check(n + ": the Save button was there to press", out.pressed, out);
    check(n + ": it says " + (storageWorks ? "it saved" : "it could not"),
      storageWorks ? /^Saved\./.test(out.line) : /^Could not save/.test(out.line), out.line);
    if (!storageWorks) {
      check(n + ": and never claims it saved", !/^Saved\./.test(out.line), out.line);
    }
    check(n + ": no console errors", errors.length === 0, errors);
  }
}

console.log("\nturning the floating button on and off");
{
  const page = await browser.newPage({ viewport: { width: 412, height: 800 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  await stage(page, "<div id=modal></div><div id=host></div>");
  await page.addStyleTag({ content: THEME });
  await page.addScriptTag({ content: SOURCE, type: "module" });
  await page.waitForFunction(() => !!window.__setup);
  const out = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const host = document.getElementById("host");
    host.style.cssText = "position:fixed;left:60px;top:60px";
    const handlers = {};
    window.__setup(
      { events: { on: (n, fn) => { handlers[n] = fn; return () => {}; } },
        ui: { showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
              registerInputBarAction: () => ({ onClick: () => () => {}, destroy: () => {} }),
              createFloatWidget: () => ({ root: host, destroy: () => {}, setPosition: () => {} }) } },
      { enabled: true, showFloatingToggle: true, floatingToggleSize: 44, toast: false },
    );
    await wait(60);
    const b = host.querySelector("button");
    const svgNow = () => b.querySelector("svg");
    const slashOff = () => {
      const line = b.querySelector(".lv-ar-slash");
      return line ? getComputedStyle(line).strokeDashoffset : "gone";
    };
    const drawnFirst = svgNow();
    const onBefore = b.getAttribute("data-ar-on");
    const hiddenBefore = slashOff();
    b.click();
    // Caught halfway, which is the animation actually running rather than the
    // state being swapped.
    await wait(60);
    const midway = slashOff();
    // And then settled.
    await wait(400);
    const onAfter = b.getAttribute("data-ar-on");
    const shownAfter = slashOff();
    // The element itself survives the switch, which is what lets the stroke
    // move rather than the whole mark being thrown away and drawn again.
    const sameNode = drawnFirst === svgNow();
    // A repaint that says nothing new: same state, different chat.
    handlers.GENERATION_STARTED && handlers.GENERATION_STARTED({ chatId: "z", generationId: "g" });
    await wait(40);
    const stillSame = drawnFirst === svgNow();
    const line = b.querySelector(".lv-ar-slash");
    return {
      onBefore, onAfter, hiddenBefore, midway, shownAfter, sameNode, stillSame,
      eases: getComputedStyle(b).transitionDuration,
      slashEase: line ? getComputedStyle(line).transitionDuration : "gone",
    };
  });
  await page.close();
  // A button that has just appeared is drawn already at rest, not caught
  // partway through moving into its own state.
  check("the first paint does not animate", parseFloat(out.hiddenBefore) === 26, out);
  check("the switch is what changes, not the drawing", out.sameNode && out.stillSame, out);
  check("turning it off draws the slash on", out.onBefore === "1" && out.onAfter === "0", out);
  check("the slash is hidden while it is on",
    parseFloat(out.hiddenBefore) > 0, out);
  check("and drawn once it is off", parseFloat(out.shownAfter) === 0, out);
  check("along its own length rather than popping in",
    parseFloat(out.midway) > 0 && parseFloat(out.midway) < 26, out);
  check("over a time somebody can see", !/^0s$/.test(String(out.slashEase).trim()), out);
  check("and the colours ease", !/^0s(,\s*0s)*$/.test(String(out.eases).trim()), out);
  check("no console errors", errors.length === 0, errors);
}

// ---- one menu per gesture, even when Android asks twice ----
// A long press on Android runs our hold timer and raises contextmenu as well,
// so the menu gets asked for twice on the way to one gesture. The host's menu
// cannot be taken back once opened, so acting on the second ask leaves two
// stacked.
console.log("\nAndroid asking for the menu twice");
{
  const page = await browser.newPage({ viewport: { width: 412, height: 800 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  await stage(page, "<div id=modal></div><div id=host></div>");
  await page.addStyleTag({ content: THEME });
  await page.addScriptTag({ content: SOURCE, type: "module" });
  await page.waitForFunction(() => !!window.__setup);
  const out = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const host = document.getElementById("host");
    host.style.cssText = "position:fixed;left:60px;top:60px";
    let asked = 0;
    let answer = null;
    window.__setup(
      { events: { on: () => () => {} },
        ui: { showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
              registerInputBarAction: () => ({ onClick: () => () => {}, destroy: () => {} }),
              // Stays open until answered, which is what a menu on screen does
              // and what the immediate stub could never catch.
              showContextMenu: () => { asked += 1; return new Promise((r) => { answer = r; }); },
              createFloatWidget: () => ({ root: host, destroy: () => {}, setPosition: () => {} }) } },
      { enabled: true, showFloatingToggle: true, floatingToggleSize: 44, toast: false },
    );
    await wait(40);
    const b = host.querySelector("button");
    // The hold fires the timer, and Android's own contextmenu lands on top of
    // it while the first menu is still up.
    b.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 80, clientY: 80 }));
    await wait(700);
    const afterHold = asked;
    b.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 80, clientY: 80 }));
    await wait(60);
    const afterBoth = asked;
    // Answering the one that is up still works, and frees the next gesture.
    answer({ selectedKey: null });
    await wait(60);
    b.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 80, clientY: 80 }));
    await wait(60);
    return { afterHold, afterBoth, afterAnswering: asked };
  });
  await page.close();
  check("the hold asks for a menu", out.afterHold === 1, out);
  check("and the contextmenu on top of it does not ask for a second",
    out.afterBoth === 1, out);
  check("once answered, the next gesture opens one again",
    out.afterAnswering === 2, out);
  check("no console errors", errors.length === 0, errors);
}

// ---- an older Lumiverse without the menu API says where to go ----
// The menu is the host's, and a build that predates it has no showContextMenu
// at all. Opening nothing would read as the button being broken, so it says
// where the settings actually are.
console.log("\na host with no context menu API");
{
  const page = await browser.newPage({ viewport: { width: 412, height: 800 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  await stage(page, "<div id=modal></div><div id=host></div>");
  await page.addStyleTag({ content: THEME });
  await page.addScriptTag({ content: SOURCE, type: "module" });
  await page.waitForFunction(() => !!window.__setup);
  const out = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const host = document.getElementById("host");
    host.style.cssText = "position:fixed;left:60px;top:60px";
    window.__setup(
      { events: { on: () => () => {} },
        ui: { showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
              registerInputBarAction: () => ({ onClick: () => () => {}, destroy: () => {} }),
              // No showContextMenu, which is the whole point.
              createFloatWidget: () => ({ root: host, destroy: () => {}, setPosition: () => {} }) } },
      { enabled: true, showFloatingToggle: true, floatingToggleSize: 44 },
    );
    await wait(40);
    const b = host.querySelector("button");
    b.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 80, clientY: 80 }));
    await wait(700);
    b.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    await wait(60);
    const t = document.getElementById("__lvRetryToast");
    return {
      stillThere: !!host.querySelector("button"),
      said: t ? (t.textContent || "").trim() : "",
    };
  });
  await page.close();
  check("the button survives a hold it cannot answer", out.stillThere, out);
  check("and it says where the settings are", /Extras/i.test(out.said), out);
  check("no console errors", errors.length === 0, errors);
}

// ---- a phone that claims it can hover is still a phone ----
// A phone told to show the desktop site says it can hover. Anything guarded on
// that question alone loses its guard there, and a synthesised hover with no
// matching leave then sticks. The menu is the host's now; the panel's own
// buttons are still ours, and this is the case that catches them.
console.log("\na phone that says it can hover");
{
  const page = await browser.newPage({ viewport: { width: 393, height: 780 }, hasTouch: true, isMobile: true });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  await page.addInitScript(() => {
    const real = window.matchMedia.bind(window);
    window.matchMedia = (q) => {
      const r = real(q);
      if (/hover:\s*hover/.test(String(q))) {
        return { matches: true, media: r.media, addEventListener() {}, removeEventListener() {},
                 addListener() {}, removeListener() {}, onchange: null, dispatchEvent() { return false; } };
      }
      return r;
    };
  });
  await stage(page, "<div id=modal></div>");
  await page.addStyleTag({ content: THEME });
  await page.addScriptTag({ content: SOURCE, type: "module" });
  await page.waitForFunction(() => !!window.__setup);
  await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__acts = {};
    window.__setup(
      { events: { on: () => () => {} },
        ui: { showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
              registerInputBarAction: (o) => { const a = { onClick: (cb) => { a.cb = cb; return () => {}; }, destroy: () => {} }; window.__acts[o.id] = a; return a; } } },
      { toast: false },
    );
    await wait(30);
    window.__acts["auto-retry-settings"].cb();
    await wait(200);
  });
  const lies = await page.evaluate(() => matchMedia("(hover: hover)").matches);
  const bg = () => page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Save");
    return b ? getComputedStyle(b).backgroundColor : "gone";
  });
  const at = await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Save");
    if (!b) return null;
    b.scrollIntoView({ block: "center" });
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  });
  const rest = await bg();
  if (at) await page.touchscreen.tap(at.x, at.y);
  await page.waitForTimeout(400);
  const after = await bg();
  await page.close();
  check("the screen claims it can hover", lies === true, lies);
  check("the panel opened with its buttons", rest !== "gone", { rest });
  check("and a tap leaves the button at its resting colour", after === rest, { rest, after });
  check("no console errors", errors.length === 0, errors);
}

// ---- a tapped button does not keep its hover colour ----
// The same half-sent pair, in the panel rather than the menu: a touch browser
// raises mouseenter at the end of a tap and never sends the matching leave, so
// every button in the panel stayed lit in its hover colour once tapped. The
// pointerleave that resets it has already run by the time that hover arrives.
console.log("\ntapping a button in the panel");
{
  const { out, errors } = await inPanel(
    browser, { viewport: { width: 393, height: 780 }, touch: true },
    async (page) => {
      const bg = () => page.evaluate(() => {
        const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Save");
        return b ? getComputedStyle(b).backgroundColor : "gone";
      });
      const at = await page.evaluate(() => {
        const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Save");
        if (!b) return null;
        b.scrollIntoView({ block: "center" });
        const r = b.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      });
      if (!at) return { err: "no Save button" };
      const rest = await bg();
      await page.touchscreen.tap(at.x, at.y);
      await page.waitForTimeout(400);
      return { rest, after: await bg() };
    },
  );
  check("the button has a resting colour", out.rest && out.rest !== "gone", out);
  check("and is back at it after a tap", out.after === out.rest, out);
  check("no console errors", errors.length === 0, errors);
}

// ---- a button is marked when it was reached by keyboard, and not otherwise ----
// Whether a button should show its focus is the browser's own question, asked
// as :focus-visible. Tracking pointer presses by hand answered it wrongly the
// moment a dialog moved focus itself: the reset picker's second step focuses Go
// back so a keyboard can act on it, and by hand that looked exactly like
// tabbing to it, so the dialog opened with a ring around a button nobody had
// touched.
//
// Driven with real input, because a dispatched press is untrusted and the
// browser does not count it when deciding.
console.log("\nwhen a button shows its focus");
{
  const { out, errors } = await inPanel(browser, {}, async (page) => {
    const ringOf = (label) => page.evaluate((s) => {
      const el = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === s);
      return el ? getComputedStyle(el).boxShadow : "no such button";
    }, label);
    // Clicked for real, by finding the button and pressing where it is. A text
    // selector is no good here: these labels carry an ellipsis character.
    const press = async (label) => {
      const box = await page.evaluate((s) => {
        const el = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === s);
        if (!el) return null;
        el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }, label);
      if (!box) return false;
      await page.mouse.click(box.x, box.y);
      return true;
    };
    const res = {};
    // A real press, which is what tells the browser somebody is using a
    // pointer. Nothing after this should be marked unless a key is pressed.
    res.pressed = await press("Save");
    await page.waitForTimeout(150);
    res.pressedNoRing = (await ringOf("Save")) === "none";
    // Now focus moved by code rather than by the person, which is what a dialog
    // does when it opens: the reset picker's second step focuses its safe
    // answer so a keyboard can act on it. Counted by hand this looked exactly
    // like tabbing, and the button lit up with nobody having gone near it.
    res.movedByCode = await page.evaluate(() => {
      const el = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "Reset\u2026");
      if (!el) return false;
      el.focus({ preventScroll: true });
      return document.activeElement === el;
    });
    await page.waitForTimeout(200);
    res.codeFocusNoRing = (await ringOf("Reset\u2026")) === "none";
    // And a real key press, which is the one case that should be marked.
    await page.keyboard.press("Tab");
    await page.waitForTimeout(250);
    res.tabbedTo = await page.evaluate(() =>
      ((document.activeElement && document.activeElement.textContent) || "").trim());
    res.tabbedRing = await page.evaluate(() =>
      getComputedStyle(document.activeElement).boxShadow);
    // The dialog case for real, and with the browser leaning the wrong way.
    // The reset picker's second step focuses Go back so a keyboard can answer
    // it, and here the step is reached from the keyboard, so :focus-visible on
    // its own says to mark it. Nobody has gone near Go back, so it stays plain.
    res.opened = await press("Reset…");
    await page.waitForTimeout(200);
    res.ticked = await page.evaluate(() => {
      const box = document.querySelector('[data-ar-reset="retry"] input');
      if (!box) return false;
      box.checked = true;
      const go = [...document.querySelectorAll("#__lvRetryReset button")]
        .find((b) => b.textContent.trim() === "Reset ticked");
      if (!go) return false;
      go.focus({ preventScroll: true });
      return true;
    });
    await page.keyboard.press("Enter");
    await page.waitForTimeout(250);
    res.onGoBack = await page.evaluate(() => {
      const b = [...document.querySelectorAll("#__lvRetryReset button")]
        .find((x) => x.textContent.trim() === "Go back");
      if (!b) return null;
      return {
        focused: document.activeElement === b,
        browserSaysShow: b.matches(":focus-visible"),
        ring: getComputedStyle(b).boxShadow,
      };
    });
    return res;
  });
  check("a button was pressed for real", out.pressed, out);
  check("and wears no ring for it", out.pressedNoRing, out);
  check("focus can be moved by code, the way a dialog does", out.movedByCode, out);
  check("and that button is not marked either", out.codeFocusNoRing, out);
  check("tabbing lands on a button", out.tabbedTo.length > 0, out);
  check("and that one does wear the ring", out.tabbedRing !== "none", out);
  check("the reset picker reaches its second step from a key",
    out.opened && out.ticked && out.onGoBack && out.onGoBack.focused, out.onGoBack);
  check("the browser would have marked Go back",
    out.onGoBack && out.onGoBack.browserSaysShow === true, out.onGoBack);
  check("and it is not marked all the same",
    out.onGoBack && out.onGoBack.ring === "none", out.onGoBack);
  check("no console errors", errors.length === 0, errors);
}

// ---- a missing permission is said out loud ----
// It is the one failure that raises nothing: a gated event never fires and a
// fire-and-forget registration silently does nothing, so the extension sits
// there looking installed while doing none of what it was asked to.
console.log("\na missing permission is said out loud");
{
  const open = async (page, granted) => page.evaluate(async (granted) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const acts = {};
    // As many listeners as are registered, like the host.
    let msgCbs = [];
    const fromBackend = (m) => { for (const cb of msgCbs.slice()) { try { cb(m); } catch (_) {} } };
    window.__setup(
      { events: { on: () => () => {} },
        sendToBackend: () => {},
        onBackendMessage: (fn) => { msgCbs.push(fn); return () => { msgCbs = msgCbs.filter((x) => x !== fn); }; },
        ui: { showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
              registerInputBarAction: (o) => { const a = { onClick: (cb) => { a.cb = cb; return () => {}; }, destroy: () => {} }; acts[o.id] = a; return a; } } },
      { liveLog: true, toast: false },
    );
    await wait(30);
    fromBackend({
      type: "permissions",
      list: [
        { name: "generation", costs: "Everything. Nothing is ever retried." },
        { name: "interceptor", costs: "The refusal note, and the Prompt tab." },
      ],
      granted: granted,
    });
    await wait(20);
    acts["auto-retry-settings"].cb();
    await wait(40);
    const box = document.querySelector("[data-ar-perms]");
    return {
      drawn: !!box && getComputedStyle(box).display !== "none",
      text: box ? box.textContent : "",
    };
  }, granted);

  // Nothing missing: no furniture for a problem that is not there.
  {
    const page = await browser.newPage();
    await stage(page, "<div id=modal></div>");
    await page.addStyleTag({ content: THEME });
    await page.addScriptTag({ content: SOURCE, type: "module" });
    await page.waitForFunction(() => !!window.__setup);
    const out = await open(page, { generation: true, interceptor: true });
    await page.close();
    check("nothing is drawn when everything is granted", !out.drawn, out);
  }
  // A build too old to answer is not a build that said no.
  {
    const page = await browser.newPage();
    await stage(page, "<div id=modal></div>");
    await page.addStyleTag({ content: THEME });
    await page.addScriptTag({ content: SOURCE, type: "module" });
    await page.waitForFunction(() => !!window.__setup);
    const out = await open(page, { generation: null, interceptor: null });
    await page.close();
    check("and nothing is drawn when the host cannot say", !out.drawn, out);
  }
  // One missing: named, with what it costs.
  {
    const page = await browser.newPage();
    await stage(page, "<div id=modal></div>");
    await page.addStyleTag({ content: THEME });
    await page.addScriptTag({ content: SOURCE, type: "module" });
    await page.waitForFunction(() => !!window.__setup);
    const out = await open(page, { generation: true, interceptor: false });
    await page.close();
    check("a missing permission is named in the panel", out.drawn && /interceptor/.test(out.text), out.text.slice(0, 140));
    check("with what stops working without it", /refusal note/i.test(out.text), out.text.slice(0, 140));
    check("and the one that is granted is not listed", !/generation/.test(out.text), out.text.slice(0, 140));
  }
  // Refusing a permission on purpose is a fair answer, and a panel saying so on
  // every visit is nagging about a decision already made. Each note is put away
  // by name, so putting away the one you chose to refuse does not hide the next
  // one that goes missing for a reason you did not choose.
  {
    const page = await browser.newPage();
    await stage(page, "<div id=modal></div>");
    await page.addStyleTag({ content: THEME });
    await page.addScriptTag({ content: SOURCE, type: "module" });
    await page.waitForFunction(() => !!window.__setup);
    const res = await page.evaluate(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const acts = {};
      // Every handler, not just the newest. Opening the panel registers more of
      // these for its own one-off replies, and a stub that keeps only the last
      // one sends everything to whichever was registered most recently, which
      // silently drops the messages the extension actually listens for.
      const handlers = [];
      window.__setup(
        { events: { on: () => () => {} },
          sendToBackend: () => {},
          onBackendMessage: (fn) => {
            handlers.push(fn);
            return () => { const i = handlers.indexOf(fn); if (i >= 0) handlers.splice(i, 1); };
          },
          ui: { showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
                registerInputBarAction: (o) => { const a = { onClick: (cb) => { a.cb = cb; return () => {}; }, destroy: () => {} }; acts[o.id] = a; return a; } } },
        { liveLog: false, toast: false },
      );
      const send = (m) => { for (const h of handlers.slice()) h(m); };
      const say = (granted) => send({
        type: "permissions",
        list: [
          { name: "generation", costs: "Everything. Nothing is ever retried." },
          { name: "interceptor", costs: "The refusal note, and the Prompt tab." },
        ],
        granted: granted,
      });
      const openPanel = async () => { acts["auto-retry-settings"].cb(); await wait(50); };
      const box = () => document.querySelector("[data-ar-perms]");
      const shown = () => (box() && getComputedStyle(box()).display !== "none" ? box().textContent : "");
      const out = {};
      await wait(30);
      say({ generation: true, interceptor: false });
      await openPanel();
      out.before = shown();
      const cross = box().querySelector("button");
      out.hasCross = !!cross;
      cross.click();
      await wait(20);
      out.afterHiding = shown();
      // Reopening is where a note that was not really put away comes back, so
      // that is what is checked rather than the click alone.
      await openPanel();
      out.afterReopen = shown();
      // A different permission going missing is a different question, and is
      // still asked even though one note was put away.
      say({ generation: false, interceptor: false });
      await openPanel();
      out.newOne = shown();
      // Granted again, then taken away again. Putting a note away answers the
      // permission being off now, not for the rest of time.
      say({ generation: true, interceptor: true });
      await wait(20);
      say({ generation: true, interceptor: false });
      await openPanel();
      out.backAfterRegrant = shown();
      // Nothing about this is written down, so a reload brings every note back.
      try {
        out.stored = localStorage.getItem("lv-auto-retry:layout:v1") || "";
      } catch (e) { out.stored = "ERR"; }
      return out;
    });
    await page.close();
    check("a note carries a way to put it away", res.hasCross, res);
    check("and putting it away takes it off the panel", /interceptor/.test(res.before) && !/interceptor/.test(res.afterHiding), res);
    check("it stays away when the panel is opened again", !/interceptor/.test(res.afterReopen), res);
    check("but a different permission going missing is still said", /generation/.test(res.newOne), res);
  check("and a note comes back if the permission is granted and lost again", /interceptor/.test(res.backAfterRegrant), res);
  check("nothing about it is written down, so a reload brings them all back", res.stored.indexOf("perm") < 0, res.stored);
  }
}

// ---- the Prompt tab only blames the permission when it can ----
// A prompt is assembled at the start of a generation, which is when the
// interceptor runs and the only chance there is to capture it. Arming the tab
// after that cannot produce one for that generation however long it runs.
//
// The tab took that silence for a missing interceptor permission and said so.
// Sending a reply with the panel shut, or on the Log tab, and opening the
// Prompt tab while it ran was enough to be told the extension lacked a
// permission it had. It named the one thing the reader could not check and was
// wrong about it.
console.log("\nthe Prompt tab only blames the permission when it can");
{
  const blames = /needs the interceptor permission/;
  // Opened partway through: there was never a chance to capture, so the tab
  // asks for another reply rather than accusing anything.
  {
    const page = await browser.newPage();
    await stage(page, "<div id=modal></div>");
    await page.addStyleTag({ content: THEME });
    await page.addScriptTag({ content: SOURCE, type: "module" });
    await page.waitForFunction(() => !!window.__setup);
    const out = await page.evaluate(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const h = {};
      window.__setup(
        { events: { on: (n, fn) => { h[n] = fn; return () => {}; } },
          sendToBackend: () => {},
          onBackendMessage: () => () => {},
          ui: { showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
                registerInputBarAction: () => ({ onClick: () => () => {}, destroy: () => {} }) } },
        { liveLog: true, toast: false },
      );
      await wait(30);
      const tab = (name) => [...document.querySelectorAll('#__lvRetryLog [role="tab"]')]
        .find((b) => (b.textContent || "").trim() === name);
      // Reading the Log, which is where the panel starts. Capture is off.
      tab("Log").click();
      await wait(20);
      h.GENERATION_STARTED({ chatId: "c1", generationId: "g1", messageId: "m1" });
      await wait(20);
      // Now go and look at the prompt, mid-generation. This is what arms it.
      tab("Prompt").click();
      await wait(20);
      h.GENERATION_ENDED({ chatId: "c1", generationId: "g1", messageId: "m1", content: "hello" });
      await wait(30);
      return document.getElementById("__lvRetryLogBody").textContent;
    });
    await page.close();
    check("opening the tab partway through does not accuse the permission", !blames.test(out), out.slice(0, 130));
    check("and asks for another reply instead", /send a reply/i.test(out), out.slice(0, 130));
  }
  // Watching from the start and still nothing came: that is the real thing the
  // message is for, and it still says it.
  {
    const page = await browser.newPage();
    await stage(page, "<div id=modal></div>");
    await page.addStyleTag({ content: THEME });
    await page.addScriptTag({ content: SOURCE, type: "module" });
    await page.waitForFunction(() => !!window.__setup);
    const out = await page.evaluate(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const h = {};
      window.__setup(
        { events: { on: (n, fn) => { h[n] = fn; return () => {}; } },
          sendToBackend: () => {},
          onBackendMessage: () => () => {},
          ui: { showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
                registerInputBarAction: () => ({ onClick: () => () => {}, destroy: () => {} }) } },
        { liveLog: true, toast: false },
      );
      await wait(30);
      [...document.querySelectorAll('#__lvRetryLog [role="tab"]')]
        .find((b) => (b.textContent || "").trim() === "Prompt").click();
      await wait(20);
      h.GENERATION_STARTED({ chatId: "c1", generationId: "g1", messageId: "m1" });
      await wait(20);
      h.GENERATION_ENDED({ chatId: "c1", generationId: "g1", messageId: "m1", content: "hello" });
      await wait(30);
      const after = document.getElementById("__lvRetryLogBody").textContent;
      // Clear throws the prompt away, so it has to throw away what the tab was
      // saying about the reply that prompt came from.
      [...document.querySelectorAll("#__lvRetryLog button")]
        .find((b) => (b.textContent || "").trim() === "Clear").click();
      await wait(20);
      return { after: after, cleared: document.getElementById("__lvRetryLogBody").textContent };
    });
    await page.close();
    check("watching from the start with nothing arriving still names the permission", blames.test(out.after), out.after.slice(0, 130));
    check("and Clear takes that back too, rather than emptying the tab and going on saying it", !blames.test(out.cleared) && /send a reply/i.test(out.cleared), out.cleared.slice(0, 130));
  }
}

// ---- a prompt is only shown for the chat you are in ----
// Snapshots are addressed to a person rather than to a window, so two chats
// open in two tabs both receive every prompt either one produces. The tab
// showing chat B drew chat A's prompt without a word about it.
//
// The prompt is held either way and only its drawing is gated, because the
// snapshot and the events that say which chat you are in are not ordered
// against each other. A chat id that arrives late has to cost nothing.
console.log("\na prompt is only shown for the chat you are in");
{
  const page = await browser.newPage();
  await stage(page, "<div id=modal></div>");
  await page.addStyleTag({ content: THEME });
  await page.addScriptTag({ content: SOURCE, type: "module" });
  await page.waitForFunction(() => !!window.__setup);
  const out = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const handlers = {};
    // As many listeners as are registered, like the host. Keeping only the last
    // one meant a per-request handler replaced the main one, so a snapshot sent
    // from here reached nobody.
    let msgCbs = [];
    const fromBackend = (m) => { for (const cb of msgCbs.slice()) { try { cb(m); } catch (_) {} } };
    window.__setup(
      { events: { on: (n, fn) => { handlers[n] = fn; return () => {}; } },
        sendToBackend: () => {},
        onBackendMessage: (fn) => { msgCbs.push(fn); return () => { msgCbs = msgCbs.filter((x) => x !== fn); }; },
        ui: { showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
              registerInputBarAction: () => ({ onClick: () => () => {}, destroy: () => {} }) } },
      { liveLog: true, toast: false },
    );
    await wait(30);
    [...document.querySelectorAll('#__lvRetryLog [role="tab"]')]
      .find((b) => (b.textContent || "").trim() === "Prompt").click();
    await wait(20);
    const shown = () => document.getElementById("__lvRetryLogBody").textContent;
    const send = (chatId) => fromBackend({
      type: "prompt_snapshot", at: Date.now(), chatId: chatId, total: 1, notes: 0,
      messages: [{ role: "user", content: "prompt for " + chatId, history: true, note: false }],
    });
    const res = {};

    // Nothing knows which chat this is yet. A guess is worse than the prompt
    // somebody asked to see, so an unknown chat counts as a match.
    send("A");
    await wait(20);
    res.shownWhenChatUnknown = /prompt for A/.test(shown());

    // Now in chat A. Still its prompt.
    handlers.CHAT_SWITCHED({ chatId: "A" });
    await wait(20);
    res.shownInItsOwnChat = /prompt for A/.test(shown());

    // Walk into chat B without generating. A's prompt is not B's.
    handlers.CHAT_SWITCHED({ chatId: "B" });
    await wait(20);
    res.hiddenInAnotherChat = !/prompt for A/.test(shown());
    res.saysWhy = /different chat/i.test(shown());

    // Back to A. The prompt was held, not thrown away, so it is there again.
    handlers.CHAT_SWITCHED({ chatId: "A" });
    await wait(20);
    res.cameBackOnReturn = /prompt for A/.test(shown());

    // The other tab's case: a prompt arrives for a chat this window is not in.
    send("B");
    await wait(20);
    res.otherChatsPromptNotDrawn = !/prompt for B/.test(shown());

    // And the ordering case this design exists for: the snapshot lands before
    // anything says which chat it was. Held, so the switch reveals it.
    handlers.CHAT_SWITCHED({ chatId: "B" });
    await wait(20);
    res.lateChatIdStillShows = /prompt for B/.test(shown());
    return res;
  });
  await page.close();
  check("a prompt is drawn while the chat is still unknown", out.shownWhenChatUnknown, out);
  check("and in the chat it belongs to", out.shownInItsOwnChat, out);
  check("it is not drawn in a different chat", out.hiddenInAnotherChat, out);
  check("and the tab says why rather than going blank", out.saysWhy, out);
  check("it comes back on returning to its own chat, so nothing was thrown away", out.cameBackOnReturn, out);
  check("a prompt for a chat this window is not in is not drawn", out.otherChatsPromptNotDrawn, out);
  check("and a chat id that arrives after the prompt costs nothing", out.lateChatIdStillShows, out);
}

// ---- the Prompt tab draws the prompt two ways ----
// Rendered is the panel as it has always looked, and the default: a row per
// message with its role, its size, and whether it came from the chat or was
// wrapped around it. Raw is the same prompt with all of that taken off, as the
// data the model was handed, which is the form to read for structure and the
// form to paste somewhere else.
console.log("\nthe Prompt tab has a rendered and a raw view");
{
  const page = await browser.newPage();
  await stage(page, "<div id=modal></div>");
  await page.addStyleTag({ content: THEME });
  await page.addScriptTag({ content: SOURCE, type: "module" });
  await page.waitForFunction(() => !!window.__setup);
  const out = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    // As many listeners as are registered, like the host.
    let msgCbs = [];
    const fromBackend = (m) => { for (const cb of msgCbs.slice()) { try { cb(m); } catch (_) {} } };
    window.__setup(
      { events: { on: () => () => {} },
        sendToBackend: () => {},
        onBackendMessage: (fn) => { msgCbs.push(fn); return () => { msgCbs = msgCbs.filter((x) => x !== fn); }; },
        ui: { showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
              registerInputBarAction: () => ({ onClick: () => () => {}, destroy: () => {} }) } },
      { liveLog: true, toast: false },
    );
    await wait(30);
    const viewBtn = () =>
      [...document.querySelectorAll("#__lvRetryLogBody button")]
        .find((b) => /^(Raw|Rendered)$/.test((b.textContent || "").trim()));
    const res = {};
    res.notInTheHeader =
      ![...document.querySelectorAll("#__lvRetryLog > div button")]
        .some((b) => /^(Raw|Rendered)$/.test((b.textContent || "").trim()));
    res.notOnTheLogTab = !viewBtn();
    [...document.querySelectorAll('#__lvRetryLog [role="tab"]')]
      .find((b) => (b.textContent || "").trim() === "Prompt").click();
    await wait(20);
    fromBackend({
      type: "prompt_snapshot", at: 1, chatId: "c1", total: 2, notes: 1,
      messages: [
        { role: "system", content: "You are a tavern keeper.", history: false, note: false },
        { role: "user", content: "she *turned* and said <b>no</b>", history: true, note: true, noteIndex: 1 },
      ],
    });
    await wait(30);
    const body = () => document.getElementById("__lvRetryLogBody");
    const raw = () => body().querySelector("[data-ar-raw]");

    // Rendered is where it starts, and it is the panel as it was.
    res.startsRendered = (viewBtn().textContent || "").trim() === "Rendered";
    res.renderedHasRows = body().querySelectorAll("details").length === 2;
    res.renderedHasNoRawBlock = !raw();
    res.renderedMarksTheNote = /Auto Retry note/.test(body().textContent);

    // The switch sits under the count, on its own line, and cannot move when
    // pressed: the label is the state, so its width changes with it.
    const countLine = [...body().children].find((el) => /messages,/.test(el.textContent || ""));
    const before = viewBtn().getBoundingClientRect();
    res.underTheCount = !!countLine &&
      countLine.compareDocumentPosition(viewBtn()) & Node.DOCUMENT_POSITION_FOLLOWING &&
      viewBtn().getBoundingClientRect().top >= countLine.getBoundingClientRect().bottom - 1;

    viewBtn().click();
    await wait(30);
    const after = viewBtn().getBoundingClientRect();
    res.didNotMove =
      Math.abs(after.left - before.left) < 1 &&
      Math.abs(after.top - before.top) < 1 &&
      Math.abs(after.width - before.width) < 1;

    // Raw: the data the model was handed, and none of the panel's own labelling.
    res.nowRaw = (viewBtn().textContent || "").trim() === "Raw";
    res.rawHasBlock = !!raw();
    res.rawHasNoRows = body().querySelectorAll("details").length === 0;
    let parsed = null;
    try { parsed = JSON.parse(raw().textContent); } catch (_) {}
    res.rawIsData =
      Array.isArray(parsed) && parsed.length === 2 &&
      parsed[0].role === "system" && parsed[1].content === "she *turned* and said <b>no</b>";
    // Role and content are what crossed to the model. The chat-or-added marks
    // and the note flag are this panel's, so they are not in the data.
    res.rawIsOnlyWhatWentOut =
      !!parsed && Object.keys(parsed[0]).sort().join(",") === "content,role";
    res.rawKeepsMarkupAsText = body().querySelectorAll("[data-ar-raw] b").length === 0;
    res.remembered = JSON.parse(localStorage.getItem("lv-auto-retry:layout:v1") || "{}").promptView;
    return res;
  });
  await page.close();
  check("the switch stays out of the header the three tabs share", out.notInTheHeader, out);
  check("and is not drawn on a tab it means nothing on", out.notOnTheLogTab, out);
  check("rendered is where it starts", out.startsRendered, out);
  check("rendered is the panel as it was, rows and all", out.renderedHasRows && out.renderedHasNoRawBlock, out);
  check("with the note still marked", out.renderedMarksTheNote, out);
  check("the switch sits under the count on its own line", !!out.underTheCount, out);
  check("and does not move or resize when pressed", out.didNotMove, out);
  check("raw replaces the rows with the prompt as data", out.nowRaw && out.rawHasBlock && out.rawHasNoRows, out);
  check("the data is the messages the model was handed", out.rawIsData, out);
  check("carrying only what went out, not the panel's own marks", out.rawIsOnlyWhatWentOut, out);
  check("and markup in it stays text", out.rawKeepsMarkupAsText, out);
  check("the choice is remembered", out.remembered === "raw", out);
}

// ---- the panel asks for prompts again when the backend comes back ----
// Asking the backend to capture prompts is a live request, and the two sides
// have separate lifetimes. Sending it only when the answer changes leaves a
// backend that was not listening yet, or that restarted, knowing nothing while
// the panel is certain it has asked, and the Prompt tab stays empty until the
// view is toggled off and on.
//
// The backend says when it has started, and this is the panel hearing it.
console.log("\nthe Prompt tab re-arms when the backend restarts");
{
  const page = await browser.newPage();
  await stage(page, "<div id=modal></div>");
  await page.addStyleTag({ content: THEME });
  await page.addScriptTag({ content: SOURCE, type: "module" });
  await page.waitForFunction(() => !!window.__setup);
  const out = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const sent = [];
    // As many listeners as are registered, like the host.
    let msgCbs = [];
    const fromBackend = (m) => { for (const cb of msgCbs.slice()) { try { cb(m); } catch (_) {} } };
    window.__setup(
      { events: { on: () => () => {} },
        sendToBackend: (m) => sent.push(m),
        onBackendMessage: (fn) => { msgCbs.push(fn); return () => { msgCbs = msgCbs.filter((x) => x !== fn); }; },
        ui: { showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
              registerInputBarAction: () => ({ onClick: () => () => {}, destroy: () => {} }) } },
      { liveLog: true, toast: false },
    );
    await wait(30);
    const arms = () => sent.filter((m) => m && m.type === "set_prompt_capture" && m.on).length;
    // Open the Prompt tab, which is the one thing that asks.
    const tab = [...document.querySelectorAll('#__lvRetryLog [role="tab"], #__lvRetryLog button')]
      .find((b) => (b.textContent || "").trim() === "Prompt");
    if (!tab) return { err: "no Prompt tab" };
    tab.click();
    await wait(30);
    const askedOnce = arms();
    // Pressing it again is not a change, so it stays at one. This is the
    // behaviour being kept, not the bug.
    tab.click();
    await wait(30);
    const afterSameTab = arms();
    // The backend says it has just started. Whatever it was told is gone.
    fromBackend({ type: "backend_ready" });
    await wait(30);
    return { askedOnce, afterSameTab, afterReady: arms() };
  });
  await page.close();
  check("opening the Prompt tab asks the backend to capture", out.askedOnce === 1, out);
  check("and asking twice for the same view does not repeat it", out.afterSameTab === 1, out);
  check("a backend that says it just started is asked again", out.afterReady === 2, out);
}

// ---- resizing the button leaves it where it is ----
// The arithmetic check above holds one resize. This holds a run of them, which
// is what the report was: a button that walked up the screen as the size was
// dragged and stopped only when it ran out of screen.
//
// The mechanism was a feedback loop. A size change rebuilds the widget, and the
// position for the rebuild was read back off the screen, so any disagreement
// between what was measured and where the button really was got fed in again on
// the next change and added up. Each host below is run through fourteen size
// changes in a row: a position that holds for fourteen is not accumulating.
//
// The second host is the one that matters. Its root does not carry the widget's
// own box, which a measurement of the middle cannot tell apart from a button
// sitting higher up, and it is why measuring is gone from this path.
console.log("\nresizing the floating button does not walk it up the screen");
{
  const trails = {};
  for (const kind of ["sized", "unsized"]) {
    const page = await browser.newPage({ viewport: { width: 400, height: 800 } });
    await stage(page, "<div id=modal></div>");
    await page.addStyleTag({ content: THEME });
    await page.addScriptTag({ content: SOURCE, type: "module" });
    await page.waitForFunction(() => !!window.__setup);
    trails[kind] = await page.evaluate(async (kind) => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const acts = {};
      let host = null;
      let wrap = null;
      window.__setup(
        { events: { on: () => () => {} },
          ui: { showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
                registerInputBarAction: (o) => {
                  const a = { onClick: (cb) => { a.cb = cb; return () => {}; }, destroy: () => {} };
                  acts[o.id] = a; return a; },
                showContextMenu: (o) => { (window.__menus ||= []).push(o); return Promise.resolve({ selectedKey: window.__pick === undefined ? null : window.__pick }); },
                createFloatWidget: (o) => {
                  wrap = document.createElement("div");
                  wrap.style.cssText = "position:fixed;left:" + o.initialPosition.x + "px;top:" +
                    o.initialPosition.y + "px;width:" + o.width + "px;height:" + o.height + "px";
                  document.body.appendChild(wrap);
                  if (kind === "sized") { host = wrap; }
                  else {
                    host = document.createElement("div");
                    host.style.cssText = "position:absolute;left:0;top:0;width:0;height:0";
                    wrap.appendChild(host);
                  }
                  return { root: host, destroy() { wrap.remove(); }, setPosition() {}, onDragEnd() { return () => {}; } }; } } },
        { enabled: true, showFloatingToggle: true, floatingToggleSize: 44, toast: false },
      );
      await wait(30);
      // Put it partway down the right edge and let the settle read record it,
      // which is how a drag tells the extension where the button now lives.
      wrap.style.left = "348px";
      wrap.style.top = "500px";
      wrap.querySelector("button").dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
      await wait(500);
      const midY = () => { const r = wrap.getBoundingClientRect(); return Math.round(r.top + r.height / 2); };
      const before = midY();
      acts["auto-retry-settings"].cb();
      await wait(40);
      const box = document.querySelector('[data-ar-row="floatingToggleSize"] input');
      const trail = [];
      for (const v of [46, 48, 50, 52, 54, 56, 58, 60, 62, 64, 66, 68, 70, 72]) {
        box.value = String(v);
        box.dispatchEvent(new Event("input", { bubbles: true }));
        await wait(12);
        trail.push(midY());
      }
      return { before, trail };
    }, kind);
    await page.close();
  }
  for (const kind of ["sized", "unsized"]) {
    const t = trails[kind];
    const held = t.trail.every((y) => y === t.before);
    const label = kind === "sized" ? "a host that reports the widget box" : "a host whose root does not carry the size";
    check(label + " holds the button still through fourteen size changes", held,
      { started: t.before, went: t.trail });
  }
}

// ---- every indicator says the same thing about the chat you are in ----
// Three things show whether Auto Retry is on: the row in the panel, the
// floating button, and the Extras entry. The first two are repainted, and the
// third has to be registered again to change its label, which is why it was the
// one that went on saying "on" in a chat that had just been switched off.
//
// The last two are never on screen together: the Extras button is hidden while
// the floating button is on, because the floating button is that same switch.
// So this runs twice, once with each of them, and reads whichever is there.
console.log("\nthe per-chat switch reaches every indicator");
for (const withButton of [true, false]) {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  await stage(page, "<div id=modal></div>");
  await page.addStyleTag({ content: THEME });
  await page.addScriptTag({ content: SOURCE, type: "module" });
  await page.waitForFunction(() => !!window.__setup);
  const out = await page.evaluate(async (withButton) => {
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const handlers = {};
    const acts = {};
    const labels = {};
    let floatRoot = null;
    window.__setup(
      { events: { on: (n, fn) => { handlers[n] = fn; return () => {}; } },
        ui: { showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
              registerInputBarAction: (o) => {
                labels[o.id] = o.label;
                const a = { onClick: (cb) => { a.cb = cb; return () => {}; }, destroy: () => { delete labels[o.id]; } };
                acts[o.id] = a; return a; },
              showContextMenu: (o) => { (window.__menus ||= []).push(o); return Promise.resolve({ selectedKey: window.__pick === undefined ? null : window.__pick }); },
              createFloatWidget: () => {
                floatRoot = document.createElement("div");
                document.body.appendChild(floatRoot);
                return { element: floatRoot, root: floatRoot, setPosition() {},
                         destroy() { floatRoot.remove(); floatRoot = null; },
                         onDragEnd() { return () => {}; } }; } } },
      { toast: false, showFloatingToggle: withButton, showExtrasToggle: true },
    );
    const row = () => document.querySelector("[data-ar-chat-switch]");
    const act = () => row() && row().querySelector("button");
    const snap = () => {
      const fb = floatRoot && floatRoot.querySelector("button");
      return { row: act() ? act().textContent.trim() : "",
               float: fb ? (fb.getAttribute("aria-label") || "") : "",
               extras: labels["auto-retry-toggle"] || "" };
    };
    acts["auto-retry-settings"].cb();
    await frame();
    handlers.CHARACTER_MESSAGE_RENDERED({ chatId: "chat-a", messageId: "m1" });
    await frame();
    const on = snap();
    act().click();
    await frame();
    const off = snap();
    handlers.CHAT_CHANGED({ chatId: "chat-b" });
    await frame();
    const elsewhere = snap();
    handlers.CHAT_CHANGED({ chatId: "chat-a" });
    await frame();
    const backAgain = snap();
    act().click();
    await frame();
    const onAgain = snap();
    return { on, off, elsewhere, backAgain, onAgain };
  }, withButton);
  // The one that carries the state outside the panel in this run. The other is
  // empty, and an empty string would pass "does not say off" for free.
  const side = (s) => (withButton ? s.float : s.extras);
  const saysOff = (s) => !!side(s) && /off in this chat/i.test(side(s)) && s.row === "Turn on here";
  const saysOn = (s) => !!side(s) && !/off in this chat/i.test(side(s)) && s.row === "Turn off here";
  const n = withButton ? "with the floating button" : "with the Extras entry";
  check(n + ": both read on before anything is switched off", saysOn(out.on), out.on);
  check(n + ": and both say off in this chat the moment it is", saysOff(out.off), out.off);
  check(n + ": the one outside the panel in particular, which used to keep saying on",
    /off in this chat/i.test(side(out.off)), side(out.off));
  check(n + ": switching to a chat that is on puts both back", saysOn(out.elsewhere), out.elsewhere);
  check(n + ": walking back into the one that is off says so again", saysOff(out.backAgain), out.backAgain);
  check(n + ": and turning it back on here clears both", saysOn(out.onAgain), out.onAgain);
  check(n + ": the other surface is not up at the same time",
    (withButton ? out.off.extras : out.off.float) === "", out.off);
  check(n + ": no console errors", errors.length === 0, errors);
  await page.close();
}


// ---- a panel that comes back does not inherit the asking ----
// Capture follows the panel now rather than the tab, so the thing that has to
// hold is that closing it forgets. Otherwise asking for a prompt once would
// pay for itself every time the panel came back, which is the cost tying it to
// the tab was avoiding in the first place.
console.log("\nreopening the panel after asking for a prompt");
{
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await stage(page, "<div id=modal></div>");
  await page.addStyleTag({ content: THEME });
  await page.addScriptTag({ content: SOURCE, type: "module" });
  await page.waitForFunction(() => !!window.__setup);
  const out = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const open = (sent) => window.__setup(
      { events: { on: () => () => {} },
        sendToBackend: (m) => sent.push(m),
        onBackendMessage: () => () => {},
        ui: { showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
              registerInputBarAction: () => ({ onClick: () => () => {}, destroy: () => {} }) } },
      { liveLog: true, toast: false },
    );
    const tab = (label) => [...document.querySelectorAll('[role="tab"]')]
      .find((b) => b.textContent.trim() === label);
    const capture = (sent) => sent.filter((m) => m.type === "set_prompt_capture").map((m) => m.on);

    // First time round: ask for a prompt, then go back to the log and close.
    const first = [];
    let teardown = open(first);
    await wait(30);
    tab("Prompt").click();
    await wait(20);
    const asked = capture(first);
    tab("Log").click();
    await wait(20);
    teardown();
    await wait(20);
    const afterClosing = capture(first);

    // Second time round, landing on the log, which is where it was left.
    const second = [];
    teardown = open(second);
    await wait(40);
    const landedOn = tab("Log") ? tab("Log").getAttribute("aria-selected") : null;
    const askedAgain = capture(second);
    // And asking afresh still works.
    tab("Prompt").click();
    await wait(20);
    const afterAskingAgain = capture(second);
    teardown();
    return { asked, afterClosing, landedOn, askedAgain, afterAskingAgain };
  });
  await page.close();
  check("the first panel asks once the prompt tab is opened",
    out.asked[out.asked.length - 1] === true, out.asked);
  check("and stops asking when it closes",
    out.afterClosing[out.afterClosing.length - 1] === false, out.afterClosing);
  check("the next panel opens where it was left", out.landedOn === "true", out);
  check("and asks for nothing, having not been asked",
    out.askedAgain.filter((v) => v).length === 0, out.askedAgain);
  check("until the prompt tab is opened again",
    out.afterAskingAgain[out.afterAskingAgain.length - 1] === true, out.afterAskingAgain);
  check("no console errors", errors.length === 0, errors);
}

// ---- the prompt viewer ----
// Lumiverse's own Prompt Breakdown lists what a chat is built from, which is a
// different question from what actually went to the model after every extension
// has had its turn. The interceptor is the one place that sees the second one,
// so the panel shows it. Off unless asked for: a whole prompt crosses the
// bridge on every reply, and it is the text of someone's chat.
console.log("\nprompt viewer");
{
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await stage(page, "<div id=modal></div>");
  await page.addStyleTag({ content: THEME });
  await page.addScriptTag({ content: SOURCE, type: "module" });
  await page.waitForFunction(() => !!window.__setup);
  const out = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    let msgCbs = [];
    const onBackend = (m) => { for (const cb of msgCbs.slice()) { try { cb(m); } catch (_) {} } };
    let tabs0 = false;
    const sent = [];
    const teardown = window.__setup(
      {
        events: { on: () => () => {} },
        sendToBackend: (m) => sent.push(m),
        onBackendMessage: (cb) => { msgCbs.push(cb); return () => { msgCbs = msgCbs.filter((x) => x !== cb); }; },
        ui: {
          showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
          registerInputBarAction: () => ({ onClick: () => () => {}, destroy: () => {} }),
        },
      },
      { liveLog: true, toast: false },
    );
    await wait(30);
    const panel = () => document.getElementById("__lvRetryLog");
    const tab = (label) => [...document.querySelectorAll('[role="tab"]')]
      .find((b) => b.textContent.trim() === label);
    const body = () => document.getElementById("__lvRetryLogBody");

    const opened = !!panel();
    const tabs = [...document.querySelectorAll('[role="tab"]')].map((b) => b.textContent.trim());
    // One switch, one panel, two tabs. It opens on the log.
    const landedOn = tab("Log") ? tab("Log").getAttribute("aria-selected") : null;
    // Nothing is captured while nobody is looking at a prompt.
    const askedBefore = sent.filter((m) => m.type === "set_prompt_capture").map((m) => m.on);

    tab("Prompt").click();
    await wait(20);
    const askedAfter = sent.filter((m) => m.type === "set_prompt_capture").map((m) => m.on);
    const beforeAny = body() ? body().textContent : "";

    // What the backend sends after an interceptor pass.
    onBackend({
      type: "prompt_snapshot",
      at: Date.now(),
      chatId: "c1",
      // Whole messages, since that is what the backend sends. The last one is
      // long on purpose: a cap would show here as a truncated message with a
      // line under it saying how much is missing.
      messages: [
        { role: "system", content: "You are a tavern keeper.", history: false },
        { role: "user", content: "I sat down by the fire.", history: true },
        { role: "system", content: "This was refused by mistake.", history: false, note: true, noteIndex: 1 },
        { role: "assistant", content: "q".repeat(9000), history: true },
      ],
      total: 4,
      notes: 1,
    });
    await wait(30);
    const shown = body() ? body().textContent : "";
    const rows = body() ? body().querySelectorAll("details").length : 0;
    // "added" versus "chat" is the distinction that matters when a prompt
    // misbehaves: what came from the conversation and what was wrapped round it.
    // Read from the label span rather than the whole summary, which also
    // carries a preview of the message and could contain the word by chance.
    const marks = body()
      ? [...body().querySelectorAll("details summary")].map((h) => {
          const label = h.children[1] ? h.children[1].textContent : "";
          return /note/i.test(label) ? "note" : /chat/.test(label) ? "chat" : "added";
        })
      : [];
    // Nothing is trimmed, so nothing in the view talks about trimming. Capping
    // a message and saying how much is missing is the one thing a reader cannot
    // work around: what was cut only ever existed on the server.
    const saysNothingAboutTrimming =
      !/more characters were sent to the model/.test(shown) &&
      !/only this view is shortened/i.test(shown) &&
      !/cut for display/i.test(shown) &&
      !/not listed below/i.test(shown);
    // Every message whole, as sent. The long one is the test.
    const wholeLongMessage = shown.indexOf("q".repeat(6000)) >= 0;

    // Where the note went is the question this view is opened for.
    const noteLine = /Auto Retry note/.test(shown);
    const notePlace = /at position 3 of 4/.test(shown);
    const noteRow = body()
      ? [...body().querySelectorAll("details")].find((d) => /Auto Retry note/.test(d.textContent))
      : null;
    const noteOpen = !!(noteRow && noteRow.open);

    // Arrow keys move between tabs for anyone driving this from a keyboard.
    tab("Prompt").focus();
    tabs0 = document.activeElement === tab("Prompt");
    document.querySelector('[role="tablist"]')
      .dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    await wait(20);
    const afterArrow = tab("Log").getAttribute("aria-selected");
    const afterLogTab = body() ? body().textContent : "";
    // Switching to another view does not stop it. Losing the prompt you sent
    // while glancing at the log is most of what anybody does with the panel
    // open, and the panel closing is what stops it.
    const askedOnLeave = sent.filter((m) => m.type === "set_prompt_capture").map((m) => m.on);

    // Big enough to hit with a thumb.
    const tabBox = tab("Prompt").getBoundingClientRect();

    teardown();
    const gone = !panel();
    const askedOnTeardown = sent.filter((m) => m.type === "set_prompt_capture").map((m) => m.on);
    return { opened, tabs, landedOn, beforeAny, shown, rows, marks, saysNothingAboutTrimming, wholeLongMessage, afterLogTab,
      gone, askedBefore, askedAfter, askedOnLeave, askedOnTeardown, noteLine, notePlace,
      noteOpen, tabFocus: tabs0, afterArrow, tabH: Math.round(tabBox.height) };
  });
  await page.close();
  check("one switch opens the panel", out.opened, out);
  check("with every view in it", out.tabs.join(",") === "Log,Prompt,Stats,Replaced", out.tabs);
  check("and it opens on the log", out.landedOn === "true", out.landedOn);
  // The reason there is no second setting: the cost is only paid while somebody
  // is actually looking at a prompt.
  check("nothing is captured until the prompt tab is opened",
    out.askedBefore.filter((v) => v).length === 0, out.askedBefore);
  check("opening it asks for capture", out.askedAfter[out.askedAfter.length - 1] === true, out.askedAfter);
  check("looking at another view does not stop it",
    out.askedOnLeave[out.askedOnLeave.length - 1] === true, out.askedOnLeave);

  check("and so does closing the panel",
    out.askedOnTeardown[out.askedOnTeardown.length - 1] === false, out.askedOnTeardown);
  check("it says nothing has been seen yet before a generation",
    /no prompt seen yet/i.test(out.beforeAny), out.beforeAny.slice(0, 80));
  check("a snapshot fills it in", out.rows === 4, out.rows);
  check("with a summary of the size", /4 messages/.test(out.shown), out.shown.slice(0, 120));
  check("marking what came from the chat, what was added, and what is ours",
    out.marks.join(",") === "added,chat,note,chat", out.marks);
  check("a long message arrives whole", out.wholeLongMessage, out.shown.length);
  check("and nothing in the view talks about trimming", out.saysNothingAboutTrimming, out.shown.slice(0, 160));
  // What the panel is for, in the user's words: knowing how and where a note
  // was inserted.
  check("a note is named rather than being one more added row", out.noteLine, out.shown.slice(0, 200));
  check("and the view says where in the prompt it landed", out.notePlace, out.shown.slice(0, 200));
  check("and opens it, since that is what was come for", out.noteOpen, out);
  check("the tabs are big enough for a thumb", out.tabH >= 30, out.tabH);
  check("a tab can be focused", out.tabFocus, out);
  check("and the arrows move between them", out.afterArrow === "true", out.afterArrow);
  // The startup line, which the log always carries, so switching back is
  // visibly the log and not a leftover of the prompt view.
  check("the log tab still shows the log",
    /ready v/.test(out.afterLogTab) && !/tavern keeper/.test(out.afterLogTab),
    out.afterLogTab.slice(0, 80));
  check("teardown takes the panel with it", out.gone, out);
  check("no console errors", errors.length === 0, errors);
}

// ---- taking a note back is scoped to the chat it was armed for ----
// Taking a note back was first written as a single flag, which said a note was
// waiting but not which chat it was waiting on. Cancelling a retry in one chat
// then took back a note armed for a different one, and that chat's next retry
// went out bare with nothing to say why. Two chats in flight at once is the
// only way to see it, so nothing else here would have caught it.
console.log("\ntaking a note back");
{
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  await stage(page, '<div id=modal></div><button data-testid="regenerate">Regenerate</button>');
  await page.addStyleTag({ content: THEME });
  await page.addScriptTag({ content: SOURCE, type: "module" });
  await page.waitForFunction(() => !!window.__setup);

  const out = await page.evaluate(async () => {
    const handlers = {};
    const sent = [];
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const teardown = window.__setup(
      {
        events: { on: (n, fn) => { handlers[n] = fn; return () => {}; } },
        sendToBackend: (m) => sent.push(m),
        onBackendMessage: () => () => {},
        ui: { showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
              registerInputBarAction: () => ({ onClick: () => () => {}, destroy: () => {} }) },
      },
      // fromTry 1, so the single round below is enough for the note to be due.
      { refusalNote: true, refusalNotes: [{ text: "This was refused by mistake.", role: "system", fromTry: 1 }],
        retryDelayMs: 10, backoffFactor: 1, maxDelayMs: 10, jitter: false,
        maxRetries: 4, toast: false, stuckTimeoutMs: 0, idleTimeoutMs: 0, pauseWhenFailing: false },
    );
    const REFUSED = { content: "I'm sorry, but I can't create that content." };

    // Chat A refuses and its retry fires, so a note is armed and waiting on the
    // generation that click started.
    handlers.GENERATION_STARTED({ chatId: "A", generationId: "a1" });
    handlers.GENERATION_ENDED(Object.assign({ chatId: "A" }, REFUSED));
    await wait(60);
    const armedForA = sent.filter((m) => m.type === "arm_refusal_note" && (m.notes || []).length).length;

    // Chat B refuses too, so it has a retry pending, and then the user stops it.
    // B never got as far as arming anything of its own.
    handlers.GENERATION_STARTED({ chatId: "B", generationId: "b1" });
    handlers.GENERATION_ENDED(Object.assign({ chatId: "B" }, REFUSED));
    handlers.GENERATION_STOPPED({ chatId: "B", generationId: "b1" });
    await wait(60);
    const disarms = sent.filter((m) => m.type === "arm_refusal_note" && !(m.notes || []).length);

    teardown();
    return { armedForA, disarmChats: disarms.map((m) => m.chatId) };
  });
  await page.close();

  check("chat A armed a note", out.armedForA > 0, out);
  // On the id the message carries, not on whether one was sent: the flag
  // version sent a disarm here too, stamped with chat B, and the backend holds
  // one note at a time so that took chat A's away. Sending nothing at all is
  // the only outcome that leaves A's note where it belongs.
  check("stopping a retry in chat B takes nothing back at all",
    out.disarmChats.length === 0, out.disarmChats);
  check("no console errors", errors.length === 0, errors);
}

// ---- a filled button has to look like one ----
// Repainting the label fixed half of this. On a theme whose accent sits near
// the panel colour, Save stayed legible and lost its edge, so nothing said it
// was a button. It gets a border only when its fill has all but vanished, and
// a theme with an ordinary accent must be left completely alone.
console.log("\nbutton edges");
{
  const read = async (css) => {
    const { out, errors } = await inPanel(browser, { css }, async (page) =>
      page.evaluate(() => {
        const by = (t) => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === t);
        const seen = (b) => {
          const cs = getComputedStyle(b);
          return { border: cs.borderTopColor, bg: cs.backgroundColor, colour: cs.color };
        };
        return { save: seen(by("Save")), reset: seen(by("Reset\u2026")) };
      }),
    );
    return { out, errors };
  };
  const clear = (c) => c === "rgba(0, 0, 0, 0)" || c === "transparent";

  const stock = await read("");
  check("on a normal theme the filled button keeps no border",
    clear(stock.out.save.border), stock.out.save);
  check("and its fill is still the theme's accent",
    !clear(stock.out.save.bg), stock.out.save.bg);
  check("no console errors", stock.errors.length === 0, stock.errors);

  // An accent all but identical to the panel behind it.
  const pale = await read(
    "#modal{background:rgb(250,249,253)}body{background:rgb(245,244,250)}" +
    ":root{--lumiverse-primary:rgba(250,248,255,.95);--lumiverse-text:rgba(20,18,26,.92);" +
    "--lumiverse-bg-elevated:rgba(248,246,252,.95);--lumiverse-card-bg-solid:rgb(250,249,253)}",
  );
  check("on a theme whose accent has vanished it gets one",
    !clear(pale.out.save.border), pale.out.save);
  check("and the label is still readable against the fill",
    pale.out.save.colour !== pale.out.save.bg, pale.out.save);
  // The edge fix paints in near-white or near-black. A secondary button must
  // keep the theme's own border colour, which is quieter on purpose, so seeing
  // either of those there means the fix reached a button it should not have.
  const FORCED = ["rgb(255, 255, 255)", "rgb(20, 18, 26)"];
  check("the secondary button keeps the theme's own border, not a forced one",
    !FORCED.includes(stock.out.reset.border) && !FORCED.includes(pale.out.reset.border),
    { stock: stock.out.reset.border, pale: pale.out.reset.border });
  check("no console errors on that theme", pale.errors.length === 0, pale.errors);

  // A mid-grey pair chosen so the two candidate edge colours disagree: judged
  // against the panel behind the button, near-black wins (4.70 to 3.95); judged
  // against the button's own fill, white wins (5.25 to 3.54). The edge has to
  // separate the button from what is behind it, so the panel is the right
  // reference. Without a case like this, using the fill instead looks correct.
  const mid = await read(
    "#modal{background:rgb(128,128,128)}body{background:rgb(128,128,128)}" +
    ":root{--lumiverse-primary:rgb(108,108,108);--lumiverse-bg-elevated:rgb(128,128,128);" +
    "--lumiverse-card-bg-solid:rgb(128,128,128)}",
  );
  check("the edge is judged against the panel, not the button's own fill",
    mid.out.save.border === "rgb(20, 18, 26)", mid.out.save);
  check("no console errors on that one", mid.errors.length === 0, mid.errors);
}

// ---- adding and removing notes ----
// A note can answer the one before it, so the list needs a way to grow and
// shrink. Ten is the ceiling and one is the floor: removing the last note would
// leave nothing to type into.
// ---- a description opens under the setting it describes ----
// Flipping above the row when there is no room below opens a long description
// somewhere none of the others do: you look under the setting and the text is
// over it instead. It stays below and scrolls.
console.log("\nhint placement");
{
  // A short viewport with a scrolling panel, so a row can be pushed low enough
  // that its description will not fit underneath.
  const PANEL = "#modal{position:fixed;inset:12px;overflow:auto;background:rgb(24,20,34);padding:10px;box-sizing:border-box}";
  // Shared by the checks below: they all want the longest description there is.
  const want = longestHintKey();
  // The long one, on a viewport too short to fit it under the row.
  {
    // A long description on a row of ordinary height. Naming the row here goes
    // stale as soon as that row moves behind a switch or its description is
    // shortened, so the longest one is worked out from the schema instead.
    // Rows behind a switch are skipped, since they are not on screen by
    // default, and so is the note list, which opens above on purpose.
    //
    // The height is what leaves less room under the row than the description
    // needs, so the cap has something to fire on. Measured at 98 of room
    // against 122 of description. Shorten the descriptions again and this has
    // to come down with them, or the cap stops being exercised.
    const { out, errors } = await inPanel(
      browser, { css: PANEL, viewport: { width: 393, height: 280 }, settings: { refusalNote: true } },
      async (page) => page.evaluate(async (want) => {
        const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        for (const h of document.querySelectorAll('[role="button"][aria-expanded="false"]')) h.click();
      // Sections travel open now, so their contents have no height for the
      // length of that. Waited out here rather than in every check below.
      await new Promise((r) => setTimeout(r, 260));
        await frame();
        const row = document.querySelector('[data-ar-row="' + want + '"]');
        if (!row) return { err: "no row" };
        row.scrollIntoView({ block: "end" });
        await frame();
        row.querySelector("[data-ar-hint]").dispatchEvent(new MouseEvent("mouseenter"));
        await frame();
        const tip = document.querySelector('[role="tooltip"]');
        if (!tip) return { err: "no tip" };
        const rr = row.getBoundingClientRect();
        const tr = tip.getBoundingClientRect();
        const cs = getComputedStyle(tip);
        const res = {
          below: tr.top >= rr.bottom - 1,
          withinBottom: tr.bottom <= innerHeight,
          capped: cs.maxHeight !== "none",
          scrolls: tip.scrollHeight > tip.clientHeight,
          contains: cs.overscrollBehaviorY === "contain",
        };
        tip.scrollTop = 20;
        tip.dispatchEvent(new Event("scroll", { bubbles: true }));
        await frame();
        res.stillOpenAfterOwnScroll = !!document.querySelector('[role="tooltip"]');
        const modal = document.getElementById("modal");
        modal.scrollTop = modal.scrollTop + 30;
        modal.dispatchEvent(new Event("scroll", { bubbles: true }));
        await frame();
        res.closedByPanelScroll = !document.querySelector('[role="tooltip"]');
        res.measured = want;
        return res;
      }, want),
    );
    check("a long description opens below the row, not above it", out.below, out);
    check("and stays on screen", out.withinBottom, out);
    check("capped to the room there is", out.capped, out);
    check("and scrolls instead of moving", out.scrolls, out);
    check("its scroll does not chain to the panel", out.contains, out);
    check("reading it does not close it", out.stillOpenAfterOwnScroll, out);
    check("scrolling the panel still closes it", out.closedByPanelScroll, out);
    check("no console errors", errors.length === 0, errors);
  }

  // ---- and reading it with a finger does not close it either ----
  // A description opened by tapping the ? leaves the ? focused. Touching the
  // popover to scroll it takes focus off the ?, and closing on that would shut
  // the very thing being read. Only a description that focus opened closes on
  // focus leaving.
  {
    const { out, errors } = await inPanel(
      browser, { css: PANEL, viewport: { width: 393, height: 460 }, touch: true, settings: { refusalNote: true } },
      async (page) => {
        const at = await page.evaluate(async (want) => {
          const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          for (const h of document.querySelectorAll('[role="button"][aria-expanded="false"]')) h.click();
      // Sections travel open now, so their contents have no height for the
      // length of that. Waited out here rather than in every check below.
      await new Promise((r) => setTimeout(r, 260));
          await frame();
          const row = document.querySelector('[data-ar-row="' + want + '"]');
          if (!row) return null;
          row.scrollIntoView({ block: "end" });
          await frame();
          const r = row.querySelector("[data-ar-hint]").getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        }, want);
        if (!at) return { err: "no row" };
        // A real tap, so the browser knows a finger is in use and does not
        // count the focus it leaves behind as worth marking.
        await page.touchscreen.tap(at.x, at.y);
        await page.waitForTimeout(150);
        const res = await page.evaluate(() => ({
          opened: !!document.querySelector('[role="tooltip"]'),
          focused: !!document.activeElement && document.activeElement.hasAttribute("data-ar-hint"),
        }));
        // A finger landing on the description takes focus off the button.
        await page.evaluate(() => {
          const q = document.querySelector("[data-ar-hint]:focus") || document.activeElement;
          if (q && q.blur) q.blur();
        });
        await page.waitForTimeout(150);
        res.stillOpenAfterTouching = await page.evaluate(() =>
          !!document.querySelector('[role="tooltip"]'));
        return res;
      },
    );
    check("a tap opens the description", out.opened, out);
    check("and leaves the ? focused", out.focused, out);
    check("touching the description does not close it", out.stillOpenAfterTouching, out);
    check("no console errors", errors.length === 0, errors);
  }

  // Under a host that applies its UI Scale as a zoom, the room on the screen
  // and the element's own units are not the same. A cap written in the wrong
  // one ran the popover off the bottom of the screen at 1.4.
  {
    const { out, errors } = await inPanel(
      browser, { css: PANEL + "body{zoom:1.4}", viewport: { width: 500, height: 360 },
                 settings: { refusalNote: true } },
      async (page) => page.evaluate(async (want) => {
        const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        for (const h of document.querySelectorAll('[role="button"][aria-expanded="false"]')) h.click();
      // Sections travel open now, so their contents have no height for the
      // length of that. Waited out here rather than in every check below.
      await new Promise((r) => setTimeout(r, 260));
        await frame();
        const row = document.querySelector('[data-ar-row="' + want + '"]');
        // Mid screen on purpose. Jammed against the bottom there is barely any
        // room to cap to, so a cap in the wrong units is too small to notice;
        // with room to spare the same mistake overshoots by half the screen.
        row.scrollIntoView({ block: "center" });
        await frame();
        row.querySelector("[data-ar-hint]").dispatchEvent(new MouseEvent("mouseenter"));
        await frame();
        const tip = document.querySelector('[role="tooltip"]');
        const rr = row.getBoundingClientRect();
        const tr = tip.getBoundingClientRect();
        return {
          below: tr.top >= rr.bottom - 1,
          withinBottom: tr.bottom <= innerHeight,
          capped: getComputedStyle(tip).maxHeight !== "none",
          rowBottom: Math.round(rr.bottom), tipTop: Math.round(tr.top),
          tipBottom: Math.round(tr.bottom), vh: innerHeight,
        };
      }, want),
    );
    check("a zoomed host still opens it below the row", out.below, out);
    check("and caps it against the room on the screen, not its own units",
      out.capped && out.withinBottom, out);
    check("no console errors", errors.length === 0, errors);
  }

  // The note list asks for its description above instead. That row holds the
  // whole list, every role, both buttons and the counter, so below it is a long
  // way from the "?" that was pressed.
  {
    const { out, errors } = await inPanel(
      browser, { css: PANEL, viewport: { width: 393, height: 800 }, settings: { refusalNote: true } },
      async (page) => page.evaluate(async () => {
        const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        for (const h of document.querySelectorAll('[role="button"][aria-expanded="false"]')) h.click();
      // Sections travel open now, so their contents have no height for the
      // length of that. Waited out here rather than in every check below.
      await new Promise((r) => setTimeout(r, 260));
        await frame();
        const row = document.querySelector('[data-ar-row="refusalNotes"]');
        row.scrollIntoView({ block: "center" });
        await frame();
        row.querySelector("[data-ar-hint]").dispatchEvent(new MouseEvent("mouseenter"));
        await frame();
        const tip = document.querySelector('[role="tooltip"]');
        if (!tip) return { err: "no tip" };
        const rr = row.getBoundingClientRect();
        const tr = tip.getBoundingClientRect();
        return {
          above: tr.bottom <= rr.top + 1,
          onScreen: tr.top >= 0 && tr.bottom <= innerHeight,
          // The point of putting it there: it lands near the "?" rather than
          // past the end of a very tall row.
          gapToTop: Math.round(rr.top - tr.bottom),
          rowHeight: Math.round(rr.height),
        };
      }),
    );
    check("the note list's description opens above its row", out.above === true, out);
    check("and sits just over it, not somewhere else",
      out.gapToTop >= 0 && out.gapToTop <= 12, out);
    check("the row really is a tall one, so this is worth doing",
      out.rowHeight > 150, out);
    check("and it stays on the screen", out.onScreen === true, out);
    check("no console errors", errors.length === 0, errors);
  }

  // Squeezed: the same row with almost no room above it must still open above
  // and still fit, rather than crossing over the row.
  {
    const { out, errors } = await inPanel(
      browser, { css: PANEL, viewport: { width: 393, height: 620 }, settings: { refusalNote: true } },
      async (page) => page.evaluate(async () => {
        const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        for (const h of document.querySelectorAll('[role="button"][aria-expanded="false"]')) h.click();
      // Sections travel open now, so their contents have no height for the
      // length of that. Waited out here rather than in every check below.
      await new Promise((r) => setTimeout(r, 260));
        await frame();
        const row = document.querySelector('[data-ar-row="refusalNotes"]');
        row.scrollIntoView({ block: "start" });
        await frame();
        row.querySelector("[data-ar-hint]").dispatchEvent(new MouseEvent("mouseenter"));
        await frame();
        const tip = document.querySelector('[role="tooltip"]');
        const rr = row.getBoundingClientRect();
        const tr = tip.getBoundingClientRect();
        return {
          above: tr.bottom <= rr.top + 1,
          onScreen: tr.top >= 0 && tr.bottom <= innerHeight,
          capped: getComputedStyle(tip).maxHeight !== "none",
        };
      }),
    );
    check("with little room above it is still above", out.above === true, out);
    check("still on the screen", out.onScreen === true, out);
    check("and capped to what room there was", out.capped === true, out);
    check("no console errors", errors.length === 0, errors);
  }

  // A row pushed off the top of the screen by the host's own layout leaves
  // negative room above it. A negative max-height is invalid CSS, which the
  // browser drops, and the popover rendered at full height straight over the
  // row it belongs to. Measured at a row top of -5, covering it from 12 to 273.
  {
    // Pushed far enough up that the row genuinely has nothing above it. The
    // fixed chrome above the scroll area, the quick setup row included, means
    // -70px does not reach.
    const OFFSET = "#modal{position:fixed;left:0;right:0;top:-260px;bottom:0;overflow:auto;background:rgb(24,20,34);box-sizing:border-box}";
    const { out, errors } = await inPanel(
      browser, { css: OFFSET, viewport: { width: 393, height: 800 }, settings: { refusalNote: true } },
      async (page) => page.evaluate(async () => {
        const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        for (const h of document.querySelectorAll('[role="button"][aria-expanded="false"]')) h.click();
      // Sections travel open now, so their contents have no height for the
      // length of that. Waited out here rather than in every check below.
      await new Promise((r) => setTimeout(r, 260));
        await frame();
        const row = document.querySelector('[data-ar-row="refusalNotes"]');
        row.scrollIntoView({ block: "start" });
        await frame();
        row.querySelector("[data-ar-hint]").dispatchEvent(new MouseEvent("mouseenter"));
        await frame();
        const tip = document.querySelector('[role="tooltip"]');
        const rr = row.getBoundingClientRect();
        const tr = tip.getBoundingClientRect();
        return {
          rowTop: Math.round(rr.top),
          // Nothing painted, rather than an empty frame over the setting.
          painted: tr.width > 0 && tr.height > 0,
          coversRow: tr.height > 0 && tr.bottom > rr.top && tr.top < rr.bottom,
          maxH: getComputedStyle(tip).maxHeight,
        };
      }),
    );
    check("a row pushed off the top really is off the top", out.rowTop < 20, out);
    check("and its description never lands on top of it", out.coversRow === false, out);
    check("nothing is painted when there is nowhere to paint it", out.painted === false, out);
    check("no console errors", errors.length === 0, errors);
  }

  // A short description with room to spare is left alone entirely.
  {
    const { out, errors } = await inPanel(
      browser, { css: PANEL, viewport: { width: 900, height: 1000 } },
      async (page) => page.evaluate(async () => {
        const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const row = [...document.querySelectorAll("[data-ar-row]")]
          .find((r) => (r.textContent || "").includes("Turn Auto Retry on"));
        row.scrollIntoView({ block: "start" });
        await frame();
        row.querySelector("[data-ar-hint]").dispatchEvent(new MouseEvent("mouseenter"));
        await frame();
        const tip = document.querySelector('[role="tooltip"]');
        const rr = row.getBoundingClientRect();
        const tr = tip.getBoundingClientRect();
        return {
          below: tr.top >= rr.bottom - 1,
          capped: getComputedStyle(tip).maxHeight !== "none",
          scrolls: tip.scrollHeight > tip.clientHeight,
        };
      }),
    );
    check("a short description with room is below the row too", out.below, out);
    check("and is not capped or scrolled", !out.capped && !out.scrolls, out);
    check("no console errors", errors.length === 0, errors);
  }
}

// ---- a row that hangs off a switch goes when the switch is off ----
// The panel was showing every setting whether or not it was in use, so the
// rows that only matter under a switch took up the space the rest needed.
console.log("\ndependent rows");
{
  const { out, errors } = await inPanel(browser, {}, async (page) =>
    page.evaluate(async () => {
      const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      for (const h of document.querySelectorAll('[role="button"][aria-expanded="false"]')) h.click();
      // Sections travel open now, so their contents have no height for the
      // length of that. Waited out here rather than in every check below.
      await new Promise((r) => setTimeout(r, 260));
      await frame();
      const shown = (k) => {
        const r = document.querySelector('[data-ar-row="' + k + '"]');
        return r ? r.style.display !== "none" : null;
      };
      // The switch itself, and the rows that hang off it.
      const box = (k) => document.querySelector('[data-ar-row="' + k + '"]').querySelector("input[type=checkbox]");
      const NOTE_ROWS = ["refusalNotes", "refusalNotePlacement", "refusalNoteStrictType"];
      const all = (f) => NOTE_ROWS.every(f);

      const offAtFirst = all((k) => shown(k) === false);
      const switchStillThere = shown("refusalNote");

      box("refusalNote").click();
      await frame();
      const onAfterTick = all((k) => shown(k) === true);

      box("refusalNote").click();
      await frame();
      const goneAgain = all((k) => shown(k) === false);

      // The same wiring on a different switch, to prove it is not special-cased.
      const shortBefore = shown("minChars");
      box("retryOnShort").click();
      await frame();
      const shortAfter = shown("minChars");

      // A search is the one exception: it finds a row whose switch is
      // off, because answering "nothing matches that" for a setting that
      // exists would be the worse answer.
      const search = document.querySelector("input[type=search]");
      search.value = "where the notes go";
      search.dispatchEvent(new Event("input", { bubbles: true }));
      await frame();
      const foundWhileOff = shown("refusalNotePlacement");
      // Ticking a switch while the search is up must not start hiding and
      // showing rows underneath the results.
      search.value = "note";
      search.dispatchEvent(new Event("input", { bubbles: true }));
      await frame();
      const matchedBefore = [...document.querySelectorAll("[data-ar-row]")]
        .filter((r) => r.style.display !== "none").length;
      box("refusalNote").click();
      await frame();
      const matchedAfter = [...document.querySelectorAll("[data-ar-row]")]
        .filter((r) => r.style.display !== "none").length;
      box("refusalNote").click();
      await frame();

      search.value = "";
      search.dispatchEvent(new Event("input", { bubbles: true }));
      await frame();
      const hiddenAfterClearing = shown("refusalNotePlacement");

      // A whole section can hang off a switch too. Turning off the accidental
      // refusal option leaves nothing under refusal tuning that does anything,
      // so the heading goes with the rows.
      //
      // Measured by whether things are actually rendered rather than by their
      // own display, because the section hides them from above.
      const rendered = (el) => !!el && el.getClientRects().length > 0;
      const tuningHead = () => [...document.querySelectorAll('[role="button"]')]
        .find((h) => /refusal tuning/i.test(h.textContent || ""));
      const tuningRow = () => document.querySelector('[data-ar-row="refusalUseBuiltins"]');
      const refusalBox = () => document.querySelector('[data-ar-row="retryOnRefusal"]')
        .querySelector("input[type=checkbox]");

      const sectionOnAtFirst = rendered(tuningHead()) && rendered(tuningRow());
      refusalBox().click();
      await frame();
      const sectionGone = !rendered(tuningHead()) && !rendered(tuningRow());
      // The switch that hides it has to stay put, or there is no way back.
      const refusalSwitchStays = rendered(document.querySelector('[data-ar-row="retryOnRefusal"]'));
      // And searching still reaches inside it.
      search.value = "extra thinking tag names";
      search.dispatchEvent(new Event("input", { bubbles: true }));
      await frame();
      const searchReachesInside = rendered(document.querySelector('[data-ar-row="refusalThinkTags"]'));
      search.value = "";
      search.dispatchEvent(new Event("input", { bubbles: true }));
      await frame();
      const goneAfterClearing = !rendered(tuningRow());
      refusalBox().click();
      await frame();
      const sectionBack = rendered(tuningHead()) && rendered(tuningRow());

      return { sectionOnAtFirst, sectionGone, refusalSwitchStays, searchReachesInside,
               goneAfterClearing, sectionBack,
               offAtFirst, switchStillThere, onAfterTick, goneAgain,
               shortBefore, shortAfter, foundWhileOff, hiddenAfterClearing,
               matchedBefore, matchedAfter };
    }),
  );
  check("the rows under a switch are not there while it is off", out.offAtFirst, out);
  check("but the switch itself always is", out.switchStillThere === true, out);
  check("ticking it brings them back with no reload", out.onAfterTick, out);
  check("unticking takes them away again", out.goneAgain, out);
  check("the same holds for another switch entirely",
    out.shortBefore === false && out.shortAfter === true, out);
  check("a search still finds a row whose switch is off", out.foundWhileOff === true, out);
  check("and clearing the search puts it away again", out.hiddenAfterClearing === false, out);
  check("ticking a switch during a search leaves the results alone",
    out.matchedBefore > 0 && out.matchedAfter === out.matchedBefore, out);
  check("a whole section is there while its switch is on", out.sectionOnAtFirst === true, out);
  check("and the heading goes with the rows when it is off", out.sectionGone === true, out);
  check("the switch that hides it stays put", out.refusalSwitchStays === true, out);
  check("a search still reaches a row inside a hidden section",
    out.searchReachesInside === true, out);
  check("and clearing the search puts the section away again",
    out.goneAfterClearing === true, out);
  check("turning it back on brings the section back", out.sectionBack === true, out);
  check("no console errors", errors.length === 0, errors);
}

// ---- the lines that only appear once something happens ----
// The panel-wide contrast sweep runs once, at build. Looking only at elements
// painting text right then skips every status line in the panel, since they are
// all empty at that moment and fill in later. On a light page whose theme
// variables are all dark they come out white on white: the search count, the
// reset note, and the line confirming a save.
console.log("\nlines that fill in later");
{
  for (const [themeName, themeCss] of [["dark", ""], ["light", LIGHT], ["dark variables on a light page", LIGHT_PAGE]]) {
    const { out, errors } = await inPanel(browser, { css: themeCss }, async (page) =>
      page.evaluate(async () => {
        const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        for (const h of document.querySelectorAll('[role="button"][aria-expanded="false"]')) h.click();
      // Sections travel open now, so their contents have no height for the
      // length of that. Waited out here rather than in every check below.
      await new Promise((r) => setTimeout(r, 260));
        await frame();
        // Everything that puts words into a line that started out empty.
        const by = (t) => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === t);
        const s = document.querySelector("input[type=search]");
        s.value = "retry";
        s.dispatchEvent(new Event("input", { bubbles: true }));
        await frame();
        if (by("Save")) by("Save").click();
        if (by("Check this text")) by("Check this text").click();
        for (const b of [...document.querySelectorAll("button")])
          if (/^Reset/.test(b.textContent || "")) { b.click(); break; }
        await frame();

        const num = (c) => (c.match(/[\d.]+/g) || []).map(Number);
        const lum = (c) => {
          const ch = c.map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); });
          return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
        };
        // Composites the layers, the way the extension does. Looking for the
        // first background over 90% opaque walks past a button whose fill is
        // exactly 90% and measures its label against the panel behind it.
        const solid = (el) => {
          const layers = [];
          let p = el;
          while (p) {
            const cs = getComputedStyle(p);
            const n = num(cs.backgroundColor);
            let c = n.slice(0, 3);
            let a = n[3] === undefined ? 1 : n[3];
            const stop = (cs.backgroundImage || "").match(/rgba?\([^)]*\)/);
            if (stop) {
              const g = num(stop[0]);
              const ga = g[3] === undefined ? 1 : g[3];
              c = [g[0] * ga + c[0] * (1 - ga), g[1] * ga + c[1] * (1 - ga), g[2] * ga + c[2] * (1 - ga)];
              a = Math.min(1, a + ga * (1 - a));
            }
            if (a > 0) layers.push([c, a]);
            if (a >= 0.999) break;
            p = p.parentElement;
          }
          let base = [0, 0, 0];
          for (let i = layers.length - 1; i >= 0; i--) {
            const [c, a] = layers[i];
            base = [c[0] * a + base[0] * (1 - a), c[1] * a + base[1] * (1 - a), c[2] * a + base[2] * (1 - a)];
          }
          return base;
        };

        const bad = [];
        let seen = 0;
        for (const el of document.querySelectorAll("#modal *")) {
          const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim());
          if (!own || el.getClientRects().length === 0) continue;
          seen++;
          const bg = solid(el);
          const c = num(getComputedStyle(el).color);
          const a = c[3] === undefined ? 1 : c[3];
          const over = [c[0] * a + bg[0] * (1 - a), c[1] * a + bg[1] * (1 - a), c[2] * a + bg[2] * (1 - a)];
          const x = lum(over), y = lum(bg);
          const r = (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
          if (r < 2.6) bad.push({ t: (el.textContent || "").trim().slice(0, 40), r: Number(r.toFixed(2)) });
        }
        // The lines this is really about had better be among what was measured.
        const wanted = ["settings match", "Saved", "defaults"];
        const texts = [...document.querySelectorAll("#modal *")].map((e) => e.textContent || "").join(" ");
        return { bad, seen, covered: wanted.filter((w) => texts.indexOf(w) >= 0).length };
      }),
    );
    check(themeName + ": every line that filled in can be read", out.bad.length === 0, out.bad);
    check(themeName + ": and the status lines were actually on screen to check",
      out.covered >= 2 && out.seen > 40, out);
    check(themeName + ": no console errors", errors.length === 0, errors);
  }
}

// ---- a search says which switch a row is waiting on ----
// Searching finds a setting whichever way its switch is set, because refusing
// to find one that exists is the worse answer. That leaves the other half of
// the problem: changing it appears to do nothing. The row says what it wants.
console.log("\nwhat a hidden row is waiting on");
{
  const { out, errors } = await inPanel(browser, {}, async (page) =>
    page.evaluate(async () => {
      const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      for (const h of document.querySelectorAll('[role="button"][aria-expanded="false"]')) h.click();
      // Sections travel open now, so their contents have no height for the
      // length of that. Waited out here rather than in every check below.
      await new Promise((r) => setTimeout(r, 260));
      await frame();
      const search = document.querySelector("input[type=search]");
      const find = (q) => { search.value = q; search.dispatchEvent(new Event("input", { bubbles: true })); };
      // The text a row is showing under itself, if any.
      const waitingOn = (k) => {
        const r = document.querySelector('[data-ar-row="' + k + '"]');
        if (!r) return null;
        const bits = [...r.querySelectorAll("div")]
          .filter((d) => d.style.display !== "none" && /^Needs /.test(d.textContent || ""));
        return bits.length ? bits[bits.length - 1].textContent : "";
      };

      // A row hidden by its own switch.
      find("where the notes go");
      await frame();
      const noteRow = waitingOn("refusalNotePlacement");

      // A row hidden by the section it sits in, which has no switch of its own.
      // The section's switch has to actually be off for there to be anything
      // to say, so it is turned off first.
      find("");
      await frame();
      document.querySelector('[data-ar-row="retryOnRefusal"]').querySelector("input[type=checkbox]").click();
      await frame();
      find("extra thinking tag names");
      await frame();
      const inSection = waitingOn("refusalThinkTags");
      find("");
      await frame();
      document.querySelector('[data-ar-row="retryOnRefusal"]').querySelector("input[type=checkbox]").click();
      await frame();

      // With the switch on there is nothing to say.
      document.querySelector('[data-ar-row="refusalNote"]').querySelector("input[type=checkbox]").click();
      await frame();
      find("where the notes go");
      await frame();
      const onceOn = waitingOn("refusalNotePlacement");

      // And it is a search-time thing only, not something left on the row.
      find("");
      await frame();
      const afterClearing = waitingOn("refusalNotePlacement");

      // The switch flipped from inside the results, without clearing the box.
      // This is the way someone actually acts on the line: they search, read
      // what it is waiting on, and turn that on there and then. The line was
      // only ever rebuilt when the search text changed, so it stayed up saying
      // the row was waiting for a switch that was now on.
      document.querySelector('[data-ar-row="refusalNote"]').querySelector("input[type=checkbox]").click();
      await frame();
      find("note");
      await frame();
      const beforeFlip = waitingOn("refusalNotePlacement");
      const sw = document.querySelector('[data-ar-row="refusalNote"]');
      const reachable = !!sw && sw.style.display !== "none";
      sw.querySelector("input[type=checkbox]").click();
      await frame();
      const afterFlip = waitingOn("refusalNotePlacement");
      return { noteRow, inSection, onceOn, afterClearing, beforeFlip, afterFlip, reachable };
    }),
  );
  check("a row found while its own switch is off names that switch",
    /^Needs "/.test(out.noteRow || "") && /refusal retry/i.test(out.noteRow || ""), out);
  check("so does one inside a section that is switched off",
    /^Needs "/.test(out.inSection || "") && /accidental refusal/i.test(out.inSection || ""), out);
  check("and it says nothing once the switch is on", out.onceOn === "", out);
  check("nor is it left behind after the search is cleared", out.afterClearing === "", out);
  check("the switch a row names is reachable from the same search", out.reachable === true, out);
  check("the row is waiting on it before it is turned on",
    /^Needs "/.test(out.beforeFlip || ""), out);
  check("and stops saying so the moment it is, without clearing the search",
    out.afterFlip === "", out);
  check("no console errors", errors.length === 0, errors);

  // The panel-wide contrast sweep runs once, while this line is still empty,
  // and it only looks at elements that are painting text. So it never saw this
  // one: on a light page whose theme variables are all dark it came out white
  // on white at a ratio of 1.02. It is checked when it first has something to
  // say instead, and this holds that on the themes that would expose it.
  for (const [themeName, themeCss] of [["dark", ""], ["light", LIGHT], ["dark variables on a light page", LIGHT_PAGE]]) {
    const { out: seen, errors: errs } = await inPanel(browser, { css: themeCss }, async (page) =>
      page.evaluate(async () => {
        const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        for (const h of document.querySelectorAll('[role="button"][aria-expanded="false"]')) h.click();
      // Sections travel open now, so their contents have no height for the
      // length of that. Waited out here rather than in every check below.
      await new Promise((r) => setTimeout(r, 260));
        await frame();
        const s = document.querySelector("input[type=search]");
        s.value = "where the notes go";
        s.dispatchEvent(new Event("input", { bubbles: true }));
        await frame();
        const line = [...document.querySelectorAll("div")]
          .find((d) => /^Needs "/.test(d.textContent || "") && d.children.length === 0);
        if (!line) return { err: "no line" };
        const num = (c) => (c.match(/[\d.]+/g) || []).map(Number);
        const lum = (c) => {
          const ch = c.map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); });
          return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
        };
        const solid = (el) => {
          let p = el;
          while (p) {
            const cs = getComputedStyle(p);
            const n = num(cs.backgroundColor);
            let base = n.slice(0, 3);
            let a = n[3] === undefined ? 1 : n[3];
            const stop = (cs.backgroundImage || "").match(/rgba?\([^)]*\)/);
            if (stop) {
              const g = num(stop[0]);
              const ga = g[3] === undefined ? 1 : g[3];
              base = [g[0] * ga + base[0] * (1 - ga), g[1] * ga + base[1] * (1 - ga), g[2] * ga + base[2] * (1 - ga)];
              a = Math.min(1, a + ga * (1 - a));
            }
            if (a > 0.9) return base;
            p = p.parentElement;
          }
          return [0, 0, 0];
        };
        const bg = solid(line);
        const c = num(getComputedStyle(line).color);
        const a = c[3] === undefined ? 1 : c[3];
        const over = [c[0] * a + bg[0] * (1 - a), c[1] * a + bg[1] * (1 - a), c[2] * a + bg[2] * (1 - a)];
        const x = lum(over), y = lum(bg);
        return { ratio: (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05), colour: getComputedStyle(line).color };
      }),
    );
    check(themeName + ": the line saying which switch is needed can be read",
      !!seen && seen.ratio >= 2.6, seen);
    check(themeName + ": no console errors", errs.length === 0, errs);
  }
}

// ---- the master switch says it is off rather than emptying the panel ----
// Auto Retry can be switched off without opening this panel, so someone can
// arrive with it off and nothing saying why. Off means paused, not
// unconfigured, so nothing is hidden or greyed for it.
console.log("\nmaster switch off");
{
  const { out, errors } = await inPanel(browser, {}, async (page) =>
    page.evaluate(async () => {
      const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      // By its attribute, not by its shape: the line carries a span and a
      // button now, since it also has to describe a chat that was switched off
      // and offer the way back from that.
      const note = () => document.querySelector("[data-ar-master]");
      const showing = () => { const n = note(); return !!n && n.style.display !== "none"; };
      const rowsUp = () => [...document.querySelectorAll("[data-ar-row]")]
        .filter((r) => r.getClientRects().length > 0).length;

      for (const h of document.querySelectorAll('[role="button"][aria-expanded="false"]')) h.click();
      // Sections travel open now, so their contents have no height for the
      // length of that. Waited out here rather than in every check below.
      await new Promise((r) => setTimeout(r, 260));
      await frame();
      const quietWhileOn = !showing();
      const before = rowsUp();
      const box = document.querySelector('[data-ar-row="enabled"]').querySelector("input[type=checkbox]");
      box.click();
      await frame();
      const after = rowsUp();
      const saysSo = showing();
      box.click();
      await frame();
      return { quietWhileOn, saysSo, before, after, quietAgain: !showing() };
    }),
  );
  check("nothing is said while it is on", out.quietWhileOn === true, out);
  check("switching it off says so", out.saysSo === true, out);
  check("and takes away nothing at all", out.before > 20 && out.after === out.before, out);
  check("switching it back on takes the line away", out.quietAgain === true, out);
  check("no console errors", errors.length === 0, errors);
}

// ---- hiding a row is only hiding it ----
// Nothing about a switch being off may cost someone what they typed or what a
// section had open. Hiding is meant to be about what is on screen and nothing
// else. A backup needs no check here: buildExport reads the settings and never
// the panel, and the round trip above already covers a hidden row, since
// refusalNotes is hidden by default and still has to appear in the file.
console.log("\nhiding keeps everything");
{
  const { out, errors } = await inPanel(browser, {}, async (page) =>
    page.evaluate(async () => {
      const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      for (const h of document.querySelectorAll('[role="button"][aria-expanded="false"]')) h.click();
      // Sections travel open now, so their contents have no height for the
      // length of that. Waited out here rather than in every check below.
      await new Promise((r) => setTimeout(r, 260));
      await frame();
      const head = () => [...document.querySelectorAll('[role="button"]')]
        .find((h) => /refusal tuning/i.test(h.textContent || ""));
      const box = (k) => document.querySelector('[data-ar-row="' + k + '"]')
        .querySelector("input[type=checkbox]");
      const phrases = () => document.querySelector('[data-ar-row="refusalExtraPhrases"]')
        .querySelector("textarea");

      const openBefore = head().getAttribute("aria-expanded");
      const ta = phrases();
      ta.value = "my own phrase";
      ta.dispatchEvent(new Event("input", { bubbles: true }));

      // Away and back again.
      box("retryOnRefusal").click();
      await frame();
      box("retryOnRefusal").click();
      await frame();

      return {
        openBefore,
        openAfter: head().getAttribute("aria-expanded"),
        textKept: phrases().value,
      };
    }),
  );
  check("a section that comes back is still open if it was", out.openAfter === out.openBefore, out);
  check("and what was typed inside it is still there", out.textKept === "my own phrase", out);
  check("no console errors", errors.length === 0, errors);
}

console.log("\nnote list");
{
  const { out, errors } = await inPanel(browser, { settings: { refusalNote: true } }, async (page) =>
    page.evaluate(async () => {
      const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      for (const h of document.querySelectorAll('[role="button"][aria-expanded="false"]')) h.click();
      // Sections travel open now, so their contents have no height for the
      // length of that. Waited out here rather than in every check below.
      await new Promise((r) => setTimeout(r, 260));
      await frame();
      const row = document.querySelector('[data-ar-row="refusalNotes"]');
      const plus = [...row.querySelectorAll("button")].find((b) => b.textContent.trim() === "+");
      const minuses = () => [...row.querySelectorAll("button")].filter((b) => b.textContent.trim() === "\u2212");
      const boxes = () => row.querySelectorAll("textarea");
      const picks = () => row.querySelectorAll("select");

      const start = { notes: boxes().length, roles: picks().length, minusOff: minuses()[0].disabled };

      // Typing in one, then adding another, must not disturb the first.
      boxes()[0].value = "first";
      boxes()[0].dispatchEvent(new Event("input", { bubbles: true }));
      picks()[0].value = "user";
      picks()[0].dispatchEvent(new Event("change", { bubbles: true }));
      plus.click();
      await frame();
      const afterAdd = {
        notes: boxes().length,
        firstKept: boxes()[0].value,
        firstRole: picks()[0].value,
        minusOn: !minuses()[0].disabled,
      };

      // Fill the second, remove the first, and the second must survive as the
      // one that is left.
      boxes()[1].value = "second";
      boxes()[1].dispatchEvent(new Event("input", { bubbles: true }));
      // Twice. A note holds writing and there is no undo, so the first press
      // arms the button and the second removes it.
      // Twice, then past the travel: the row's space is let down before it goes.
      const drop = (n) => {
        n.click();
        n.click();
      };
      const settled = () => new Promise((r) => setTimeout(r, 380));
      drop(minuses()[0]);
      await settled();
      const afterRemove = { notes: boxes().length, left: boxes()[0].value };

      // Climb to the ceiling.
      for (let i = 0; i < 30; i++) plus.click();
      await frame();
      const atCap = { notes: boxes().length, plusOff: plus.disabled };

      // And back down to the floor.
      for (let i = 0; i < 30; i++) {
        const m = minuses();
        if (m.length) drop(m[m.length - 1]);
        await settled();
      }
      await frame();
      const atFloor = { notes: boxes().length, minusOff: minuses()[0].disabled, plusOn: !plus.disabled };

      return { start, afterAdd, afterRemove, atCap, atFloor };
    }),
  );
  check("it opens with one note", out.start.notes === 1 && out.start.roles === 1, out.start);
  check("and that one cannot be removed", out.start.minusOff, out.start);
  check("plus adds another", out.afterAdd.notes === 2, out.afterAdd);
  check("without disturbing what is already typed",
    out.afterAdd.firstKept === "first" && out.afterAdd.firstRole === "user", out.afterAdd);
  check("with two, either can be removed", out.afterAdd.minusOn, out.afterAdd);
  check("removing one keeps the other's text",
    out.afterRemove.notes === 1 && out.afterRemove.left === "second", out.afterRemove);
  check("it stops at ten", out.atCap.notes === 10 && out.atCap.plusOff, out.atCap);
  check("and never goes below one", out.atFloor.notes === 1 && out.atFloor.minusOff, out.atFloor);
  check("with room again after coming back down", out.atFloor.plusOn, out.atFloor);
  check("no console errors", errors.length === 0, errors);
}

// ---- adding a note does not raise the keyboard on a phone ----
// Focusing the new note is what someone with a keyboard wants and what someone
// on a phone does not: it raises the on-screen keyboard, which covers the panel
// and the note just added. So it turns on what pressed the button rather than
// on what kind of device it is, which is the only thing that gets a tablet with
// a keyboard right.
console.log("\nadding a note");
{
  const { out, errors } = await inPanel(browser, { settings: { refusalNote: true } }, async (page) =>
    page.evaluate(async () => {
      const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      for (const h of document.querySelectorAll('[role="button"][aria-expanded="false"]')) h.click();
      // Sections travel open now, so their contents have no height for the
      // length of that. Waited out here rather than in every check below.
      await new Promise((r) => setTimeout(r, 260));
      await frame();
      const row = document.querySelector('[data-ar-row="refusalNotes"]');
      const plus = [...row.querySelectorAll("button")].find((b) => b.textContent.trim() === "+");
      const boxes = () => row.querySelectorAll("textarea");
      const minuses = () => [...row.querySelectorAll("button")].filter((b) => b.textContent.trim() === "−");
      // Whether the note that was just added is the thing holding focus.
      const landedInNew = () => {
        const b = boxes();
        return document.activeElement === b[b.length - 1];
      };
      const add = async (pointerType) => {
        if (pointerType) {
          plus.dispatchEvent(new PointerEvent("pointerdown", { pointerType, bubbles: true }));
        }
        plus.click();
        await frame();
      };
      const reset = async () => {
        for (let i = 0; i < 30; i++) { const m = minuses(); if (m.length) m[m.length - 1].click(); }
        if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
        await frame();
      };

      await add("touch");
      const byTouch = { notes: boxes().length, focused: landedInNew() };
      await reset();

      // A keyboard press straight after a tap, to prove the tap does not leave
      // the button stuck in the state it set.
      await add(null);
      const byKeyboard = { notes: boxes().length, focused: landedInNew() };
      await reset();

      await add("mouse");
      const byMouse = { notes: boxes().length, focused: landedInNew() };
      await reset();

      await add("pen");
      const byPen = { notes: boxes().length, focused: landedInNew() };

      return { byTouch, byKeyboard, byMouse, byPen };
    }),
  );
  check("a tap adds the note", out.byTouch.notes === 2, out.byTouch);
  check("and does not put the cursor in it, so no keyboard comes up",
    out.byTouch.focused === false, out.byTouch);
  check("a keyboard press right after a tap still lands in the new note",
    out.byKeyboard.focused === true, out.byKeyboard);
  check("a mouse click lands in the new note", out.byMouse.focused === true, out.byMouse);
  check("a stylus is treated like a finger", out.byPen.focused === false, out.byPen);
  check("no console errors", errors.length === 0, errors);
}

// ---- a surface is measured by what it paints ----
// The floating panels build an opaque surface by painting a solid colour and
// laying the theme's tint over it as a gradient. background-color reports only
// the colour underneath. On a theme that leaves the solid one unset, the
// popover painted near-white, measured as the dark fallback beneath, and had
// its text repainted white to suit, which made it disappear.
console.log("\npainted surfaces");
{
  // Every surface below declares a dark background-colour and lays the theme's
  // tint over it as a gradient, and every one of them has its text repainted
  // against whatever it measures as sitting on. They share the fault and so
  // they are checked together.
  const look = async (name, css) => {
    const { out, errors } = await inPanel(browser, { css }, async (page) =>
      page.evaluate(async () => {
        const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const num = (c) => (c.match(/[\d.]+/g) || []).map(Number);
        const lum = (c) => {
          const ch = c.map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); });
          return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
        };
        // What the surface paints: the gradient tint over the declared colour.
        // The text is read off whichever element actually carries it, which on
        // the editor is a child of the surface rather than the surface itself.
        // Only a child gets its colour recomputed, so measuring the surface's
        // own inherited colour would miss the fault entirely.
        const reading = (el, textEl) => {
          if (!el || (textEl !== undefined && !textEl)) return null;
          const cs = getComputedStyle(el);
          const stop = (cs.backgroundImage || "").match(/rgba?\([^)]*\)/);
          const [br, bg, bb] = num(cs.backgroundColor);
          let painted = [br, bg, bb];
          if (stop) {
            const [gr, gg, gb, ga = 1] = num(stop[0]);
            painted = [gr * ga + br * (1 - ga), gg * ga + bg * (1 - ga), gb * ga + bb * (1 - ga)];
          }
          const colour = getComputedStyle(textEl || el).color;
          const [tr, tg, tb, ta = 1] = num(colour);
          const over = [tr * ta + painted[0] * (1 - ta), tg * ta + painted[1] * (1 - ta), tb * ta + painted[2] * (1 - ta)];
          const a = lum(over), b = lum(painted);
          return {
            ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
            text: colour, declared: cs.backgroundColor,
          };
        };
        const found = {};

        document.querySelector("button[data-ar-hint]").dispatchEvent(new MouseEvent("mouseenter"));
        await frame();
        found.tip = reading(document.querySelector('[role="tooltip"]'));
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

        // The full-size editor, reached the way someone would reach it.
        for (const h of document.querySelectorAll('[role="button"][aria-expanded="false"]')) h.click();
      // Sections travel open now, so their contents have no height for the
      // length of that. Waited out here rather than in every check below.
      await new Promise((r) => setTimeout(r, 260));
        await frame();
        const ex = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Expand");
        if (ex) ex.click();
        await frame();
        const box = [...document.querySelectorAll("body > div")]
          .filter((d) => d.id !== "modal")
          .map((d) => d.querySelector("textarea") && d.querySelector("textarea").parentElement)
          .find(Boolean);
        // The editor's title: a plain line of text on the surface, and one of
        // the elements the sweep repaints.
        const title = box && [...box.children].find(
          (c) => c.tagName === "DIV" &&
            [...c.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim()),
        );
        found.editor = reading(box, title);
        const closeEditor = box && [...box.querySelectorAll("button")].find((b) => b.textContent.trim() === "Cancel");
        if (closeEditor) closeEditor.click();
        await frame();

        // The reset picker, which paints the same way and had none of this.
        const resetBtn = [...document.querySelectorAll("button")].find((b) => /^Reset/.test(b.textContent.trim()));
        if (resetBtn) resetBtn.click();
        await frame();
        const rbox = document.getElementById("__lvRetryReset");
        const rcard = rbox && rbox.firstElementChild;
        const rtitle = rcard && [...rcard.children].find(
          (c) => c.tagName === "DIV" &&
            [...c.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim()),
        );
        found.reset = reading(rcard, rtitle);
        return found;
      }),
    );
    check(name + ": the tip's text reads against what the tip paints",
      out.tip && out.tip.ratio >= 3, out.tip);
    check(name + ": the editor's text reads against what the editor paints",
      out.editor && out.editor.ratio >= 3, out.editor);
    check(name + ": the reset picker's text reads against what it paints",
      out.reset && out.reset.ratio >= 3, out.reset);
    check(name + ": no console errors", errors.length === 0, errors);
  };
  await look("stock", "");
  await look("full light", LIGHT);
  await look("partial light", PARTIAL_LIGHT);
  await look("dark variables on a light page", LIGHT_PAGE);
}

// ---- resetting one part leaves the others alone ----
// The picker exists because all or nothing is the wrong shape: putting the
// button selectors back is the case that comes up, and doing it should not cost
// the word swaps and refusal phrases. What is worth holding down is the promise
// it makes on screen: what you do not tick is not touched.
console.log("\nreset picker");
{
  const openPicker = async (page) =>
    page.evaluate(async () => {
      const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const b = [...document.querySelectorAll("button")].find((x) => /^Reset/.test(x.textContent.trim()));
      b.click();
      await frame();
    });

  const { out, errors } = await inPanel(browser, {}, async (page) => {
    // Move one setting in each of two different parts away from its default.
    await page.evaluate(async () => {
      const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      for (const h of document.querySelectorAll('[role="button"][aria-expanded="false"]')) h.click();
      // Sections travel open now, so their contents have no height for the
      // length of that. Waited out here rather than in every check below.
      await new Promise((r) => setTimeout(r, 260));
      await frame();
      const row = (k) => document.querySelector('[data-ar-row="' + k + '"]');
      const set = (k, v) => {
        const el = row(k).querySelector("input,textarea,select");
        el.value = v;
        el.dispatchEvent(new Event("change", { bubbles: true }));
      };
      set("maxRetries", "9");                       // Retry behavior
      set("regenerateSelector", ".my-own-button");  // Button selectors
      set("refusalExtraPhrases", "nope");           // Refusal detection
      await frame();
    });
    await openPicker(page);
    const seen = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("[data-ar-reset]")];
      return rows.map((r) => ({
        id: r.getAttribute("data-ar-reset"),
        disabled: r.querySelector("input").disabled,
        note: r.lastElementChild.textContent.trim(),
      }));
    });
    // Tick the button selectors only, and go.
    const after = await page.evaluate(async () => {
      const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      document.querySelector('[data-ar-reset="buttons"] input').checked = true;
      [...document.querySelectorAll("#__lvRetryReset button")]
        .find((b) => b.textContent.trim() === "Reset ticked").click();
      await frame();
      // Guarded rather than chained straight onto find(). A regression that
      // skips the asking step leaves no Yes button, and a TypeError here would
      // take the rest of the file down with it instead of failing one check.
      const confirmBtn = [...document.querySelectorAll("#__lvRetryReset button")]
        .find((b) => /^Yes, reset/.test(b.textContent.trim()));
      if (confirmBtn) confirmBtn.click();
      await frame();
      const row = (k) => document.querySelector('[data-ar-row="' + k + '"]');
      const val = (k) => row(k).querySelector("input,textarea,select").value;
      return {
        stillOpen: !!document.getElementById("__lvRetryReset"),
        selector: val("regenerateSelector"),
        maxRetries: val("maxRetries"),
        phrases: val("refusalExtraPhrases"),
      };
    });
    return { seen, after };
  });

  const row = (id) => out.seen.find((r) => r.id === id);
  check("every part is offered, plus the presets line",
    out.seen.length >= 5 && !!row("retry") && !!row("buttons") && !!row("refusal") && !!row("presets"),
    out.seen.map((r) => r.id));
  check("a part that was changed says how many settings moved",
    /1 setting changed/.test(row("buttons").note), row("buttons").note);
  // Nothing to press is the honest state for a part still at its defaults, and
  // a tickable box that reports "nothing changed" afterwards is not that.
  check("a part still at its defaults cannot be ticked",
    row("notifications").disabled === true && /already default/.test(row("notifications").note),
    row("notifications"));
  check("with no presets saved, that line cannot be ticked either",
    row("presets").disabled === true, row("presets"));
  check("the picker closes when it has run", out.after.stillOpen === false, out.after);
  check("the ticked part is back at its default",
    out.after.selector !== ".my-own-button" && out.after.selector.length > 0, out.after.selector);
  // The whole point of the picker.
  check("and the parts left unticked are untouched",
    out.after.maxRetries === "9" && out.after.phrases === "nope", out.after);
  check("no console errors", errors.length === 0, errors);
}

// A reset fills the panel in and stops there, the same deal an import offers,
// so a mistaken press costs a panel close rather than a settings set.
{
  const { out, errors } = await inPanel(browser, {}, async (page) => {
    await page.evaluate(async () => {
      const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      for (const h of document.querySelectorAll('[role="button"][aria-expanded="false"]')) h.click();
      // Sections travel open now, so their contents have no height for the
      // length of that. Waited out here rather than in every check below.
      await new Promise((r) => setTimeout(r, 260));
      await frame();
      const el = document.querySelector('[data-ar-row="maxRetries"] input');
      el.value = "9";
      el.dispatchEvent(new Event("change", { bubbles: true }));
      [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Save").click();
      await frame();
      [...document.querySelectorAll("button")].find((b) => /^Reset/.test(b.textContent.trim())).click();
      await frame();
      document.querySelector('[data-ar-reset="retry"] input').checked = true;
      [...document.querySelectorAll("#__lvRetryReset button")]
        .find((b) => b.textContent.trim() === "Reset ticked").click();
      await frame();
      // Guarded rather than chained straight onto find(). A regression that
      // skips the asking step leaves no Yes button, and a TypeError here would
      // take the rest of the file down with it instead of failing one check.
      const confirmBtn = [...document.querySelectorAll("#__lvRetryReset button")]
        .find((b) => /^Yes, reset/.test(b.textContent.trim()));
      if (confirmBtn) confirmBtn.click();
      await frame();
    });
    return page.evaluate(() => ({
      inPanel: document.querySelector('[data-ar-row="maxRetries"] input').value,
      stored: JSON.parse(localStorage.getItem("lv-auto-retry:settings:v1")).maxRetries,
    }));
  });
  check("the reset shows in the panel", out.inPanel !== "9", out);
  check("but is not saved until you press Save", out.stored === 9, out);
  check("no console errors", errors.length === 0, errors);
}

// Nothing resets without being asked first. The old all-or-nothing button went
// through the host's confirm dialog and treated a host with no dialog as a yes,
// which is the wrong way round for the one control that throws settings away.
// The picker asks for itself, so a host without a dialog still asks.
console.log("\nreset confirmation");
{
  const { out, errors } = await inPanel(browser, {}, async (page) =>
    page.evaluate(async () => {
      const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      for (const h of document.querySelectorAll('[role="button"][aria-expanded="false"]')) h.click();
      // Sections travel open now, so their contents have no height for the
      // length of that. Waited out here rather than in every check below.
      await new Promise((r) => setTimeout(r, 260));
      await frame();
      const el = document.querySelector('[data-ar-row="maxRetries"] input');
      el.value = "9";
      el.dispatchEvent(new Event("change", { bubbles: true }));
      await frame();
      const open = async () => {
        [...document.querySelectorAll("button")].find((b) => /^Reset/.test(b.textContent.trim())).click();
        await frame();
      };
      // Every lookup below is guarded. A regression that skips the asking step
      // leaves these buttons missing, and a TypeError would take the rest of
      // the file down with it instead of failing the one check that caught it.
      const inBox = (t) => [...document.querySelectorAll("#__lvRetryReset button")]
        .find((b) => b.textContent.trim() === t) || null;
      const press = async (t) => { const b = inBox(t) || [...document.querySelectorAll("#__lvRetryReset button")].find((x) => x.textContent.trim().startsWith(t)); if (b) b.click(); await frame(); };
      const tick = (id) => document.querySelector('[data-ar-reset="' + id + '"] input');
      const val = () => document.querySelector('[data-ar-row="maxRetries"] input').value;
      const confirmEl = () => document.querySelector("[data-ar-reset-confirm]");

      await open();
      if (tick("retry")) tick("retry").checked = true;
      await press("Reset ticked");
      const summary = confirmEl() ? confirmEl().textContent.trim() : "";
      const untouchedWhileAsking = val();
      // The ticks cannot move while the summary is on screen describing them.
      const boxesHeld = tick("retry") ? tick("retry").disabled : null;
      const hasYes = !!inBox("Yes, reset");
      const hasGoBack = !!inBox("Go back");

      await press("Go back");
      const afterBack = {
        value: val(),
        stillOpen: !!document.getElementById("__lvRetryReset"),
        asking: !!confirmEl() && confirmEl().offsetParent !== null,
        tickKept: tick("retry") ? tick("retry").checked : null,
        boxesBack: tick("retry") ? !tick("retry").disabled : null,
      };

      // Escape out of the asking step changes nothing either.
      await press("Reset ticked");
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await frame();
      const afterEsc = { value: val(), gone: !document.getElementById("__lvRetryReset") };

      await open();
      if (tick("retry")) tick("retry").checked = true;
      await press("Reset ticked");
      await press("Yes, reset");
      return {
        summary, untouchedWhileAsking, boxesHeld, hasYes, hasGoBack,
        afterBack, afterEsc, afterYes: val(),
      };
    }),
  );
  check("Reset ticked asks instead of doing it", out.hasYes && out.hasGoBack, out);
  check("nothing has changed while it is asking", out.untouchedWhileAsking === "9", out);
  // A fixed sentence cannot say this, which is why the picker asks for itself
  // rather than handing the question to the host.
  check("it names the part and counts what would change",
    // The ticked part is the one holding maxRetries, matched on its stem and
    // read up to its count rather than written out in full, so rewording a
    // tick box does not fail a check about counting.
    /retr[a-z]*[^)]*\(\d+ settings?\)/i.test(out.summary), out.summary);
  check("and says that closing the panel undoes it",
    /closing the panel/i.test(out.summary), out.summary);
  check("the ticks are held while it asks", out.boxesHeld === true, out);
  check("Go back returns to the list with the tick kept",
    out.afterBack.value === "9" && out.afterBack.stillOpen &&
    !out.afterBack.asking && out.afterBack.tickKept && out.afterBack.boxesBack, out.afterBack);
  check("Escape while it asks changes nothing",
    out.afterEsc.value === "9" && out.afterEsc.gone, out.afterEsc);
  check("only Yes goes through with it", out.afterYes !== "9", out);
  check("no console errors", errors.length === 0, errors);
}

// The permanent half of the picker has to say so before it happens.
{
  const { out, errors } = await inPanel(browser, {}, async (page) =>
    page.evaluate(async () => {
      const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      for (const h of document.querySelectorAll('[role="button"][aria-expanded="false"]')) h.click();
      // Sections travel open now, so their contents have no height for the
      // length of that. Waited out here rather than in every check below.
      await new Promise((r) => setTimeout(r, 260));
      await frame();
      document.querySelector('[data-ar-row="refusalExtraPhrases"] textarea').value = "cat => dog";
      document.querySelector('[data-ar-row="refusalExtraPhrases"] textarea')
        .dispatchEvent(new Event("change", { bubbles: true }));
      // Scoped: the note preset bar is identical and sits in an earlier section.
      const swapBar = document.querySelector('[data-ar-presets="notes"]');
      swapBar.querySelector('input[placeholder="Preset name"]').value = "trial";
      [...swapBar.querySelectorAll("button")].find((b) => b.textContent.trim() === "Save as new").click();
      await frame();
      [...document.querySelectorAll("button")].find((b) => /^Reset/.test(b.textContent.trim())).click();
      await frame();
      document.querySelector('[data-ar-reset="presets"] input').checked = true;
      [...document.querySelectorAll("#__lvRetryReset button")]
        .find((b) => b.textContent.trim() === "Reset ticked").click();
      await frame();
      const el = document.querySelector("[data-ar-reset-confirm]");
      const summary = el ? el.textContent.trim() : "";
      const stillThere = JSON.parse(localStorage.getItem("lv-auto-retry:presets:v1")).notes.length;
      return { summary, stillThere };
    }),
  );
  check("deleting presets is spelled out before it happens",
    /Delete 1 saved preset\b/.test(out.summary), out.summary);
  check("and it says that one is not undone by closing the panel",
    /will not bring them back/i.test(out.summary), out.summary);
  check("nothing is deleted until Yes", out.stillThere === 1, out);
  check("no console errors", errors.length === 0, errors);
}

// Deleting presets is the one line in the picker that does not wait for Save,
// because presets live outside the settings object. It has to actually delete
// them, and it has to leave the settings alone while it does.
{
  const { out, errors } = await inPanel(browser, {}, async (page) =>
    page.evaluate(async () => {
      const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      for (const h of document.querySelectorAll('[role="button"][aria-expanded="false"]')) h.click();
      // Sections travel open now, so their contents have no height for the
      // length of that. Waited out here rather than in every check below.
      await new Promise((r) => setTimeout(r, 260));
      await frame();
      const el = document.querySelector('[data-ar-row="maxRetries"] input');
      el.value = "9";
      el.dispatchEvent(new Event("change", { bubbles: true }));
      // Save a preset the way someone would.
      document.querySelector('[data-ar-row="refusalExtraPhrases"] textarea').value = "cat => dog";
      document.querySelector('[data-ar-row="refusalExtraPhrases"] textarea')
        .dispatchEvent(new Event("change", { bubbles: true }));
      // Scoped: the note preset bar is identical and sits in an earlier section.
      const swapBar = document.querySelector('[data-ar-presets="notes"]');
      swapBar.querySelector('input[placeholder="Preset name"]').value = "trial";
      [...swapBar.querySelectorAll("button")].find((b) => b.textContent.trim() === "Save as new").click();
      await frame();
      const before = JSON.parse(localStorage.getItem("lv-auto-retry:presets:v1")).notes.length;
      [...document.querySelectorAll("button")].find((b) => /^Reset/.test(b.textContent.trim())).click();
      await frame();
      const line = document.querySelector('[data-ar-reset="presets"]');
      const wasDisabled = line.querySelector("input").disabled;
      line.querySelector("input").checked = true;
      [...document.querySelectorAll("#__lvRetryReset button")]
        .find((b) => b.textContent.trim() === "Reset ticked").click();
      await frame();
      // Guarded rather than chained straight onto find(). A regression that
      // skips the asking step leaves no Yes button, and a TypeError here would
      // take the rest of the file down with it instead of failing one check.
      const confirmBtn = [...document.querySelectorAll("#__lvRetryReset button")]
        .find((b) => /^Yes, reset/.test(b.textContent.trim()));
      if (confirmBtn) confirmBtn.click();
      await frame();
      return {
        before,
        wasDisabled,
        after: JSON.parse(localStorage.getItem("lv-auto-retry:presets:v1")).notes.length,
        maxRetries: document.querySelector('[data-ar-row="maxRetries"] input').value,
      };
    }),
  );
  check("with a preset saved, that line can be ticked", out.before === 1 && out.wasDisabled === false, out);
  check("ticking it deletes the presets straight away", out.after === 0, out);
  check("and leaves the settings alone", out.maxRetries === "9", out);
  check("no console errors", errors.length === 0, errors);
}

// The two things a reset can do are not equally serious, and the confirmation
// has to say which one this is. Settings go back and are undone by closing the
// panel; presets are gone. Painting both the same would make the warning worth
// ignoring on the one that matters.
console.log("\nreset urgency");
{
  const { out, errors } = await inPanel(browser, {}, async (page) =>
    page.evaluate(async () => {
      const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      for (const h of document.querySelectorAll('[role="button"][aria-expanded="false"]')) h.click();
      // Sections travel open now, so their contents have no height for the
      // length of that. Waited out here rather than in every check below.
      await new Promise((r) => setTimeout(r, 260));
      await frame();
      const el = document.querySelector('[data-ar-row="maxRetries"] input');
      el.value = "9";
      el.dispatchEvent(new Event("change", { bubbles: true }));
      // Save a preset so its line can be ticked.
      document.querySelector('[data-ar-row="refusalExtraPhrases"] textarea').value = "cat => dog";
      document.querySelector('[data-ar-row="refusalExtraPhrases"] textarea')
        .dispatchEvent(new Event("change", { bubbles: true }));
      // Scoped: the note preset bar is identical and sits in an earlier section.
      const swapBar = document.querySelector('[data-ar-presets="notes"]');
      swapBar.querySelector('input[placeholder="Preset name"]').value = "trial";
      [...swapBar.querySelectorAll("button")].find((b) => b.textContent.trim() === "Save as new").click();
      await frame();

      const inBox = (re) => [...document.querySelectorAll("#__lvRetryReset button")]
        .find((b) => re.test(b.textContent.trim())) || null;
      const open = async () => {
        [...document.querySelectorAll("button")].find((b) => /^Reset/.test(b.textContent.trim())).click();
        await frame();
      };
      const read = () => {
        const wrap = document.querySelector("[data-ar-reset-confirm]").parentElement;
        const head = wrap.firstElementChild;
        const yes = inBox(/^Yes, reset/);
        return {
          edge: getComputedStyle(wrap).borderLeftColor,
          wash: getComputedStyle(wrap).backgroundColor,
          head: head.textContent.trim(),
          headWeight: getComputedStyle(head).fontWeight,
          headColour: getComputedStyle(head).color,
          yesLabel: yes.textContent.trim(),
          yesBg: getComputedStyle(yes).backgroundColor,
        };
      };

      // Settings only.
      await open();
      document.querySelector('[data-ar-reset="retry"] input').checked = true;
      inBox(/^Reset ticked/).click();
      await frame();
      const settingsOnly = read();
      inBox(/^Go back/).click();
      await frame();

      // Presets as well.
      document.querySelector('[data-ar-reset="presets"] input').checked = true;
      inBox(/^Reset ticked/).click();
      await frame();
      const withPresets = read();
      // A button's colour is what it rests at, not what it is painted right
      // now. Setting the background alone was undone by the next mouseleave,
      // so the danger red came off the moment a pointer crossed it.
      const yes = inBox(/^Yes, reset/);
      yes.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
      await frame();
      const onHover = getComputedStyle(yes).backgroundColor;
      yes.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
      await frame();
      const afterHover = getComputedStyle(yes).backgroundColor;

      const presetLabel = document.querySelector('[data-ar-reset="presets"] strong');
      return {
        settingsOnly,
        withPresets,
        onHover,
        afterHover,
        presetBold: !!presetLabel,
        presetColour: presetLabel ? getComputedStyle(presetLabel).color : "",
        presetWeight: presetLabel ? getComputedStyle(presetLabel).fontWeight : "",
      };
    }),
  );

  // Amber is not red, and a pattern that only looked at the first channel said
  // it was: #f59e0b starts with 245 the same way #ef4444 starts with 239. The
  // green channel is what tells them apart (158 against 68).
  const red = (c) => {
    const n = (String(c).match(/\d+/g) || []).map(Number);
    return n.length >= 3 && n[0] > 180 && n[1] < 120 && n[2] < 120;
  };
  check("the permanent line is bold", out.presetBold && Number(out.presetWeight) >= 600, out);
  check("and carries the danger colour", red(out.presetColour), out.presetColour);
  check("the confirmation headline is bold",
    Number(out.settingsOnly.headWeight) >= 600, out.settingsOnly);
  // Settings-only is a question, not a warning: closing the panel undoes it.
  check("a settings-only reset does not claim to be permanent",
    !/cannot be undone/i.test(out.settingsOnly.head), out.settingsOnly.head);
  check("and is not painted red", !red(out.settingsOnly.edge), out.settingsOnly.edge);
  check("adding presets turns it red", red(out.withPresets.edge), out.withPresets.edge);
  check("and says so in the headline",
    /cannot be undone/i.test(out.withPresets.head), out.withPresets.head);
  check("and the button that commits it says what it will do",
    /delete/i.test(out.withPresets.yesLabel), out.withPresets.yesLabel);
  check("and is red too", red(out.withPresets.yesBg), out.withPresets.yesBg);
  check("and stays red under a pointer", red(out.onHover), out.onHover);
  check("and after the pointer leaves", red(out.afterHover), out.afterHover);
  check("no console errors", errors.length === 0, errors);
}

// Cancel and Escape have to leave everything where it was, or the picker is a
// worse trap than the button it replaced.
{
  const { out, errors } = await inPanel(browser, {}, async (page) =>
    page.evaluate(async () => {
      const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      for (const h of document.querySelectorAll('[role="button"][aria-expanded="false"]')) h.click();
      // Sections travel open now, so their contents have no height for the
      // length of that. Waited out here rather than in every check below.
      await new Promise((r) => setTimeout(r, 260));
      await frame();
      const el = document.querySelector('[data-ar-row="maxRetries"] input');
      el.value = "9";
      el.dispatchEvent(new Event("change", { bubbles: true }));
      const open = async () => {
        [...document.querySelectorAll("button")].find((b) => /^Reset/.test(b.textContent.trim())).click();
        await frame();
      };
      await open();
      document.querySelector('[data-ar-reset="retry"] input').checked = true;
      [...document.querySelectorAll("#__lvRetryReset button")]
        .find((b) => b.textContent.trim() === "Cancel").click();
      await frame();
      const afterCancel = document.querySelector('[data-ar-row="maxRetries"] input').value;
      await open();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await frame();
      return {
        afterCancel,
        afterEsc: document.querySelector('[data-ar-row="maxRetries"] input').value,
        gone: !document.getElementById("__lvRetryReset"),
      };
    }),
  );
  check("Cancel changes nothing", out.afterCancel === "9", out);
  check("Escape shuts it and changes nothing", out.afterEsc === "9" && out.gone, out);
  check("no console errors", errors.length === 0, errors);
}

// ---- nothing is left behind ----
// ---- what is left of find and replace ----
// The feature is gone. The one thing left is a card handing somebody's rules
// back to them, and it has to be absent for everyone who never used it.
console.log("\nfind and replace, retired");
{
  const { out, errors } = await inPanel(browser, {}, async (page) =>
      page.evaluate(async () => {
        const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        // Written the way a real install holds them: in the saved blob, not as
        // a live setting, because the panel has no field for them any more.
        const raw = JSON.parse(localStorage.getItem("lv-auto-retry:settings:v1") || "{}");
        raw.replaceRules = "cat => dog\nhot => cold";
        localStorage.setItem("lv-auto-retry:settings:v1", JSON.stringify(raw));
        window.__acts["auto-retry-settings"].cb();
        await frame();
        const box = document.querySelector("[data-ar-retired]");
        const saved = [];
        // The download is a link click in a real browser, so it is watched for
        // rather than followed.
        const realCreate = URL.createObjectURL;
        URL.createObjectURL = (b) => { saved.push(b); return realCreate.call(URL, b); };
        const text = box ? box.textContent : "";
        const get = box && box.querySelector('[data-ar-retired-save]');
        if (get) get.click();
        await frame();
        const file = saved.length ? await saved[0].text() : "";
        const hide = box && box.querySelector('[data-ar-retired-hide]');
        if (hide) hide.click();
        await frame();
        URL.createObjectURL = realCreate;
        return {
          there: !!box && !!box.textContent.trim(),
          saysWhy: /retired/i.test(text) && /Auto Refine/.test(text),
          counted: /2 rules/.test(text),
          file,
          goneAfterHide: !document.querySelector("[data-ar-retired]") ||
            !document.querySelector("[data-ar-retired]").textContent.trim(),
          remembered: !!localStorage.getItem("lv-auto-retry:swaps-retired:v1"),
        };
      }),
  );
  check("somebody with rules is told the feature went", out.there && out.saysWhy, out);
  check("and how much of theirs is still there", out.counted, out);
  check("the download holds the rules themselves", /cat => dog/.test(out.file), out.file.slice(0, 120));
  check("hiding it takes it away", out.goneAfterHide && out.remembered, out);

  // Hiding the card must not be a decision anybody has to get right first time.
  // The same download stays under Import / export for as long as there is
  // anything to hand back.
  const { out: after, errors: e2 } = await inPanel(browser, {}, async (page) =>
    page.evaluate(async () => {
      const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const raw = JSON.parse(localStorage.getItem("lv-auto-retry:settings:v1") || "{}");
      raw.replaceRules = "cat => dog";
      localStorage.setItem("lv-auto-retry:settings:v1", JSON.stringify(raw));
      // Already dismissed, the way somebody who pressed it by accident is.
      localStorage.setItem("lv-auto-retry:swaps-retired:v1", "1");
      window.__acts["auto-retry-settings"].cb();
      await frame();
      for (const h of document.querySelectorAll('[role="button"][aria-expanded="false"]')) h.click();
      // Sections travel open now, so their contents have no height for the
      // length of that. Waited out here rather than in every check below.
      await new Promise((r) => setTimeout(r, 260));
      await frame();
      const saved = [];
      const realCreate = URL.createObjectURL;
      URL.createObjectURL = (b) => { saved.push(b); return realCreate.call(URL, b); };
      const row = document.querySelector("[data-ar-old-swaps]");
      const get = document.querySelector("[data-ar-old-swaps-save]");
      if (get) get.click();
      await frame();
      const file = saved.length ? await saved[0].text() : "";
      URL.createObjectURL = realCreate;
      return {
        cardGone: !document.querySelector("[data-ar-retired]") ||
          !document.querySelector("[data-ar-retired]").textContent.trim(),
        rowThere: !!row,
        file,
      };
    }),
  );
  check("with the card dismissed, the way back is still in Import / export",
    after.cardGone && after.rowThere, after);
  check("and it hands over the same rules", /cat => dog/.test(after.file), after.file.slice(0, 100));
  check("no console errors on the way back", e2.length === 0, e2);
  check("no console errors", errors.length === 0, errors);
}

// A row that hangs off a switch moves in the same way a section does, since
// they are the same thing happening: something that was not on the panel now is.
{
  const { out, errors } = await inPanel(browser, {}, async (page) =>
    page.evaluate(async () => {
      const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      await frame();
      for (const h of document.querySelectorAll('[role="button"][aria-expanded="false"]')) h.click();
      // Sections travel open now, so their contents have no height for the
      // length of that. Waited out here rather than in every check below.
      await new Promise((r) => setTimeout(r, 260));
      await frame();
      // A switch with rows named after it in the schema, rather than whichever
      // one happens to be first: Pause when it keeps failing carries the two
      // rows saying how many runs and how long a pause.
      const kid = () => document.querySelector('#modal [data-ar-row="breakerRuns"]');
      const parent = document.querySelector('#modal [data-ar-row="pauseWhenFailing"]');
      const sw = parent && parent.querySelector("input[data-ar-check]");
      if (!sw || !kid()) return { found: false, sw: !!sw, kid: !!kid() };
      // Rows only. The sections were opened by hand just above, and an opened
      // section is marked to move for the same reason a row is, so counting
      // both would be counting this check's own clicks.
      const marks = () => document.querySelectorAll("#modal [data-ar-row][data-ar-arrive]").length;
      const onBuild = marks();
      // Whichever way it starts, drive it off and then on.
      if (kid().style.display !== "none") sw.click();
      await frame();
      const hidden = kid().style.display === "none";
      const wentAway = marks();
      sw.click();
      const back = kid();
      const shown = back.style.display !== "none";
      const marked = back.getAttribute("data-ar-arrive");
      const cs = getComputedStyle(back);
      const anim = { name: cs.animationName, time: cs.animationDuration };
      await new Promise((r) => setTimeout(r, 300));
      const after = getComputedStyle(back);
      const settled = { opacity: after.opacity, shown: after.display };
      return { found: true, onBuild, hidden, wentAway, shown, marked, anim, settled };
    }),
  );
  check("the switch and the row under it are both there to drive", out.found, out);
  check("nothing is animated just for the panel being built", out.onBuild === 0, out);
  check("switching it off takes the row away", out.hidden, out);
  check("and marks nothing, since going away is not worth watching", out.wentAway === 0, out);
  check("switching it back on brings the row and marks it to move",
    out.shown && out.marked === "1", out);
  check("with the same shape and time as a section opening",
    out.anim && out.anim.name === "lvRetryArrive" && out.anim.time === "0.18s", out.anim);
  check("and it settles fully in place",
    out.settled && out.settled.opacity === "1" && out.settled.shown === "flex", out.settled);
  check("no console errors", errors.length === 0, errors);
}

// A section opening moves rather than appearing between two frames.
{
  const { out, errors } = await inPanel(browser, {}, async (page) =>
    page.evaluate(async () => {
      const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      await frame();
      const head = document.querySelector('[role="button"][aria-expanded="false"]');
      if (!head) return { missing: true };
      const body = head.parentElement.querySelector("div[style*='display: none']") ||
        head.nextElementSibling;
      // Every section is applied once while the panel is built, and animating
      // those would have the whole thing shimmer itself into existence.
      const onBuild = body.getAttribute("data-ar-arrive");
      head.click();
      const opened = body.getAttribute("data-ar-arrive");
      const style = getComputedStyle(body);
      const mid = { name: style.animationName, time: style.animationDuration };
      await new Promise((r) => setTimeout(r, 300));
      // Read into a plain object here and not later. getComputedStyle hands
      // back a live view, so holding on to it and reading it after the next
      // click reports the state the section ended in rather than the one being
      // asked about.
      const after = getComputedStyle(body);
      const settled = { opacity: after.opacity, shown: after.display };
      head.click();
      const shut = body.getAttribute("data-ar-arrive");
      return { missing: false, onBuild, opened, shut, mid, settled };
    }),
  );
  check("a section is not animated just for being built", !out.missing && out.onBuild === null, out);
  check("opening one marks it to move", out.opened === "1", out);
  check("with the same shape and time as Auto Refine's folds",
    out.mid.name === "lvRetryArrive" && out.mid.time === "0.18s", out.mid);
  check("and it settles fully open", out.settled.opacity === "1" && out.settled.shown === "flex", out.settled);
  check("shutting it takes the mark off again", out.shut === null, out);
  check("no console errors", errors.length === 0, errors);
}

// What a file gives and what it takes are two questions with one answer each.
{
  const { out, errors } = await inPanel(browser, {}, async (page) =>
    page.evaluate(async () => {
      const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      await frame();
      for (const h of document.querySelectorAll('[role="button"][aria-expanded="false"]')) h.click();
      // Sections travel open now, so their contents have no height for the
      // length of that. Waited out here rather than in every check below.
      await new Promise((r) => setTimeout(r, 260));
      await frame();
      const outList = document.querySelector('[data-ar-parts="export"]');
      const inList = document.querySelector('[data-ar-parts="import"]');
      if (!outList || !inList) return { missing: true };
      const outBoxes = Array.from(outList.querySelectorAll('input[type="checkbox"]'));
      const inBoxes = Array.from(inList.querySelectorAll('input[type="checkbox"]'));
      // Untick everything on the import side only.
      for (const b of inBoxes) if (b.checked) b.click();
      // Long enough for the mark to have finished going. Reading it a frame
      // later catches it part-way out, which is the animation working and not
      // an answer to whether the box ends up empty.
      await new Promise((r) => setTimeout(r, 300));
      return {
        missing: false,
        same: outBoxes.length === inBoxes.length,
        outStillOn: outBoxes.every((b) => b.checked),
        inAllOff: inBoxes.every((b) => !b.checked),
        // Both are drawn by us rather than by the browser, so they can animate.
        drawn: outBoxes.concat(inBoxes).every((b) => b.getAttribute("data-ar-check") === "1"),
        appearance: getComputedStyle(outBoxes[0]).appearance,
        tickHidden: getComputedStyle(inBoxes[0], "::after").opacity,
        tickShown: getComputedStyle(outBoxes[0], "::after").opacity,
        moves: /transform/.test(getComputedStyle(outBoxes[0], "::after").transitionProperty),
      };
    }),
  );
  check("there are two lists of ticks, not one", !out.missing && out.same, out);
  check("unticking what a file may change leaves what goes into one alone",
    out.inAllOff && out.outStillOn, out);
  check("the boxes are drawn by us, so they can be animated", out.drawn && out.appearance === "none", out);
  check("a ticked one shows its mark and an unticked one does not",
    out.tickShown === "1" && out.tickHidden === "0", out);
  check("and the mark moves rather than appearing", out.moves, out);
  check("no console errors", errors.length === 0, errors);
}

// Somebody who never used it should never learn it existed.
{
  const { out, errors } = await inPanel(browser, {}, async (page) =>
    page.evaluate(() => {
      const box = document.querySelector("[data-ar-retired]");
      return { empty: !box || !box.textContent.trim() };
    }),
  );
  check("and somebody who never used it sees nothing", out.empty, out);
  check("no console errors", errors.length === 0, errors);
}

console.log("\nteardown");
{
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await stage(page, "<div id=modal></div>");
  await page.addStyleTag({ content: THEME });
  await page.addScriptTag({ content: SOURCE, type: "module" });
  await page.waitForFunction(() => !!window.__setup);
  const out = await page.evaluate(async () => {
    const live = new Map();
    let duplicate = false;
    const teardown = window.__setup(
      {
        events: { on: () => () => {} },
        ui: {
          showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
          registerInputBarAction: (o) => {
            if (live.has(o.id)) duplicate = true;
            const a = {
              onClick: (cb) => { a.cb = cb; return () => {}; },
              destroy: () => live.delete(o.id),
            };
            live.set(o.id, a);
            return a;
          },
          showContextMenu: (o) => { (window.__menus ||= []).push(o); return Promise.resolve({ selectedKey: window.__pick === undefined ? null : window.__pick }); },
          createFloatWidget: () => ({ root: document.createElement("div"), destroy() {} }),
        },
      },
      // The floating button stays down here. With it up its own menu takes the
      // movable entries over and only the settings one is left in Extras, which
      // is the wrong shape for a check about tearing all of them down.
      { showExtrasToggle: true, showFloatingToggle: false, showReplaceButton: true, showSwapAllButton: true },
    );
    const registered = [...live.keys()];
    // Open a hint first, or "the popover is gone afterwards" passes because one
    // was never there. Same for the toast, which only exists once shown.
    window.__acts = { settings: live.get("auto-retry-settings") };
    live.get("auto-retry-settings").cb();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    document.querySelector("button[data-ar-hint]").dispatchEvent(new MouseEvent("mouseenter"));
    live.get("auto-retry-toggle").cb();
    await new Promise((r) => setTimeout(r, 30));
    const hintWasOpen = !!document.querySelector('[role="tooltip"]');
    const toastWasUp = !!document.getElementById("__lvRetryToast");
    // The full-size editor hangs off the page rather than off the modal, so
    // dismissing the modal never took it with it. It is the one thing here that
    // covers the whole screen, which makes it the worst thing to leave behind.
    const doneButton = () =>
      [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Done");
    const expand = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Expand");
    if (expand) expand.click();
    await new Promise((r) => setTimeout(r, 30));
    const editorWasOpen = doneButton();
    teardown();
    return {
      registered,
      duplicate,
      left: [...live.keys()],
      hintWasOpen,
      toastWasUp,
      editorWasOpen,
      toastGone: !document.getElementById("__lvRetryToast"),
      hintGone: !document.querySelector('[role="tooltip"]'),
      editorGone: !doneButton(),
    };
  });
  await page.close();
  check("both Extras entries register", out.registered.length === 2, out.registered);
  check("none register twice", !out.duplicate);
  check("teardown removes every one", out.left.length === 0, out.left);
  check("a hint, a toast and the full-size editor were actually up first",
    out.hintWasOpen && out.toastWasUp && out.editorWasOpen, out);
  check("teardown removes the toast and any hint", out.toastGone && out.hintGone);
  check("and the full-size editor with them", out.editorGone, out);
  check("no console errors", errors.length === 0, errors);
}


// ---- the panel built again in place, which is what Update does ----
// Updating the extension tears the panel down and sets it up again with no
// reload, and the backend restarts under it. The panel comes back holding no
// chat, and the two things it can ask both mislead it at that moment: the
// backend answers "which chat is open" with the account's most recent chat,
// which on the home screen is the one you were in before the update, and a
// backend still starting up answers "nobody is in a chat" while you are plainly
// sitting in one. Neither used to be checked against anything.
console.log("\nrebuilt in place");
{
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await stage(page, '<div id=modal></div><button data-testid="regenerate">R</button>');
  await page.addScriptTag({ content: SOURCE, type: "module" });
  await page.waitForFunction(() => !!window.__setup);
  const out = await page.evaluate(async () => {
    localStorage.removeItem("lv-auto-retry:url-slot:v1");
    const tick = (ms) => new Promise((r) => setTimeout(r, ms || 90));
    const res = {};
    let sent = [], listeners = [];
    // What the backend says when asked which chat is open. Set per case.
    let answerWith = null;
    const build = (url) => {
      try { window.__teardown && window.__teardown(); } catch (_) {}
      document.getElementById("modal").innerHTML = "";
      history.pushState({}, "", url);
      sent = []; listeners = [];
      window.__acts = {}; window.__handlers = {};
      window.__teardown = window.__setup({
        events: { on: (n, f) => { window.__handlers[n] = f; return () => {}; } },
        sendToBackend: (m) => {
          sent.push(m);
          if (m && m.type === "get_active_chat" && answerWith !== null) {
            const a = answerWith;
            setTimeout(() => listeners.slice().forEach((f) => {
              try {
                f({ type: "active_chat", requestId: m.requestId, chatId: a,
                    character: a ? "Wren" : null, resolved: true, hasCharacter: !!a });
              } catch (_) {}
            }), 0);
          }
        },
        onBackendMessage: (cb) => {
          listeners.push(cb);
          return () => { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); };
        },
        ui: { showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
              registerInputBarAction: (o) => { const a = { onClick: (cb) => { a.cb = cb; return () => {}; }, destroy: () => {} }; window.__acts[o.id] = a; return a; } },
      }, { toast: false, stuckTimeoutMs: 0, idleTimeoutMs: 0 });
    };
    const openPanel = async () => {
      window.__acts["auto-retry-settings"].cb();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      await tick();
    };
    const note = () => {
      const w = document.getElementById("modal").querySelector("[data-ar-chat-switch]");
      return w ? w.innerText.replace(/\s+/g, " ") : "";
    };
    const asks = () => sent.filter((m) => m.type === "get_active_chat").length;

    // A chat first, with its id in the address, which is the one moment the
    // panel can learn where in an address an id sits. That is kept in this
    // browser, which is what makes it there after the rebuild.
    answerWith = "oldchat00001";
    build("/chat/oldchat00001");
    window.__handlers.GENERATION_STARTED({ chatId: "oldchat00001", generationId: "g1" });
    window.__handlers.GENERATION_ENDED({ chatId: "oldchat00001", generationId: "g1", content: "ok reply here." });
    await tick(300);
    res.slotLearned = !!localStorage.getItem("lv-auto-retry:url-slot:v1");

    // Update pressed on the home screen. The backend names the chat from before.
    build("/");
    await openPanel();
    await tick(300);
    res.homeNote = note();
    res.homeAsks = asks();

    // Update pressed in a chat, with the backend not up yet.
    answerWith = null;
    build("/chat/oldchat00001");
    await openPanel();
    // The first answer, from something that could look, saying there is none.
    sent.filter((m) => m.type === "get_active_chat").forEach((m) => {
      listeners.slice().forEach((f) => {
        try { f({ type: "active_chat", requestId: m.requestId, chatId: null, character: null, resolved: true, hasCharacter: false }); } catch (_) {}
      });
    });
    await tick(200);
    res.coldNote = note();
    const asked = asks();
    await tick(3000);
    res.askedAgain = asks() > asked;
    // It comes up.
    sent.filter((m) => m.type === "get_active_chat").forEach((m) => {
      listeners.slice().forEach((f) => {
        try { f({ type: "active_chat", requestId: m.requestId, chatId: "oldchat00001", character: "Wren", resolved: true, hasCharacter: true }); } catch (_) {}
      });
    });
    await tick(200);
    res.warmNote = note();

    // And the same thing taking longer than the quick run of questions, which
    // is what the Update button does: it resets to the remote branch and
    // rebuilds, and a rebuild is not always over in six seconds.
    answerWith = null;
    build("/chat/oldchat00001");
    await openPanel();
    // Nothing answers at all, the way a backend that is not there yet does not
    // answer. Counted from after the quick run is over rather than from the
    // start, so the quick run's own questions cannot be mistaken for the slow
    // one still going.
    await tick(8000);
    const afterQuick = asks();
    await tick(12000);
    res.slowAsks = asks() - afterQuick;
    // It finishes rebuilding and answers.
    answerWith = "oldchat00001";
    await tick(6000);
    res.slowNote = note();
    return res;
  });
  await page.close();

  check("the address teaches where a chat id sits", out.slotLearned, out);
  check("rebuilt on the home screen, the last chat is not taken for this one",
    /No chat is open/.test(out.homeNote), out.homeNote);
  check("and the row does not offer to switch a chat off there",
    !/Turn off here/.test(out.homeNote) || /No chat is open/.test(out.homeNote), out.homeNote);
  check("a backend still starting up is believed for now",
    /No chat is open|Waiting to find out/.test(out.coldNote), out.coldNote);
  check("but it is asked again rather than taken as final", out.askedAgain, out);
  check("and the row lands in the chat once it answers",
    !/No chat is open|Waiting to find out/.test(out.warmNote), out.warmNote);
  check("a rebuild slower than the quick run is still being asked about",
    out.slowAsks >= 2, out);
  check("and the row lands in the chat when it finally answers",
    !/No chat is open|Waiting to find out/.test(out.slowNote), out.slowNote);
  check("no console errors", errors.length === 0, errors);
}


// ---- the count climbs while the reply is arriving ----
// A figure that is right at the end and right at the start still reads as a
// hang if it never moves in between. This watches it through the middle of one
// reply rather than at either end of it.
console.log("\nthe live count climbs as the reply arrives");
{
  const { out, errors } = await inPanel(
    browser,
    { settings: { liveLog: true, panelHome: "float" } },
    (page) =>
      page.evaluate(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const read = () => {
          const e = document.getElementById("__lvRetryStatus");
          return e ? e.textContent.trim() : "";
        };
        const count = () => {
          const m = /([\d,]+) characters/.exec(read());
          return m ? Number(m[1].replace(/,/g, "")) : null;
        };
        window.__handlers.GENERATION_STARTED({ chatId: "c1", generationId: "g1", messageId: "m1" });
        await wait(60);
        const seen = [];
        for (let i = 0; i < 8; i++) {
          window.__handlers.STREAM_TOKEN_RECEIVED({
            chatId: "c1", generationId: "g1", token: "0123456789", type: "content", seq: i,
          });
          // Longer than the quarter-second clock, so each reading is a repaint
          // that happened rather than one that might have.
          await wait(320);
          const n = count();
          if (n !== null) seen.push(n);
        }
        return { seen: seen, line: read() };
      }),
  );
  const seen = out.seen || [];
  check("the line counts what has arrived", seen.length >= 3, out);
  check("and the count climbs while it arrives",
    seen.length >= 3 && seen[seen.length - 1] > seen[0], out);
  check("without ever going backwards",
    seen.every((n, i) => i === 0 || n >= seen[i - 1]), out);
  check("landing on everything that came", /80 characters/.test(out.line || ""), out.line);
  check("no console errors", errors.length === 0, errors);
}


// ---- opening a section does not throw the panel ----
// A section is most of a screen. Its body used to fade in while its height
// arrived whole, so everything below it moved twelve hundred pixels between two
// frames: the fade said something was arriving and the jump said the panel had
// lost its place.
console.log("\nsections open without throwing the panel");
{
  const measure = (shutFirst) =>
    inPanel(browser, {}, (page) =>
      page.evaluate(async (closeIt) => {
        const root = document.getElementById("modal");
        const shut = () => [...root.querySelectorAll('[aria-expanded="false"]')];
        const head = shut()[0];
        const below = shut()[1];
        if (!head || !below) return { err: "not enough sections" };
        const at = () => below.getBoundingClientRect().top;
        if (closeIt) {
          head.click();
          await new Promise((r) => setTimeout(r, 400));
        }
        const before = at();
        head.click();
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const after = at();
        await new Promise((r) => setTimeout(r, 600));
        const rested = at();
        return {
          moved: Math.abs(Math.round(after - before)),
          settled: Math.abs(Math.round(rested - before)),
        };
      }, shutFirst),
    );

  // Against how far it had to travel, so the rule reads the same for a short
  // section and a long one.
  const smooth = (o) => o.moved < Math.max(6, o.settled / 3);

  const { out: open, errors: openErrors } = await measure(false);
  check("opening one travels rather than jumping", smooth(open), open);
  check("and it really is open by the end", open.settled > 200, open);
  check("opening one: no console errors", openErrors.length === 0, openErrors);

  const { out: close, errors: closeErrors } = await measure(true);
  check("closing one travels too", smooth(close), close);
  check("and it really is closed by the end", close.settled > 200, close);
  check("closing one: no console errors", closeErrors.length === 0, closeErrors);
}

await browser.close();
console.log(failures ? `\n${failures} FAILED` : "\nall browser checks passed");
process.exit(failures ? 1 : 0);
