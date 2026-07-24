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
 * All rules run in a single pass over the text, so no rule ever acts on what
 * another rule just wrote. Where two rules could match the same spot, the one
 * with the longer left side wins.
 *
 * This backend also keeps the whole settings object in account storage, so the
 * user's settings follow them across browsers and devices. Rules and settings
 * arrive from the UI over the frontend message bridge and are persisted so they
 * survive a restart. Editing a message emits
 * MESSAGE_EDITED (not GENERATION_ENDED), so this cannot re-trigger itself.
 *
 * Needs the `generation` permission (to hear GENERATION_ENDED) and
 * `chat_mutation` (to edit the saved message).
 */

declare const spindle: any;

const RULES_FILE = 'replace-rules.json';
const SETTINGS_FILE = 'settings.json';

interface Group { tos: string[]; from: string; isWord: boolean; }

let enabled = false;
let random = false;
let caseSensitive = false;
let rulesText = '';
let allowReSwap = false;
let confirmBeforeEdit = false;
let groups: Group[] = [];
// All rules compiled into one pattern, plus the group index each capture slot
// belongs to. Built once per settings change, used for the single pass.
let combined: RegExp | null = null;
let combinedOrder: number[] = [];
let warnedEditError = false;
// Messages a swap has already changed this session, so the manual button won't
// compound swaps on a reply that auto-swap or an earlier tap already changed.
const swappedIds = new Set<string>();
const SWAPPED_CAP = 1000;
function markSwapped(id: any) {
  if (id == null) return;
  swappedIds.add(id);
  if (swappedIds.size > SWAPPED_CAP) swappedIds.delete(swappedIds.values().next().value as string);
}
// Best-effort: the chat currently active (on screen), which needs the "chats"
// permission. Method name follows the API's get-naming convention; if it's absent
// or errors, fall back to the chat the request came from so nothing breaks.

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
    try {
      // Compiled here only to drop a source that can't form a valid pattern,
      // so one bad rule can't take the combined pattern down with it.
      new RegExp(escapeRe(g.from), cs ? 'gu' : 'giu');
      out.push({ tos: g.tos, from: g.from, isWord: isWord });
    } catch (_) { /* skip a rule that can't compile */ }
  }
  return out;
}

// Every rule joined into one alternation so the text is walked once and each
// stretch of it is replaced at most once. Running rules one after another would
// let a later rule act on what an earlier one just wrote, so "cat => dog"
// followed by "dog => wolf" would turn cat into wolf.
function buildCombined(gs: Group[], cs: boolean): RegExp | null {
  if (!gs.length) return null;
  // Longest source first. A regex alternation takes the first branch that
  // matches, so without this "cat" would win over "cat nap" and the longer
  // rule would never fire. Equal lengths keep the order they were listed in.
  combinedOrder = gs.map((_, i) => i).sort((a, b) =>
    (gs[b].from.length - gs[a].from.length) || (a - b));
  const parts = combinedOrder.map((i) => {
    const body = escapeRe(gs[i].from);
    return '(' + (gs[i].isWord ? '\\b' + body + '\\b' : body) + ')';
  });
  try {
    return new RegExp('(?:' + parts.join('|') + ')( ?)', cs ? 'gu' : 'giu');
  } catch (_) {
    combinedOrder = [];
    return null;
  }
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
  const src = String(text == null ? '' : text);
  if (!combined || !combinedOrder.length) return src;
  combined.lastIndex = 0;
  return src.replace(combined, (...args: any[]) => {
    // args is: whole match, one slot per rule, the trailing space, offset, input.
    const trail = String(args[combinedOrder.length + 1] || '');
    let matched: string | null = null;
    let g: Group | null = null;
    for (let k = 0; k < combinedOrder.length; k++) {
      if (args[k + 1] !== undefined) {
        matched = String(args[k + 1]);
        g = groups[combinedOrder[k]];
        break;
      }
    }
    if (!g || matched == null) return String(args[0]);
    let repl = (random && g.tos.length > 1) ? g.tos[Math.floor(Math.random() * g.tos.length)] : g.tos[0];
    if (!caseSensitive) repl = matchCase(matched, repl);
    return repl === '' ? '' : repl + trail;   // deletion also drops one trailing space
  });
}

