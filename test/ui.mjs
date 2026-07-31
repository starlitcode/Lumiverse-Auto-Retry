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
// Playwright is deliberately NOT a dependency of this project: it pulls a few
// hundred megabytes of browsers, and the install path here is "Lumiverse clones
// the repo". If it is not present this skips and exits cleanly. To run it:
//
//   bun add -d playwright && bunx playwright install chromium
//
// The pure logic (refusal detection, cut-off detection, contrast maths, the
// word-swap engine) is covered by `bun test`, which needs nothing extra.

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
  await page.setContent("<div id=modal></div>");
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
          lastOnScreen: !!lr && lr.bottom <= 1030 && lr.top >= 0,
        };
      }),
  );
  check("a hint moves nothing below it", out.moved === 0, out.moved);
  check("the popover lands on screen", out.onScreen);
  check("only one is ever open", out.afterSecond === 1, out.afterSecond);
  check("a second tap closes it", out.afterRetap === 0);
  check("a tap elsewhere closes it", out.afterOutside === 0);
  check("scrolling closes it", out.afterScroll === 0);
  check("the last row's hint flips above", out.lastOnScreen);
  check("no console errors", errors.length === 0, errors);
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

// ---- nothing is left behind ----
console.log("\nteardown");
{
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setContent("<div id=modal></div>");
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
    teardown();
    return {
      registered,
      duplicate,
      left: [...live.keys()],
      toastGone: !document.getElementById("__lvRetryToast"),
      hintGone: !document.querySelector('[role="tooltip"]'),
    };
  });
  await page.close();
  check("all four Extras entries register", out.registered.length === 4, out.registered);
  check("none register twice", !out.duplicate);
  check("teardown removes every one", out.left.length === 0, out.left);
  check("teardown removes the toast and any hint", out.toastGone && out.hintGone);
  check("no console errors", errors.length === 0, errors);
}

await browser.close();
console.log(failures ? `\n${failures} FAILED` : "\nall browser checks passed");
process.exit(failures ? 1 : 0);
