// The reply a retry replaced, kept by the backend so a reload can ask for it
// back. Driven through the file Lumiverse loads.
//
// Run with: bun test

import { expect, test, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const BACKEND = readFileSync(join(root, "dist", "backend.js"), "utf8");

// A fresh backend over a store that can be handed to the next one, as after an
// update or a restart.
function boot(stored: Record<string, any> = {}, connections: any[] = []) {
  let frontendHandler: any = null;
  const sent: Array<{ msg: any; userId: any }> = [];
  const spindle = {
    storage: {
      read: async () => {
        throw new Error("empty");
      },
      write: async () => {},
    },
    userStorage: {
      getJson: async (file: string, o: any) => {
        const k = String((o && o.userId) || "") + ":" + file;
        return k in stored ? stored[k] : null;
      },
      setJson: async (file: string, value: any, o: any) => {
        stored[String((o && o.userId) || "") + ":" + file] = value;
      },
    },
    onFrontendMessage: (fn: any) => {
      frontendHandler = fn;
    },
    sendToFrontend: (msg: any, userId: any) => {
      sent.push({ msg, userId });
    },
    on: () => {},
    chat: { getMessages: async () => [], updateMessage: async () => {} },
    registerInterceptor: () => {},
    connections: { list: async () => connections },
    log: { info() {}, warn() {}, error() {} },
  };
  new Function("spindle", BACKEND)(spindle);
  return {
    stored,
    ask: (payload: any, userId = "u1") => frontendHandler(payload, userId),
    sent,
    list: async (userId = "u1", save = false) => {
      await frontendHandler({ type: "list_replaced", requestId: "r", save }, userId);
      const got = sent.filter((s) => s.msg.type === "replaced_list" && s.userId === userId).pop();
      return got ? got.msg.items : null;
    },
  };
}

const item = (chatId: string, text: string, at: number) => ({ chatId, text, reason: "a refusal", at });

describe("the reply a retry replaced", () => {
  test("a reloaded page gets it back", async () => {
    const h = boot();
    await h.ask({ type: "keep_replaced", item: item("c1", "The ferry left without them.", 10), save: false });
    const list = await h.list();
    expect(list.length).toBe(1);
    expect(list[0].text).toBe("The ferry left without them.");
    expect(list[0].reason).toBe("a refusal");
  });

  test("another account gets nothing of it", async () => {
    const h = boot();
    await h.ask({ type: "keep_replaced", item: item("c1", "The ferry left without them.", 10), save: false });
    expect(await h.list("u2")).toEqual([]);
  });

  test("one per chat, for the last eight chats", async () => {
    const h = boot();
    for (let i = 0; i < 10; i++)
      await h.ask({ type: "keep_replaced", item: item("c" + i, "Reply " + i, i + 1), save: false });
    await h.ask({ type: "keep_replaced", item: item("c9", "Newer reply", 20), save: false });
    const list = await h.list();
    expect(list.length).toBe(8);
    expect(list.filter((r: any) => r.chatId === "c9").map((r: any) => r.text)).toEqual(["Newer reply"]);
    expect(list.some((r: any) => r.chatId === "c0" || r.chatId === "c1")).toBe(false);
  });

  test("Clear drops it, and turning it off drops all of them", async () => {
    const h = boot();
    await h.ask({ type: "keep_replaced", item: item("c1", "One", 1), save: false });
    await h.ask({ type: "keep_replaced", item: item("c2", "Two", 2), save: false });
    await h.ask({ type: "forget_replaced", chatId: "c1", save: false });
    expect((await h.list()).map((r: any) => r.chatId)).toEqual(["c2"]);
    await h.ask({ type: "forget_replaced", all: true, save: false });
    expect(await h.list()).toEqual([]);
  });

  test("with Keep it through an update off, nothing is written", async () => {
    const h = boot();
    await h.ask({ type: "keep_replaced", item: item("c1", "The ferry left without them.", 10), save: false });
    const saved = h.stored["u1:replaced.json"];
    expect(saved === undefined || (Array.isArray(saved) && saved.length === 0)).toBe(true);
  });

  test("with it on, it lasts through a restart, for its own account only", async () => {
    const h = boot();
    await h.ask({ type: "keep_replaced", item: item("c1", "The ferry left without them.", 10), save: true });
    expect(h.stored["u1:replaced.json"].length).toBe(1);
    const again = boot(h.stored);
    const list = await again.list("u1", true);
    expect(list.map((r: any) => r.text)).toEqual(["The ferry left without them."]);
    expect(await again.list("u2", true)).toEqual([]);
  });

  test("a retry before the list is asked for keeps what was saved before a restart", async () => {
    const stored: Record<string, any> = { "u1:replaced.json": [item("c7", "The lamp swung twice.", 5)] };
    const h = boot(stored);
    await h.ask({ type: "keep_replaced", item: item("c1", "The ferry left without them.", 10), save: true });
    expect(h.stored["u1:replaced.json"].map((r: any) => r.chatId)).toEqual(["c7", "c1"]);
  });

  test("turning it off empties the saved copy", async () => {
    const h = boot();
    await h.ask({ type: "keep_replaced", item: item("c1", "The ferry left without them.", 10), save: true });
    await h.ask({ type: "save_replaced", save: false });
    expect(h.stored["u1:replaced.json"]).toEqual([]);
    // Still there until the next restart.
    expect((await h.list()).length).toBe(1);
  });

  test("after a restart, the first message with it off empties a copy left from before", async () => {
    const stored: Record<string, any> = { "u1:replaced.json": [item("c7", "The lamp swung twice.", 5)] };
    const h = boot(stored);
    await h.ask({ type: "save_replaced", save: false });
    expect(h.stored["u1:replaced.json"]).toEqual([]);
  });
});

describe("the thinking markers saved on a connection", () => {
  const bound = (prefix: string, suffix: string) => ({
    id: "c1",
    reasoning_bindings: { settings: { prefix, suffix, autoParse: true } },
  });

  test("are sent to the panel as written, with line breaks trimmed", async () => {
    const h = boot({}, [bound("@@plan@@\n", "\n@@done@@"), { id: "c2", reasoning_bindings: null }]);
    await h.ask({ type: "get_think_marks" });
    const got = h.sent.filter((s) => s.msg.type === "think_marks").pop();
    expect(got.msg.pairs).toEqual([{ open: "@@plan@@", close: "@@done@@" }]);
    expect(got.userId).toBe("u1");
  });

  test("and one too short to be safe is left out", async () => {
    const h = boot({}, [bound("(", ")")]);
    await h.ask({ type: "get_think_marks" });
    expect(h.sent.filter((s) => s.msg.type === "think_marks").pop().msg.pairs).toEqual([]);
  });
});
