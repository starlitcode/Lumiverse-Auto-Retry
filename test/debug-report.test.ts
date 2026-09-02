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

  test("each tick box names everything its section prints", () => {
    // Same rule the import and export parts follow. The tick boxes are what
    // somebody reads when deciding what to leave out of a report they are
    // about to paste in public, so a section carrying something its name does
    // not mention gets unticked, or kept, for the wrong reason.
    const list = between("const sections: Array<{", "\n      ];");
    const labels: Record<string, string> = {};
    for (const m of list.matchAll(/\{ id: "([a-z]+)", label: "([^"]+)" \}/g))
      labels[m[1]] = m[2];
    expect(Object.keys(labels).sort()).toEqual(["activity", "buttons", "environment", "settings"]);

    // What each section actually prints, and the word its name has to carry.
    const rules: Array<{ id: string; prints: string; word: RegExp }> = [
      { id: "environment", prints: 'lines.push("permissions:")', word: /permission/i },
      { id: "buttons", prints: "regenerateSelector = ", word: /selector/i },
      { id: "activity", prints: "recent activity (oldest first)", word: /activity/i },
      { id: "settings", prints: 'lines.push("settings:")', word: /setting/i },
    ];
    for (const r of rules) {
      // The section really does print it, so the rule cannot pass by being
      // written about something the report stopped carrying.
      expect({ id: r.id, prints: report.indexOf(r.prints) >= 0 })
        .toEqual({ id: r.id, prints: true });
      expect({ id: r.id, label: labels[r.id] })
        .toEqual({ id: r.id, label: r.word.test(labels[r.id]) ? labels[r.id] : "MISSING THE WORD" });
    }
  });

});
