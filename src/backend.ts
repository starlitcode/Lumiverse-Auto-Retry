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
 * This backend also keeps the whole settings object in per-user account storage,
 * so the user's settings follow them across browsers and devices. Rules and
 * settings arrive from the UI over the frontend message bridge and are persisted
 * so they survive a restart. Editing a message emits MESSAGE_EDITED and
 * SWIPE_EDITED, neither of which is GENERATION_ENDED, and the edit watcher below
 * ignores text it wrote itself, so this cannot re-trigger itself.
 *
 * Needs the `generation` permission (to hear GENERATION_ENDED) and
 * `chat_mutation` (to edit the saved message).
 */

declare const spindle: any;
// The backend runtime has timers, but this module typechecks against ES2020
// with no DOM lib, and nothing in ES2020 declares them. Without these the
// settle gate below fails the backend typecheck, which takes `bun run check`
// and the CI job with it. Declarations emit nothing, so dist is unaffected.
declare function setTimeout(fn: () => void, ms: number): any;
declare function clearTimeout(handle: any): void;

const SETTINGS_FILE = 'settings.json';
// Word-swap presets. These lived only in the browser's local storage, so a
// user's settings followed them to a new device and their presets silently did
// not. Kept in account storage alongside the settings, with the browser copy
// still acting as the fast local cache.
const PRESETS_FILE = 'presets.json';

interface Group { tos: string[]; from: string; isWord: boolean; }

let enabled = false;
let random = false;
let caseSensitive = false;
let rulesText = '';
let allowReSwap = false;
let confirmBeforeEdit = false;
let waitForOtherEdits = false;
let waitStartMs = 85000;   // matches the panel's default until settings arrive
let groups: Group[] = [];
// All rules compiled into one pattern, plus the group index each capture slot
// belongs to. Built once per settings change, used for the single pass.
let combined: RegExp | null = null;
let combinedOrder: number[] = [];
let warnedEditError = false;

// ---- per-user storage ----
// One backend process can serve every account on the server. spindle.storage
// resolves to a single shared directory in that case, so settings and presets
// written through it were pooled across accounts: one person's word swaps could
// be read back by another. userStorage always resolves per user. On an ordinary
// single-user install the userId is inferred and this behaves exactly as before.
function hasUserStorage(): boolean {
  try {
    return !!(spindle.userStorage && typeof spindle.userStorage.getJson === 'function');
  } catch (_) {
    return false;
  }
}

// Reads this user's copy, and on the first read after upgrading copies the old
// shared-store copy up rather than presenting the user with empty settings.
async function readUserJson(file: string, userId?: string): Promise<any> {
  if (hasUserStorage()) {
    try {
      const v = await spindle.userStorage.getJson(file, { fallback: null, userId: userId });
      if (v != null) return v;
    } catch (_) { /* fall through to the legacy store */ }
    let legacy: any = null;
    try { legacy = JSON.parse(await spindle.storage.read(file)); } catch (_) { legacy = null; }
    if (legacy != null) {
      try { await spindle.userStorage.setJson(file, legacy, { userId: userId }); } catch (_) {}
    }
    return legacy;
  }
  try { return JSON.parse(await spindle.storage.read(file)); } catch (_) { return null; }
}

async function writeUserJson(file: string, value: any, userId?: string): Promise<void> {
  if (hasUserStorage()) {
    try {
      await spindle.userStorage.setJson(file, value, { userId: userId });
      return;
    } catch (_) { /* fall through so a save is never silently lost */ }
  }
  await spindle.storage.write(file, JSON.stringify(value));
}

// Replying without a userId broadcasts to every connected user on an
// operator-scoped install, so every reply to a frontend message carries the id
// of whoever sent it. A user-scoped install ignores the argument.
function replyTo(userId: string | undefined, msg: any): void {
  try { spindle.sendToFrontend(msg, userId); } catch (_) {}
}

// The note that goes out with a refusal retry. Armed by the frontend the moment
// before it clicks, collected by the interceptor on the generation that click
// starts, then thrown away. One generation only.
//
// Three things keep it from landing on the wrong generation: it is scoped to
// the chat it was armed for, it is used once and cleared whether or not it was
// used, and it expires. The frontend also takes it back when the retry click it
// was armed for never started anything, so the window between arming and
// collection is the length of one click, not the age limit below.
//
// The one thing that no longer guards this is what the host calls the
// generation. It used to require context.generationType to read "regenerate"
// or "swipe". Builds that report "normal" for every generation, which is most
// of them, therefore never sent the note at all: it was armed, the retry ran
// without it, and the only sign was a line in the log. The type is now only
// consulted when the user asks for it, through strictType below.
interface RefusalNote { chatId: string; notes: Array<{ text: string; role: string }>; placement: string; at: number; strictType: boolean; }
let refusalNote: RefusalNote | null = null;
// The extension's master switch, and the chats it has been switched off in.
// Both belong to the frontend, and both have to reach here because swapping
// runs on this side and would otherwise ignore them.
let masterOn = true;
let chatsOff: Set<string> = new Set();
// Long enough to cover prompt assembly on a busy server, short enough that a
// note whose click died is expired rather than sitting around. The frontend
// disarms on a dead click well inside this.
const NOTE_MAX_AGE_MS = 45000;
const NOTE_ROLES = ['system', 'user', 'assistant'];
// What the host may call a generation that a retry produced. Only used when the
// user turns the strict check on, since the names vary between builds.
const RETRY_TYPES = ['regenerate', 'regeneration', 'swipe', 'reroll', 'retry'];
// Matches the cap the panel offers, so a hand-edited payload cannot exceed it.
const MAX_NOTES = 10;

