// Fit the wait to the model. The rules are the same in Auto Refine and Auto
// Foley: a model on your own computer or network gets five times as long, and
// thinking set higher gets longer, at most an hour. The rules run in the
// panel. The backend names the connection a reply is written by, which is
// driven here through the file Lumiverse loads.
//
// Run with: bun test

import { expect, test, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { __testing } from "../src/frontend";

const { isLocalUrl, fitWait, minutesText, CONFIG, SCHEMA, MOVED_DEFAULTS } = __testing as any;

describe("fitting the wait to the model", () => {
  test("an address on your own computer or network counts as local, and a cloud one does not", () => {
    const local = ["http://localhost:5001/v1", "http://127.0.0.1:8080", "http://192.168.1.40:11434/v1", "http://10.0.0.7:5000", "http://172.20.3.4:1234", "http://100.90.12.3:8080", "http://gpu-box:5001", "http://studio.local:1234/v1", "http://[::1]:8080", "https://user:pass@192.168.0.9/v1"];
    const cloud = ["https://api.openai.com/v1", "https://openrouter.ai/api/v1", "https://172.15.0.1/v1", "https://100.50.1.1", "", "not a url"];
    expect(local.filter((u) => !isLocalUrl(u))).toEqual([]);
    expect(cloud.filter((u) => isLocalUrl(u))).toEqual([]);
  });

  test("the wait is stretched for thinking and for a local model, at most an hour", () => {
    expect(fitWait(120, "https://api.openai.com/v1", "").secs).toBe(120);
    expect(fitWait(120, "https://api.openai.com/v1", "low").secs).toBe(120);
    expect(fitWait(120, "https://api.openai.com/v1", "high").secs).toBe(240);
    expect(fitWait(120, "https://api.openai.com/v1", "max").secs).toBe(360);
    const local = fitWait(120, "http://localhost:5001", "medium");
    expect(local.secs).toBe(900);
    expect(local.why).toEqual(["thinking is set to medium", "the model runs on your own computer or network"]);
    expect(fitWait(600, "http://localhost:5001", "max").secs).toBe(3600);
  });

  test("with the default waits, a local model with high thinking gets 40 and 15 minutes", () => {
    const stuck = fitWait(CONFIG.stuckTimeoutMs / 1000, "http://192.168.1.40:5001/v1", "high");
    const idle = fitWait(CONFIG.idleTimeoutMs / 1000, "http://192.168.1.40:5001/v1", "high");
    expect(minutesText(stuck.secs)).toBe("40 minutes");
    expect(minutesText(idle.secs)).toBe("15 minutes");
  });

  test("the switch is on by default and sits straight under the two waits", () => {
    expect(CONFIG.waitFit).toBe(true);
    for (const g of SCHEMA) {
      const keys = g.fields.map((f: any) => f.key);
      const at = keys.indexOf("waitFit");
      if (at < 0) continue;
      expect(keys.slice(at - 2, at)).toEqual(["stuckTimeoutMs", "idleTimeoutMs"]);
      return;
    }
    throw new Error("waitFit is not in the panel");
  });

  test("a new setting has no moved-default row", () => {
    expect(MOVED_DEFAULTS.some((m: any) => m.key === "waitFit")).toBe(false);
  });
});

describe("the defaults that moved in 5.28.0", () => {
  test("three tries, and the thinking-only checks off", () => {
    expect(CONFIG.maxRetries).toBe(3);
    expect(CONFIG.retryOnSpamThinking).toBe(false);
    expect(CONFIG.retryOnGarbledThinking).toBe(false);
    expect(CONFIG.retryOnLoopThinking).toBe(false);
  });

  test("each has a row, so a reader still on the old value is told", () => {
    const row = (k: string) => MOVED_DEFAULTS.find((m: any) => m.key === k);
    expect(row("maxRetries") && row("maxRetries").was).toBe(4);
    for (const k of ["retryOnSpamThinking", "retryOnGarbledThinking", "retryOnLoopThinking"])
      expect(row(k) && row(k).was).toBe(true);
  });

  test("the hints of the thinking checks say they are off by default", () => {
    const keys = ["retryOnSpamThinking", "retryOnGarbledThinking", "retryOnLoopThinking"];
    let seen = 0;
    for (const g of SCHEMA)
      for (const f of g.fields)
        if (keys.indexOf(f.key) >= 0) {
          seen++;
          expect(String(f.hint || "")).toStartWith("Off by default.");
        }
    expect(seen).toBe(3);
  });
});

const BACKEND = readFileSync(join(import.meta.dir, "..", "dist", "backend.js"), "utf8");

function boot(connections: any[], meta: any = {}) {
  let onFrontend: any = null;
  let interceptor: any = null;
  const sent: Array<{ msg: any; userId: any }> = [];
  const spindle: any = {
    storage: { read: async () => { throw new Error("empty"); }, write: async () => {} },
    userStorage: { getJson: async () => null, setJson: async () => {} },
    onFrontendMessage: (fn: any) => { onFrontend = fn; },
    sendToFrontend: (msg: any, userId?: any) => sent.push({ msg, userId }),
    on: () => {},
    chat: { getMessages: async () => [], updateMessage: async () => {} },
    chats: { get: async (chatId: string) => ({ id: chatId, metadata: meta }) },
    connections: { list: async () => connections },
    registerInterceptor: (fn: any) => { interceptor = fn; },
    log: { info() {}, warn() {}, error() {} },
  };
  // eslint-disable-next-line no-new-func
  new Function("spindle", BACKEND)(spindle);
  const fits = () => sent.filter((s) => s.msg && s.msg.type === "wait_fit");
  return {
    ask: (payload: any, userId = "u1") => onFrontend(payload, userId),
    run: (msgs: any[], context: any) => interceptor(msgs, context),
    fits,
    settle: () => new Promise((r) => setTimeout(r, 20)),
  };
}

const conns = [
  { id: "cloud", name: "Cloud", api_url: "https://api.example.com/v1", is_default: true, reasoning_bindings: { settings: { apiReasoning: true, reasoningEffort: "low" } } },
  { id: "home", name: "Home", api_url: "http://192.168.1.40:5001/v1", is_default: false, reasoning_bindings: { settings: { apiReasoning: true, reasoningEffort: "high" } } },
  { id: "quiet", name: "Quiet", api_url: "http://gpu-box:5001", is_default: false, reasoning_bindings: { settings: { apiReasoning: false, reasoningEffort: "max" } } },
];

describe("the connection a reply is written by", () => {
  test("with nothing else known, it is the default connection", async () => {
    const h = boot(conns);
    await h.ask({ type: "get_wait_fit", chatId: "c1" });
    const got = h.fits().pop();
    expect(got.userId).toBe("u1");
    expect(got.msg.fit).toEqual({ url: "https://api.example.com/v1", effort: "low" });
  });

  test("a chat with its own connection uses that one", async () => {
    const h = boot(conns, { connection_profile_id: "home" });
    await h.ask({ type: "get_wait_fit", chatId: "c1" });
    expect(h.fits().pop().msg.fit.url).toBe("http://192.168.1.40:5001/v1");
  });

  test("the interceptor names the connection Lumiverse picked, and it is used for that chat after", async () => {
    const h = boot(conns);
    await h.run([{ role: "user", content: "The tide came in." }], { chatId: "c1", userId: "u1", connectionId: "home", generationType: "normal" });
    await h.settle();
    const pushed = h.fits().pop();
    expect(pushed.msg.from).toBe("interceptor");
    expect(pushed.msg.chatId).toBe("c1");
    expect(pushed.msg.fit.url).toBe("http://192.168.1.40:5001/v1");
    expect(pushed.userId).toBe("u1");
    await h.ask({ type: "get_wait_fit", chatId: "c1" });
    expect(h.fits().pop().msg.fit.url).toBe("http://192.168.1.40:5001/v1");
  });

  test("thinking counts only when the connection sends it to the model", async () => {
    const h = boot(conns, { connection_profile_id: "quiet" });
    await h.ask({ type: "get_wait_fit", chatId: "c1" });
    expect(h.fits().pop().msg.fit.effort).toBe("");
  });

  test("a generation that names no account is not answered to anybody", async () => {
    const h = boot(conns);
    await h.run([{ role: "user", content: "The tide came in." }], { chatId: "c1", connectionId: "home", generationType: "normal" });
    await h.settle();
    expect(h.fits().length).toBe(0);
  });

  test("a background call and a prompt preview name nothing", async () => {
    const h = boot(conns);
    await h.run([{ role: "user", content: "x" }], { chatId: "c1", userId: "u1", connectionId: "home", generationType: "quiet" });
    await h.run([{ role: "user", content: "x" }], { chatId: "c1", userId: "u1", connectionId: "home", dryRun: true });
    await h.settle();
    expect(h.fits().length).toBe(0);
  });

  test("with no connections to read, the answer is empty", async () => {
    const h = boot([]);
    await h.ask({ type: "get_wait_fit", chatId: "c1" });
    expect(h.fits().pop().msg.fit).toBe(null);
  });
});
