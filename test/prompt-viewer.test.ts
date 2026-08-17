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
// The view used to be capped: 200 messages, 4000 characters each, 300000 in
// total, with the rest reported as missing. It was the one thing somebody
// reading this view could not work around, since what was cut only ever existed
// on the server and was thrown away as the snapshot was built. It now goes
// whole. A prompt is only captured while the Prompt tab is actually open, which
// is where the cost is kept.
describe("the whole prompt reaches the panel", () => {
  const huge = () =>
    Array.from({ length: 500 }, () => ({
      role: "user",
      content: "z".repeat(20000),
      __isChatHistory: true,
    }));

  test("every message is listed, however many there are", async () => {
    const h = boot();
    await h.watch(true);
    await h.run(huge(), { chatId: "c1" });
    const snap = h.snapshots().pop()!.msg;
    expect(snap.messages.length).toBe(500);
    expect(snap.total).toBe(500);
  });

  test("and every character of each one is there", async () => {
    const h = boot();
    await h.watch(true);
    await h.run(huge(), { chatId: "c1" });
    const msgs = h.snapshots().pop()!.msg.messages;
    expect(msgs[0].content).toBe("z".repeat(20000));
    expect(msgs[499].content).toBe("z".repeat(20000));
    expect(msgs.reduce((n: number, m: any) => n + m.content.length, 0)).toBe(10000000);
  });

  // Nothing is left out, so nothing counts what was left out. A field that is
  // always zero is one more thing to read and get wrong.
  test("and nothing is left saying what was trimmed", async () => {
    const h = boot();
    await h.watch(true);
    await h.run(huge(), { chatId: "c1" });
    const snap = h.snapshots().pop()!.msg;
    expect(snap.dropped).toBeUndefined();
    expect(snap.clipped).toBeUndefined();
    expect(snap.messages[0].chars).toBeUndefined();
  });
});

test("a prompt that is not an array is not snapshotted, and costs nobody a generation", async () => {
  const h = boot();
  await h.watch(true);
  expect(await h.run(null as any, { chatId: "c1" })).toBe(null);
  expect(h.snapshots().length).toBe(0);
});

// Capturing a prompt happens in the interceptor, so an interceptor that was
// never registered takes the whole Prompt tab with it, along with the refusal
// note. Registering it is fire-and-forget: without the permission the host does
// not throw, it silently does nothing and notifies instead. Registering once as
// the module loaded was a bet that the grant was already cached at that instant,
// and a grant can be given or taken away while the extension runs with nothing
// restarting. Losing that bet left both features dead for the life of the
// process with nothing anywhere saying so.
//
// Held as a shape check on the source because there is no way to observe it
// from a test: the failure is the host declining to call code that was never
// registered, which looks exactly like a quiet install.
describe("registering the interceptor", () => {
  const BACK = readFileSync(new URL("../src/backend.ts", import.meta.url), "utf8");
  test("goes through one guarded function rather than straight into module load", () => {
    const calls = [...BACK.matchAll(/spindle\.registerInterceptor\(/g)].length;
    expect(calls).toBe(1);
    expect(BACK).toContain("function tryRegisterInterceptor()");
    // The registration sits inside that function, not at the top level.
    const fn = BACK.slice(BACK.indexOf("function tryRegisterInterceptor()"));
    expect(fn.slice(0, fn.indexOf("\n}\n"))).toContain("spindle.registerInterceptor(");
  });

  test("checks the permission first, and does not register twice", () => {
    const fn = BACK.slice(BACK.indexOf("function tryRegisterInterceptor()"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body).toContain("has('interceptor')");
    expect(body).toContain("if (interceptorOn) return;");
  });

  test("and tries again when the permission is granted later", () => {
    expect(BACK).toContain("permissions.onChanged");
    expect(BACK).toMatch(/permission === 'interceptor' && e\.granted\) tryRegisterInterceptor\(\)/);
  });

  test("a refusal is reported, since nothing else would show it", () => {
    expect(BACK).toContain("permissions.onDenied");
  });
});

// What crosses the bridge, and nothing else. A field the other side never reads
// is one a reader has to work out the purpose of before deciding it has none,
// which is the same fault as a handler for a message nobody sends.
describe("the snapshot carries only what the panel reads", () => {
  test("role and content, and the two marks the panel draws", async () => {
    const h = boot();
    await h.watch(true);
    await h.run([{ role: "user", content: "hi", __isChatHistory: true }], { chatId: "c1" });
    const snap = h.snapshots().pop()!.msg;
    expect(Object.keys(snap).sort()).toEqual(["at", "messages", "notes", "total", "type"]);
    expect(Object.keys(snap.messages[0]).sort()).toEqual(
      ["content", "history", "note", "noteIndex", "role"],
    );
  });

  // The panel matches a token count to a prompt by when it was taken, so two
  // taken in the same millisecond must not share that.
  test("two prompts in a row never share an identity", async () => {
    const h = boot();
    await h.watch(true);
    const seen = new Set<number>();
    for (let i = 0; i < 50; i++) {
      await h.run([{ role: "user", content: "n" + i }], { chatId: "c1" });
      seen.add(h.snapshots().pop()!.msg.at);
    }
    expect(seen.size).toBe(50);
  });
});
