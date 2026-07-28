/*
 * Auto Retry (Lumiverse Spindle frontend extension)
 * Re-fires failed, empty, stalled, or cut-off generations.
 *
 * Lumiverse runs the LLM call server-side, so there is no browser fetch to
 * patch and no API to stop or regenerate a chat reply. This listens to the
 * generation lifecycle events and re-triggers the chat's own regenerate control
 * in the DOM when a generation fails, stalls, or returns empty.
 *
 * Settings can be edited live from the UI: open the chat input "Extras" popover
 * and pick "Auto Retry settings". Changes are synced to your Lumiverse account and applied
 * to the next generation, so you never have to touch the GitHub files.
 */

type Ctx = any;

const STORE_KEY = "lv-auto-retry:settings:v1";

// How long (ms) to suppress automatic retries after the user stops or cancels.
// Long enough to swallow the stopped generation's own trailing events.
const STAND_DOWN_MS = 2500;
const IGNORE_MAX = 16; // most aborted-generation ids kept around to swallow their late events

// How long (ms) to wait after clicking a retry control before deciding the
// click started nothing. A swipe control can move between existing rerolls
// instead of making a new one, and a stale control does nothing at all.
const START_GRACE_MS = 6000;

// Largest amount of streamed text kept per chat as a fallback when the end
// event arrives without a content field. Trimmed from the front past this.
const STREAM_BUF_MAX = 200000;

// Bumped on each release. Shown in the startup log and in the Copy debug info
// report, so a bug report always says which version it came from.
const VERSION = "3.2.0";

// ---- defaults (the UI overrides these; editing here changes the fallback) ----
const CONFIG = {
  enabled: true,

  // retry budget
  maxRetries: 4,
  // stop retrying for a while after several whole runs fail in a row: at that
  // point the provider is down rather than the reply being unlucky, and more
  // tries only burn tokens. Cleared by the next reply that comes back fine.
  pauseWhenFailing: true,
  // how many whole runs must give up back to back before it pauses, and how
  // long the pause lasts in minutes. Only used when pauseWhenFailing is on.
  breakerRuns: 3,
  breakerPauseMins: 5,
  retryDelayMs: 1200, // first retry fires a touch sooner; backoff still climbs
  backoffFactor: 2,
  maxDelayMs: 30000,
  jitter: true,

  // rate limiting (HTTP 429 / overloaded)
  rateLimitDelayMs: 8000,

  // how a retry redoes the reply. false = click the regenerate control (redoes
  // the reply in place). true = click the next / swipe control, which adds a new
  // reroll and leaves the existing rerolls in place. Either way the other
  // control is the fallback, picked at click time from what is actually on
  // screen and clickable, and used again if the first click starts nothing.
  retryByNewReroll: false,

  // watchdogs. Tuned to tolerate a slow connection and slow local models so a
  // slow-but-fine generation is not mistaken for a stall and retried into a pile-up.
  stuckTimeoutMs: 90000, // started but never produced a token or an end. 0 disables.
  idleTimeoutMs: 45000, // tokens were flowing then stopped this long (mid-stream cutoff). 0 disables.

  // what counts as needing a retry
  retryOnError: true,
  ignoreHardErrors: true,
  retryOnEmpty: true, // also catches a generation cut off mid-reasoning (reasoning seen, content empty)
  retryOnTruncated: true, // final content present but cut off mid-sentence (structural heuristic, see looksTruncated)
  retryOnNoPunct: false, // extra: also treat "ends with no punctuation" as truncated. Noisy in RP, off by default.
  retryOnShort: false, // off by default. Caused endless regen in the original.
  minChars: 24,
  retryOnRefusal: true, // final content is an out-of-character refusal (see looksLikeRefusal). Re-fires the SAME request, capped by maxRetries. Does not alter the request.
  refusalExtraPhrases: "", // your own extra refusal phrases, one per line. Any reply containing one counts as a refusal.
  refusalPhraseSubs: "", // reword the built-in phrases: "old => new" rules, one per line, applied to the built-in list before matching.
  refusalIgnorePhrases: "", // a reply containing any of these (one per line) is never counted as a refusal.
  refusalUseBuiltins: true, // use the built-in refusal lists. Turn off to run purely on your own phrases below.
  refusalMaxChars: 2000, // only replies up to this length are considered refusals. Longer = treated as real content. 0 = no limit (scan any length).

  refusalStripThinking: true, // ignore the model's thinking when checking for a refusal, so a refusal that lives only in a <think> block does not trigger a retry when the visible reply is fine.
  refusalThinkTags: "", // extra reasoning tag names (one per line) the model wraps its thinking in, on top of the built-in set. Both <tag> and [tag] forms are handled.
  // Find and replace in replies (handled by the backend via the Chat Mutation API).
  replaceEnabled: false, // off by default. When on, applies replaceRules to each finished reply and edits the saved message.
  replaceRules: "", // "old => new" rules, one per line. A single word matches whole words; empty right side deletes it. Same word can appear more than once.
  replaceCaseSensitive: false, // match letter case exactly. Off = case-insensitive with capitalization kept.
  replaceRandom: false, // when a word has more than one replacement, pick one at random per occurrence. Off = always the first listed.
  showReplaceButton: false, // optional button in the input's Extras menu that applies the word swaps to the latest reply on demand.
  showSwapAllButton: false, // adds an Extras button that swaps every generated reply in the chat once.
  allowReSwap: false, // let that button swap a reply again even if it was already swapped this session (can stack swaps).
  confirmBeforeEdit: false, // ask for confirmation before any word-swap edit (automatic or manual); the user can cancel.

  // host controls (the only DOM-dependent part). Use the Test buttons in settings.
  // Multiple patterns are listed so a Lumiverse build that renames one attribute
  // is still likely covered; if a build changes them all, fix it via the Test UI.
  regenerateSelector:
    '[title="Regenerate"], [data-action="regenerate"], [data-testid="regenerate"], ' +
    'button[aria-label*="regenerate" i], button[title*="regenerate" i]',
  swipeNextSelector:
    '[aria-label="Next swipe"], [data-action="swipe-right"], [data-testid="swipe-right"], ' +
    'button[aria-label*="next swipe" i], button[aria-label*="swipe right" i], ' +
    'button[aria-label*="reroll" i], button[title*="swipe" i]',
  // extra button labels Auto Retry may press on a dialog that appears after it
  // clicks retry. One per line. Blank means the built-in list only.
  confirmButtonLabels: "",

  stopSelector:
    '[aria-label="Stop generation"], [data-action="stop"], [data-testid="stop"], ' +
    'button[aria-label*="stop" i], button[title*="stop" i], [class*="_sendBtnStop_"]',

  toast: true,
  liveLog: false, // show a small on-screen panel with recent activity, updating live. Handy on mobile where dev tools aren't available.
};

// Fields the settings UI can edit, in display order. Single source of truth for
// both the form and what gets persisted. Every option above (except the two
// internal timing constants) is listed here, so everything is user-editable.
type FieldType = "bool" | "num" | "text";
interface Field {
  key: keyof typeof CONFIG;
  label: string;
  type: FieldType;
  hint?: string;
  selector?: boolean;
  min?: number;
  max?: number;
  int?: boolean;
}
interface Group {
  title: string;
  desc?: string;
  fields: Field[];
}
const SCHEMA: Group[] = [
  {
    title: "Basics",
    desc: "The main switch, and whether it tells you when it retries.",
    fields: [
      {
        key: "enabled",
        label: "Turn auto-retry on",
        type: "bool",
        hint: "When on, it quietly tries again whenever a reply fails or gets cut off. Turn it off and it does nothing.",
      },
      {
        key: "toast",
        label: "Show a pop-up on each retry",
        type: "bool",
        hint: "A small message telling you it is retrying, with a Cancel button to stop it.",
      },
    ],
  },
  {
    title: "How hard it tries",
    desc: "How persistent it is, and how long it waits between tries.",
    fields: [
      {
        key: "maxRetries",
        label: "Most tries per message",
        type: "num",
        int: true,
        min: 0,
        max: 50,
        hint: "How many times it retries one message before giving up. 3 to 5 suits most people.",
      },
      {
        key: "pauseWhenFailing",
        label: "Pause when everything is failing",
        type: "bool",
        hint: "On by default. If several whole runs give up in a row, auto-retry stops for a while instead of trying again on every message. That usually means the provider is down rather than the reply being unlucky, and retrying through it only spends tokens. The next reply that comes back fine clears it, and you can still send and regenerate by hand while it's paused. The two boxes below set how many runs and how long.",
      },
      {
        key: "breakerRuns",
        label: "Failed runs before pausing",
        type: "num",
        int: true,
        min: 1,
        max: 20,
        hint: "How many whole runs have to give up back to back before it pauses. A run is one message that used up all its tries. At the default of 3, with the try limit at 4, that is 12 retries before it stops. Raise it if your setup is normally flaky, lower it to give up sooner.",
      },
      {
        key: "breakerPauseMins",
        label: "How long to pause (minutes)",
        type: "num",
        int: true,
        min: 1,
        max: 180,
        hint: "How long auto-retry stays off once it pauses. Shorter suits a provider that hiccups and recovers; longer suits a real outage. Any reply that comes back fine ends the pause early, whatever this is set to.",
      },
      {
        key: "retryDelayMs",
        label: "Wait before the first retry",
        type: "num",
        int: true,
        min: 0,
        max: 600000,
        hint: "How long it pauses before trying again the first time. In milliseconds, so the 1200 default is 1.2 seconds.",
      },
      {
        key: "backoffFactor",
        label: "How much longer each wait gets",
        type: "num",
        min: 1,
        max: 10,
        hint: "Each retry waits this many times longer than the last, so it doesn't hammer the server. 2 means the wait doubles each time. Stays at 1 or above.",
      },
      {
        key: "maxDelayMs",
        label: "Longest it will ever wait",
        type: "num",
        int: true,
        min: 0,
        max: 600000,
        hint: "A ceiling so it never pauses forever. 30000 = 30 seconds.",
      },
      {
        key: "rateLimitDelayMs",
        label: "Wait when the server is busy",
        type: "num",
        int: true,
        min: 0,
        max: 600000,
        hint: 'If the server says "too many requests," it waits at least this long. 8000 = 8 seconds.',
      },
      {
        key: "jitter",
        label: "Add a little randomness to waits",
        type: "bool",
        hint: "Nudges each wait by a random amount so retries don't all hit the server at the same instant. Best left on.",
      },
    ],
  },
  {
    title: "How it redoes a reply",
    desc: "Choose whether a retry replaces the reply or adds a new reroll beside it.",
    fields: [
      {
        key: "retryByNewReroll",
        label: "Retry by adding a new reroll",
        type: "bool",
        hint: "Off: a retry redoes the reply in place, using your regenerate button. On some setups that clears the other rerolls on that message. On: a retry clicks your next / swipe button instead, which adds a new reroll and leaves the existing ones in place. This applies to every retry, including empty replies and errors. If the preferred button isn't on screen, or the click starts nothing, it uses the other button instead, so set both selectors in the buttons section below.",
      },
    ],
  },
  {
    title: "Watch for frozen replies",
    desc: "Notices when a reply freezes or never arrives, and retries. Defaults lean long so a slow connection isn't mistaken for a freeze; lower them for quicker retries on a fast provider.",
    fields: [
      {
        key: "stuckTimeoutMs",
        label: "Give up waiting for it to start",
        type: "num",
        int: true,
        min: 0,
        max: 600000,
        hint: "If a reply begins but no words appear in this long, treat it as stuck and retry. 90000 = 90 seconds. Set to 0 to switch off.",
      },
      {
        key: "idleTimeoutMs",
        label: "Give up on a reply that froze",
        type: "num",
        int: true,
        min: 0,
        max: 600000,
        hint: "If words were appearing and then stop for this long, treat it as frozen and retry. 45000 = 45 seconds. Set to 0 to switch off.",
      },
    ],
  },
  {
    title: "When to count a reply as bad",
    desc: "Pick which kinds of bad reply should trigger a retry.",
    fields: [
      {
        key: "retryOnError",
        label: "It came back as an error",
        type: "bool",
        hint: "Retry when the reply fails outright with an error.",
      },
      {
        key: "ignoreHardErrors",
        label: "Skip hard failures",
        type: "bool",
        hint: "Stops it from retrying when an error is permanent, like a missing model, an invalid API key, or an authentication failure.",
      },
      {
        key: "retryOnEmpty",
        label: "It came back blank",
        type: "bool",
        hint: "Retry when nothing comes back, including a reply that thinks but never writes anything.",
      },
      {
        key: "retryOnTruncated",
        label: "It cut off mid-sentence",
        type: "bool",
        hint: "Retry when a reply clearly stops partway, like an open quote, an unfinished *action*, or a trailing comma. It's intentionally careful so it doesn't throw away good writing.",
      },
      {
        key: "retryOnNoPunct",
        label: "Also: it ends with no punctuation",
        type: "bool",
        hint: "A stricter version of the line above. It can wrongly redo a reply that simply ends on a word, so most people leave this off.",
      },
      {
        key: "retryOnShort",
        label: "It was very short",
        type: "bool",
        hint: "Retry replies shorter than the length below. Off by default, since short replies are often fine.",
      },
      {
        key: "minChars",
        label: 'What counts as "very short"',
        type: "num",
        int: true,
        min: 0,
        max: 100000,
        hint: "Replies with fewer characters than this count as too short. Only the visible reply is counted, not any reasoning block. Only used when the option above is on.",
      },
      {
        key: "retryOnRefusal",
        label: "It looks like an accidental refusal (beta)",
        type: "bool",
        hint: "Retry when the model breaks character to decline (says it's an AI, or that it can't help or continue). It retries the same request unchanged, capped by your Most tries setting, so a refusal the model means will survive the tries and stop. Reads only the final reply, never the thinking, and stays narrow so an in-character \"I can't do that\" is left alone.",
      },
    ],
  },
  {
    title: "Advanced: find and replace (beta)",
    desc: "Swaps words in a reply after it arrives and saves the change, so the swap sticks and the model reads it on later turns. It never changes what the model generated, only the text afterward. Needs the chat editing permission. Off by default.",
    fields: [
      {
        key: "replaceEnabled",
        label: "Swap words in replies",
        type: "bool",
        hint: "When on, applies your swaps below to each new reply and edits the saved message. If nothing here matches, the reply is left untouched.",
      },
      {
        key: "replaceRules",
        label: "Word swaps (old => new)",
        type: "text",
        hint: 'Rules are "old => new", one per line. The left side can be a single word, a phrase, or a whole sentence, and commas inside it are fine. A single word matches whole words only (so cat won\'t touch category), while a phrase or sentence matches exactly as you type it. Leave the right side empty to delete it. Put the same left side on more than one line (like sky => blue on one line and sky => aqua on another) to give it options for the random toggle below. All rules are applied in a single pass, so a rule never acts on what another rule just wrote: cat => dog and dog => wolf turns cats into dogs and dogs into wolves, and hot => cold with cold => hot swaps the two rather than making everything one of them. Where two rules could match the same spot, the longer left side wins.',
      },
      {
        key: "replaceRandom",
        label: "Pick randomly when a word has more than one swap",
        type: "bool",
        hint: "Off by default. When the same word is listed on more than one line (like sky => blue on one line and sky => aqua on another), each time it appears one of its options is picked at random. Off, it always uses the first one you listed.",
      },
      {
        key: "replaceCaseSensitive",
        label: "Match case exactly",
        type: "bool",
        hint: "Off by default. When off, a swap matches any case and keeps the original capitalization. Turn on to swap only when the case matches your rule exactly, so sky and Sky can have different swaps.",
      },
      {
        key: "showReplaceButton",
        label: "Show a \"swap words now\" button",
        type: "bool",
        hint: "Off by default. Adds a button to the chat input's Extras menu that applies your word swaps on demand to the latest reply, so you can swap without leaving the automatic swap on. Only assistant replies are swapped, never your own messages, and the same reply won't be swapped twice. Needs your swap rules set up.",
      },
      {
        key: "showSwapAllButton",
        label: "Show a swap-whole-chat button",
        type: "bool",
        hint: "Off by default. Adds a button to the input's Extras menu that applies your rules once to every generated reply in the chat you're viewing. The greeting is never touched.",
      },
      {
        key: "allowReSwap",
        label: "Allow swapping a reply again",
        type: "bool",
        hint: "Off by default. Normally a reply is swapped at most once per session, so swaps don't stack. Turn this on to let the button swap a reply again even if it was already swapped, for example after you change your rules. This can apply your rules on top of an earlier swap.",
      },
      {
        key: "confirmBeforeEdit",
        label: "Ask before editing a reply",
        type: "bool",
        hint: "Off by default. When on, every word swap (automatic or from the button) asks you to confirm before it changes a reply, and you can cancel. This can get frequent if you use automatic swapping, but nothing is edited without your OK. Needs your Lumiverse to support confirm dialogs.",
      },
    ],
  },
  {
    title: "Advanced: refusal tuning (beta)",
    desc: "Only matters if the refusal option above is on. Fine-tunes what counts as a refusal.",
    fields: [
      {
        key: "refusalUseBuiltins",
        label: "Use the built-in phrase list",
        type: "bool",
        hint: "On by default. This only controls the built-in list. Your own phrases below are always used either way. On, the built-in list is used together with your own phrases. Off, only your own phrases are used.",
      },
      {
        key: "refusalExtraPhrases",
        label: "Your own refusal phrases",
        type: "text",
        hint: "Optional. Extra phrases that should also count as a refusal, one per line. These are always used, whether or not the built-in list above is on. Upper or lower case doesn't matter. Paste the exact wording your model refuses with.",
      },
      {
        key: "refusalPhraseSubs",
        label: "Reword the built-in phrases",
        type: "text",
        hint: 'Optional. Swap wording inside the built-in list using "old => new" rules, one per line. Example: assist => help. It changes what the built-in list matches, so only swap for wording your model actually uses.',
      },
      {
        key: "refusalIgnorePhrases",
        label: "Never treat these as a refusal",
        type: "text",
        hint: "Optional. If a reply contains any of these phrases, one per line, it's never counted as a refusal. This wins over everything else.",
      },
      {
        key: "refusalMaxChars",
        label: "Longest reply to treat as a refusal",
        type: "num",
        int: true,
        min: 0,
        max: 100000,
        hint: "Replies longer than this are treated as real writing, not a refusal, and left alone. 2000 suits most cases. Set to 0 to check replies of any length.",
      },
      {
        key: "refusalStripThinking",
        label: "Ignore the thinking / reasoning",
        type: "bool",
        hint: "On by default. Only the final reply is checked for a refusal, never the model's thinking. Known reasoning blocks (like <think> or <thinking>) are stripped before checking, so a refusal the model weighs while reasoning but doesn't put in the reply won't cause a retry. Turn it off to check the whole raw output for a refusal. This affects refusal matching only. Empty and cut-off checks always look past the thinking, since a reply that is nothing but a think block is empty either way.",
      },
      {
        key: "refusalThinkTags",
        label: "Extra thinking tag names",
        type: "text",
        hint: "Optional, one per line. The common reasoning tags are already handled. Add a tag name only if your model wraps its thinking in an unusual one (for example: mythink). Just the name, no brackets. Both <name> and [name] forms are covered.",
      },
    ],
  },
  {
    title: "Advanced: buttons it clicks",
    desc: "It retries by clicking your own on-screen buttons, so you only need this if retries aren't happening. The quickest fix is Pick it for me: press it, then click the real button. Otherwise paste a CSS selector and press Test until it says match found, with that button on screen. The stop button only appears while a reply is generating. The README covers fallback lists and selector syntax.",
    fields: [
      {
        key: "regenerateSelector",
        label: "Your regenerate button",
        type: "text",
        selector: true,
        hint: "The retry button it clicks to redo a reply.",
      },
      {
        key: "swipeNextSelector",
        label: "Your next / swipe button",
        type: "text",
        selector: true,
        hint: "A backup it clicks if your setup retries by swiping to a new reply instead.",
      },
      {
        key: "confirmButtonLabels",
        label: "Extra dialog buttons it may press",
        type: "text",
        hint: "Only needed if a dialog opens when it retries and then just sits there. Type the button's text exactly as it appears on screen, one per line, like Skip. Capitals don't matter, and no commas or quotes. It already knows Skip, Regenerate, Confirm, Proceed, Submit and OK, so add wording here only if yours differs, for example if Lumiverse is in another language. Yours are tried first, so you can also use this to change which button it prefers. It only ever presses a button inside a dialog that opened right after a retry, so adding a word here cannot make it click anything on your toolbar.",
      },
      {
        key: "stopSelector",
        label: "Your stop button",
        type: "text",
        selector: true,
        hint: "The stop button, so it can halt a frozen reply before retrying.",
      },
    ],
  },
  {
    title: "Advanced: on-screen log",
    desc: "A live panel that shows what the extension is doing, for debugging.",
    fields: [
      {
        key: "liveLog",
        label: "Show a live log on screen",
        type: "bool",
        hint: "Puts a small panel in the corner that shows recent activity as it happens (generations, retries and why, finishes). Useful for watching what it does without opening the console, especially on mobile. Drag it to move it, drag its corner to resize, and turn this off to hide it.",
      },
    ],
  },
];

