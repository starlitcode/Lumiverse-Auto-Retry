// The two modules talk over a message bridge of plain strings, which nothing
// type-checks. A handler for a message nobody sends compiles, passes every
// test, and sits there forever looking load-bearing: that is exactly what
// `set_replace_rules` was, and it dragged a storage file and a startup read
// along with it. A message sent to nobody is the worse half of the same fault,
// because it silently does nothing at runtime.
import { expect, test, describe } from "bun:test";
import { readFileSync } from "node:fs";

const FRONT = readFileSync(new URL("../src/frontend.ts", import.meta.url), "utf8");
const BACK = readFileSync(new URL("../src/backend.ts", import.meta.url), "utf8");

const uniq = (a: string[]) => [...new Set(a)].sort();
const matches = (src: string, re: RegExp) =>
  uniq([...src.matchAll(re)].map((m) => m[1]));

// What each side sends, and what each side answers to.
//
// Most sends call sendToBackend with the message written out on the spot. The
// swap requests go through sendSwapRequest instead, which wraps the same call
// so it can arm a timeout, so that name is read here too. A wrapper this does
// not know about would hide whatever it sends, which the last test in this
// block is there to catch.
const frontSends = matches(FRONT, /(?:sendToBackend|sendSwapRequest)\(\{\s*type:\s*"([a-z_]+)"/g);
const backHandles = matches(BACK, /payload\.type === '([a-z_]+)'/g);
const backSends = matches(BACK, /replyTo\([^,]+,\s*\{\s*type:\s*'([a-z_]+)'/g);
const frontHandles = uniq([
  ...[...FRONT.matchAll(/msg\.type (?:===|!==) "([a-z_]+)"/g)].map((m) => m[1]),
]);

describe("the message bridge has no dead ends", () => {
  test("both directions were really parsed", () => {
    for (const list of [frontSends, backHandles, backSends, frontHandles])
      expect(list.length).toBeGreaterThan(0);
  });

  test("every message the frontend sends is handled", () => {
    expect(frontSends.filter((t) => backHandles.indexOf(t) < 0)).toEqual([]);
  });

  test("every message the backend handles is sent by somebody", () => {
    expect(backHandles.filter((t) => frontSends.indexOf(t) < 0)).toEqual([]);
  });

  test("every reply the backend sends is handled", () => {
    // confirm_edit is the one the frontend answers with a dialog rather than a
    // typed branch, so it is matched by name here like the rest.
    expect(backSends.filter((t) => frontHandles.indexOf(t) < 0)).toEqual([]);
  });

  test("every reply the frontend waits for is actually sent", () => {
    expect(frontHandles.filter((t) => backSends.indexOf(t) < 0)).toEqual([]);
  });

  test("no send is hidden behind a wrapper this file does not read", () => {
    // A sendToBackend call handed a variable says nothing about what it sends,
    // so the checks above cannot see through it. There were none left once the
    // word swap wrapper went, and none is the state worth holding: every send
    // now names its own type where the checks above can read it.
    const indirect = uniq(
      [...FRONT.matchAll(/sendToBackend\((?!\{)([A-Za-z_$][\w$]*)\)/g)].map((m) => m[1]),
    );
    expect(indirect).toEqual([]);
  });
});

describe("no storage file is written and never read, or read and never written", () => {
  test("every storage filename is used on both sides of a read and a write", () => {
    const files = uniq([...BACK.matchAll(/const ([A-Z_]+_FILE) =/g)].map((m) => m[1]));
    expect(files.length).toBeGreaterThan(0);
    const orphans: string[] = [];
    for (const f of files) {
      const read = new RegExp("(read|getJson|readUserJson)\\([^)]*" + f).test(BACK);
      const written = new RegExp("(write|setJson|writeUserJson)\\([^)]*" + f).test(BACK);
      if (!read || !written) orphans.push(f + (read ? " is never written" : " is never read"));
    }
    expect(orphans).toEqual([]);
  });
});

// Both modules decide for themselves what counts as the model's thinking: the
// frontend to keep a refusal inside it from causing a retry, the backend to
// keep a word swap out of it. They are separate runtimes with no shared import,
// so the lists are duplicated, and nothing but this notices when one grows a
// tag the other has never heard of. The result of that drift is quiet: a swap
// rewrites a reasoning block the refusal check knows to skip, or the other way
// round, and both files look perfectly correct on their own.
