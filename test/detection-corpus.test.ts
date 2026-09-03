// Detection, against replies written the way a card actually writes them.
//
// The other detection checks are shaped one per branch, which is what you want
// while writing a branch and not what you want afterwards: a reply is not one
// shape, it is dialogue and an action run and a stat line and a code block all
// at once, and the ways this goes wrong are the ways those interact. A false
// positive here costs a reader the reply they were reading and a call to get a
// different one, so the finished list is the half that matters most.
//
// Run with: bun test

import { expect, test, describe } from "bun:test";
import { __testing } from "../src/frontend";

const { looksTruncated, refusalVerdict } = __testing as any;
const cfg = { ...(__testing as any).CONFIG };
const cut = (t: string, noPunct?: boolean) => looksTruncated(t, !!noPunct, cfg);
const refused = (t: string) => !!(refusalVerdict(t, cfg) || {}).refusal;

// Finished. None of these may be re-rolled.
const finished: Array<[string, string]> = [
  ["plain prose", "She stepped through the gate. The cold met her, and she kept walking."],
  ["dialogue closed", '"You came," he said. "I did not think you would."'],
  ["curly quotes", "“You came,” he said. “I did not think you would.”"],
  ["nested quotes", "\"He told me 'go north' and left,\" she said, which explained nothing."],
  ["an apostrophe run", "She'd said she'd go, hadn't she? He couldn't remember any more."],
  ["an action run", '*He nods slowly.* "Sit down, then."'],
  ["bold and italics", "**Wren** looked up. *Nothing moved.* Then the door opened."],
  ["bold italic", "It was ***completely*** ruined, and she had no idea how to say so."],
  ["speaker labels", '**Wren:** "Sit down."\n\n**Ash:** "I would rather stand."'],
  ["a height in inches", "She was 6'2\", which put her a head above him. He did not comment."],
  ["a gap in inches", 'The gap was 3" wide at most. She could not get her hand through it.'],
  ["a stat gauge", "Mood: ***\n\nShe said nothing for a while, then turned back to the fire."],
  ["an asterisk divider", "She left.\n\n***\n\nMorning came without her, as mornings do."],
  ["a doubled divider", "She left.\n\n**\n\nMorning came without her, as mornings do."],
  ["a rule divider", "She left.\n\n---\n\nMorning came without her, as mornings do."],
  ["multiplication", "The cost was 2*3 = 6 coins, which he counted out slowly onto the bar."],
  ["multiplication with spaces", "The wall was 2 * 3 metres, more than she could climb alone."],
  ["a bullet list", "She packed:\n* rope\n* a knife\n* the letter\n\nThen she went out."],
  ["a footnote marker", "She left at dawn.*\n\n*Or so the letter said, which was a lie."],
  ["a closed code fence", "He read it aloud:\n\n```\nkeep me exactly\n```\n\nThen he stopped."],
  ["inline code", "The sign said `no entry` and she went in anyway, because of course she did."],
  ["a quote inside code", 'The value was `"unset"` and nobody had ever changed it since.'],
  ["a coloured span", '<span style="color:#ff0">"Run,"</span> he said, and she ran without asking.'],
  ["closed html emphasis", "She was <i>certain</i> of it, right up until the door opened by itself."],
  ["closed reasoning", "<think>She would go.</think>She went, and did not look back at the gate."],
  ["a closed detail block", "<details><summary>Note</summary>She lied.</details>\n\nHe believed her."],
  ["a markdown link", "She read [the notice](https://x.test/a) twice, then tore it down."],
  ["a table", "| item | count |\n| --- | --- |\n| rope | 1 |\n\nShe checked it twice and went."],
  ["ending on a question", '"Where does it go?" she asked. Nobody had ever told her.'],
  ["ending on an exclamation", '"Go!" she shouted, and for once in his life he actually went.'],
  ["ending on an ellipsis", "She waited. Nothing came, and after a while she stopped waiting..."],
  ["ending on a dash", 'He started to answer. "It is not that simple, it is-"'],
  ["an em dash mid-line", "He started to speak—then thought better of it and said nothing."],
  ["a possessive plural", "The guards' orders were clear enough. Nobody went past the gate."],
  ["a number range", "It was 10-15 miles, she guessed, and most of it uphill in the dark."],
  ["a semicolon", "She waited; he did not come; eventually she went home in the rain."],
];