// ---- the prompt viewer ----
// The interceptor is the one place in the extension that sees the whole
// assembled prompt, in the shape it goes to the model in and after everything
// else has had its turn at it. Lumiverse's own Prompt Breakdown lists what the
// chat is built from, which is not the same question as "what actually went",
// so this answers that one.
//
// Captured only while somebody has the Prompt view open, and stopped the
// moment they close it or switch back to the log. A prompt is large, it crosses
// the bridge on every generation, and it is the user's chat text, so none of it
// moves while nobody is looking at it. This is a live request from the panel
// rather than a saved setting: a setting left on would go on paying for itself
// in every chat forever after somebody looked once.
//
// A set rather than a flag, because one backend can serve several accounts and
// one person opening the view is not a reason to capture anyone else's prompt.
const promptWatchers = new Set<string>();
// A snapshot is identified to the panel by when it was taken, which is how a
// token count that arrives later is matched to the prompt it describes. Two
// generations in the same millisecond would share that identity and the count
// for one would be shown against the other, so it is nudged forward to stay
// strictly rising.
let lastSnapshotAt = 0;
const watcherKey = (userId?: string) => String(userId == null ? '' : userId);
// Who a snapshot belongs to, or null for nobody. The exact key answers it
// whenever both sides name the same person, and they do not always: the panel's
// request arrives through onFrontendMessage, which is given a userId, while the
// interceptor reads one off its own context, which not every Lumiverse build
// fills in. The watcher then goes in under a name and every lookup arrives
// without one, so the view stays empty for good and nothing anywhere says why.
//
// An empty key means the host did not say who this is. On a build that never
// says, the only person it can be is the one watching. Two or more watchers is
// a real multi-user instance, where a prompt nobody can attribute must not be
// handed to whichever of them happens to be first, so it is dropped instead.
function promptWatcherFor(userId?: string): string | null {
  const k = watcherKey(userId);
  if (promptWatchers.has(k)) return k;
  if (promptWatchers.size !== 1) return null;
  const only = promptWatchers.values().next().value as string;
  return k === '' || only === '' ? only : null;
}
// The whole prompt goes to the panel, every message and every character of it.
// This used to be capped, which kept the cost of a generation down and left the
// view saying a message was longer than what it was showing, which is the one
// thing somebody opening this view cannot work around. A prompt is only sent
// while the Prompt tab is actually open, and that is where the cost is kept.

// The tokeniser the host actually uses, when it will tell us. The panel's own
// figure is characters divided by four, which is a serviceable guess and wrong
// by enough to matter on a long chat. Needs no permission. Answers null on any
// build or model where it does not resolve, and the panel says "roughly" again.
async function countTokens(text: string, context: any, userId?: string): Promise<number | null> {
  try {
    if (!text || !spindle.tokens || typeof spindle.tokens.countText !== 'function') return null;
    const model = context && (context.model || context.modelId);
    const res = await spindle.tokens.countText(text, { model: model, userId: userId });
    const n = res && Number(res.total_tokens);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch (_) {
    return null;
  }
}

function snapshotPrompt(messages: any[], context: any, userId?: string, noteAt?: { from: number; count: number }): void {
  const watcher = promptWatcherFor(userId);
  if (watcher == null || !Array.isArray(messages)) return;
  // An empty key is a host that does not name its users, where a broadcast and
  // a targeted send reach the same one person.
  const to = watcher === '' ? undefined : watcher;
  try {
    const out: any[] = [];
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (!m) continue;
      // The extension's own notes, marked so the panel can point at them. Where
      // a note lands is the whole question someone opens this view to answer,
      // and it is not something they can work out by reading the text.
      const isNote =
        !!noteAt && i >= noteAt.from && i < noteAt.from + noteAt.count;
      out.push({
        role: String(m.role == null ? '' : m.role),
        content: String(m.content == null ? '' : m.content),
        // Marks the messages that came from stored chat turns, which is what
        // separates the conversation from everything wrapped around it.
        history: !!m.__isChatHistory,
        note: isNote,
        noteIndex: isNote ? i - noteAt!.from + 1 : 0,
      });
    }
    const at = Math.max(Date.now(), lastSnapshotAt + 1);
    lastSnapshotAt = at;
    // The chat this belongs to, so the panel can tell whether the prompt it is
    // holding is for the chat you are actually looking at. Snapshots are
    // addressed to a person, not to a window, so somebody with two chats open
    // in two tabs has both of them receiving every prompt either one produces.
    // The generation type used to ride along here too and nothing ever read it.
    replyTo(to, {
      type: 'prompt_snapshot',
      at: at,
      chatId: context && context.chatId ? String(context.chatId) : '',
      messages: out,
      total: messages.length,
      notes: noteAt ? noteAt.count : 0,
    });
    // Sent as a second message so a slow tokeniser never delays the view. The
    // panel shows its own estimate until this lands, and replaces it if it does.
    countTokens(messages.map((m: any) => String((m && m.content) || '')).join('\n'), context, to)
      .then((tokens) => {
        if (tokens == null) return;
        replyTo(to, { type: 'prompt_tokens', at: at, tokens: tokens });
      })
      .catch(() => {});
  } catch (_) { /* a viewer must never cost anyone their generation */ }
}

