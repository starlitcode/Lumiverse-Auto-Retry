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
          { type: "arm_refusal_note", chatId: "c1", text: "This was refused by mistake.", role: "system", placement: "after" },
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
    await h.arm({ text: "   " });
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
      await h.arm({ role });
      const out = await h.run(prompt());
      expect(roles(out).join("|")).toContain(role + ":This was refused by mistake.");
    });
  }

  test("a role that is not one of the three falls back to system", async () => {
    const h = boot();
    await h.arm({ role: "tool" });
    expect(roles(await h.run(prompt())).join("|")).toContain("system:This was refused by mistake.");
  });
});

// The extension takes no view on what a note should say. These hold that down,
// so filtering, truncation or a house style cannot be added later without a
// check going red.
describe("the note is sent exactly as written", () => {
  const sent = async (text: string) => {
    const h = boot();
    await h.arm({ text });
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

  test("only surrounding whitespace is trimmed, and only to tell empty from not", async () => {
    expect(await sent("  padded  ")).toBe("padded");
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
