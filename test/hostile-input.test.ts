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
const cfg = {
  refusalUseBuiltins: true,
  refusalMaxChars: 2000,
  refusalStripThinking: true,
};

const TAKES_ANYTHING = [
  "looksTruncated",
  "looksLikeRefusal",
  "looksLikeRefusalError",
  "normalizeForMatch",
  "stripThinking",
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

// Each of these is shaped to make a careless pattern backtrack. The budget is
// generous because a slow machine running the whole suite is still a pass; what
// it is really catching is the difference between milliseconds and forever.
describe("nothing hangs on a pathological reply", () => {
  const BUDGET_MS = 3000;
  const cases: Array<[string, string]> = [
    ["200k letters", "a".repeat(200000)],
    ["50k quotes", '"'.repeat(50000)],
    ["20k nested tags", "<b>".repeat(20000) + "x"],
    ["a 100k attribute value", '<span style="' + "a".repeat(100000) + '">x'],
    ["20k reasoning openers", "<think>".repeat(20000)],
    ["5k channel blocks", "<|channel|>analysis<|message|>x".repeat(5000)],
    ["100k asterisks", "*".repeat(100000)],
    ["100k newlines", "a\n".repeat(50000)],
  ];
  for (const [name, text] of cases) {
    test(name, () => {
      const started = Date.now();
      expect(() => {
        T.looksTruncated(text, true, {});
        T.looksLikeRefusal(text, cfg);
      }).not.toThrow();
      expect(Date.now() - started).toBeLessThan(BUDGET_MS);
    });
  }
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
    expect(T.looksLikeRefusal("a.*b", own("a.*b"))).toBe(true);
  });

  test("and does not match what that pattern would have", () => {
    expect(T.looksLikeRefusal("axxxb", own("a.*b"))).toBe(false);
  });

  test("a phrase full of metacharacters is harmless", () => {
    for (const p of ["(", "[", "\\", "*+?", "$^", "(?:"]) {
      expect(() => T.looksLikeRefusal("nothing here", own(p))).not.toThrow();
    }
  });
});

describe("the empty cases belong to the empty check, not to these", () => {
  test("nothing is not a refusal", () => {
    expect(T.looksLikeRefusal("", cfg)).toBe(false);
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
  expect(T.looksLikeRefusal(text, cfg)).toBe(true);
});
