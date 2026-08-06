// What counts as a bad reply.
//
// These are the judgement calls that decide whether the extension throws away a
// reply and asks for another, so getting one wrong costs the user real writing.
// Everything here is a pure function of the reply text and the settings, which
// is why it can be checked without a browser or a running Lumiverse.
//
// Run with: bun test

import { expect, test, describe } from "bun:test";
import { __testing } from "../src/frontend";

const {
  refusalVerdict,
  looksLikeRefusal,
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
    '<span style="background: linear-gradient(to right, #E6A15C, #8B4F1D); ' +
    '-webkit-background-clip: text; color: transparent;">' + inner;

  // The two quotes around a style value were counted alongside the two around
  // the speech, so an opened quote came out even and read as finished.
  test("a style attribute's quotes do not balance an opened one", () => {
    expect(looksTruncated(coloured('"Noel... please... wait,'), false, {})).toBe(true);
  });

  test("and a closed one is still closed", () => {
    expect(looksTruncated(coloured('"Noel... please... wait,"</span> he whispered.'), false, {})).toBe(false);
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
