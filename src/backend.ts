/*
 * Auto Retry backend (find and replace in replies).
 *
 * Applies the user's word swaps to each finished assistant reply and saves the
 * change through the Chat Mutation API, so the swapped wording sticks and is
 * what the model reads on later turns. It never changes what the model
 * generated; it edits the stored text afterward.
 *
 * A source word may have several replacements: list it on more than one line (e.g.
 * "sky => blue" then "sky => aqua").
 * With the random option on, each occurrence picks one of them at random; off,
 * it always uses the first one listed. A case-sensitive option controls whether
 * matching respects letter case.
 *
 * Rules arrive from the settings UI over the frontend message bridge and are
 * persisted so they survive a backend restart. Editing a message emits
 * MESSAGE_EDITED (not GENERATION_ENDED), so this cannot re-trigger itself.
 *
 * Needs the `generation` permission (to hear GENERATION_ENDED) and
 * `chat_mutation` (to edit the saved message).
 */

declare const spindle: any;

const RULES_FILE = 'replace-rules.json';

interface Group { re: RegExp; tos: string[]; from: string; }

let enabled = false;
let random = false;
let caseSensitive = false;
let rulesText = '';
let groups: Group[] = [];
let warnedEditError = false;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Parse "old => new" rules into groups keyed by the source word, so the same
// word listed more than once collects all its replacements. A single-token
// source (letters/numbers only) matches whole words, so "cat => dog" doesn't
// turn "category" into "dogegory"; anything with a space or punctuation is
// matched literally.
function buildGroups(raw: string, cs: boolean): Group[] {
  const map = new Map<string, { from: string; tos: string[] }>();
  const order: string[] = [];
  for (const line of String(raw == null ? '' : raw).split(/\r?\n/)) {
    const i = line.indexOf('=>');
    if (i < 0) continue;
    const from = line.slice(0, i).trim();
    const to = line.slice(i + 2).trim();
    if (!from) continue;
    const key = cs ? from : from.toLowerCase();
    if (!map.has(key)) { map.set(key, { from: from, tos: [] }); order.push(key); }
    map.get(key)!.tos.push(to);
  }
  const out: Group[] = [];
  for (const key of order) {
    const g = map.get(key)!;
    const isWord = /^[\p{L}\p{N}]+$/u.test(g.from);
    const body = escapeRe(g.from);
    const re = new RegExp('(' + (isWord ? '\\b' + body + '\\b' : body) + ')( ?)', cs ? 'gu' : 'giu');
    out.push({ re: re, tos: g.tos, from: g.from });
  }
  return out;
}

// Keep the replacement's capitalization roughly in line with the text it
// replaced, so a swap at the start of a sentence still reads right. Only used
// when matching is case-insensitive.
function matchCase(sample: string, repl: string): string {
  if (!repl) return repl;
  if (sample.length > 1 && sample === sample.toUpperCase() && sample !== sample.toLowerCase()) return repl.toUpperCase();
  if (/^[A-Z\u00C0-\u00DE]/.test(sample)) return repl.charAt(0).toUpperCase() + repl.slice(1);
  return repl;
}

function applyRules(text: string): string {
  let out = String(text == null ? '' : text);
  for (const g of groups) {
    out = out.replace(g.re, (m: string, matched: string, trail: string) => {
      let repl = (random && g.tos.length > 1) ? g.tos[Math.floor(Math.random() * g.tos.length)] : g.tos[0];
      if (!caseSensitive) repl = matchCase(matched, repl);
      return repl === '' ? '' : repl + trail;   // deletion also drops one trailing space
    });
  }
  return out;
}

function rebuild(): void {
  groups = buildGroups(rulesText, caseSensitive);
}

// Load persisted rules on startup.
(async () => {
  try {
    const saved = await spindle.storage.read(RULES_FILE);
    const parsed = JSON.parse(saved);
    enabled = !!parsed.enabled;
    random = !!parsed.random;
    caseSensitive = !!parsed.caseSensitive;
    rulesText = String(parsed.rulesText == null ? '' : parsed.rulesText);
    rebuild();
  } catch (_) { /* no saved rules yet */ }
})();

// Receive rule changes from the settings UI and persist them.
spindle.onFrontendMessage(async (payload: any) => {
  try {
    if (!payload || payload.type !== 'set_replace_rules') return;
    enabled = !!payload.enabled;
    random = !!payload.random;
    caseSensitive = !!payload.caseSensitive;
    rulesText = String(payload.rulesText == null ? '' : payload.rulesText);
    rebuild();
    await spindle.storage.write(RULES_FILE, JSON.stringify({ enabled: enabled, random: random, caseSensitive: caseSensitive, rulesText: rulesText }));
  } catch (_) {
    try { spindle.log.warn('auto-retry replace: could not save rules'); } catch (__) {}
  }
});

// After each finished reply, apply the rules to the saved message.
spindle.on('GENERATION_ENDED', async (p: any) => {
  try {
    if (!enabled || !groups.length) return;
    if (!p || p.error || !p.chatId) return;
    const chatId = p.chatId;
    let messageId = p.messageId;
    let content = typeof p.content === 'string' ? p.content : '';
    if (!messageId || !content) {
      const msgs = await spindle.chat.getMessages(chatId);
      if (!Array.isArray(msgs) || !msgs.length) return;
      let m = messageId ? msgs.find((x: any) => x && x.id === messageId) : null;
      if (!m) {
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i] && msgs[i].role === 'assistant') { m = msgs[i]; break; }
        }
      }
      if (!m) return;
      messageId = m.id;
      if (!content) content = String(m.content == null ? '' : m.content);
    }
    if (!content) return;
    const next = applyRules(content);
    if (next !== content) {
      await spindle.chat.updateMessage(chatId, messageId, { content: next });
    }
  } catch (e: any) {
    if (!warnedEditError) {
      warnedEditError = true;
      try { spindle.log.warn('auto-retry replace: ' + (e && e.message ? e.message : String(e)) + ' (further errors suppressed; if this is a permission error, grant chat editing)'); } catch (__) {}
    }
  }
});

try { spindle.log.info('Auto Retry backend loaded (find and replace in replies).'); } catch (_) {}
