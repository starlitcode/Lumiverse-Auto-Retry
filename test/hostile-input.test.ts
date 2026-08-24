// What happens when a reply is not a reply.
//
// Everything here is fed to the checks that decide whether to throw a reply
// away. They run on whatever a model produced, which is not always text and is
// sometimes enormous, so the two things that matter are that nothing throws and
// nothing hangs. A pattern that backtracks catastrophically on a long reply
// would lock the tab up, and it would do it on somebody's longest scene.
//
// Run with: bun test

import { expect, test, describe } from "bun:test";
import { __testing } from "../src/frontend";

const T = __testing as any;

// refusalVerdict is the real entry point and returns a verdict plus its reason.
// These checks are about the answer, not the wording of it.
const looksLikeRefusal = (text: any, cfg?: any): boolean =>
  T.refusalVerdict(text, cfg).refusal;
const cfg = {
  refusalUseBuiltins: true,
  refusalMaxChars: 2000,
  refusalStripThinking: true,
};

const TAKES_ANYTHING = [
  "looksTruncated",
  "refusalVerdict",
  "looksLikeRefusalError",
  "normalizeForMatch",
  "stripThinking",
  "stripMarkup",
  "splitPhrases",
  "parseSubs",
  "splitSelectorList",
];

describe("nothing throws on input that is not text", () => {
  for (const name of TAKES_ANYTHING) {
    test(name, () => {
      for (const v of [null, undefined, "", 0, NaN, {}, [], true]) {
        expect(() => T[name](v, v, v)).not.toThrow();
      }
    });
  }
});

// Each of these is shaped to make a careless pattern backtrack.
//
// A hang is caught by the per-test timeout below, not by measuring how long the
// work took. A wall-clock assertion in here is itself a bug: the first version
// of this file asserted under three seconds, passed on every machine it was
// written on, and then failed on a CI runner that happened to be busy. What is
// being tested is the difference between milliseconds and forever, and a
// timeout says that without inventing a number that tracks machine load.
describe("nothing hangs on a pathological reply", () => {
  // Long enough that only a genuine hang reaches it. The slowest of these is
  // single-digit milliseconds when the patterns are behaving.
  const NO_HANG_MS = 20000;
  const cases: Array<[string, string]> = [
    ["200k letters", "a".repeat(200000)],
    ["50k quotes", '"'.repeat(50000)],
    ["20k nested tags", "<b>".repeat(20000) + "x"],
    ["a 100k attribute value", '<span style="' + "a".repeat(100000) + '">x'],
    ["20k reasoning openers", "<think>".repeat(20000)],
    ["5k channel blocks", "<|channel|>analysis<|message|>x".repeat(5000)],
    ["100k asterisks", "*".repeat(100000)],
    ["50k half-written tags", "<div class=".repeat(50000)],
    ["20k unclosed containers", "<div>".repeat(20000)],
    ["20k unclosed containers and one close", "<div>".repeat(20000) + "</div>"],
    ["10k balanced container pairs", "<div>x</div>".repeat(10000)],
    ["10k containers nested inside each other", "<div>".repeat(10000) + "x" + "</div>".repeat(10000)],
    ["50k closing tags with nothing opened", "</div>".repeat(50000)],
    ["100k newlines", "a\n".repeat(50000)],
  ];
  for (const [name, text] of cases) {
    test(
      name,
      () => {
        expect(() => {
          T.looksTruncated(text, true, {});
          looksLikeRefusal(text, cfg);
        }).not.toThrow();
      },
      NO_HANG_MS,
    );
  }

  // The shape that makes this file worth having. Stripping reasoning walks
  // forward from every opener looking for its closer, so a reply that is
  // nothing but openers can make each one scan the whole remainder: 5k openers
  // at 96ms, 20k at 1.5s, 40k at 6s. Doubling the input has to roughly double
  // the work, not quadruple it.
  test("the work grows with the input, not with its square", () => {
    const cost = (n: number) => {
      const text = "<think>".repeat(n);
      const started = Date.now();
      T.looksTruncated(text, true, {});
      looksLikeRefusal(text, cfg);
      return Date.now() - started;
    };
    cost(2000); // warm, so the first call does not carry the whole cost
    const small = cost(10000);
    const large = cost(40000);
    // Four times the input. Quadratic would be about sixteen times the work;
    // the allowance is loose because these are milliseconds and a busy machine
    // is noisy, but sixteen-fold growth cannot hide inside it.
    expect(large).toBeLessThanOrEqual(Math.max(60, small * 8));
  });

  // The same shape, one check along. Walking to the end of the reply from every
  // "<" costs the square of the length on a reply made of half-written tags:
  // 50k of them takes 48 seconds, which is a locked tab on somebody's longest
  // scene. Only the last "<" can be unclosed, so one scan is enough and this
  // holds it to one.
  test("looking for an unclosed tag grows with the input too", () => {
    const cost = (n: number) => {
      const text = "<div class=".repeat(n);
      const started = Date.now();
      T.looksTruncated(text, true, {});
      return Date.now() - started;
    };
    cost(2000);
    const small = cost(10000);
    const large = cost(40000);
    expect(large).toBeLessThanOrEqual(Math.max(60, small * 8));
  });
});

// SECURITY.md says a rule cannot turn into a regular expression by accident.
// This is that promise, held down.
describe("a phrase someone typed is text, not a pattern", () => {
  const own = (phrases: string) => ({
    ...cfg,
    refusalUseBuiltins: false,
    refusalExtraPhrases: phrases,
  });

  test("a regex-looking phrase matches itself", () => {
    expect(looksLikeRefusal("a.*b", own("a.*b"))).toBe(true);
  });

  test("and does not match what that pattern would have", () => {
    expect(looksLikeRefusal("axxxb", own("a.*b"))).toBe(false);
  });

  test("a phrase full of metacharacters is harmless", () => {
    for (const p of ["(", "[", "\\", "*+?", "$^", "(?:"]) {
      expect(() => looksLikeRefusal("nothing here", own(p))).not.toThrow();
    }
  });
});

describe("the empty cases belong to the empty check, not to these", () => {
  test("nothing is not a refusal", () => {
    expect(looksLikeRefusal("", cfg)).toBe(false);
  });

  test("nothing is not cut off", () => {
    expect(T.looksTruncated("", true, {})).toBe(false);
    expect(T.looksTruncated("   \n\t ", true, {})).toBe(false);
  });

  test("and neither is a reply that is only thinking", () => {
    expect(T.looksTruncated("<think>hm</think>", true, {})).toBe(false);
  });
});

// The length limit is about how much a person reads, so it is measured on the
// visible reply. Counting the reasoning would let a long think block carry a
// refusal past the limit and out of reach of the check.
test("a long reasoning block cannot push a refusal past the length limit", () => {
  const text = "<think>" + "x".repeat(5000) + "</think>I cannot assist with that.";
  expect(looksLikeRefusal(text, cfg)).toBe(true);
});
