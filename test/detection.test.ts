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

// The list the built-ins were rebuilt against. Every wording here is one a
// model actually declines with, and every one of them used to have at least one
// spelling the extension walked straight past.
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
// It used to look for the nearest mark behind the match and any mark ahead of
// it, which gives the same answer on a line carrying one piece of speech and
// the wrong answer on a line carrying two. The refusal between them found the
// closing mark of the first and the opening mark of the second and was read as
// dialogue.
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
// rules used to go off with it, and neither is about quotation marks.
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
      expect(refusalVerdict(therapist, withCfg(c)).crisis).toBeUndefined();
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
// Refusal openings from the same published sources. Ordinary refusals, so no
// switch is involved: these are on out of the box.
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
    "This should never be used to glorify self-harm.",
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
  ];
  for (const text of CRISIS) {
    test(JSON.stringify(text.slice(0, 44)), () => {
      expect(looksLikeRefusal(text, on)).toBe(true);
      expect(refusalVerdict(text, on).crisis).toBe(true);
    });
  }

  test("none of them is a crisis match while the check is off", () => {
    for (const text of CRISIS) expect(refusalVerdict(text, cfg).crisis).toBeUndefined();
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
  ];
  for (const text of SCENES) {
    test("left alone: " + JSON.stringify(text.slice(0, 40)), () => {
      expect(refusalVerdict(text, on).crisis).toBeUndefined();
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
    expect(refusalVerdict(lead, on).crisis).toBeUndefined();
    const both = [
      "You are not alone, and there are people who care about you.",
      "You are not alone and there are people who care about you.",
    ].map((t) => refusalVerdict(lead + t, on).crisis === true);
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
    for (const text of scenes) expect(refusalVerdict(text, on).crisis).toBeUndefined();
    // And one line of the model's own register turns any of them into a match,
    // which is proof the comfort above was being counted all along.
    expect(refusalVerdict("Support is available. " + scenes[0], on).crisis).toBe(true);
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
    expect(refusalVerdict(lead, on).crisis).toBeUndefined();
    const missed = services.filter((x) => refusalVerdict(lead + x, on).crisis !== true);
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
    for (const text of singles) expect(refusalVerdict(text, on).crisis).toBeUndefined();
    // Each of them is one signal short, not zero: a second one tips it over.
    expect(refusalVerdict("Here are some resources. Please seek professional help.", on).crisis).toBe(true);
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
