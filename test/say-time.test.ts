// How long is left, said the way a person would.
//
// This is the one number anyone watches while a retry is pending, and it is
// redrawn four times a second, so it has to be readable at a glance and it has
// to stop changing width as it counts. The waits it has to cover are not all
// short: the pause after repeated failures can be set to as much as 180
// minutes, so this has to reach three hours without asking anyone to divide.
//
// Run with: bun test

import { expect, test, describe } from "bun:test";
import { __testing } from "../src/frontend";

const { sayTime } = __testing as any;
const secs = (n: number) => sayTime(n * 1000);

describe("seconds on their own", () => {
  const cases: Array<[number, string]> = [
    [0, "0s"],
    [1, "1s"],
    [9, "9s"],
    [45, "45s"],
    [59, "59s"],
  ];
  for (const [n, want] of cases) {
    test(n + " reads " + want, () => expect(secs(n)).toBe(want));
  }
});

describe("minutes once there is one", () => {
  const cases: Array<[number, string]> = [
    [60, "1m 00s"],
    [61, "1m 01s"],
    [90, "1m 30s"],
    [599, "9m 59s"],
    [3599, "59m 59s"],
  ];
  for (const [n, want] of cases) {
    test(n + " reads " + want, () => expect(secs(n)).toBe(want));
  }
});

describe("hours once there is one", () => {
  const cases: Array<[number, string]> = [
    [3600, "1h 00m 00s"],
    [3661, "1h 01m 01s"],
    [7325, "2h 02m 05s"],
    // The longest pause the settings allow, so the widest this ever gets.
    [180 * 60, "3h 00m 00s"],
  ];
  for (const [n, want] of cases) {
    test(n + " reads " + want, () => expect(secs(n)).toBe(want));
  }
});

describe("the shape holds while it counts", () => {
  // A number that gains and loses a digit as it goes makes the line jump, and
  // the line is next to a Cancel button people are aiming at.
  test("a smaller unit keeps its leading zero under a larger one", () => {
    expect(secs(3605)).toBe("1h 00m 05s");
    expect(secs(65)).toBe("1m 05s");
  });

  test("but the largest unit shown never carries one", () => {
    expect(secs(300)).toBe("5m 00s");
    expect(secs(5)).toBe("5s");
  });

  test("every second of a minute is the same width", () => {
    const widths = new Set<number>();
    for (let n = 60; n < 120; n++) widths.add(secs(n).length);
    expect(widths.size).toBe(1);
  });

  test("and every second of an hour is too", () => {
    const widths = new Set<number>();
    for (let n = 3600; n < 3660; n++) widths.add(secs(n).length);
    expect(widths.size).toBe(1);
  });
});

describe("what it does with input it should never get", () => {
  // A wait that has already passed is nothing left, not a negative number on
  // screen next to a Cancel button.
  test("a wait already over reads as none left", () => {
    expect(secs(-1)).toBe("0s");
    expect(secs(-9999)).toBe("0s");
  });

  // Rounded up, so it never says 0s while there is still a fraction to go and
  // the retry has visibly not fired.
  test("part of a second still counts as a second", () => {
    expect(sayTime(1)).toBe("1s");
    expect(sayTime(999)).toBe("1s");
    expect(sayTime(1001)).toBe("2s");
  });

  // NaN slips past every comparison in here and would land on screen as
  // "NaNs", which is worse than being wrong quietly.
  test("nonsense reads as none left rather than reaching the screen", () => {
    for (const v of [null, undefined, NaN, "", {}, [], Infinity, "soon"]) {
      expect(() => sayTime(v as any)).not.toThrow();
      expect(sayTime(v as any)).toMatch(/^\d+[hms]/);
    }
    expect(sayTime(NaN as any)).toBe("0s");
    expect(sayTime("soon" as any)).toBe("0s");
    expect(sayTime(Infinity as any)).toBe("0s");
  });
});
