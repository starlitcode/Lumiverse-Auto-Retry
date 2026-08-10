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
body{background:rgb(10,8,18);margin:0}#modal{background:rgb(35,30,48);padding:0;width:456px}`;

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
    window.__setup(
      {
        events: { on: () => () => {} },
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

function brightestPixel(buf) {
  const px = decodePixels(buf);
  if (!px) return null;
  return px.reduce((a, p) => (p.r + p.g + p.b > a.r + a.g + a.b ? p : a), px[0]);
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
    route.fulfill({ contentType: "text/html", body: "<!doctype html><meta charset=utf-8>" + body }),
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
    page.evaluate(() => {
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
    }),
  );
  check(`${label}: all ${out.count} labels clear 3.0`, out.under3.length === 0, out.under3);
  check(`${label}: no console errors`, errors.length === 0, errors);
  if (label === "raised text scale") {
    // The panel is interface chrome and must not follow the reader's text-size
    // setting; doing so once made it grow until barely one section fitted.
    check("raised text scale: panel text does not grow", out.labelPx === 13, out.labelPx);
  }
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
        const below = [...modal.querySelectorAll("span")].find(
          (s) => s.textContent === "Floating on/off button",
        );
        const before = below.getBoundingClientRect().top;
        infos[0].click();
        await frame();
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
        const afterRetap = pops();
        infos[0].click();
        await frame();
        document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
        await frame();
        const afterOutside = pops();
        infos[0].click();
        await frame();
        const scroller = [...modal.querySelectorAll("div")].find(
          (d) => getComputedStyle(d).overflowY === "auto",
        );
        scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
        await frame();
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
// It used to hang off the "?" button, which is 18px tall and sits partway down
// a row that can be two lines high, so the description landed on top of the
// very setting being asked about. Measuring the row instead also makes this
// hold at any scale the host applies, since it reads what was actually painted.
console.log("\nhints do not cover their own row");
// The scales below are the range of Lumiverse's own UI Scale slider, which
// runs 0.8 to 1.5. It applies as a zoom on the page, and the popover is
// parented to the page so it gets zoomed too: an earlier version of this check
// zoomed only #modal, which left the popover and the row in one coordinate
// space and passed while the real thing was broken at 0.9.
for (const [label, css] of [
  ["normal", ""],
  ["UI Scale 0.8", "body{zoom:0.8}"],
  ["UI Scale 0.9", "body{zoom:0.9}"],
  ["UI Scale 1.5", "body{zoom:1.5}"],
  ["scaled by transform", "body{transform:scale(0.9);transform-origin:top left}"],
  ["larger host text", "#modal{font-size:20px}"],
]) {
  const { out, errors } = await inPanel(
    browser,
    { css, viewport: { width: 480, height: 1030 }, touch: true },
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
      const vis = (w) =>
        [...modal.querySelectorAll("span")].filter(
          (s) => s.textContent === w && s.offsetParent !== null,
        ).length;
      const heads = [...modal.querySelectorAll('[role="button"][aria-expanded]')];
      const refusal = heads.find((h) => /refusal tuning/i.test(h.textContent || ""));
      refusal.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await frame();
      const afterEnter = { exp: refusal.getAttribute("aria-expanded"), vis: vis("Extra thinking tag names") };
      refusal.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
      await frame();
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
  check("every section header is focusable", out.focusable && out.sections >= 6, out.sections);
  check("Enter opens a section", out.afterEnter.exp === "true" && out.afterEnter.vis === 1, out.afterEnter);
  check("Space closes it", out.afterSpace.exp === "false" && out.afterSpace.vis === 0, out.afterSpace);
  check("search filters", out.filtered.hit === 1 && out.filtered.miss === 0, out.filtered);
  check("clearing restores every row", out.cleared.hit === 1 && out.cleared.miss === 1, out.cleared);
  check("the search field is always visible", out.searchAlwaysVisible);
  check("the panel uses the height it is given", out.panelHeight > 500, out.panelHeight);
  check("no console errors", errors.length === 0, errors);
}

// ---- find and replace says what a preset carries ----
// Half these options change when you load a preset and half never do, and there
// was no way to tell which from looking. The lists below are the contract: if
// the preset definition changes, this fails and the headings get updated with
// it, rather than quietly starting to lie.
console.log("\npreset split");
{
  const { out, errors } = await inPanel(browser, {}, (page) =>
    page.evaluate(async () => {
      const frame = () =>
        new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const modal = document.getElementById("modal");
      const head = [...modal.querySelectorAll('[role="button"][aria-expanded]')].find((h) =>
        /find and replace/i.test(h.textContent || ""));
      head.click();
      await frame();
      // A run's wrapper is the div whose first child is the heading itself.
      const run = (t) =>
        [...modal.querySelectorAll("div")].find(
          (d) => d.firstElementChild && d.firstElementChild.textContent === t);
      const inPreset = run("Saved in a preset");
      const yours = run("Yours, whatever preset you load");
      const labels = (e) =>
        e ? [...e.querySelectorAll("[data-ar-row]")].map((r) => r.querySelector("span").textContent) : null;
      const shown = (e) => !!e && e.offsetParent !== null;
      const search = modal.querySelector("input[type=search]");
      const filter = async (q) => {
        search.value = q;
        search.dispatchEvent(new Event("input"));
        await frame();
        return { inPreset: shown(inPreset), yours: shown(yours) };
      };
      const onlyPreset = await filter("match case");
      const onlyYours = await filter("confirm");
      const cleared = await filter("");
      return {
        presetLabels: labels(inPreset),
        yoursLabels: labels(yours),
        onlyPreset,
        onlyYours,
        cleared,
      };
    }),
  );
  const expectPreset = [
    "Word swaps (old => new)",
    "Pick randomly when a word has more than one swap",
    "Match case exactly",
  ];
  // Everything in the find-and-replace group that a preset does not carry.
  // Two settings were added to this run and this list was not updated with
  // them, so the check had been failing on a correct panel.
  const expectYours = [
    'Show a "swap words now" button',
    "Show a swap-whole-chat button",
    "Allow swapping a reply again",
    "Ask before editing a reply",
    "Wait for other extensions to finish",
    "How long to wait (seconds)",
  ];
  const same = (a, b) => !!a && a.length === b.length && a.every((x, i) => x === b[i]);
  check("the preset run holds exactly what a preset saves", same(out.presetLabels, expectPreset), out.presetLabels);
  check("the other run holds everything a preset leaves alone", same(out.yoursLabels, expectYours), out.yoursLabels);
  check("a search hides the run with no matches", out.onlyPreset.inPreset && !out.onlyPreset.yours, out.onlyPreset);
  check("and the other way round", !out.onlyYours.inPreset && out.onlyYours.yours, out.onlyYours);
  check("clearing brings both back", out.cleared.inPreset && out.cleared.yours, out.cleared);
  check("no console errors", errors.length === 0, errors);
}

// ---- the note settings that are not per note say so ----
// The note list gives every note a role and a try to start on, which made the
// two settings underneath it read as more of the same, and the question came
// back twice: does this change one note or all of them. It is all of them, and
// a heading is where that gets said. This holds that the heading is over the
// right two rows and no others, so it cannot end up standing over a per-note
// setting and claiming the opposite of the truth.
console.log("\nwhole-list note settings");
{
  const { out, errors } = await inPanel(browser, {}, (page) =>
    page.evaluate(async () => {
      const frame = () =>
        new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const modal = document.getElementById("modal");
      for (const h of modal.querySelectorAll('[role="button"][aria-expanded="false"]')) h.click();
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

// ---- the box between the click and the reply ----
// With Regeneration Feedback on, pressing regenerate opens a box asking for
// guidance, and the reply only starts once that box is dealt with. An
// unattended retry has to get past it on its own. This stands one in and
// counts what gets pressed, since pressing the wrong thing there would throw
// the reply away rather than re-roll it.
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
// The float button used to carry a Unicode character, which meant its shape was
// whatever font the device happened to pick. These check it is an actual
// drawing, that on and off are told apart by more than colour, and that the
// drawing scales with the button instead of staying one size.
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
  check("off is marked by a slash, not just colour", out.off.slashes > out.on.slashes, {
    on: out.on.slashes, off: out.off.slashes });
  check("the drawing scales with the button", out.big.width > out.on.width, {
    at28: out.on.width, at96: out.big.width });
  check("it never scales below legible", out.on.width >= 14, out.on.width);
  check("every Extras entry carries an icon",
    out.actions.length > 0 && out.actions.every((a) => a.svg), out.actions);
  check("no console errors", errors.length === 0, errors);
}

// ---- nothing moves, and nothing needs to ----
// The float button used to carry transitions on four colour properties and a
// scale dip on every press, which is a compositing layer and four
// interpolations for a control whose whole job is to flip between two states.
// It flips instantly now. This is the check that keeps it that way, since a
// transition is one line to add back and costs a frame every time it runs.
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
    check(name + ", the button does not move under a press", !r.moved, r.moved);
    check(name + ", it animates nothing at all",
      /^0s(,\s*0s)*$/.test(String(r.transition).trim()), r.transition);
    // Removing the animation must not remove the feedback with it.
    check(name + ", a tap still changes its colour", r.recoloured, r);
  }
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
    const menu = () => document.querySelector('[role="menu"]');
    const items = () => [...document.querySelectorAll('[role="menuitem"]')].map((b) => b.textContent);
    const down = (el, x, y) => el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: x, clientY: y }));
    // Dispatched at the document, which is what a host that has captured the
    // pointer for its drag would produce. A move aimed at the button would not
    // reach a document listener by bubbling, so this is the harder case.
    const move = (_el, x, y) => document.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: x, clientY: y }));
    const up = (el) => el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));

    // A quick tap toggles and opens nothing.
    const wasOn = btn().getAttribute("aria-pressed");
    down(btn(), 130, 130); await wait(60); up(btn()); btn().click();
    const afterTap = { pressed: btn().getAttribute("aria-pressed"), menu: !!menu() };
    btn().click(); // back on

    // A hold opens the menu and does not toggle.
    const before = btn().getAttribute("aria-pressed");
    down(btn(), 130, 130); await wait(620);
    const openedByHold = !!menu();
    const entries = items();
    up(btn()); btn().click();
    const afterHold = { pressed: btn().getAttribute("aria-pressed"), same: btn().getAttribute("aria-pressed") === before };

    // On screen, not off the edge.
    const box = menu() ? menu().getBoundingClientRect() : null;
    const onScreen = !!box && box.left >= 0 && box.top >= 0 &&
      box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1;

    // Esc closes it.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    const afterEsc = !!menu();

    // A drag is not a hold.
    down(btn(), 130, 130); move(btn(), 190, 175); await wait(620);
    const afterDrag = !!menu();
    up(btn());

    // Resizing rebuilds the widget, and the rebuild used to start where a fresh
    // one starts, so wherever the button had been dragged to was thrown away.
    // Driven through the panel, which is the path a person takes and the one
    // that exercises the live preview at the same time.
    host.style.left = "300px";
    host.style.top = "260px";
    const askedBefore = asked.length;
    acts["auto-retry-settings"].cb();
    await wait(30);
    for (const h of document.querySelectorAll('[role="button"][aria-expanded="false"]')) h.click();
    await wait(30);
    const sizeBox = document.querySelector('[data-ar-row="floatingToggleSize"] input');
    const dot = document.querySelector('[data-ar-row="floatingToggleSize"] div[aria-hidden="true"]');
    sizeBox.value = "72";
    // input, not change: a preview is meant to move while it is being typed.
    sizeBox.dispatchEvent(new Event("input", { bubbles: true }));
    await wait(30);
    const resize = {
      rebuilt: asked.length > askedBefore,
      at: asked.length ? asked[asked.length - 1].initialPosition : null,
      size: asked.length ? asked[asked.length - 1].width : null,
      previewPx: dot ? dot.style.width : null,
    };

    // "Move back to the corner" rebuilds the widget.
    const widgetsBefore = widgets;
    down(btn(), 130, 130); await wait(620);
    [...document.querySelectorAll('[role="menuitem"]')].find((b) => /corner/i.test(b.textContent)).click();
    await wait(30);
    const rebuilt = widgets > widgetsBefore;
    up(btn());

    // How a menu item shows focus, and where the menu sits in the stack. Read
    // while the button still exists, since the next step removes it.
    down(btn(), 130, 130); await wait(620);
    const item = document.querySelector('[role="menuitem"]');
    const focus = {
      outline: getComputedStyle(item).outlineStyle,
      ringWhenFocused: (item.focus(), getComputedStyle(item).boxShadow),
      ringWhenBlurred: (item.blur(), getComputedStyle(item).boxShadow),
    };
    const menuZ = Number(getComputedStyle(menu()).zIndex);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    up(btn());

    // "Hide this button" takes it away and leaves no menu behind.
    down(btn(), 130, 130); await wait(620);
    [...document.querySelectorAll('[role="menuitem"]')].find((b) => /hide/i.test(b.textContent)).click();
    await wait(30);
    const gone = { button: !host.querySelector("button"), menu: !!menu() };

    // And teardown after all that leaves nothing.
    down(document.body, 1, 1);
    teardown();
    const left = { menu: !!menu(), items: items().length };
    return { wasOn, afterTap, openedByHold, entries, afterHold, onScreen, afterEsc, afterDrag, rebuilt, resize, gone, left, focus, menuZ };
  });
  await page.close();
  check("a quick tap still toggles", out.afterTap.pressed !== out.wasOn, out.afterTap);
  check("and opens no menu", !out.afterTap.menu);
  check("a hold opens the menu", out.openedByHold);
  check("with all three entries", out.entries.length === 3, out.entries);
  // The thing someone holding this button is most likely to be after, so it is
  // the one their thumb lands on first.
  check("settings is the first of them", /settings/i.test(out.entries[0]), out.entries);
  check("a hold does not also toggle", out.afterHold.same, out.afterHold);
  check("the menu lands on screen", out.onScreen);
  check("Esc closes it", !out.afterEsc);
  check("dragging is not a hold", !out.afterDrag);
  check("moving it back rebuilds the widget", out.rebuilt);
  check("resizing rebuilds it too", out.resize.rebuilt, out.resize);
  check("at the new size", out.resize.size === 72, out.resize);
  // The whole point: the rebuild is handed where the button already was, not
  // the corner a fresh one starts in.
  check("and keeps where the button was",
    !!out.resize.at && out.resize.at.x === 300 && out.resize.at.y === 260, out.resize);
  // A number in a box says nothing about how big the button will be.
  check("the preview circle is drawn at the size being typed",
    out.resize.previewPx === "72px", out.resize);
  check("hiding removes the button", out.gone.button, out.gone);
  check("and leaves no menu behind", !out.gone.menu);
  check("teardown leaves nothing", !out.left.menu && out.left.items === 0, out.left);
  // 2147483647 is the highest a browser accepts. Anything sitting there cannot
  // be drawn over by another extension, however much it needs to be.
  check("the menu does not claim the top of the stacking order",
    out.menuZ > 1000000 && out.menuZ < 2147483647, out.menuZ);
  check("menu items drop the browser's own focus ring", out.focus.outline === "none", out.focus);
  check("and show focus in the theme's colour instead",
    out.focus.ringWhenFocused !== "none" && out.focus.ringWhenBlurred === "none", out.focus);
  // Read from the built stylesheet rather than hard-coded here, so this tracks
  // whatever the pop-up actually uses.
  const toastZ = await (async () => {
    const page2 = await browser.newPage();
    await stage(page2, '<div id=modal></div><button data-testid="regenerate">Regenerate</button>');
    await page2.addStyleTag({ content: THEME });
    await page2.addScriptTag({ content: SOURCE, type: "module" });
    await page2.waitForFunction(() => !!window.__setup);
    const z = await page2.evaluate(async () => {
      const handlers = {};
      window.__setup(
        { events: { on: (n, fn) => { handlers[n] = fn; return () => {}; } },
          ui: { showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
                registerInputBarAction: () => ({ onClick: () => () => {}, destroy: () => {} }) } },
        { toast: true, retryDelayMs: 400, backoffFactor: 1, jitter: false, maxRetries: 2,
          stuckTimeoutMs: 0, idleTimeoutMs: 0, pauseWhenFailing: false },
      );
      handlers.GENERATION_STARTED({ chatId: "c", generationId: "g" });
      handlers.GENERATION_ENDED({ chatId: "c", content: "" });
      await new Promise((r) => setTimeout(r, 80));
      const t = document.getElementById("__lvRetryToast");
      return t ? Number(getComputedStyle(t).zIndex) : null;
    });
    await page2.close();
    return z;
  })();
  check("the menu sits above the retry pop-up", out.menuZ > toastZ, { menu: out.menuZ, toast: toastZ });
  check("no console errors", errors.length === 0, errors);
}

