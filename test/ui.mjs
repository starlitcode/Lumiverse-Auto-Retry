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
async function inPanel(browser, { css = "", viewport, touch = false } = {}, fn) {
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
  await page.evaluate(async () => {
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
      {},
    );
    window.__acts["auto-retry-settings"].cb();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
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
  const expectYours = [
    'Show a "swap words now" button',
    "Show a swap-whole-chat button",
    "Allow swapping a reply again",
    "Ask before editing a reply",
  ];
  const same = (a, b) => !!a && a.length === b.length && a.every((x, i) => x === b[i]);
  check("the preset run holds exactly what a preset saves", same(out.presetLabels, expectPreset), out.presetLabels);
  check("the other run holds everything a preset leaves alone", same(out.yoursLabels, expectYours), out.yoursLabels);
  check("a search hides the run with no matches", out.onlyPreset.inPreset && !out.onlyPreset.yours, out.onlyPreset);
  check("and the other way round", !out.onlyYours.inPreset && out.onlyYours.yours, out.onlyYours);
  check("clearing brings both back", out.cleared.inPreset && out.cleared.yours, out.cleared);
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

// ---- asking for less movement is honoured ----
// The float button dips under a press. That is the only thing in the extension
// that actually moves, so it is the only thing reduced motion has to switch off.
// The colour change stays either way, or the button would stop acknowledging a
// tap at all.
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
      btn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      const moved = btn.style.transform;
      const css = getComputedStyle(btn).transition;
      return { moved, animatesTransform: /transform/.test(css), colours: /background/.test(css) };
    });
    await page.close();
    return { ...out, errs };
  };
  const normal = await press("no-preference");
  const reduced = await press("reduce");
  check("normally the button dips under a press", normal.moved === "scale(0.94)", normal.moved);
  check("with reduced motion it does not move", reduced.moved === "", reduced.moved);
  check("and stops animating transform at all", !reduced.animatesTransform, reduced);
  check("but still acknowledges the tap in colour", reduced.colours, reduced);
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
    let teardown = window.__setup(
      {
        events: { on: () => () => {} },
        ui: {
          showModal: () => ({ root: document.getElementById("modal"), onDismiss: () => {}, dismiss: () => {} }),
          registerInputBarAction: () => ({ onClick: () => () => {}, destroy: () => {} }),
          createFloatWidget: () => { widgets++; return { root: host, destroy: () => {}, setPosition: () => {} }; },
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
    return { wasOn, afterTap, openedByHold, entries, afterHold, onScreen, afterEsc, afterDrag, rebuilt, gone, left, focus, menuZ };
  });
  await page.close();
  check("a quick tap still toggles", out.afterTap.pressed !== out.wasOn, out.afterTap);
  check("and opens no menu", !out.afterTap.menu);
  check("a hold opens the menu", out.openedByHold);
  check("with both entries", out.entries.length === 2, out.entries);
  check("a hold does not also toggle", out.afterHold.same, out.afterHold);
  check("the menu lands on screen", out.onScreen);
  check("Esc closes it", !out.afterEsc);
  check("dragging is not a hold", !out.afterDrag);
  check("moving it back rebuilds the widget", out.rebuilt);
  check("hiding removes the button", out.gone.button, out.gone);
  check("and leaves no menu behind", !out.gone.menu);
  check("teardown leaves nothing", !out.left.menu && out.left.items === 0, out.left);
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
      onMsg({ type: "swapped", pairs, wholeChat: true });
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
      // A field the user is typing in must never be rewritten underneath them.
      input: await (async () => {
        chat.innerHTML = "<textarea>a cat here</textarea>";
        onMsg({ type: "swapped", pairs: [["cat ", "dog "]], wholeChat: true });
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
            refusalNotePlacement: "after", refusalNoteFromTry: 2,
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
      fromFirst: (await drive({ refusalNoteFromTry: 1 }, REFUSED)).length,
      off: (await drive({ refusalNote: false }, REFUSED)).length,
      empty: (await drive({ refusalNotes: [{ text: "   ", role: "system" }] }, REFUSED)).length,
      // What actually gets sent across the bridge.
      payload: (await drive({ refusalNoteFromTry: 1, refusalNotePlacement: "start",
        refusalNotes: [{ text: "This was refused by mistake.", role: "user" }] }, REFUSED))[0],
    };
  });
  await page.close();
  check("a refusal arms the note", out.refusal > 0, out.refusal);
  check("but not on the first try, by default", out.refusal === 2, out.refusal);
  check("set to 1, it arms on every refusal retry", out.fromFirst === 3, out.fromFirst);
  check("a cut-off reply never arms it", out.cutOff === 0, out.cutOff);
  check("nor does anything while the setting is off", out.off === 0, out.off);
  check("nor while the box is empty", out.empty === 0, out.empty);
  check("the note carries its text, role, placement and chat",
    !!out.payload && out.payload.notes && out.payload.notes.length === 1 &&
    out.payload.notes[0].text === "This was refused by mistake." &&
    out.payload.notes[0].role === "user" && out.payload.placement === "start" && !!out.payload.chatId,
    out.payload);
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
        return { save: seen(by("Save")), reset: seen(by("Reset to defaults")) };
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
console.log("\nnote list");
{
  const { out, errors } = await inPanel(browser, {}, async (page) =>
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
  const { out, errors } = await inPanel(browser, {}, async (page) =>
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
        return found;
      }),
    );
    check(name + ": the tip's text reads against what the tip paints",
      out.tip && out.tip.ratio >= 3, out.tip);
    check(name + ": the editor's text reads against what the editor paints",
      out.editor && out.editor.ratio >= 3, out.editor);
    check(name + ": no console errors", errors.length === 0, errors);
  };
  await look("stock", "");
  await look("full light", LIGHT);
  await look("partial light", PARTIAL_LIGHT);
  await look("dark variables on a light page", LIGHT_PAGE);
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
    teardown();
    return {
      registered,
      duplicate,
      left: [...live.keys()],
      hintWasOpen,
      toastWasUp,
      toastGone: !document.getElementById("__lvRetryToast"),
      hintGone: !document.querySelector('[role="tooltip"]'),
    };
  });
  await page.close();
  check("all four Extras entries register", out.registered.length === 4, out.registered);
  check("none register twice", !out.duplicate);
  check("teardown removes every one", out.left.length === 0, out.left);
  check("a hint and a toast were actually up first", out.hintWasOpen && out.toastWasUp, out);
  check("teardown removes the toast and any hint", out.toastGone && out.hintGone);
  check("no console errors", errors.length === 0, errors);
}

await browser.close();
console.log(failures ? `\n${failures} FAILED` : "\nall browser checks passed");
process.exit(failures ? 1 : 0);
