// Keeping panel text readable on any theme.
//
// Every colour in the settings panel comes from the user's Lumiverse theme, and
// a theme can set its accent to anything. The bug these guard against: a theme
// whose accent sits close to its text colour rendered filled buttons as blank
// rectangles, the label present but the same colour as the button under it.
//
// Run with: bun test

import { expect, test, describe } from "bun:test";
import { __testing } from "../src/frontend";

const { parseColor, blendColor, relLuminance, contrastRatio } = __testing;

// The floor fixContrast holds text to. Below this a label is hard to pick out;
// at 1 it is invisible.
const MIN = 3.2;

describe("parsing what the browser reports", () => {
  test("rgb()", () => {
    expect(parseColor("rgb(255, 0, 0)")).toEqual([255, 0, 0, 1]);
  });
  test("rgba() with a decimal alpha", () => {
    expect(parseColor("rgba(10, 20, 30, 0.5)")).toEqual([10, 20, 30, 0.5]);
  });
  test("the space-and-slash form", () => {
    expect(parseColor("rgb(10 20 30 / 50%)")).toEqual([10, 20, 30, 0.5]);
  });
  test("alpha is clamped to 0-1", () => {
    expect(parseColor("rgba(0, 0, 0, 4)")![3]).toBe(1);
  });
  test("anything else is reported as unknown, so the caller leaves it alone", () => {
    // getComputedStyle only ever hands back rgb()/rgba(), so these mean the
    // value came from somewhere unexpected and should not be acted on.
    for (const v of ["transparent", "#ffffff", "red", "", null, undefined]) {
      expect(parseColor(v as any)).toBe(null);
    }
  });
});

describe("compositing", () => {
  test("half-transparent white over black is grey", () => {
    expect(blendColor([255, 255, 255, 0.5], [0, 0, 0, 1])).toEqual([
      127.5, 127.5, 127.5, 1,
    ]);
  });
  test("an opaque colour covers whatever is under it", () => {
    expect(blendColor([12, 34, 56, 1], [255, 255, 255, 1])).toEqual([12, 34, 56, 1]);
  });
  test("a fully transparent colour leaves the backdrop", () => {
    expect(blendColor([12, 34, 56, 0], [1, 2, 3, 1])).toEqual([1, 2, 3, 1]);
  });
});

describe("contrast maths matches the WCAG definition", () => {
  test("black on white is 21:1", () => {
    expect(contrastRatio([0, 0, 0, 1], [255, 255, 255, 1])).toBeCloseTo(21, 4);
  });
  test("a colour against itself is 1:1", () => {
    expect(contrastRatio([147, 112, 219, 1], [147, 112, 219, 1])).toBeCloseTo(1, 6);
  });
  test("the order of the two colours does not matter", () => {
    const a: any = [12, 200, 90, 1];
    const b: any = [40, 40, 40, 1];
    expect(contrastRatio(a, b)).toBeCloseTo(contrastRatio(b, a), 10);
  });
  test("white is the brightest thing there is", () => {
    expect(relLuminance([255, 255, 255, 1])).toBeCloseTo(1, 6);
    expect(relLuminance([0, 0, 0, 1])).toBeCloseTo(0, 6);
  });
});

describe("the themes that matter", () => {
  // Lumiverse's stock values.
  const stockAccent = parseColor("rgb(136, 105, 200)")!; // --lumiverse-primary over the panel
  const stockText = parseColor("rgb(255, 255, 255)")!; // --lumiverse-text
  const panel = parseColor("rgb(35, 30, 48)")!; // --lumiverse-bg-elevated

  test("stock theme: white on the accent already reads, so nothing is repainted", () => {
    expect(contrastRatio(stockText, stockAccent)).toBeGreaterThan(MIN);
  });

  test("stock theme: body text on the panel already reads", () => {
    expect(contrastRatio(stockText, panel)).toBeGreaterThan(MIN);
  });

  // The reported bug: a custom theme with a light lavender accent, and a body
  // text colour almost the same shade.
  const lightAccent = parseColor("rgb(224, 192, 255)")!;
  const lavenderText = parseColor("rgb(226, 200, 250)")!;

  test("light accent: the original pairing is effectively invisible", () => {
    expect(contrastRatio(lavenderText, lightAccent)).toBeLessThan(1.2);
  });

  test("light accent: white does not rescue it either", () => {
    expect(contrastRatio([255, 255, 255, 1], lightAccent)).toBeLessThan(MIN);
  });

  test("light accent: near-black does, which is what fixContrast picks", () => {
    // fixContrast chooses whichever of near-white / near-black reads better.
    const light: any = [255, 255, 255, 1];
    const dark: any = [20, 18, 26, 1];
    const chosen =
      contrastRatio(light, lightAccent) >= contrastRatio(dark, lightAccent) ? light : dark;
    expect(chosen).toEqual(dark);
    expect(contrastRatio(chosen, lightAccent)).toBeGreaterThan(MIN);
  });

  test("on a dark surface the same choice lands on near-white", () => {
    const light: any = [255, 255, 255, 1];
    const dark: any = [20, 18, 26, 1];
    const chosen =
      contrastRatio(light, panel) >= contrastRatio(dark, panel) ? light : dark;
    expect(chosen).toEqual(light);
    expect(contrastRatio(chosen, panel)).toBeGreaterThan(MIN);
  });

  test("one of near-white or near-black always clears the floor", () => {
    // Whatever accent a theme picks, there is always a readable answer. Walking
    // the greyscale is enough: luminance is what the choice turns on.
    for (let v = 0; v <= 255; v += 5) {
      const bg: any = [v, v, v, 1];
      const best = Math.max(
        contrastRatio([255, 255, 255, 1], bg),
        contrastRatio([20, 18, 26, 1], bg),
      );
      expect(best).toBeGreaterThan(MIN);
    }
  });

  test("translucent text is judged on what it composites to", () => {
    // --lumiverse-text is rgba(255,255,255,0.9): judging the raw value rather
    // than the blend would report a contrast the user never actually sees.
    const translucent: any = [255, 255, 255, 0.9];
    const solid = blendColor(translucent, panel);
    expect(solid[3]).toBe(1);
    expect(contrastRatio(solid, panel)).toBeGreaterThan(MIN);
  });
});