// ---- the countdown actually counts ----
// It used to say "in 47.3s" once and keep saying it for the next forty-seven
// seconds, so the one number anyone watches was the one that never moved. On
// the current defaults a wait can be a minute, which made a frozen number look
// like a frozen extension.
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
// Updating the extension reloads it, and the panel used to come back in the
// default corner at the default size every time. Dragging it clear of your
// chat and sizing it to what you want to read is work, and having to redo it
// on every update is what makes a panel not worth opening.
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
  // The dot: dim and flat when off, lit when on, pulsing only while working.
  check("the dot is lit but still with nothing to do",
    out.idleState === "idle" && out.idleAnim === "none" && out.idleGlow !== "none", out);
  check("and pulses while something is happening",
    out.busyState === "busy" && out.busyAnim === "lvRetryPulse", out);
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
    const teardown = window.__setup(
      { events: { on: (n, fn) => { handlers[n] = fn; return () => {}; } },
        sendToBackend: (m) => backend.push(m),
        onBackendMessage: (fn) => { window.__fromBackend = fn; return () => {}; },
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
      await page.evaluate(() => {
        for (const h of document.querySelectorAll('[role="button"][aria-expanded="false"]')) h.click();
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
      return { selectRest, selectClicked, focused, afterTab, textRest, textClicked };
    },
  );
  check("the dropdown is there to test", out.selectRest !== null, out);
  check("clicking it still focuses it", out.focused === true, out);
  check("but leaves its border alone", out.selectClicked === out.selectRest, out);
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

    // The retry fires and a reply starts. This is where it used to stay up and
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
    return { whileWaiting, afterRetryStarted, secondUp, hadCancel, afterCancel, laterStillUp, afterTwoStops };
  });
  await page.close();
  check("the pop-up counts the wait down", out.whileWaiting.up && /Retrying in/.test(out.whileWaiting.text), out);
  check("and goes once the retry has fired", out.afterRetryStarted.up === false, out);
  check("it does not stay to describe the reply that followed",
    !/Waiting for the reply|Model is thinking|Reply arriving/.test(out.afterRetryStarted.text), out);
  check("it comes back for the next wait", out.secondUp === true, out);
  check("its Cancel button is there", out.hadCancel === true, out);
  check("pressing Cancel takes the countdown away",
    !/Retrying in/.test(out.afterCancel.text) && out.afterCancel.cancelGone === true, out);
  check("and says so briefly instead", /stopped/i.test(out.afterCancel.text), out);
  check("and that confirmation clears itself", out.laterStillUp === false, out);
  check("stopping twice does not leave one behind", out.afterTwoStops.up === false, out);
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
      const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
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
    // it would show up as is the count creeping past one. Switched back and
    // forth enough times that a per-view interval could not hide.
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
  check("switching tabs never stacks up another clock", out.peak === 1, out);
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
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const sel = document.querySelector("select");
      const by = (t) => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === t);
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
console.log("\npreset boundary");
{
  const { out, errors } = await inPanel(browser, {}, async (page) =>
    page.evaluate(async () => {
      const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      for (const h of document.querySelectorAll('[role="button"][aria-expanded="false"]')) h.click();
      await frame();
      const by = (t) => [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === t);
      const ctl = (k) => {
        const r = document.querySelector('[data-ar-row="' + k + '"]');
        return r && (r.querySelector("textarea") || r.querySelector("input"));
      };
      const set = (k, v) => {
        const i = ctl(k);
        if (!i) return;
        if (i.type === "checkbox") { if (i.checked !== v) i.click(); }
        else { i.value = v; i.dispatchEvent(new Event("input", { bubbles: true })); i.dispatchEvent(new Event("change", { bubbles: true })); }
      };
      const get = (k) => { const i = ctl(k); return i ? (i.type === "checkbox" ? i.checked : i.value) : "(missing)"; };

      const OWNED = ["replaceRules", "replaceRandom", "replaceCaseSensitive"];
      const YOURS = ["replaceEnabled", "showReplaceButton", "showSwapAllButton", "allowReSwap", "confirmBeforeEdit"];

      // Everything on, saved into a preset.
      set("replaceRules", "cat => dog");
      for (const k of OWNED.slice(1).concat(YOURS)) set(k, true);
      by("Save").click(); await frame();
      document.querySelector('input[placeholder="Preset name"]').value = "A";
      by("Save as new").click(); await frame();

      // Everything off, saved.
      set("replaceRules", "hot => cold");
      for (const k of OWNED.slice(1).concat(YOURS)) set(k, false);
      by("Save").click(); await frame();

      // Load the preset back.
      const sel = document.querySelector("select");
      sel.value = "A";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      by("Load").click(); await frame();

      const owned = {}; for (const k of OWNED) owned[k] = get(k);
      const yours = {}; for (const k of YOURS) yours[k] = get(k);
      return { owned, yours };
    }),
  );
  check("a preset restores the rules it saved",
    out.owned.replaceRules === "cat => dog", out.owned);
  check("and the two options that decide how they match",
    out.owned.replaceRandom === true && out.owned.replaceCaseSensitive === true, out.owned);
  check("loading one cannot switch swapping on for you",
    out.yours.replaceEnabled === false, out.yours);
  check("cannot move buttons into your Extras menu",
    out.yours.showReplaceButton === false && out.yours.showSwapAllButton === false, out.yours);
  check("and cannot take away the confirmation step",
    out.yours.confirmBeforeEdit === false && out.yours.allowReSwap === false, out.yours);
  check("no console errors", errors.length === 0, errors);
}

