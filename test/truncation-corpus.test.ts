// Two corpora of whole replies, run through the real cut-off check.
//
// One is finished replies, which it must never call cut off. One is replies
// that really were cut, which it must still catch. They are in one file
// deliberately: every fix on the first side loosens a check, and the cost of
// loosening one too far is a cut reply passing as complete, which is the whole
// point of the second side.
//
// Reported as a reply that looked complete being thrown away, with no copy of
// the reply kept. There was nothing to reproduce from, so the check was turned
// on the shapes a model actually writes instead, and four of them were being
// read as cut: a height written 6'2", a measurement in inches, multiplication
// written 2*3, and a reply that ends on a bullet list.
import { expect, test, describe } from "bun:test";
import { __testing } from "../src/frontend";
const { looksTruncated } = __testing as any;

const FINISHED: Array<[string, string]> = [
  ["plain prose", "She closed the door and leaned against it, breathing hard."],
  ["dialogue", 'He looked up. "You came back," he said quietly.'],
  ["action asterisks", "*He leans against the doorway, arms folded.* You're late."],
  ["bold and italics", "That was **not** what she meant, and *everyone* knew it."],
  ["ellipsis ending", "She hesitated... then nodded."],
  ["emoji ending", "He grinned at her and shrugged 🙂"],
  ["question ending", 'She tilted her head. "Are you sure about this?"'],
  ["smart quotes", "“I never said that,” she muttered, looking away."],
  ["nested smart quotes", "“He told me ‘go home’ and left,” she said."],
  ["apostrophes", "It wasn't hers, and she couldn't say whose it was."],
  ["smart apostrophe", "It wasn’t hers, and she couldn’t say whose it was."],
  ["possessive plural", "The girls' coats were still hanging by the door."],
  ["decade", "He still dressed like it was the '90s."],
  ["single-quoted speech", "'Get out,' she said, and meant it."],
  ["height in feet and inches", 'He was 6\'2" and had to duck through the doorway.'],
  ["measurement in inches", 'The gap was barely 3" wide, but she squeezed through.'],
  ["temperature", "It was 40° out and she had no coat."],
  ["markdown list", "She counted what was left:\n\n* one match\n* half a candle\n* a knife"],
  ["dash list", "Supplies:\n- rope\n- water\n- a map she could not read"],
  ["divider asterisks", "He left.\n\n***\n\nThe room was quiet after that."],
  ["mood gauge", "Mood: ***\nShe said nothing else that night."],
  ["code block", "Here is the cipher:\n\n```\nXHFF QB\n```"],
  ["inline code", "The sign read `NO ENTRY`, so she went in anyway."],
  ["math with asterisk", "Two rooms, three windows each, so 2*3 = 6 ways out."],
  ["stat widget", '<div class="card"><b>HP</b>: 12/20<br><b>Height</b>: 6\'2"</div>\n\nShe checked her wounds and stood.'],
  ["closed span colour", '<span style="color:#f0f">"Run,"</span> he hissed, and she ran.'],
  ["closed think block", "<think>She is lying.</think>\n\n\"I believe you,\" he said."],
  ["json status closed", 'Status: {"hp": 12, "sky": "clear"}\n\nShe pressed on.'],
  ["ends on closing quote", 'He shook his head. "Not tonight."'],
  ["ends on exclamation", "She threw the cup at the wall. It shattered!"],
  ["ends on a bracket", "He nodded (though he did not agree)."],
  ["multi paragraph", "The rain had stopped.\n\nShe stepped outside, and the air smelled like iron.\n\nNothing moved."],
  ["long scene with quotes", '"I told you," she said. "I told you and you did not listen." He said nothing. What was there to say?'],
  ["reply ending in an action", "She turned away. *He watched her go.*"],
  ["colon then list ending", "There were three doors, and she picked the middle one."],
  ["number ending", "The clock read 3:47."],
  ["quote inside action", "*She whispers, \"not yet,\" and steps back.*"],
  ["contraction heavy", "Y'know, I'd've told you if I'd known, but I didn't, so here we are."],
  ["scene break", "He left at dawn.\n\n---\n\nBy noon she had packed everything she owned."],
  ["parenthetical aside", "He agreed (reluctantly, and only after she asked twice)."],
  ["two heights in one reply", 'She was 5\'4" and he was 6\'1", and the difference showed.'],
  ["leading apostrophe words", "'Twas her idea, and she'd tell 'em so herself."],
  ["nickname in quotes", 'They called him "Ghost" for a reason.'],
  ["ellipsis character", "She waited… and then the light went out."],
  ["quote then possessive", '"That is Marcus\'s coat," she said, pointing.'],
  ["numbered list ending", "Three rules:\n\n1. Do not look back\n2. Do not stop\n3. Do not speak"],
  ["stat lines ending", "She checked the panel.\n\nHP: 12/20\nStamina: 4/10"],
  ["asterisk footnote", "He said it was safe.*\n\n*He was lying."],
  ["bold label list", "Inventory:\n\n- **rope**, frayed\n- **water**, half a flask"],
  ["ends on a closing bracket after dialogue", 'She shrugged. "Suit yourself." (He did not.)'],
  ["price with a decimal", "The room cost 12.50 a night, and she paid in coins."],
  ["ratio with asterisk emphasis", "It was *two* against *five*, and she liked those odds."],
];

describe("a finished reply is never called cut off", () => {
  for (const [name, text] of FINISHED) {
    test(name + " (no-punct check off)", () => {
      expect(looksTruncated(text, false, {})).toBe(false);
    });
    test(name + " (no-punct check on, the shipped default)", () => {
      expect(looksTruncated(text, true, {})).toBe(false);
    });
  }
});

const CUT: Array<[string, string]> = [
  ["stops mid-word", "She reached for the handle and pu"],
  ["stops on a comma", "He turned to face her, hands shaking,"],
  ["stops on a semicolon", "The room was cold;"],
  ["dialogue opened, never closed", 'She grabbed his arm. "Wait, I need to tell you'],
  ["dialogue opened after a height", 'He was 6\'2". She looked up at him and said, "You never told me'],
  ["smart quote opened, never closed", "He shook his head. “That is not what happened"],
  ["action asterisk opened", "*He steps forward, one hand raised"],
  ["code fence opened", "Here is the layout:\n\n```\nroom A"],
  ["inline code opened", "The sign said `NO ENT"],
  ["json opened", 'Status: {"hp": 12, "sky":'],
  ["think block opened", "<think>She is lying and I should"],
  ["custom block opened", "<story_plan>\nBeat one: she leaves"],
  ["html container opened", '<div class="card"><b>HP</b>: 12'],
  ["stops on a letter with no punctuation", "She walked to the window and looked out at the empty street below and then she"],
  ["list then cut mid-item", "Supplies:\n- rope\n- water\n- a map she could not"],
  ["multiplication then cut open action", "Two rooms, 2*3 ways out. *She counted them again"],
];

describe("a reply that was cut off is still caught", () => {
  for (const [name, text] of CUT) {
    test(name, () => {
      expect(looksTruncated(text, true, {})).toBe(true);
    });
  }
});