// Where the note sits relative to the conversation. __isChatHistory marks the
// messages that came from stored chat turns, so "after the last message" means
// after the last real one rather than after whatever the host appended behind
// it. With nothing marked, the ends of the array are the best guess available.
function placeNotes(messages: any[], notes: any[], placement: string): { list: any[]; from: number } {
  const list = messages.slice();
  if (placement === 'start') {
    list.unshift.apply(list, notes);
    return { list: list, from: 0 };
  }
  let last = -1;
  for (let i = 0; i < list.length; i++) if (list[i] && list[i].__isChatHistory) last = i;
  if (last < 0) last = list.length - 1;
  const at = placement === 'before' ? Math.max(0, last) : last + 1;
  // Inserted in one go so they stay in the order they were written, which is
  // what lets a note answer the one before it.
  list.splice.apply(list, ([at, 0] as any[]).concat(notes));
  return { list: list, from: at };
}

// Messages a swap has already changed this session, so the manual button won't
// compound swaps on a reply that auto-swap or an earlier tap already changed.
const swappedIds = new Set<string>();
const SWAPPED_CAP = 1000;
function markSwapped(id: any) {
  if (id == null) return;
  swappedIds.add(id);
  if (swappedIds.size > SWAPPED_CAP) swappedIds.delete(swappedIds.values().next().value as string);
}

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
// Whole-word matching, without \b. JavaScript defines \b against \w, which is
// [A-Za-z0-9_] and stays that way even under the u flag. So "\bcafé\b" never
// matches anything: the boundary test fails at the é. Every single-word rule
// whose source was not pure ASCII was therefore compiled and then silently
// matched nothing, in French, Spanish, German, Polish, Turkish, Greek, Russian
// and everything else outside plain English. Lookarounds over \p{L} and \p{N}
// do what \b was meant to do here, and still refuse to fire inside a longer
// word, so "cat" leaves "category" alone.
const WORD_BEFORE = '(?<![\\p{L}\\p{N}_])';
const WORD_AFTER = '(?![\\p{L}\\p{N}_])';

function buildCombined(gs: Group[], cs: boolean): RegExp | null {
  if (!gs.length) return null;
  // Longest source first. A regex alternation takes the first branch that
  // matches, so without this "cat" would win over "cat nap" and the longer
  // rule would never fire. Equal lengths keep the order they were listed in.
  combinedOrder = gs.map((_, i) => i).sort((a, b) =>
    (gs[b].from.length - gs[a].from.length) || (a - b));
  const assemble = (before: string, after: string) =>
    '(?:' +
    combinedOrder
      .map((i) => {
        const body = escapeRe(gs[i].from);
        return '(' + (gs[i].isWord ? before + body + after : body) + ')';
      })
      .join('|') +
    ')( ?)';
  const flags = cs ? 'gu' : 'giu';
  try {
    return new RegExp(assemble(WORD_BEFORE, WORD_AFTER), flags);
  } catch (_) { /* no lookbehind on this engine */ }
  // A browser too old for lookbehind keeps the ASCII-only behaviour it had
  // before, rather than losing word swaps altogether.
  try {
    return new RegExp(assemble('\\b', '\\b'), flags);
  } catch (__) {
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
  // Any uppercase letter, not just the Latin-1 ones. Whole-word matching uses
  // \p{L}, so a word in Cyrillic, Greek, Turkish, Polish, Czech or Vietnamese
  // was matched and swapped and then quietly lost its capital, because the test
  // for one stopped at \u00DE.
  if (/^\p{Lu}/u.test(sample)) return repl.charAt(0).toUpperCase() + repl.slice(1);
  return repl;
}

function applyRules(text: string, seen?: Array<[string, string]>): string {
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
    const out = repl === '' ? '' : repl + trail;   // deletion also drops one trailing space
    // Recorded so the frontend can apply the same change to what is on screen.
    // The host writes the message but does not redraw the chat view for it.
    if (seen && matched + trail !== out) seen.push([matched + trail, out]);
    return out;
  });
}

