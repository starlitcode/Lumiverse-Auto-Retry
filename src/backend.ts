/*
 * Auto Retry backend.
 *
 * Three jobs.
 *
 * It keeps the whole settings object in per-user account storage, so somebody's
 * settings follow them across browsers and devices instead of living in one
 * browser. Settings arrive from the panel over the frontend message bridge and
 * are persisted so they survive a restart.
 *
 * And it carries the refusal note: the wording the panel arms just before it
 * clicks retry, collected by the prompt interceptor on the generation that
 * click starts, then thrown away. One generation only.
 *
 * And it sends the prompt several times at once when "Several tries at once"
 * is on, then adds the reply the panel picks to the chat as a new reroll, or
 * as a new reply when the failed turn saved none.
 *
 * Needs the `generation` permission to hear when a reply finishes and to send
 * the tries, `interceptor` for the refusal note, `chat_mutation` to add a
 * reroll or a reply, and `chats` to see whether a chat is a group chat before
 * adding a reply.
 */

declare const spindle: any;

// The build this half is running. An update pulls the repo, rebuilds if it has
// to, and restarts the backend runtime. It does not reach into a browser tab
// that is already open, so that tab goes on running the frontend it loaded
// with while this side comes back on the new build. A debug report naming only
// the panel's version would be speaking for a file it cannot see, so the panel
// asks for this one and prints both.
const VERSION = '5.24.0';

const SETTINGS_FILE = 'settings.json';
// Presets, kept in account storage next to the settings so they
// follow the user between devices. The browser copy is a fast local cache, not
// the only copy.
const PRESETS_FILE = 'presets.json';

// ---- per-user storage ----
// One backend process can serve every account on the server. spindle.storage
// resolves to a single shared directory in that case, so settings and presets
// written through it were pooled across accounts: one person's settings could
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
      // Read again from the old store next time, so a failed move is not lost.
      try { await spindle.userStorage.setJson(file, legacy, { userId: userId }); } catch (e: any) {
        try { spindle.log.warn('auto-retry: could not move ' + file + ' to the account, so it is read from the old store for now: ' + ((e && e.message) || String(e))); } catch (__) {}
      }
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
    } catch (_) { /* fall through so a save is never lost with no message */ }
  }
  await spindle.storage.write(file, JSON.stringify(value));
}

// Writes for one account, one after another. A save runs only once the one
// before it has finished, so the last one sent is the last one written. Two
// saves close together, written at once, can finish the older one last and
// leave it as the copy every browser loads. Settings and presets each have
// their own line, so a save of one never waits on a save of the other.
const settingsWrites = new Map<string, Promise<void>>();
const presetWrites = new Map<string, Promise<void>>();
const stateWrites = new Map<string, Promise<void>>();
// The chats switched off, and the notices the reader has already read.
const STATE_FILE = 'state.json';
function inTurn(queue: Map<string, Promise<void>>, userId: string | undefined, job: () => Promise<void>): Promise<void> {
  const k = String(userId == null ? '' : userId);
  const before = queue.get(k) || Promise.resolve();
  const next = before.then(job, job);
  const held = next.catch(() => {});
  queue.set(k, held);
  // Dropped once it is the last in line, so the map holds nothing for an
  // account that is not saving.
  held.then(() => {
    if (queue.get(k) === held) queue.delete(k);
  });
  return next;
}

// ---- the replies a retry replaced ----
// The panel keeps the last reply a retry replaced in each chat. A copy is held
// here as well, per account, so the panel can ask for it again after a reload.
// Memory only, unless the account has Keep it through an update on: then it is
// also written to that account's storage, so an update or a restart keeps it.
const REPLACED_FILE = 'replaced.json';
const REPLACED_PER_USER = 8;
const REPLACED_TEXT_MAX = 200000;
type Replaced = { chatId: string; text: string; reason: string; at: number };
const replacedKept = new Map<string, Replaced[]>();
const replacedRead = new Set<string>();
const replacedSavedWas = new Map<string, boolean>();
const replacedWrites = new Map<string, Promise<void>>();
const userKey = (userId: any): string => String(userId == null ? '' : userId);
function replacedFor(userId: any): Replaced[] {
  const k = userKey(userId);
  let list = replacedKept.get(k);
  if (!list) {
    list = [];
    replacedKept.set(k, list);
  }
  return list;
}
function cleanReplaced(r: any): Replaced | null {
  if (!r || typeof r !== 'object') return null;
  const text = String(r.text == null ? '' : r.text).slice(-REPLACED_TEXT_MAX);
  if (!text.trim()) return null;
  const at = Number(r.at);
  return {
    chatId: String(r.chatId == null ? '' : r.chatId),
    text: text,
    reason: String(r.reason == null ? '' : r.reason).slice(0, 300),
    at: isFinite(at) && at > 0 ? at : Date.now(),
  };
}
// Writes this account's list, or an empty one when saving is off, so turning
// the switch off removes the saved copy. With it off, only the first message
// after it was turned off writes anything.
//
// The saved copy is read in first, so a write made before the panel has asked
// for the list cannot overwrite replies saved before a restart. When this
// module has not seen the switch yet, off still writes the empty list once, as
// the saved copy may be from before the switch was turned off.
async function saveReplaced(userId: any, on: boolean): Promise<void> {
  const k = userKey(userId);
  const was = replacedSavedWas.get(k);
  replacedSavedWas.set(k, on);
  if (!on && was === false) return;
  if (on) await readReplaced(userId);
  else replacedRead.add(k);
  const value = on ? replacedFor(userId).slice() : [];
  return inTurn(replacedWrites, userId, async () => {
    try {
      await writeUserJson(REPLACED_FILE, value, userId);
    } catch (e) {
      try { spindle.log.warn('auto-retry: could not save the replaced replies to the account'); } catch (__) {}
      replyTo(userId, { type: 'account_save_failed', what: 'replaced' });
    }
  });
}
// The saved copy is read once per account, on the first ask after this module
// starts, and only when the account keeps one. What is already in memory is
// newer and wins.
async function readReplaced(userId: any): Promise<void> {
  const k = userKey(userId);
  if (replacedRead.has(k)) return;
  replacedRead.add(k);
  let got: any = null;
  try { got = await readUserJson(REPLACED_FILE, userId); } catch (_) { got = null; }
  if (!Array.isArray(got)) return;
  const list = replacedFor(userId);
  for (const raw of got.slice(0, REPLACED_PER_USER)) {
    const r = cleanReplaced(raw);
    if (r && !list.some((x) => x.chatId === r.chatId)) list.push(r);
  }
  list.sort((a, b) => a.at - b.at);
  while (list.length > REPLACED_PER_USER) list.shift();
}

