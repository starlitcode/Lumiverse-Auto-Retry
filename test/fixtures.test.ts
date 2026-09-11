import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Markup copied out of a running Lumiverse is the only way to check against what
// the host really draws, and what comes with it is a live chat id, a connection
// somebody named, and whatever else was on screen. None of that is what such a
// file is for, and this repository is public.
//
// There are no pasted fixtures here yet. This is in place for the first one,
// because the sister extension got a real chat id and a real connection name in
// exactly that way and nobody looked until afterwards.
describe("a pasted fixture carries nothing real", () => {
  const dir = join(import.meta.dir);
  const files = readdirSync(dir).filter((f) => f.endsWith(".html"));

  // The one id such a file may hold, and it is not an id: every digit is zero
  // and the version nibble keeps the shape valid, so a parser can be exercised
  // without anything being named.
  const PLACEHOLDER = "00000000-0000-4000-8000-000000000000";
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

  test("no id in one names anything", () => {
    const found: string[] = [];
    for (const f of files) {
      const text = readFileSync(join(dir, f), "utf8");
      for (const id of text.match(UUID) || [])
        if (id.toLowerCase() !== PLACEHOLDER) found.push(f + ": " + id);
    }
    expect(found).toEqual([]);
  });

  // A connection is named by whoever set it up, so the name says which provider
  // somebody pays and sometimes what they call it. The shape such a file exists
  // for needs a label, not that label.
  test("no connection in one is named after a real provider", () => {
    const PROVIDERS = [
      "openai", "gpt", "anthropic", "claude", "gemini", "google", "mistral",
      "cohere", "llama", "deepseek", "grok", "openrouter", "together", "groq",
      "azure", "bedrock", "ollama", "kobold", "oobabooga", "featherless",
      "chutes", "nano", "requesty",
    ];
    const found: string[] = [];
    for (const f of files) {
      const text = readFileSync(join(dir, f), "utf8").toLowerCase();
      for (const name of PROVIDERS)
        if (text.indexOf(name) >= 0) found.push(f + ": " + name);
    }
    expect(found).toEqual([]);
  });
});