// Writes swapped text back. The chat view redraws on SWIPE_EDITED and not on
// MESSAGE_EDITED, and the host emits SWIPE_EDITED when the patch names any one
// of swipes, swipe_id or swipe_dates. A message carrying a usable swipe array
// gets the active slot rewritten to the same text the content patch sets, so
// the message is identical either way. A message without one still names its
// active index, which is enough for the redraw and changes nothing: without it
// the swap saved correctly and then sat unseen until the chat was reopened,
// which is what made a swap look like it had not happened.
async function writeSwapped(chatId: string, m: any, next: string): Promise<void> {
  const patch: any = { content: next };
  const swipes = m && Array.isArray(m.swipes) ? m.swipes.slice() : null;
  const idx = m && typeof m.swipe_id === 'number' ? m.swipe_id : 0;
  if (swipes && swipes.length > 0 && idx >= 0 && idx < swipes.length) {
    swipes[idx] = next;
    patch.swipes = swipes;
    patch.swipe_id = idx;
  } else {
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
  // The extension's own master switch, not the swap one. Its description says
  // "turn it off and it does nothing", and rewriting somebody's saved replies
  // while it is off is emphatically something. Absent means on, so a settings
  // object from before this was read does not switch swapping off by surprise.
  masterOn = s.enabled !== false;
  enabled = !!s.replaceEnabled;
  random = !!s.replaceRandom;
  caseSensitive = !!s.replaceCaseSensitive;
  rulesText = String(s.replaceRules == null ? '' : s.replaceRules);
  allowReSwap = !!s.allowReSwap;
  confirmBeforeEdit = !!s.confirmBeforeEdit;
  waitForOtherEdits = !!s.swapWaitForEdits;
  const secs = Number(s.swapWaitSecs);
  // The clamp matches the panel's own range. It said 120 while the panel said
  // 300, so anything above two minutes was quietly cut back to two.
  waitStartMs = Number.isFinite(secs) && secs > 0
    ? Math.min(300, Math.max(1, Math.round(secs))) * 1000
    : 85000;
  rebuild();
}

// ---- the settle gate ----
// Another extension may rewrite the same reply asynchronously after it lands.
// Hone's auto-refine is the case this exists for: it runs a second LLM pass off
// GENERATION_ENDED and saves the result seconds later, so a swap applied the
// instant the reply arrived was overwritten by that rewrite. Nothing about
// another extension is detectable from here, so rather than trying to know who
// else is editing, this waits for the message to stop changing.
const SETTLE_MS = 1500;      // quiet period after an edit before swapping
// Ceiling, so a reply that never settles is still swapped. It has to clear the
// longest wait the panel offers plus a few settle rounds on top, or the ceiling
// would cut a refinement short that the wait was set long enough for.
const MAX_WAIT_MS = 420000;
const RESWAP_CAP = 3;        // re-assertions per message, so two extensions cannot ping-pong
const OURWRITES_CAP = 200;

const pendingSwaps = new Map<string, any>();
const ourWrites = new Map<string, string>();
const reswapCount = new Map<string, number>();

const swapKey = (c: any, m: any) => String(c) + ':' + String(m);

function rememberWrite(k: string, text: string) {
  ourWrites.set(k, text);
  if (ourWrites.size > OURWRITES_CAP) ourWrites.delete(ourWrites.keys().next().value as string);
}

// Reads the message at the moment of the swap rather than using the text the
// end event carried. That is what lets a deferred swap apply on top of another
// extension's rewrite instead of replacing it with the pre-rewrite reply.
// userId is threaded all the way down because sendToFrontend without one
// broadcasts to every connected user on an operator-scoped install: one
// person's "apply your word swaps?" prompt reached everybody, and so did the
// text of the swap. It is undefined on a user-scoped install, where the host
// ignores the argument, so this costs nothing there.
async function swapMessageNow(chatId: string, messageId: any, userId?: string): Promise<void> {
  if (!groups.length) return;
  let m: any = null;
  try {
    const msgs = await spindle.chat.getMessages(chatId);
    if (!Array.isArray(msgs) || !msgs.length) return;
    // The opening message is authored, not generated, so it is never swapped.
    const greetingId = (msgs[0] && msgs[0].role === 'assistant') ? msgs[0].id : null;
    if (messageId != null && greetingId != null && messageId === greetingId) return;
    m = msgs.find((x: any) => x && x.id === messageId && x.role === 'assistant') || null;
  } catch (_) { return; }
  if (!m) return;
  const content = String(m.content == null ? '' : m.content);
  const pairs: Array<[string, string]> = [];
  const next = applyRules(content, pairs);
  if (next === content) return;
  if (confirmBeforeEdit) {
    // Ask first; the frontend sends apply_replace_now for this reply if the user agrees.
    replyTo(userId, { type: 'confirm_edit', chatId: chatId, messageId: messageId, requestId: 'ar-auto-' + Date.now() });
    return;
  }
  rememberWrite(swapKey(chatId, messageId), next);
  await writeSwapped(chatId, m, next);
  markSwapped(messageId);
  // Both halves of the message go with the pairs. The pairs patch what is on
  // screen; the halves let the frontend recognise the pre-swap text if the host
  // hands it back in its edit box, which it does when its own copy of the
  // message did not pick the change up.
  replyTo(userId, {
    type: 'swapped',
    chatId: chatId,
    messageId: messageId,
    pairs: pairs,
    before: content,
    after: next,
  });
}

function scheduleSwap(chatId: string, messageId: any, sawEdit: boolean, userId?: string) {
  const k = swapKey(chatId, messageId);
  let p = pendingSwaps.get(k);
  if (!p) { p = { capAt: Date.now() + MAX_WAIT_MS, timer: null }; pendingSwaps.set(k, p); }
  if (p.timer) clearTimeout(p.timer);
  // The owner is remembered from whichever event scheduled the swap first, so a
  // deferred swap still replies to that user and not to everyone.
  if (userId != null) p.userId = userId;
  const want = sawEdit ? SETTLE_MS : waitStartMs;
  const left = Math.max(0, p.capAt - Date.now());
  p.timer = setTimeout(() => {
    pendingSwaps.delete(k);
    swapMessageNow(chatId, messageId, p.userId).catch(() => {});
  }, Math.max(0, Math.min(want, left)));
}

function clearPending(chatId: any, messageId: any) {
  const k = swapKey(chatId, messageId);
  const p = pendingSwaps.get(k);
  if (p) { if (p.timer) clearTimeout(p.timer); pendingSwaps.delete(k); }
}

// An edit by anything other than us. While a swap is pending this pushes it
// back; after one has landed it re-asserts, capped, for the case where the
// other extension finished later than the wait allowed for.
function onForeignEdit(chatId: any, messageId: any, content: string, userId?: string) {
  if (!enabled || !groups.length || !chatId || messageId == null) return;
  const k = swapKey(chatId, messageId);
  if (ourWrites.get(k) === content) return; // the event our own write raised
  if (!pendingSwaps.has(k)) {
    if (!waitForOtherEdits) return;
    if (!swappedIds.has(messageId)) return; // never a message we have not touched
    const n = (reswapCount.get(k) || 0) + 1;
    if (n > RESWAP_CAP) return;
    reswapCount.set(k, n);
  }
  scheduleSwap(chatId, messageId, true, userId);
}

const readEdit = (p: any) => {
  try {
    if (!p || !p.chatId || !p.message) return;
    onForeignEdit(p.chatId, p.message.id, String(p.message.content == null ? '' : p.message.content), p.userId);
  } catch (_) {}
};
try { spindle.on('MESSAGE_EDITED', readEdit); } catch (_) {}
try { spindle.on('SWIPE_EDITED', readEdit); } catch (_) {}

// Load persisted settings on startup. There is no userId here, so this only
// resolves on a user-scoped install where userStorage can infer the owner.
// Everywhere else it finds nothing and the state stays at its defaults until a
// panel loads or saves, which is why load_settings applies what it reads rather
// than only handing it back. One rule set per process either way, so on a
// multi-account install it belongs to whoever loaded or saved last.
(async () => {
  try {
    const s = await readUserJson(SETTINGS_FILE);
    if (s && typeof s === 'object') applyReplaceFromSettings(s);
  } catch (_) { /* no account settings yet */ }
})();

// Settings bridge with the UI: save the whole settings object to per-user
// account storage, hand it back on request, and keep the find-and-replace state
// in sync with it.
spindle.onFrontendMessage(async (payload: any, userId?: string) => {
  try {
    if (!payload) return;
    if (payload.type === 'save_settings' && payload.settings && typeof payload.settings === 'object') {
      applyReplaceFromSettings(payload.settings);
      await writeUserJson(SETTINGS_FILE, payload.settings, userId);
      return;
    }
    if (payload.type === 'load_settings') {
      let settings: any = null;
      try { settings = await readUserJson(SETTINGS_FILE, userId); } catch (__) { settings = null; }
      // Adopted here, not just handed back. This runs on every page load and it
      // is the only path that arrives with a userId, so it is the one that can
      // resolve per-user storage. The startup read above cannot: it has no user
      // to read for, and says so. Without this the swap state stayed at its
      // defaults until the panel was opened and Save pressed, so automatic
      // swapping did nothing while the manual buttons worked, because those
      // only ask whether there are rules and never look at the switch.
      //
      // On a multi-account install this is still one rule set for the whole
      // process, which it always was. What changes is which user sets it: it
      // was whoever saved first, and it is now whoever loaded or saved last.
      if (settings && typeof settings === 'object') applyReplaceFromSettings(settings);
      replyTo(userId, { type: 'loaded_settings', requestId: payload.requestId, settings: settings });
      return;
    }
    // Which chat the user is looking at. The frontend cannot ask for this
    // itself: chats is a backend permission, and there is no frontend event
    // that reports the current chat without something happening in it first.
    // Answers null rather than failing when the permission is not granted, so
    // the panel falls back to waiting to be told, exactly as it did before.
    if (payload.type === 'get_active_chat') {
      let chatId: string | null = payload.chatId ? String(payload.chatId) : null;
      let character: string | null = null;
      try {
        let chat: any = null;
        if (chatId && spindle.chats && typeof spindle.chats.get === 'function') {
          chat = await spindle.chats.get(chatId, userId);
        } else if (spindle.chats && typeof spindle.chats.getActive === 'function') {
          chat = await spindle.chats.getActive(userId);
          chatId = (chat && chat.id) || null;
        }
        // A chat can hold several cards, with character_id naming the one it
        // belongs to. The primary is the useful answer here: the panel wants a
        // word for which chat this is, not a cast list.
        const cardId = chat && chat.character_id;
        if (cardId && spindle.characters && typeof spindle.characters.get === 'function') {
          const card = await spindle.characters.get(cardId, userId);
          const name = card && card.name;
          character = name ? String(name) : null;
        }
      } catch (_) { /* no chats or characters permission: answer with what we have */ }
      replyTo(userId, {
        type: 'active_chat',
        requestId: payload.requestId,
        chatId: chatId,
        character: character,
      });
      return;
    }
    if (payload.type === 'set_chats_off') {
      const list = Array.isArray(payload.chats) ? payload.chats : [];
      chatsOff = new Set(list.slice(0, 500).map((c: any) => String(c)));
      return;
    }
    if (payload.type === 'get_permissions') {
      // getGranted is a roundtrip to the host and is the authoritative answer,
      // where has() reads a cache. This is the one place worth paying for it: a
      // panel opening is rare, and this is the answer somebody acts on. A build
      // without it falls back to the cache.
      let granted: Record<string, boolean | null> | null = null;
      try {
        const perms: any = (spindle as any).permissions;
        if (perms && typeof perms.getGranted === 'function') {
          const live = await perms.getGranted();
          if (Array.isArray(live) && live.every((x: any) => typeof x === 'string'))
            granted = grantedMap({ allGranted: live });
        }
      } catch (_) {}
      replyTo(userId, {
        type: 'permissions',
        requestId: payload.requestId,
        list: PERMISSIONS,
        granted: granted || grantedMap(),
      });
      return;
    }
    if (payload.type === 'set_prompt_capture') {
      const k = watcherKey(userId);
      if (payload.on) promptWatchers.add(k);
      else promptWatchers.delete(k);
      return;
    }
    if (payload.type === 'arm_refusal_note') {
      const raw = Array.isArray(payload.notes) ? payload.notes : [];
      const notes: Array<{ text: string; role: string }> = [];
      for (const n of raw.slice(0, MAX_NOTES)) {
        // Trimmed to decide whether it is empty, and not otherwise. What goes
        // into the prompt is what was typed, spacing and all.
        const text = String(n && n.text != null ? n.text : '');
        if (!text.trim()) continue;
        notes.push({ text: text, role: NOTE_ROLES.indexOf(String(n && n.role)) >= 0 ? String(n.role) : 'system' });
      }
      refusalNote = notes.length && payload.chatId
        ? {
            chatId: String(payload.chatId),
            notes: notes,
            placement: String(payload.placement || 'after'),
            at: Date.now(),
            strictType: !!payload.strictType,
          }
        : null;
      // Acknowledged so the frontend can hold the retry click until the note is
      // actually in place. The arm travels this bridge while the click travels
      // the DOM to the host to the server, and those are independent: the click
      // could otherwise reach prompt assembly first and the note would be
      // silently dropped from that generation.
      replyTo(userId, { type: 'note_armed', requestId: payload.requestId, armed: !!refusalNote });
      return;
    }
    if (payload.type === 'save_presets' && payload.presets && typeof payload.presets === 'object') {
      await writeUserJson(PRESETS_FILE, payload.presets, userId);
      return;
    }
    if (payload.type === 'load_presets') {
      let presets: any = null;
      try { presets = await readUserJson(PRESETS_FILE, userId); } catch (__) { presets = null; }
      replyTo(userId, { type: 'loaded_presets', requestId: payload.requestId, presets: presets });
      return;
    }
    if (payload.type === 'apply_replace_now') {
      let ok = true, found = false, changed = 0, skipped = 0;
      // Literal substitutions made, passed back so the frontend can update the
      // rendered text. The host saves the message without redrawing the chat.
      const pairs: Array<[string, string]> = [];
      // One entry per reply actually rewritten, so the frontend can recognise
      // the pre-swap text of any of them.
      const edits: Array<{ messageId: any; before: string; after: string }> = [];
      try {
        const chatId = payload.chatId;
        const wantId = payload.messageId;
        if (chatId && groups.length) {
          const msgs = await spindle.chat.getMessages(chatId);
          const targets: any[] = [];
          if (Array.isArray(msgs)) {
            // The opening/greeting message is authored, not generated, so never swap it.
            const greetingId = (msgs.length && msgs[0] && msgs[0].role === 'assistant') ? msgs[0].id : null;
            if (payload.wholeChat) {
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
            // A deferred swap waiting on this same reply is dropped, so the two
            // cannot both fire and stack.
            clearPending(chatId, m.id);
            // Skip replies already swapped this session unless re-swapping is allowed.
            if (!allowReSwap && swappedIds.has(m.id)) { skipped++; continue; }
            const content = String(m.content == null ? '' : m.content);
            const next = applyRules(content, pairs);
            if (next !== content) {
              rememberWrite(swapKey(chatId, m.id), next);
              await writeSwapped(chatId, m, next);
              changed++;
              markSwapped(m.id);
              edits.push({ messageId: m.id, before: content, after: next });
            }
          }
        }
      } catch (_) { ok = false; }
      replyTo(userId, { type: 'replace_now_result', requestId: payload.requestId, ok: ok, hasRules: groups.length > 0, found: found, changed: changed, skipped: skipped, pairs: pairs, edits: edits });
      return;
    }
  } catch (_) {
    try { spindle.log.warn('auto-retry: could not handle a settings message'); } catch (__) {}
  }
});

// After each finished reply, apply the rules to the saved message, either now or
// once the reply has stopped being edited by anything else.
spindle.on('GENERATION_ENDED', async (p: any) => {
  try {
    if (!masterOn || !enabled || !groups.length) return;
    if (!p || p.error || !p.chatId) return;
    // Left alone means left alone, including by this.
    if (chatsOff.has(String(p.chatId))) return;
    const chatId = p.chatId;
    let messageId = p.messageId;
    if (!messageId) {
      // Not every build puts the id on the end event, so the newest assistant
      // reply stands in. swapMessageNow rules out the greeting either way.
      try {
        const msgs = await spindle.chat.getMessages(chatId);
        if (Array.isArray(msgs)) {
          for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i] && msgs[i].role === 'assistant') { messageId = msgs[i].id; break; }
          }
        }
      } catch (_) {}
    }
    if (!messageId) return;
    if (waitForOtherEdits) { scheduleSwap(chatId, messageId, false, p.userId); return; }
    await swapMessageNow(chatId, messageId, p.userId);
  } catch (e: any) {
    if (!warnedEditError) {
      warnedEditError = true;
      try { spindle.log.warn('auto-retry replace: ' + (e && e.message ? e.message : String(e)) + ' (further errors suppressed; if this is a permission error, grant chat editing)'); } catch (__) {}
    }
  }
});