// ---- the swap has to show up on screen, not just in storage ----
// The backend writes the swapped reply, but the host does not redraw the chat
// for it, so the frontend rewrites the visible text itself. That path had no
// coverage, and it is exactly where the 3.1.1 bug lived: the swap was saved
// correctly and stayed invisible until the chat was reopened.
console.log("\non-screen swap");
{
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await stage(page, '<div id=modal></div><div id=chat></div>');
  await page.addStyleTag({ content: THEME });
  await page.addScriptTag({ content: SOURCE, type: "module" });
  await page.waitForFunction(() => !!window.__setup);
  const out = await page.evaluate(async () => {
    let onMsg = null;
    window.__setup(
      {
        events: { on: () => () => {} },
        sendToBackend: () => {},
        onBackendMessage: (cb) => { onMsg = cb; return () => {}; },
        ui: { showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
              registerInputBarAction: () => ({ onClick: () => () => {}, destroy: () => {} }) },
      },
      { toast: false },
    );
    const chat = document.getElementById("chat");
    const run = async (html, pairs) => {
      chat.innerHTML = html;
      onMsg({ type: "swapped", pairs });
      await new Promise((r) => setTimeout(r, 30));
      return chat.textContent;
    };
    return {
      ascii: await run("<p>a cat here</p>", [["cat ", "dog "]]),
      inside: await run("<p>category stays</p>", [["cat ", "dog "]]),
      accent: await run("<p>a caf\u00e9 here</p>", [["caf\u00e9 ", "bar "]]),
      accentInside: await run("<p>caf\u00e9teria stays</p>", [["caf\u00e9 ", "bar "]]),
      cyrillic: await run("<p>\u043f\u0440\u0438\u0432\u0435\u0442 there</p>", [["\u043f\u0440\u0438\u0432\u0435\u0442 ", "hello "]]),
      cyrillicInside: await run("<p>\u043f\u0440\u0438\u0432\u0435\u0442\u0441\u0442\u0432\u0438\u0435 stays</p>", [["\u043f\u0440\u0438\u0432\u0435\u0442 ", "hello "]]),
      // The pairs above all carry the trailing space the backend captures, and
      // that space alone keeps "cat " out of "category". A swap at the end of a
      // sentence has no trailing space, and then only the boundary protects it.
      noTrail: await run("<p>category stays</p>", [["cat", "dog"]]),
      noTrailCyrillic: await run("<p>\u043f\u0440\u0438\u0432\u0435\u0442\u0441\u0442\u0432\u0438\u0435 stays</p>", [["\u043f\u0440\u0438\u0432\u0435\u0442", "hello"]]),
      noTrailHit: await run("<p>one cat.</p>", [["cat", "dog"]]),
      // The backend records one pair per match it made, so the pairs are the
      // budget: two matches in the newest reply means two pairs and exactly two
      // occurrences to change. Rewriting every occurrence in the last matching
      // node spent both on the first pair, and the second then went hunting
      // further up the page and rewrote an older message that had never been
      // edited. Reproduced before it was fixed: the older line read "The dog sat
      // here." while the stored chat still said cat.
      bleed: await run(
        "<div>The cat sat here.</div><div>A cat and a cat and more.</div>",
        [["cat ", "dog "], ["cat ", "dog "]],
      ),
      // The backend only ever edits replies, never anything the user wrote, so
      // a swap must not touch their messages on screen either. The whole-chat
      // path used to replace every occurrence everywhere and caught them.
      //
      // Sent with the wholeChat flag the backend used to set, even though
      // nothing reads it now. That flag is what chose the path this went wrong
      // on, so a check that leaves it out passes against the old code and
      // guards nothing.
      userMessage: await (async () => {
        chat.innerHTML = "<div>I like cat.</div><div>A cat.</div>";
        onMsg({ type: "swapped", pairs: [["cat", "dog"]], wholeChat: true });
        await new Promise((r) => setTimeout(r, 30));
        return chat.textContent;
      })(),
      // A field the user is typing in must never be rewritten underneath them.
      input: await (async () => {
        chat.innerHTML = "<textarea>a cat here</textarea>";
        onMsg({ type: "swapped", pairs: [["cat ", "dog "]] });
        await new Promise((r) => setTimeout(r, 30));
        return chat.querySelector("textarea").value;
      })(),
    };
  });
  await page.close();
  check("an English word is rewritten on screen", out.ascii === "a dog here", out.ascii);
  check("and not inside a longer word", out.inside === "category stays", out.inside);
  check("an accented word is rewritten too", out.accent === "a bar here", out.accent);
  check("and not inside a longer one", out.accentInside === "caf\u00e9teria stays", out.accentInside);
  check("a Cyrillic word is rewritten too", out.cyrillic === "hello there", out.cyrillic);
  check("and not inside a longer one", out.cyrillicInside === "\u043f\u0440\u0438\u0432\u0435\u0442\u0441\u0442\u0432\u0438\u0435 stays", out.cyrillicInside);
  check("with no trailing space, a longer word is still safe",
    out.noTrail === "category stays", out.noTrail);
  check("in any script", out.noTrailCyrillic === "\u043f\u0440\u0438\u0432\u0435\u0442\u0441\u0442\u0432\u0438\u0435 stays", out.noTrailCyrillic);
  check("while the real word at a sentence end still swaps",
    out.noTrailHit === "one dog.", out.noTrailHit);
  check("two matches in one reply are both rewritten, and no older message is",
    out.bleed === "The cat sat here.A dog and a dog and more.", out.bleed);
  check("a swap never rewrites one of your own messages",
    out.userMessage === "I like cat.A dog.", out.userMessage);
  check("a text box is left alone", out.input === "a cat here", out.input);
  check("no console errors", errors.length === 0, errors);
}

