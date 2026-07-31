// The word-swap engine, driven through the file Lumiverse actually loads.
//
// This is the most intricate logic in the extension and the only part that
// rewrites a user's saved writing, which cannot be undone. It also had no
// tests: the rules in docs/word-swaps.md (single pass, longest match wins,
// whole-word matching, capitalisation, the greeting exemption) were promises
// with nothing holding them.
//
// dist/backend.js is a plain script that reads one free variable, `spindle`, so
// it can be run here against a stub of that API. Testing the built file rather
// than the source means a broken build fails these too.
//
// Run with: bun test

import { expect, test, describe, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const BACKEND = readFileSync(
  join(import.meta.dir, "..", "dist", "backend.js"),
  "utf8",
);

type Msg = { id: string; role: string; content: string; swipes?: string[]; swipe_id?: number };

interface Harness {
  onFrontend: (payload: any) => Promise<void>;
  onGenerationEnded: (payload: any) => Promise<void>;
  toFrontend: any[];
  messages: Msg[];
  settings: (over?: any) => any;
}

// Boot a fresh copy of the backend with its own storage and chat.
function boot(messages: Msg[]): Harness {
  const store = new Map<string, string>();
  const toFrontend: any[] = [];
  let frontendHandler: any = null;
  const events: Record<string, any> = {};

  const spindle = {
    storage: {
      read: async (f: string) => {
        if (!store.has(f)) throw new Error("no such file: " + f);
        return store.get(f);
      },
      write: async (f: string, v: string) => {
        store.set(f, v);
      },
    },
    onFrontendMessage: (fn: any) => {
      frontendHandler = fn;
    },
    sendToFrontend: (m: any) => {
      toFrontend.push(m);
    },
    on: (name: string, fn: any) => {
      events[name] = fn;
    },
    chat: {
      getMessages: async () => messages,
      updateMessage: async (_chatId: string, id: string, patch: any) => {
        const m = messages.find((x) => x.id === id);
        if (!m) throw new Error("no such message " + id);
        Object.assign(m, patch);
      },
    },
    log: { info() {}, warn() {}, error() {} },
  };

  // eslint-disable-next-line no-new-func
  new Function("spindle", BACKEND)(spindle);

  return {
    onFrontend: (p: any) => frontendHandler(p),
    onGenerationEnded: (p: any) => events["GENERATION_ENDED"](p),
    toFrontend,
    messages,
    settings: (over?: any) =>
      Object.assign(
        {
          replaceEnabled: true,
          replaceRules: "",
          replaceRandom: false,
          replaceCaseSensitive: false,
          allowReSwap: false,
          confirmBeforeEdit: false,
        },
        over || {},
      ),
  };
}

// A chat with a greeting, a user line, and one generated reply to swap.
const chatWith = (reply: string): Msg[] => [
  { id: "greet", role: "assistant", content: "Welcome to the tavern." },
  { id: "u1", role: "user", content: "I sat down by the fire." },
  { id: "a1", role: "assistant", content: reply },
];

// Run a set of rules over one reply and hand back what it became.
async function swap(reply: string, rules: string, over?: any): Promise<string> {
  const msgs = chatWith(reply);
  const h = boot(msgs);
  await h.onFrontend({
    type: "save_settings",
    settings: h.settings(Object.assign({ replaceRules: rules }, over || {})),
  });
  await h.onGenerationEnded({ chatId: "c1", messageId: "a1", content: reply });
  return msgs[2].content;
}

describe("rules are applied in a single pass", () => {
  test("no rule acts on what another just wrote", async () => {
    // The documented promise: cats become dogs and dogs become wolves, and a
    // cat never becomes a wolf.
    expect(await swap("A cat and a dog.", "cat => dog\ndog => wolf")).toBe(
      "A dog and a wolf.",
    );
  });

  test("two rules can swap past each other", async () => {
    expect(await swap("hot and cold", "hot => cold\ncold => hot")).toBe(
      "cold and hot",
    );
  });
});

describe("which rule wins", () => {
  test("the longer left side beats a shorter one that starts the same", async () => {
    expect(await swap("a cat nap", "cat => dog\ncat nap => siesta")).toBe("a siesta");
  });

  test("listed first wins when two left sides are the same length", async () => {
    expect(await swap("sky", "sky => blue\nsky => aqua")).toBe("blue");
  });
});

describe("what a rule matches", () => {
  test("a single word matches whole words only", async () => {
    expect(await swap("the cat in the category", "cat => dog")).toBe(
      "the dog in the category",
    );
  });

  test("a phrase matches exactly as written, mid-sentence", async () => {
    expect(await swap("it was sort of fine", "sort of => kind of")).toBe(
      "it was kind of fine",
    );
  });

  test("a whole sentence can be swapped", async () => {
    expect(await swap("He left. She stayed.", "He left. => He ran.")).toBe(
      "He ran. She stayed.",
    );
  });

  test("a rule that cannot compile is skipped without taking the rest down", async () => {
    expect(await swap("a cat here", "( => x\ncat => dog")).toBe("a dog here");
  });

  test("a line with no arrow is ignored", async () => {
    expect(await swap("a cat here", "just some text\ncat => dog")).toBe("a dog here");
  });
});

describe("letter case", () => {
  test("matching ignores case and keeps the original capitalisation", async () => {
    expect(await swap("Cat and cat.", "cat => dog")).toBe("Dog and dog.");
  });

  test("an all-caps match stays all caps", async () => {
    expect(await swap("CATS everywhere", "cats => dogs")).toBe("DOGS everywhere");
  });

  test("case-sensitive mode swaps only an exact case match", async () => {
    expect(
      await swap("Cat and cat.", "cat => dog", { replaceCaseSensitive: true }),
    ).toBe("Cat and dog.");
  });

  test("case-sensitive mode lets one word have two different swaps", async () => {
    expect(
      await swap("Sky and sky.", "Sky => Blue\nsky => aqua", {
        replaceCaseSensitive: true,
      }),
    ).toBe("Blue and aqua.");
  });
});

describe("deleting a word", () => {
  test("an empty right side removes it and one trailing space", async () => {
    expect(await swap("he was very tired", "very => ")).toBe("he was tired");
  });

  test("it does not eat the punctuation after it", async () => {
    expect(await swap("he was very, tired", "very => ")).toBe("he was , tired");
  });
});

describe("random replacements", () => {
  test("off, it always uses the first one listed", async () => {
    for (let i = 0; i < 8; i++) {
      expect(await swap("the sky", "sky => blue\nsky => aqua")).toBe("the blue");
    }
  });

  test("on, it picks from the options given", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      seen.add(
        await swap("the sky", "sky => blue\nsky => aqua", { replaceRandom: true }),
      );
    }
    // Every result has to be one of the two, and over forty rolls both should
    // turn up; a run that only ever produced one would mean the option is dead.
    for (const s of seen) expect(["the blue", "the aqua"]).toContain(s);
    expect(seen.size).toBe(2);
  });
});

