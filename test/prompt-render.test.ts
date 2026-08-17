// The Prompt tab draws a message one of two ways. Raw is every character as the
// model got it. Rendered lays the same text out with the light markdown a scene
// is written in applied.
//
// splitEmphasis is the whole of the second one that can be wrong. It returns
// what each run says and how it should look, never any markup, so the panel
// builds nodes from it and a prompt has no path onto the page as HTML. These
// check both halves of that: that it finds the emphasis, and that anything it
// does not understand survives as the characters that were typed.
import { expect, test, describe } from "bun:test";
import { __testing } from "../src/frontend";

const { splitEmphasis } = __testing as any;
const plain = (s: string) => splitEmphasis(s).map((r: any) => r.text).join("");

describe("laying out a prompt message", () => {
  test("plain text is one run and says the same thing", () => {
    expect(splitEmphasis("just words")).toEqual([{ text: "just words" }]);
  });

  test("single markers are emphasis, double are strong", () => {
    expect(splitEmphasis("a *b* c")).toEqual([
      { text: "a " }, { text: "b", em: true }, { text: " c" },
    ]);
    expect(splitEmphasis("a **b** c")).toEqual([
      { text: "a " }, { text: "b", strong: true }, { text: " c" },
    ]);
  });

  test("underscores work the same way", () => {
    expect(splitEmphasis("_b_")).toEqual([{ text: "b", em: true }]);
    expect(splitEmphasis("__b__")).toEqual([{ text: "b", strong: true }]);
  });

  test("backticks win, so asterisks inside code stay literal", () => {
    expect(splitEmphasis("`a *b* c`")).toEqual([{ text: "a *b* c", code: true }]);
  });

  test("several runs on one line", () => {
    expect(splitEmphasis("*a* and **b** and `c`")).toEqual([
      { text: "a", em: true }, { text: " and " }, { text: "b", strong: true },
      { text: " and " }, { text: "c", code: true },
    ]);
  });

  // The half that matters for a view whose whole job is fidelity: anything it
  // does not understand has to survive as what was typed.
  describe("anything it cannot read is left alone", () => {
    const asIs = [
      "an unclosed *marker",
      "an unclosed `backtick",
      "empty ** pair",
      "a lone * on its own",
      "5 * 3 = 15 and 2 * 4 = 8",
      "snake_case_name stays whole",
      "**",
      "*",
      "`",
      "",
    ];
    for (const s of asIs) {
      test(JSON.stringify(s), () => {
        expect(plain(s)).toBe(s);
      });
    }
  });

  // Markers it recognises are consumed, so the text does not rejoin to the line
  // in general. What has to hold is that nothing is invented and nothing is
  // reordered: what comes out is always the line with some characters taken
  // away, in the order they were in.
  const isSubsequence = (a: string, b: string) => {
    let i = 0;
    for (const ch of b) if (i < a.length && a[i] === ch) i++;
    return i === a.length;
  };
  test("nothing is ever invented or reordered", () => {
    const lines = [
      "*a* **b** `c` d", "***a***", "*a**b*", "`*a*`", "a*b*c", "__a_b__",
      "*a* _b_ **c** __d__ `e`", "*", "**", "***", "*_*_*",
      "<script>alert(1)</script>", "*<b>x</b>*", "a\tb",
      "2 * 4 = 8", "snake_case", "* bullet", "a * b * c",
    ];
    for (const l of lines) expect(isSubsequence(plain(l), l)).toBe(true);
  });

  // The cases that made this worth doing properly: a prompt is full of both.
  test("arithmetic and identifiers survive", () => {
    expect(plain("5 * 3 = 15 and 2 * 4 = 8")).toBe("5 * 3 = 15 and 2 * 4 = 8");
    expect(plain("snake_case_name stays whole")).toBe("snake_case_name stays whole");
    expect(plain("call foo_bar and baz_qux")).toBe("call foo_bar and baz_qux");
  });

  // It returns text, never markup. Tags in a prompt are characters like any
  // other, and the panel puts them on the page as text.
  test("markup in a prompt comes back as text, not as a tag", () => {
    const runs = splitEmphasis("*<img onerror=x>*");
    expect(runs).toEqual([{ text: "<img onerror=x>", em: true }]);
    for (const r of runs) expect(typeof r.text).toBe("string");
  });
});
