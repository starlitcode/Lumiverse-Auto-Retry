// Which build the backend says it is, driven through the file Lumiverse loads.
//
// The panel prints its own version in a debug report and can only print this
// side's by asking. The two are shipped together and loaded separately, the
// frontend by the browser and this by the server, so they can differ: a tab
// left open across an update keeps the frontend it started with. A report that
// names one version for both sends whoever reads it to the wrong file.
//
// Run with: bun test

import { expect, test, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const BACKEND = readFileSync(join(root, "dist", "backend.js"), "utf8");
const manifest = JSON.parse(readFileSync(join(root, "spindle.json"), "utf8")).version;

// The same stub shape the note checks use, with sendToFrontend kept this time,
// since what this side says is the whole point here.
function boot() {
  let frontendHandler: any = null;
  const sent: any[] = [];
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
    sendToFrontend: (msg: any) => sent.push(msg),
    on: () => {},
    chat: { getMessages: async () => [], updateMessage: async () => {} },
    registerInterceptor: () => {},
    log: { info() {}, warn() {}, error() {} },
  };
  new Function("spindle", BACKEND)(spindle);
  return {
    sent,
    ask: (payload: any) => frontendHandler(payload, "u1"),
  };
}

describe("the backend says which build it is", () => {
  test("unprompted at startup, for a panel that was already open", () => {
    const h = boot();
    const said = h.sent.filter((m: any) => m.type === "backend_version");
    expect(said.length).toBe(1);
    expect(said[0].version).toBe(manifest);
  });

  test("and on request, for a panel that opened later and missed it", async () => {
    const h = boot();
    h.sent.length = 0;
    await h.ask({ type: "get_backend_version", requestId: "r1" });
    const said = h.sent.filter((m: any) => m.type === "backend_version");
    expect(said.length).toBe(1);
    expect(said[0].version).toBe(manifest);
    expect(said[0].requestId).toBe("r1");
  });
});