// ---- a backup has to bring everything back ----
// Settings have gone missing from exports before: four of them were absent from
// every backup and nobody noticed until a restore came back short. There is a
// safety net in the code that folds any unlisted setting into the retry
// category, and until now nothing checked that it works. This changes every
// setting in the panel, exports, resets, imports, and compares.
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
    const r = window.__ctl("replaceRules");
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
      rules: window.__get("replaceRules"),
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
      replace: { replaceRules: "hot => cold" },
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
    before.stored && before.stored.replaceRules === "cat => dog" &&
    afterGood.stored && afterGood.stored.replaceRules === "cat => dog", {
      beforeSave: afterGood.stored && afterGood.stored.replaceRules });
  check("and is kept once it is",
    afterSave.stored && afterSave.stored.replaceRules === "hot => cold", afterSave.stored && afterSave.stored.replaceRules);
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
      // This used to arm and then take it back, which was correct but spent the
      // whole acknowledgement wait getting there, and for the length of that
      // wait the backend held a note for a generation that never came. Runs
      // last, since it takes the button off the page.
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
          createFloatWidget: () => ({ root: host, destroy: () => {}, setPosition: () => {} }),
        },
      },
      { enabled: true, showFloatingToggle: true, toast: false, retryDelayMs: 10,
        backoffFactor: 1, maxDelayMs: 10, jitter: false, maxRetries: 4,
        stuckTimeoutMs: 0, idleTimeoutMs: 0, pauseWhenFailing: false },
    );
    const btn = () => host.querySelector("button");
    const menu = () => [...document.querySelectorAll('[role="menuitem"]')].map((b) => b.textContent);
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
    const backBtn = note ? [...note.querySelectorAll("button")].find((b) => /back on/i.test(b.textContent)) : null;
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
    return { menuOn, offNow, retriedWhileOff, otherChatOn, retriedElsewhere, remembered,
      noteShown, noteText, afterBack, menuBack, rowThere, saidBefore, saidAfter };
  });
  await page.close();
  check("the hold menu keeps to the button's own business",
    !out.menuOn.some((t) => /this chat/i.test(t)), out.menuOn);
  check("and still offers the way to the settings",
    out.menuOn.some((t) => /settings/i.test(t)), out.menuOn);
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
  check("and offers the way back", out.afterBack.pressed === "true", out.afterBack);
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