describe("what it will and will not touch", () => {
  test("the opening greeting is never swapped", async () => {
    const msgs = chatWith("nothing to match here");
    const h = boot(msgs);
    await h.onFrontend({
      type: "save_settings",
      settings: h.settings({ replaceRules: "tavern => inn" }),
    });
    // Even when the greeting is named as the finished reply.
    await h.onGenerationEnded({ chatId: "c1", messageId: "greet", content: msgs[0].content });
    expect(msgs[0].content).toBe("Welcome to the tavern.");
  });

  test("the user's own message is never swapped", async () => {
    const msgs = chatWith("She poked the fire.");
    const h = boot(msgs);
    await h.onFrontend({
      type: "save_settings",
      settings: h.settings({ replaceRules: "fire => hearth" }),
    });
    await h.onGenerationEnded({ chatId: "c1", messageId: "a1", content: msgs[2].content });
    expect(msgs[1].content).toBe("I sat down by the fire."); // untouched
    expect(msgs[2].content).toBe("She poked the hearth.");
  });

  test("nothing happens when the feature is off", async () => {
    expect(
      await swap("a cat here", "cat => dog", { replaceEnabled: false }),
    ).toBe("a cat here");
  });

  test("a reply nothing matches is left exactly as it was", async () => {
    expect(await swap("a bird here", "cat => dog")).toBe("a bird here");
  });

  test("an errored generation is left alone", async () => {
    const msgs = chatWith("a cat here");
    const h = boot(msgs);
    await h.onFrontend({
      type: "save_settings",
      settings: h.settings({ replaceRules: "cat => dog" }),
    });
    const ended = (over: any) =>
      h.onGenerationEnded(
        Object.assign({ chatId: "c1", messageId: "a1", content: "a cat here" }, over),
      );
    await ended({ error: "boom" });
    expect(msgs[2].content).toBe("a cat here");
    // Proves the rule was live all along, so the line above is the error branch
    // doing its job rather than a rule that was never going to match.
    await ended({});
    expect(msgs[2].content).toBe("a dog here");
  });
});

