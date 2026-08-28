// The settle gate, driven for real.
//
// "Wait for another extension to finish editing" holds a swap back for up to
// five minutes. Everything about it happens on a timer in the backend, so
// reading the source proves nothing: these load the built backend against a
// stub host and watch what it actually writes, and when.
//
// The question they exist for: someone who does not want to wait presses a
// swap button, and the wait has to end there. Two swaps landing minutes apart
// off one reply is the failure, and the second one arrives long after anything
// on screen could explain it.
import { expect, test, describe } from "bun:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SRC = readFileSync(new URL("../dist/backend.js", import.meta.url), "utf8");

interface Msg {
  id: string;
  role: string;
  content: string;
}

// The wait, in seconds, that these run with. The panel's own floor, so nothing
// here depends on a value the backend would clamp.
const WAIT_SECS = 1;
const WAIT_MS = WAIT_SECS * 1000;

const BASE = {
  enabled: true,
  replaceEnabled: true,
  replaceRules: "lantern => lamp",
  swapWaitForEdits: true,
  swapWaitSecs: WAIT_SECS,
  confirmBeforeEdit: false,
  allowReSwap: false,
};

function host(messages: Msg[], opts: { unreadable?: boolean } = {}) {
  const handlers: Record<string, Array<(p: any) => any>> = {};
  let frontHandler: any = null;
  const sent: any[] = [];
  const writes: Array<{ id: string; at: number; content: string }> = [];
  const msgs = messages.map((m) => ({ ...m }));
  const t0 = Date.now();

  const spindle = {
    on: (name: string, fn: any) => {
      (handlers[name] = handlers[name] || []).push(fn);
    },
    onFrontendMessage: (fn: any) => {
      frontHandler = fn;
    },
    sendToFrontend: (msg: any) => sent.push(msg),
    log: { info: () => {}, warn: () => {}, error: () => {} },
    chat: {
      getMessages: async () => {
        // A host that will not hand the chat back, which is the path where a
        // wait used to survive a button press.
        if (opts.unreadable) throw new Error("no chat permission");
        return msgs.map((m) => ({ ...m }));
      },
      updateMessage: async (chatId: string, id: string, patch: any) => {
        const m = msgs.find((x) => x.id === id);
        if (!m) return;
        Object.assign(m, patch);
        writes.push({ id: id, at: Date.now() - t0, content: patch.content });
        // The host raises an edit for every save, including the backend's own.
        for (const fn of handlers.MESSAGE_EDITED || [])
          fn({ chatId: chatId, message: { id: id, content: patch.content } });
      },
    },
    storage: { read: async () => null, write: async () => {} },
    userStorage: { read: async () => null, write: async () => {} },
    interceptors: { register: () => {} },
    permissions: { has: () => true },
  };

  vm.runInContext(
    SRC,
    vm.createContext({
      spindle,
      console,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      Date,
      JSON,
      Math,
      Number,
      String,
      Array,
      Object,
      Promise,
      Map,
      Set,
      RegExp,
      Error,
      isNaN,
      parseInt,
      parseFloat,
    }),
  );

  return {
    sent,
    writes,
    body: (id: string) => (msgs.find((m) => m.id === id) || ({} as any)).content,
    front: (p: any) => frontHandler(p, "u1"),
    // A save by something that is not this extension, which is the whole
    // reason the wait exists.
    foreignEdit: (chatId: string, id: string, content: string) => {
      const m = msgs.find((x) => x.id === id);
      if (m) m.content = content;
      for (const fn of handlers.MESSAGE_EDITED || [])
        fn({ chatId: chatId, message: { id: id, content: content } });
    },
    ended: async (p: any) => {
      for (const fn of handlers.GENERATION_ENDED || []) await fn(p);
    },
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const chat = (): Msg[] => [
  // The opening message is authored, so it is never swapped.
  { id: "m0", role: "assistant", content: "Welcome to the crossing." },
  { id: "m1", role: "user", content: "who is there" },
  { id: "m2", role: "assistant", content: "Marisol set the lantern down." },
];

async function armed(messages = chat(), opts = {}) {
  const h = host(messages, opts);
  await h.front({ type: "save_settings", settings: BASE });
  return h;
}

describe("the wait for another extension", () => {
  test("left alone, the swap lands when the wait runs out", async () => {
    const h = await armed();
    await h.ended({ chatId: "c1", messageId: "m2" });
    expect(h.body("m2")).toBe("Marisol set the lantern down.");
    await wait(WAIT_MS + 500);
    expect(h.body("m2")).toBe("Marisol set the lamp down.");
    expect(h.writes.length).toBe(1);
  });

  test("pressing a swap button swaps at once, not when the wait ends", async () => {
    const h = await armed();
    await h.ended({ chatId: "c1", messageId: "m2" });
    await wait(150);
    await h.front({ type: "apply_replace_now", chatId: "c1", messageId: "m2", requestId: "r" });
    expect(h.body("m2")).toBe("Marisol set the lamp down.");
    // And nothing lands a second time once the wait would have been up.
    await wait(WAIT_MS + 500);
    expect(h.writes.length).toBe(1);
    expect(h.writes[0].at).toBeLessThan(WAIT_MS);
  });

  test("it says how many waits it ended", async () => {
    const h = await armed();
    await h.ended({ chatId: "c1", messageId: "m2" });
    await h.front({ type: "apply_replace_now", chatId: "c1", messageId: "m2", requestId: "r" });
    const done = h.sent.find((m) => m.type === "replace_now_result");
    expect(done.waitsEnded).toBe(1);
  });

  test("with nothing waiting it says so rather than nothing", async () => {
    const h = await armed();
    await h.front({ type: "apply_replace_now", chatId: "c1", messageId: "m2", requestId: "r" });
    const done = h.sent.find((m) => m.type === "replace_now_result");
    expect(done.waitsEnded).toBe(0);
  });

  test("every reply in the chat stops waiting, not only the one swapped", async () => {
    // Two replies came in while the reader was reading, so two are on a timer.
    // Swap now names the newest, and the older one used to keep its timer and
    // land on its own once the wait was up.
    const two = chat().concat([
      { id: "m3", role: "user", content: "and then" },
      { id: "m4", role: "assistant", content: "She lit the lantern again." },
    ]);
    const h = await armed(two);
    await h.ended({ chatId: "c1", messageId: "m2" });
    await h.ended({ chatId: "c1", messageId: "m4" });
    await wait(150);
    await h.front({ type: "apply_replace_now", chatId: "c1", messageId: "m4", requestId: "r" });
    const done = h.sent.find((m) => m.type === "replace_now_result");
    expect(done.waitsEnded).toBe(2);
    expect(h.body("m4")).toBe("She lit the lamp again.");
    await wait(WAIT_MS + 500);
    // The older reply is left as it was, rather than being rewritten a second
    // later by a timer nobody could see.
    expect(h.body("m2")).toBe("Marisol set the lantern down.");
    expect(h.writes.length).toBe(1);
  });

  test("a chat that cannot be read still stops waiting", async () => {
    const h = await armed(chat(), { unreadable: true });
    // The end event cannot resolve a message id from an unreadable chat, so
    // this arms the wait with the id the host supplied.
    await h.ended({ chatId: "c1", messageId: "m2" });
    await wait(150);
    await h.front({ type: "apply_replace_now", chatId: "c1", messageId: "m2", requestId: "r" });
    const done = h.sent.find((m) => m.type === "replace_now_result");
    expect(done.waitsEnded).toBe(1);
    expect(done.ok).toBe(false);
  });

  test("a swap button in one chat leaves another chat's wait alone", async () => {
    const h = await armed();
    await h.ended({ chatId: "c1", messageId: "m2" });
    await wait(150);
    await h.front({ type: "apply_replace_now", chatId: "c2", messageId: "m9", requestId: "r" });
    const done = h.sent.find((m) => m.type === "replace_now_result");
    expect(done.waitsEnded).toBe(0);
    // The first chat's wait was never anybody else's to cancel.
    await wait(WAIT_MS + 500);
    expect(h.body("m2")).toBe("Marisol set the lamp down.");
  });

  test("another extension writing after a hand swap still gets answered", async () => {
    // Ending the wait is not the same as giving up on the reply. The rewrite
    // this feature exists for can still arrive late, and the swap goes back on
    // top of it.
    const h = await armed();
    await h.ended({ chatId: "c1", messageId: "m2" });
    await wait(150);
    await h.front({ type: "apply_replace_now", chatId: "c1", messageId: "m2", requestId: "r" });
    expect(h.body("m2")).toBe("Marisol set the lamp down.");
    h.foreignEdit("c1", "m2", "Marisol set the lantern down on the step.");
    await wait(2200);
    expect(h.body("m2")).toBe("Marisol set the lamp down on the step.");
  });
});