// Runs after the prompt is assembled and before it reaches the model. Priority
// 150 rather than the default 100 so the note lands after anything another
// extension adds, which is what "closest to the model" has to mean to be worth
// choosing.
const promptInterceptor = async (messages: any[], context: any) => {
  try {
    const who = context && context.userId;
    if (!refusalNote) {
      snapshotPrompt(messages, context, who);
      return messages;
    }
    const chatId = context && context.chatId;
    // A note armed in one chat is not for a generation in another, and it
    // stays armed so the retry it was meant for can still collect it.
    if (chatId && refusalNote.chatId && String(chatId) !== refusalNote.chatId) {
      snapshotPrompt(messages, context, who);
      return messages;
    }
    const type = String((context && context.generationType) || '');
    // Only when the user asked for it. Left on by default this rejected every
    // generation on any build that reports "normal", which is the bug that
    // made the note look like it did nothing at all.
    if (refusalNote.strictType && type && RETRY_TYPES.indexOf(type.toLowerCase()) < 0) {
      snapshotPrompt(messages, context, who);
      // Named rather than swallowed. A note that never appears looks the same
      // whether it was never armed or the host called this generation
      // something else, and only one of those is fixable by the user. The
      // note stays armed: with the strict check on, the point is to wait for
      // a generation the host does call a retry.
      try { replyTo(who, { type: 'note_skipped', reason: 'the strict check is on and the host called this generation "' + type + '"' }); } catch (__) {}
      return messages;
    }
    const armed = refusalNote;
    refusalNote = null; // one generation, collected or not
    if (Date.now() - armed.at > NOTE_MAX_AGE_MS) {
      try { replyTo(who, { type: 'note_skipped', reason: 'it was armed too long ago to still belong to this generation' }); } catch (__) {}
      snapshotPrompt(messages, context, who);
      return messages;
    }
    if (!Array.isArray(messages)) return messages;
    const built = armed.notes.map((n) => ({ role: n.role, content: n.text }));
    const placed = placeNotes(messages, built, armed.placement);
    // Named in the Prompt Breakdown so each note is inspectable rather than
    // something that silently happened to the prompt.
    const breakdown = built.map((_, i) => ({
      messageIndex: placed.from + i,
      name: built.length > 1 ? 'Auto Retry refusal note ' + (i + 1) : 'Auto Retry refusal note',
    }));
    // Said out loud, so "did my note go?" has an answer in the live log
    // instead of being something the user has to infer from the reply.
    try { replyTo(who, { type: 'note_sent', count: built.length, generationType: type }); } catch (__) {}
    // After the note is in, so the panel shows what actually went rather than
    // what would have gone without it.
    snapshotPrompt(placed.list, context, who, { from: placed.from, count: built.length });
    return { messages: placed.list, breakdown: breakdown };
  } catch (_) {
    return messages; // a fault here must never cost the user their generation
  }
};

