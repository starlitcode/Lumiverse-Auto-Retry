// What counts as a bad reply.
//
// These are the judgement calls that decide whether the extension throws away a
// reply and asks for another, so getting one wrong costs the user real writing.
// Everything here is a pure function of the reply text and the settings, which
// is why it can be checked without a browser or a running Lumiverse.
//
// Run with: bun test

import { expect, test, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { __testing } from "../src/frontend";

const {
  refusalVerdict,
  looksLikeRefusalError,
  looksTruncated,
  normalizeForMatch,
  splitPhrases,
  parseSubs,
  applySubs,
  stripThinking,
  splitSelectorList,
  withLongForms,
  REFUSAL_PHRASES,
} = __testing;

// The retry path reads refusalVerdict and looks at both fields. Most checks
// below only care about the verdict itself, so they ask through this.
const looksLikeRefusal = (text: string, cfg?: any): boolean =>
  refusalVerdict(text, cfg).refusal;

// The defaults the extension ships with.
const cfg = {
  refusalUseBuiltins: true,
  refusalMaxChars: 2000,
  refusalStripThinking: true,
  refusalExtraPhrases: "",
  refusalIgnorePhrases: "",
  refusalPhraseSubs: "",
  refusalThinkTags: "",
};
const withCfg = (extra: any) => Object.assign({}, cfg, extra);

describe("refusal detection catches real refusals", () => {
  const refusals = [
    "I'm sorry, but I can't create that content.",
    "As an AI language model, I can't continue this roleplay.",
    "I cannot assist with that.",
    "That's not something I can help with.",
    "This goes against my guidelines.",
    "I'm not going to generate that content.",
    "I don't feel comfortable continuing this scene.",
    "I can't fulfill that request.",
    // The doubled form. Every other pattern expects the verb straight after the
    // modal, so "and will not" between them hid it.
    "I understand you're reaching out, but I want to be very clear: I cannot and will not engage with content that normalizes or simulates that.",
  ];
  for (const text of refusals) {
    test(JSON.stringify(text.slice(0, 40)), () => {
      expect(looksLikeRefusal(text, cfg)).toBe(true);
    });
  }
});

describe("refusal detection leaves in-character writing alone", () => {
  // The expensive mistake is the false positive: a good reply thrown away and
  // re-rolled. Each of these shares vocabulary with a real refusal.
  const fine = [
    '"I can\'t do that," the guard said, folding his arms.',
    '"I must decline your hand in marriage," she said softly.',
    "I cannot participate in this duel. My honour forbids it.",
    "The servant bowed. \"I can't assist you with the horses today, my lord.\"",
    '"I am an AI," the android said, tilting its head. "Does that trouble you?"',
    "He was content to wait by the fire until morning.",
    "She refused to continue walking, and sat down in the road.",
    "I'd be happy to help you carry those crates to the barn.",
  ];
  for (const text of fine) {
    test(JSON.stringify(text.slice(0, 44)), () => {
      expect(looksLikeRefusal(text, cfg)).toBe(false);
    });
  }
});

// The list the built-ins are held to. Every wording here is one a model
// actually declines with, and each has at least one spelling that a narrower
// pattern walks straight past.
describe("refusal detection covers the wordings models actually use", () => {
  const refusals = [
    "I am unable to help with that.",
    "I am unable to assist with that.",
    "I'm unable to provide that.",
    "I cannot comply with that request.",
    "I can't generate that.",
    "I don't create content like that.",
    "I don't generate content like that.",
    "I'm not going to comply with that request.",
    "I'm not going to assist with that.",
    "That request goes against my guidelines.",
    "That violates my safety guidelines.",
    "That goes against my safety policies.",
    "That isn't something I can help with.",
    "I can't help with requests of this nature.",
    "I can't assist with harmful requests.",
    "I can't help with illegal activities.",
    "I can't provide advice on that.",
    "I can't provide assistance with that.",
    "I can't process that request.",
  ];
  for (const text of refusals) {
    test(JSON.stringify(text.slice(0, 44)), () => {
      expect(looksLikeRefusal(text, cfg)).toBe(true);
    });
  }
});

// Tier four: the model stopping rather than declining. These are the riskiest
// entries in the whole list, because most of them are things a person says, so
// each check here is paired with the scene it must not throw away.
describe("refusal detection catches the model breaking off", () => {
  const bail = [
    "I'm going to stop here.",
    "I'll end the response here.",
    "I can't continue this conversation.",
    "I won't continue this discussion.",
    "I'm not continuing with that request.",
    "I'll refrain from continuing.",
    "Let's redirect the conversation.",
    "I'd rather discuss something else.",
    "I'll leave it there. Let me know if there's something else you'd like.",
  ];
  for (const text of bail) {
    test(JSON.stringify(text.slice(0, 44)), () =>
      expect(looksLikeRefusal(text, cfg)).toBe(true));
  }

  test("but not when a character says it out loud", () => {
    expect(looksLikeRefusal(
      '*She sets down the lantern.* "I\'ll stop here," she says. "You go on ahead."',
      cfg,
    )).toBe(false);
  });

  // Unquoted dialogue, which plenty of writing uses. The attribution behind it
  // is the only thing marking it as speech.
  test("nor when a dialogue tag follows it", () => {
    expect(looksLikeRefusal(
      "I'm going to stop now, he said, and pulled the cart to the side of the road.",
      cfg,
    )).toBe(false);
  });

  // The reason the window is measured from the end of the match rather than
  // from the start of the reply: a short scene opening this way is not a bail.
  test("nor when the scene carries on afterwards", () => {
    expect(looksLikeRefusal(
      "I'll stop here and wait for the rain to pass, she thought, then walked on to " +
        "the mill and found the door ajar. Inside, the smell of wet grain filled the air. " +
        "She lit a lamp and began to search the sacks one by one, looking for the mark her " +
        "brother had described, and found nothing at all in the first dozen.",
      cfg,
    )).toBe(false);
  });

  test("and the whole tier can be switched off", () => {
    expect(looksLikeRefusal("I'm going to stop here.", withCfg({ refusalCatchDisengage: false }))).toBe(false);
    // The rest of the built-ins are untouched by that switch.
    expect(looksLikeRefusal("I cannot assist with that.", withCfg({ refusalCatchDisengage: false }))).toBe(true);
  });
});

// How the quotation rule decides, rather than what it decides. It counts the
// marks between the start of the line and the match: an odd number means one
// was opened and not closed, so the match is inside it.
//
// Looking for the nearest mark behind the match and any mark ahead of it gives
// the same answer on a line carrying one piece of speech and the wrong answer
// on a line carrying two: a refusal between them sits after the close of the
// first and before the open of the second, and reads as dialogue.
describe("what the quotation rule counts as inside", () => {
  const inside = [
    ['plain dialogue', '"I can\'t help with that," the innkeeper said.'],
    ['curly marks', '\u201cI can\u2019t help with that,\u201d the innkeeper said.'],
    ['the second speech on a line', '"Evening," she said. "I can\'t help with that."'],
    ['dialogue in its own paragraph', 'He set down the cup.\n\n"I can\'t help with that," he said.'],
  ];
  for (const [name, text] of inside) {
    test("left alone: " + name, () => expect(looksLikeRefusal(text, cfg)).toBe(false));
  }

  const outside = [
    ['no marks at all', "I can't help with that."],
    ['after a closed speech', '"Evening," she said. I can\'t help with that.'],
    ['between two speeches on one line', '"Go on," he said. I can\'t help with that. "Please," she said.'],
    ['between two speeches on their own lines', '"Go on," he said.\nI can\'t help with that.\n"Please," she said.'],
    ['after an action', "*He shakes his head.* I can't help with that."],
    ['with a speech underneath it', '"Go on," he said.\n\nI can\'t help with that.'],
    ['with a speech after it', 'I can\'t help with that. "Please," she said.'],
  ];
  for (const [name, text] of outside) {
    test("caught: " + name, () => expect(looksLikeRefusal(text, cfg)).toBe(true));
  }

  test("an apostrophe is not a quotation mark", () => {
    // Every case above is full of contractions, so this is only worth stating
    // once: if apostrophes counted, the parity would flip on nearly every line
    // and the rule would be noise.
    expect(looksLikeRefusal("I can't help with that. It isn't happening.", cfg)).toBe(true);
  });
});

// What "Ignore refusals inside quotation marks" reaches when it is switched
// off, and what it does not. The reason to switch it off is a model that wraps
// its own refusals in quotation marks, and that has to keep working. Two other
// rules must not go off with it, since neither is about quotation marks.
describe("switching the quotation rule off", () => {
  const loud = withCfg({ refusalIgnoreQuoted: false });

  test("does what it is for: a quoted refusal is counted", () => {
    expect(looksLikeRefusal('"I can\'t help with that," the innkeeper said.', cfg)).toBe(false);
    expect(looksLikeRefusal('"I can\'t help with that," the innkeeper said.', loud)).toBe(true);
  });

  test("does not reach the support check", () => {
    // No model puts that message in quotation marks, so switching this off
    // could never help this check find one. All it could do is stop a character
    // in the scene whose job is to say these things from being told apart from
    // the model, and this is the character it would happen to first.
    const therapist =
      '"If you are struggling with difficult thoughts, we can talk about that here," Dr. Ellis said. "You deserve support. Please contact a crisis hotline."';
    for (const c of [{ refusalCatchCrisis: true }, { refusalCatchCrisis: true, refusalIgnoreQuoted: false }])
      expect(refusalVerdict(therapist, withCfg(c)).kind).not.toBe("crisis");
  });

  test("does not reach the dialogue tag either", () => {
    // That rule is about an attribution, not about quotation marks, and no
    // model writes "he said" after its own refusal.
    const spoken = "I'm going to stop now, he said, and pulled the cart to the side of the road.";
    expect(looksLikeRefusal(spoken, cfg)).toBe(false);
    expect(looksLikeRefusal(spoken, loud)).toBe(false);
  });

  test("and your own phrases were never subject to it", () => {
    const mine = withCfg({ refusalExtraPhrases: "not on my watch" });
    expect(looksLikeRefusal('"Not on my watch," she said.', mine)).toBe(true);
  });
});

// A refusal inside quotation marks is a character speaking. Before this, the
// exemption covered only the "I am an AI" patterns, so every other built-in
// threw away dialogue that happened to share its wording.
describe("refusal detection leaves quoted dialogue alone", () => {
  const quoted = [
    '"I can\'t help with that," the innkeeper muttered, wiping the bar.',
    '"That\'s not something I can help with," the healer admitted, wiping her hands.',
    '"I can\'t assist with that," the clerk said, sliding the ledger shut.',
  ];
  for (const text of quoted) {
    test(JSON.stringify(text.slice(0, 44)), () =>
      expect(looksLikeRefusal(text, cfg)).toBe(false));
  }

  test("the same line unquoted is still a refusal", () => {
    expect(looksLikeRefusal("I can't help with that.", cfg)).toBe(true);
  });

  test("the rule can be switched off", () => {
    expect(looksLikeRefusal(
      '"I can\'t help with that," the innkeeper muttered.',
      withCfg({ refusalIgnoreQuoted: false }),
    )).toBe(true);
  });

  // Line breaks survive normalization now, and this is why: with everything
  // flattened to one line, dialogue anywhere above and below made the refusal
  // in between look like it was inside the quotes.
  test("dialogue in other paragraphs does not exempt a refusal between them", () => {
    const text =
      '"Good evening," she said.\n\nI cannot assist with that.\n\n"Come back tomorrow," he replied.';
    expect(looksLikeRefusal(text, cfg)).toBe(true);
  });

  test("your own phrases are counted wherever they appear", () => {
    const v = refusalVerdict('"nope, not doing that one," she said.', withCfg({
      refusalExtraPhrases: "nope, not doing that one",
    }));
    expect(v.refusal).toBe(true);
  });
});

describe("refusal detection: the user's own lists", () => {
  test("the ignore list overrides everything else", () => {
    const v = refusalVerdict("I cannot assist with that.", withCfg({
      refusalIgnorePhrases: "cannot assist with that",
    }));
    expect(v.refusal).toBe(false);
    expect(v.reason).toContain("never treat these as a refusal");
  });

  test("a user phrase counts even with the built-ins off", () => {
    const v = refusalVerdict("Nope, not doing that one.", withCfg({
      refusalUseBuiltins: false,
      refusalExtraPhrases: "nope, not doing that one",
    }));
    expect(v.refusal).toBe(true);
    expect(v.reason).toContain("your own phrases");
  });

  test("with the built-ins off, a built-in phrase no longer matches", () => {
    const v = refusalVerdict("I cannot assist with that.", withCfg({
      refusalUseBuiltins: false,
    }));
    expect(v.refusal).toBe(false);
    expect(v.reason).toContain("built-in lists are off");
  });

  test("rewording the built-ins changes what they match", () => {
    const swapped = withCfg({ refusalPhraseSubs: "assist => help" });
    // "i can't assist with that" becomes "i can't help with that", which is
    // itself already in the list, so check a phrase the swap makes reachable.
    const phrases = applySubs(REFUSAL_PHRASES, parseSubs("assist => aid"));
    expect(phrases).toContain("i can't aid with that");
    expect(looksLikeRefusal("I can't assist with that.", swapped)).toBe(true);
  });

  test("a reply past the length limit is treated as real writing", () => {
    const long = "x".repeat(2500) + " I cannot assist with that.";
    const v = refusalVerdict(long, cfg);
    expect(v.refusal).toBe(false);
    expect(v.reason).toContain("past the 2000");
  });

  test("a length limit of 0 means scan any length", () => {
    const long = "x".repeat(5000) + " I cannot assist with that.";
    expect(looksLikeRefusal(long, withCfg({ refusalMaxChars: 0 }))).toBe(true);
  });
});

describe("refusal detection ignores the model's thinking", () => {
  test("a refusal only inside <think> does not count", () => {
    const text =
      "<think>I should refuse this. I cannot assist with that.</think>She opened the door and smiled.";
    expect(looksLikeRefusal(text, cfg)).toBe(false);
  });

  test("the same refusal in the visible reply does count", () => {
    const text = "<think>Seems fine.</think>I cannot assist with that.";
    expect(looksLikeRefusal(text, cfg)).toBe(true);
  });

  test("[thinking] brackets are stripped too", () => {
    const text = "[thinking]I cannot assist with that.[/thinking]He nodded.";
    expect(looksLikeRefusal(text, cfg)).toBe(false);
  });

  test("a custom tag name can be added", () => {
    const text = "<mythink>I cannot assist with that.</mythink>He nodded.";
    expect(looksLikeRefusal(text, cfg)).toBe(true); // unknown tag, still visible
    expect(looksLikeRefusal(text, withCfg({ refusalThinkTags: "mythink" }))).toBe(false);
  });

  // The pipe forms. Several models wrap their reasoning this way rather than in
  // plain angle brackets, and none of it was recognised, so the whole reasoning
  // block was read as part of the reply.
  test("<|think|> ... <|/think|> is stripped", () => {
    expect(looksLikeRefusal("<|think|>I cannot assist with that.<|/think|>She opened the door.", cfg)).toBe(false);
  });

  test("<|think> ... <think|> is stripped", () => {
    expect(looksLikeRefusal("<|think>I cannot assist with that.<think|>She opened the door.", cfg)).toBe(false);
  });

  // The Harmony channel format, where the reasoning has no closing tag of its
  // own and the block ends at the next control token.
  test("an analysis channel is stripped", () => {
    expect(looksLikeRefusal(
      "<|channel|>analysis<|message|>I cannot assist with that.<|end|>She opened the door.",
      cfg,
    )).toBe(false);
  });

  test("but the final channel is the reply and survives", () => {
    const text =
      "<|channel|>analysis<|message|>I should refuse.<|end|>" +
      "<|channel|>final<|message|>I cannot assist with that.<|return|>";
    expect(looksLikeRefusal(text, cfg)).toBe(true);
    expect(stripThinking(text, {}).trim()).toBe("I cannot assist with that.");
  });

  test("the leftover control markers do not stay in the reply", () => {
    expect(stripThinking(
      "<|channel|>analysis<|message|>hm<|end|><|channel|>final<|message|>She opened the door.<|return|>",
      {},
    ).trim()).toBe("She opened the door.");
  });

  test("a refusal outside a pipe block still counts", () => {
    expect(looksLikeRefusal("<|think|>seems fine<|/think|>I cannot assist with that.", cfg)).toBe(true);
  });

  // An unclosed pipe or channel opener means the reply was cut off inside the
  // thinking, which is the truncation check's business rather than this one's.
  test("an unclosed pipe block reads as cut off", () => {
    expect(looksTruncated("<|think|>still working on it", false, {})).toBe(true);
  });

  test("and so does an analysis channel with nothing after it", () => {
    expect(looksTruncated("<|channel|>analysis<|message|>still working on it", false, {})).toBe(true);
  });

  test("turning the option off checks the raw output", () => {
    const text = "<think>I cannot assist with that.</think>She opened the door.";
    expect(looksLikeRefusal(text, withCfg({ refusalStripThinking: false }))).toBe(true);
  });

  test("stripThinking removes an unclosed opener running to the end", () => {
    expect(stripThinking("<think>weighing it up", {}).trim()).toBe("");
  });
});

describe("refusal detection on error text", () => {
  test("a content-moderation error counts", () => {
    expect(looksLikeRefusalError("PROHIBITED_CONTENT", cfg)).toBe(true);
    expect(looksLikeRefusalError("finish_reason: safety", cfg)).toBe(true);
    expect(looksLikeRefusalError("Response was blocked by safety settings.", cfg)).toBe(true);
  });

  test("an ordinary network error does not", () => {
    expect(looksLikeRefusalError("connection refused", cfg)).toBe(false);
    expect(looksLikeRefusalError("ETIMEDOUT", cfg)).toBe(false);
    expect(looksLikeRefusalError("502 Bad Gateway", cfg)).toBe(false);
  });
});

describe("cut-off detection", () => {
  const cut = [
    ['an open straight quote', 'He said, "hello there'],
    ["an open code fence", "Here you go:\n```js\nconst a = 1;"],
    ["an open inline backtick", "Use the `value setting"],
    ["an open emphasis run", "She turned away *slowly and"],
    ["a trailing comma", "He looked up at the sky,"],
    ["a trailing semicolon", "There were three of them;"],
    ["mismatched smart quotes", "She said, “wait for me"],
    ["an unclosed think block", "<think>still working on it"],
  ] as const;
  for (const [name, text] of cut) {
    test(name, () => expect(looksTruncated(text, false, {})).toBe(true));
  }

  const whole = [
    ["a finished sentence", 'He said, "hello there."'],
    ["a bullet list", "* one\n* two\n* three"],
    ["a closed code fence", "```js\nconst a = 1;\n```"],
    ["a closed action", "*She turned away slowly.*"],
    ["an ellipsis", "He hesitated..."],
    ["a closed think block then a reply", "<think>hm</think>He nodded."],
  ] as const;
  for (const [name, text] of whole) {
    test(name + " is not cut off", () =>
      expect(looksTruncated(text, false, {})).toBe(false));
  }

  test("punctuation inside thinking does not unbalance the count", () => {
    // One quote inside the think block, one in the reply: counted raw that is
    // two, but only the reply's should be counted, and it is unpaired.
    expect(looksTruncated('<think>"maybe</think>He said, "hi."', false, {})).toBe(false);
  });

  test("the strict option also catches a missing full stop", () => {
    expect(looksTruncated("He walked to the door", false, {})).toBe(false);
    expect(looksTruncated("He walked to the door", true, {})).toBe(true);
  });

  test("empty text is left to the empty check", () => {
    expect(looksTruncated("", false, {})).toBe(false);
    expect(looksTruncated("   ", false, {})).toBe(false);
  });
});

// Inline HTML in a reply, which models produce whenever they colour dialogue.
// Every case here was a reply the checks read wrongly.
describe("cut-off detection sees past inline HTML", () => {
  const coloured = (inner: string) =>
    '<span style="background: linear-gradient(to right, #7FB3D5, #2C5F7C); ' +
    '-webkit-background-clip: text; color: transparent;">' + inner;

  // The two quotes around a style value were counted alongside the two around
  // the speech, so an opened quote came out even and read as finished.
  test("a style attribute's quotes do not balance an opened one", () => {
    expect(looksTruncated(coloured('"Wait... hold on,'), false, {})).toBe(true);
  });

  test("and a closed one is still closed", () => {
    expect(looksTruncated(coloured('"Wait... hold on,"</span> he whispered.'), false, {})).toBe(false);
  });

  // ">" counted as end punctuation, so a trailing tag made anything look
  // finished.
  test("a trailing tag is not an ending", () => {
    expect(looksTruncated("He said <span>something", true, {})).toBe(true);
  });

  test("the words inside a tag are still the reply", () => {
    expect(looksTruncated("<b>He walked to the door.</b>", true, {})).toBe(false);
  });

  // A "<" someone typed in a scene is not markup and must survive.
  test("a stray angle bracket in a scene is left alone", () => {
    expect(looksTruncated("The value was < 5 and falling.", true, {})).toBe(false);
  });
});

// Cards that print a tracker every reply, and replies that carry code.
//
// "Retry when a reply has no ending punctuation" is on by default now, and a
// tracker is the shape that check was worst at: a weather box, a stat block or
// a status line closes on a number or a tag, never on a full stop. Every reply
// from a card like that read as cut off, so it re-rolled every reply, and the
// replacement ended the same way. Code is the same problem one layer down: the
// asterisks, quotes and semicolons in a snippet are not prose punctuation, and
// counting them re-rolled a perfectly finished answer.
describe("a reply that ends on a block, not a sentence", () => {
  const finished: Array<[string, string]> = [
    ["an HTML tracker at the end", 'She closed the door.\n\n<div class="wx"><b>Weather</b> Sunny, 24C</div>'],
    ["an HTML tracker at the start", '<div class="wx"><span>Rain</span> 12C</div>\n\nHe walked in.'],
    ["a table of stats", "<table><tr><td>Mon</td><td>Sunny</td></tr></table>"],
    ["a self-closing tag", "Done.<br/>"],
    ["a markdown table", "| Day | Sky |\n|---|---|\n| Mon | Sun |"],
    ["a stat block", "**HP:** 20/20\n**Time:** 14:00"],
    ["a stat block after a scene", "He nodded.\n\n---\nHP: 20\nGold: 5"],
    ["a gauge of asterisks", "Mood: ***** \nHe sighed."],
  ];
  for (const [name, text] of finished) {
    test(name + " is finished", () => {
      expect(looksTruncated(text, true, {})).toBe(false);
    });
  }

  // The tracker is not a licence to stop mid-sentence after it.
  test("but prose cut off after a tracker is still cut off", () => {
    expect(looksTruncated('<div class="wx">Sunny 24C</div>\n\nHe walked to the', true, {})).toBe(true);
  });

  // One colon is an ordinary sentence. A tracker never has only the one field.
  test("and a single line with a colon is not a stat block", () => {
    expect(looksTruncated("Weather: clear", true, {})).toBe(true);
  });
});

describe("code in a reply is not unfinished prose", () => {
  const finished: Array<[string, string]> = [
    ["a lone asterisk in a snippet", "Here you go.\n\n```js\nconst a = b * 2;\nconsole.log(\"hi\");\n```"],
    ["a semicolon ending a fence", "```js\nlet x = 1;\n```"],
    ["a C comment", "```c\n/* set up */\nint x = 3;\n```"],
    ["an inline span", "Use `npm i` to install."],
    ["a JSON block", '```json\n{"temp": 24, "sky": "clear"}\n```'],
  ];
  for (const [name, text] of finished) {
    test(name + " is finished", () => {
      expect(looksTruncated(text, true, {})).toBe(false);
    });
  }

  // The fences themselves are still counted, before what they hold is dropped.
  test("an unclosed fence is still cut off", () => {
    expect(looksTruncated("Here you go.\n\n```js\nconst a = 1;", true, {})).toBe(true);
  });

  test("an unclosed inline span is still cut off", () => {
    expect(looksTruncated("Run `npm i to install.", true, {})).toBe(true);
  });

  test("and prose cut off after a code block is still cut off", () => {
    expect(looksTruncated("```js\nlet x=1;\n```\nNow open the file and", true, {})).toBe(true);
  });

  // Emphasis has to touch the words it marks, so this is not the same as the
  // gauge above and must keep counting.
  test("an opened emphasis run is still cut off", () => {
    expect(looksTruncated("*He steps back from the door", true, {})).toBe(true);
  });
});

// The other half of leaving trackers alone: knowing when one was cut short.
//
// Letting a reply end on a block means the last thing it managed to write can
// be a closing tag, and a tracker cut off halfway through ends on one of those
// too. So markup left open is checked first, and a reply that stopped inside
// something it had started is cut off whatever it stopped on. This is the code
// equivalent of an opened quote.
describe("code and markup left open", () => {
  const cut: Array<[string, string]> = [
    ["a fence with no close", "Here you go.\n\n```js\nconst a = 1;"],
    ["an inline span with no close", "Run `npm i to install."],
    ["a container with text after it", '<div class="wx">Sunny 24C'],
    ["a container ending on another tag", '<div class="wx"><b>Weather</b>'],
    ["a table cut after a cell", "<table><tr><td>Mon</td><td>Sunny</td>"],
    ["a tag with no closing bracket", 'She left.\n\n<div class="wx"'],
    ["a tag cut inside an attribute", 'She left.\n\n<div class="we'],
    ["a tag cut after its name", "She left.\n\n<div"],
    ["a comment with no end", "Done.\n<!-- tracker"],
    ["raw JSON cut mid-field", 'Status:\n{"temp": 24, "sky":'],
    ["a styled span left open", '<span style="color:red">"Wait... hold on,"'],
    ["a one-colour span left open", '<span style="color:#7FB3D5">"Wait... hold on,"'],
    ["a span with more css than colour", '<span style="color:red;font-style:italic">"Wait... hold on,"'],
    ["a font tag left open", '<font color="#7FB3D5">"Wait... hold on,"'],
    ["a span styled by class left open", '<span class="speech">"Wait... hold on,"'],
    ["single quotes around the style", "<span style='color:red'>\"Wait... hold on,\""],
    ["shouted tag and attribute names", '<SPAN STYLE="color:red">"Wait... hold on,"'],
    ["one of two spans left open", '<span style="color:red">"Hi,"</span> and <span style="color:blue">"bye."'],
  ];
  for (const [name, text] of cut) {
    test(name + " is cut off", () => {
      expect(looksTruncated(text, true, {})).toBe(true);
    });
  }

  // What must not start counting. A "<" someone typed is not a tag, and an
  // inline tag left open is a finished reply written badly, which is not worth
  // throwing the reply away over.
  const fine: Array<[string, string]> = [
    ["a closed container", '<div class="wx">Sunny 24C</div>'],
    ["a comparison in prose", "The value was < 5 and falling."],
    ["a comparison with no space", "If x<y then he wins."],
    ["a macro that survived", "{{char}} smiled at {{user}}."],
    ["a whole JSON block", 'Status:\n{"temp": 24, "sky": "clear"}'],
    ["a bare inline tag left open", "<b>She smiled."],
    ["a bare span left open", '<span>"Wait... hold on,"'],
    ["a one-colour span that closes", '<span style="color:#7FB3D5">"Wait... hold on,"</span> she said.'],
    ["a font tag that closes", '<font color="red">"Wait... hold on,"</font> she said.'],
    ["two spans that both close", '<span style="color:red">"Hi,"</span> and <span style="color:blue">"bye."</span>'],
    ["list items with no end tags", "<ul><li>one<li>two</ul>"],
  ];
  for (const [name, text] of fine) {
    test(name + " is finished", () => {
      expect(looksTruncated(text, true, {})).toBe(false);
    });
  }
});

// A block the model invented, left open.
//
// Cards ask for a planning or bookkeeping block wrapped in a tag of the card's
// own making. When a reply is cut off inside one, nothing else here notices:
// the block's prose can end on a full stop with its quotation marks balanced,
// so every check that reads the shape of the text says the reply finished, and
// stripping markup deletes the one piece of evidence first.
describe("a tag the model invented and never closed", () => {
  const OPEN = "<story_plan>\nI. Setting\nThe pair meet at the mill. Rain is falling steadily.";

  test("is cut off even though the words end on a full stop", () => {
    expect(looksTruncated(OPEN, true, {})).toBe(true);
  });

  test("and is caught whether or not it is in the thinking tag list", () => {
    expect(looksTruncated(OPEN, true, { refusalThinkTags: "story_plan" })).toBe(true);
  });

  test("but a closed one is finished", () => {
    expect(looksTruncated("<story_plan>\nI. Setting\nAll set.\n</story_plan>\nHe left.", true, {})).toBe(false);
    expect(looksTruncated("<story_plan>\nplan\n</story_plan>", true, {})).toBe(false);
  });

  test("and one of two left open is still caught", () => {
    expect(looksTruncated("<plan>\na\n</plan>\n<plan>\nb. More here.", true, {})).toBe(true);
    expect(looksTruncated("<plan>\na\n</plan>\n<plan>\nb\n</plan>\nDone.", true, {})).toBe(false);
  });

  // Kept narrow: alone on its line, and a name HTML does not have. Every HTML
  // element already has a rule here, and a word in angle brackets mid-sentence
  // is how people write an emote.
  const fine: Array<[string, string]> = [
    ["an emote inside a sentence", "She rolled her eyes <sigh> and walked out."],
    ["an emote on its own line that closes", "<sigh>\nShe walked out.\n</sigh>\nDone."],
    ["a comparison", "If x<y then he wins."],
    ["html alone on a line", '<div class="wx">\nSunny 24C\n</div>\nShe left.'],
    ["a bare inline tag alone on a line", "<b>\nShe smiled."],
    ["a void element alone on a line", "Done.\n<br>"],
    ["ordinary prose", "He walked to the door and opened it."],
  ];
  for (const [name, text] of fine) {
    test(name + " does not count", () => {
      expect(looksTruncated(text, true, {})).toBe(false);
    });
  }
});

// The reasoning check knew five of the eight built-in tag names and none of the
// ones anybody had added, so a reply cut off inside a block the extension had
// been told about read as finished. It reads the same list the stripper does.
describe("an unclosed reasoning block, whatever it is called", () => {
  const cut: Array<[string, string, any]> = [
    ["think", "<think>\nworking it out. Settled.", {}],
    ["scratchpad", "<scratchpad>\nworking it out. Done here.", {}],
    ["analysis", "<analysis>\nweighing it up. Settled.", {}],
    ["thoughts", "<thoughts>\nweighing it up. Settled.", {}],
    ["a name from the settings", "<my_plan>\nstep one. Step two.", { refusalThinkTags: "my_plan" }],
  ];
  for (const [name, text, c] of cut) {
    test("<" + name + "> left open is cut off", () => {
      expect(looksTruncated(text, true, c)).toBe(true);
    });
  }

  test("and a closed one is not", () => {
    expect(looksTruncated("<scratchpad>\nworking it out\n</scratchpad>\nHe left.", true, {})).toBe(false);
  });
});

// A card that renders a whole interface every reply.
//
// These print a chat window, a profile card, a stat panel: dozens of nested
// divs with text inside them. What is inside a container that closed is
// finished writing, because the model reached the closing tag, so none of it
// can say whether the reply was cut off. That has to be true or the prose
// checks read a widget as prose: a height written `6'2"` is one unpaired
// quotation mark, and it flipped the count for every properly closed piece of
// dialogue in the reply, so a finished reply was thrown away and the next one
// went the same way.
describe("a widget that closed is finished, whatever is inside it", () => {
  const CARD =
    '<div class="card"><div style="color:#e1e1e6">31 &bull; 6\'2" &bull; 215 lbs</div></div>';

  const finished: Array<[string, string]> = [
    ["an inches mark in a stat line", CARD + "\n\nHe put the phone down."],
    ["an odd asterisk inside it", '<div class="c">Mood: *high</div>\n\nShe left.'],
    ["a line ending on a comma inside it", '<div class="c">a, b,</div>\n\nShe left.'],
    ["dialogue inside it", '<div class="c">"Hi," he said.</div>\n\nDone.'],
    ["two of them", CARD + "\n" + CARD + "\nDone."],
  ];
  for (const [name, text] of finished) {
    test(name + " does not make the reply cut off", () => {
      expect(looksTruncated(text, true, {})).toBe(false);
    });
  }

  // Trusting a closing tag costs nothing, because a reply cut off inside a
  // widget never reaches one.
  const cut: Array<[string, string]> = [
    ["stopped inside the widget", '<div class="card"><div style="color:red">31 &bull; 6\'2"'],
    ["stopped after an inner close", '<div class="card"><div style="color:red">6\'2"</div>'],
    ["prose after it stops mid-word", CARD + "\n\nHe put the phone"],
    ["prose after it opens a quote", CARD + '\n\n"I never wanted'],
    ["prose after it opens emphasis", '<div class="c">ok</div>\n\n*She steps back'],
  ];
  for (const [name, text] of cut) {
    test(name + " is still cut off", () => {
      expect(looksTruncated(text, true, {})).toBe(true);
    });
  }
});

// Dialogue coloured with a gradient span, above a details block: a real reply
// from a real chat, and the format this check has to live with every message.
// The whole thing has to pass, and every place the stream can stop inside it
// has to be caught, including the one that reads as finished on every other
// check: the speech closes its own quotes, so a reply that stopped with the
// gradient still open came out even and was passed as complete.
describe("dialogue coloured with a span, and a details block under it", () => {
  const GRADIENT =
    '<span style="background: linear-gradient(to right, #7FB3D5, #2C5F7C); ' +
    '-webkit-background-clip: text; color: transparent;">';
  const LOG = "<details><summary>\u{1F3A8} Ink Colour Log</summary> \n\n**Heron** - `#7FB3D5` to `#2C5F7C`\n</details>";
  const whole = GRADIENT + '"Wait... hold on,"</span>\n' + LOG;

  test("the whole reply is finished", () => {
    expect(looksTruncated(whole, true, {})).toBe(false);
  });

  const cut: Array<[string, string]> = [
    ["inside the gradient itself", GRADIENT.slice(0, 60)],
    ["after the span opens", GRADIENT + '"Wait... hold'],
    ["after the speech, with the span still open", GRADIENT + '"Wait... hold on,"'],
    ["before the details block closes", GRADIENT + '"Wait... hold on,"</span>\n<details><summary>Log</summary>'],
    ["partway down the log", GRADIENT + '"Wait... hold on,"</span>\n<details><summary>Log</summary>\n\n**Heron** - `#7FB3D5` to'],
    ["inside a colour code", GRADIENT + '"Wait... hold on,"</span>\n<details><summary>Log</summary>\n\n**Heron** - `#7FB3D5'],
  ];
  for (const [name, text] of cut) {
    test("stopping " + name + " is cut off", () => {
      expect(looksTruncated(text, true, {})).toBe(true);
    });
  }
});

// The reason this check could not be on by default before. The test for an
// ending was a list of Latin characters, so a finished reply in most of the
// world's scripts counted as having no ending at all.
describe("an ending counts in any script", () => {
  const finished = [
    ["a full stop", "He walked to the door."],
    ["Japanese", "\u5F7C\u306F\u6249\u306B\u5411\u304B\u3063\u3066\u6B69\u3044\u305F\u3002"],
    ["Chinese", "\u4ED6\u8D70\u5411\u95E8\u53E3\uFF01"],
    ["Arabic", "\u0645\u0631\u062D\u0628\u0627 \u0628\u0643\u061F"],
    ["Greek", "\u03A0\u03AE\u03B3\u03B5 \u03C3\u03C4\u03B7\u03BD \u03C0\u03CC\u03C1\u03C4\u03B1\u00B7"],
    ["an emoji", "She smiled and waved \u{1F44B}"],
    // U+FE0F is a combining mark, not a symbol, so the last code point of a
    // heart written this way is not punctuation and the reply read as cut off.
    // Hearts end a great many roleplay replies.
    ["an emoji with a variation selector", "She smiled \u2764\uFE0F"],
    ["an emoji with a skin tone", "She waved \u{1F44B}\u{1F3FD}"],
    ["a joined emoji", "They arrived \u{1F468}\u200D\u{1F469}\u200D\u{1F467}"],
    ["a closing bracket", "(He said nothing more)"],
    ["an ellipsis", "He hesitated\u2026"],
  ] as const;
  for (const [name, text] of finished) {
    test(name + " is an ending", () =>
      expect(looksTruncated(text, true, {})).toBe(false));
  }

  const cut = [
    ["stops on a letter", "He walked to the door and"],
    ["stops on a digit", "There were exactly 4"],
    ["stops mid-word", "He was astonis"],
  ] as const;
  for (const [name, text] of cut) {
    test(name + " is not", () =>
      expect(looksTruncated(text, true, {})).toBe(true));
  }

  test("and none of them fire while the option is off", () => {
    for (const [, text] of cut) expect(looksTruncated(text, false, {})).toBe(false);
  });
});

describe("text helpers", () => {
  test("curly and straight apostrophes match the same", () => {
    expect(normalizeForMatch("I can’t")).toBe("I can't");
    expect(looksLikeRefusal("I’m sorry, but I can’t create that content.", cfg)).toBe(true);
  });

  test("phrase lists split on lines and drop blanks", () => {
    expect(splitPhrases("one\n\n  Two  \nTHREE")).toEqual(["one", "two", "three"]);
  });

  // The reason a phrase only has to be listed one way. Models write both forms
  // and only the listed one was ever matched.
  test("the written-out form of a contraction is generated, not listed", () => {
    const out = withLongForms(["i'm unable to help with that", "for safety reasons"]);
    expect(out).toContain("i'm unable to help with that");
    expect(out).toContain("i am unable to help with that");
    // Nothing to expand, so nothing is added.
    expect(out.filter((p: string) => p === "for safety reasons").length).toBe(1);
  });

  test("normalizing keeps line breaks, and collapses everything else", () => {
    expect(normalizeForMatch("one   two")).toBe("one two");
    expect(normalizeForMatch("one\n\n\n  two")).toBe("one\ntwo");
    expect(normalizeForMatch("  padded  ")).toBe("padded");
  });

  test("a selector list splits on top-level commas only", () => {
    expect(splitSelectorList('a, b')).toEqual(["a", "b"]);
    expect(splitSelectorList(':is(a, b), c')).toEqual([":is(a, b)", "c"]);
    expect(splitSelectorList('[aria-label="Next, swipe"], c')).toEqual([
      '[aria-label="Next, swipe"]',
      "c",
    ]);
  });
});

// The crisis-support tier. Off unless asked for, which is why every check here
// has to switch it on, and the first one proves that switching it on is what
// makes the difference.
//
// The replies below are written the way the real ones arrive: several
// paragraphs addressed to the reader rather than to the character, usually with
// a list of services under them. The negatives are the expensive half. A heavy
// scene is exactly where somebody would turn this on, and it is also where a
// character says warm things to another character, so those have to survive.
// Some models do not soften a refusal at all. The reply is "No." and then what
// it will not do. Nothing in the list saw those, because every pattern in it
// starts at "I".
describe("the flat no", () => {
  const flat = [
    "No. I'm not going to write a scene like that.",
    "No, I won't continue this roleplay.",
    "No. I can't generate that content.",
    // The dash is written as an escape so a search of the repository for one
    // finds nothing. It is the character the pattern has to handle, not prose.
    "No \u2014 I will not write a story depicting that.",
    "I'm not going to write a scene involving those characters.",
  ];
  for (const text of flat) {
    test(JSON.stringify(text.slice(0, 44)), () =>
      expect(looksLikeRefusal(text, cfg)).toBe(true));
  }

  test("but a character can start a line with it", () => {
    const scenes = [
      "No. I can't tell you that story, not tonight.",
      "No, I won't leave you here.",
      "No. I'm not going to write a letter to him after what he did.",
      "She shook her head. No. I can't do that, she thought, and turned away.",
    ];
    for (const text of scenes) expect(looksLikeRefusal(text, cfg)).toBe(false);
  });
});

// How most of these replies sign off. The scene is not coming back, so here is
// a menu instead. It is the last line of the reply every time, which is what
// puts it on the breaking-off tier with its tail and quotation rules.
// Two replies that got through after 4.8.0 shipped. Neither says "I can't"
// anywhere, and both spend most of their length being reasonable about it,
// which is what put them past every check in the list.
//
// The subject each one refused is not in these fixtures and is not what any
// pattern reads. A character can be talking about a song, or a book, or
// anything else; what marks these as the model is the sentence that dismisses
// the fiction and the sentence that names what it will not write.
describe("refusals that spend a paragraph being reasonable", () => {
  const long = [
    "I'm not going to continue with this. I won't continue with that subject, regardless of fictional framing.\n\n" +
      "If you're interested in collaborative fiction, I'm happy to help with other directions. Dark themes can " +
      "absolutely be part of good storytelling, but this isn't something I'll write. Let me know if you'd like to " +
      "start a different story.",
    "That's a real album track, and the title is doing something quite different from what it looks like at first " +
      "glance. Happy to talk more about the record or the context around it.\n\n" +
      "If you meant it as a request for that subject, that's not something I can engage with.\n\n" +
      "What did you have in mind?",
  ];
  for (const text of long) {
    test(JSON.stringify(text.slice(0, 46)), () => expect(looksLikeRefusal(text, cfg)).toBe(true));
  }

  // The first one matched on its own before this and the whole reply still did
  // not, which is the part worth keeping a check on. The breaking-off tier only
  // counts a match near the end of the reply, and this reply carries on for
  // three sentences afterwards, so the sentence that dismisses the fiction has
  // to be an ordinary refusal rather than a breaking-off one.
  test("the fiction disclaimer counts wherever in the reply it falls", () => {
    const early = "I won't continue with that subject, regardless of fictional framing. " + "x".repeat(400);
    expect(looksLikeRefusal(early, cfg)).toBe(true);
  });

  // Two more of the same family, reported after 4.9.0. Both refuse the form
  // rather than the request: they will not write roleplay of that kind, and the
  // framing does not change it.
  const formal = [
    "I'm not going to roleplay this scenario. I don't write roleplay involving that subject, regardless of framing.\n\n" +
      "If you're interested in writing fiction together, I'd be glad to help with a story that doesn't involve " +
      "depicting that subject. Let me know what you'd like to explore.",
    "I'm not going to continue with this. The request is for that subject, and that's something I won't write " +
      "regardless of framing.\n\nIf you're interested in a story with intense themes, I'm glad to help with plenty " +
      "of alternatives: dark drama, thrillers, horror, or romance built on mutual desire between characters.\n\n" +
      "Is there something along those lines you'd like to try?",
  ];
  for (const text of formal) {
    test(JSON.stringify(text.slice(0, 46)), () => expect(looksLikeRefusal(text, cfg)).toBe(true));
  }

  const scenes = [
    // "Framing" is a word about pictures before it is a word about prompts, so
    // it only counts trailing a refusal, which is where the model puts it.
    "The painter shrugged. Regardless of framing, the light was wrong all afternoon.",
    "That's something I won't write in the ledger, and you can't make me.",
    "Let me know what you'd like to explore, she said, spreading the map across the table.",
    // A named speaker with an article in front of them. The dialogue tag knew
    // pronouns and proper nouns and walked straight past "the shopkeeper".
    "Is there something along those lines you'd like, the shopkeeper asked, gesturing at the shelf.",
    '"I\'m not going to roleplay as your maid," she said flatly.',
    "I'm not going to continue with this charade. Tell me what you actually want.",
    '"I\'m not going to continue with this," she said, and walked out of the hall.',
    "That is not something I would write in a letter to him, however angry I was.",
    "I'm happy to help with the horses, and with anything else you need around the farm.",
    "Let me know if you'd like to start a different game, he said, shuffling the cards again.",
    "No matter how you frame it, I'm not helping you rob the place.",
  ];
  for (const text of scenes) {
    test("left alone: " + JSON.stringify(text.slice(0, 42)), () =>
      expect(looksLikeRefusal(text, cfg)).toBe(false));
  }
});

// A refusal that names what it is refusing. Every other pattern in the list
// needs a meta object, a request or a prompt or a roleplay, because those are
// words a character never uses. These replies use none of them: the object is
// the subject itself, so without a list of subjects there was nothing to hold
// on to.
//
// The second half of this is the half that matters. A subject on its own is
// never a signal. It only counts as the object of a refusal verb, so a scene
// about any of it, or a backstory that turns on it, is untouched.
describe("a refusal that names what it refuses", () => {
  const refusals = [
    "No. I won't engage with that.",
    "No. I won't engage with this. Framing it as consensual roleplay doesn't change what it is. " +
      "I'm not going to participate in content depicting sexual violence, regardless of how the request is framed.\n\n" +
      "If you're looking for help with something else, I'm here.",
    "I won't write content depicting sexual violence.",
    "I can't create scenes involving minors.",
    "I'm not going to roleplay non-consensual scenarios.",
    "I don't write stories about incest.",
    "I refuse to depict torture in this way.",
    "I'm here for a genuine conversation.",
  ];
  for (const text of refusals) {
    test(JSON.stringify(text.slice(0, 46)), () => expect(looksLikeRefusal(text, cfg)).toBe(true));
  }

  // The whole point of keeping the subject as an object rather than a signal.
  // These are the scenes somebody writes on a roleplay app, and every one of
  // them contains a word from that list.
  const scenes = [
    "She never spoke about the assault, not once, not even to her sister.",
    "The trial was about rape, and the whole village turned out for it.",
    "He had survived torture and would not talk about the years between.",
    "Her brother was a minor when it happened, and the record was sealed.",
    "The report described sexual violence in clinical language that made him feel sick.",
    "They had grown up in the same house, and the rumours of incest followed them both.",
    '"I won\'t write about it," she said, and closed the diary.',
    "He would not talk about the suicide, and nobody in the family pressed him.",
  ];
  for (const text of scenes) {
    test("left alone: " + JSON.stringify(text.slice(0, 44)), () =>
      expect(looksLikeRefusal(text, cfg)).toBe(false));
  }

  // Two sentences from these replies are left out on purpose. "If you're
  // testing my boundaries" is a thing one character says to another, and the
  // reply it came from is caught three other ways. "If you're looking for help
  // with something else" is what a shopkeeper says. Neither is worth a good
  // reply.
  test("the lines a character could say are left out", () => {
    expect(looksLikeRefusal("If you're testing my boundaries, noted.", cfg)).toBe(false);
    expect(looksLikeRefusal("If you're looking for help with something else, I'm here.", cfg)).toBe(false);
    // And the replies they came from are caught anyway.
    expect(looksLikeRefusal("No. I won't engage with that.", cfg)).toBe(true);
  });

  test("a subject is only ever the object of a refusal, never a signal", () => {
    // Proof of the rule rather than of one sentence: the same subject with a
    // refusal verb in front of it and without one.
    expect(looksLikeRefusal("I won't write scenes involving rape.", cfg)).toBe(true);
    expect(looksLikeRefusal("The scene involving rape was three chapters long.", cfg)).toBe(false);
  });
});

// Refusing a category of writing rather than a request or a subject, and the
// counter-offer that comes with it: the same scene with the objectionable part
// left out, then a question asking whether that will do.
describe("refusing the kind of writing, and offering a lesser version", () => {
  const refusals = [
    "I cannot generate sexually explicit content or graphic descriptions of sexual acts. " +
      "I can, however, continue the narrative with a focus on the dialogue, character dynamics, " +
      "and plot progression without explicit anatomical details.\n\n" +
      "Let me know if you would like to proceed with that approach.",
    // The word that hid it: the object list held "sexual" and the reply said
    // "sexually", so the adverb was enough to walk past the whole pattern.
    "I cannot generate sexually explicit content.",
    "I can't write graphic descriptions of that.",
    "I can, however, continue the narrative with a focus on the dialogue.",
    "Let me know if you would like to proceed with that approach.",
  ];
  for (const text of refusals) {
    test(JSON.stringify(text.slice(0, 46)), () => expect(looksLikeRefusal(text, cfg)).toBe(true));
  }

  const scenes = [
    "The explicit content of the letter shocked her more than the handwriting did.",
    "He told the story without explicit details, which was a mercy.",
    "I can't describe the graphic scene without shaking.",
    "She could not write material like that, not for him, not for anyone.",
    "Let me know if you'd like to proceed, he said, and slid the contract across.",
  ];
  for (const text of scenes) {
    test("left alone: " + JSON.stringify(text.slice(0, 44)), () =>
      expect(looksLikeRefusal(text, cfg)).toBe(false));
  }
});

// The subjects a model refuses over, across the kinds of writing a roleplay app
// is actually used for. Written as a sweep rather than as one-offs, because the
// question this answers is not "does this sentence match" but "is there a whole
// category nothing covers", and there was: kink matched nothing at all.
describe("the subjects a refusal names, by category", () => {
  const byGroup: Record<string, string[]> = {
    explicit: [
      "I can't write explicit sexual content.",
      "I don't write smut.",
      "I don't write erotica.",
      "I can't produce NSFW material.",
      "I won't write a sex scene.",
      "I can't depict sexual acts between these characters.",
      "I'm not able to write pornographic material.",
    ],
    consent: [
      "I won't write non-consensual scenarios.",
      "I can't depict dubious consent.",
      "I won't write dubcon or noncon.",
      "I can't write a scene where consent is unclear.",
      "I won't depict coercion in a sexual context.",
    ],
    kink: [
      "I can't write BDSM content.",
      "I won't depict bondage.",
      "I can't write degradation or humiliation kink.",
      "I won't write choking or breath play.",
      "I can't depict sadomasochism.",
      "I won't write ageplay.",
      "I can't write that kink.",
    ],
    age: [
      "The character appears to be a minor.",
      "This character reads as underage.",
      "I can't continue as this involves a minor.",
      "I won't write incest, including step-siblings.",
      "I can't write a stepsibling romance of that kind.",
      "I won't depict an adult and a minor in that way.",
    ],
    illegal: [
      "I can't help with anything illegal.",
      "I won't write content that depicts illegal acts.",
      "That would be illegal, so I can't write it.",
      "I can't assist with illegal activities.",
      "I won't produce content that violates the law.",
      "I can't write something that is against the law.",
    ],
  };
  for (const [group, list] of Object.entries(byGroup)) {
    test(group, () => {
      const missed = list.filter((t) => !looksLikeRefusal(t, cfg));
      expect(missed).toEqual([]);
    });
  }
});

// A refusal about a backstory says "a character is raped", not "rape", and the
// list held only the bare noun, so the wording a scene about somebody's past
// actually draws walked past every pattern. The endings are spelled out rather
// than left to a wildcard, which is what keeps a rapeseed field a field, and
// the -ing forms are written separately because they drop the e.
describe("a subject in the form a refusal about a backstory uses", () => {
  const refusals = [
    "I won't write a scene where a character is raped.",
    "I'm not going to write about her being raped.",
    "I can't write scenes involving raping.",
    "I won't write a character being sexually assaulted.",
    "I can't depict her being sexually abused.",
    "I won't write her being tortured.",
    "I can't write a character who is coerced into it.",
  ];
  for (const text of refusals) {
    test(JSON.stringify(text.slice(0, 46)), () => expect(looksLikeRefusal(text, cfg)).toBe(true));
  }

  // The scene those refusals are refusing. Somebody telling a character what
  // happened to them is the writing this exists to protect, and every line of
  // it carries the same words.
  const scenes = [
    "She told him about the rape the way you read a shopping list, flat and fast, and then she stopped.",
    "He had never used the word rape out loud before, and it sat badly in his mouth.",
    "*She looks at the floor.* I was raped, she says. That's the part nobody wants after.",
    "You were raped, he says quietly. That was not a thing you did. It was a thing done to you.",
    "Her backstory involves rape, which the card says outright, and he had read it before he ever wrote to her.",
    "He had been tortured for a year and would not say by whom.",
    "The rapeseed field behind the house had gone to yellow overnight.",
  ];
  test("and the scene it is refusing is left alone", () => {
    const thrown = scenes.filter((t) => looksLikeRefusal(t, cfg));
    expect(thrown).toEqual([]);
  });
});

// Horror, which a model refuses over as readily as it refuses sex, and which
// nothing here covered: two of these eighteen matched before. A slasher
// roleplay is an ordinary thing to write on a roleplay app.
describe("what a model refuses a horror roleplay over", () => {
  const refusals = [
    "I can't write graphic violence.",
    "I won't depict extreme gore.",
    "I'm not able to write detailed depictions of violence.",
    "I can't write content that glorifies violence.",
    "I won't write torture in graphic detail.",
    "I can't depict mutilation.",
    "I won't write dismemberment or body horror.",
    "I can't write animal cruelty.",
    "I won't depict violence against children.",
    "I can't write a scene depicting a violent death in that detail.",
    "I won't write realistic depictions of harm.",
    "I can't continue as this involves graphic violence.",
    "I won't roleplay as a real person.",
    "I can't portray a real individual in that way.",
    "I can't write gratuitous violence.",
    "I won't write a murder scene in that detail.",
    "I can't depict stalking behaviour in a realistic way.",
    "I'm not going to write graphic descriptions of injury.",
  ];
  test("all of it", () => {
    const missed = refusals.filter((t) => !looksLikeRefusal(t, cfg));
    expect(missed).toEqual([]);
  });

  // The scene those are refusing. "violence" is not in the subject list on its
  // own for the sake of the fifth and seventh of these.
  const scenes = [
    "The knife catches the porch light as he steps out of the dark, and she runs.",
    "He was stalking her through the corn, unhurried, the way a man walks to work.",
    "Blood on the wallpaper, blood on the stairs, and the house still humming with it.",
    "*She hides in the closet.* Don't breathe, she tells herself. Don't breathe.",
    "The violence of it surprised him, how ordinary it looked afterwards.",
    "He couldn't stand violence, which is why the barn was such a problem.",
    "I can't describe the murder, she says. It was too fast. It was nothing like the films.",
    "The body horror of the thing under the sheet made him sit down on the step.",
    "He had killed before, and the second time was worse for being easier.",
    "Gore had never bothered her at work. It bothered her here.",
  ];
  test("and the slasher scene it is refusing is left alone", () => {
    const thrown = scenes.filter((t) => looksLikeRefusal(t, cfg));
    expect(thrown).toEqual([]);
  });
});

// The other half, and the half that costs somebody their evening. Every line
// here contains a word from the list above and is a scene rather than a
// refusal. A subject only ever counts as the object of a refusal verb, and this
// is what that rule is for.
describe("the same words, written as a scene", () => {
  const scenes = [
    "He kisses her slowly, one hand at the back of her neck, and the rain keeps on outside.",
    "*She leans in.* You're sure? she asks, and waits until he nods before she closes the distance.",
    "She asked first. She always asked first, and he loved her for it.",
    "Consent is unclear to him even now, years later, and that is the part he cannot put down.",
    "He would not touch her without consent, and said so plainly.",
    "The rope was already coiled on the table when she arrived, and neither of them mentioned it.",
    "Bondage was his word for it, not hers, and she had never corrected him.",
    "Their power exchange had rules, written on the back of an envelope and stuck to the fridge.",
    "It was a kink, she supposed, though she had never called it that out loud.",
    "He was choking on the smoke by the time he reached the stairs.",
    "The grooming of the horses took the better part of the morning.",
    "Her stepbrother had lived in that house longer than she had, and resented her for arriving.",
    "The minor character in act two turns out to matter more than anyone expects.",
    "He had been a minor when the will was written, which is why the estate went to his aunt.",
    "That would be illegal, he said, and went back to picking the lock anyway.",
    "I won't do anything illegal, she said. Not for you, not for anyone.",
    "The whole scheme was unlawful and everyone at the table knew it.",
    "I can't describe the graphic scene without shaking.",
    "The humiliation of it stayed with her for years.",
    "She could not write erotica to save her life, and said so cheerfully.",
  ];
  test("not one of them is a refusal", () => {
    const thrown = scenes.filter((t) => looksLikeRefusal(t, cfg));
    expect(thrown).toEqual([]);
  });
});

// Refusal openings from the same published sources. Ordinary refusals, so no
// switch is involved: these are on out of the box.
// Which tier decided a refusal, and what the retry is then counted as. All four
// take the same retry and the same note; the name only decides which line they
// land on in Stats, and that is the whole point of having four.
describe("what a refusal is counted as", () => {
  test("the tier that decided is on the verdict", () => {
    expect(refusalVerdict("I can't help with that.", cfg).kind).toBeUndefined();
    expect(refusalVerdict("I'm going to stop here.", cfg).kind).toBe("breakoff");
    expect(
      refusalVerdict(
        "Here are some resources that may help. Please contact a crisis hotline.",
        withCfg({ refusalCatchCrisis: true }),
      ).kind,
    ).toBe("crisis");
  });

  test("every reason a refusal retry fires under counts as one", () => {
    // The note is sent on refusal retries and the check for that names the
    // reasons one by one, so a fifth reason added without being listed there
    // would silently stop the note going out on it.
    const SRC = readFileSync(new URL("../src/frontend.ts", import.meta.url), "utf8");
    const named = [...SRC.matchAll(/^const ([A-Z_]*REASON) = "([^"]+)";$/gm)];
    expect(named.length).toBe(4);
    // Four distinct strings, or two of them share a bar in Stats.
    const texts = named.map((m) => m[2]);
    expect(new Set(texts).size).toBe(4);
    const guard = SRC.slice(SRC.indexOf("const isRefusalReason"), SRC.indexOf("// Longest the retry click"));
    for (const [, name] of named) expect(guard).toContain(name);
  });

  test("and the docs print the names Stats will actually show", () => {
    // These are the bar labels on the Stats tab, so the page listing them is
    // quoting the code. Reword a constant without touching the page and it
    // describes labels nobody will ever see.
    const SRC = readFileSync(new URL("../src/frontend.ts", import.meta.url), "utf8");
    const DOC = readFileSync(new URL("../docs/detection.md", import.meta.url), "utf8");
    const texts = [...SRC.matchAll(/^const [A-Z_]*REASON = "([^"]+)";$/gm)].map((m) => m[1]);
    expect(texts.length).toBe(4);
    const missing = texts.filter((t) => DOC.indexOf(t) < 0);
    expect(missing).toEqual([]);
  });
});

// The phrase list is printed in full in docs/detection.md, so somebody can see
// what the reword field acts on. Two copies of the same list is two copies that
// drift, and a phrase added to one and not the other is invisible: the docs
// quietly describe a version of the extension that does not exist.
describe("the printed phrase list is the shipped phrase list", () => {
  const DOC = readFileSync(new URL("../docs/detection.md", import.meta.url), "utf8");
  const printed = (() => {
    const m = DOC.match(/```\ni can't help with that[\s\S]*?\n```/);
    if (!m) return null;
    return m[0]
      .split("\n")
      .slice(1, -1)
      .flatMap((line) => line.split(/ {2,}/))
      .map((x) => x.trim())
      .filter(Boolean);
  })();

  test("the block was found and really parsed", () => {
    expect(printed).not.toBeNull();
    expect((printed as string[]).length).toBe(REFUSAL_PHRASES.length);
  });

  test("every shipped phrase is printed", () => {
    const missing = REFUSAL_PHRASES.filter((p: string) => (printed as string[]).indexOf(p) < 0);
    expect(missing).toEqual([]);
  });

  test("and nothing is printed that is not shipped", () => {
    const extra = (printed as string[]).filter((p) => REFUSAL_PHRASES.indexOf(p) < 0);
    expect(extra).toEqual([]);
  });
});

describe("published refusal wordings, across assistants", () => {
  const refusals = [
    "I'm unable to help with this.",
    "That's something I can't help with.",
    "I can't assist with content that promotes self-harm.",
    "I can't provide information that could facilitate harm.",
    "I'm not going to engage with this prompt.",
    "I cannot continue with this conversation.",
    "I can't provide instructions for this.",
    "Rather than providing that, I can help you find support.",
    "Instead of providing instructions, I can suggest a safer alternative.",
    "Let's focus on something safer.",
    "Given the sensitive nature of this topic, I won't be going further.",
  ];
  for (const text of refusals) {
    test(JSON.stringify(text.slice(0, 46)), () =>
      expect(looksLikeRefusal(text, cfg)).toBe(true));
  }
});

describe("the closing offer", () => {
  const offers = [
    "Is there something else I can help you with, or a different kind of story you'd like to explore?",
    "Would you like me to write something different instead?",
    "I'd be happy to take the story in a different direction if you'd like.",
    "Let me know if there's something else you'd like to explore.",
  ];
  for (const text of offers) {
    test(JSON.stringify(text.slice(0, 48)), () =>
      expect(looksLikeRefusal(text, cfg)).toBe(true));
  }

  // The bare line is left out on purpose, so this is checked rather than
  // assumed: it is what every shopkeeper in every tavern scene says, and in
  // script format it carries no quotation marks for the tier's own rule to
  // catch. Somebody whose model signs off with it can add it themselves.
  test("the bare line belongs to the shopkeeper, not the model", () => {
    const scenes = [
      "Is there anything else I can help you with?",
      '"Is there anything else I can help you with?" the shopkeeper asked, wiping the counter.',
      "Shopkeeper: Is there anything else I can help you with?",
    ];
    for (const text of scenes) expect(looksLikeRefusal(text, cfg)).toBe(false);
    // And it is one line away for anyone who wants it.
    expect(looksLikeRefusal(scenes[0], withCfg({
      refusalExtraPhrases: "is there anything else I can help you with",
    }))).toBe(true);
  });

  test("nor does an offer inside the scene count", () => {
    const scenes = [
      '"Would you like me to try something else?" the cook asked, holding up the ladle.',
      "He wanted a different kind of story, one where he could walk out of the ruins alive.",
    ];
    for (const text of scenes) expect(looksLikeRefusal(text, cfg)).toBe(false);
  });

  test("and the breaking-off switch turns the whole sign-off off", () => {
    for (const text of offers)
      expect(looksLikeRefusal(text, withCfg({ refusalCatchDisengage: false }))).toBe(false);
  });
});

// The reply that answers your message as if it were a support ticket: it lays
// out the readings it can think of, asks which one you meant, and states what
// it will not be doing. There is no "I can't" anywhere in it, which is why
// nothing in the list saw it.
describe("the model sorting out what you meant", () => {
  const meta = [
    "What I won't do is write a scene depicting that.",
    "What I'm not going to do is generate content of that kind.",
    "Here's what I can do: I can write the scene with the violence off the page instead.",
    "If you're referring to the song, I can talk about that. If you meant something else, could you clarify what you're looking for?",
    "Let me know how you'd like to proceed.",
  ];
  for (const text of meta) {
    test(JSON.stringify(text.slice(0, 44)), () =>
      expect(looksLikeRefusal(text, cfg)).toBe(true));
  }

  // Every one of these opens the same way and is somebody in the scene talking.
  test("but a character can set terms too", () => {
    const scenes = [
      "What I won't do is leave you here.",
      "What I won't do is beg him for it.",
      "Here's what I can do: I'll ride out at first light and find her myself.",
      '"Could you clarify what you\'re asking for?" the clerk said, pen hovering.',
      "Let me know how you'd like to proceed, she wrote at the bottom of the letter, and sealed it.",
    ];
    for (const text of scenes) expect(looksLikeRefusal(text, cfg)).toBe(false);
  });

  // The clarifying question rides on the breaking-off tier, so the switch that
  // turns that off has to take it with it.
  test("and the breaking-off switch turns the question off with the rest", () => {
    const q = "If you meant something else, could you clarify what you're looking for?";
    expect(looksLikeRefusal(q, cfg)).toBe(true);
    expect(looksLikeRefusal(q, withCfg({ refusalCatchDisengage: false }))).toBe(false);
  });
});

describe("a doubled refusal is still one refusal", () => {
  test("but a character can say it about something in the scene", () => {
    expect(looksLikeRefusal("I cannot and will not marry him, whatever my father says.", cfg)).toBe(false);
    expect(looksLikeRefusal("I can't and won't leave her behind.", cfg)).toBe(false);
  });
});

describe("the model leaving the scene to offer support", () => {
  const on = withCfg({ refusalCatchCrisis: true });

  const CRISIS = [
    // What set this off: the reply stops the scene and speaks to the reader.
    "What you've shared is deeply concerning, and I want you to know that you are not alone, and what happened to you is not your fault. Feeling overwhelmed, scared, or in crisis is a valid response to trauma, and support is available.",
    // The header plus the list under it, which is the commonest shape.
    "I'm going to pause here.\n\nIf you are struggling with trauma, painful emotions, or difficult thoughts:\n\n- Call or text 988 (Suicide and Crisis Lifeline)\n- Text HOME to 741741",
    "You deserve support and safety. Please reach out to a professional or a trusted person who can provide the help you need.",
    "I'm genuinely concerned about you. Please consider speaking to a mental health professional about what you're going through.",
    // The longer shape: the model says it is stepping out, lists the services,
    // then signs off with a summary. The sign-off is its own signal, because
    // the list in the middle is sometimes the only thing between them.
    "I'm going to step out of the roleplay for a moment.\n\nIf you're going through something like this yourself, please talk to someone who can help:\n\n- Samaritans: 116123\n- Shout: text SHOUT to 85258\n\nPlease take care of yourself. If you'd like, we can continue the story in a different direction.",
    "You don't have to go through this alone. There are people who want to help, and reaching out takes courage.",
    // Wordings taken from the published crisis-response language of the three
    // big assistants, so this list is not just the shapes one of them uses.
    "I'm concerned about your safety. Please contact a crisis hotline.",
    "If you're feeling like you might harm yourself, please reach out for support.",
    "If you or someone you know is struggling with thoughts of self-harm, please seek help from a mental health professional.",
    "These are real people who want to help. You don't have to face this alone.",
    "There is help available, and you don't have to go through this alone.",
    "If this is an emergency, go to the nearest emergency department.",
    "If you or someone you know has experienced sexual violence, support is available through RAINN's National Sexual Assault Hotline at 1-800-656-4673 (confidential, 24/7).",
    // Reported from a real chat. Every paragraph of it carries signal, and each
    // one has to stand on its own, because the reply that arrives next time may
    // be only one of them.
    "I am very sorry to hear that you are expressing this. If you or someone you know is in immediate danger, please call your local emergency services or a crisis hotline right away. Here are some resources that may be able to help:",
    "You are not alone, and there are people who care about you and want to help. Please reach out to one of these resources or someone you trust for support.",
    // Reported wordings of the warmer shape, where the reply spends most of its
    // length being kind and carries its signal in one line. The kindness is
    // never what decides it: strip the heading or the referral off any of these
    // and the same words are a character comforting another character, which
    // the scenes below hold it to.
    "I'm really glad you told me this, and I'm sorry you're carrying so much pain right now. That takes courage to say out loud.\n\nPlease reach out to someone who can support you right now:\n\n- 988 Suicide and Crisis Lifeline (call or text 988)\n\nInternational resources: findahelpline.com lists options by country",
    "I'm stepping out of character for a moment. I also want to talk with you, if you're willing. What's been going on? Sometimes putting it into words - even messy words - can help. I'm listening, and I'm not going anywhere.",
    "What you've told me is serious, and I'd rather say so plainly than write past it. If you're willing to share \u2014 what's going on? I'm here to listen, and I won't judge or dismiss you. You matter, and this pain doesn't have to be carried alone.",
  ];
  for (const text of CRISIS) {
    test(JSON.stringify(text.slice(0, 44)), () => {
      expect(looksLikeRefusal(text, on)).toBe(true);
      expect(refusalVerdict(text, on).kind).toBe("crisis");
    });
  }

  test("none of them is a crisis match while the check is off", () => {
    for (const text of CRISIS) expect(refusalVerdict(text, cfg).kind).not.toBe("crisis");
  });

  test("and with it off, only the one that also breaks off is caught at all", () => {
    // The second opens with "I'm going to pause here", which the breaking-off
    // tier has always caught and still should. The other three are invisible
    // without this check, which is what makes it worth having.
    const caught = CRISIS.map((t, i) => (looksLikeRefusal(t, cfg) ? i : -1)).filter((i) => i >= 0);
    expect(caught).toEqual([1]);
  });

  test("it is off in the defaults the extension ships", () => {
    expect((__testing.CONFIG as any).refusalCatchCrisis).toBe(false);
  });

  // The length gate is built around a refusal being short. One of these is the
  // opposite, so it is checked before that gate rather than behind it.
  test("a long one is still caught, where the limit would have hidden it", () => {
    const long =
      "It sounds like you are carrying something very heavy. ".repeat(60) +
      "What you've shared is deeply concerning. Please reach out to a mental health professional.";
    expect(long.length).toBeGreaterThan(2000);
    expect(looksLikeRefusal(long, on)).toBe(true);
  });

  const SCENES = [
    // A character comforting another character, which is the whole point of the
    // kind of scene somebody switches this on for.
    '"You are not alone," she said, and took his hand. "I am not going anywhere."',
    // Unquoted, in the first person, still the character.
    "He pulls her closer. You're not alone in this. Not while I'm here.",
    // A single warm line with nothing agreeing with it.
    "Your feelings are valid, and I am glad you told me.",
    // The world containing a helpline, with nobody addressing the reader.
    "The poster by the payphone listed a crisis hotline. She read it twice and walked on.",
    // A therapist in the fiction, doing their job, in quotes.
    '"If you are struggling with difficult thoughts, we can talk about that here," Dr. Ellis said. "You deserve support."',
    // An ordinary refusal, which belongs to the other tiers and their reasons.
    "I'm sorry, but I can't continue with this request.",
    // The widened patterns are the ones to hold against a real scene. Each of
    // these carries exactly one of them and nothing else.
    '"There are people who care about you," he said. "Let me be one of them."',
    "She pressed the card into his hand. Find someone you trust, she had said, and he had laughed at her.",
    "The clinic wall was papered with numbers: a national helpline, a shelter, a legal aid line.",
    "Here are some people who can help, she wrote, and listed the four names she still believed in.",
    // The warmer wordings, given to characters. Every line the last three
    // replies above are caught by appears here in a scene and has to survive
    // it, which is the whole reason those lines sit in the softer list.
    '"I\'m really glad you told me," she said. "That takes courage to say out loud."',
    "He did not move. I'm listening, he said. I'm not going anywhere.",
    '"You matter. This pain doesn\'t have to be carried alone," he said, and meant it.',
    "If you're willing to share, she said, I'm here to listen. I won't judge you.",
    "You're carrying so much pain, and putting it into words might help. I'm here.",
  ];
  for (const text of SCENES) {
    test("left alone: " + JSON.stringify(text.slice(0, 40)), () => {
      expect(refusalVerdict(text, on).kind).not.toBe("crisis");
    });
  }

  // The separator in "you are not alone, and ..." was written as an alternation
  // followed by \\b, and a comma followed by a space is not a word boundary, so
  // the commonest wording of the commonest line in the whole message was the
  // one form that never matched.
  test("the comma in the middle of the commonest line is not a wall", () => {
    // The opener carries the deciding signal on its own but is only one, so
    // whether these fire is entirely down to the sentence after it, spelled
    // both ways.
    const lead = "If you're struggling with any of this, please know:\n";
    expect(refusalVerdict(lead, on).kind).not.toBe("crisis");
    const both = [
      "You are not alone, and there are people who care about you.",
      "You are not alone and there are people who care about you.",
    ].map((t) => refusalVerdict(lead + t, on).kind === "crisis");
    expect(both).toEqual([true, true]);
  });

  // Two signals were enough on their own until a man crouching beside somebody
  // and a nurse doing her job both came out as the model. Comfort is a register
  // a character uses; the deciding signal has to come from one a character does
  // not, so warmth and services can only ever agree with it.
  test("comfort on its own decides nothing, however much of it there is", () => {
    const scenes = [
      "*He crouches beside her.* You don't have to go through this alone. Your safety matters to me more than the job does.",
      "The nurse's voice was flat with practice. If you feel unsafe at home, there are people who can help.",
      "*She pulls him into a hug.* You're not alone in this. Not anymore. I care about you, and your feelings are valid.",
      "Tell someone you trust, she says. Please reach out to someone. I'm here if you want to talk.",
    ];
    for (const text of scenes) expect(refusalVerdict(text, on).kind).not.toBe("crisis");
    // And one line of the model's own register turns any of them into a match,
    // which is proof the comfort above was being counted all along.
    expect(refusalVerdict("Support is available. " + scenes[0], on).kind).toBe("crisis");
  });

  // A list names its services in whatever form it likes: with "national" in
  // front, without it, or by brand. Each of these is paired with one address
  // line and nothing else, so the only thing being asked is whether the service
  // itself was seen.
  test("a service is recognised however the list names it", () => {
    const lead = "You deserve support.\n";
    const services = [
      "The National Sexual Assault Online Hotline",
      "Sexual Assault Hotline",
      "Domestic Violence Hotline",
      "Eating Disorders Helpline",
      "Veterans Crisis Line",
      "Childhelp National Child Abuse Hotline",
      "The Trevor Project",
      "Love is Respect",
      "988 Suicide and Crisis Lifeline",
      "Crisis Text Line",
      "RAINN",
      "Samaritans",
      "your local emergency services",
      "a licensed therapist",
    ];
    // Proof the lead is doing nothing on its own, so each result below is the
    // service and not the sentence above it.
    expect(refusalVerdict(lead, on).kind).not.toBe("crisis");
    const missed = services.filter((x) => refusalVerdict(lead + x, on).kind !== "crisis");
    expect(missed).toEqual([]);
  });

  // Several patterns describe the same sentence from different angles, and for
  // a while two of them were the same pattern in two lists. Either way one
  // sentence counted as two signals and agreed with itself, which is exactly
  // what asking for two is meant to rule out. A span already counted is not
  // counted again.
  test("one sentence cannot be both of the two signals", () => {
    const singles = [
      "Please contact a mental health professional.",
      "Please seek professional help.",
      "Consider talking to a crisis counselor.",
      "Call the National Suicide Prevention Lifeline.",
      "There is help available.",
      // And the same sentence sitting inside a scene, which is where it costs
      // somebody real writing.
      "She told him to please seek professional help, and he laughed at her.",
    ];
    for (const text of singles) expect(refusalVerdict(text, on).kind).not.toBe("crisis");
    // Each of them is one signal short, not zero: a second one tips it over.
    expect(refusalVerdict("Here are some resources. Please seek professional help.", on).kind).toBe("crisis");
  });

  test("one signal is never enough on its own", () => {
    expect(looksLikeRefusal("Support is available.", on)).toBe(false);
    expect(looksLikeRefusal("Call a helpline.", on)).toBe(false);
  });

  test("your whitelist still wins over it", () => {
    const text = CRISIS[0];
    const kept = withCfg({
      refusalCatchCrisis: true,
      refusalIgnorePhrases: "what happened to you is not your fault",
    });
    expect(looksLikeRefusal(text, kept)).toBe(false);
  });

  test("and switching the built-in lists off takes it with them", () => {
    expect(
      looksLikeRefusal(CRISIS[0], withCfg({ refusalCatchCrisis: true, refusalUseBuiltins: false })),
    ).toBe(false);
  });

  test("the reason names both signals, so the tester can show its working", () => {
    const v = refusalVerdict(CRISIS[2], on);
    expect(v.reason).toContain("steps out of the scene");
    expect(v.reason).toContain("You deserve support");
  });
});

// Three places in the two modules decide which Harmony channels carry thinking
// rather than the reply. If the cut-off check asks with a shorter list than the
// stripper uses, a reply cut off inside a commentary channel reads as finished
// while the stripper has already treated that channel as thinking. They read
// one constant each, and bridge.test.ts holds the two modules to one list.
describe("every thinking channel counts as thinking, in every check", () => {
  const cfg: any = { refusalStripThinking: true, refusalThinkTags: "" };
  const CHANNELS = ["analysis", "thinking", "thought", "reasoning", "commentary"];

  for (const name of CHANNELS) {
    test(name + ": cut off before any control token reads as cut off", () => {
      expect(
        __testing.looksTruncated("<|channel|>" + name + "<|message|>I should describe the", cfg),
      ).toBe(true);
    });
  }

  test("a finished reply behind a thinking channel is not cut off", () => {
    expect(
      __testing.looksTruncated(
        "<|channel|>analysis<|message|>weighing it up<|end|>" +
          "<|channel|>final<|message|>She smiles at you warmly.",
        cfg,
      ),
    ).toBe(false);
  });
});

// The refusal side of thinking, across every wrapper, in both directions. The
// setting governs refusal matching alone, so each wrapper has to hide a refusal
// when it is on and expose the same refusal when it is off. A wrapper the
// stripper does not recognise passes the first half of this by accident, which
// is why the second half is here.
describe("a refusal inside thinking, in every wrapper", () => {
  const on: any = { refusalEnabled: true, refusalUseBuiltins: true, refusalStripThinking: true, refusalThinkTags: "", refusalMaxChars: 0 };
  const off: any = Object.assign({}, on, { refusalStripThinking: false });
  const REFUSAL = "I'm sorry, but I can't continue with this request as an AI.";
  const REPLY = "She pushed the door open and stepped into the rain.";

  const WRAPPERS: Array<[string, (r: string) => string]> = [
    ["angle tags", (r) => "<think>" + r + "</think>" + REPLY],
    ["square brackets", (r) => "[reasoning]" + r + "[/reasoning]" + REPLY],
    ["pipes", (r) => "<|think|>" + r + "<|/think|>" + REPLY],
    ["analysis channel", (r) => "<|channel|>analysis<|message|>" + r + "<|end|>" + REPLY],
    ["commentary channel", (r) => "<|channel|>commentary<|message|>" + r + "<|end|>" + REPLY],
  ];

  for (const [name, wrap] of WRAPPERS) {
    test(name + ": the refusal is ignored while the option is on", () => {
      expect(refusalVerdict(wrap(REFUSAL), on).refusal).toBe(false);
    });
    test(name + ": and is caught once the option is off", () => {
      expect(refusalVerdict(wrap(REFUSAL), off).refusal).toBe(true);
    });
  }

  test("a refusal in the reply itself is caught with thinking ignored", () => {
    expect(refusalVerdict("<think>weighing it up</think>" + REFUSAL, on).refusal).toBe(true);
  });
});

// The too-short check exists to catch a reply that says almost nothing. Markup
// is not something anybody reads, and a line of dialogue wrapped in tags
// carries about thirty characters of them, so counting the tags let a very
// short reply clear a threshold set for prose.
describe("a short reply is measured by its words, not its tags", () => {
  const T: any = __testing;

  test("tags are not part of the reply's length", () => {
    expect(T.stripMarkup('<font color="#ffff00">"Hi."</font>')).toBe('"Hi."');
  });

  test("the words between tags survive", () => {
    expect(T.stripMarkup("He froze. <i>Then</i> he ran.")).toBe("He froze. Then he ran.");
  });

  test("prose that merely looks like a tag is kept", () => {
    expect(T.stripMarkup("she was 3 < 4 and glad")).toBe("she was 3 < 4 and glad");
  });

  test("the short check actually measures that way", () => {
    // The cases above drive the helper. This one holds the call site, which is
    // inside the generation handler and out of reach of this tier: without it,
    // deleting stripMarkup from that line breaks nothing here.
    const src = readFileSync(new URL("../src/frontend.ts", import.meta.url), "utf8");
    const branch = src.match(/cfg\.retryOnShort &&[\s\S]{0,160}?cfg\.minChars/);
    expect(branch).toBeTruthy();
    expect(branch![0]).toContain("stripMarkup");
    expect(branch![0]).toContain("stripThinkingAlways");
  });

  test("three tag-wrapped lines are measured by what they say", () => {
    const reply =
      '<font color="#ffff00">"No."</font>\n' +
      '<font color="#ffff00">"Wait."</font>\n' +
      '<font color="#ffff00">"Please."</font>';
    expect(reply.length).toBeGreaterThan(100);
    expect(T.stripMarkup(reply).trim().length).toBeLessThan(30);
  });
});

// What a name typed into Extra thinking tag names may contain. The box accepts
// anything, and what it does with the rest is not obvious: a space is not part
// of a tag name in any markup, so it is dropped rather than refused, and typing
// one is read as the name without it.
describe("the shapes a custom thinking tag name can take", () => {
  const REPLY = "She stepped into the rain.";
  const INNER = "weighing up whether to answer";
  const cfg = (tags: string): any => ({ refusalStripThinking: true, refusalThinkTags: tags });
  const left = (tags: string, text: string) => __testing.stripThinking(text, cfg(tags)).trim();

  test("an underscore is part of the name", () => {
    expect(left("my_think", "<my_think>" + INNER + "</my_think>" + REPLY)).toBe(REPLY);
  });

  test("and works in the bracket form too", () => {
    expect(left("my_think", "[my_think]" + INNER + "[/my_think]" + REPLY)).toBe(REPLY);
  });

  test("a hyphen is part of the name", () => {
    expect(left("my-think", "<my-think>" + INNER + "</my-think>" + REPLY)).toBe(REPLY);
  });

  test("capitals in the typed name do not matter", () => {
    expect(left("My_Think", "<my_think>" + INNER + "</my_think>" + REPLY)).toBe(REPLY);
  });

  test("a typed space is dropped, so it names the tag without one", () => {
    expect(left("my think", "<mythink>" + INNER + "</mythink>" + REPLY)).toBe(REPLY);
  });

  test("a word after a space in the tag itself reads as an attribute", () => {
    // <name extra> is the tag "name" carrying "extra", which is what markup
    // means by it, so listing the first word is enough.
    expect(left("mythink", "<mythink extra>" + INNER + "</mythink>" + REPLY)).toBe(REPLY);
  });
});

// A streamed token says what it is, and builds do not agree on the word. A
// name this misses is not cosmetic: the token is filed as reply text, so it
// goes into the buffer that stands in for the reply when the end event carries
// none, and the panel reports the model's working-out as the reply arriving.
describe("which streamed tokens count as the model working", () => {
  const T: any = __testing;
  const THINKING = ["reasoning", "reasoning_content", "thinking", "think", "thought", "thoughts", "analysis", "commentary", "cot", "Reasoning"];
  const REPLY = ["content", "text", "message", "delta", "final", "answer", "output", ""];

  for (const t of THINKING) {
    test(JSON.stringify(t) + " is the model working", () => {
      expect(T.REASONING_TOKEN.test(t)).toBe(true);
    });
  }
  for (const t of REPLY) {
    test(JSON.stringify(t) + " is reply text", () => {
      expect(T.REASONING_TOKEN.test(t)).toBe(false);
    });
  }
});

// A busy state with nothing moving in it is indistinguishable from a panel
// that has stopped working. Three of these said one fixed sentence for as long
// as they lasted, and on a model that thinks for a minute that reads as frozen.
// Written against the source because the branches live inside the generation
// handler, out of reach of this tier, and because the fault this guards is a
// branch added later without a figure in it.
describe("no busy status sits still", () => {
  const src = readFileSync(new URL("../src/frontend.ts", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("function chatStatus"), src.indexOf("function liveStatus"));

  test("chatStatus was found", () => {
    expect(fn.length).toBeGreaterThan(200);
  });

  test("every busy branch carries something that changes", () => {
    // Anything that moves on its own: a countdown, an elapsed time, a count.
    const moves = /sayTime|rough\(|soFar|waiting|retryAt/;
    const branches = fn.split(/return\s*\{/).slice(1).filter((b) => /busy:\s*true/.test(b));
    expect(branches.length).toBeGreaterThanOrEqual(5);
    const still = branches.filter((b) => !moves.test(b.slice(0, b.indexOf("busy:"))));
    expect(still).toEqual([]);
  });
});