// ---- thinking markers saved on a connection ----
// The thinking start and end a reader saved on a connection, under Lumiverse's
// Reasoning settings. The panel does the stripping, so they are sent there as
// written. Read at most once a minute per account. The global Reasoning
// settings cannot be read by an extension, so a marker set only there is not
// found here.
const MARKS_FRESH_MS = 60000;
const marksBy = new Map<string, { at: number; pairs: Array<{ open: string; close: string }> }>();
function marksFrom(list: any): Array<{ open: string; close: string }> {
  const out: Array<{ open: string; close: string }> = [];
  if (!Array.isArray(list)) return out;
  for (const c of list) {
    const set = c && c.reasoning_bindings && c.reasoning_bindings.settings;
    if (!set) continue;
    // Lumiverse trims line breaks off both ends of each marker. One under 3
    // characters could be ordinary punctuation in a reply, so it is skipped.
    const open = String(set.prefix == null ? '' : set.prefix).replace(/^\n+|\n+$/g, '');
    const close = String(set.suffix == null ? '' : set.suffix).replace(/^\n+|\n+$/g, '');
    if (open.trim().length < 3 || close.trim().length < 3 || open.length > 80 || close.length > 80) continue;
    if (out.some((p) => p.open === open && p.close === close)) continue;
    out.push({ open: open, close: close });
    if (out.length >= 10) break;
  }
  return out;
}