// Registering an interceptor without the permission does not throw. It is a
// silent no-op, and the host notifies instead. Registering once as this module
// loaded was therefore a bet that the grant was already in the local cache at
// that moment, and a grant can be given or taken away while the extension runs
// with nothing restarting. Lose that bet and the interceptor never exists: no
// refusal note is ever added and no prompt ever reaches the Prompt tab, with
// nothing anywhere saying why. The documented shape is this one, try at
// startup, try again on the grant, and keep a flag so a second grant does not
// register twice.
// Every permission this extension asks for, and what stops working without it.
// A missing permission is the one failure that raises nothing to catch: a gated
// event simply never fires and a fire-and-forget registration silently does
// nothing, so an extension with the wrong grants sits there looking installed
// and working. The panel asks for this and says which are missing.
const PERMISSIONS: Array<{ name: string; costs: string }> = [
  { name: 'generation', costs: 'Everything. Retries run off the generation events, and without this none of them arrive, so nothing is ever retried.' },
  { name: 'interceptor', costs: 'The refusal note, and the Prompt tab.' },
  { name: 'chat_mutation', costs: 'Word swaps. Nothing can be written back to a reply.' },
  { name: 'chats', costs: 'The chat name in the log, and knowing which chat you are in without a reply first.' },
  { name: 'characters', costs: 'The character name in the log.' },
  { name: 'ui_panels', costs: 'The floating button. The on-screen panel falls back to its own window.' },
];
// null where the host is too old to say, which is not the same as denied and is
// not worth showing as one.
//
// Given the event from onChanged, that event is believed over has(). has()
// reads a local cache the host keeps in step, and inside the very callback
// announcing a change it can still hold the answer from before it: asking it
// there reported a permission as refused at the moment it was granted, and the
// panel put the note back up on the grant that should have taken it down.
function grantedMap(e?: any): Record<string, boolean | null> {
  const all = e && e.allGranted;
  // allGranted is the full list of what is granted after the change, as an
  // array of names. Anything else arriving in that field is not a list this can
  // read, so it backs off to the cache rather than guessing: read wrongly it
  // answers no to every permission, which is a panel full of refusals that are
  // not real. An empty list is a real answer and means nothing is granted.
  const usable = Array.isArray(all) && all.every((x: any) => typeof x === 'string');
  const fromAll = (name: string): boolean | null =>
    usable ? all.indexOf(name) >= 0 : null;
  const out: Record<string, boolean | null> = {};
  for (const p of PERMISSIONS) {
    let v: boolean | null = fromAll(p.name);
    if (v === null) {
      try {
        const perms: any = (spindle as any).permissions;
        if (perms && typeof perms.has === 'function') v = !!perms.has(p.name);
      } catch (_) {}
    }
    // The one the event is actually about, straight from the event.
    if (e && e.permission === p.name && typeof e.granted === 'boolean') v = e.granted;
    out[p.name] = v;
  }
  return out;
}