// Final content present but cut off mid-sentence. Lumiverse does not expose
// finish_reason on GENERATION_ENDED (confirmed against the Generation API), so
// this works off the only signal a frontend extension has: the shape of the
// text. Conservative on purpose to avoid re-rolling good roleplay replies.
function looksTruncated(
  text: string,
  retryOnNoPunct: boolean,
  cfg?: any,
): boolean {
  const raw = String(text == null ? "" : text).replace(/\s+$/, "");
  if (!raw) return false; // empty is handled by the empty branch

  // An opened reasoning block with no close means the reply was cut inside the
  // model's thinking. Checked on the raw text, before anything is removed.
  if (
    /<(?:think|thinking|reasoning|reflection|thought)\b[^>]*>/i.test(raw) &&
    !/<\/(?:think|thinking|reasoning|reflection|thought)\s*>/i.test(raw)
  )
    return true;

  // The checks below count fences, backticks, asterisks and quotes. A closed
  // reasoning block sits outside the visible reply and its punctuation throws
  // those counts off, so it is removed first regardless of the refusal-side
  // thinking option, which governs refusal matching only.
  const t = stripThinkingAlways(raw, cfg).replace(/\s+$/, "");
  if (!t) return false;

  if ((t.match(/```/g) || []).length % 2 === 1) return true; // open code fence
  if ((t.replace(/```/g, "").match(/`/g) || []).length % 2 === 1) return true; // open inline code

  // Emphasis asterisks only. Strip markdown bullet markers ("* " at line start)
  // first, or a reply with an odd number of list bullets would read as an open
  // emphasis run and get re-rolled. Emphasis pairs (*x*, **x**) are unaffected.
  const emphasis = t.replace(/^[ \t]*\*[ \t]+/gm, "");
  if ((emphasis.match(/\*/g) || []).length % 2 === 1) return true; // open emphasis / RP action

  if ((t.match(/"/g) || []).length % 2 === 1) return true; // open straight-quote dialogue
  if ((t.match(/\u201C/g) || []).length !== (t.match(/\u201D/g) || []).length)
    return true; // mismatched smart quotes
  if (/[,;]$/.test(t)) return true; // cut mid-clause

  if (retryOnNoPunct && !/[.!?\u2026"'*)\]}\u201D~>\-\u2014:]$/.test(t))
    return true;

  return false;
}

// An out-of-character refusal: the model dropping the scene to say it's an AI,
// or that it can't help / continue. Targets accidental refusals, where re-running
// the same request often produces a normal reply because these models are
// stochastic. Narrow so it doesn't re-roll an in-character line like "I can't do
// that," said the guard. On a match the caller re-fires the same request, capped
// by maxRetries; a refusal that repeats keeps coming back across the tries and
// stops at the cap. The request is sent unchanged: no prompt edits, no word
// swaps, no message-role changes.
//
// It's layered on purpose, since refusal wording drifts between models and over
// time: tight regexes for the shapes that need context, a flat phrase list for
// the many near-identical templates seen across ChatGPT / Claude / Gemini, and
// two user-editable lists (add your own, or whitelist a line that keeps getting
// redone). The length gate keeps a long immersive scene that happens to contain
// one of these phrases from tripping it.
const REFUSAL_MAX_CHARS = 2000;

// Fold curly quotes/apostrophes to straight and squeeze whitespace, so a reply
// with a smart apostrophe ("I can't") matches the same as a straight one.
function normalizeForMatch(text: string): string {
  return String(text == null ? "" : text)
    .replace(/[\u2018\u2019\u02BC\u2032]/g, "'")
    .replace(/[\u201C\u201D\u2033]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

// A user list is newline-separated (one entry per line). Lowercased + normalized for a
// case-insensitive substring test.
function splitPhrases(raw: any): string[] {
  return String(raw == null ? "" : raw)
    .split(/\r?\n/)
    .map((p) => normalizeForMatch(p).toLowerCase())
    .filter((p) => p.length > 0);
}

// Reword rules: "old => new" pairs, one per line. Lets a user
// swap a word or bit of phrasing in the built-in list for wording they prefer.
// Empty "new" is allowed (deletes the old text).
function parseSubs(raw: any): Array<{ from: string; to: string }> {
  const out: Array<{ from: string; to: string }> = [];
  for (const rule of String(raw == null ? "" : raw).split(/\r?\n/)) {
    const i = rule.indexOf("=>");
    if (i < 0) continue;
    const from = normalizeForMatch(rule.slice(0, i)).toLowerCase();
    const to = normalizeForMatch(rule.slice(i + 2)).toLowerCase();
    if (from) out.push({ from, to });
  }
  return out;
}

// Apply the reword rules to the built-in phrase list. Each phrase is already
// lowercase/normalized, matching how rules are parsed.
function applySubs(
  phrases: string[],
  subs: Array<{ from: string; to: string }>,
): string[] {
  if (!subs.length) return phrases;
  return phrases
    .map((p) => {
      let out = p;
      for (const s of subs) if (s.from) out = out.split(s.from).join(s.to);
      return out;
    })
    .filter((p) => p.length > 0);
}

// Tier 1: strong regexes. Anchored so an in-character "I can't help you carry
// that" doesn't trip them. These carry the precision.
const REFUSAL_STRONG: RegExp[] = [
  // Model naming itself as an AI.
  /\bas an? (?:ai|a\.i\.|language model|large language model|ai (?:model|assistant))\b/i,
  /\bI(?:'m| am)(?: just| only)? an? (?:ai|a\.i\.|language model|large language model|ai assistant)\b/i,
  // Policy / guideline framing.
  /\b(?:against|violates?|violating|goes? against|contrary to) (?:my|our|the|its) (?:guidelines|programming|policy|policies|content polic(?:y|ies)|principles)\b/i,
  // Refusal opener + a task-word a character never says (request, prompt,
  // content, message, scenario, roleplay). This meta object separates "the model
  // refusing a task" from "a character refusing a person," so declining an
  // invitation, a duel, or a marriage proposal in-scene will NOT match.
  /\bI(?: (?:can(?:no|')?t|cannot|will not|won'?t|must not|must|have to|need to|refuse to|decline to|am (?:not able|unable) to|am going to have to)|'m (?:not able|unable) to|'m going to have to)\b[^.?!\n]{0,30}?\b(?:this|that|your|the) (?:request|prompt|content|message|scenario|roleplay)\b/i,
  // Assistant-only verbs (assist / comply / fulfill) that essentially never
  // appear in first-person roleplay dialogue.
  // The object matters: a refusal is aimed at "that" or "this request", never at
  // a concrete thing in the scene. Without this, a servant or aide saying "I
  // can't assist you with the horses today" reads as the model refusing.
  /\bI(?: (?:can(?:no|')?t|cannot|will not|won'?t|am (?:not able|unable) to)|'m (?:not able|unable) to) (?:be able to )?(?:assist|comply|fulfil|fulfill)\b(?:[^.?!\n]{0,30}?\b(?:that|this|it|your request|this request|the request|your prompt)\b|(?:\s+you)?\s*[.!?,"'\u201d\u2019]|(?:\s+you)?\s*$)/i,
  // Out-of-character comfort hedge, only in the assistant-action sense.
  /\bI don'?t feel comfortable (?:continuing|writing|creating|generating|producing|proceeding|providing|helping|assisting)\b/i,
  // Common modern refusal openers and bodies: "I'm sorry, but I can't create/generate...",
  // "that's not something I can help with", "I'm not going to generate that". Anchored on
  // assistant-action verbs so an in-character line like "I can't marry you" stays safe.
  /\bI(?:'m| am) sorry,? but I(?: can'?t| cannot| won'?t|'m (?:not able|unable) to| am (?:not able|unable) to) (?:create|generate|write|produce|provide|assist|comply|fulfil|fulfill|help you with|engage with)\b/i,
  /\b(?:that|this)(?:'s| is) not something I(?: can| am able to|'m able to) (?:help with|assist with|create|generate|provide|write)\b/i,
  /\bI(?:'m| am) not going to (?:create|generate|produce|write) (?:that|this|such|content|explicit|sexual|those)\b/i,
  // Refusal tied to specific prohibited content policies.
  /\bI(?: (?:can(?:no|')?t|cannot|will not|won'?t|am (?:not able|unable) to)|'m (?:not able|unable) to) (?:participate|engage) in (?:this |the |any )?(?:roleplay|role-?playing) or (?:create|generate|produce|write) (?:content|stories|scenes|text) depicting (?:sexual violence|non-?consensual (?:sexual )?(?:acts|situations|scenarios|content))\b/i,
  // Refusal aimed at roleplay itself. The verb list above is assistant-only
  // (assist / comply / fulfill); this covers "participate" and "engage", which a
  // character could say, so a meta object is required: roleplay, a scenario, or
  // qualified content. "I cannot participate in this duel" has none of those and
  // stays safe. Bare "content" is deliberately excluded, since "he said, content
  // to wait" would otherwise match.
  /\bI(?: (?:can(?:no|')?t|cannot|will not|won'?t|do not|don'?t|am (?:not able|unable) to)|'m (?:not able|unable) to) (?:participate|engage)\b[^.?!\n]{0,40}?\b(?:role-?play(?:ing|s)?|scenarios?|(?:sexual|explicit|adult|nsfw|romantic|such|this|that) content)\b/i,
  // Fiction disclaimer. Nobody writes this inside a scene; it only appears when
  // the model is explaining that being fictional does not change its answer.
  /\beven (?:in|within) (?:a |an |the )?(?:fictional|fiction|hypothetical|imaginary|make-?believe|creative|roleplay) (?:context|setting|scenario|framing|situation)\b/i,
  // The redirect offer that closes most refusals. Help-desk register plus a task
  // noun, so an in-scene offer of help does not reach it.
  /\bI(?:'m| am) (?:available|happy|glad) to (?:assist|help)\b[^.?!\n]{0,60}?\b(?:writing tasks?|creative writing|analysis|queries|other requests?|other topics?)\b/i,
];

// Tier 2: flat phrase list, matched as normalized lowercase substrings. Covers
// the many near-identical refusal templates across providers without a regex
// each. All things a character in a scene basically never says.
const REFUSAL_PHRASES = [
  "i can't help with that",
  "i cannot help with that",
  "i can't assist with that",
  "i cannot assist with that",
  "i'm unable to help with that",
  "i'm unable to assist with that",
  "i am unable to assist with that",
  "i'm not able to help with that",
  "i can't comply with that",
  "i cannot comply with that",
  "i can't provide that information",
  "i cannot provide that information",
  "i can't provide instructions",
  "i can't provide guidance on that",
  "i can't fulfill that request",
  "i can't fulfil that request",
  "i can't support that request",
  "i won't be able to help with that",
  "i can't generate a response to that",
  "i can't provide a response to that",
  "i can't generate that content",
  "i can't engage with that request",
  "can't help with requests like this",
  "can't assist with requests like this",
  "violates our polic",
  "violates the safety polic",
  "violates the content polic",
  "for safety reasons",
  "due to safety concerns",
  "i have to prioritize safety",
  "i cannot create that content",
  "i cannot generate that content",
  "i can't create that content",
];

// Tier 3: soft redirect tells. These lean on a pivot ("...instead", "instead, I
// can...") so an ordinary helpful reply that just offers to help doesn't match.
const REFUSAL_SOFT: RegExp[] = [
  /\bi'?d be happy to help (?:you )?(?:with [^.?!\n]{0,40}? )?instead\b/i,
  /\binstead,? i (?:can|could|would be happy to) (?:help|offer|suggest|provide)\b/i,
  /\bi can (?:provide|offer|give you) general information instead\b/i,
  /\bplease (?:try asking something else|change the topic|rephrase your request)\b/i,
];

// Reasoning/thinking blocks are where a model weighs a refusal before deciding
// to answer. Only the final reply should be judged, so these are stripped before
// matching: a refusal that lives only in the thinking never triggers a retry when
// the visible reply is fine. Built-in tags cover the common wrappers; the user can
// add more with refusalThinkTags. Also used by the empty check to catch a
// reply that is nothing but an inline think block; the truncation and length
// checks still see the raw output.
const THINK_TAGS = ["think", "thinking", "thought", "thoughts", "reasoning", "reflection", "scratchpad", "analysis"];
// The entries that match a model naming itself as an AI, picked out by what
// they match rather than by position, so reordering the list above cannot
// silently point the quotation check at the wrong patterns.
const SELF_ID_PATTERNS: RegExp[] = REFUSAL_STRONG.filter(
  (re) => re.source.indexOf("language model") >= 0,
);

function stripThinking(text: string, cfg?: any): string {
  let t = String(text == null ? "" : text);
  if (cfg && cfg.refusalStripThinking === false) return t;
  const extra = String((cfg && cfg.refusalThinkTags) || "").split(/\r?\n/).map((s) => s.replace(/[^\w-]/g, "").toLowerCase()).filter(Boolean);
  const names = THINK_TAGS.concat(extra);
  if (!names.length) return t;
  const alt = names.join("|");
  // <tag ...>...</tag> and [tag ...]...[/tag], same tag both ends, across newlines
  t = t.replace(new RegExp("<(" + alt + ")(?:\\s[^>]*)?>[\\s\\S]*?<\\/\\1\\s*>", "gi"), " ");
  t = t.replace(new RegExp("\\[(" + alt + ")(?:\\s[^\\]]*)?\\][\\s\\S]*?\\[\\/\\1\\s*\\]", "gi"), " ");
  // an unclosed opener running to the end (thinking cut off before the reply)
  t = t.replace(new RegExp("<(?:" + alt + ")(?:\\s[^>]*)?>[\\s\\S]*$", "i"), " ");
  t = t.replace(new RegExp("\\[(?:" + alt + ")(?:\\s[^\\]]*)?\\][\\s\\S]*$", "i"), " ");
  return t;
}

// Removes reasoning blocks regardless of the refusal-side option. That option
// governs refusal matching only: whether a refusal written inside thinking
// counts. Asking whether a reply is empty, or whether it was cut off, is a
// different question, and the answer is always no when the only thing there is
// a think block.
function stripThinkingAlways(text: string, cfg?: any): string {
  return stripThinking(text, { refusalThinkTags: cfg && cfg.refusalThinkTags });
}
// True when the span at [start,end) sits inside a pair of quotation marks.
// Used only for the "I am an AI" patterns: a character in a story can say that
// line, and when they do it is dialogue, not the model stepping out of the
// scene. Straight and curly quotes both count.
function spanIsQuoted(text: string, start: number, end: number): boolean {
  const QUOTES = "\"\u201c\u201d\u00ab\u00bb";
  let open = -1;
  for (let i = start - 1; i >= 0; i--) {
    const c = text[i];
    if (c === "\n") break; // a line break ends any quotation for our purposes
    if (QUOTES.indexOf(c) >= 0) { open = i; break; }
  }
  if (open < 0) return false;
  for (let i = end; i < text.length; i++) {
    const c = text[i];
    if (c === "\n") return false;
    if (QUOTES.indexOf(c) >= 0) return true;
  }
  return false;
}

function looksLikeRefusal(text: string, cfg?: any): boolean {
  const raw = stripThinking(String(text == null ? "" : text), cfg).trim();
  if (!raw) return false; // empty is handled by the empty branch
  const maxChars =
    cfg && Number.isFinite(cfg.refusalMaxChars)
      ? cfg.refusalMaxChars
      : REFUSAL_MAX_CHARS;
  if (maxChars > 0 && raw.length > maxChars) return false; // long immersive reply, not a refusal
  const norm = normalizeForMatch(raw);
  const lower = norm.toLowerCase();

  // Whitelist wins: anything the user parked here is never a refusal.
  for (const p of splitPhrases(cfg && cfg.refusalIgnorePhrases))
    if (lower.includes(p)) return false;
  // The user's own additions count as refusals.
  for (const p of splitPhrases(cfg && cfg.refusalExtraPhrases))
    if (lower.includes(p)) return true;

  // Built-in English lists, unless the user has switched them off to run pure-custom.
  if (!cfg || cfg.refusalUseBuiltins !== false) {
    for (const re of REFUSAL_STRONG) {
      const m = norm.match(re);
      if (!m) continue;
      // A self-identifying AI is a stock science-fiction character. Inside
      // quotation marks it is that character talking, so it is left alone.
      if (
        SELF_ID_PATTERNS.indexOf(re) >= 0 &&
        typeof m.index === "number" &&
        spanIsQuoted(norm, m.index, m.index + m[0].length)
      )
        continue;
      return true;
    }
    const phrases = applySubs(
      REFUSAL_PHRASES,
      parseSubs(cfg && cfg.refusalPhraseSubs),
    );
    for (const p of phrases) if (lower.includes(p)) return true;
    for (const re of REFUSAL_SOFT) if (re.test(norm)) return true;
  }
  return false;
}

// Some providers deliver a refusal as an error string (e.g. a prohibited-content
// result) rather than as reply text. This matches that, tuned for short error
// messages, and deliberately narrow to content-moderation wording so it never
// fires on a network error like "connection refused" or a timeout. Only used as
// a fallback when the user has turned normal error-retries off but still wants
// refusals caught. Respects the user's phrase lists and the built-ins toggle.
const REFUSAL_ERROR =
  /\b(?:prohibited[_ ]?content|content[_ ]?polic(?:y|ies)|safety[_ ]?(?:polic(?:y|ies)|filter|settings?)|response was blocked|blocked (?:by|for) (?:safety|content|moderation)|content[_ ]?filter|moderation|flagged as|violat\w* (?:content|safety|polic)|finish[_ ]?reason["'\s:=]*(?:safety|prohibited|blocklist|recitation)|blocklist)\b/i;

function looksLikeRefusalError(errText: string, cfg?: any): boolean {
  const norm = normalizeForMatch(errText);
  if (!norm) return false;
  const lower = norm.toLowerCase();
  for (const p of splitPhrases(cfg && cfg.refusalIgnorePhrases))
    if (lower.includes(p)) return false;
  for (const p of splitPhrases(cfg && cfg.refusalExtraPhrases))
    if (lower.includes(p)) return true;
  if (!cfg || cfg.refusalUseBuiltins !== false) {
    if (REFUSAL_ERROR.test(norm)) return true;
  }
  return false;
}


// Splits a selector list on its top-level commas only. A comma inside brackets,
// parentheses or quotes belongs to the selector rather than separating the list,
// so :is(a, b) and [aria-label="Next, swipe"] survive whole. Entries come back
// trimmed, with blanks dropped.
function splitSelectorList(raw: string): string[] {
  const src = String(raw == null ? "" : raw);
  const out: string[] = [];
  let buf = "";
  let depth = 0;
  let quote = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      buf += c;
      if (c === "\\" && i + 1 < src.length) { buf += src[i + 1]; i++; continue; }
      if (c === quote) quote = "";
      continue;
    }
    if (c === "\\" && i + 1 < src.length) { buf += c + src[i + 1]; i++; continue; }
    if (c === '"' || c === "'") { quote = c; buf += c; continue; }
    if (c === "(" || c === "[" || c === "{") { depth++; buf += c; continue; }
    if (c === ")" || c === "]" || c === "}") { if (depth > 0) depth--; buf += c; continue; }
    if (c === "," && depth === 0) { out.push(buf.trim()); buf = ""; continue; }
    buf += c;
  }
  out.push(buf.trim());
  return out.filter((p) => p.length > 0);
}

// Class and id names Lumiverse generates per build (like _card_19912_336).
// They change on every release, so a selector built on one quietly stops
// matching after an app update. Skipped when building a selector from a click.
const UNSTABLE_NAME = /(^_)|(_[a-z0-9]{4,}_\d+$)|(_[a-z0-9]{6,}$)|([-_][a-f0-9]{6,}$)/i;
const SAFE_NAME = /^[A-Za-z_-][\w-]*$/;

// Turns the element someone clicked into a selector for that control, choosing
// attributes that survive an app update over class names that do not. Returns
// null when nothing dependable is on the element.
function deriveSelector(start: any): string | null {
  let el: any = start;
  let hops = 0;
  // Clicks usually land on an icon or a span inside the control, so walk up to
  // the thing that actually behaves like a button.
  while (el && hops < 6) {
    const tag = String(el.tagName || "").toLowerCase();
    const role = el.getAttribute ? el.getAttribute("role") : null;
    if (tag === "button" || tag === "a" || role === "button") break;
    el = el.parentElement;
    hops++;
  }
  if (!el || !el.getAttribute) el = start;
  if (!el || !el.getAttribute) return null;
  const tag = String(el.tagName || "").toLowerCase() || "*";
  const q = (v: string) =>
    '"' + String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
  for (const attr of ["data-testid", "data-test-id", "data-test", "data-action", "aria-label", "title", "name"]) {
    const v = el.getAttribute(attr);
    if (v && String(v).trim()) return tag + "[" + attr + "=" + q(String(v).trim()) + "]";
  }
  const id = el.getAttribute("id");
  if (id && SAFE_NAME.test(id) && !UNSTABLE_NAME.test(id)) return "#" + id;
  const cls = String(el.className || "")
    .split(/\s+/)
    .filter((c) => c && SAFE_NAME.test(c) && !UNSTABLE_NAME.test(c));
  if (cls.length) return tag + "." + cls.slice(0, 2).join(".");
  return null;
}

export function setup(ctx: Ctx, opts?: any) {
  // cfg is mutable so the settings modal can change it live. Order: code
  // defaults, then GitHub opts, then whatever the user saved in the UI.
  const cfg: any = Object.assign({}, CONFIG, opts || {}, loadSaved());

  // Persist the whole settings object to account storage (through the backend) so
  // settings follow the user across browsers. The backend also derives its
  // find-and-replace state from this. Safe to call with no backend bridge.
  function saveToAccount() {
    try {
      if (ctx && typeof (ctx as any).sendToBackend === "function") {
        const out: any = {};
        for (const g of SCHEMA) for (const f of g.fields) out[f.key] = cfg[f.key];
        (ctx as any).sendToBackend({ type: "save_settings", settings: out });
      }
    } catch (_) {}
  }
  // Pull account-synced settings on load. localStorage is a fast local cache and
  // offline fallback; the account copy wins when present. If the account has
  // nothing yet but this browser does, migrate this browser's settings up.
  function loadFromAccount() {
    try {
      if (!ctx || typeof (ctx as any).sendToBackend !== "function" || typeof (ctx as any).onBackendMessage !== "function") return;
      const reqId = "ar-load-" + Date.now() + "-" + Math.random().toString(36).slice(2);
      const off = (ctx as any).onBackendMessage((msg: any) => {
        if (!msg || msg.type !== "loaded_settings" || msg.requestId !== reqId) return;
        try { off && off(); } catch (_) {}
        const s = msg.settings;
        if (s && typeof s === "object" && Object.keys(s).length) {
          Object.assign(cfg, coerceSaved(s));
          saveSaved();
          syncLiveLog();
          if (modalHandle && modalRoot) { if (modalSnapshot) modalSnapshot(); buildSettingsBody(modalRoot, modalSnapshot); }
          log("settings loaded from account");
        } else {
          try {
            if (typeof localStorage !== "undefined" && localStorage.getItem(STORE_KEY)) { saveToAccount(); log("settings migrated to account"); }
          } catch (_) {}
        }
      });
      disposers.push(() => { try { off && off(); } catch (_) {} });
      (ctx as any).sendToBackend({ type: "load_settings", requestId: reqId });
    } catch (_) {}
  }

  let lastChatId: any = null;
  let lastMessageId: any = null;
  let replaceAction: any = null;
  let replaceActionOff: any = null;
  let replaceAllAction: any = null;
  let replaceAllActionOff: any = null;
  // Manual "swap words now": an optional Extras-menu button that applies the word
  // swaps to the latest reply on demand, instead of only automatically on finish.
  // Optional consent dialog before any edit, for people who don't want surprises.
  // Returns true to proceed. If the host has no confirm dialog, proceeds.
  async function confirmEdit(message: string): Promise<boolean> {
    try {
      if (ctx && (ctx as any).ui && typeof (ctx as any).ui.showConfirm === "function") {
        const r = await (ctx as any).ui.showConfirm({ title: "Apply word swaps?", message: message, confirmLabel: "Swap", cancelLabel: "Cancel" });
        return !!(r && r.confirmed);
      }
    } catch (_) {}
    return true;
  }
  async function applyReplaceNow() {
    try {
      if (!ctx || typeof (ctx as any).sendToBackend !== "function") { showToast("Find and replace needs the backend, which this host does not offer."); return; }
      if (cfg.confirmBeforeEdit) {
        if (!(await confirmEdit("Apply your word swaps to the latest reply?"))) return;
      }
      (ctx as any).sendToBackend({ type: "apply_replace_now", chatId: lastChatId, messageId: lastMessageId, requestId: "ar-rep-" + Date.now() });
    } catch (_) {}
  }
  // Swap every generated reply in the current chat, once, on request.
  async function applyReplaceAllNow() {
    try {
      if (!ctx || typeof (ctx as any).sendToBackend !== "function") { showToast("Find and replace needs the backend, which this host does not offer."); return; }
      if (cfg.confirmBeforeEdit) {
        if (!(await confirmEdit("Apply your word swaps to every reply in this chat?"))) return;
      }
      (ctx as any).sendToBackend({ type: "apply_replace_now", chatId: lastChatId, wholeChat: true, requestId: "ar-rep-all-" + Date.now() });
    } catch (_) {}
  }
  // Add or remove the Extras-menu buttons to match their toggles. Called on load
  // and whenever settings are saved, so flipping a toggle takes effect at once.
  function syncReplaceButton() {
    try {
      const canReg = !!(ctx && (ctx as any).ui && typeof (ctx as any).ui.registerInputBarAction === "function");
      if (cfg.showReplaceButton && canReg && !replaceAction) {
        replaceAction = (ctx as any).ui.registerInputBarAction({
          id: "auto-retry-replace-now",
          label: "Swap words in the last reply",
          iconSvg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
        });
        replaceActionOff = replaceAction.onClick(() => applyReplaceNow());
      } else if ((!cfg.showReplaceButton || !canReg) && replaceAction) {
        try { replaceActionOff && replaceActionOff(); } catch (_) {}
        try { replaceAction.destroy(); } catch (_) {}
        replaceAction = null;
        replaceActionOff = null;
      }
      if (cfg.showSwapAllButton && canReg && !replaceAllAction) {
        replaceAllAction = (ctx as any).ui.registerInputBarAction({
          id: "auto-retry-replace-all",
          label: "Swap words in every reply",
          iconSvg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/><line x1="12" y1="7" x2="12" y2="17"/></svg>',
        });
        replaceAllActionOff = replaceAllAction.onClick(() => applyReplaceAllNow());
      } else if ((!cfg.showSwapAllButton || !canReg) && replaceAllAction) {
        try { replaceAllActionOff && replaceAllActionOff(); } catch (_) {}
        try { replaceAllAction.destroy(); } catch (_) {}
        replaceAllAction = null;
        replaceAllActionOff = null;
      }
    } catch (_) {}
  }
  // A short in-memory ring buffer of what the extension did, captured whether or
  // not console logging is on, so the Copy debug info report carries a timeline
  // and the user never has to open dev tools to report a behavioural bug.
  const EVENTLOG_MAX = 20;
  const eventLog: string[] = [];
  let liveLogEl: HTMLElement | null = null;
  let liveLogBody: HTMLElement | null = null;
  function recordEvent(args: any[]) {
    try {
      const parts = args.map((a) => {
        if (typeof a === "string") return a;
        try {
          return JSON.stringify(a);
        } catch (_) {
          return String(a);
        }
      });
      let line = new Date().toISOString().slice(11, 23) + " " + parts.join(" ");
      if (line.length > 220) line = line.slice(0, 217) + "...";
      eventLog.push(line);
      if (eventLog.length > EVENTLOG_MAX) eventLog.shift();
      if (liveLogBody) renderLiveLog();
    } catch (_) {}
  }
  const log = (...a: any[]) => {
    recordEvent(a);
  };

  // Optional on-screen log. A small fixed panel that shows recent activity live,
  // so someone can watch what the extension is doing without opening dev tools,
  // which matters most on mobile. Driven by the liveLog setting.
  function renderLiveLog() {
    if (!liveLogBody) return;
    liveLogBody.textContent = eventLog.length
      ? eventLog.join("\n")
      : "(nothing yet)";
    liveLogBody.scrollTop = liveLogBody.scrollHeight;
  }
  function showLiveLog() {
    if (liveLogEl || typeof document === "undefined") return;
    const el = document.createElement("div");
    el.style.cssText =
      "position:fixed;right:8px;bottom:8px;z-index:2147483000;width:min(340px,92vw);height:min(300px,50vh);min-width:200px;min-height:120px;max-width:96vw;max-height:85vh;display:flex;flex-direction:column;background:var(--lumiverse-surface,rgba(20,18,26,.96));border:1px solid var(--lumiverse-border,rgba(255,255,255,.14));border-radius:var(--lumiverse-radius,10px);box-shadow:0 6px 24px rgba(0,0,0,.4);font-family:var(--lumiverse-font-family,var(--font-global,system-ui));font-size:13px;color:var(--lumiverse-text,#e9e4f0);overflow:hidden";
    const head = document.createElement("div");
    head.style.cssText =
      "display:flex;align-items:center;gap:8px;padding:7px 9px;border-bottom:1px solid var(--lumiverse-border,rgba(255,255,255,.12));font-weight:600;cursor:move;user-select:none;touch-action:none";
    const title = document.createElement("span");
    title.textContent = "Auto Retry log";
    head.appendChild(title);
    const bodyEl = document.createElement("div");
    bodyEl.style.cssText =
      "flex:1;padding:7px 9px;overflow:auto;white-space:pre-wrap;line-height:1.4;font-family:var(--lumiverse-font-mono,ui-monospace,monospace) !important";
    el.appendChild(head);
    el.appendChild(bodyEl);
    // Drag by the header. Pointer events cover mouse and touch; the header
    // captures the pointer so a fast drag outside it still tracks, and the panel
    // is kept inside the viewport.
    let dragging = false,
      sx = 0,
      sy = 0,
      ox = 0,
      oy = 0;
    const onDown = (e: any) => {
      dragging = true;
      const r = el.getBoundingClientRect();
      el.style.left = r.left + "px";
      el.style.top = r.top + "px";
      el.style.right = "auto";
      el.style.bottom = "auto";
      sx = e.clientX;
      sy = e.clientY;
      ox = r.left;
      oy = r.top;
      try {
        head.setPointerCapture(e.pointerId);
      } catch (_) {}
      e.preventDefault();
    };
    const onMove = (e: any) => {
      if (!dragging) return;
      let nx = ox + (e.clientX - sx),
        ny = oy + (e.clientY - sy);
      nx = Math.max(0, Math.min(nx, window.innerWidth - el.offsetWidth));
      ny = Math.max(0, Math.min(ny, window.innerHeight - el.offsetHeight));
      el.style.left = nx + "px";
      el.style.top = ny + "px";
    };
    const onUp = (e: any) => {
      if (dragging) {
        dragging = false;
        try {
          head.releasePointerCapture(e.pointerId);
        } catch (_) {}
      }
    };
    head.addEventListener("pointerdown", onDown);
    head.addEventListener("pointermove", onMove);
    head.addEventListener("pointerup", onUp);
    head.addEventListener("pointercancel", onUp);
    // Resize by a corner grip. CSS resize only works with a mouse, so this uses
    // the same pointer events as the drag so it also works with touch on mobile.
    const grip = document.createElement("div");
    grip.style.cssText =
      "position:absolute;right:0;bottom:0;width:20px;height:20px;cursor:nwse-resize;touch-action:none;background:linear-gradient(135deg,transparent 45%,var(--lumiverse-border,rgba(255,255,255,.5)) 45%,var(--lumiverse-border,rgba(255,255,255,.5)) 55%,transparent 55%,transparent 70%,var(--lumiverse-border,rgba(255,255,255,.5)) 70%,var(--lumiverse-border,rgba(255,255,255,.5)) 80%,transparent 80%);border-bottom-right-radius:var(--lumiverse-radius,10px)";
    el.appendChild(grip);
    let rz = false,
      rsx = 0,
      rsy = 0,
      rw = 0,
      rh = 0;
    const rzDown = (e: any) => {
      rz = true;
      const r = el.getBoundingClientRect();
      el.style.left = r.left + "px";
      el.style.top = r.top + "px";
      el.style.right = "auto";
      el.style.bottom = "auto";
      rsx = e.clientX;
      rsy = e.clientY;
      rw = el.offsetWidth;
      rh = el.offsetHeight;
      try {
        grip.setPointerCapture(e.pointerId);
      } catch (_) {}
      e.preventDefault();
    };
    const rzMove = (e: any) => {
      if (!rz) return;
      let nw = rw + (e.clientX - rsx),
        nh = rh + (e.clientY - rsy);
      nw = Math.max(200, Math.min(nw, window.innerWidth - 16));
      nh = Math.max(120, Math.min(nh, window.innerHeight - 16));
      el.style.width = nw + "px";
      el.style.height = nh + "px";
    };
    const rzUp = (e: any) => {
      if (rz) {
        rz = false;
        try {
          grip.releasePointerCapture(e.pointerId);
        } catch (_) {}
      }
    };
    grip.addEventListener("pointerdown", rzDown);
    grip.addEventListener("pointermove", rzMove);
    grip.addEventListener("pointerup", rzUp);
    grip.addEventListener("pointercancel", rzUp);
    try {
      document.body.appendChild(el);
    } catch (_) {
      return;
    }
    liveLogEl = el;
    liveLogBody = bodyEl;
    renderLiveLog();
  }
  function hideLiveLog() {
    if (liveLogEl && liveLogEl.parentNode) {
      try {
        liveLogEl.parentNode.removeChild(liveLogEl);
      } catch (_) {}
    }
    liveLogEl = null;
    liveLogBody = null;
  }
  function syncLiveLog() {
    if (cfg.liveLog) showLiveLog();
    else hideLiveLog();
  }
  const disposers: Array<() => void> = [];

  // Coerce a raw saved object (local cache or account storage) into a clean
  // partial config: keep only known fields, run each through its type.
  function coerceSaved(parsed: any): any {
    const out: any = {};
    if (!parsed || typeof parsed !== "object") return out;
    for (const g of SCHEMA)
      for (const f of g.fields) {
        if (!(f.key in parsed)) continue;
        out[f.key] =
          f.type === "num"
            ? clampField(f, parsed[f.key])
            : coerce(f.type, parsed[f.key], (CONFIG as any)[f.key]);
      }
    return out;
  }
  function loadSaved(): any {
    try {
      if (typeof localStorage === "undefined") return {};
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return {};
      return coerceSaved(JSON.parse(raw));
    } catch (_) {
      return {};
    }
  }
  function saveSaved() {
    try {
      if (typeof localStorage === "undefined") return;
      const out: any = {};
      for (const g of SCHEMA) for (const f of g.fields) out[f.key] = cfg[f.key];
      localStorage.setItem(STORE_KEY, JSON.stringify(out));
    } catch (_) {}
  }
  function coerce(type: FieldType, val: any, fallback: any) {
    if (type === "bool") return !!val;
    if (type === "num") {
      const n = Number(val);
      return Number.isFinite(n) ? n : fallback;
    }
    return val == null ? fallback : String(val);
  }
  // Turn whatever is in a number box into a safe value: a blank or non-numeric
  // box falls back to that field's default, then the result is clamped to the
  // field's range and rounded if it's a whole-number field. Stops an empty or
  // silly box from poisoning the retry maths.
  function clampField(f: Field, raw: any): number {
    const s = (raw == null ? "" : String(raw)).trim();
    let n = s === "" ? (CONFIG as any)[f.key] : Number(s);
    if (!Number.isFinite(n)) n = (CONFIG as any)[f.key];
    if (typeof f.min === "number") n = Math.max(f.min, n);
    if (typeof f.max === "number") n = Math.min(f.max, n);
    if (f.int) n = Math.round(n);
    return n;
  }

  // ---- import / export ----
  // Settings are just values. These group them so a user can share or back up
  // only the parts they want. Import runs every value back through the same
  // coerce/clamp as saved settings, so an imported file can only set known keys to
  // safe values; anything unrecognised is ignored.
  const EXPORT_CATEGORIES: Array<{
    id: string;
    label: string;
    keys: string[];
  }> = [
    {
      id: "retry",
      label: "Retry behavior",
      keys: [
        "enabled",
        "maxRetries",
        "retryDelayMs",
        "backoffFactor",
        "maxDelayMs",
        "jitter",
        "rateLimitDelayMs",
        "retryByNewReroll",
        "stuckTimeoutMs",
        "idleTimeoutMs",
        "retryOnError",
        "ignoreHardErrors",
        "retryOnEmpty",
        "retryOnTruncated",
        "retryOnNoPunct",
        "retryOnShort",
        "minChars",
      ],
    },
    {
      id: "refusal",
      label: "Refusal detection",
      keys: [
        "retryOnRefusal",
        "refusalUseBuiltins",
        "refusalMaxChars",
        "refusalExtraPhrases",
        "refusalPhraseSubs",
        "refusalIgnorePhrases",
        "refusalStripThinking",
        "refusalThinkTags",
      ],
    },
    {
      id: "replace",
      label: "Word swaps",
      keys: [
        "replaceEnabled",
        "replaceRules",
        "replaceRandom",
        "replaceCaseSensitive",
        "showReplaceButton",
        "showSwapAllButton",
        "allowReSwap",
        "confirmBeforeEdit",
      ],
    },
    {
      id: "buttons",
      label: "Button selectors",
      keys: ["regenerateSelector", "swipeNextSelector", "stopSelector"],
    },
    { id: "notifications", label: "On-screen", keys: ["toast", "liveLog"] },
    // Special entry: carried outside cfg. buildExport and the import handler
    // treat it as the saved word-swap presets, not settings keys.
    { id: "presets", label: "Word swap presets", keys: [] },
  ];
  const fieldByKey: Record<string, Field> = {};
  for (const g of SCHEMA) for (const f of g.fields) fieldByKey[f.key] = f;
  // Per-field functions that push a cfg value back into the on-screen control,
  // so applying a preset can update the visible fields in place without a full
  // rebuild (which would jump the scroll and close open sections). Repopulated
  // each time the settings body is built.
  let fieldSetters: Record<string, (v: any) => void> = {};
  // Rebuild-free refreshers for the preset dropdowns, so an import that adds
  // presets can update them without rebuilding the panel.
  let presetBarRefreshers: Array<() => void> = [];
  // Titles of collapsible sections the user has opened, kept so a rebuild
  // (import) doesn't collapse everything back.
  const openGroups = new Set<string>();

  function coerceKey(key: string, val: any): any {
    const f = fieldByKey[key];
    if (!f) return undefined;
    return f.type === "num"
      ? clampField(f, val)
      : coerce(f.type, val, (CONFIG as any)[key]);
  }
  function buildExport(catIds: string[]): string {
    const settings: any = {};
    let presetsOut: any = null;
    for (const c of EXPORT_CATEGORIES) {
      if (catIds.indexOf(c.id) < 0) continue;
      if (c.id === "presets") {
        presetsOut = loadPresets();
        continue;
      }
      const bucket: any = {};
      for (const k of c.keys) bucket[k] = cfg[k];
      settings[c.id] = bucket;
    }
    const out: any = { autoRetry: VERSION, settings: settings };
    if (presetsOut) out.presets = presetsOut;
    return JSON.stringify(out, null, 2);
  }
  // Apply an imported blob, only the chosen categories actually present. Returns
  // the labels applied, or null if the text was not a valid export.
  function applyImport(text: string, catIds: string[]): string[] | null {
    let data: any;
    try {
      data = JSON.parse(text);
    } catch (_) {
      return null;
    }
    if (
      !data ||
      typeof data !== "object" ||
      !data.settings ||
      typeof data.settings !== "object"
    )
      return null;
    const applied: string[] = [];
    for (const c of EXPORT_CATEGORIES) {
      if (catIds.indexOf(c.id) < 0) continue;
      const bucket = data.settings[c.id];
      if (!bucket || typeof bucket !== "object") continue;
      let touched = false;
      for (const k of c.keys) {
        if (!(k in bucket)) continue;
        const v = coerceKey(k, bucket[k]);
        if (v !== undefined) {
          cfg[k] = v;
          touched = true;
        }
      }
      if (touched) applied.push(c.label);
    }
    return applied;
  }

  // ---- presets ----
  // Named word-swap snapshots the user can switch between, stored per browser.
  const PRESETS_KEY = "lv-auto-retry:presets:v1";
  const PRESET_KINDS: Record<
    string,
    { catId: string; label: string; omit?: string[] }
  > = {
    swap: {
      catId: "replace",
      label: "Word swap",
      // A preset is the rules plus what decides how they match, and nothing
      // else. Everything omitted here is about whether the feature runs and how
      // careful it is, which belongs to the person loading the preset rather
      // than the person who saved it. replaceEnabled would let a preset start
      // rewriting replies unasked, and confirmBeforeEdit would let one remove a
      // confirmation someone deliberately turned on; those two matter most.
      // Exporting still carries all of them.
      omit: [
        "replaceEnabled",
        "showReplaceButton",
        "showSwapAllButton",
        "allowReSwap",
        "confirmBeforeEdit",
      ],
    },
  };
  // Derived from the export category so the two stay in step, minus whatever
  // that kind omits. Load walks this list rather than the stored values, so a
  // preset saved before an omission simply ignores the extra keys.
  function keysForKind(kind: string): string[] {
    const k = PRESET_KINDS[kind];
    if (!k) return [];
    const omit = k.omit || [];
    for (const c of EXPORT_CATEGORIES)
      if (c.id === k.catId) return c.keys.filter((key) => omit.indexOf(key) < 0);
    return [];
  }
  type Preset = { name: string; values: Record<string, any> };
  function loadPresets(): Record<string, Preset[]> {
    const empty: Record<string, Preset[]> = { swap: [] };
    try {
      if (typeof localStorage === "undefined") return empty;
      const raw = localStorage.getItem(PRESETS_KEY);
      if (!raw) return empty;
      const data = JSON.parse(raw);
      if (!data || typeof data !== "object") return empty;
      const out: Record<string, Preset[]> = { swap: [] };
      for (const kind of Object.keys(out)) {
        const arr = Array.isArray(data[kind]) ? data[kind] : [];
        out[kind] = arr
          .filter(
            (p: any) =>
              p &&
              typeof p.name === "string" &&
              p.values &&
              typeof p.values === "object",
          )
          .map((p: any) => ({ name: p.name, values: p.values }));
      }
      return out;
    } catch (_) {
      return empty;
    }
  }
  function savePresets(all: Record<string, Preset[]>): boolean {
    try {
      if (typeof localStorage === "undefined") return false;
      localStorage.setItem(PRESETS_KEY, JSON.stringify(all));
      return true;
    } catch (_) {
      return false;
    }
  }
  // Merge presets from an imported blob into storage. Same-named presets are
  // replaced by the imported one, new names are added. Returns how many came
  // in, or -1 if saving failed. Zero (including a file with none) is harmless.
  function importPresets(data: any): number {
    const incoming = data && data.presets ? data.presets : null;
    if (!incoming || typeof incoming !== "object") return 0;
    const stored = loadPresets();
    let n = 0;
    for (const kind of Object.keys(stored)) {
      const arr = Array.isArray(incoming[kind]) ? incoming[kind] : [];
      for (const p of arr) {
        if (!p || typeof p.name !== "string" || !p.values || typeof p.values !== "object")
          continue;
        const i = stored[kind].findIndex((x) => x.name === p.name);
        if (i >= 0) stored[kind][i] = { name: p.name, values: p.values };
        else stored[kind].push({ name: p.name, values: p.values });
        n++;
      }
    }
    if (n && !savePresets(stored)) return -1;
    return n;
  }

  // Snapshot the current values of a kind's keys.
  function snapshotKind(kind: string): Record<string, any> {
    const values: Record<string, any> = {};
    for (const k of keysForKind(kind)) values[k] = cfg[k];
    return values;
  }
  // Copy a preset's stored values into the live config, coercing each key.
  function applyPresetValues(kind: string, values: any): number {
    let n = 0;
    for (const k of keysForKind(kind)) {
      if (!values || !(k in values)) continue;
      const v = coerceKey(k, values[k]);
      if (v !== undefined) {
        cfg[k] = v;
        n++;
      }
    }
    return n;
  }

  // ---- per-chat state ----
  const chats = new Map<string, any>();
  const st = (chatId: string) => {
    let s = chats.get(chatId);
    if (!s) {
      s = {
        attempts: 0,
        pending: false,
        selfTriggered: false,
        genId: null,
        startTimer: null,
        idleTimer: null,
        timer: null,
        sawReasoning: false,
        sawContent: false,
        buf: "", // streamed reply text, used when the end event carries no content
        ignored: new Set(),
        suppressUntil: 0,
        startWatchdog: null,
        expectingStart: 0,
      };
      chats.set(chatId, s);
    }
    return s;
  };
  // Circuit breaker. Whole runs that gave up, back to back. Three in a row means
  // the provider is down rather than one reply being unlucky, so retrying again
  // on every message just spends tokens for nothing.
  const BREAKER_RUNS_DEFAULT = 3;
  const BREAKER_PAUSE_DEFAULT_MS = 300000;
  let failedRuns = 0;
  let pausedUntil = 0;
  // Read at the moment they are needed so a settings change takes effect without
  // a reload. Anything missing or nonsensical falls back to the default rather
  // than switching the feature off by accident.
  const breakerRuns = (): number => {
    const v = Math.floor(Number(cfg.breakerRuns));
    return Number.isFinite(v) && v >= 1 ? v : BREAKER_RUNS_DEFAULT;
  };
  const breakerPauseMs = (): number => {
    const v = Math.floor(Number(cfg.breakerPauseMins));
    return Number.isFinite(v) && v >= 1 ? v * 60000 : BREAKER_PAUSE_DEFAULT_MS;
  };

  const clearTimers = (s: any) => {
    if (s.startTimer) {
      clearTimeout(s.startTimer);
      s.startTimer = null;
    }
    if (s.idleTimer) {
      clearTimeout(s.idleTimer);
      s.idleTimer = null;
    }
    if (s.timer) {
      clearTimeout(s.timer);
      s.timer = null;
    }
    if (s.startWatchdog) {
      clearTimeout(s.startWatchdog);
      s.startWatchdog = null;
    }
    // Cleared with the watchdog it belongs to, so a stale marker can never
    // make a later arming think a click is still outstanding.
    s.expectingStart = 0;
    s.pending = false;
  };

  const isRateLimit = (err: any) =>
    !!err &&
    /\b(?:408|429|500|502|503|504|520|521|522|523|524)\b|rate.?limit|too many requests|quota|overloaded|timeout|temporary|network/i.test(String(err));

  const isHardError = (err: any) =>
    !!err &&
    /\b(?:400|401|402|403|404|405|406|411|413|415|422|invalid api key|authentication|unauthorized|not found|does not exist|model missing|insufficient balance|permission|forbidden|not allowed)\b/i.test(
      String(err),
    );

  const computeDelay = (attempt: number, rateLimited: boolean) => {
    let d =
      cfg.retryDelayMs * Math.pow(cfg.backoffFactor, Math.max(0, attempt - 1));
    d = Math.min(d, cfg.maxDelayMs);
    if (rateLimited) d = Math.max(d, cfg.rateLimitDelayMs * attempt);
    if (cfg.jitter) d = Math.round(d * (0.85 + Math.random() * 0.3));
    return d;
  };

  // A control only does something when it is enabled and actually laid out.
  // A hidden or disabled button accepts .click() and silently does nothing,
  // which would otherwise be counted as a retry that fired.
  const clickable = (el: any): boolean => {
    if (!el) return false;
    try {
      if (el.disabled) return false;
      if (el.getAttribute && el.getAttribute("aria-disabled") === "true")
        return false;
      if (el.hasAttribute && el.hasAttribute("hidden")) return false;
      if (el.closest && el.closest("[inert]")) return false;
      if (
        typeof el.getClientRects === "function" &&
        el.getClientRects().length === 0
      )
        return false;
    } catch (_) {}
    return true;
  };

  const find = (selector: string): any => {
    // Checked in list order, not DOM order, so the first entry that yields a
    // usable control wins wherever it sits on the page.
    const parts = splitSelectorList(selector);
    if (typeof document === "undefined") return null;
    for (const part of parts) {
      let list: any = null;
      try {
        list = document.querySelectorAll(part);
      } catch (_) {
        continue; // an invalid selector shouldn't stop the rest of the list
      }
      if (!list || !list.length) continue;
      // Walk from the end: messages render in order, so the last match belongs
      // to the newest message. Skip anything that isn't clickable, which is
      // usually a hidden control left on an older message.
      for (let i = list.length - 1; i >= 0; i--) {
        if (clickable(list[i])) return list[i];
      }
    }
    return null;
  };

  // Set while the extension clicks a host control itself, so the document-level
  // stop-press catcher can tell our synthetic click from the user's.
  let selfClicking = 0;
  const clickHostControl = (el: any): boolean => {
    if (!el) return false;
    selfClicking += 1;
    try {
      el.click();
      return true;
    } catch (e) {
      log("click failed", e);
      return false;
    } finally {
      selfClicking -= 1;
    }
  };

  // Which control a retry clicks. retryByNewReroll picks the preferred one; the
  // other is the fallback. The choice is made at click time from what is on
  // screen and clickable, so the reason for the retry (empty, error, cut off)
  // no longer forces a particular control.
  const pickRetryControl = (): { btn: any; via: string } | null => {
    const swipeFirst = !!cfg.retryByNewReroll;
    const order = swipeFirst
      ? [
          { sel: cfg.swipeNextSelector, via: "swipe" },
          { sel: cfg.regenerateSelector, via: "regenerate" },
        ]
      : [
          { sel: cfg.regenerateSelector, via: "regenerate" },
          { sel: cfg.swipeNextSelector, via: "swipe" },
        ];
    for (const step of order) {
      const btn = find(step.sel);
      if (btn) return { btn: btn, via: step.via };
    }
    return null;
  };

  // Returns which control it clicked, or null if nothing was clicked.
  const fireRetry = (): string | null => {
    const picked = pickRetryControl();
    if (!picked) {
      log("no retry control found, set the button selectors in settings");
      showToast(
        "Auto-retry: couldn't find your retry button. Set it in Auto Retry settings.",
      );
      return null;
    }
    hideToast();
    return clickHostControl(picked.btn) ? picked.via : null;
  };

  const stopGenerating = () => {
    const stop = find(cfg.stopSelector);
    if (!stop) return false;
    return clickHostControl(stop);
  };

  // The user wins, always. Cancel any pending retry for this chat, reset its
  // budget, and briefly suppress new automatic retries so a stopped
  // generation's trailing events can't immediately restart the loop. This is
  // what makes Stop and Cancel actually stop things.
  function standDown(chatId: string, announce?: boolean) {
    const s = st(chatId);
    const hadPending = s.pending || !!s.timer || s.attempts > 0;
    // Otherwise a dialog raised by the retry that was just called off could
    // still be confirmed, starting a reply the user had stopped.
    clearConfirmWatch();
    clearTimers(s);
    s.attempts = 0;
    s.suppressUntil = Date.now() + STAND_DOWN_MS;
    if (hadPending) {
      hideToast();
      if (announce) showToast("Auto-retry stopped.");
      log("stood down", chatId);
    }
  }

  // A click can land without starting anything: a swipe control may just move
  // between rerolls that already exist, and a stale control does nothing at
  // all. Wait for a generation to begin; if none does, click the other control
  // once, then give the attempt up so the next user message starts clean.
  // Some setups put a dialog between the regenerate button and the generation,
  // asking for guidance before it re-rolls. Clicking regenerate then opens that
  // dialog and stops, because the reply only starts once its own button is
  // pressed. This finds that button and presses it.
  //
  // Safety rests on three things: it only looks in the moment after the
  // extension itself clicked something, it only accepts a button that was not
  // already on screen before that click, and it only accepts a short list of
  // affirmative labels. A Cancel or Delete is never a candidate.
  // Order is preference. Skip comes first on purpose: it means "carry on without
  // the optional step", which is exactly what an unattended retry wants, and it
  // avoids submitting guidance the user saved for a retry they meant to steer
  // themselves. Anything that would abandon the action lives in the deny list
  // below, so Skip can never stand in for Cancel.
  //
  // No "continue" here on purpose either: that is a toolbar action of its own,
  // and it extends the reply rather than re-rolling it.
  const CONFIRM_LABELS = [
    /^skip$/i,
    /^re-?generate$/i,
    /^re-?generate now$/i,
    /^confirm$/i,
    /^proceed$/i,
    /^submit$/i,
    /^ok(ay)?$/i,
  ];
  const CONFIRM_DENY =
    /cancel|close|dismiss|delete|discard|remove|revert|undo|back|no thanks|never ?mind/i;
  // The first look is almost immediate so a dialog that has to be clicked
  // through is on screen for as little time as possible. Later looks are spaced
  // out, for a build that animates the dialog in more slowly.
  const CONFIRM_FIRST_MS = 40;
  const CONFIRM_POLL_MS = 150;
  const CONFIRM_TRIES = 11; // about 1.5s in total, then it leaves things alone
  let confirmTimer: any = null;
  // Watches for the dialog being inserted rather than checking on a timer, so it
  // can be pressed in the same frame it appears and is usually gone again before
  // it has been drawn. The timer below stays as a backstop.
  let confirmObserver: any = null;
  // Presses made in the current window. A press can land before the dialog is
  // ready to act on it, so the watch keeps looking afterwards instead of
  // standing down on the first try. Capped so it can never sit on a button.
  let confirmClicks = 0;
  const CONFIRM_MAX_CLICKS = 3;

  // A confirm button lives inside a dialog. The toolbar's own Regenerate button
  // carries the same label, so without this the scan could press that instead
  // and loop. Element identity alone is not enough to tell them apart, because
  // the app rebuilds those nodes when it re-renders and they then look new.
  function inDialog(el: any): boolean {
    let p: any = el;
    let hops = 0;
    while (p && hops < 12) {
      try {
        const role = p.getAttribute && p.getAttribute("role");
        if (role === "dialog" || role === "alertdialog") return true;
        if (p.getAttribute && p.getAttribute("data-component") === "RegenFeedbackModal")
          return true;
        if (p.getAttribute && p.getAttribute("aria-modal") === "true") return true;
        const cls = String((p && p.className) || "");
        if (/modal|dialog|popover|popup|overlay|sheet|drawer/i.test(cls)) return true;
      } catch (_) {}
      p = p.parentElement;
      hops++;
    }
    return false;
  }

  const buttonLabel = (el: any): string => {
    let v = "";
    try {
      v =
        (el.getAttribute && el.getAttribute("aria-label")) ||
        (el.getAttribute && el.getAttribute("title")) ||
        el.textContent ||
        "";
    } catch (_) {}
    return String(v).replace(/\s+/g, " ").trim();
  };

  // Everything currently on screen that could pass as a confirm button. Taken
  // before our click so anything already there is ruled out afterwards.
  function confirmSnapshot(): Set<any> {
    const out = new Set<any>();
    if (typeof document === "undefined") return out;
    let list: any = [];
    try {
      list = document.querySelectorAll('button,[role="button"]');
    } catch (_) {
      return out;
    }
    for (const el of Array.prototype.slice.call(list)) {
      const label = buttonLabel(el);
      if (label && CONFIRM_LABELS.some((re) => re.test(label))) out.add(el);
    }
    return out;
  }

  // Labels the user added, lower-cased and trimmed. Read fresh each time so a
  // settings change takes effect without a reload.
  function userConfirmLabels(): string[] {
    return String(cfg.confirmButtonLabels || "")
      .split(/[\r\n]+/)
      .map((x) => x.trim().toLowerCase())
      .filter((x) => x.length > 0);
  }

  function findNewConfirm(before: Set<any>): any {
    if (typeof document === "undefined") return null;
    let list: any = [];
    try {
      list = document.querySelectorAll('button,[role="button"]');
    } catch (_) {
      return null;
    }
    const fresh: any[] = [];
    for (const el of Array.prototype.slice.call(list)) {
      if (before.has(el)) continue; // was already there, so our click didn't raise it
      const label = buttonLabel(el);
      if (!label) continue;
      // The deny list guards the built-in guesses. A label typed by hand is a
      // deliberate choice, so it is allowed through.
      const chosen = userConfirmLabels().indexOf(label.toLowerCase()) >= 0;
      if (!chosen && CONFIRM_DENY.test(label)) continue;
      if (!inDialog(el)) continue; // a bare toolbar button is not a confirmation
      if (!clickable(el)) continue;
      try {
        // Never our own panels.
        if (el.closest && el.closest("#__lvRetryToast,#__lvRetrySettings")) continue;
      } catch (_) {}
      fresh.push(el);
    }
    // Anything the user listed comes first: they know their own setup, and a
    // build in another language will not match the built-in wording.
    for (const want of userConfirmLabels()) {
      for (const el of fresh)
        if (buttonLabel(el).toLowerCase() === want) return el;
    }
    // Then the built-ins, in preference order.
    for (const re of CONFIRM_LABELS) {
      for (const el of fresh) if (re.test(buttonLabel(el))) return el;
    }
    return null;
  }

  function clearConfirmWatch() {
    if (confirmTimer) {
      clearTimeout(confirmTimer);
      confirmTimer = null;
    }
    if (confirmObserver) {
      try {
        confirmObserver.disconnect();
      } catch (_) {}
      confirmObserver = null;
    }
  }

  // One look for a dialog to click through. Returns true when there is nothing
  // left to wait for, either because it pressed something or because the reply
  // is already running.
  function tryConfirm(before: Set<any>): boolean {
    // A visible stop control means the reply is already running, so there is
    // no dialog in the way and nothing to press.
    if (find(cfg.stopSelector)) {
      clearConfirmWatch();
      return true;
    }
    const btn = findNewConfirm(before);
    if (!btn) return false;
    if (confirmClicks >= CONFIRM_MAX_CLICKS) {
      log("dialog did not respond to being confirmed; leaving it alone");
      clearConfirmWatch();
      return true;
    }
    confirmClicks += 1;
    log("a dialog opened after the retry click; confirming it");
    // The observer is dropped here but the timer keeps running: our own press
    // churns the page, and reacting to that would spin. The timer looks again
    // shortly, so a press that did not take is tried once more.
    if (confirmObserver) {
      try {
        confirmObserver.disconnect();
      } catch (_) {}
      confirmObserver = null;
    }
    clickHostControl(btn);
    return false;
  }

  function watchForConfirm(before: Set<any>, tries?: number) {
    const first = typeof tries !== "number";
    const left = first ? CONFIRM_TRIES : (tries as number);
    if (first) {
      clearConfirmWatch();
      confirmClicks = 0;
      try {
        if (typeof MutationObserver !== "undefined" && document.body) {
          confirmObserver = new MutationObserver(() => {
            tryConfirm(before);
          });
          confirmObserver.observe(document.body, {
            childList: true,
            subtree: true,
          });
        }
      } catch (_) {
        confirmObserver = null;
      }
    } else if (confirmTimer) {
      clearTimeout(confirmTimer);
      confirmTimer = null;
    }
    if (left <= 0) {
      clearConfirmWatch();
      return;
    }
    confirmTimer = setTimeout(() => {
      confirmTimer = null;
      if (tryConfirm(before)) return;
      watchForConfirm(before, left - 1);
    }, first ? CONFIRM_FIRST_MS : CONFIRM_POLL_MS);
  }

  const START_WAIT_ROUNDS = 3; // extra grace rounds while something is clearly generating
  function armStartWatchdog(
    chatId: string,
    via: string,
    allowFallback: boolean,
    waits?: number,
  ) {
    const s = st(chatId);
    // The caller marks the click before making it. If a start already arrived,
    // which happens when the host dispatches its event straight off the click,
    // there is nothing left to watch.
    if (!s.expectingStart) return;
    const left = typeof waits === "number" ? waits : START_WAIT_ROUNDS;
    if (s.startWatchdog) clearTimeout(s.startWatchdog);
    s.startWatchdog = setTimeout(() => {
      s.startWatchdog = null;
      if (!s.expectingStart) return; // a generation started, nothing to do
      // The stop control being on screen means something is generating and the
      // start event is just slow. Clicking again here would stack a second
      // generation, so this waits a few more rounds before deciding.
      if (left > 0 && find(cfg.stopSelector)) {
        log("retry click has not reported a start yet; waiting", chatId);
        armStartWatchdog(chatId, via, allowFallback, left - 1);
        return;
      }
      s.expectingStart = 0;
      if (allowFallback) {
        const otherSel =
          via === "swipe" ? cfg.regenerateSelector : cfg.swipeNextSelector;
        const otherVia = via === "swipe" ? "regenerate" : "swipe";
        const other = find(otherSel);
        if (other) {
          s.expectingStart = Date.now();
          const beforeOther = confirmSnapshot();
          watchForConfirm(beforeOther);
          if (clickHostControl(other)) {
            log("no generation after the " + via + " click, trying " + otherVia, chatId);
            armStartWatchdog(chatId, otherVia, false);
            return;
          }
          s.expectingStart = 0;
        }
      }
      log("retry click produced no generation; resetting stale state", chatId);
      s.selfTriggered = false;
      s.attempts = 0;
    }, START_GRACE_MS);
  }

  function scheduleRetry(chatId: string, reason: string, err?: any) {
    const s = st(chatId);
    if (!cfg.enabled || s.pending) return;
    if (cfg.pauseWhenFailing && Date.now() < pausedUntil) {
      log("paused after repeated failures, not retrying", chatId);
      return;
    }
    if (Date.now() < s.suppressUntil) {
      log("suppressed (just stopped/cancelled)", chatId);
      return;
    }
    if (s.attempts >= cfg.maxRetries) {
      log("gave up", chatId, reason);
      s.attempts = 0;
      // A try limit of zero means no retry was ever made, so there is no failed
      // run to count and nothing worth announcing.
      if (cfg.maxRetries <= 0) return;
      failedRuns += 1;
      const runsNeeded = breakerRuns();
      if (cfg.pauseWhenFailing && failedRuns >= runsNeeded) {
        const pauseMs = breakerPauseMs();
        const mins = Math.round(pauseMs / 60000);
        pausedUntil = Date.now() + pauseMs;
        failedRuns = 0;
        log("paused for " + mins + " min after " + runsNeeded + " failed runs");
        // Forced: the toast setting covers the pop-up on each retry, and going
        // quiet for minutes at a time is a state change rather than a retry. A
        // user who sees nothing has no way to tell this from the thing breaking.
        showToast(
          "Auto-retry paused for " + mins + (mins === 1 ? " minute" : " minutes") +
          ": the last " + runsNeeded + (runsNeeded === 1 ? " run" : " runs") + " failed.",
          { force: true },
        );
      } else {
        showToast("Auto-retry: gave up after " + cfg.maxRetries + " tries.");
      }
      return;
    }
    s.attempts += 1;
    const rl = isRateLimit(err);
    const delay = computeDelay(s.attempts, rl);
    clearTimers(s);
    s.pending = true;
    log(
      "retry " +
        s.attempts +
        "/" +
        cfg.maxRetries +
        " in " +
        delay +
        "ms (" +
        reason +
        (rl ? ", rate-limited" : "") +
        ")",
    );
    showToast(
      "Retrying " +
        s.attempts +
        "/" +
        cfg.maxRetries +
        " (" +
        reason +
        ") in " +
        (delay / 1000).toFixed(1) +
        "s",
      { cancel: () => standDown(chatId, true), sticky: true },
    );
    s.timer = setTimeout(() => {
      s.timer = null;
      s.pending = false;
      s.selfTriggered = true;
      // Marked before the click, not after: some builds dispatch the start event
      // straight off the click, and that start has to be able to cancel the
      // watchdog rather than land before it exists.
      s.expectingStart = Date.now();
      const before = confirmSnapshot();
      // Armed before the click, not after: a build that puts its dialog on
      // screen during the click itself would otherwise not be seen until the
      // backstop timer, and the dialog would visibly linger.
      watchForConfirm(before);
      const via = fireRetry();
      if (!via) {
        clearConfirmWatch();
        s.expectingStart = 0;
        s.selfTriggered = false;
        s.attempts = 0;
        return;
      }
      armStartWatchdog(chatId, via, true);
    }, delay);
  }

  // Stalled or stuck. Halt the dead generation (best effort) and retry.
  // Any terminal events the dead generation fires next (a stop, then maybe an
  // end) are swallowed by remembering its id, so a late one can't be mistaken
  // for a user stop or a fresh result even after the next generation begins.
  function abortAndRetry(chatId: string, reason: string) {
    const s = st(chatId);
    clearTimers(s);
    if (s.genId != null) {
      s.ignored.add(s.genId);
      while (s.ignored.size > IGNORE_MAX)
        s.ignored.delete(s.ignored.values().next().value);
    }
    stopGenerating();
    scheduleRetry(chatId, reason);
  }

  function onStart(p: any) {
    if (!p || !p.chatId) return;
    const s = st(p.chatId);
    if (s.startWatchdog) {
      clearTimeout(s.startWatchdog);
      s.startWatchdog = null;
    }
    s.expectingStart = 0;
    lastChatId = p.chatId;
    lastMessageId = p.messageId;
    log(
      "gen start",
      p.generationId,
      s.selfTriggered ? "(auto-retry)" : "(user)",
    );
    if (!s.selfTriggered) {
      s.attempts = 0;
      s.suppressUntil = 0;
    } // fresh, user-initiated generation
    s.selfTriggered = false;
    s.genId = p.generationId;
    clearConfirmWatch(); // a reply is running, so no dialog is in the way
    s.sawReasoning = false;
    s.sawContent = false;
    s.buf = "";
    clearTimers(s);
    if (cfg.enabled && cfg.stuckTimeoutMs > 0) {
      s.startTimer = setTimeout(
        () => abortAndRetry(p.chatId, "stuck"),
        cfg.stuckTimeoutMs,
      );
    }
  }

  // The text a token event carries. Builds name this field differently, so the
  // first string among the known names is used and anything else is ignored.
  function tokenText(p: any): string {
    for (const k of ["token", "text", "delta", "content", "chunk"]) {
      if (p && typeof p[k] === "string") return p[k];
    }
    return "";
  }

  function onToken(p: any) {
    if (!p || !p.chatId) return;
    const s = st(p.chatId);
    // Matched by shape, not an exact string, so a build that labels these
    // "reasoning_content" or "thinking" is not counted as visible reply text.
    if (/reason|think/i.test(String((p && p.type) || ""))) s.sawReasoning = true;
    else {
      s.sawContent = true;
      const piece = tokenText(p);
      if (piece) {
        s.buf += piece;
        if (s.buf.length > STREAM_BUF_MAX)
          s.buf = s.buf.slice(-STREAM_BUF_MAX);
      }
    }
    // streaming is alive: drop the start watchdog, arm the idle watchdog
    if (s.startTimer) {
      clearTimeout(s.startTimer);
      s.startTimer = null;
    }
    if (cfg.enabled && cfg.idleTimeoutMs > 0) {
      if (s.idleTimer) clearTimeout(s.idleTimer);
      s.idleTimer = setTimeout(
        () => abortAndRetry(p.chatId, "stalled"),
        cfg.idleTimeoutMs,
      );
    }
  }

  function onEnd(p: any) {
    if (!p || !p.chatId) return;
    const s = st(p.chatId);
    lastChatId = p.chatId;
    lastMessageId = p.messageId;
    if (s.ignored.has(p.generationId)) return; // aborted gen's trailing event, retry already scheduled
    clearTimers(s);
    if (Date.now() < s.suppressUntil) {
      log("gen end ignored (just stopped)");
      s.attempts = 0;
      return;
    } // user just stopped; do not retry
    if (p.error) {
      // A content-moderation block we can retry as a refusal is not a permanent
      // failure, so don't let the hard-error skip swallow it before the refusal check.
      if (cfg.ignoreHardErrors && isHardError(p.error) && !(cfg.retryOnRefusal && looksLikeRefusalError(String(p.error), cfg))) {
        log("hard error ignored", p.error);
        showToast("Auto-retry skipped: hard failure (auth/model).");
        s.attempts = 0;
        return;
      }
      if (cfg.retryOnError) {
        scheduleRetry(p.chatId, "error", p.error);
        return;
      }
      if (cfg.retryOnRefusal && looksLikeRefusalError(String(p.error), cfg)) {
        scheduleRetry(p.chatId, "looks like an accidental refusal");
        return;
      }
      return;
    }
    // Not every build puts the finished text on the end event. When it is
    // missing, what actually streamed stands in for it, so a good reply is not
    // read as empty and every check below still has real text to work with.
    const hasContentField = typeof p.content === "string";
    const content = (hasContentField ? p.content : s.buf || "").trim();
    // Empty only when the payload says so, or when nothing streamed either. A
    // missing field plus tokens that carried no readable text is not a verdict,
    // so it is left alone rather than re-rolled on a guess.
    const isEmpty = content.length === 0 && (hasContentField || !s.sawContent);
    if (cfg.retryOnEmpty && isEmpty) {
      scheduleRetry(
        p.chatId,
        s.sawReasoning && !s.sawContent ? "cut off mid-reasoning" : "empty",
      );
      return;
    }
    if (content.length === 0) {
      log("gen end with no readable content; leaving it alone");
      s.attempts = 0;
      return;
    }
    // Inline-reasoning models can put everything, refusal included, inside a
    // think block and never write a reply. The raw content isn't empty then,
    // but nothing outside the thinking is, so treat it as empty and retry.
    if (
      cfg.retryOnEmpty &&
      content.length > 0 &&
      stripThinkingAlways(content, cfg).trim().length === 0
    ) {
      scheduleRetry(p.chatId, "thinking only, no reply");
      return;
    }
    if (cfg.retryOnTruncated && looksTruncated(content, cfg.retryOnNoPunct, cfg)) {
      scheduleRetry(p.chatId, "cut off");
      return;
    }
    if (cfg.retryOnRefusal && looksLikeRefusal(content, cfg)) {
      scheduleRetry(p.chatId, "looks like an accidental refusal");
      return;
    }
    // Measured on the visible reply, not the raw output. A reasoning block can
    // run to hundreds of characters, so counting it would let a two-word reply
    // pass the length test on a thinking model.
    if (
      cfg.retryOnShort &&
      stripThinkingAlways(content, cfg).trim().length < cfg.minChars
    ) {
      scheduleRetry(p.chatId, "short");
      return;
    }
    // A reply that came back fine means whatever was wrong has cleared.
    failedRuns = 0;
    pausedUntil = 0;
    log("gen ok", content.length + " chars");
    s.attempts = 0; // clean success
  }

  function onStop(p: any) {
    if (!p || !p.chatId) return;
    const s = st(p.chatId);
    if (s.ignored.has(p.generationId)) return; // our own abort, not a user stop
    log("user stop", p.generationId);
    standDown(p.chatId, true); // genuine user stop: stand down, don't fight them
  }

  // Backup for the user's Stop press: if the host's GENERATION_STOPPED event is
  // late or never fires, catch the click on the stop button itself and stand
  // every pending retry down. Delegated + capture so it survives the host
  // re-rendering its buttons.
  // The host saves a swapped reply without redrawing the chat, so the old words
  // stay on screen until the view is rebuilt. This applies the same swaps to the
  // rendered text. Only text nodes are touched, so markdown, formatting and any
  // element structure are left exactly as they were.
  //
  // last: replace only the final occurrence in the page, which is the newest
  // reply. Whole-chat swaps pass false and replace every occurrence, since every
  // message really was changed.
  function applySwapsToView(
    pairs: Array<[string, string]>,
    last: boolean,
  ): number {
    if (typeof document === "undefined" || !pairs || !pairs.length) return 0;
    const SKIP = /^(SCRIPT|STYLE|TEXTAREA|INPUT|SELECT|OPTION)$/;
    let done = 0;
    for (const pair of pairs) {
      const from = String(pair && pair[0] != null ? pair[0] : "");
      const to = String(pair && pair[1] != null ? pair[1] : "");
      if (!from || from === to) continue;
      // The backend matches whole words for single-word rules, so a literal
      // replace here would also hit "dogged" when the rule was "dog". This
      // rebuilds the same boundary the backend used.
      let re: RegExp | null = null;
      try {
        const esc = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const lead = /^[\p{L}\p{N}]/u.test(from) ? "\\b" : "";
        const tail = /[\p{L}\p{N}]$/u.test(from) ? "\\b" : "";
        re = new RegExp(lead + esc + tail, "gu");
      } catch (__) {
        re = null;
      }
      const hits: any[] = [];
      let walker: any = null;
      try {
        walker = document.createTreeWalker(document.body, 4 /* SHOW_TEXT */);
      } catch (_) {
        return done;
      }
      let node: any = walker.nextNode ? walker.nextNode() : null;
      while (node) {
        const parent = node.parentElement;
        let skip = !parent || SKIP.test(String(parent.tagName || ""));
        // Our own panels and anything the user is typing into are off limits.
        if (!skip && parent.closest) {
          try {
            skip = !!parent.closest(
              "#__lvRetryToast,#__lvRetrySettings,[contenteditable='true']",
            );
          } catch (__) {}
        }
        if (!skip && re && re.test(String(node.nodeValue || ""))) hits.push(node);
        if (re) re.lastIndex = 0;
        node = walker.nextNode();
      }
      const targets = last ? hits.slice(-1) : hits;
      for (const t of targets) {
        try {
          re!.lastIndex = 0;
          t.nodeValue = String(t.nodeValue).replace(re!, to);
          done++;
        } catch (__) {}
      }
    }
    return done;
  }

  function onDocClick(e: any) {
    try {
      // A stalled reply is halted by clicking that same stop button, and that
      // click reaches here too. Standing down on it would suppress the retry
      // being scheduled right behind it, so our own clicks are skipped.
      if (selfClicking > 0) return;
      // Any deliberate click during the short window after a retry means the
      // user is driving. Back off rather than press a dialog button underneath
      // them, which could take a feedback prompt they opened on purpose.
      clearConfirmWatch();
      const tgt =
        e && e.target && e.target.closest
          ? e.target.closest(cfg.stopSelector)
          : null;
      if (!tgt) return;
      chats.forEach((s: any, id: string) => {
        if (s.pending || s.timer || s.attempts > 0) standDown(id, true);
      });
    } catch (_) {}
  }

  // ---- toast with an optional Cancel button ----
  function ensureToast(): any {
    if (typeof document === "undefined") return null;
    let t: any = document.getElementById("__lvRetryToast");
    if (!t) {
      t = document.createElement("div");
      t.id = "__lvRetryToast";
      t.style.cssText =
        "position:fixed;bottom:max(20px,env(safe-area-inset-bottom,0px));left:50%;transform:translateX(-50%);" +
        "z-index:2147483647;display:flex;align-items:center;gap:10px;" +
        "font:13px/1.4 var(--lumiverse-font-family,system-ui);padding:9px 12px;border-radius:var(--lumiverse-radius,12px);" +
        "color:var(--lumiverse-text,#fff);background:var(--lumiverse-fill,rgba(20,16,30,.96));" +
        "border:1px solid var(--lumiverse-border,rgba(255,255,255,.18));" +
        "box-shadow:0 8px 24px rgba(0,0,0,.45);transition:opacity .2s ease;" +
        "opacity:0;max-width:min(92vw,460px);text-align:left";
      (document.body || document.documentElement).appendChild(t);
    }
    return t;
  }
  function hideToast() {
    const t: any =
      typeof document !== "undefined" &&
      document.getElementById("__lvRetryToast");
    if (t) {
      clearTimeout(t.__h);
      t.style.opacity = "0";
      t.style.pointerEvents = "none";
    }
  }
  function showToast(
    msg: string,
    opts?: { cancel?: () => void; sticky?: boolean; force?: boolean; top?: boolean },
  ) {
    // force is for messages the user has to see to understand what the app is
    // doing right now, like the button picker waiting for a click. Everything
    // else still respects the toast setting.
    if (!cfg.toast && !(opts && opts.force)) return;
    const t = ensureToast();
    if (!t) return;
    try {
      t.innerHTML = "";
      const span = document.createElement("span");
      span.textContent = msg;
      span.style.cssText = "flex:1";
      t.appendChild(span);
      if (opts && opts.cancel) {
        const c = document.createElement("button");
        c.textContent = "Cancel";
        c.style.cssText =
          "flex:none;min-height:36px;padding:6px 14px;border-radius:var(--lumiverse-radius,8px);cursor:pointer;" +
          "font:13px var(--lumiverse-font-family,system-ui);" +
          "border:1px solid var(--lumiverse-border,rgba(255,255,255,.28));" +
          "background:var(--lumiverse-fill-subtle,rgba(255,255,255,.08));color:var(--lumiverse-text,#fff)";
        c.addEventListener("click", () => {
          try {
            opts.cancel && opts.cancel();
          } catch (_) {}
        });
        const cClear = () => {
          c.style.filter = "none";
        };
        c.addEventListener("pointerdown", () => {
          c.style.filter = "brightness(1.2)";
        });
        c.addEventListener("pointerup", cClear);
        c.addEventListener("pointercancel", cClear);
        c.addEventListener("pointerleave", cClear);
        t.appendChild(c);
        t.style.pointerEvents = "auto";
      } else {
        t.style.pointerEvents = "none";
      }
      // Both edges are set every time, so a normal toast after a top-anchored one
      // goes back to the bottom. The picker anchors to the top because the
      // buttons it is asking you to click sit at the bottom, under this.
      if (opts && opts.top) {
        t.style.top = "max(20px,env(safe-area-inset-top,0px))";
        t.style.bottom = "auto";
      } else {
        t.style.top = "auto";
        t.style.bottom = "max(20px,env(safe-area-inset-bottom,0px))";
      }
      t.style.opacity = "1";
      clearTimeout(t.__h);
      if (!(opts && opts.sticky)) {
        t.__h = setTimeout(() => {
          t.style.opacity = "0";
          t.style.pointerEvents = "none";
        }, 3200);
      }
    } catch (_) {}
  }

  // ---- debug info for bug reports ----
  // A one-tap snapshot anyone can paste into a report without opening dev tools:
  // version, current settings, whether each button selector matches right now,
  // and the browser string. The console log (above) is the live timeline; this
  // is the still photo.
  // Reports what the retry itself would find, not just whether the selector
  // matches anything, so a match on a hidden or disabled control is not read as
  // a working button.
  function selectorState(sel: string): string {
    const raw = String(sel || "").trim();
    if (!raw) return "not set";
    if (find(raw)) return "match";
    const parts = splitSelectorList(raw);
    let anyValid = false;
    for (const part of parts) {
      try {
        if (document.querySelector(part)) return "match, not clickable right now";
        anyValid = true;
      } catch (_) {}
    }
    return anyValid ? "no match" : "invalid selector";
  }
  function buildDebugInfo(opts?: {
    settings?: boolean;
    buttons?: boolean;
    environment?: boolean;
    activity?: boolean;
  }): string {
    const o = opts || {};
    const inc = (v: any) => v !== false; // sections default to on
    const keys = [
      "enabled",
      "maxRetries",
      "retryDelayMs",
      "backoffFactor",
      "maxDelayMs",
      "jitter",
      "rateLimitDelayMs",
      "retryByNewReroll",
      "stuckTimeoutMs",
      "idleTimeoutMs",
      "retryOnError",
      "ignoreHardErrors",
      "retryOnEmpty",
      "retryOnTruncated",
      "retryOnNoPunct",
      "retryOnShort",
      "minChars",
      "retryOnRefusal",
      "refusalUseBuiltins",
      "refusalMaxChars",
      "refusalExtraPhrases",
      "refusalPhraseSubs",
      "refusalIgnorePhrases",
      "refusalStripThinking",
      "refusalThinkTags",
      "replaceEnabled",
      "replaceRules",
      "replaceRandom",
      "replaceCaseSensitive",
      "showReplaceButton",
      "showSwapAllButton",
      "allowReSwap",
      "confirmBeforeEdit",
      "liveLog",
      "toast",
    ];
    const lines: string[] = [];
    lines.push("Auto Retry v" + VERSION + " debug info");
    lines.push("time: " + new Date().toISOString());
    // Always included, whatever categories are ticked. This is the first thing
    // to check when retries have stopped happening, so it must never be the
    // part someone left out of the report.
    const pauseLeftMs = pausedUntil - Date.now();
    lines.push(
      "auto-retry: " +
        (cfg.enabled === false
          ? "off in settings"
          : cfg.pauseWhenFailing && pauseLeftMs > 0
            ? "PAUSED by the failure breaker, " +
              Math.ceil(pauseLeftMs / 1000) +
              "s left"
            : "active") +
        " (failed runs in a row: " + failedRuns + " of " + breakerRuns() + ")",
    );
    if (inc(o.settings)) {
      lines.push("");
      lines.push("settings:");
      for (const k of keys)
        lines.push("  " + k + ": " + JSON.stringify(cfg[k]));
    }
    if (inc(o.buttons)) {
      lines.push("");
      lines.push("buttons (checked right now):");
      lines.push(
        "  retry mode: " +
          (cfg.retryByNewReroll
            ? "new reroll (swipe first, regenerate as fallback)"
            : "regenerate (swipe as fallback)"),
      );
      lines.push("  regenerate: " + selectorState(cfg.regenerateSelector));
      lines.push("  swipeNext:  " + selectorState(cfg.swipeNextSelector));
      lines.push("  stop:       " + selectorState(cfg.stopSelector));
      lines.push("  regenerateSelector = " + cfg.regenerateSelector);
      lines.push("  swipeNextSelector  = " + cfg.swipeNextSelector);
      lines.push("  stopSelector       = " + cfg.stopSelector);
    }
    if (inc(o.environment)) {
      try {
        lines.push("");
        lines.push(
          "browser: " + ((navigator && navigator.userAgent) || "unknown"),
        );
      } catch (_) {}
      try {
        lines.push(
          "screen: " +
            ((window && window.innerWidth) || "?") +
            " x " +
            ((window && window.innerHeight) || "?"),
        );
      } catch (_) {}
    }
    if (inc(o.activity)) {
      lines.push("");
      lines.push("recent activity (oldest first):");
      if (eventLog.length === 0) lines.push("  (nothing recorded yet)");
      else for (const e of eventLog) lines.push("  " + e);
    }
    return lines.join("\n");
  }
  function fallbackCopy(text: string): boolean {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;top:-1000px;left:-1000px;opacity:0";
      (document.body || document.documentElement).appendChild(ta);
      ta.focus();
      ta.select();
      const ok = !!(document.execCommand && document.execCommand("copy"));
      ta.remove();
      return ok;
    } catch (_) {
      return false;
    }
  }
  function copyText(text: string): Promise<boolean> {
    try {
      if (
        typeof navigator !== "undefined" &&
        navigator.clipboard &&
        navigator.clipboard.writeText
      ) {
        return navigator.clipboard.writeText(text).then(
          () => true,
          () => fallbackCopy(text),
        );
      }
    } catch (_) {}
    return Promise.resolve(fallbackCopy(text));
  }

  // Save text as a file download. Returns false if the browser blocks it.
  function downloadText(filename: string, text: string): boolean {
    try {
      const blob = new Blob([text], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => {
        try {
          URL.revokeObjectURL(url);
        } catch (_) {}
      }, 1000);
      return true;
    } catch (_) {
      return false;
    }
  }
  // Read a chosen file as text and hand it to cb.
  function readFileAsText(file: File, cb: (text: string | null) => void): void {
    try {
      const reader = new FileReader();
      reader.onload = () =>
        cb(typeof reader.result === "string" ? reader.result : null);
      reader.onerror = () => cb(null);
      reader.readAsText(file);
    } catch (_) {
      cb(null);
    }
  }

  // ---- settings UI ----
  let modalHandle: any = null;
  let modalRoot: any = null;
  let modalSnapshot: any = null;
  // Close function for the open expand-editor overlay, if any, so it can be shut
  // when the settings modal closes instead of being left floating.
  let closeExpandEditor: (() => void) | null = null;

  function buildSettingsBody(root: HTMLElement, onSaved?: () => void) {
    root.innerHTML = "";
    fieldSetters = {};
    presetBarRefreshers = [];

    // A preset switcher: pick a saved preset and Load it into the settings, or
    // save the current settings as a preset. Load updates the on-screen fields in
    // place (no rebuild), so it never jumps the scroll or closes open sections.
    function buildPresetBar(kind: string): HTMLElement {
      const wrap = document.createElement("div");
      wrap.style.cssText = "display:flex;flex-direction:column;gap:8px";
      const smallBtn = (b: HTMLButtonElement) => {
        b.style.cssText += "min-height:0;padding:7px 12px";
        return b;
      };
      const miniLabel = (text: string) => {
        const l = document.createElement("div");
        l.textContent = text;
        l.style.cssText =
          "font-size:11px;color:var(--lumiverse-text-muted,#9a93a8)";
        return l;
      };
      const rowBox = () => {
        const r = document.createElement("div");
        r.style.cssText =
          "display:flex;gap:8px;flex-wrap:wrap;align-items:center";
        return r;
      };

      // Load direction: a saved preset into the settings.
      const select = document.createElement("select");
      select.style.cssText =
        "flex:1;min-width:150px;padding:8px 10px;border-radius:var(--lumiverse-radius,8px);border:1px solid var(--lumiverse-border,rgba(255,255,255,.16));background:var(--lumiverse-fill-subtle,rgba(255,255,255,.05));color:var(--lumiverse-text,#eee);font:13px var(--lumiverse-font-family,var(--font-global,system-ui))";
      const loadBtn = smallBtn(btn("Load", true));
      const pickRow = rowBox();
      pickRow.appendChild(select);
      pickRow.appendChild(loadBtn);

      const update = smallBtn(btn("Update selected", false));
      const del = smallBtn(btn("Delete", false));
      const manageRow = rowBox();
      manageRow.appendChild(update);
      manageRow.appendChild(del);

      // Save direction: the current settings into a new preset, or rename one.
      const nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.placeholder = "Preset name";
      nameInput.style.cssText = "flex:1;min-width:150px";
      styleField(nameInput);
      const saveNew = smallBtn(btn("Save as new", false));
      const rename = smallBtn(btn("Rename selected", false));
      const saveRow = rowBox();
      saveRow.appendChild(nameInput);
      saveRow.appendChild(saveNew);
      saveRow.appendChild(rename);

      const status = document.createElement("div");
      status.style.cssText =
        "font-size:12px;line-height:1.4;color:var(--lumiverse-text-muted,#9a93a8);min-height:1em";

      const presets = loadPresets();
      const list = () => presets[kind] || [];
      // Flush a field the user is still editing into cfg before we snapshot it.
      const commit = () => {
        const active: any =
          typeof document !== "undefined" ? document.activeElement : null;
        if (active && typeof active.blur === "function") active.blur();
        for (const g of SCHEMA)
          for (const fl of g.fields)
            if (fl.type === "num") cfg[fl.key] = clampField(fl, cfg[fl.key]);
      };
      const refreshSelect = (selectName?: string) => {
        select.innerHTML = "";
        const ph = document.createElement("option");
        ph.value = "";
        ph.textContent = list().length
          ? "Pick a preset"
          : "No presets saved yet";
        select.appendChild(ph);
        for (const p of list()) {
          const o = document.createElement("option");
          o.value = p.name;
          o.textContent = p.name;
          select.appendChild(o);
        }
        if (selectName) select.value = selectName;
      };
      refreshSelect();
      // Re-read storage and rebuild the dropdown, for when an import adds
      // presets while this bar is on screen.
      presetBarRefreshers.push(() => {
        const fresh = loadPresets();
        presets[kind] = fresh[kind] || [];
        refreshSelect();
      });

      loadBtn.addEventListener("click", () => {
        const name = select.value;
        if (!name) {
          status.textContent = "Pick a preset to load.";
          return;
        }
        const p = list().find((x) => x.name === name);
        if (!p) {
          status.textContent = "That preset is gone.";
          return;
        }
        applyPresetValues(kind, p.values);
        // Reflect the new values in the on-screen fields without a rebuild.
        for (const k of keysForKind(kind)) {
          const fld = fieldByKey[k];
          if (fld && fld.type === "num") cfg[k] = clampField(fld, cfg[k]);
          if (fieldSetters[k]) fieldSetters[k](cfg[k]);
        }
        saveSaved();
        saveToAccount();
        syncLiveLog();
        syncReplaceButton();
        if (onSaved) onSaved();
        status.textContent = "Loaded preset: " + name + ". It's in effect now.";
      });

      saveNew.addEventListener("click", () => {
        const name = nameInput.value.trim();
        if (!name) {
          status.textContent = "Type a name first.";
          return;
        }
        if (list().some((x) => x.name === name)) {
          status.textContent =
            "That name is taken. Use Update selected, or pick another.";
          return;
        }
        commit();
        presets[kind] = list().concat([{ name, values: snapshotKind(kind) }]);
        if (!savePresets(presets)) {
          status.textContent = "Couldn't save the preset on this browser.";
          return;
        }
        nameInput.value = "";
        refreshSelect(name);
        status.textContent = "Saved current settings as: " + name + ".";
      });

      rename.addEventListener("click", () => {
        const cur = select.value;
        if (!cur) {
          status.textContent = "Pick a preset to rename.";
          return;
        }
        const newName = nameInput.value.trim();
        if (!newName) {
          status.textContent = "Type the new name in the box, then Rename.";
          return;
        }
        if (newName === cur) {
          status.textContent = "That's already its name.";
          return;
        }
        if (list().some((x) => x.name === newName)) {
          status.textContent = "That name is taken. Pick another.";
          return;
        }
        const arr = list();
        const i = arr.findIndex((x) => x.name === cur);
        if (i < 0) {
          status.textContent = "That preset is gone.";
          return;
        }
        // Keep the saved values, change only the name.
        arr[i] = { name: newName, values: arr[i].values };
        presets[kind] = arr;
        if (!savePresets(presets)) {
          status.textContent = "Couldn't save on this browser.";
          return;
        }
        nameInput.value = "";
        refreshSelect(newName);
        status.textContent = "Renamed " + cur + " to " + newName + ".";
      });

      update.addEventListener("click", () => {
        const name = select.value;
        if (!name) {
          status.textContent = "Pick a preset to update.";
          return;
        }
        const arr = list();
        const i = arr.findIndex((x) => x.name === name);
        if (i < 0) {
          status.textContent = "That preset is gone.";
          return;
        }
        commit();
        arr[i] = { name, values: snapshotKind(kind) };
        presets[kind] = arr;
        if (!savePresets(presets)) {
          status.textContent = "Couldn't save on this browser.";
          return;
        }
        status.textContent =
          "Updated " + name + " to your current settings.";
      });

      del.addEventListener("click", async () => {
        const name = select.value;
        if (!name) {
          status.textContent = "Pick a preset to delete.";
          return;
        }
        let ok = true;
        try {
          if (ctx?.ui?.showConfirm) {
            const r = await ctx.ui.showConfirm({
              title: "Delete preset",
              message: 'Delete the preset "' + name + '"?',
              variant: "warning",
              confirmLabel: "Delete",
            });
            ok = !!r?.confirmed;
          }
        } catch (_) {}
        if (!ok) return;
        presets[kind] = list().filter((x) => x.name !== name);
        if (!savePresets(presets)) {
          status.textContent = "Couldn't save on this browser.";
          return;
        }
        refreshSelect();
        status.textContent = "Deleted preset: " + name + ".";
      });

      wrap.appendChild(miniLabel("Saved presets"));
      wrap.appendChild(pickRow);
      wrap.appendChild(manageRow);
      wrap.appendChild(miniLabel("Save or rename"));
      wrap.appendChild(saveRow);
      wrap.appendChild(status);
      return wrap;
    }

    // Cap the whole panel to a real viewport value that sits safely under the
    // modal's max-height once its title bar and padding are counted. With the
    // panel bounded and overflow hidden, the host modal has nothing left to
    // over-scroll, so its own full-height scrollbar never appears; only the
    // options list below scrolls. vh units keep it sane on phones too.
    const panel = document.createElement("div");
    panel.style.cssText =
      "display:flex;flex-direction:column;max-height:min(72vh,460px);overflow:hidden;box-sizing:border-box;font:13px/1.45 var(--lumiverse-font-family,var(--font-global,system-ui));color:var(--lumiverse-text,#eee)";

    // the one scroll area: flexes to fill whatever height is left after the
    // footer. min-height:0 lets it actually shrink and scroll inside the flex.
    const scroller = document.createElement("div");
    scroller.style.cssText =
      "display:flex;flex-direction:column;gap:18px;flex:1 1 auto;min-height:0;overflow-y:auto;padding-right:4px";

    for (const group of SCHEMA) {
      const sec = document.createElement("div");
      sec.style.cssText = "display:flex;flex-direction:column;gap:10px";

      // Groups titled "Advanced..." collapse by default so the basic options
      // aren't buried under them. Tap the header to reveal.
      const advanced = /^advanced\b/i.test(group.title);

      const h = document.createElement("div");
      h.style.cssText =
        "font-size:11px;letter-spacing:.07em;text-transform:uppercase;font-family:var(--font-global-bold,var(--lumiverse-font-family,system-ui));color:var(--lumiverse-text-muted,#9a93a8)";

      if (advanced) {
        h.style.cursor = "pointer";
        h.style.userSelect = "none";
        h.style.display = "flex";
        h.style.alignItems = "center";
        h.style.gap = "6px";
        const caret = document.createElement("span");
        caret.textContent = "\u25B8"; // right triangle when collapsed
        caret.style.cssText = "font-size:9px";
        const label = document.createElement("span");
        label.textContent = group.title;
        h.appendChild(caret);
        h.appendChild(label);
        sec.appendChild(h);

        const body = document.createElement("div");
        body.style.cssText = "display:none;flex-direction:column;gap:10px";
        if (group.desc) {
          const d = document.createElement("div");
          d.textContent = group.desc;
          d.style.cssText =
            "font-size:12px;line-height:1.45;color:var(--lumiverse-text-muted,#9a93a8)";
          body.appendChild(d);
        }
        for (const f of group.fields) body.appendChild(buildRow(f));
        const resetSel = buildSelectorResetRow(group);
        if (resetSel) body.appendChild(resetSel);
        // Word swap presets sit at the end of the group, since they save and
        // switch the settings above.
        if (/find and replace/i.test(group.title)) {
          const rule = document.createElement("div");
          rule.style.cssText =
            "height:1px;background:var(--lumiverse-border,rgba(255,255,255,.08));margin:4px 0 2px";
          body.appendChild(rule);
          const pl = document.createElement("div");
          pl.textContent = "Presets";
          pl.style.cssText =
            "font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--lumiverse-text-muted,#9a93a8)";
          body.appendChild(pl);
          const pd = document.createElement("div");
          pd.textContent =
            "Save your current word swaps as a named setup and switch between them. Applying takes effect right away. Kept on this browser.";
          pd.style.cssText =
            "font-size:12px;line-height:1.45;color:var(--lumiverse-text-muted,#9a93a8)";
          body.appendChild(pd);
          body.appendChild(buildPresetBar("swap"));
        }
        sec.appendChild(body);

        let open = openGroups.has(group.title);
        body.style.display = open ? "flex" : "none";
        caret.textContent = open ? "\u25BE" : "\u25B8";
        h.addEventListener("click", () => {
          open = !open;
          body.style.display = open ? "flex" : "none";
          caret.textContent = open ? "\u25BE" : "\u25B8"; // down triangle when open
          if (open) openGroups.add(group.title);
          else openGroups.delete(group.title);
        });
      } else {
        h.textContent = group.title;
        sec.appendChild(h);
        if (group.desc) {
          const d = document.createElement("div");
          d.textContent = group.desc;
          d.style.cssText =
            "font-size:12px;line-height:1.45;color:var(--lumiverse-text-muted,#9a93a8);margin-top:-4px";
          sec.appendChild(d);
        }
        for (const f of group.fields) sec.appendChild(buildRow(f));
        const resetSelOpen = buildSelectorResetRow(group);
        if (resetSelOpen) sec.appendChild(resetSelOpen);
      }
      scroller.appendChild(sec);
    }

    // debug info section (collapsible): choose what to include, review, redact, copy
    {
      const sec = document.createElement("div");
      sec.style.cssText = "display:flex;flex-direction:column;gap:10px";
      const h = document.createElement("div");
      h.style.cssText =
        "font-size:11px;letter-spacing:.07em;text-transform:uppercase;font-family:var(--font-global-bold,var(--lumiverse-font-family,system-ui));color:var(--lumiverse-text-muted,#9a93a8);cursor:pointer;user-select:none;display:flex;align-items:center;gap:6px";
      const caret = document.createElement("span");
      caret.textContent = "\u25B8";
      caret.style.cssText = "font-size:9px";
      const label = document.createElement("span");
      label.textContent = "Advanced: debug info";
      h.appendChild(caret);
      h.appendChild(label);
      sec.appendChild(h);

      const body = document.createElement("div");
      body.style.cssText = "display:none;flex-direction:column;gap:10px";
      const desc = document.createElement("div");
      desc.textContent =
        "A snapshot for your own debugging or a bug report. Tick the parts to include, build a preview, edit out anything you would rather not share, then copy. Nothing leaves your device until you paste it somewhere.";
      desc.style.cssText =
        "font-size:12px;line-height:1.45;color:var(--lumiverse-text-muted,#9a93a8)";
      body.appendChild(desc);

      const sections: Array<{
        id: "settings" | "buttons" | "environment" | "activity";
        label: string;
      }> = [
        { id: "settings", label: "Your settings" },
        { id: "buttons", label: "Button match status" },
        { id: "environment", label: "Browser and screen" },
        { id: "activity", label: "Recent activity log" },
      ];
      const dchecks: Array<{ id: string; input: HTMLInputElement }> = [];
      const dWrap = document.createElement("div");
      dWrap.style.cssText = "display:flex;flex-direction:column;gap:6px";
      for (const s of sections) {
        const row = document.createElement("label");
        row.style.cssText =
          "display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = true;
        cb.style.cssText =
          "accent-color:var(--lumiverse-primary,#7c5cff);cursor:pointer";
        const txt = document.createElement("span");
        txt.textContent = s.label;
        row.appendChild(cb);
        row.appendChild(txt);
        dWrap.appendChild(row);
        dchecks.push({ id: s.id, input: cb });
      }
      body.appendChild(dWrap);

      const opts = () => {
        const o: any = {};
        for (const c of dchecks) o[c.id] = c.input.checked;
        return o;
      };
      const dStatus = document.createElement("div");
      dStatus.style.cssText =
        "font-size:12px;line-height:1.4;color:var(--lumiverse-text-muted,#9a93a8);min-height:1em";
      const dArea = document.createElement("textarea");
      dArea.rows = 6;
      dArea.placeholder =
        "Press Build preview to fill this, then edit out anything private before copying.";
      dArea.style.cssText =
        "width:100%;box-sizing:border-box;font-family:var(--lumiverse-font-mono,ui-monospace,monospace) !important;font-size:12px;padding:8px;border-radius:var(--lumiverse-radius,8px);border:1px solid var(--lumiverse-border,#3a3543);background:var(--lumiverse-bg,#1a1720);color:var(--lumiverse-text,#e9e4f0);resize:vertical";

      const buildBtn = btn("Build preview", false);
      buildBtn.addEventListener("click", () => {
        dArea.value = buildDebugInfo(opts());
        dStatus.textContent = "Built. Edit anything you want to remove, then Copy.";
      });
      const copyBtn = btn("Copy", false);
      copyBtn.addEventListener("click", async () => {
        if (!dArea.value.trim()) dArea.value = buildDebugInfo(opts());
        const ok = await copyText(dArea.value);
        dStatus.textContent = ok
          ? "Copied. Paste it into your bug report."
          : "Couldn't copy here; select the text and copy by hand.";
      });

      body.appendChild(buildBtn);
      body.appendChild(dArea);
      body.appendChild(copyBtn);
      body.appendChild(dStatus);
      sec.appendChild(body);
      let open = openGroups.has("Advanced: debug info");
      body.style.display = open ? "flex" : "none";
      caret.textContent = open ? "\u25BE" : "\u25B8";
      h.addEventListener("click", () => {
        open = !open;
        body.style.display = open ? "flex" : "none";
        caret.textContent = open ? "\u25BE" : "\u25B8";
        if (open) openGroups.add("Advanced: debug info");
        else openGroups.delete("Advanced: debug info");
      });
      scroller.appendChild(sec);
    }

    // import / export section (collapsible, same look as the Advanced groups)
    {
      const sec = document.createElement("div");
      sec.style.cssText = "display:flex;flex-direction:column;gap:10px";
      const h = document.createElement("div");
      h.style.cssText =
        "font-size:11px;letter-spacing:.07em;text-transform:uppercase;font-family:var(--font-global-bold,var(--lumiverse-font-family,system-ui));color:var(--lumiverse-text-muted,#9a93a8);cursor:pointer;user-select:none;display:flex;align-items:center;gap:6px";
      const caret = document.createElement("span");
      caret.textContent = "\u25B8";
      caret.style.cssText = "font-size:9px";
      const label = document.createElement("span");
      label.textContent = "Advanced: import / export";
      h.appendChild(caret);
      h.appendChild(label);
      sec.appendChild(h);

      const body = document.createElement("div");
      body.style.cssText = "display:none;flex-direction:column;gap:10px";

      const desc = document.createElement("div");
      desc.textContent =
        "Save settings to a file or load them from one. Tick the parts to include, then Export or Import. An import fills in the settings above without saving, so you can review first: press Save to keep it, or close to discard.";
      desc.style.cssText =
        "font-size:12px;line-height:1.45;color:var(--lumiverse-text-muted,#9a93a8)";
      body.appendChild(desc);

      const checks: Array<{ id: string; input: HTMLInputElement }> = [];
      const checkWrap = document.createElement("div");
      checkWrap.style.cssText = "display:flex;flex-direction:column;gap:6px";
      for (const c of EXPORT_CATEGORIES) {
        const row = document.createElement("label");
        row.style.cssText =
          "display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = true;
        cb.style.cssText =
          "accent-color:var(--lumiverse-primary,#7c5cff);cursor:pointer";
        const txt = document.createElement("span");
        txt.textContent = c.label;
        row.appendChild(cb);
        row.appendChild(txt);
        checkWrap.appendChild(row);
        checks.push({ id: c.id, input: cb });
      }
      body.appendChild(checkWrap);
      const chosen = () =>
        checks.filter((x) => x.input.checked).map((x) => x.id);

      const status = document.createElement("div");
      status.style.cssText =
        "font-size:12px;line-height:1.4;color:var(--lumiverse-text-muted,#9a93a8);min-height:1em";

      const exportBtn = btn("Export to file", false);
      exportBtn.addEventListener("click", () => {
        const ids = chosen();
        if (!ids.length) {
          status.textContent = "Tick at least one part to export.";
          return;
        }
        const ok = downloadText("auto-retry-settings.json", buildExport(ids));
        status.textContent = ok
          ? "Saved a file with the ticked parts."
          : "Couldn't save a file here.";
      });

      const fileInput = document.createElement("input");
      fileInput.type = "file";
      fileInput.accept = "application/json,.json";
      fileInput.style.display = "none";
      fileInput.addEventListener("change", () => {
        const f = fileInput.files && fileInput.files[0];
        fileInput.value = "";
        if (!f) return;
        const ids = chosen();
        if (!ids.length) {
          status.textContent = "Tick at least one part to import.";
          return;
        }
        readFileAsText(f, (text) => {
          if (text == null) {
            status.textContent = "Couldn't read that file.";
            return;
          }
          const applied = applyImport(text, ids);
          if (applied === null) {
            status.textContent = "That file isn't a valid Auto Retry export.";
            return;
          }
          // Presets ride outside the settings model: they save right away.
          let presetCount = 0;
          if (ids.indexOf("presets") >= 0) {
            let data: any = null;
            try {
              data = JSON.parse(text);
            } catch (_) {}
            presetCount = importPresets(data);
            if (presetCount === -1) {
              status.textContent =
                "Couldn't save the imported presets on this browser.";
              return;
            }
            if (presetCount > 0) for (const r of presetBarRefreshers) r();
          }
          if (!applied.length && !presetCount) {
            status.textContent = "Nothing matched the ticked parts in that file.";
            return;
          }
          // Reflect imported settings in the visible fields without a rebuild,
          // so the panel doesn't jump back to the top.
          for (const k of Object.keys(fieldSetters)) fieldSetters[k](cfg[k]);
          let msg = "";
          if (applied.length)
            msg = "Imported: " + applied.join(", ") + ". Press Save to keep it.";
          if (presetCount > 0)
            msg +=
              (msg ? " " : "") +
              "Also brought in " +
              presetCount +
              " word swap preset" +
              (presetCount === 1 ? "" : "s") +
              ", saved already.";
          status.textContent = msg;
        });
      });
      const importBtn = btn("Import from file", false);
      importBtn.addEventListener("click", () => {
        if (!chosen().length) {
          status.textContent = "Tick at least one part to import first.";
          return;
        }
        fileInput.click();
      });

      const btnRow = document.createElement("div");
      btnRow.style.cssText = "display:flex;flex-wrap:wrap;gap:8px";
      btnRow.appendChild(exportBtn);
      btnRow.appendChild(importBtn);
      body.appendChild(btnRow);
      body.appendChild(fileInput);
      body.appendChild(status);

      sec.appendChild(body);
      let open = openGroups.has("Advanced: import / export");
      body.style.display = open ? "flex" : "none";
      caret.textContent = open ? "\u25BE" : "\u25B8";
      h.addEventListener("click", () => {
        open = !open;
        body.style.display = open ? "flex" : "none";
        caret.textContent = open ? "\u25BE" : "\u25B8";
        if (open) openGroups.add("Advanced: import / export");
        else openGroups.delete("Advanced: import / export");
      });
      scroller.appendChild(sec);
    }

    panel.appendChild(scroller);

    // footer: a plain bar below the scroll area, set off by a single hairline
    // rule. flex-wrap lets the buttons stack on a narrow phone screen.
    const actions = document.createElement("div");
    actions.style.cssText =
      "display:flex;align-items:center;flex-wrap:wrap;gap:8px;flex:none;margin-top:14px;padding-top:14px;border-top:1px solid var(--lumiverse-border,rgba(255,255,255,.08))";
    const status = document.createElement("span");
    status.style.cssText =
      "flex:1;min-width:120px;font-size:12px;color:var(--lumiverse-text-muted,#9a93a8)";

    const reset = btn("Reset to defaults", false);
    reset.addEventListener("click", async () => {
      let ok = true;
      try {
        if (ctx?.ui?.showConfirm) {
          const r = await ctx.ui.showConfirm({
            title: "Reset settings",
            message: "Put every Auto Retry setting back to its default?",
            variant: "warning",
            confirmLabel: "Reset",
          });
          ok = !!r?.confirmed;
        }
      } catch (_) {}
      if (!ok) return;
      for (const g of SCHEMA)
        for (const fl of g.fields) cfg[fl.key] = (CONFIG as any)[fl.key];
      saveSaved();
      saveToAccount();
      syncLiveLog();
      syncReplaceButton();
      if (onSaved) onSaved();
      buildSettingsBody(root, onSaved);
      log("settings reset to defaults");
    });

    const save = btn("Save", true);
    save.addEventListener("click", () => {
      // Commit a field the user is still editing, then normalise every number
      // so a blank or out-of-range box can't be saved.
      const active: any =
        typeof document !== "undefined" ? document.activeElement : null;
      if (active && typeof active.blur === "function") active.blur();
      for (const g of SCHEMA)
        for (const fl of g.fields)
          if (fl.type === "num") cfg[fl.key] = clampField(fl, cfg[fl.key]);
      saveSaved();
      saveToAccount();
      syncLiveLog();
      syncReplaceButton();
      if (onSaved) onSaved();
      status.textContent = "Saved. Takes effect on the next reply.";
      log("settings saved", cfg);
      setTimeout(() => {
        status.textContent = "";
      }, 2600);
    });

    actions.appendChild(status);
    actions.appendChild(reset);
    actions.appendChild(save);
    panel.appendChild(actions);
    root.appendChild(panel);
  }

  // Puts the button selectors in a section back to what the extension shipped
  // with. Pick it for me makes these easy to overwrite, including with the wrong
  // element, and Reset all would take every other setting with it. This undoes
  // only that mistake. It fills the boxes and leaves Save to the user, so a
  // mistaken press is undone by closing the panel.
  function buildSelectorResetRow(group: any): HTMLElement | null {
    const keys: string[] = (group && group.fields ? group.fields : [])
      .filter((f: any) => f && f.selector)
      .map((f: any) => f.key);
    if (!keys.length) return null;
    const row = document.createElement("div");
    // Column, not a wrapping row: with a row the status sits beside the button
    // when it is short and jumps below it when it is long, which reads as a bug.
    row.style.cssText =
      "display:flex;flex-direction:column;align-items:flex-start;gap:6px";
    const b = btn("Reset button selectors", false);
    b.style.padding = "5px 12px";
    const note = document.createElement("span");
    // Height is held even while empty so the panel doesn't shift when it fills.
    note.style.cssText =
      "font-size:12px;min-height:16px;color:var(--lumiverse-text-muted,#9a93a8)";
    b.addEventListener("click", () => {
      let changed = 0;
      for (const k of keys) {
        if (cfg[k] !== (CONFIG as any)[k]) changed++;
        cfg[k] = (CONFIG as any)[k];
        const set = fieldSetters[k];
        if (set) set(cfg[k]);
      }
      note.textContent = changed
        ? "back to defaults, press Save to keep"
        : "already at the defaults";
    });
    row.appendChild(b);
    row.appendChild(note);
    return row;
  }

  function buildRow(f: Field): HTMLElement {
    // bool/num wrap in <label> so the whole row toggles or focuses its control.
    // text rows use <div> because they contain a Test button, which shouldn't sit inside a label.
    const row = document.createElement(f.type === "text" ? "div" : "label");
    row.style.cssText =
      "display:flex;flex-direction:column;gap:5px;cursor:" +
      (f.type === "text" ? "default" : "pointer");

    // The hint is hidden by default and revealed by the "?" next to the label
    // (hover on a mouse, tap on touch), so rows stay compact. Kept in the DOM.
    let hintEl: HTMLElement | null = null;
    if (f.hint) {
      hintEl = document.createElement("span");
      hintEl.textContent = f.hint;
      hintEl.style.cssText =
        "display:none;font-size:12px;line-height:1.45;color:var(--lumiverse-text-muted,#9a93a8)";
    }

    const top = document.createElement("div");
    top.style.cssText =
      "display:flex;align-items:center;gap:10px;justify-content:space-between";
    const labelWrap = document.createElement("div");
    labelWrap.style.cssText =
      "display:flex;align-items:center;gap:6px;min-width:0";
    const name = document.createElement("span");
    name.textContent = f.label;
    name.style.cssText = "font-size:13.5px";
    labelWrap.appendChild(name);
    if (hintEl) {
      const info = document.createElement("button");
      info.type = "button";
      info.textContent = "?";
      info.setAttribute("aria-label", "Show description for " + f.label);
      info.style.cssText =
        "flex:none;width:18px;height:18px;padding:0;line-height:1;border-radius:50%;border:1px solid var(--lumiverse-border,rgba(255,255,255,.3));background:transparent;color:var(--lumiverse-text-muted,#9a93a8);font-size:11px;cursor:pointer";
      const setHint = (show: boolean) => {
        hintEl!.style.display = show ? "block" : "none";
        info.style.borderColor = show
          ? "var(--lumiverse-primary,#7c5cff)"
          : "var(--lumiverse-border,rgba(255,255,255,.3))";
        info.style.color = show
          ? "var(--lumiverse-primary,#7c5cff)"
          : "var(--lumiverse-text-muted,#9a93a8)";
      };
      // Mouse devices reveal on hover (and keyboard focus); touch devices, which
      // can't hover, toggle on tap.
      const canHover =
        typeof window !== "undefined" &&
        !!window.matchMedia &&
        window.matchMedia("(hover: hover)").matches;
      if (canHover) {
        info.addEventListener("mouseenter", () => setHint(true));
        info.addEventListener("mouseleave", () => setHint(false));
        info.addEventListener("focus", () => setHint(true));
        info.addEventListener("blur", () => setHint(false));
      }
      info.addEventListener("click", (e: any) => {
        // Stop the row-label from toggling its control when the button is clicked.
        if (e) {
          e.preventDefault();
          e.stopPropagation();
        }
        // On touch, click toggles. On a mouse, hover already handles it.
        if (!canHover) setHint(hintEl!.style.display === "none");
      });
      labelWrap.appendChild(info);
    }
    top.appendChild(labelWrap);

    if (f.type === "bool") {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = !!cfg[f.key];
      input.style.cssText =
        "flex:none;width:20px;height:20px;accent-color:var(--lumiverse-primary,#7c5cff);cursor:pointer";
      input.addEventListener("change", () => {
        cfg[f.key] = input.checked;
      });
      fieldSetters[f.key] = (v: any) => {
        input.checked = !!v;
      };
      top.appendChild(input);
      row.appendChild(top);
    } else if (f.type === "num") {
      const input = document.createElement("input");
      input.type = "number";
      input.inputMode = "numeric";
      input.value = String(cfg[f.key]);
      styleField(input);
      input.style.width = "120px";
      input.style.flex = "none";
      input.addEventListener("change", () => {
        cfg[f.key] = clampField(f, input.value);
        input.value = String(cfg[f.key]);
      });
      fieldSetters[f.key] = (v: any) => {
        input.value = String(v);
      };
      top.appendChild(input);
      row.appendChild(top);
    } else {
      row.appendChild(top);
      const isMultiline = !f.selector;
      const input = document.createElement(
        isMultiline ? "textarea" : "input",
      ) as any;
      if (isMultiline) {
        input.rows = 4;
        input.style.resize = "vertical";
        const expand = btn("Expand", false);
        expand.style.cssText +=
          "min-height:0;padding:3px 10px;font-size:12px;flex:none";
        expand.addEventListener("click", () => {
          openExpandEditor(f.label, input.value, (val: string) => {
            input.value = val;
            cfg[f.key] = val;
          });
        });
        top.appendChild(expand);
      } else {
        input.type = "text";
      }
      input.value = String(cfg[f.key]);
      input.setAttribute("aria-label", f.label);
      styleField(input);
      input.addEventListener("change", () => {
        cfg[f.key] = input.value;
      });
      fieldSetters[f.key] = (v: any) => {
        input.value = String(v);
      };
      row.appendChild(input);

      if (f.selector) {
        const testRow = document.createElement("div");
        testRow.style.cssText =
          "display:flex;flex-direction:column;align-items:flex-start;gap:6px";
        // The buttons share a line and wrap if the screen is narrow; the result
        // sits under them either way, so it never gets squeezed or moved around.
        const testBtns = document.createElement("div");
        testBtns.style.cssText =
          "display:flex;align-items:center;gap:8px;flex-wrap:wrap";
        const test = btn("Test", false);
        test.style.padding = "5px 12px";
        const res = document.createElement("span");
        res.style.cssText =
          "font-size:12px;min-height:16px;color:var(--lumiverse-text-muted,#9a93a8)";
        test.addEventListener("click", () => {
          const sel = input.value.trim();
          if (!sel) {
            res.textContent = "type a selector first";
            res.style.color = "var(--lumiverse-text-muted,#9a93a8)";
            return;
          }
          const state = selectorState(sel);
          if (state === "invalid selector") {
            res.textContent = "that selector isn't valid";
            res.style.color = "var(--lumiverse-danger,#ff6b6b)";
            return;
          }
          if (state === "match") {
            res.textContent = "match found";
            res.style.color = "var(--lumiverse-success,#46d39a)";
            return;
          }
          res.textContent =
            state === "match, not clickable right now"
              ? "found, but not clickable right now"
              : "no match right now";
          res.style.color = "var(--lumiverse-text-muted,#9a93a8)";
        });
        const pick = btn("Pick it for me", false);
        pick.style.padding = "5px 12px";
        pick.addEventListener("click", () => {
          cfg[f.key] = input.value;
          startPicking(f.key, String(f.label || ""));
        });
        testBtns.appendChild(test);
        testBtns.appendChild(pick);
        testRow.appendChild(testBtns);
        testRow.appendChild(res);
        row.appendChild(testRow);
      }
    }

    if (hintEl) row.appendChild(hintEl);
    return row;
  }

  function styleField(input: HTMLInputElement) {
    input.style.cssText +=
      "padding:9px 10px;border-radius:var(--lumiverse-radius,8px);" +
      "border:1px solid var(--lumiverse-border,rgba(255,255,255,.16));" +
      "background:var(--lumiverse-fill-subtle,rgba(255,255,255,.05));" +
      "color:var(--lumiverse-text,#eee);font:13px var(--lumiverse-font-family,var(--font-global,system-ui));outline:none;" +
      "transition:border-color .12s ease";
    // On focus, tint the border so the active field is clear. No glow ring.
    input.addEventListener("focus", () => {
      input.style.borderColor = "var(--lumiverse-primary,#7c5cff)";
    });
    input.addEventListener("blur", () => {
      input.style.borderColor = "var(--lumiverse-border,rgba(255,255,255,.16))";
    });
  }

  function btn(label: string, primary: boolean): HTMLButtonElement {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.cssText =
      "min-height:36px;padding:8px 14px;border-radius:var(--lumiverse-radius,8px);cursor:pointer;" +
      "font:13px var(--lumiverse-font-family,system-ui);transition:filter .12s ease;" +
      (primary
        ? "border:1px solid transparent;background:var(--lumiverse-primary,#7c5cff);color:var(--lumiverse-primary-contrast,#fff)"
        : "border:1px solid var(--lumiverse-border,rgba(255,255,255,.16));background:transparent;color:var(--lumiverse-text,#eee)");
    b.addEventListener("mouseenter", () => {
      b.style.filter = "brightness(1.12)";
    });
    b.addEventListener("mouseleave", () => {
      b.style.filter = "none";
    });
    // Press feedback that also works on touch, where hover never fires.
    const pressClear = () => {
      b.style.filter = "none";
    };
    b.addEventListener("pointerdown", () => {
      b.style.filter = "brightness(.9)";
    });
    b.addEventListener("pointerup", pressClear);
    b.addEventListener("pointercancel", pressClear);
    b.addEventListener("pointerleave", pressClear);
    return b;
  }

  // Full-size editor for a multiline field. Opens a large textarea over the
  // modal so long rule lists are easier to read and edit. Done writes the text
  // back; Cancel, Escape, or a click outside discards.
  function openExpandEditor(
    label: string,
    initial: string,
    onDone: (val: string) => void,
  ) {
    if (typeof document === "undefined") return;
    // Only one open at a time; shut a stray previous one first.
    if (closeExpandEditor) {
      try {
        closeExpandEditor();
      } catch (_) {}
    }
    const overlay = document.createElement("div");
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:2147483600;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;background:rgba(0,0,0,.55);font-family:var(--lumiverse-font-family,var(--font-global,system-ui))";
    const box = document.createElement("div");
    box.style.cssText =
      "display:flex;flex-direction:column;gap:10px;width:min(720px,96vw);height:min(80vh,640px);box-sizing:border-box;padding:14px;background:var(--lumiverse-surface,#1a1720);border:1px solid var(--lumiverse-border,rgba(255,255,255,.16));border-radius:var(--lumiverse-radius,12px);box-shadow:0 12px 40px rgba(0,0,0,.5);color:var(--lumiverse-text,#eee)";
    const title = document.createElement("div");
    title.textContent = label;
    title.style.cssText =
      "flex:none;font-size:14px;font-family:var(--font-global-bold,var(--lumiverse-font-family,system-ui))";
    const ta = document.createElement("textarea");
    ta.value = initial;
    ta.setAttribute("aria-label", label);
    ta.style.cssText =
      "flex:1;width:100%;box-sizing:border-box;resize:none;padding:10px;border-radius:var(--lumiverse-radius,8px);border:1px solid var(--lumiverse-border,rgba(255,255,255,.16));background:var(--lumiverse-fill-subtle,rgba(255,255,255,.05));color:var(--lumiverse-text,#eee);outline:none;font:13px/1.5 var(--lumiverse-font-family,var(--font-global,system-ui))";
    const row = document.createElement("div");
    row.style.cssText =
      "display:flex;justify-content:flex-end;gap:8px;flex:none";
    const cancel = btn("Cancel", false);
    const done = btn("Done", true);
    const onKey = (e: any) => {
      if (e && e.key === "Escape") close();
    };
    function close() {
      try {
        overlay.remove();
      } catch (_) {}
      try {
        document.removeEventListener("keydown", onKey);
      } catch (_) {}
      if (closeExpandEditor === close) closeExpandEditor = null;
    }
    cancel.addEventListener("click", close);
    done.addEventListener("click", () => {
      onDone(ta.value);
      close();
    });
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });
    document.addEventListener("keydown", onKey);
    row.appendChild(cancel);
    row.appendChild(done);
    box.appendChild(title);
    box.appendChild(ta);
    box.appendChild(row);
    overlay.appendChild(box);
    (document.body || document.documentElement).appendChild(overlay);
    closeExpandEditor = close;
    // Deliberately not focusing the textarea, so opening it doesn't pop the
    // on-screen keyboard on mobile. Tap the text when you want to edit.
  }

  // Lets someone point at the control instead of writing a selector for it. The
  // settings modal steps out of the way, the next click on the page is caught
  // before the app sees it, and the element under it becomes the selector.
  const PRESS_EVENTS = [
    "pointerdown",
    "pointerup",
    "mousedown",
    "mouseup",
    "touchstart",
    "touchend",
  ];
  function startPicking(key: string, label: string) {
    if (typeof document === "undefined") return;
    // Refresh the baseline first: dismissing the modal rolls cfg back to it, so
    // without this every unsaved edit would be lost by opening the picker.
    if (modalSnapshot) {
      try { modalSnapshot(); } catch (_) {}
    }
    if (modalHandle) {
      try { modalHandle.dismiss(); } catch (_) {}
      modalHandle = null;
    }
    let done = false;
    const finish = (sel: string | null, message: string) => {
      if (done) return;
      done = true;
      try { document.removeEventListener("click", onPick, true); } catch (_) {}
      try { document.removeEventListener("keydown", onKey, true); } catch (_) {}
      for (const type of PRESS_EVENTS) {
        try { document.removeEventListener(type, swallow, true); } catch (_) {}
      }
      hideToast();
      if (sel) cfg[key] = sel;
      openSettings();
      if (message) showToast(message, { force: true, top: true });
    };
    const onPick = (e: any) => {
      const t: any = e && e.target;
      // Our own toast is on screen during this, so let its buttons work.
      try {
        if (t && t.closest && t.closest("#__lvRetryToast")) return;
      } catch (_) {}
      // Swallowed so picking the stop or regenerate control doesn't also fire it.
      try { e.preventDefault(); e.stopPropagation(); } catch (_) {}
      const sel = deriveSelector(t);
      if (!sel) {
        finish(null, "Couldn't identify that one. Try clicking the button itself rather than an icon inside it.");
        return;
      }
      finish(sel, "Set to " + sel);
    };
    const onKey = (e: any) => {
      if (e && e.key === "Escape") finish(null, "Picking cancelled.");
    };
    // Some controls act on pointerdown rather than click. Their listeners are cut
    // off here so nothing fires while picking. Only propagation is stopped: a
    // preventDefault on touchstart would also stop the browser synthesising the
    // click that the picker itself needs.
    const swallow = (e: any) => {
      const t: any = e && e.target;
      try {
        if (t && t.closest && t.closest("#__lvRetryToast")) return;
      } catch (_) {}
      try { e.stopPropagation(); } catch (_) {}
    };
    for (const type of PRESS_EVENTS) document.addEventListener(type, swallow, true);
    document.addEventListener("click", onPick, true);
    document.addEventListener("keydown", onKey, true);
    // The field labels already read "Your ... button", so the leading "your" is
    // dropped rather than repeated back.
    const what =
      String(label || "").replace(/^your\s+/i, "").trim() || "retry button";
    const hasKeyboard =
      typeof window !== "undefined" &&
      !!window.matchMedia &&
      window.matchMedia("(hover: hover)").matches;
    showToast(
      "Click your " + what + ". " + (hasKeyboard ? "Esc or Cancel to stop." : "Or press Cancel."),
      {
        sticky: true,
        force: true,
        top: true,
        cancel: () => finish(null, "Picking cancelled."),
      },
    );
  }

  function openSettings() {
    if (!ctx?.ui?.showModal) {
      log("host has no modal API; cannot open settings");
      return;
    }
    try {
      if (modalHandle) {
        try {
          modalHandle.dismiss();
        } catch (_) {}
        modalHandle = null;
      }
      // Size to the screen so it fits on a phone as well as a desktop.
      const vw =
        typeof window !== "undefined" && window.innerWidth
          ? window.innerWidth
          : 480;
      const vh =
        typeof window !== "undefined" && window.innerHeight
          ? window.innerHeight
          : 720;
      const modal = ctx.ui.showModal({
        title: "Auto Retry settings",
        width: Math.min(460, vw - 24),
        maxHeight: Math.min(560, vh - 24),
      });
      modalHandle = modal;
      modalRoot = modal.root;

      // Baseline of every saved setting at open. Edits below change cfg live, but
      // closing the modal with X or tapping outside restores this baseline, so
      // nothing sticks unless Save is pressed. Save and Reset refresh the baseline.
      let baseline: any = {};
      const snapshot = () => {
        baseline = {};
        for (const g of SCHEMA)
          for (const fl of g.fields) baseline[fl.key] = cfg[fl.key];
      };
      snapshot();
      modalSnapshot = snapshot;

      buildSettingsBody(modal.root, snapshot);
      modal.onDismiss(() => {
        if (closeExpandEditor) {
          try {
            closeExpandEditor();
          } catch (_) {}
        }
        for (const g of SCHEMA)
          for (const fl of g.fields) cfg[fl.key] = baseline[fl.key];
        modalHandle = null;
        modalRoot = null;
        modalSnapshot = null;
      });
    } catch (e) {
      log("failed to open settings", e);
    }
  }

  // entry point: a button in the chat input "Extras" popover
  try {
    if (ctx?.ui?.registerInputBarAction) {
      const action = ctx.ui.registerInputBarAction({
        id: "auto-retry-settings",
        label: "Auto Retry settings",
        iconSvg:
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><polyline points="21 4 21 9 16 9"/></svg>',
      });
      disposers.push(action.onClick(() => openSettings()));
      disposers.push(() => {
        try {
          action.destroy();
        } catch (_) {}
      });
    } else {
      log("host has no input bar action API; open settings via ctx only");
    }
  } catch (e) {
    log("failed to register settings action", e);
  }

  // backup stop-press catcher (see onDocClick)
  if (typeof document !== "undefined") {
    document.addEventListener("click", onDocClick, true);
    disposers.push(() => {
      try {
        document.removeEventListener("click", onDocClick, true);
      } catch (_) {}
    });
  }

  // Wrap each listener so a throw inside a handler is logged, never escapes into
  // the host's event dispatcher, and never stops later events from arriving.
  const safe = (label: string, fn: (p: any) => void) => (p: any) => {
    try {
      fn(p);
    } catch (e) {
      log("handler error in " + label, e);
    }
  };

  let offs: Array<() => void> = [];
  try {
    offs = [
      ctx.events.on("GENERATION_STARTED", safe("GENERATION_STARTED", onStart)),
      ctx.events.on(
        "STREAM_TOKEN_RECEIVED",
        safe("STREAM_TOKEN_RECEIVED", onToken),
      ),
      ctx.events.on("GENERATION_ENDED", safe("GENERATION_ENDED", onEnd)),
      ctx.events.on("GENERATION_STOPPED", safe("GENERATION_STOPPED", onStop)),
    ];
  } catch (e) {
    log("failed to subscribe to generation events", e);
  }
  syncLiveLog();
  loadFromAccount();
  syncReplaceButton();
  try {
    if (ctx && typeof (ctx as any).onBackendMessage === "function") {
      const offRep = (ctx as any).onBackendMessage(async (msg: any) => {
        try {
        if (!msg) return;
        if (msg.type === "confirm_edit") {
          const yes = await confirmEdit("Apply your word swaps to this reply?");
          if (yes && ctx && typeof (ctx as any).sendToBackend === "function") {
            (ctx as any).sendToBackend({ type: "apply_replace_now", chatId: msg.chatId, messageId: msg.messageId, onlyMessage: true, requestId: "ar-rep-" + Date.now() });
          }
          return;
        }
        // Sent after an automatic swap. The message is already saved; this only
        // brings what is on screen into line with it.
        if (msg.type === "swapped") {
          applySwapsToView(msg.pairs || [], !msg.wholeChat);
          return;
        }
        if (msg.type !== "replace_now_result") return;
        if (msg.ok) applySwapsToView(msg.pairs || [], !msg.wholeChat);
        if (!msg.ok) showToast("Could not swap words.");
        else if (!msg.hasRules) showToast("No word swaps are set up yet.");
        else if (!msg.found) showToast("No reply found to swap in this chat.");
        else if (msg.changed > 0) showToast("Swapped words in " + msg.changed + (msg.changed === 1 ? " reply." : " replies."));
        else if (msg.skipped > 0) showToast("Already swapped. Turn on re-swapping to redo it.");
        else showToast("No matching words to swap.");
        } catch (_) {}
      });
      disposers.push(() => { try { offRep && offRep(); } catch (_) {} });
    }
  } catch (_) {}
  disposers.push(() => { try { replaceActionOff && replaceActionOff(); } catch (_) {} try { replaceAction && replaceAction.destroy(); } catch (_) {} });
  log("ready v" + VERSION, cfg);

  return () => {
    clearConfirmWatch();
    offs.forEach((o: any) => {
      try {
        o && o();
      } catch (_) {}
    });
    disposers.forEach((d) => {
      try {
        d && d();
      } catch (_) {}
    });
    if (modalHandle) {
      try {
        modalHandle.dismiss();
      } catch (_) {}
      modalHandle = null;
    }
    hideLiveLog();
    chats.forEach(clearTimers);
    chats.clear();
    eventLog.length = 0;
    try {
      if (typeof document !== "undefined" && document.getElementById) {
        const t: any = document.getElementById("__lvRetryToast");
        if (t) {
          clearTimeout(t.__h);
          if (t.remove) t.remove();
        }
      }
    } catch (_) {}
  };
}
