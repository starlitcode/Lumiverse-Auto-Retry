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

// ---- the thing the extension is for ----
// Retrying means clicking a real button in the host's DOM, so it cannot be
// checked without one. This drives the generation events the way Lumiverse
// would and counts the clicks that land on a stand-in regenerate button.
console.log("\nretrying");
{
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setContent(
    '<div id=modal></div><button data-testid="regenerate">Regenerate</button>',
  );
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
