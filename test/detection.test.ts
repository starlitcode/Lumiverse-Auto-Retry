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