describe("the swipe array is carried, so the chat view redraws", () => {
  test("the active swipe is rewritten alongside the content", async () => {
    const msgs = chatWith("a cat here");
    msgs[2].swipes = ["an older take", "a cat here"];
    msgs[2].swipe_id = 1;
    const h = boot(msgs);
    await h.onFrontend({
      type: "save_settings",
      settings: h.settings({ replaceRules: "cat => dog" }),
    });
    await h.onGenerationEnded({ chatId: "c1", messageId: "a1", content: "a cat here" });
    expect(msgs[2].content).toBe("a dog here");
    expect(msgs[2].swipes).toEqual(["an older take", "a dog here"]);
    expect(msgs[2].swipe_id).toBe(1);
  });
});

describe("what it tells the frontend", () => {
  let h: Harness;
  let msgs: Msg[];
  beforeEach(async () => {
    msgs = chatWith("a cat here");
    h = boot(msgs);
    await h.onFrontend({
      type: "save_settings",
      settings: h.settings({ replaceRules: "cat => dog" }),
    });
  });

  test("an automatic swap reports the exact substitutions it made", async () => {
    await h.onGenerationEnded({ chatId: "c1", messageId: "a1", content: "a cat here" });
    const m = h.toFrontend.find((x) => x.type === "swapped");
    expect(m).toBeDefined();
    // The frontend replays these onto the rendered text, so they must be the
    // literal before/after pairs, not the rules.
    expect(m.pairs).toEqual([["cat ", "dog "]]);
    expect(m.wholeChat).toBe(false);
  });

  test("asking first sends a confirm instead of editing", async () => {
    const msgs2 = chatWith("a cat here");
    const h2 = boot(msgs2);
    await h2.onFrontend({
      type: "save_settings",
      settings: h2.settings({ replaceRules: "cat => dog", confirmBeforeEdit: true }),
    });
    await h2.onGenerationEnded({ chatId: "c1", messageId: "a1", content: "a cat here" });
    expect(msgs2[2].content).toBe("a cat here"); // not edited yet
    expect(h2.toFrontend.some((x) => x.type === "confirm_edit")).toBe(true);
  });

  test("the manual button reports what it changed", async () => {
    await h.onFrontend({ type: "apply_replace_now", chatId: "c1", requestId: "r1" });
    const m = h.toFrontend.find((x) => x.type === "replace_now_result");
    expect(m.ok).toBe(true);
    expect(m.hasRules).toBe(true);
    expect(m.found).toBe(true);
    expect(m.changed).toBe(1);
    expect(msgs[2].content).toBe("a dog here");
  });

  test("it will not swap the same reply twice by default", async () => {
    await h.onFrontend({ type: "apply_replace_now", chatId: "c1", requestId: "r1" });
    await h.onFrontend({ type: "apply_replace_now", chatId: "c1", requestId: "r2" });
    const last = h.toFrontend.filter((x) => x.type === "replace_now_result").pop();
    expect(last.changed).toBe(0);
    expect(last.skipped).toBe(1);
    expect(msgs[2].content).toBe("a dog here"); // not "a wolf here" or similar
  });

  test("with no rules set it says so rather than reporting success", async () => {
    const msgs2 = chatWith("a cat here");
    const h2 = boot(msgs2);
    await h2.onFrontend({ type: "save_settings", settings: h2.settings({ replaceRules: "" }) });
    await h2.onFrontend({ type: "apply_replace_now", chatId: "c1", requestId: "r1" });
    const m = h2.toFrontend.find((x) => x.type === "replace_now_result");
    expect(m.hasRules).toBe(false);
  });
});

describe("settings survive a restart", () => {
  test("saved settings are written and handed back", async () => {
    const h = boot(chatWith("x"));
    const settings = h.settings({ replaceRules: "cat => dog" });
    await h.onFrontend({ type: "save_settings", settings });
    await h.onFrontend({ type: "load_settings", requestId: "r1" });
    const m = h.toFrontend.find((x) => x.type === "loaded_settings");
    expect(m.settings.replaceRules).toBe("cat => dog");
  });

  test("word swap presets round-trip through account storage", async () => {
    const h = boot(chatWith("x"));
    const presets = { swap: [{ name: "Softer", values: { replaceRules: "very => " } }] };
    await h.onFrontend({ type: "save_presets", presets });
    await h.onFrontend({ type: "load_presets", requestId: "r1" });
    const m = h.toFrontend.find((x) => x.type === "loaded_presets");
    expect(m.presets).toEqual(presets);
  });
});
