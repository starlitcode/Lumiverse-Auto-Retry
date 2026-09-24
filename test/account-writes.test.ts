// The order saves reach the account in, driven through the file Lumiverse loads.
//
// Two saves close together, written at once, can finish the older one last.
// That older copy is then the one every browser loads. Each account's saves
// are written one after another, in the order they were sent.
//
// Run with: bun test

import { expect, test, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const BACKEND = readFileSync(join(root, "dist", "backend.js"), "utf8");

// A store where the first write can be made slow, so a later write would
// finish first if nothing kept them in turn.
function boot() {
  let frontendHandler: any = null;
  const stored: Record<string, any> = {};
  const delays: number[] = [];
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
        const slow = delays.shift();
        if (slow) await new Promise((r) => setTimeout(r, slow));
        stored[String((o && o.userId) || "") + ":" + file] = value;
      },
    },
    onFrontendMessage: (fn: any) => {
      frontendHandler = fn;
    },
    sendToFrontend: () => {},
    on: () => {},
    chat: { getMessages: async () => [], updateMessage: async () => {} },
    registerInterceptor: () => {},
    log: { info() {}, warn() {}, error() {} },
  };
  new Function("spindle", BACKEND)(spindle);
  return {
    stored,
    slowFirst: (ms: number) => delays.push(ms, 0),
    ask: (payload: any) => frontendHandler(payload, "u1"),
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("saves reach the account in the order they were made", () => {
  test("an older settings save cannot finish after a newer one and stand", async () => {
    const h = boot();
    h.slowFirst(40);
    const older = h.ask({ type: "save_settings", settings: { maxRetries: 2 } });
    const newer = h.ask({ type: "save_settings", settings: { maxRetries: 5 } });
    await Promise.all([older, newer]);
    await wait(60);
    expect(h.stored["u1:settings.json"].maxRetries).toBe(5);
  });

  test("and the same holds for presets", async () => {
    const h = boot();
    h.slowFirst(40);
    const older = h.ask({ type: "save_presets", presets: { retry: [{ name: "Patient", at: 1 }] } });
    const newer = h.ask({ type: "save_presets", presets: { retry: [{ name: "Patient", at: 2 }] } });
    await Promise.all([older, newer]);
    await wait(60);
    expect(h.stored["u1:presets.json"].retry[0].at).toBe(2);
  });
});