let interceptorOn = false;
function tryRegisterInterceptor(): void {
  if (interceptorOn) return;
  try {
    const perms: any = (spindle as any).permissions;
    // A build too old to have permissions.has gets the old behaviour, which is
    // to register and let the host decide.
    if (perms && typeof perms.has === 'function' && !perms.has('interceptor')) return;
  } catch (_) {}
  try {
    spindle.registerInterceptor(promptInterceptor, 150);
    interceptorOn = true;
  } catch (_) {
    try { spindle.log.warn('auto-retry: could not register the interceptor; the refusal note will not be sent'); } catch (__) {}
  }
}
tryRegisterInterceptor();
try {
  (spindle as any).permissions.onChanged((e: any) => {
    if (e && e.permission === 'interceptor' && e.granted) tryRegisterInterceptor();
    // Grants change while the extension runs and nothing restarts, so a panel
    // that is open is told rather than left showing what was true when it
    // opened.
    try { replyTo(undefined, { type: 'permissions', list: PERMISSIONS, granted: grantedMap(e) }); } catch (__) {}
  });
} catch (_) {}
// The only way to find out a fire-and-forget registration was refused. Said in
// the log rather than swallowed, since the two features it takes out both look
// like nothing happening.
try {
  (spindle as any).permissions.onDenied((e: any) => {
    if (e && e.permission === 'interceptor')
      try { spindle.log.warn('auto-retry: the interceptor permission is not granted, so the refusal note and the Prompt tab will not work'); } catch (__) {}
  });
} catch (_) {}

// Said out loud once this module is listening. A panel that asked to be sent
// prompts has no way to know the backend was not up yet, or has restarted since
// and forgotten, and its request is a one-off. Hearing this, it asks again.
try { replyTo(undefined, { type: 'backend_ready' }); } catch (_) {}

try { spindle.log.info('Auto Retry backend loaded (find and replace in replies).'); } catch (_) {}
