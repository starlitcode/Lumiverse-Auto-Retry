// Messages shown as Lumiverse's own notifications, driven through the file
// Lumiverse loads.
//
// Lumiverse takes notifications only from an extension's server side, so the
// panel sends its words to the backend, and the backend shows them. On a shared
// server a notification with no account named goes to everybody, so the
// account that asked is named.
//
// Run with: bun test

import { expect, test, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const BACKEND = readFileSync(join(root, "dist", "backend.js"), "utf8");

function boot() {
  let frontendHandler: any = null;
  const notes: Array<{ kind: string; text: string; opts: any }> = [];
  const note = (kind: string) => (text: string, opts?: any) => {
    notes.push({ kind: kind, text: text, opts: opts });
  };
  const spindle = {
    storage: {
      read: async () => {
        throw new Error("empty");
      },
      write: async () => {},
    },
    onFrontendMessage: (fn: any) => {
      frontendHandler = fn;
    },
    sendToFrontend: () => {},
    on: () => {},
    chat: { getMessages: async () => [], updateMessage: async () => {} },
    registerInterceptor: () => {},
    log: { info() {}, warn() {}, error() {} },
    toast: { success: note("success"), info: note("info"), warning: note("warning"), error: note("error") },
  };
  new Function("spindle", BACKEND)(spindle);
  return { notes, ask: (payload: any, who = "u1") => frontendHandler(payload, who) };
}

describe("notifications the panel asks for", () => {
  test("are shown as Lumiverse's own, in the colour asked for, to the account that asked", async () => {
    const h = boot();
    await h.ask({ type: "notify", kind: "warning", text: "Auto Retry gave up after 3 tries." }, "u7");
    expect(h.notes).toEqual([{ kind: "warning", text: "Auto Retry gave up after 3 tries.", opts: { userId: "u7" } }]);
  });

  test("an unknown colour is shown as information", async () => {
    const h = boot();
    await h.ask({ type: "notify", kind: "shout", text: "Auto Retry is on." });
    expect(h.notes.map((n) => n.kind)).toEqual(["info"]);
  });

  test("empty words show nothing", async () => {
    const h = boot();
    await h.ask({ type: "notify", kind: "success", text: "  " });
    expect(h.notes).toEqual([]);
  });
});
