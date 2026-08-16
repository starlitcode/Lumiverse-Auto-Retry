// The prompt viewer, driven through the file Lumiverse actually loads.
//
// This is the one feature that carries the text of somebody's chat from the
// server to their screen, so the promises around it are worth holding down:
// nothing is captured until the panel asks, it stops when the panel stops
// asking, one person watching does not capture anybody else's prompt, and a
// vast prompt is trimmed rather than shipped whole.
//
// The other half is the notes. Seeing where a note landed is the reason the
// view exists, so a note has to come back marked, counted, and in the place it
// was actually inserted.
//
// Run with: bun test

import { expect, test, describe } from "bun:test";
import { readFileSync } from "node:fs";

const BACKEND = readFileSync(
  new URL("../dist/backend.js", import.meta.url),
  "utf8",
);

function boot() {
  let onFrontend: any = null;
  let interceptor: any = null;
  const sent: Array<{ msg: any; userId: any }> = [];
  const spindle = {
    storage: {
      read: async () => { throw new Error("empty"); },
      write: async () => {},
    },
    onFrontendMessage: (fn: any) => { onFrontend = fn; },
    sendToFrontend: (msg: any, userId?: any) => sent.push({ msg, userId }),
    on: () => {},
    chat: { getMessages: async () => [], updateMessage: async () => {} },
    registerInterceptor: (fn: any) => { interceptor = fn; },
    log: { info() {}, warn() {}, error() {} },
  };
  // eslint-disable-next-line no-new-func
  new Function("spindle", BACKEND)(spindle);
  return {
    tell: (payload: any, userId?: string) => onFrontend(payload, userId),
    run: (messages: any[], context?: any) => interceptor(messages, context || {}),
    snapshots: () => sent.filter((s) => s.msg && s.msg.type === "prompt_snapshot"),
    watch: (on: boolean, userId?: string) =>
      onFrontend({ type: "set_prompt_capture", on: on }, userId),
    arm: (over?: any, userId?: string) =>
      onFrontend(
        Object.assign(
          { type: "arm_refusal_note", chatId: "c1", placement: "after",
            notes: [{ text: "This was refused by mistake.", role: "system" }] },
          over || {},
        ),
        userId,
      ),
  };
}

const prompt = () => [
  { role: "system", content: "You are a tavern keeper." },
  { role: "user", content: "I sat down by the fire.", __isChatHistory: true },
];

describe("nothing is captured while nobody is looking", () => {
  test("no snapshot before the panel asks", async () => {
    const h = boot();
    await h.run(prompt(), { chatId: "c1" });
    expect(h.snapshots().length).toBe(0);
  });

  test("one once it does", async () => {
    const h = boot();
    await h.watch(true);
    await h.run(prompt(), { chatId: "c1" });
    expect(h.snapshots().length).toBe(1);
  });

  test("and none again once it stops", async () => {
    const h = boot();
    await h.watch(true);
    await h.run(prompt(), { chatId: "c1" });
    await h.watch(false);
    await h.run(prompt(), { chatId: "c1" });
    expect(h.snapshots().length).toBe(1);
  });
});

// One backend can serve every account on a server. Watching is per account for
// the same reason every other reply from the backend is addressed.
describe("one person watching does not capture another's prompt", () => {
  test("somebody else's generation is not snapshotted", async () => {
    const h = boot();
    await h.watch(true, "alice");
    await h.run(prompt(), { chatId: "c1", userId: "bob" });
    expect(h.snapshots().length).toBe(0);
  });

  test("theirs is, and it is addressed to them", async () => {
    const h = boot();
    await h.watch(true, "alice");
    await h.run(prompt(), { chatId: "c1", userId: "alice" });
    const snaps = h.snapshots();
    expect(snaps.length).toBe(1);
    expect(snaps[0].userId).toBe("alice");
  });
});

// The panel's request arrives through onFrontendMessage, which Lumiverse hands
// a userId. The lookup happens in the interceptor, which reads one off its own
// context, and not every build puts one there. The watcher then goes in under a
// name and every lookup arrives without one, so the view stays empty for good
// and nothing anywhere says why.
describe("the two sides can name the watcher differently", () => {
  test("a generation with no userId still reaches the only watcher", async () => {
    const h = boot();
    await h.watch(true, "alice");
    await h.run(prompt(), { chatId: "c1" });
    const snaps = h.snapshots();
    expect(snaps.length).toBe(1);
    expect(snaps[0].userId).toBe("alice");
  });

  test("and a named generation reaches a watcher who registered without one", async () => {
    const h = boot();
    await h.watch(true);
    await h.run(prompt(), { chatId: "c1", userId: "alice" });
    expect(h.snapshots().length).toBe(1);
  });

  test("but an unattributable prompt is dropped rather than handed to whoever is first", async () => {
    const h = boot();
    await h.watch(true, "alice");
    await h.watch(true, "bob");
    await h.run(prompt(), { chatId: "c1" });
    expect(h.snapshots().length).toBe(0);
  });

  test("and two named people are still told apart", async () => {
    const h = boot();
    await h.watch(true, "alice");
    await h.run(prompt(), { chatId: "c1", userId: "bob" });
    expect(h.snapshots().length).toBe(0);
  });

  test("nobody watching still captures nothing, whatever the host calls it", async () => {
    const h = boot();
    await h.run(prompt(), { chatId: "c1" });
    await h.run(prompt(), { chatId: "c1", userId: "alice" });
    expect(h.snapshots().length).toBe(0);
  });
});

