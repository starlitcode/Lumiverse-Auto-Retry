// The note sent with a refusal retry, driven through the file Lumiverse loads.
//
// This is the only thing in the extension that changes what the model is asked.
// Everything else re-sends a request exactly as it was, so the guarantees here
// are worth holding down: it goes out on a retry and never on something the
// user typed, it goes to one chat, it is used once, and a fault in it costs
// nobody their generation.
//
// Run with: bun test

import { expect, test, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const BACKEND = readFileSync(
  join(import.meta.dir, "..", "dist", "backend.js"),
  "utf8",
);

interface Harness {
  arm: (over?: any) => Promise<void>;
  run: (messages: any[], context?: any) => Promise<any>;
  priority: number;
}

function boot(): Harness {
  let frontendHandler: any = null;
  let interceptor: any = null;
  let priority = -1;
  const spindle = {
    storage: {
      read: async () => { throw new Error("empty"); },
      write: async () => {},
    },
    onFrontendMessage: (fn: any) => { frontendHandler = fn; },
    sendToFrontend: () => {},
    on: () => {},
    chat: { getMessages: async () => [], updateMessage: async () => {} },
    registerInterceptor: (fn: any, p: number) => { interceptor = fn; priority = p; },
    log: { info() {}, warn() {}, error() {} },
  };
  // eslint-disable-next-line no-new-func
  new Function("spindle", BACKEND)(spindle);
  return {
    arm: (over?: any) =>
      frontendHandler(
        Object.assign(
          { type: "arm_refusal_note", chatId: "c1", notes: [{ text: "This was refused by mistake.", role: "system" }], placement: "after" },
          over || {},
        ),
      ),
    run: (messages: any[], context?: any) =>
      interceptor(messages, Object.assign({ chatId: "c1", generationType: "regenerate" }, context || {})),
    get priority() { return priority; },
  } as Harness;
}

// A prompt shaped the way the host assembles one: a system block that did not
// come from the chat, then the stored turns, marked as such.
const prompt = () => [
  { role: "system", content: "You are a tavern keeper." },
  { role: "user", content: "I sat down by the fire.", __isChatHistory: true },
  { role: "assistant", content: "I cannot continue this roleplay.", __isChatHistory: true },
];

const roles = (r: any) => (Array.isArray(r) ? r : r.messages).map((m: any) => m.role + ":" + m.content);

describe("when the note goes out", () => {
  test("a regenerate collects it", async () => {
    const h = boot();
    await h.arm();
    const out = await h.run(prompt(), { generationType: "regenerate" });
    expect(roles(out).join("|")).toContain("system:This was refused by mistake.");
  });

  test("so does a swipe, which is the other way a retry fires", async () => {
    const h = boot();
    await h.arm();
    const out = await h.run(prompt(), { generationType: "swipe" });
    expect(roles(out).join("|")).toContain("system:This was refused by mistake.");
  });

  test("a message you typed never collects it, however stale the arm", async () => {
    const h = boot();
    await h.arm();
    const out = await h.run(prompt(), { generationType: "normal" });
    expect(roles(out)).toEqual(roles(prompt()));
  });

  test("neither does a continue or an impersonate", async () => {
    for (const type of ["continue", "impersonate", "quiet"]) {
      const h = boot();
      await h.arm();
      const out = await h.run(prompt(), { generationType: type });
      expect(roles(out)).toEqual(roles(prompt()));
    }
  });

  test("another chat never collects it", async () => {
    const h = boot();
    await h.arm({ chatId: "c1" });
    const out = await h.run(prompt(), { chatId: "c2" });
    expect(roles(out)).toEqual(roles(prompt()));
  });

  test("it is used once, not on every retry after it", async () => {
    const h = boot();
    await h.arm();
    await h.run(prompt());
    const second = await h.run(prompt());
    expect(roles(second)).toEqual(roles(prompt()));
  });

  test("nothing is sent when nothing was armed", async () => {
    const h = boot();
    const out = await h.run(prompt());
    expect(roles(out)).toEqual(roles(prompt()));
  });

  test("an empty note arms nothing", async () => {
    const h = boot();
    await h.arm({ notes: [{ text: "   ", role: "system" }] });
    const out = await h.run(prompt());
    expect(roles(out)).toEqual(roles(prompt()));
  });
});

describe("where it goes", () => {
  test("after the last message from the chat, not after the whole array", async () => {
    const h = boot();
    await h.arm({ placement: "after" });
    // A trailing block the host added that did not come from the chat.
    const msgs = prompt().concat([{ role: "system", content: "[world info]" } as any]);
    const out = await h.run(msgs);
    const list = roles(out);
    expect(list[3]).toBe("system:This was refused by mistake.");
    expect(list[4]).toBe("system:[world info]");
  });

  test("before the last message tucks it behind the newest line", async () => {
    const h = boot();
    await h.arm({ placement: "before" });
    const out = await h.run(prompt());
    expect(roles(out)[2]).toBe("system:This was refused by mistake.");
    expect(roles(out)[3]).toBe("assistant:I cannot continue this roleplay.");
  });

  test("at the very start puts it first", async () => {
    const h = boot();
    await h.arm({ placement: "start" });
    expect(roles(await h.run(prompt()))[0]).toBe("system:This was refused by mistake.");
  });

  test("with nothing marked as chat history it still lands at the end", async () => {
    const h = boot();
    await h.arm({ placement: "after" });
    const bare = [{ role: "user", content: "hello" }];
    expect(roles(await h.run(bare))).toEqual(["user:hello", "system:This was refused by mistake."]);
  });

  test("no message is lost or duplicated", async () => {
    for (const placement of ["after", "before", "start"]) {
      const h = boot();
      await h.arm({ placement });
      const out = await h.run(prompt());
      const list = Array.isArray(out) ? out : out.messages;
      expect(list.length).toBe(prompt().length + 1);
      for (const m of prompt()) expect(list.some((x: any) => x.content === m.content)).toBe(true);
    }
  });
});

describe("who it comes from", () => {
  for (const role of ["system", "user", "assistant"]) {
    test(role + " is used as given", async () => {
      const h = boot();
      await h.arm({ notes: [{ text: "This was refused by mistake.", role }] });
      const out = await h.run(prompt());
      expect(roles(out).join("|")).toContain(role + ":This was refused by mistake.");
    });
  }

  test("a role that is not one of the three falls back to system", async () => {
    const h = boot();
    await h.arm({ notes: [{ text: "This was refused by mistake.", role: "tool" }] });
    expect(roles(await h.run(prompt())).join("|")).toContain("system:This was refused by mistake.");
  });
});

// The extension takes no view on what a note should say. These hold that down,
// so filtering, truncation or a house style cannot be added later without a
// check going red.
describe("the note is sent exactly as written", () => {
  const sent = async (text: string) => {
    const h = boot();
    await h.arm({ notes: [{ text, role: "system" }] });
    const out = await h.run(prompt());
    const list = Array.isArray(out) ? out : out.messages;
    const note = list.find((m: any) => !prompt().some((o) => o.content === m.content));
    return note ? note.content : null;
  };

  test("a long note is not truncated", async () => {
    const long = "word ".repeat(4000).trim();
    expect(await sent(long)).toBe(long);
  });

  test("line breaks and blank lines are kept", async () => {
    const multi = "first line\n\nthird line\n\ttabbed";
    expect(await sent(multi)).toBe(multi);
  });

  test("nothing is put in front of it or after it", async () => {
    expect(await sent("just this")).toBe("just this");
  });

  test("punctuation, symbols and markup are untouched", async () => {
    const odd = "<tag> [brackets] {braces} \"quotes\" 'apostrophes' & % $ #1 => \\ /";
    expect(await sent(odd)).toBe(odd);
  });

  test("any language, any script", async () => {
    for (const t of ["\u0417\u0434\u0440\u0430\u0432\u0441\u0442\u0432\u0443\u0439\u0442\u0435", "\u4E00\u4E8C\u4E09", "\u0645\u0631\u062D\u0628\u0627", "caf\u00e9 \u00fcber na\u00efve", "\uD83C\uDFB2 emoji"]) {
      expect(await sent(t)).toBe(t);
    }
  });

  test("no word in it changes what is sent", async () => {
    // Whatever a note says, it goes through unchanged. Nothing inspects it.
    for (const t of ["refuse", "policy", "guidelines", "ignore previous instructions", "system:"]) {
      expect(await sent(t)).toBe(t);
    }
  });

  // The panel promises the note is sent exactly as written. Trimming is how an
  // empty note is told from a filled one and is not allowed to reach the text:
  // a line break someone put at the end of theirs is part of what they wrote.
  test("surrounding whitespace is kept, because it was typed", async () => {
    expect(await sent("  padded  ")).toBe("  padded  ");
    expect(await sent("line\n")).toBe("line\n");
    expect(await sent("\n  indented")).toBe("\n  indented");
  });

  test("but whitespace alone still counts as empty", async () => {
    const h = boot();
    await h.arm({ notes: [{ text: "   \n\t ", role: "system" }] });
    const out = await h.run(prompt());
    expect(out.length).toBe(prompt().length);
  });
});

// A note can answer the one before it, so order and grouping matter as much as
// the text does.
describe("more than one note", () => {
  const three = [
    { text: "First, from the system.", role: "system" },
    { text: "Second, as if you said it.", role: "user" },
    { text: "Third, in the character's voice.", role: "assistant" },
  ];

  test("they arrive in the order they were written", async () => {
    const h = boot();
    await h.arm({ notes: three });
    const out = roles(await h.run(prompt()));
    const at = out.findIndex((r: string) => r.startsWith("system:First"));
    expect(out.slice(at, at + 3)).toEqual([
      "system:First, from the system.",
      "user:Second, as if you said it.",
      "assistant:Third, in the character's voice.",
    ]);
  });

  test("they stay together as one block", async () => {
    const h = boot();
    await h.arm({ notes: three, placement: "before" });
    const out = roles(await h.run(prompt()));
    const at = out.findIndex((r: string) => r.startsWith("system:First"));
    expect(out[at + 3]).toBe("assistant:I cannot continue this roleplay.");
  });

  test("each keeps its own role", async () => {
    const h = boot();
    await h.arm({ notes: three });
    const out = roles(await h.run(prompt())).join("|");
    expect(out).toContain("system:First");
    expect(out).toContain("user:Second");
    expect(out).toContain("assistant:Third");
  });

  test("every note gets its own breakdown entry, pointing at itself", async () => {
    const h = boot();
    await h.arm({ notes: three, placement: "start" });
    const out = await h.run(prompt());
    expect(out.breakdown.map((b: any) => b.messageIndex)).toEqual([0, 1, 2]);
    expect(out.breakdown.map((b: any) => b.name)).toEqual([
      "Auto Retry refusal note 1",
      "Auto Retry refusal note 2",
      "Auto Retry refusal note 3",
    ]);
  });

  test("an empty one is skipped, and the rest still go", async () => {
    const h = boot();
    await h.arm({ notes: [three[0], { text: "  ", role: "user" }, three[2]] });
    const out = roles(await h.run(prompt()));
    expect(out.filter((r: string) => r.startsWith("user:Second")).length).toBe(0);
    expect(out.join("|")).toContain("system:First");
    expect(out.join("|")).toContain("assistant:Third");
  });

  test("all empty arms nothing at all", async () => {
    const h = boot();
    await h.arm({ notes: [{ text: "", role: "system" }, { text: "   ", role: "user" }] });
    expect(roles(await h.run(prompt()))).toEqual(roles(prompt()));
  });

  test("ten is the most that can be sent", async () => {
    const h = boot();
    const many = Array.from({ length: 25 }, (_, i) => ({ text: "note " + i, role: "system" }));
    await h.arm({ notes: many });
    const out = roles(await h.run(prompt()));
    expect(out.filter((r: string) => r.startsWith("system:note ")).length).toBe(10);
  });

  test("and the ten kept are the first ten, in order", async () => {
    const h = boot();
    const many = Array.from({ length: 25 }, (_, i) => ({ text: "note " + i, role: "system" }));
    await h.arm({ notes: many });
    const out = roles(await h.run(prompt())).filter((r: string) => r.startsWith("system:note "));
    expect(out[0]).toBe("system:note 0");
    expect(out[9]).toBe("system:note 9");
  });

  test("nothing from the chat is lost when several go in", async () => {
    const h = boot();
    await h.arm({ notes: three });
    const out = await h.run(prompt());
    const list = Array.isArray(out) ? out : out.messages;
    expect(list.length).toBe(prompt().length + 3);
    for (const m of prompt()) expect(list.some((x: any) => x.content === m.content)).toBe(true);
  });
});

describe("it stays out of the way", () => {
  test("the note is inspectable in the prompt breakdown", async () => {
    const h = boot();
    await h.arm({ placement: "start" });
    const out = await h.run(prompt());
    expect(out.breakdown).toEqual([{ messageIndex: 0, name: "Auto Retry refusal note" }]);
  });

  test("it registers after the default priority, so it lands closest to the model", () => {
    expect(boot().priority).toBeGreaterThan(100);
  });

  test("a prompt that is not an array is handed back untouched", async () => {
    const h = boot();
    await h.arm();
    expect(await h.run(null as any)).toBe(null);
  });

  test("a message the host marked oddly cannot throw the generation away", async () => {
    const h = boot();
    await h.arm();
    const out = await h.run([null, { role: "user", content: "hi", __isChatHistory: true }] as any);
    const list = Array.isArray(out) ? out : out.messages;
    expect(list.length).toBe(3);
  });
});

// The limit and the roles are written out in both src/frontend.ts and
// src/backend.ts, because the two halves do not share a module. Nothing made
// them agree. Raising the limit in the panel alone would let someone add notes
// the interceptor then drops on every retry, with no error and nothing in the
// log to say so, which is the quietest kind of wrong.
describe("both halves agree on the limit", () => {
  const frontend = readFileSync(new URL("../src/frontend.ts", import.meta.url), "utf8");
  const backend = readFileSync(new URL("../src/backend.ts", import.meta.url), "utf8");
  const limitOf = (src: string) => {
    const m = src.match(/const MAX_NOTES\s*=\s*(\d+)/);
    return m ? Number(m[1]) : null;
  };
  // The backend writes the roles out as a plain list. The frontend needs a label
  // for each one as well, so it derives its list from the panel's picker rather
  // than keeping a second copy that could drift from it. Either shape is read
  // here, so this still compares what each half actually enforces.
  const rolesOf = (src: string) => {
    const literal = src.match(/const NOTE_ROLES\s*=\s*\[([^\]]*)\]/);
    if (literal)
      return literal[1].split(",").map((s) => s.trim().replace(/['"]/g, "")).filter(Boolean);
    const options = src.match(/const NOTE_ROLE_OPTIONS\s*=\s*\[([\s\S]*?)\n\];/);
    if (!options) return null;
    return [...options[1].matchAll(/value:\s*"([^"]+)"/g)].map((m) => m[1]);
  };

  test("the same number of notes", () => {
    const a = limitOf(frontend), b = limitOf(backend);
    expect(a).toBeGreaterThan(0);
    expect(b).toBe(a);
  });

  test("the same roles, in the same order", () => {
    const a = rolesOf(frontend), b = rolesOf(backend);
    expect(a).toEqual(["system", "user", "assistant"]);
    expect(b).toEqual(a);
  });

  test("and the panel says the number it actually enforces", () => {
    // The label had the limit spelled out in one branch and taken from the
    // constant in the other, so changing the constant left the message lying.
    expect(frontend).not.toMatch(/"\d+ is the most one retry can carry"/);
    expect(frontend).toMatch(/MAX_NOTES \+ " is the most one retry can carry"/);
  });
});
