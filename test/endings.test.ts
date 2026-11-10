// How a reply ended, as the backend heard it, driven through the file
// Lumiverse loads.
//
// A tab can miss the event that ends a reply, and the panel then asks this
// side before it calls the reply stuck or stalled. The promises worth holding
// down: an error, a stop and a finished reply are each told apart; a reply
// this side never heard end is said to be not known; one account is not told
// about another's reply; and no reply text is kept.
//
// Run with: bun test

import { expect, test, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const BACKEND = readFileSync(join(import.meta.dir, "..", "dist", "backend.js"), "utf8");

function boot(opts?: { noEvents?: boolean }) {
  let frontendHandler: any = null;
  const events: Record<string, any> = {};
  const sent: Array<{ msg: any; userId: any }> = [];
  const spindle = {
    storage: { read: async () => { throw new Error("empty"); }, write: async () => {} },
    onFrontendMessage: (fn: any) => { frontendHandler = fn; },
    sendToFrontend: (msg: any, userId?: any) => sent.push({ msg, userId }),
    // Without the generation permission Lumiverse refuses the events.
    on: (name: string, fn: any) => {
      if (opts && opts.noEvents) throw new Error("PERMISSION_DENIED: generation");
      events[name] = fn;
    },
    chat: { getMessages: async () => [], updateMessage: async () => {} },
    registerInterceptor: () => {},
    log: { info() {}, warn() {}, error() {} },
  };
  new Function("spindle", BACKEND)(spindle);
  return {
    hear: (name: string, payload: any, userId?: string) => events[name] && events[name](payload, userId),
    ask: async (generationId: string, userId?: string) => {
      await frontendHandler({ type: "how_ended", requestId: "q-" + generationId, generationId }, userId);
      const hit = sent.filter((s) => s.msg && s.msg.type === "ended_how" && s.msg.requestId === "q-" + generationId).pop();
      return hit ? { ...hit.msg, to: hit.userId } : null;
    },
    source: BACKEND,
  };
}

describe("how a reply ended", () => {
  test("an error is told with its words", async () => {
    const h = boot();
    h.hear("GENERATION_ENDED", { generationId: "g1", chatId: "c1", error: "Lantern stream failed (504): Gateway Timeout" }, "u1");
    const got = await h.ask("g1", "u1");
    expect(got.known).toBe(true);
    expect(got.how).toBe("ended");
    expect(got.error).toBe("Lantern stream failed (504): Gateway Timeout");
    expect(got.to).toBe("u1");
  });

  test("a stop is told as a stop", async () => {
    const h = boot();
    h.hear("GENERATION_STOPPED", { generationId: "g2", chatId: "c1", content: "The lamp was" }, "u1");
    const got = await h.ask("g2", "u1");
    expect(got.known).toBe(true);
    expect(got.how).toBe("stopped");
    expect(got.error).toBe("");
  });

  test("a finished reply is told as ended, with no error and no text", async () => {
    const h = boot();
    h.hear("GENERATION_ENDED", { generationId: "g3", chatId: "c1", content: "The ferry pulled away from the dock." }, "u1");
    const got = await h.ask("g3", "u1");
    expect(got.known).toBe(true);
    expect(got.how).toBe("ended");
    expect(got.error).toBe("");
    expect(got.hasText).toBe(true);
    expect(JSON.stringify(got)).not.toContain("ferry");
  });

  test("a reply this side never heard end is not known", async () => {
    const h = boot();
    const got = await h.ask("never", "u1");
    expect(got.known).toBe(false);
  });

  test("one account is not told about another's reply", async () => {
    const h = boot();
    h.hear("GENERATION_ENDED", { generationId: "g4", chatId: "c1", error: "Lantern stream failed (502): Bad Gateway" }, "u1");
    const got = await h.ask("g4", "u2");
    expect(got.known).toBe(false);
    expect(got.error).toBe("");
  });

  test("on a Lumiverse that names no account, the reply's id is enough", async () => {
    const h = boot();
    h.hear("GENERATION_STOPPED", { generationId: "g5", chatId: "c1" });
    expect((await h.ask("g5", "u1")).known).toBe(true);
  });

  test("only the last sixty are kept", async () => {
    const h = boot();
    for (let i = 0; i < 70; i++) h.hear("GENERATION_STOPPED", { generationId: "n" + i, chatId: "c1" }, "u1");
    expect((await h.ask("n0", "u1")).known).toBe(false);
    expect((await h.ask("n69", "u1")).known).toBe(true);
  });

  test("without the generation permission, every ending is not known", async () => {
    const h = boot({ noEvents: true });
    expect((await h.ask("g1", "u1")).known).toBe(false);
  });
});
