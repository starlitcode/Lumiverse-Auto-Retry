/*
 * Auto Retry backend.
 *
 * Two jobs.
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
 * Needs the `generation` permission to hear when a reply finishes, and
 * `interceptor` for the refusal note.
 */

declare const spindle: any;
// The backend runtime has timers, but this module typechecks against ES2020
// with no DOM lib, and nothing in ES2020 declares them. Without these the
// settle gate below fails the backend typecheck, which takes `bun run check`
// and the CI job with it. Declarations emit nothing, so dist is unaffected.
declare function setTimeout(fn: () => void, ms: number): any;
declare function clearTimeout(handle: any): void;

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
// What the host calls the generation is not one of the guards, on purpose.
// Most builds report "normal" for everything, including a regenerate, so
// requiring "regenerate" or "swipe" would mean no note ever goes out. Users who
// know their build reports it properly can ask for that check with strictType.
interface RefusalNote { chatId: string; notes: Array<{ text: string; role: string }>; placement: string; at: number; strictType: boolean; }
let refusalNote: RefusalNote | null = null;
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

// Settings bridge with the UI: save the whole settings object to per-user
// account storage and send it back on request.
spindle.onFrontendMessage(async (payload: any, userId?: string) => {
  try {
    if (!payload) return;
    if (payload.type === 'save_settings' && payload.settings && typeof payload.settings === 'object') {
      // This write is the account copy, the one that carries settings between
      // devices. It is caught here rather than falling to the catch at the
      // bottom, which logs on the server where the affected user cannot see it
      // while the panel claims the save worked.
      try {
        await writeUserJson(SETTINGS_FILE, payload.settings, userId);
      } catch (e) {
        try { spindle.log.warn('auto-retry: could not save settings to the account'); } catch (__) {}
        replyTo(userId, { type: 'account_save_failed', what: 'settings' });
      }
      return;
    }
    if (payload.type === 'load_settings') {
      let settings: any = null;
      try { settings = await readUserJson(SETTINGS_FILE, userId); } catch (__) { settings = null; }
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
      try {
        await writeUserJson(PRESETS_FILE, payload.presets, userId);
      } catch (e) {
        try { spindle.log.warn('auto-retry: could not save presets to the account'); } catch (__) {}
        replyTo(userId, { type: 'account_save_failed', what: 'presets' });
      }
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
    // Only when the user asked for it. Left on by default it would reject every
    // generation on a build that reports "normal", and the note would then
    // never appear at all.
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
// nothing, so an extension with the wrong grants stays installed and looks
// like it is working. The panel asks for this and says which are missing.
const PERMISSIONS: Array<{ name: string; costs: string }> = [
  { name: 'generation', costs: 'Everything. Retries run off the generation events, and without this none of them arrive, so nothing is ever retried.' },
  { name: 'interceptor', costs: 'The refusal note, and the Prompt tab.' },
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

try { spindle.log.info('Auto Retry backend loaded.'); } catch (_) {}