// Writes swapped text back. Content alone emits only MESSAGE_EDITED, which the
// chat view does not redraw on, so the swap sat there unseen until the chat was
// reopened. Supplying the swipe array as well makes the host emit SWIPE_EDITED
// too, which the view does redraw on. The active slot is rewritten to the same
// text the content patch sets, so the message is unchanged either way; only the
// event that announces it differs. Falls back to a plain content patch when the
// message carries no usable swipe array.
async function writeSwapped(chatId: string, m: any, next: string): Promise<void> {
  const patch: any = { content: next };
  const swipes = m && Array.isArray(m.swipes) ? m.swipes.slice() : null;
  const idx = m && typeof m.swipe_id === 'number' ? m.swipe_id : 0;
  if (swipes && swipes.length > 0 && idx >= 0 && idx < swipes.length) {
    swipes[idx] = next;
    patch.swipes = swipes;
    patch.swipe_id = idx;
  }
  await spindle.chat.updateMessage(chatId, m.id, patch);
}

function rebuild(): void {
  groups = buildGroups(rulesText, caseSensitive);
  combined = buildCombined(groups, caseSensitive);
}

// Pull the find-and-replace fields out of a full settings object.
function applyReplaceFromSettings(s: any) {
  enabled = !!s.replaceEnabled;
  random = !!s.replaceRandom;
  caseSensitive = !!s.replaceCaseSensitive;
  rulesText = String(s.replaceRules == null ? '' : s.replaceRules);
  allowReSwap = !!s.allowReSwap;
  confirmBeforeEdit = !!s.confirmBeforeEdit;
  rebuild();
}
// Load persisted settings on startup. The whole settings object now lives in
// account storage (SETTINGS_FILE) so it follows the user across browsers; an
// older install that only stored replace rules (RULES_FILE) is read as a fallback.
(async () => {
  try {
      applyReplaceFromSettings(JSON.parse(await spindle.storage.read(SETTINGS_FILE)));
      return;
  } catch (_) { /* no account settings yet */ }
  try {
      const parsed = JSON.parse(await spindle.storage.read(RULES_FILE));
      enabled = !!parsed.enabled;
      random = !!parsed.random;
      caseSensitive = !!parsed.caseSensitive;
      rulesText = String(parsed.rulesText == null ? '' : parsed.rulesText);
      rebuild();
  } catch (_) { /* no saved rules yet */ }
})();
// Settings bridge with the UI: save the whole settings object to account storage,
// hand it back on request, and keep the find-and-replace state in sync with it.
spindle.onFrontendMessage(async (payload: any) => {
  try {
      if (!payload) return;
      if (payload.type === 'save_settings' && payload.settings && typeof payload.settings === 'object') {
      applyReplaceFromSettings(payload.settings);
      await spindle.storage.write(SETTINGS_FILE, JSON.stringify(payload.settings));
      return;
      }
      if (payload.type === 'load_settings') {
      let settings = null;
      try { settings = JSON.parse(await spindle.storage.read(SETTINGS_FILE)); } catch (__) { settings = null; }
      try { spindle.sendToFrontend({ type: 'loaded_settings', requestId: payload.requestId, settings: settings }); } catch (__) {}
      return;
      }
      if (payload.type === 'apply_replace_now') {
        let ok = true, found = false, changed = 0, skipped = 0;
        try {
          const chatId = payload.chatId;
          const wantId = payload.messageId;
          if (chatId && groups.length) {
            const msgs = await spindle.chat.getMessages(chatId);
            const targets: any[] = [];
            if (Array.isArray(msgs)) {
              // The opening/greeting message is authored, not generated, so never swap it.
              const greetingId = (msgs.length && msgs[0] && msgs[0].role === 'assistant') ? msgs[0].id : null;
              if (payload.wholeChat && !payload.onlyMessage) {
                // Every generated assistant reply in the chat (never user messages or the greeting).
                for (const x of msgs) { if (x && x.role === 'assistant' && x.id !== greetingId) targets.push(x); }
              } else {
                // The exact reply if we have it, else the latest assistant reply, never the greeting.
                let m: any = null;
                if (wantId != null) m = msgs.find((x: any) => x && x.id === wantId && x.role === 'assistant') || null;
                if (!m) { for (let i = msgs.length - 1; i >= 0; i--) { if (msgs[i] && msgs[i].role === 'assistant' && msgs[i].id !== greetingId) { m = msgs[i]; break; } } }
                if (m && m.id !== greetingId) targets.push(m);
              }
            }
            found = targets.length > 0;
            for (const m of targets) {
              // Skip replies already swapped this session unless re-swapping is allowed.
              if (!allowReSwap && swappedIds.has(m.id)) { skipped++; continue; }
              const content = String(m.content == null ? '' : m.content);
              const next = applyRules(content);
              if (next !== content) { await writeSwapped(chatId, m, next); changed++; markSwapped(m.id); }
            }
          }
        } catch (_) { ok = false; }
        try { spindle.sendToFrontend({ type: 'replace_now_result', requestId: payload.requestId, ok: ok, hasRules: groups.length > 0, found: found, changed: changed, skipped: skipped }); } catch (__) {}
        return;
      }
      if (payload.type === 'set_replace_rules') {
      // Legacy path for an older cached frontend that still sends rules alone.
      enabled = !!payload.enabled;
      random = !!payload.random;
      caseSensitive = !!payload.caseSensitive;
      rulesText = String(payload.rulesText == null ? '' : payload.rulesText);
      rebuild();
      await spindle.storage.write(RULES_FILE, JSON.stringify({ enabled: enabled, random: random, caseSensitive: caseSensitive, rulesText: rulesText }));
      return;
      }
  } catch (_) {
      try { spindle.log.warn('auto-retry: could not handle a settings message'); } catch (__) {}
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
    // Fetch to fill any missing content and to spot the greeting: the opening
    // message is authored, not generated, so it must never be swapped.
    // Held so the write below can carry the swipe array, which is what makes the
    // chat view redraw. Stays null if the message can't be read; the write then
    // falls back to a plain content patch.
    let target: any = null;
    try {
      const msgs = await spindle.chat.getMessages(chatId);
      if (Array.isArray(msgs) && msgs.length) {
        const greetingId = (msgs[0] && msgs[0].role === 'assistant') ? msgs[0].id : null;
        if (!messageId || !content) {
          let m: any = messageId ? msgs.find((x: any) => x && x.id === messageId && x.role === 'assistant') : null;
          if (!m) { for (let i = msgs.length - 1; i >= 0; i--) { if (msgs[i] && msgs[i].role === 'assistant') { m = msgs[i]; break; } } }
          if (m) { messageId = m.id; if (!content) content = String(m.content == null ? '' : m.content); }
        }
        if (messageId != null && greetingId != null && messageId === greetingId) return; // never swap the greeting
        target = msgs.find((x: any) => x && x.id === messageId) || null;
      }
    } catch (_) {}
    // Both are needed: without an id there is nothing to write to, and the
    // lookup above leaves it unset when the reply cannot be found.
    if (!messageId || !content) return;
    const next = applyRules(content);
    if (next !== content) {
      if (confirmBeforeEdit) {
        // Ask first; the frontend sends apply_replace_now for this reply if the user agrees.
        try { spindle.sendToFrontend({ type: 'confirm_edit', chatId: chatId, messageId: messageId, requestId: 'ar-auto-' + Date.now() }); } catch (__) {}
        return;
      }
      await writeSwapped(chatId, target || { id: messageId }, next);
      markSwapped(messageId);
    }
  } catch (e: any) {
    if (!warnedEditError) {
      warnedEditError = true;
      try { spindle.log.warn('auto-retry replace: ' + (e && e.message ? e.message : String(e)) + ' (further errors suppressed; if this is a permission error, grant chat editing)'); } catch (__) {}
    }
  }
});

try { spindle.log.info('Auto Retry backend loaded (find and replace in replies).'); } catch (_) {}
