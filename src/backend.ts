/*
 * Auto Retry backend (find and replace in replies).
 *
 * Applies the user's word swaps to each finished assistant reply and saves the
 * change through the Chat Mutation API, so the swapped wording sticks and is
 * what the model reads on later turns. It never changes what the model
 * generated; it edits the stored text afterward.
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

let enabled = false;
let rules: Array<{ re: RegExp; to: string }> = [];
let warnedEditError = false;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A single-token "old" (letters/numbers only) matches whole words, so
// "cat => dog" doesn't turn "category" into "dogegory". Anything with a space
// or punctuation is matched literally.
function buildRule(from: string, to: string): { re: RegExp; to: string } | null {
  const f = String(from == null ? '' : from);
  if (!f) return null;
  const isWord = /^[\p{L}\p{N}]+$/u.test(f);
  const body = escapeRe(f);
  const re = new RegExp(isWord ? '\\b' + body + '\\b' : body, 'giu');
  return { re: re, to: String(to == null ? '' : to) };
}

function parseRules(raw: string): Array<{ re: RegExp; to: string }> {
  const out: Array<{ re: RegExp; to: string }> = [];
  for (const line of String(raw == null ? '' : raw).split(/[,\n]/)) {
    const i = line.indexOf('=>');
    if (i < 0) continue;
    const r = buildRule(line.slice(0, i).trim(), line.slice(i + 2).trim());
    if (r) out.push(r);
  }
  return out;
}

// Keep the replacement's capitalization roughly in line with the text it
// replaced, so a swap at the start of a sentence still reads right.
function matchCase(sample: string, repl: string): string {
  if (!repl) return repl;
  if (sample.length > 1 && sample === sample.toUpperCase() && sample !== sample.toLowerCase()) return repl.toUpperCase();
  if (/^[A-Z\u00C0-\u00DE]/.test(sample)) return repl.charAt(0).toUpperCase() + repl.slice(1);
  return repl;
}

function applyRules(text: string): string {
  let out = String(text == null ? '' : text);
  for (const r of rules) out = out.replace(r.re, (m: string) => matchCase(m, r.to));
  return out;
}

// Load persisted rules on startup.
(async () => {
  try {
    const saved = await spindle.storage.read(RULES_FILE);
    const parsed = JSON.parse(saved);
    enabled = !!parsed.enabled;
    rules = parseRules(parsed.rulesText || '');
  } catch (_) { /* no saved rules yet */ }
})();

// Receive rule changes from the settings UI and persist them.
spindle.onFrontendMessage(async (payload: any) => {
  try {
    if (!payload || payload.type !== 'set_replace_rules') return;
    enabled = !!payload.enabled;
    const rulesText = String(payload.rulesText == null ? '' : payload.rulesText);
    rules = parseRules(rulesText);
    await spindle.storage.write(RULES_FILE, JSON.stringify({ enabled: enabled, rulesText: rulesText }));
  } catch (_) {
    try { spindle.log.warn('auto-retry replace: could not save rules'); } catch (__) {}
  }
});

// After each finished reply, apply the rules to the saved message.
spindle.on('GENERATION_ENDED', async (p: any) => {
  try {
    if (!enabled || !rules.length) return;
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
      await spindle.chat.updateMessage(chatId, messageId, { content: next, metadata: { source: 'auto_retry_replace' } });
    }
  } catch (e: any) {
    if (!warnedEditError) {
      warnedEditError = true;
      try { spindle.log.warn('auto-retry replace: ' + (e && e.message ? e.message : String(e)) + ' (further errors suppressed; if this is a permission error, grant chat editing)'); } catch (__) {}
    }
  }
});

try { spindle.log.info('Auto Retry backend loaded (find and replace in replies).'); } catch (_) {}