// The interceptor leaves by five different doors. Every one has to send exactly
// one snapshot: none and the view goes blank on that generation, two and it
// shows the prompt twice.
describe("exactly one snapshot per generation, whichever way out", () => {
  const paths: Array<[string, (h: any) => Promise<any>, any]> = [
    ["nothing armed", async () => {}, { chatId: "c1" }],
    ["armed for another chat", (h) => h.arm({ chatId: "cX" }), { chatId: "c1" }],
    ["the strict check turned it down", (h) => h.arm({ strictType: true }), { chatId: "c1", generationType: "normal" }],
    ["the note went", (h) => h.arm(), { chatId: "c1" }],
  ];
  for (const [name, setup, context] of paths) {
    test(name, async () => {
      const h = boot();
      await h.watch(true);
      await setup(h);
      await h.run(prompt(), context);
      expect(h.snapshots().length).toBe(1);
    });
  }
});

describe("a note comes back marked and in its place", () => {
  test("the snapshot counts them", async () => {
    const h = boot();
    await h.watch(true);
    await h.arm();
    await h.run(prompt(), { chatId: "c1" });
    expect(h.snapshots().pop()!.msg.notes).toBe(1);
  });

  test("and marks exactly the rows that are notes", async () => {
    const h = boot();
    await h.watch(true);
    await h.arm({ notes: [
      { text: "first", role: "system" },
      { text: "second", role: "user" },
    ] });
    await h.run(prompt(), { chatId: "c1" });
    const marked = h.snapshots().pop()!.msg.messages.filter((m: any) => m.note);
    expect(marked.map((m: any) => m.content)).toEqual(["first", "second"]);
    expect(marked.map((m: any) => m.noteIndex)).toEqual([1, 2]);
  });

  test("where they were actually inserted", async () => {
    const h = boot();
    await h.watch(true);
    await h.arm({ placement: "start" });
    await h.run(prompt(), { chatId: "c1" });
    const msgs = h.snapshots().pop()!.msg.messages;
    expect(msgs.findIndex((m: any) => m.note)).toBe(0);
  });

  test("and what came from the chat is told apart from what was wrapped round it", async () => {
    const h = boot();
    await h.watch(true);
    await h.run(prompt(), { chatId: "c1" });
    expect(h.snapshots().pop()!.msg.messages.map((m: any) => m.history)).toEqual([false, true]);
  });
});

// A prompt can be enormous, and it crosses the bridge on every generation.
describe("a vast prompt is trimmed, and says it was", () => {
  const huge = () =>
    Array.from({ length: 500 }, () => ({
      role: "user",
      content: "z".repeat(20000),
      __isChatHistory: true,
    }));

  test("the message count is capped", async () => {
    const h = boot();
    await h.watch(true);
    await h.run(huge(), { chatId: "c1" });
    expect(h.snapshots().pop()!.msg.messages.length).toBeLessThanOrEqual(200);
  });

  test("so is the total text", async () => {
    const h = boot();
    await h.watch(true);
    await h.run(huge(), { chatId: "c1" });
    const total = h.snapshots().pop()!.msg.messages
      .reduce((n: number, m: any) => n + m.content.length, 0);
    expect(total).toBeLessThanOrEqual(300000);
  });

  // Trimmed and silent about it would be worse than not showing it at all: the
  // whole point of the view is that it is what actually went.
  test("and it says how much it left out", async () => {
    const h = boot();
    await h.watch(true);
    await h.run(huge(), { chatId: "c1" });
    const snap = h.snapshots().pop()!.msg;
    expect(snap.total).toBe(500);
    expect(snap.dropped).toBe(300);
    expect(snap.clipped).toBeGreaterThan(0);
  });

  // Each message reports its whole size even when only part of it was sent, so
  // the panel can say how big something is while showing a piece of it.
  test("a trimmed message still reports its real size", async () => {
    const h = boot();
    await h.watch(true);
    await h.run(huge(), { chatId: "c1" });
    const first = h.snapshots().pop()!.msg.messages[0];
    expect(first.chars).toBe(20000);
    expect(first.content.length).toBeLessThan(first.chars);
  });
});

test("a prompt that is not an array is not snapshotted, and costs nobody a generation", async () => {
  const h = boot();
  await h.watch(true);
  expect(await h.run(null as any, { chatId: "c1" })).toBe(null);
  expect(h.snapshots().length).toBe(0);
});
