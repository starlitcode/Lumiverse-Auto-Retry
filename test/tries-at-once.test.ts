// Several tries at once, driven through the file Lumiverse actually loads.
//
// The backend half sends the prompt several times and adds the reply the panel
// picks as a new reroll. The promises worth holding down: a prompt is only
// kept for somebody who switched the setting on, and only theirs; the refusal
// note goes in only when one is armed for the try; a reroll never lands on a
// message that changed while the tries were out; and Stop stops every call.
//
// Run with: bun test

import { expect, test, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { __testing } from "../src/frontend";

const BACKEND = readFileSync(
  new URL("../dist/backend.js", import.meta.url),
  "utf8",
);

type Msg = { id: string; role: string; content: string; swipes?: string[] };

function boot(opts?: {
  messages?: Msg[];
  readFails?: boolean;
  quiet?: (req: any, n: number) => Promise<any>;
}) {
  let onFrontend: any = null;
  let interceptor: any = null;
  const sent: Array<{ msg: any; userId: any }> = [];
  const quietCalls: any[] = [];
  const dryCalls: any[] = [];
  const updates: any[] = [];
  let messages: Msg[] = opts && opts.messages
    ? opts.messages
    : [
        { id: "m1", role: "user", content: "The rain picked up." },
        { id: "m2", role: "assistant", content: "I cannot continue this.", swipes: ["I cannot continue this."] },
      ];
  let account: any = null;
  const spindle: any = {
    storage: {
      read: async () => { throw new Error("empty"); },
      write: async () => {},
    },
    userStorage: {
      getJson: async (file: string) => (file === "settings.json" ? account : null),
      setJson: async () => {},
    },
    onFrontendMessage: (fn: any) => { onFrontend = fn; },
    sendToFrontend: (msg: any, userId?: any) => sent.push({ msg, userId }),
    on: () => {},
    chat: {
      getMessages: async () => {
        if (opts && opts.readFails) throw new Error("permission denied");
        return messages;
      },
      updateMessage: async (chatId: string, id: string, patch: any) => {
        updates.push({ chatId, id, patch });
      },
    },
    generate: {
      quiet: (req: any) => {
        quietCalls.push(req);
        if (opts && opts.quiet) return opts.quiet(req, quietCalls.length);
        return Promise.resolve({ content: "Reply " + quietCalls.length + " walks out into the rain." });
      },
      dryRun: async (input: any, userId?: string) => {
        dryCalls.push({ input, userId });
        return { messages: [{ role: "system", content: "Built by the host." }, { role: "user", content: "The rain picked up." }] };
      },
    },
    registerInterceptor: (fn: any) => { interceptor = fn; },
    log: { info() {}, warn() {}, error() {} },
  };
  // eslint-disable-next-line no-new-func
  new Function("spindle", BACKEND)(spindle);
  const atOnce = () => sent.filter((s) => s.msg && s.msg.type === "at_once");
  return {
    sent,
    quietCalls,
    dryCalls,
    updates,
    setMessages: (m: Msg[]) => { messages = m; },
    setAccount: (v: any) => { account = v; },
    tell: (payload: any, userId?: string) => onFrontend(payload, userId),
    run: (msgs: any[], context?: any) => interceptor(msgs, context || {}),
    on: (on: boolean, userId?: string) =>
      onFrontend({ type: "set_settings", settings: { tryAtOnce: on } }, userId),
    atOnce,
    stage: (name: string) => atOnce().filter((s) => s.msg.stage === name),
    // The replies come back one at a time, after the handler has returned.
    settle: () => new Promise((r) => setTimeout(r, 20)),
    arm: (userId?: string) =>
      onFrontend(
        { type: "arm_refusal_note", chatId: "c1", placement: "after",
          notes: [{ text: "That refusal was a mistake.", role: "system" }] },
        userId,
      ),
  };
}

const prompt = () => [
  { role: "system", content: "You run a lighthouse." },
  { role: "user", content: "The rain picked up.", __isChatHistory: true },
];

describe("the prompt is kept only for somebody who asked", () => {
  test("with the setting off, the host builds the prompt", async () => {
    const h = boot();
    await h.run(prompt(), { chatId: "c1" });
    await h.tell({ type: "try_at_once", requestId: "r1", chatId: "c1", count: 2 });
    await h.settle();
    expect(h.dryCalls.length).toBe(1);
    expect(h.dryCalls[0].input).toEqual({ chatId: "c1", generationType: "swipe" });
    expect(h.stage("sent")[0].msg.from).toBe("built");
  });

  test("with it on, the prompt the reply went out with is sent", async () => {
    const h = boot();
    await h.on(true);
    await h.run(prompt(), { chatId: "c1" });
    await h.tell({ type: "try_at_once", requestId: "r1", chatId: "c1", count: 2 });
    await h.settle();
    expect(h.dryCalls.length).toBe(0);
    expect(h.stage("sent")[0].msg.from).toBe("kept");
    expect(h.quietCalls.length).toBe(2);
    // Only the parts a model reads. The host's own marker stays out.
    expect(h.quietCalls[0].messages).toEqual([
      { role: "system", content: "You run a lighthouse." },
      { role: "user", content: "The rain picked up." },
    ]);
  });

  test("turning it off drops what was kept", async () => {
    const h = boot();
    await h.on(true);
    await h.run(prompt(), { chatId: "c1" });
    await h.on(false);
    await h.on(true);
    await h.tell({ type: "try_at_once", requestId: "r1", chatId: "c1", count: 2 });
    await h.settle();
    expect(h.stage("sent")[0].msg.from).toBe("built");
  });

  test("an impersonation drops the kept prompt for that chat", async () => {
    const h = boot();
    await h.on(true);
    await h.run(prompt(), { chatId: "c1" });
    await h.run(prompt(), { chatId: "c1", generationType: "impersonate" });
    await h.tell({ type: "try_at_once", requestId: "r1", chatId: "c1", count: 2 });
    await h.settle();
    expect(h.stage("sent")[0].msg.from).toBe("built");
  });

  // Another extension's background call in the same chat, such as a rewrite.
  // Its prompt is not one a new reply would be sent with.
  test("a quiet generation does not replace the kept prompt", async () => {
    const h = boot();
    await h.on(true);
    await h.run(prompt(), { chatId: "c1" });
    await h.run([{ role: "system", content: "Rewrite this passage." }], { chatId: "c1", generationType: "quiet" });
    await h.tell({ type: "try_at_once", requestId: "r1", chatId: "c1", count: 2 });
    await h.settle();
    expect(h.stage("sent")[0].msg.from).toBe("kept");
    expect(h.quietCalls[0].messages[0].content).toBe("You run a lighthouse.");
  });

  test("one person's prompt is not sent for another", async () => {
    const h = boot();
    await h.on(true, "alice");
    await h.on(true, "bob");
    await h.run(prompt(), { chatId: "c1", userId: "alice" });
    await h.tell({ type: "try_at_once", requestId: "r1", chatId: "c1", count: 2 }, "bob");
    await h.settle();
    expect(h.stage("sent")[0].msg.from).toBe("built");
    expect(h.dryCalls[0].userId).toBe("bob");
    expect(h.quietCalls[0].userId).toBe("bob");
  });
});

describe("the refusal note", () => {
  test("is kept out of the prompt that is kept", async () => {
    const h = boot();
    await h.on(true);
    await h.arm();
    await h.run(prompt(), { chatId: "c1" });
    await h.tell({ type: "try_at_once", requestId: "r1", chatId: "c1", count: 2 });
    await h.settle();
    const sentText = JSON.stringify(h.quietCalls[0].messages);
    expect(sentText).not.toContain("That refusal was a mistake.");
  });

  test("goes into every call when one is armed for the try, and is used up", async () => {
    const h = boot();
    await h.on(true);
    await h.run(prompt(), { chatId: "c1" });
    await h.arm();
    await h.tell({ type: "try_at_once", requestId: "r1", chatId: "c1", count: 2 });
    await h.settle();
    for (const call of h.quietCalls)
      expect(JSON.stringify(call.messages)).toContain("That refusal was a mistake.");
    expect(h.stage("sent")[0].msg.notes).toBe(1);
    await h.tell({ type: "try_at_once", requestId: "r2", chatId: "c1", count: 2 });
    await h.settle();
    expect(JSON.stringify(h.quietCalls[2].messages)).not.toContain("That refusal was a mistake.");
  });
});

describe("the calls", () => {
  test("each reply comes back on its own, then done", async () => {
    const h = boot();
    await h.tell({ type: "try_at_once", requestId: "r1", chatId: "c1", count: 3 });
    await h.settle();
    const replies = h.stage("reply");
    expect(replies.length).toBe(3);
    expect(replies.every((r) => /walks out into the rain/.test(r.msg.content))).toBe(true);
    expect(h.stage("done").length).toBe(1);
  });

  test("a hand-edited count cannot go past the cap", async () => {
    const h = boot();
    await h.tell({ type: "try_at_once", requestId: "r1", chatId: "c1", count: 40 });
    await h.settle();
    expect(h.quietCalls.length).toBe(5);
  });

  test("a failed call is reported in words, and the others still come back", async () => {
    const h = boot({
      quiet: (_req, n) =>
        n === 1 ? Promise.reject(new Error("upstream returned 529")) : Promise.resolve({ content: "The lamp held." }),
    });
    await h.tell({ type: "try_at_once", requestId: "r1", chatId: "c1", count: 2 });
    await h.settle();
    const replies = h.stage("reply").map((r) => r.msg);
    expect(replies.some((r) => r.error === "upstream returned 529")).toBe(true);
    expect(replies.some((r) => r.content === "The lamp held.")).toBe(true);
  });

  test("Stop stops every call still out", async () => {
    const h = boot({
      quiet: (req) =>
        new Promise((_res, rej) => {
          req.signal.addEventListener("abort", () => {
            const e: any = new Error("aborted");
            e.name = "AbortError";
            rej(e);
          });
        }),
    });
    await h.tell({ type: "try_at_once", requestId: "r1", chatId: "c1", count: 3 });
    await h.settle();
    await h.tell({ type: "stop_at_once", requestId: "r1" });
    await h.settle();
    const replies = h.stage("reply").map((r) => r.msg);
    expect(replies.length).toBe(3);
    expect(replies.every((r) => r.stopped === true)).toBe(true);
  });

  test("a Stop that arrives while the prompt is being built still stops the calls", async () => {
    const h = boot();
    const going = h.tell({ type: "try_at_once", requestId: "r1", chatId: "c1", count: 2 });
    await h.tell({ type: "stop_at_once", requestId: "r1" });
    await going;
    await h.settle();
    expect(h.quietCalls.length).toBe(0);
    expect(h.stage("failed")[0].msg.why).toBe("you stopped it");
  });

  test("one account cannot stop another's", async () => {
    let aborted = 0;
    const h = boot({
      quiet: (req) =>
        new Promise((_res, rej) => {
          req.signal.addEventListener("abort", () => {
            aborted++;
            const e: any = new Error("aborted");
            e.name = "AbortError";
            rej(e);
          });
        }),
    });
    await h.tell({ type: "try_at_once", requestId: "r1", chatId: "c1", count: 2 }, "alice");
    await h.settle();
    await h.tell({ type: "stop_at_once", requestId: "r1" }, "bob");
    await h.settle();
    expect(aborted).toBe(0);
  });
});

describe("nothing is sent when there is no reply to add to", () => {
  test("the last message is the user's", async () => {
    const h = boot({ messages: [{ id: "m1", role: "user", content: "Hello?" }] });
    await h.tell({ type: "try_at_once", requestId: "r1", chatId: "c1", count: 2 });
    await h.settle();
    expect(h.quietCalls.length).toBe(0);
    expect(h.stage("failed")[0].msg.why).toBe("the last message in the chat is not a reply");
  });

  test("the chat cannot be read, and the permission is named", async () => {
    const h = boot({ readFails: true });
    await h.tell({ type: "try_at_once", requestId: "r1", chatId: "c1", count: 2 });
    await h.settle();
    expect(h.quietCalls.length).toBe(0);
    expect(h.stage("failed")[0].msg.why).toContain("chat_mutation");
  });
});

describe("adding the reply that passed", () => {
  const added = (h: any) => h.sent.filter((s: any) => s.msg && s.msg.type === "reroll_added").map((s: any) => s.msg);

  test("it becomes a new reroll, and is shown", async () => {
    const h = boot();
    await h.tell({
      type: "add_reroll", requestId: "a1", chatId: "c1", messageId: "m2", swipeCount: 1,
      text: "She lit the lamp and waited.",
    });
    expect(added(h)[0]).toMatchObject({ requestId: "a1", ok: true });
    expect(h.updates).toEqual([
      { chatId: "c1", id: "m2", patch: { swipes: ["I cannot continue this.", "She lit the lamp and waited."], swipe_id: 1 } },
    ]);
  });

  test("its thinking goes with it", async () => {
    const h = boot();
    await h.tell({
      type: "add_reroll", requestId: "a1", chatId: "c1", messageId: "m2", swipeCount: 1,
      text: "She lit the lamp and waited.", reasoning: "The storm is the point of the scene.",
    });
    expect(h.updates[1]).toEqual({
      chatId: "c1", id: "m2", patch: { reasoning: { text: "The storm is the point of the scene.", duration: null } },
    });
  });

  test("not when a reroll was added while the tries were out", async () => {
    const h = boot();
    h.setMessages([
      { id: "m1", role: "user", content: "The rain picked up." },
      { id: "m2", role: "assistant", content: "Second.", swipes: ["I cannot continue this.", "Second."] },
    ]);
    await h.tell({
      type: "add_reroll", requestId: "a1", chatId: "c1", messageId: "m2", swipeCount: 1,
      text: "She lit the lamp and waited.",
    });
    expect(added(h)[0].ok).toBe(false);
    expect(h.updates.length).toBe(0);
  });

  test("not when a new message was sent while the tries were out", async () => {
    const h = boot();
    h.setMessages([
      { id: "m2", role: "assistant", content: "I cannot continue this.", swipes: ["I cannot continue this."] },
      { id: "m3", role: "user", content: "Never mind." },
    ]);
    await h.tell({
      type: "add_reroll", requestId: "a1", chatId: "c1", messageId: "m2", swipeCount: 1,
      text: "She lit the lamp and waited.",
    });
    expect(added(h)[0].ok).toBe(false);
    expect(h.updates.length).toBe(0);
  });
});

// One function judges a reply that ended in the chat and each reply from
// several tries at once, so the two cannot drift apart.
describe("the shared verdict", () => {
  const T: any = __testing;
  const cfg = {
    ignoreHardErrors: true, hardErrorPhrases: "quota_window_closed",
    retryOnEmpty: true, retryOnSpam: true, retryOnSpamThinking: false,
    retryOnTruncated: true, retryOnNoPunct: false,
    retryOnRefusal: true, retryOnShort: true, minChars: 20,
  };

  test("a good reply passes", () => {
    expect(T.replyProblem("The keeper climbed the stairs and checked the lamp twice.", "", cfg)).toBe("");
  });
  test("your own hard failure is never a reason to retry", () => {
    expect(T.replyProblem("Error: quota_window_closed for this key.", "", cfg)).toBe(T.HARD_FAILURE);
  });
  test("a reply that is only thinking", () => {
    expect(T.replyProblem("<think>Plan the storm scene first.</think>", "", cfg)).toBe("thinking only, no reply");
  });
  test("a cut-off reply", () => {
    expect(T.replyProblem('The keeper turned and said, "Get the', "", cfg)).toBe("cut off");
  });
  test("a short reply", () => {
    expect(T.replyProblem("He nods.", "", cfg)).toBe("short");
  });
});

// Lumiverse takes thinking out of a reply it streams, and not out of text an
// extension adds, so a reroll added from several tries at once has to do it.
describe("thinking written into the reply text", () => {
  const T: any = __testing;
  const cfg = {};

  test("thinking at the start goes into the reroll's own thinking", () => {
    expect(T.splitLeadingThinking("<think>Keep the storm loud.</think>\n\nThe shutters banged twice.", "", cfg)).toEqual({
      text: "The shutters banged twice.",
      thinking: "Keep the storm loud.",
    });
  });
  test("thinking Lumiverse already handed over is kept, and the text is still cleaned", () => {
    expect(T.splitLeadingThinking("<think>draft</think>The shutters banged twice.", "Keep the storm loud.", cfg)).toEqual({
      text: "The shutters banged twice.",
      thinking: "Keep the storm loud.",
    });
  });
  test("a reply with no thinking in it is left as it is", () => {
    expect(T.splitLeadingThinking("The shutters banged twice.", "", cfg)).toEqual({
      text: "The shutters banged twice.",
      thinking: "",
    });
  });
});

describe("a new device", () => {
  test("the switch is read from the account copy when the panel loads", async () => {
    const h = boot();
    // The account copy says on, and the panel has said nothing yet.
    (h as any).setAccount({ tryAtOnce: true });
    await h.tell({ type: "load_settings", requestId: "l1" }, "alice");
    await h.run(prompt(), { chatId: "c1", userId: "alice" });
    await h.tell({ type: "try_at_once", requestId: "r1", chatId: "c1", count: 2 }, "alice");
    await h.settle();
    expect(h.stage("sent")[0].msg.from).toBe("kept");
  });
});