// ---- the per-chat switch has to be reachable ----
// It lived only in the floating button's hold menu, and that button is off by
// default, so on a stock install there was no way to reach it at all.
console.log("\nper-chat switch, in the panel");
{
  const { out, errors } = await inPanel(browser, {}, async (page) =>
    page.evaluate(async () => {
      const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
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
  check("saying why", /Open a chat/.test(out.noChat.text), out.noChat.text.slice(0, 80));
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
    let onBackend = null;
    let tabs0 = false;
    const sent = [];
    const teardown = window.__setup(
      {
        events: { on: () => () => {} },
        sendToBackend: (m) => sent.push(m),
        onBackendMessage: (cb) => { onBackend = cb; return () => {}; },
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
      messages: [
        { role: "system", content: "You are a tavern keeper.", chars: 24, history: false },
        { role: "user", content: "I sat down by the fire.", chars: 23, history: true },
        { role: "system", content: "This was refused by mistake.", chars: 28, history: false, note: true, noteIndex: 1 },
        { role: "assistant", content: "A long reply.", chars: 9000, history: true },
      ],
      total: 4,
      dropped: 0,
      clipped: 1,
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
    // A message shown in part has to say so rather than looking complete.
    const saysClipped = /cut for display/.test(shown);

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
    // And the capture stops the moment the prompt is not being looked at.
    const askedOnLeave = sent.filter((m) => m.type === "set_prompt_capture").map((m) => m.on);

    // Big enough to hit with a thumb.
    const tabBox = tab("Prompt").getBoundingClientRect();

    teardown();
    const gone = !panel();
    const askedOnTeardown = sent.filter((m) => m.type === "set_prompt_capture").map((m) => m.on);
    return { opened, tabs, landedOn, beforeAny, shown, rows, marks, saysClipped, afterLogTab,
      gone, askedBefore, askedAfter, askedOnLeave, askedOnTeardown, noteLine, notePlace,
      noteOpen, tabFocus: tabs0, afterArrow, tabH: Math.round(tabBox.height) };
  });
  await page.close();
  check("one switch opens the panel", out.opened, out);
  check("with all three views in it", out.tabs.join(",") === "Log,Prompt,Stats", out.tabs);
  check("and it opens on the log", out.landedOn === "true", out.landedOn);
  // The reason there is no second setting: the cost is only paid while somebody
  // is actually looking at a prompt.
  check("nothing is captured until the prompt tab is opened",
    out.askedBefore.filter((v) => v).length === 0, out.askedBefore);
  check("opening it asks for capture", out.askedAfter[out.askedAfter.length - 1] === true, out.askedAfter);
  check("leaving it stops capture", out.askedOnLeave[out.askedOnLeave.length - 1] === false, out.askedOnLeave);
  check("and so does closing the panel",
    out.askedOnTeardown[out.askedOnTeardown.length - 1] === false, out.askedOnTeardown);
  check("it says nothing has been seen yet before a generation",
    /no prompt seen yet/i.test(out.beforeAny), out.beforeAny.slice(0, 80));
  check("a snapshot fills it in", out.rows === 4, out.rows);
  check("with a summary of the size", /4 messages/.test(out.shown), out.shown.slice(0, 120));
  check("marking what came from the chat, what was added, and what is ours",
    out.marks.join(",") === "added,chat,note,chat", out.marks);
  check("a message shown in part says so", out.saysClipped, out.shown.slice(-120));
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
// It used to flip above the row when there was no room below, so a long
// description opened somewhere none of the others do: you look under the
// setting and the text is over it instead. It stays below now and scrolls.
console.log("\nhint placement");
{
  // A short viewport with a scrolling panel, so a row can be pushed low enough
  // that its description will not fit underneath.
  const PANEL = "#modal{position:fixed;inset:12px;overflow:auto;background:rgb(24,20,34);padding:10px;box-sizing:border-box}";
  // Shared by the checks below: they all want the longest description there is.
  const want = longestHintKey();
  // The long one, on a viewport too short to fit it under the row.
  {
    // A long description on a row of ordinary height. Which row that is used to
    // be written in here by name, and it went stale twice: once when the row
    // moved behind a switch and stopped being on screen at all, and once when
    // its description was shortened and no longer overflowed. What this is
    // about is the longest description, whichever setting carries it, so it is
    // worked out from the schema rather than written down. Rows that need a
    // switch are skipped because they are not on screen by default, and the
    // note list because it opens above on purpose, which is the one case this
    // is not testing.
    const { out, errors } = await inPanel(
      browser, { css: PANEL, viewport: { width: 393, height: 460 }, settings: { refusalNote: true } },
      async (page) => page.evaluate(async (want) => {
        const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        for (const h of document.querySelectorAll('[role="button"][aria-expanded="false"]')) h.click();
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

  // Under a host that applies its UI Scale as a zoom, the room on the screen
  // and the element's own units are not the same. A cap written in the wrong
  // one ran the popover off the bottom of the screen at 1.4.
  {
    const { out, errors } = await inPanel(
      browser, { css: PANEL + "body{zoom:1.4}", viewport: { width: 500, height: 520 },
                 settings: { refusalNote: true } },
      async (page) => page.evaluate(async (want) => {
        const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        for (const h of document.querySelectorAll('[role="button"][aria-expanded="false"]')) h.click();
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
    // panel carries more fixed chrome above its scroll area than it used to
    // (the quick setup row), so -70px no longer reaches.
    const OFFSET = "#modal{position:fixed;left:0;right:0;top:-260px;bottom:0;overflow:auto;background:rgb(24,20,34);box-sizing:border-box}";
    const { out, errors } = await inPanel(
      browser, { css: OFFSET, viewport: { width: 393, height: 800 }, settings: { refusalNote: true } },
      async (page) => page.evaluate(async () => {
        const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        for (const h of document.querySelectorAll('[role="button"][aria-expanded="false"]')) h.click();
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
          .find((r) => (r.textContent || "").includes("Turn auto-retry on"));
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
// The panel-wide contrast sweep runs once, at build, and used to look only at
// elements that were painting text right then. Every status line in the panel
// is empty at that moment and fills in later, so not one of them was ever
// checked. On a light page whose theme variables are all dark they came out
// white on white: the search count, the reset note, and the line that confirms
// a save, which is the one that tells you your settings were kept.
console.log("\nlines that fill in later");
{
  for (const [themeName, themeCss] of [["dark", ""], ["light", LIGHT], ["dark variables on a light page", LIGHT_PAGE]]) {
    const { out, errors } = await inPanel(browser, { css: themeCss }, async (page) =>
      page.evaluate(async () => {
        const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        for (const h of document.querySelectorAll('[role="button"][aria-expanded="false"]')) h.click();
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
      minuses()[0].click();
      await frame();
      const afterRemove = { notes: boxes().length, left: boxes()[0].value };

      // Climb to the ceiling.
      for (let i = 0; i < 30; i++) plus.click();
      await frame();
      const atCap = { notes: boxes().length, plusOff: plus.disabled };

      // And back down to the floor.
      for (let i = 0; i < 30; i++) { const m = minuses(); if (m.length) m[m.length - 1].click(); }
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
// Reset used to be all or nothing, plus a second button for the button
// selectors on their own, because putting those back was the case that came up
// and doing it cost you your word swaps and your refusal phrases. The picker
// replaces both. The thing worth holding down is the promise it makes on
// screen: what you do not tick is not touched.
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
    out.seen.length >= 6 && !!row("retry") && !!row("buttons") && !!row("refusal") && !!row("presets"),
    out.seen.map((r) => r.id));
  check("a part that was changed says how many settings moved",
    /1 setting changed/.test(row("buttons").note), row("buttons").note);
  // Nothing to press is the honest state for a part still at its defaults, and
  // a tickable box that reports "nothing changed" afterwards is not that.
  check("a part still at its defaults cannot be ticked",
    row("replace").disabled === true && /already default/.test(row("replace").note), row("replace"));
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
    /Retry behavior \(\d+ settings?\)/.test(out.summary), out.summary);
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
      await frame();
      document.querySelector('[data-ar-row="replaceRules"] textarea').value = "cat => dog";
      document.querySelector('[data-ar-row="replaceRules"] textarea')
        .dispatchEvent(new Event("change", { bubbles: true }));
      document.querySelector('input[placeholder="Preset name"]').value = "trial";
      [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Save as new").click();
      await frame();
      [...document.querySelectorAll("button")].find((b) => /^Reset/.test(b.textContent.trim())).click();
      await frame();
      document.querySelector('[data-ar-reset="presets"] input').checked = true;
      [...document.querySelectorAll("#__lvRetryReset button")]
        .find((b) => b.textContent.trim() === "Reset ticked").click();
      await frame();
      const el = document.querySelector("[data-ar-reset-confirm]");
      const summary = el ? el.textContent.trim() : "";
      const stillThere = JSON.parse(localStorage.getItem("lv-auto-retry:presets:v1")).swap.length;
      return { summary, stillThere };
    }),
  );
  check("deleting presets is spelled out before it happens",
    /Delete 1 saved word swap preset\b/.test(out.summary), out.summary);
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
      await frame();
      const el = document.querySelector('[data-ar-row="maxRetries"] input');
      el.value = "9";
      el.dispatchEvent(new Event("change", { bubbles: true }));
      // Save a preset the way someone would.
      document.querySelector('[data-ar-row="replaceRules"] textarea').value = "cat => dog";
      document.querySelector('[data-ar-row="replaceRules"] textarea')
        .dispatchEvent(new Event("change", { bubbles: true }));
      document.querySelector('input[placeholder="Preset name"]').value = "trial";
      [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Save as new").click();
      await frame();
      const before = JSON.parse(localStorage.getItem("lv-auto-retry:presets:v1")).swap.length;
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
        after: JSON.parse(localStorage.getItem("lv-auto-retry:presets:v1")).swap.length,
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
      await frame();
      const el = document.querySelector('[data-ar-row="maxRetries"] input');
      el.value = "9";
      el.dispatchEvent(new Event("change", { bubbles: true }));
      // Save a preset so its line can be ticked.
      document.querySelector('[data-ar-row="replaceRules"] textarea').value = "cat => dog";
      document.querySelector('[data-ar-row="replaceRules"] textarea')
        .dispatchEvent(new Event("change", { bubbles: true }));
      document.querySelector('input[placeholder="Preset name"]').value = "trial";
      [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Save as new").click();
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
          createFloatWidget: () => ({ root: document.createElement("div"), destroy() {} }),
        },
      },
      { showExtrasToggle: true, showFloatingToggle: true, showReplaceButton: true, showSwapAllButton: true },
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
  check("all four Extras entries register", out.registered.length === 4, out.registered);
  check("none register twice", !out.duplicate);
  check("teardown removes every one", out.left.length === 0, out.left);
  check("a hint, a toast and the full-size editor were actually up first",
    out.hintWasOpen && out.toastWasUp && out.editorWasOpen, out);
  check("teardown removes the toast and any hint", out.toastGone && out.hintGone);
  check("and the full-size editor with them", out.editorGone, out);
  check("no console errors", errors.length === 0, errors);
}

await browser.close();
console.log(failures ? `\n${failures} FAILED` : "\nall browser checks passed");
process.exit(failures ? 1 : 0);