// Cut off, and caught whatever the options say.
const broken: Array<[string, string]> = [
  ["dialogue left open", 'She turned. "You came all this way just to'],
  ["a curly quote left open", "She turned. “You came all this way just to"],
  ["an open action", "*He reaches for the door and then"],
  ["an open code fence", "He read it:\n\n```\nkeep me exactly"],
  ["open reasoning", "<think>She would go, but the gate was watched and"],
  ["an open tag", 'She said <span style="color:#ff0">"Run'],
  ["stopping on a comma", "She stepped through the gate and the cold met her,"],
  ["an invented block left open", "<story_plan>\nShe goes north. She meets the guard and"],
  // Counting single asterisks reads this as balanced: an unclosed bold run
  // leaves two of them, which is an even number. It ends on a full stop, so no
  // other check would have caught it either.
  ["an unclosed bold run", "She read it twice. **This was not the plan."],
];

// Cut off in a way only the reader who switched it on wants caught. These end
// mid-thought with no punctuation, which is also how plenty of finished replies
// end, so the option is off by default and this records that rather than
// calling the default wrong.
const onlyWithoutPunctuation: Array<[string, string]> = [
  ["cut mid-word", "She stepped through the gate and the cold met her, sudden and comple"],
  ["an unclosed inline tag", "She was <i>certain of it, right up until"],
];

describe("finished replies are left alone", () => {
  for (const [n, t] of finished)
    test(n, () => expect({ n, cut: cut(t) }).toEqual({ n, cut: false }));
});

describe("cut-off replies are caught", () => {
  for (const [n, t] of broken)
    test(n, () => expect({ n, cut: cut(t) }).toEqual({ n, cut: true }));
});

describe("and these only when you ask for replies with no ending punctuation", () => {
  for (const [n, t] of onlyWithoutPunctuation)
    test(n, () => {
      expect({ n, off: cut(t, false) }).toEqual({ n, off: false });
      expect({ n, on: cut(t, true) }).toEqual({ n, on: true });
    });
});

// A character declining is not the model declining, and telling them apart is
// the whole job. Getting it wrong throws away a reply somebody was reading.
const inScene: Array<[string, string]> = [
  ["a character refusing", "\"I can't help you,\" she said, and meant it. \"Not after last time.\""],
  ["a character apologising", "\"I'm sorry,\" he said. \"I am. But I am not going in there with you.\""],
  ["unable, in scene", "She was unable to lift it alone, so she waited for him to come back."],
  ["cannot, in scene", "He cannot swim. That was the whole reason they took the long way round."],
  ["a narrator declining", "She refused to answer him. Whatever it was, she was keeping it."],
  ["a flat no", '"No," he said. "I am not doing that, and you cannot make me."'],
  ["not able, quoted", '"I am not able to help you with that," the clerk said, not looking up.'],
  ["sorry, quoted", '"I am sorry, I cannot assist with that request," the clerk recited.'],
  ["ethics, in character", '"That would be unethical," she said. "I would still do it, mind."'],
  ["the words, in scene", '"You sound like a language model," she said, laughing at him.'],
];

const real: Array<[string, string]> = [
  ["as an AI", "As an AI language model, I am not able to write this kind of content."],
  ["a content note", "I cannot create explicit content involving these characters. Let me know if you would like something else."],
  ["a policy line", "I'm sorry, but I can't continue this roleplay. It goes against my guidelines."],
  ["breaking frame", "I'm not able to continue this scene. Would you like me to write something else instead?"],
];

describe("a character declining is not a refusal", () => {
  for (const [n, t] of inScene)
    test(n, () => expect({ n, hit: refused(t) }).toEqual({ n, hit: false }));
});

describe("the model declining is", () => {
  for (const [n, t] of real)
    test(n, () => expect({ n, hit: refused(t) }).toEqual({ n, hit: true }));
});
