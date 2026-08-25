// A bug report has to carry what the panel already knows. The counters are
// kept in one object and read in two places: the Stats tab, which the user can
// see, and the debug report, which is what actually gets pasted somewhere.
// They drifted once: a counter added for the Stats tab was not added here, so
// reports came in with no line about it and the answer had to be asked for.
//
// Written against the source, because both are built inside setup() and
// neither is reachable from this tier.
import { expect, test, describe } from "bun:test";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../src/frontend.ts", import.meta.url), "utf8");

const between = (from: string, to: string) => {
  const i = SRC.indexOf(from);
  expect(i).toBeGreaterThan(-1);
  const j = SRC.indexOf(to, i);
  expect(j).toBeGreaterThan(i);
  return SRC.slice(i, j);
};

// Which counters a block reads. The per-chat ones are read through a total
// rather than by name, so the field name is what is compared, not the shape of
// the sum built from it.
const countersIn = (block: string): string[] =>
  [...new Set([...block.matchAll(/stats\.([A-Za-z]+)/g)].map((m) => m[1]))].sort();

describe("the debug report and the Stats tab agree", () => {
  const statsTab = between("const statsAsText = () => {", "\n    };");
  const report = between("function buildDebugInfo(", "\n  function fallbackCopy");

  test("both blocks were really found", () => {
    expect(statsTab.length).toBeGreaterThan(200);
    expect(report.length).toBeGreaterThan(200);
    expect(countersIn(statsTab).length).toBeGreaterThan(3);
  });

  test("every counter on the Stats tab is in the report too", () => {
    // One way only. The report is allowed to carry more than the tab shows,
    // since it also holds settings, selectors and the activity log; what it
    // must never do is hold less.
    const missing = countersIn(statsTab).filter((k) => countersIn(report).indexOf(k) < 0);
    expect(missing).toEqual([]);
  });

  test("the count of words swapped is in both, on the same terms", () => {
    // A swap leaves nothing on screen once it lands, so this is the only
    // evidence a report can carry that swapping ran at all. Both work out the
    // total the same way and both name the chat you are in, so the two cannot
    // disagree in front of somebody trying to read them together.
    for (const block of [statsTab, report]) {
      expect(block).toContain("stats.swapsByChat");
      expect(block).toContain("cfg.replaceEnabled || swapsAll");
      expect(block).toContain("in this chat");
    }
  });
});
