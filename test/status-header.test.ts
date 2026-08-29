// Replies that open with a status header.
//
// A common card format: every reply starts with a bracketed line carrying the
// time, date, place and weather, then the prose. It is written by the card's
// own instructions, so it is on every single reply, and a check that reads one
// of its characters wrongly does not misfire once, it misfires for good.
//
// What is on trial here is the cut-off check, which is the one that counts
// brackets, quotes, braces and asterisks. Every reply below is finished writing
// and must be left alone. The last block is the other half: a header on a reply
// that really did stop partway is still a reply that stopped partway.
import { expect, test, describe } from "bun:test";
import { __testing } from "../src/frontend";

const { looksTruncated, refusalVerdict, CONFIG } = __testing as any;

// The card's own defaults, so these run through the same settings a reader has
// on the day they install it.
const cut = (text: string) => looksTruncated(text, CONFIG.retryOnNoPunct, CONFIG);
const refusal = (text: string) => refusalVerdict(text, CONFIG).refusal;

const header =
  "[ 🕰️ Time 09:14 AM | 🗓️ Day 3 - 🗓️ Wednesday, March 4, 1888 AD | " +
  "📍 Ashgrove - The old mill road | 🌧️ Rain, 51 °F ]";

const finished = [
  header + "\n\nThe mill road ran slick under a sky that had not lifted since " +
    "dawn. Ines pulled her coat tighter and kept walking.",
  // Dialogue, which is where an odd quote count would bite.
  header + "\n\n\"You are late,\" the miller said, without turning around.",
  // Roleplay asterisks around an action, the other paired thing that is counted.
  header + "\n\n*She wipes the rain off her face.* \"I walked.\"",
  // Smart quotes, counted as their own matched pair.
  header + "\n\n“Then walk faster next time,” he said.",
  // A fantasy era and an invented calendar, which the instructions allow.
  "[ 🕰️ Time 11:40 PM | 🗓️ Day 212 - 🗓️ Emberday, Ashfall 12, 4E 331 | " +
    "📍 Vaelmoor - The lower cisterns | ❄️ Sleet, 28 °F ]\n\n" +
    "Cold came up off the water. Nobody had been down here in years.",
  // A height in the prose, a straight quote that is not dialogue.
  header + "\n\nThe man in the doorway was 6'2\" and had to duck to come in.",
  // A time skip, which the instructions ask for outright.
  header + "\n\nShe slept until the bell. When she woke the rain had stopped.",
  // The header alone on a line with the prose starting immediately under it,
  // no blank line, which is how a good many cards actually render.
  header + "\nIt was quiet.",
  // A stat block under the header, braces and all, closed properly.
  header + "\n\n{\"mood\": \"tired\", \"coin\": 3}\n\nShe counted it twice.",
  // Bold, which some cards wrap the whole line in. The asterisks are paired.
  "**" + header + "**\n\nThe road was empty both ways.",
  // The other arrangement: the header last, so the reply ends on a bracket
  // rather than on a full stop. That has to count as an ending or every single
  // reply in this format gets re-rolled.
  "She latched the door behind her.\n\n" + header,
  // A place with an apostrophe in it, which is one straight-ish mark in prose.
  "[ 🕰️ Time 06:02 AM | 🗓️ Day 9 - 🗓️ Friday, June 7, 1901 AD | " +
    "📍 Halloway - The Crow's Nest | 🌫️ Fog, 44 °F ]\n\nNobody was up yet.",
];

const stillCutOff = [
  // The prose stops on a comma.
  header + "\n\nShe reached the top of the road and looked back at the town,",
  // Dialogue opened and never closed.
  header + "\n\n\"You are late,\" the miller said, \"and I have been waiting since",
  // An action asterisk left open.
  header + "\n\n*She wipes the rain off her face and looks up at the",
  // The status block itself stopped inside its own braces.
  header + "\n\n{\"mood\": \"tired\", \"coin\":",
];

describe("a reply that opens with a status header", () => {
  test("the header on its own is not a cut-off reply", () => {
    expect(cut(header)).toBe(false);
  });

  test("a finished reply behind the header is left alone", () => {
    const wrong = finished.filter((t) => cut(t));
    expect(wrong).toEqual([]);
  });

  test("and none of them reads as a refusal", () => {
    const wrong = finished.filter((t) => refusal(t));
    expect(wrong).toEqual([]);
  });

  test("a reply that really stopped partway is still caught", () => {
    const missed = stillCutOff.filter((t) => !cut(t));
    expect(missed).toEqual([]);
  });

  test("the same reply without its header reads the same way", () => {
    // The header must not be what decides it, in either direction. Strip it and
    // every verdict above has to hold.
    const strip = (t: string) => t.slice(t.indexOf("]") + 1).trim();
    for (const t of finished) expect(cut(strip(t))).toBe(false);
    for (const t of stillCutOff) expect(cut(strip(t))).toBe(true);
  });
});