// Replying without a userId broadcasts to every connected user on an
// operator-scoped install, so every reply to a frontend message carries the id
// of whoever sent it. A user-scoped install ignores the argument.
// With a tab named, only that tab gets the message. A Lumiverse that does not
// know the third argument ignores it and sends to every tab.
function replyTo(userId: string | undefined, msg: any, tab?: string): void {
  try {
    if (tab) spindle.sendToFrontend(msg, userId, { frontendSessionId: tab });
    else spindle.sendToFrontend(msg, userId);
  } catch (_) {}
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
// What the host calls the generation is not one of the guards, on purpose.
// Most builds report "normal" for everything, including a regenerate, so
// requiring "regenerate" or "swipe" would mean no note ever goes out. Users who
// know their build reports it properly can ask for that check with strictType.
// tab is the browser tab that armed the note, which is the tab retrying.
interface RefusalNote { chatId: string; notes: Array<{ text: string; role: string }>; placement: string; at: number; strictType: boolean; tab: string; }
// One per chat. One backend can serve several accounts, and a single slot let
// a note armed in one account's chat replace one armed a moment earlier in
// another's, so that retry went out without the note it was promised.
const refusalNotes = new Map<string, RefusalNote>();
// The chats the extension is switched off in. The frontend's list, sent here so
// this side agrees with the panel about where it is meant to be doing anything.
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
// Truncating here would leave the view claiming a message is longer than what
// it shows, which is the one thing a reader cannot work around. The cost is
// kept down by only sending a prompt while the Prompt tab is open.

// The tokenizer the host actually uses, when it will tell us. The panel's own
// figure is characters divided by four, which is a serviceable guess and wrong
// by enough to matter on a long chat. Needs no permission. Answers null on any
// build or model where it does not resolve, and the panel says "roughly" again.
async function countTokens(text: string, context: any, userId?: string): Promise<number | null> {
  try {
    if (!text || !spindle.tokens || typeof spindle.tokens.countText !== 'function') return null;
    const model = context && (context.model || context.modelId);
    const res = await spindle.tokens.countText(text, { model: model, userId: userId });
    // Lumiverse says when it had no tokenizer for the model and fell back to
    // characters over four. Answered as no count at all, because that is the
    // same guess the panel makes for itself and saying roughly over it is the
    // difference between a figure and a figure that looks exact.
    if (res && res.approximate) return null;
    const n = res && Number(res.total_tokens);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch (_) {
    return null;
  }
}

function snapshotPrompt(messages: any[], context: any, userId?: string, noteAt?: { from: number; count: number }): void {
  const watcher = promptWatcherFor(userId);
  if (watcher == null) {
    // A prompt was read and there was somebody waiting for one, and the two
    // could not be matched to the same person. The tab's own empty state calls
    // that worth reporting, so it has to be able to say more than that it
    // happened: without this the drop is silent and there is nothing to report.
    //
    // Counts and whether the host named anybody, never the names themselves.
    // This goes to every panel on the instance, because the one thing known
    // here is that nobody can be addressed.
    if (promptWatchers.size) {
      try {
        replyTo(undefined, {
          type: 'prompt_unclaimed',
          watchers: promptWatchers.size,
          named: watcherKey(userId) !== '',
        });
      } catch (_) {}
      try {
        spindle.log.warn(
          'auto-retry: read a prompt and could not match it to the tab waiting for one. ' +
            'Watching: ' + promptWatchers.size + '. The generation ' +
            (watcherKey(userId) !== '' ? 'named an account' : 'named no account') + '.',
        );
      } catch (_) {}
    }
    return;
  }
  if (!Array.isArray(messages)) return;
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
    replyTo(to, {
      type: 'prompt_snapshot',
      at: at,
      chatId: context && context.chatId ? String(context.chatId) : '',
      messages: out,
      total: messages.length,
      notes: noteAt ? noteAt.count : 0,
    });
    // Sent as a second message so a slow tokenizer never delays the view. The
    // panel shows its own estimate until this lands, and replaces it if it does.
    countTokens(messages.map((m: any) => String((m && m.content) || '')).join('\n'), context, to)
      .then((tokens) => {
        if (tokens == null) return;
        replyTo(to, { type: 'prompt_tokens', at: at, tokens: tokens });
      })
      .catch(() => {});
  } catch (_) { /* a viewer must never cost anyone their generation */ }
}

// ---- several tries at once ----
// With "Several tries at once" on, a retry from the second try on sends the
// prompt the failed reply went out with several times at the same moment,
// through generate.quiet, and the panel keeps the first reply that passes its
// checks. Lumiverse runs one reply per chat at a time, so pressing its button
// cannot do this. The calls have to come from here.
//
// The prompt is the one the interceptor saw for the last reply in the chat,
// taken before the refusal note goes in, so a note is only ever in it when the
// panel arms one for this try. It is kept only for people who have the setting
// on, in memory, one per chat, for a limited time, and it is dropped the moment
// the setting goes off. Where there is none, Lumiverse is asked to build the
// prompt with generate.dryRun. That one skips the council, which is why the
// kept one comes first.
//
// A kept prompt is only used for the message it answers. Lumiverse calls
// interceptors after it has staged the empty reply, so a turn that fails
// while the prompt is still being built never reaches the interceptor, and
// what is kept is the prompt for the turn before. Sent again, it would answer
// the wrong message.
const atOnceUsers = new Set<string>();
// answers is the id of the last chat message in the prompt, or '' on a
// Lumiverse that does not say which message a prompt line came from.
// connectionId is the connection Lumiverse picked for that reply.
interface KeptPrompt { messages: any[]; at: number; answers: string; connectionId: string; }
const keptPrompts = new Map<string, KeptPrompt>();
// Enough for someone moving between a handful of chats. The oldest goes first.
const KEPT_MAX = 12;
// A retry that comes later than this is not part of the same run of tries,
// and the chat may have moved on, so the prompt is built again instead.
const KEPT_MAX_AGE_MS = 30 * 60 * 1000;
// The panel offers up to this many at once. A hand-edited request cannot
// go past it.
const MAX_AT_ONCE = 5;
// The calls in flight, by the request that started them, so Stop can end
// them. Each records who started it, so one account cannot stop another's.
const atOnceRuns = new Map<string, { controller: any; who: string; release: () => void }>();
// Stop can arrive while the prompt is still being built, before there is a
// run to stop. Those requests are remembered here so their calls never go out.
const stoppedEarly = new Map<string, string>();
const STOPPED_EARLY_MAX = 50;
// One run of tries per chat at a time, by account and chat. Two tabs open on
// one chat both see the reply that failed, and each would send its own tries
// and pay for them. The first request holds the chat until its calls are
// back or stopped. A hold older than this belongs to a run that went wrong,
// and gives way.
const atOnceHolds = new Map<string, { requestId: string; at: number }>();
const AT_ONCE_HOLD_MS = 10 * 60 * 1000;

const keptKey = (who: string, chatId: string) => who + '\n' + chatId;

// The dry run tries at once asks for, by chat. The interceptor fills it in
// with the prompt as Lumiverse built it, which a dry run hands back only as a
// copy made for showing on screen, and with the connection Lumiverse picked
// for the chat. A real swipe leaves the reply it replaces out of its prompt,
// and a dry run cannot be told which reply that is, so for a reroll the
// interceptor takes that reply out by id (leave).
interface OwnDry { leave: string; messages: any[] | null; connectionId: string; }
const ownDry = new Map<string, OwnDry>();

// Same matching as the prompt viewer: the interceptor's context does not name
// the user on every build, and on a server with one such user that is who it is.
function atOnceUserFor(userId?: string): string | null {
  const k = watcherKey(userId);
  if (atOnceUsers.has(k)) return k;
  if (atOnceUsers.size !== 1) return null;
  const only = atOnceUsers.values().next().value as string;
  return k === '' || only === '' ? only : null;
}

function setAtOnce(userId: string | undefined, on: boolean): void {
  const k = watcherKey(userId);
  if (on) {
    atOnceUsers.add(k);
    return;
  }
  atOnceUsers.delete(k);
  for (const key of Array.from(keptPrompts.keys()))
    if (key.indexOf(k + '\n') === 0) keptPrompts.delete(key);
}

// Only the parts a model reads. The host's own markers stay out of a request
// that does not go through prompt assembly. An assistant prefill is a last
// message marked partial, with any thinking prefill beside it, and keeps both
// so the provider still treats it as the start of the reply.
function plainMessages(messages: any[]): any[] {
  const out: any[] = [];
  for (const m of messages) {
    if (!m) continue;
    const one: any = { role: String(m.role == null ? 'user' : m.role), content: m.content == null ? '' : m.content };
    if (typeof m.name === 'string' && m.name) one.name = m.name;
    if (m.partial === true) one.partial = true;
    if (typeof m.reasoning_content === 'string' && m.reasoning_content) one.reasoning_content = m.reasoning_content;
    out.push(one);
  }
  return out;
}

// The prefill a prompt ends on, if any. Lumiverse puts it at the start of the
// reply it saves, so a reply from a quiet call gets it put back the same way.
function prefillOf(messages: any[]): { text: string; thinking: string } {
  const end = messages.length ? messages[messages.length - 1] : null;
  if (!end || end.role !== 'assistant' || end.partial !== true) return { text: '', thinking: '' };
  return {
    text: typeof end.content === 'string' ? end.content : '',
    thinking: typeof end.reasoning_content === 'string' ? end.reasoning_content : '',
  };
}

function keepPrompt(messages: any[], context: any, userId?: string): void {
  try {
    if (!atOnceUsers.size || !Array.isArray(messages)) return;
    const who = atOnceUserFor(userId);
    const chatId = context && context.chatId ? String(context.chatId) : '';
    if (who == null || !chatId) return;
    const type = String((context && context.generationType) || '').toLowerCase();
    // An impersonation writes your turn and a continue adds to the reply on
    // screen. Neither prompt is the one a new reply would be sent with, so the
    // kept one is dropped and the next try builds its own.
    if (type === 'impersonate' || type === 'continue') {
      keptPrompts.delete(keptKey(who, chatId));
      return;
    }
    let answers = '';
    for (const m of messages)
      if (m && m.__isChatHistory && m.sourceMessageId != null) answers = String(m.sourceMessageId);
    const key = keptKey(who, chatId);
    keptPrompts.delete(key);
    const connectionId = context && context.connectionId ? String(context.connectionId) : '';
    keptPrompts.set(key, { messages: plainMessages(messages), at: Date.now(), answers: answers, connectionId: connectionId });
    while (keptPrompts.size > KEPT_MAX) keptPrompts.delete(keptPrompts.keys().next().value as string);
  } catch (_) { /* keeping a copy must never cost anyone their generation */ }
}

// What went wrong, in words a user can act on. A host error can be a string,
// an Error, or an object with the message further in.
function sayError(e: any): string {
  if (!e) return 'no reason was given';
  if (typeof e === 'string') return e;
  const m = e.message || (e.error && (e.error.message || e.error)) || '';
  return m ? String(m) : 'no reason was given';
}

// What a try is for, read off the last message in the chat.
//
// A reply that failed its check gets the reply that passes as a new reroll.
// A message of the user's with no reply after it is a turn that failed before
// any text came back, such as an error before the first word, so Lumiverse
// saved no reply. The reply that passes is added after it as a new reply.
// Anything else means the chat has moved on. answers is the message the new
// reply answers: the one before the failed reply, or your message itself.
type AtOnceTarget =
  | { kind: 'reroll'; id: string; swipes: string[]; answers: string; text: string }
  | { kind: 'reply'; id: string; answers: string };
async function whereToAdd(chatId: string): Promise<AtOnceTarget | { why: string }> {
  if (!spindle.chat || typeof spindle.chat.getMessages !== 'function')
    return { why: 'this version of Lumiverse does not let an extension add to a chat' };
  let list: any[];
  try {
    list = await spindle.chat.getMessages(chatId);
  } catch (e) {
    return { why: 'Auto Retry could not read the chat. Check that the chat_mutation permission is granted (' + sayError(e) + ')' };
  }
  const last = Array.isArray(list) && list.length ? list[list.length - 1] : null;
  const role = last && last.id ? String(last.role || '') : '';
  if (!role) return { why: 'there is nothing in the chat yet' };
  if (role === 'user') return { kind: 'reply', id: String(last.id), answers: String(last.id) };
  if (role !== 'assistant') return { why: 'the last message in the chat is not a reply or a message of yours' };
  const swipes = Array.isArray(last.swipes) && last.swipes.length
    ? last.swipes.map((x: any) => String(x == null ? '' : x))
    : [String(last.content == null ? '' : last.content)];
  const before = list.length > 1 ? list[list.length - 2] : null;
  const answers = before && before.id ? String(before.id) : '';
  const text = String(last.content == null ? '' : last.content);
  return { kind: 'reroll', id: String(last.id), swipes, answers, text };
}

// The chat's own settings, which need the chats permission. why says what
// went wrong when they could not be read.
async function chatMeta(chatId: string, userId?: string): Promise<{ meta: any; why: string }> {
  if (!spindle.chats || typeof spindle.chats.get !== 'function')
    return { meta: null, why: 'this Lumiverse cannot say whether this is a group chat' };
  try {
    const chat = await spindle.chats.get(chatId, userId);
    return { meta: chat && chat.metadata && typeof chat.metadata === 'object' ? chat.metadata : {}, why: '' };
  } catch (e) {
    return { meta: null, why: 'Auto Retry could not read the chat to see whether it is a group chat (' + sayError(e) + ')' };
  }
}

// A reply an extension adds carries no character, so in a group chat it
// cannot say which character wrote it. Lumiverse marks a group chat with
// metadata.group. A chat that cannot be read is treated the same way, since
// the answer is not known.
function groupChatWhy(read: { meta: any; why: string }): string {
  if (read.why) return read.why;
  if (read.meta && read.meta.group === true)
    return 'this is a group chat, and a reply added by an extension cannot say which character wrote it';
  return '';
}

async function tryAtOnce(payload: any, userId?: string): Promise<void> {
  const requestId = String(payload.requestId || '');
  const chatId = payload.chatId ? String(payload.chatId) : '';
  const count = Math.max(1, Math.min(MAX_AT_ONCE, Math.round(Number(payload.count)) || 1));
  const say = (m: any) => replyTo(userId, Object.assign({ type: 'at_once', requestId: requestId }, m));
  if (!requestId) return;
  if (!chatId) return say({ stage: 'failed', why: 'the host did not say which chat this is' });
  const who = watcherKey(userId);
  const holdKey = keptKey(who, chatId);
  const held = atOnceHolds.get(holdKey);
  if (held && held.requestId !== requestId && Date.now() - held.at < AT_ONCE_HOLD_MS)
    return say({ stage: 'failed', busy: true, why: 'tries at once are already out for this chat, from another tab' });
  atOnceHolds.set(holdKey, { requestId: requestId, at: Date.now() });
  const release = () => {
    const now = atOnceHolds.get(holdKey);
    if (now && now.requestId === requestId) atOnceHolds.delete(holdKey);
  };
  // Every way out before the calls go releases the hold.
  const fail = (why: string) => {
    release();
    return say({ stage: 'failed', why: why });
  };
  const target = await whereToAdd(chatId);
  if ('why' in target) return fail(target.why);
  // Read once, for the group check and for the connection the chat is set to.
  const read = await chatMeta(chatId, userId);
  if (target.kind === 'reply') {
    const why = groupChatWhy(read);
    if (why) return fail(why);
  }
  // A quiet call that names no connection goes to the default one, which is
  // not always the one the chat's replies use. The tries go to the same
  // connection as a reply in this chat: the one Lumiverse picked for the
  // prompt, or the one the chat is set to.
  const meta = read.meta || {};
  const bound = typeof meta.connection_profile_id === 'string' ? meta.connection_profile_id.trim() : '';
  let connectionId = '';
  let parameters: any = null;

  const kept = keptPrompts.get(keptKey(atOnceUserFor(userId) || who, chatId));
  const keptFits = !!kept && Date.now() - kept.at < KEPT_MAX_AGE_MS && (!kept.answers || kept.answers === target.answers);
  let messages: any[] | null = kept && keptFits ? kept.messages : null;
  let from = 'kept';
  if (messages && kept) connectionId = kept.connectionId;
  if (!messages) {
    from = 'built';
    if (!spindle.generate || typeof spindle.generate.dryRun !== 'function')
      return fail('this Lumiverse cannot build a prompt for an extension');
    try {
      // A reroll is built the way a swipe is. A new reply is built the way a
      // normal turn is, from the chat as it stands, ending on your message.
      const generationType = target.kind === 'reroll' ? 'swipe' : 'normal';
      const own: OwnDry = { leave: target.kind === 'reroll' ? target.id : '', messages: null, connectionId: '' };
      ownDry.set(chatId, own);
      let dry: any;
      try {
        dry = await spindle.generate.dryRun({ chatId: chatId, generationType: generationType }, userId);
      } finally {
        if (ownDry.get(chatId) === own) ownDry.delete(chatId);
      }
      if (own.messages) messages = plainMessages(own.messages);
      else {
        // Without the interceptor permission, only the copy made for showing
        // is there, and the reply being replaced was not taken out above. It
        // is then the last message, word for word, and comes off here.
        messages = dry && Array.isArray(dry.messages) ? plainMessages(dry.messages) : null;
        if (target.kind === 'reroll' && messages && messages.length) {
          const end = messages[messages.length - 1];
          if (end.role === 'assistant' && String(end.content).trim() === target.text.trim()) messages = messages.slice(0, -1);
        }
      }
      connectionId = own.connectionId;
      // The model and samplers Lumiverse would send with this prompt. Only
      // with the connection they belong to, since a model name means nothing
      // on another one.
      if (connectionId && dry && dry.parameters && typeof dry.parameters === 'object') {
        parameters = Object.assign({}, dry.parameters);
        if (typeof dry.model === 'string' && dry.model) parameters.model = dry.model;
      }
    } catch (e) {
      return fail('Lumiverse could not build the prompt (' + sayError(e) + ')');
    }
  }
  if (!messages || !messages.length) return fail('there was no prompt to send');
  if (!connectionId) connectionId = bound;
  // A chat set to its own connection can also be set to its own model on it.
  if (!parameters && connectionId && connectionId === bound && typeof meta.connection_model === 'string' && meta.connection_model.trim())
    parameters = { model: meta.connection_model.trim() };

  // The refusal note armed for this try, placed the same way the interceptor
  // places it, and used up the same way.
  let notes = 0;
  const armed = refusalNotes.get(chatId);
  if (armed) {
    refusalNotes.delete(chatId);
    if (Date.now() - armed.at <= NOTE_MAX_AGE_MS) {
      const built = armed.notes.map((n) => ({ role: n.role, content: n.text }));
      messages = placeNotes(messages, built, armed.placement).list;
      notes = built.length;
    }
  }

  if (stoppedEarly.get(requestId) === who) {
    stoppedEarly.delete(requestId);
    return fail('you stopped it');
  }

  const Ctl = (globalThis as any).AbortController;
  const controller = typeof Ctl === 'function' ? new Ctl() : null;
  atOnceRuns.set(requestId, { controller: controller, who: who, release: release });
  const prefill = prefillOf(messages);
  const swipeCount = target.kind === 'reroll' ? target.swipes.length : 0;
  const said = !connectionId
    ? 'your default one, since Auto Retry could not tell which one the chat uses'
    : connectionId === bound
      ? "the one the chat is set to"
      : 'the one the chat\'s replies use';
  const connection = said + (parameters && Object.keys(parameters).some((k) => k !== 'model') ? ', with its samplers' : '');
  // Every tab of the account hears this, and the chat id lets a tab standing
  // by in that chat see that another tab is retrying.
  say({ stage: 'sent', chatId: chatId, count: count, from: from, notes: notes, kind: target.kind, messageId: target.id, swipeCount: swipeCount, connection: connection });
  let left = count;
  for (let i = 0; i < count; i++) {
    const req: any = { messages: messages };
    if (connectionId) req.connection_id = connectionId;
    if (parameters) req.parameters = parameters;
    if (userId) req.userId = userId;
    if (controller) req.signal = controller.signal;
    let call: Promise<any>;
    try {
      call = Promise.resolve(spindle.generate.quiet(req));
    } catch (e) {
      call = Promise.reject(e);
    }
    call
      .then((res: any) => {
        const thought = res && typeof res.reasoning === 'string' ? res.reasoning : '';
        say({
          stage: 'reply',
          index: i,
          content: prefill.text + String((res && res.content) || ''),
          reasoning: prefill.thinking + thought,
        });
      })
      .catch((e: any) => {
        const stopped = !!(e && e.name === 'AbortError');
        say({ stage: 'reply', index: i, stopped: stopped, error: stopped ? 'stopped' : sayError(e) });
      })
      .then(() => {
        left -= 1;
        if (left > 0) return;
        atOnceRuns.delete(requestId);
        release();
        say({ stage: 'done' });
      });
  }
}

function stopAtOnce(requestId: string, userId?: string): void {
  const run = atOnceRuns.get(requestId);
  if (!run) {
    if (!requestId) return;
    stoppedEarly.set(requestId, watcherKey(userId));
    while (stoppedEarly.size > STOPPED_EARLY_MAX) stoppedEarly.delete(stoppedEarly.keys().next().value as string);
    return;
  }
  if (run.who !== watcherKey(userId)) return;
  atOnceRuns.delete(requestId);
  run.release();
  try { if (run.controller) run.controller.abort(); } catch (_) {}
}

// The reply that passed goes on the failed reply as a new reroll, or after
// your message as a new reply when the turn saved none, and is shown. The
// chat is read again first: if a message was sent or the reply deleted while
// the tries were out, the reply is not put on the wrong message. The message
// it landed on is handed back, so Auto Refine can be told which one it is.
async function addReroll(payload: any): Promise<{ ok: boolean; why?: string; changed?: boolean; messageId?: string; swipe?: number }> {
  const chatId = payload.chatId ? String(payload.chatId) : '';
  const text = String(payload.text == null ? '' : payload.text);
  if (!chatId || !text.trim()) return { ok: false, why: 'there was nothing to add' };
  const target = await whereToAdd(chatId);
  if ('why' in target) return { ok: false, why: target.why };
  const asked = payload.kind === 'reply' ? 'reply' : 'reroll';
  if (target.kind !== asked || target.id !== String(payload.messageId || ''))
    return { ok: false, changed: true, why: 'the chat changed while the tries were out' };
  let messageId = target.id;
  let swipe = 0;
  if (target.kind === 'reroll') {
    if (target.swipes.length !== Number(payload.swipeCount))
      return { ok: false, changed: true, why: 'the reply changed while the tries were out' };
    try {
      await spindle.chat.updateMessage(chatId, target.id, {
        swipes: target.swipes.concat([text]),
        swipe_id: target.swipes.length,
      });
    } catch (e) {
      return { ok: false, why: 'Lumiverse would not add the reroll (' + sayError(e) + ')' };
    }
    swipe = target.swipes.length;
  } else {
    if (typeof spindle.chat.appendMessage !== 'function')
      return { ok: false, why: 'this version of Lumiverse does not let an extension add to a chat' };
    try {
      const made = await spindle.chat.appendMessage(chatId, { role: 'assistant', content: text });
      messageId = made && made.id ? String(made.id) : '';
    } catch (e) {
      return { ok: false, why: 'Lumiverse refused to add the new reply (' + sayError(e) + ')' };
    }
  }
  const reasoning = String(payload.reasoning == null ? '' : payload.reasoning);
  if (reasoning.trim() && messageId) {
    try {
      await spindle.chat.updateMessage(chatId, messageId, { reasoning: { text: reasoning, duration: null } });
    } catch (_) {
      try { spindle.log.warn('auto-retry: added the reply that passed, but Lumiverse would not save its thinking'); } catch (__) {}
    }
  }
  return { ok: true, messageId: messageId, swipe: swipe };
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
  // Past everything, the host's own trailing messages included. "After the last
  // message" stops at the end of the conversation, and some builds append their
  // own instructions behind it; this is the only placement that puts a note
  // after those, which is where a note has to be to answer one of them. An
  // assistant prefill stays last, since it is the start of the reply.
  if (placement === 'end') {
    const tail = list.length ? list[list.length - 1] : null;
    const from = tail && tail.role === 'assistant' && tail.partial === true ? list.length - 1 : list.length;
    list.splice.apply(list, ([from, 0] as any[]).concat(notes));
    return { list: list, from: from };
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




















// Load persisted settings on startup. There is no userId here, so this only
// resolves on a user-scoped install where userStorage can infer the owner.
// Everywhere else it finds nothing and the state stays at its defaults until a
// panel loads or saves, which is why load_settings applies what it reads rather
// than only handing it back. One rule set per process either way, so on a
// multi-account install it belongs to whoever loaded or saved last.
(async () => {
  try {
    await readUserJson(SETTINGS_FILE);
  } catch (_) { /* no account settings yet */ }
})();

// One of Lumiverse's own notifications. Lumiverse takes them only from an
// extension's server side, so the panel sends its words here to be shown. The
// kind sets the color. It is sent to the account that asked: on a shared
// server, a notification with no account named goes to everybody. Lumiverse
// shows the extension's name as the title, so none is added. It also shows at
// most five in ten seconds from one extension and drops the rest.
const NOTIFY_KINDS = ['success', 'info', 'warning', 'error'];
function notify(kind: any, text: any, userId?: string) {
  const k = NOTIFY_KINDS.indexOf(String(kind)) >= 0 ? String(kind) : 'info';
  const words = String(text == null ? '' : text).trim().slice(0, 500);
  if (!words) return;
  try {
    if (!spindle.toast || typeof spindle.toast[k] !== 'function') return;
    spindle.toast[k](words, userId ? { userId: userId } : undefined);
  } catch (e) {
    try { spindle.log.warn('auto-retry: could not show a notification: ' + sayError(e)); } catch (__) {}
  }
}

// Settings bridge with the UI: save the whole settings object to per-user
// account storage and send it back on request.
// tab is the id of the browser tab that sent the message. A Lumiverse that
// does not pass one leaves it undefined.
spindle.onFrontendMessage(async (payload: any, userId?: string, tab?: string) => {
  try {
    if (!payload) return;
    if (payload.type === 'notify') {
      notify(payload.kind, payload.text, userId);
      return;
    }
    if (payload.type === 'save_settings' && payload.settings && typeof payload.settings === 'object') {
      setAtOnce(userId, payload.settings.tryAtOnce === true);
      // This write is the account copy, the one that carries settings between
      // devices. It is caught here rather than falling to the catch at the
      // bottom, which logs on the server where the affected user cannot see it
      // while the panel claims the save worked.
      await inTurn(settingsWrites, userId, async () => {
        try {
          await writeUserJson(SETTINGS_FILE, payload.settings, userId);
        } catch (e) {
          try { spindle.log.warn('auto-retry: could not save settings to the account'); } catch (__) {}
          replyTo(userId, { type: 'account_save_failed', what: 'settings' });
        }
      });
      return;
    }
    if (payload.type === 'load_settings') {
      let settings: any = null;
      try { settings = await readUserJson(SETTINGS_FILE, userId); } catch (__) { settings = null; }
      // A panel on a new device has none of this person's settings yet and
      // tells this side nothing until it saves, so the switch is read from the
      // account copy here.
      if (settings && typeof settings === 'object') setAtOnce(userId, settings.tryAtOnce === true);
      // This runs on every page load and it is the only path that arrives with
      // a userId, so it is the one that can resolve per-user storage. The
      // startup read above cannot: it has no user to read for.
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
      // Whether the host could actually be asked which chat is open. Without
      // this a null chatId means two different things, "no chat is open" and
      // "I could not look", and the frontend has to tell them apart: the first
      // is worth saying out loud and the second is worth waiting through.
      let resolved = false;
      let hasCharacter = false;
      try {
        let chat: any = null;
        if (chatId && spindle.chats && typeof spindle.chats.get === 'function') {
          chat = await spindle.chats.get(chatId, userId);
          // Asked about a named chat and told, whether or not it has a card on
          // it. The frontend caches "this chat has no name" off this flag, so
          // a lookup that threw before getting here must not look like one.
          resolved = true;
        } else if (spindle.chats && typeof spindle.chats.getActive === 'function') {
          chat = await spindle.chats.getActive(userId);
          chatId = (chat && chat.id) || null;
          // Answered, whether or not it named a chat.
          resolved = true;
        }
        // A chat can hold several cards, with character_id naming the one it
        // belongs to. The primary is the useful answer here: the panel wants a
        // word for which chat this is, not a cast list.
        const cardId = chat && chat.character_id;
        // Whether the chat has a card at all, which is not the same question as
        // what it is called. The name needs the characters permission and the
        // lookup below can come back empty for want of it, so a missing name
        // cannot tell a chat with no card from one nobody was allowed to name.
        // This reads the chat itself and so answers whenever the chat did.
        const cards = chat && chat.metadata && chat.metadata.character_ids;
        hasCharacter = !!cardId || (Array.isArray(cards) && cards.length > 0);
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
        resolved: resolved,
        hasCharacter: hasCharacter,
      });
      return;
    }
    if (payload.type === 'set_settings' && payload.settings && typeof payload.settings === 'object') {
      // The panel handing back what this module knew before it restarted.
      setAtOnce(userId, payload.settings.tryAtOnce === true);
      return;
    }
    if (payload.type === 'set_chats_off') {
      const list = Array.isArray(payload.chats) ? payload.chats : [];
      chatsOff = new Set(list.slice(0, 500).map((c: any) => String(c)));
      return;
    }
    // Which build this half is on. Asked on every panel load rather than only
    // announced at startup: this module comes up once and stays up, so a panel
    // opened at any point after that missed the announcement.
    if (payload.type === 'get_backend_version') {
      replyTo(userId, { type: 'backend_version', requestId: payload.requestId, version: VERSION });
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
    // The reply a generation just produced, counted so the panel can price the
    // output half of a retry. Only the count goes back: the text is not kept,
    // not stored, and not read for anything else, and it came from this server
    // in the first place.
    if (payload.type === 'count_reply') {
      const text = String(payload.text == null ? '' : payload.text);
      const at = Number(payload.at) || 0;
      if (!text) return;
      countTokens(text, null, userId)
        .then((tokens) => {
          if (tokens == null) return;
          replyTo(userId, { type: 'reply_tokens', at: at, tokens: tokens });
        })
        .catch(() => {});
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
      // Arming with nothing is how the panel takes a note back, so an empty
      // arm clears that chat's note and leaves every other chat's alone.
      const forChat = payload.chatId ? String(payload.chatId) : '';
      if (forChat && notes.length)
        refusalNotes.set(forChat, {
          chatId: forChat,
          notes: notes,
          placement: String(payload.placement || 'after'),
          at: Date.now(),
          strictType: !!payload.strictType,
          tab: typeof tab === 'string' ? tab : '',
        });
      else if (forChat) refusalNotes.delete(forChat);
      // Acknowledged so the frontend can hold the retry click until the note is
      // actually in place. The arm travels this bridge while the click travels
      // the DOM to the host to the server, and those are independent: the click
      // could otherwise reach prompt assembly first and the note would be
      // left out of that generation with no message.
      replyTo(userId, { type: 'note_armed', requestId: payload.requestId, armed: !!forChat && refusalNotes.has(forChat) });
      return;
    }
    if (payload.type === 'try_at_once') {
      // Not awaited: the replies come back one at a time as they finish, and
      // this handler should not hold the bridge for the length of a reply.
      tryAtOnce(payload, userId).catch((e) => {
        replyTo(userId, { type: 'at_once', requestId: String(payload.requestId || ''), stage: 'failed', why: sayError(e) });
      });
      return;
    }
    // Retrying in a chat was stopped in one tab. Every tab of the account is
    // told, so a tab standing by for that chat does not retry it.
    if (payload.type === 'stood_down') {
      const forChat = payload.chatId ? String(payload.chatId) : '';
      // why is "gave_up" when that tab used every try, and empty when you
      // stopped it. Nothing else is passed on.
      const why = payload.why === 'gave_up' ? 'gave_up' : '';
      if (forChat) replyTo(userId, { type: 'stood_down', chatId: forChat, why: why });
      return;
    }
    if (payload.type === 'stop_at_once') {
      stopAtOnce(String(payload.requestId || ''), userId);
      return;
    }
    if (payload.type === 'add_reroll') {
      let done: { ok: boolean; why?: string; changed?: boolean; messageId?: string; swipe?: number };
      try {
        done = await addReroll(payload);
      } catch (e) {
        done = { ok: false, why: sayError(e) };
      }
      // Every tab of the account hears this too, with the chat it was for.
      replyTo(userId, {
        type: 'reroll_added',
        requestId: payload.requestId,
        chatId: payload.chatId ? String(payload.chatId) : '',
        ok: done.ok,
        why: done.why || '',
        changed: !!done.changed,
        messageId: done.messageId || '',
        swipe: Number(done.swipe) || 0,
      });
      return;
    }
    if (payload.type === 'save_presets' && payload.presets && typeof payload.presets === 'object') {
      await inTurn(presetWrites, userId, async () => {
        try {
          await writeUserJson(PRESETS_FILE, payload.presets, userId);
        } catch (e) {
          try { spindle.log.warn('auto-retry: could not save presets to the account'); } catch (__) {}
          replyTo(userId, { type: 'account_save_failed', what: 'presets' });
        }
      });
      return;
    }
    if (payload.type === 'get_think_marks') {
      const k = userKey(userId);
      const had = marksBy.get(k);
      let pairs = had ? had.pairs : [];
      if (!had || Date.now() - had.at >= MARKS_FRESH_MS) {
        try {
          if (spindle.connections && typeof spindle.connections.list === 'function')
            pairs = marksFrom(await spindle.connections.list(userId));
        } catch (_) { /* no generation permission: the built-in formats still apply */ }
        marksBy.set(k, { at: Date.now(), pairs: pairs });
      }
      replyTo(userId, { type: 'think_marks', pairs: pairs });
      return;
    }
    if (payload.type === 'keep_replaced') {
      const r = cleanReplaced(payload.item);
      if (!r) return;
      const list = replacedFor(userId).filter((x) => x.chatId !== r.chatId);
      list.push(r);
      while (list.length > REPLACED_PER_USER) list.shift();
      replacedKept.set(userKey(userId), list);
      await saveReplaced(userId, payload.save === true);
      return;
    }
    if (payload.type === 'forget_replaced') {
      const chatId = payload.chatId == null ? null : String(payload.chatId);
      replacedKept.set(
        userKey(userId),
        payload.all === true || chatId === null ? [] : replacedFor(userId).filter((x) => x.chatId !== chatId),
      );
      await saveReplaced(userId, payload.save === true);
      return;
    }
    if (payload.type === 'save_replaced') {
      await saveReplaced(userId, payload.save === true);
      return;
    }
    if (payload.type === 'list_replaced') {
      if (payload.save === true) await readReplaced(userId);
      replyTo(userId, { type: 'replaced_list', requestId: payload.requestId, items: replacedFor(userId).slice() });
      return;
    }
    // The chats switched off and the notices already read, which follow the
    // account apart from the settings. One write at a time, in order.
    if (payload.type === 'save_state' && payload.state && typeof payload.state === 'object') {
      await inTurn(stateWrites, userId, async () => {
        try {
          await writeUserJson(STATE_FILE, payload.state, userId);
        } catch (e: any) {
          try { spindle.log.warn('could not save the chats switched off to the account: ' + ((e && e.message) || String(e))); } catch (_) {}
          replyTo(userId, { type: 'account_save_failed', what: 'state' });
        }
      });
      return;
    }

    if (payload.type === 'load_state') {
      let state: any = null;
      try { state = await readUserJson(STATE_FILE, userId); } catch (_) { state = null; }
      replyTo(userId, { type: 'loaded_state', requestId: payload.requestId, state: state });
      return;
    }

    if (payload.type === 'load_presets') {
      let presets: any = null;
      try { presets = await readUserJson(PRESETS_FILE, userId); } catch (__) { presets = null; }
      replyTo(userId, { type: 'loaded_presets', requestId: payload.requestId, presets: presets });
      return;
    }
  } catch (_) {
    try { spindle.log.warn('auto-retry: could not handle a settings message'); } catch (__) {}
  }
});

// Runs after the prompt is assembled and before it reaches the model. Priority
// 150 rather than the default 100 so the note lands after anything another
// extension adds, which is what "closest to the model" has to mean to be worth
// choosing.
const promptInterceptor = async (messages: any[], context: any) => {
  try {
    // A quiet generation is a background call, such as another extension's
    // rewrite or one of this extension's own tries at once. A dry run builds a
    // prompt that is never sent, such as Lumiverse's prompt preview or the
    // prompt built for tries at once. Neither is a reply in the chat, so
    // neither takes the refusal note, replaces the kept prompt, or takes the
    // Prompt tab's place. The one change made to a dry run is taking out the
    // reply a reroll replaces, for tries at once (see ownDry).
    if (String((context && context.generationType) || '').toLowerCase() === 'quiet') return messages;
    if (context && context.dryRun === true) {
      const own = context.chatId ? ownDry.get(String(context.chatId)) : undefined;
      if (!own || !Array.isArray(messages)) return messages;
      const kept = own.leave
        ? messages.filter((m: any) => !(m && m.__isChatHistory && String(m.sourceMessageId) === own.leave))
        : messages;
      own.messages = kept;
      own.connectionId = context.connectionId ? String(context.connectionId) : '';
      return kept;
    }
    const who = context && context.userId;
    const chatId = context && context.chatId ? String(context.chatId) : '';
    // Before the note goes in, so a later try only carries a note when one is
    // armed for it.
    keepPrompt(messages, context, who);
    // A note armed in one chat is not for a generation in another, and it
    // stays armed so the retry it was meant for can still collect it. A
    // generation that names no chat takes the one note there is, and none
    // when there are several, since it cannot say which is its own.
    const refusalNote = chatId
      ? refusalNotes.get(chatId) || null
      : refusalNotes.size === 1
        ? refusalNotes.values().next().value || null
        : null;
    if (!refusalNote) {
      snapshotPrompt(messages, context, who);
      return messages;
    }
    const type = String((context && context.generationType) || '');
    // Only when the user asked for it. Left on by default it would reject every
    // generation on a build that reports "normal", and the note would then
    // never appear at all.
    if (refusalNote.strictType && type && RETRY_TYPES.indexOf(type.toLowerCase()) < 0) {
      snapshotPrompt(messages, context, who);
      // Named rather than hidden. A note that never appears looks the same
      // whether it was never armed or the host called this generation
      // something else, and only one of those is fixable by the user. The
      // note stays armed: with the strict check on, the point is to wait for
      // a generation the host does call a retry.
      try { replyTo(who, { type: 'note_skipped', reason: 'the strict check is on and the host called this generation "' + type + '"' }, refusalNote.tab); } catch (__) {}
      return messages;
    }
    const armed = refusalNote;
    refusalNotes.delete(armed.chatId); // one generation, collected or not
    if (Date.now() - armed.at > NOTE_MAX_AGE_MS) {
      try { replyTo(who, { type: 'note_skipped', reason: 'it was armed too long ago to still belong to this generation' }, armed.tab); } catch (__) {}
      snapshotPrompt(messages, context, who);
      return messages;
    }
    if (!Array.isArray(messages)) return messages;
    const built = armed.notes.map((n) => ({ role: n.role, content: n.text }));
    const placed = placeNotes(messages, built, armed.placement);
    // Named in the Prompt Breakdown so each note is inspectable rather than
    // something that happened to the prompt with no record.
    const breakdown = built.map((_, i) => ({
      messageIndex: placed.from + i,
      name: built.length > 1 ? 'Auto Retry refusal note ' + (i + 1) : 'Auto Retry refusal note',
    }));
    // Said out loud, so "did my note go?" has an answer in the live log
    // instead of being something the user has to infer from the reply. Sent
    // to the tab that armed the note, which is the tab retrying, and not to
    // every open tab.
    try { replyTo(who, { type: 'note_sent', count: built.length, generationType: type }, armed.tab); } catch (__) {}
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
// event never fires and a fire-and-forget registration does nothing and
// says nothing, so an extension with the wrong grants stays installed and looks
// like it is working. The panel asks for this and says which are missing.
// onlyFor names the setting a permission is for, when only one setting uses it.
const PERMISSIONS: Array<{ name: string; costs: string; onlyFor?: string }> = [
  { name: 'generation', costs: 'Everything. Retries run off the generation events, and without this none of them arrive, so nothing is ever retried.' },
  { name: 'interceptor', costs: 'The refusal note, and the Prompt tab. With Several tries at once on, the tries go to your default connection unless the chat is set to its own, and a reply that failed is found in a prompt Lumiverse builds by its words only.' },
  { name: 'chats', costs: 'The chat name in the log, and knowing which chat you are in without a reply first. With Several tries at once on, a try after an error that came before any text presses the retry button instead, and a chat set to its own connection may send its tries to your default one.' },
  { name: 'characters', costs: 'The character name in the log.' },
  { name: 'ui_panels', costs: 'The floating button. The on-screen panel falls back to its own window.' },
  { name: 'chat_mutation', costs: 'Several tries at once, which adds the reply that passes as a new reroll or a new reply. Everything else works without it.', onlyFor: 'tryAtOnce' },
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
    // A build without permissions.has cannot be asked, so register and let the
    // host decide.
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
// the log rather than hidden, since the two features it takes out both look
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
// Sent unprompted as well as on request, so a panel that was already open when
// this module restarted hears about a build change without asking again.
try { replyTo(undefined, { type: 'backend_version', version: VERSION }); } catch (_) {}

try { spindle.log.info('Auto Retry ' + VERSION + ' backend loaded.'); } catch (_) {}
