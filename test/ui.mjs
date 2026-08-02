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


// Decodes a PNG far enough to find its brightest pixel. Only used by the clear
// button check, which cannot be done any other way: the browser will not report
// a pseudo-element's own styles back through getComputedStyle.
function brightestPixel(buf) {
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
  let best = null, bestSum = -1;
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
      const sum = out[o] + out[o + 1] + out[o + 2];
      if (sum > bestSum) { bestSum = sum; best = { r: out[o], g: out[o + 1], b: out[o + 2] }; }
    }
  }
  return best;
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
      const solid = (el) => {
        let p = el;
        while (p) {
          const c = getComputedStyle(p).backgroundColor;
          const m = c.match(/[\d.]+/g);
          if (m && (m[3] === undefined || Number(m[3]) > 0.9)) return c;
          p = p.parentElement;
        }
        return "rgb(0,0,0)";
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
  const page = await browser.newPage({ viewport: { width: 480, height: 200 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await stage(page, "<div id=modal></div>");
  await page.addStyleTag({ content: THEME });
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
  check("the panel stylesheet is injected", box.styled);
  check("the search field carries the id the rule targets", box.id === "__lvRetrySearch", box.id);
  const bright = brightestPixel(png);
  // With the rule in place the brightest thing at that end of the field is the
  // cross itself, drawn in the muted theme colour, which over this dark field
  // lands around 170. Without it nothing is painted there at all and the
  // brightest thing is the field's own edge, far darker. Checking for "bright
  // but not white" therefore proves the cross is both present and themed.
  //
  // Note this cannot prove the untouched button was white: headless Chromium
  // never paints the browser's own clear button, which is why this bug reached
  // a real phone without any check noticing.
  const themed = !!bright && bright.r > 120 && bright.r < 245 &&
                 Math.abs(bright.r - bright.b) < 40;
  check("the clear button is painted in the theme colour, not white", themed, bright);
  check("no console errors", errors.length === 0, errors);
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
  const { out, errors } = await inPanel(browser, {}, async (page) =>
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
  check("the hint popover is solid", out.hint && out.hint.ok, out.hint);
  check("the full-size editor is solid", out.editor && out.editor.ok, out.editor);
  check("no console errors", errors.length === 0, errors);

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
