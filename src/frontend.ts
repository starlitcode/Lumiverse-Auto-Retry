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

// The section-header carets. Named so the open and shut states are set from
// one place instead of repeating the escapes at every call site.
const CARET_OPEN = "\u25BE"; // down triangle
const CARET_SHUT = "\u25B8"; // right triangle

// Stacking order for everything this extension puts on screen, in one place.
//
// Two of these sat at 2147483647, the highest a browser accepts. Nothing can be
// drawn above that, so an Auto Retry hint stayed on top of whatever
// another extension opened over it, and the other extension had no number left
// to win with. These are high enough to clear ordinary page content and low
// enough to leave room above for anyone who needs it.
//
// The two overlays are the exception and stay near the top: they open over the
// host's own settings modal and have to be above it to be usable at all.
const Z_LIVE_LOG = 2147483000;
const Z_TOAST = 2147483100;
const Z_HINT = 2147483300;
const Z_OVERLAY = 2147483600;

const STORE_KEY = "lv-auto-retry:settings:v1";
// The settings search field. It needs an id because the browser's own clear
// button inside it can only be reached from a stylesheet, not inline.
const SEARCH_ID = "__lvRetrySearch";

// How long (ms) to suppress automatic retries after the user stops or cancels.
// Long enough to swallow the stopped generation's own trailing events.
const STAND_DOWN_MS = 2500;
const IGNORE_MAX = 16; // most aborted-generation ids kept around to swallow their late events

// How long (ms) to wait after clicking a retry control before deciding the
// click started nothing. A swipe control can move between existing rerolls
// instead of making a new one, and a stale control does nothing at all.
//
// Sized for the slowest link in the chain rather than the fastest: on a busy
// server, or a local model that has to load weights before it reports a start,
// six seconds ran out while the generation was still coming, so the extension
// decided its own click had failed and pressed the other control on top of it.
const START_GRACE_MS = 15000;
// The retry reason that carries the optional note. Named once so the arming
// check below cannot drift away from the callers that raise it.
const REFUSAL_REASON = "looks like an accidental refusal";
// The other three ways a refusal is decided, each reported under its own name.
//
// They are all refusals as far as this extension is concerned, and every one of
// them takes the same retry, the same cap and the same note. What differs is
// what you would do about it, and the Stats tab is where that gets read: a
// column of "declined" says the phrase list is earning its keep, a column of
// "broke off" points at the switch for that tier, and a column of the last one
// points at the switch nobody turns on by accident. Folded into a single total
// none of those questions has an answer.
const BREAKOFF_REASON = "broke off rather than declining";
const BLOCKED_REASON = "blocked before it was written";
const CRISIS_REASON = "left the scene to offer support";
const isRefusalReason = (reason: string) =>
  reason === REFUSAL_REASON ||
  reason === BREAKOFF_REASON ||
  reason === BLOCKED_REASON ||
  reason === CRISIS_REASON;
// Longest the retry click waits on the backend confirming the note is in place.
// A round trip to a backend under load is not instant, and giving up early
// meant clicking without the note, which is the one thing the wait exists to
// prevent. Nothing waits this long in practice: it resolves on the reply.
const NOTE_ACK_MS = 4000;

// How many notes one refusal retry may carry.
//
// A note is a whole message in the prompt, sent on every refusal retry once the
// list is in use, so the ceiling is about what stops being a note and starts
// being a second system prompt crowding the scene out. Ten covers the case this
// was asked for, a note answering the note before it, with room left for a
// short worked example if someone wants one, and it is still a list you can
// read at a glance. Below ten nobody is stopped from doing anything reasonable;
// above it the notes start costing more than they buy on every single retry.
// Use fewer by adding fewer: one is the floor and it is the default.
const MAX_NOTES = 10;
// The roles a note may carry, and how each is offered in the panel. One list,
// because the picker was written out twice: once to build the dropdown and
// again to check what came back out of it, so adding a role in one place would
// have made the other silently reject it.
const NOTE_ROLE_OPTIONS = [
  { value: "system", label: "System" },
  { value: "user", label: "You" },
  { value: "assistant", label: "The character" },
];
const NOTE_ROLES = NOTE_ROLE_OPTIONS.map((o) => o.value);
// Which retry a note starts on, when it does not say. Two, so the first retry
// re-sends unchanged and a note is only added once a plain re-roll has failed.
const NOTE_FROM_TRY_DEFAULT = 2;
const NOTE_FROM_TRY_MAX = 20;

// Largest amount of streamed text kept per chat as a fallback when the end
// event arrives without a content field. Trimmed from the front past this.
const STREAM_BUF_MAX = 200000;

// Bumped on each release. Shown in the startup log and in the Copy debug info
// report, so a bug report always says which version it came from.
const VERSION = "4.23.0";

// The one address the extension ever points at, used by the warning in front of
// the crisis-support check. Pinned to the released branch rather than to a tag,
// so an old install still opens the page as it stands today.
const SAFETY_URL =
  "https://github.com/starlitcode/Lumiverse-Auto-Retry/blob/stable/docs/safety.md";

// ---- defaults (the UI overrides these; editing here changes the fallback) ----
const CONFIG = {
  enabled: true,
  // Two quick ways to switch the extension off without opening settings: a small
  // draggable button over the chat, and an entry in the chat input's Extras menu.
  showFloatingToggle: false,
  floatingToggleSize: 44,
  showExtrasToggle: false,

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
  retryDelayMs: 2000, // long enough that a provider catching its breath has caught it
  backoffFactor: 2,
  maxDelayMs: 60000,

  jitter: true,

  // rate limiting (HTTP 429 / overloaded). Most free and shared tiers meter per
  // minute, so a wait under ten seconds usually just spends another try hitting
  // the same limit. Fifteen clears the common ones on the first retry.
  rateLimitDelayMs: 15000,

  // how a retry redoes the reply. false = click the regenerate control (redoes
  // the reply in place). true = click the next / swipe control, which adds a new
  // reroll and leaves the existing rerolls in place. Either way the other
  // control is the fallback, picked at click time from what is actually on
  // screen and clickable, and used again if the first click starts nothing.
  // On by default, because of what the two do to a reply that was fine. A
  // regenerate redoes the reply in place and on some builds clears the other
  // rerolls with it, so a retry the extension should not have made takes the
  // good reply with it and there is no way back. A swipe adds a reroll beside
  // it, so the reply it was wrong about is still there to swipe back to.
  retryByNewReroll: true,

  // watchdogs. Both are set long. A watchdog that fires early on a slow but
  // healthy model is worse than one that fires late: it throws away a reply
  // that was still arriving, and the replacement is generated by that same
  // slow model, so it fires again on that one too and the chat fills with
  // half-written replies. The cost of waiting too long is that a genuinely dead
  // generation sits there a bit longer, which the user can see and stop.
  //
  // Three minutes covers a local model loading weights, a long prompt being
  // processed before the first token, and a queue on a shared endpoint.
  stuckTimeoutMs: 180000, // started but never produced a token or an end. 0 disables.
  // Ninety seconds of silence mid-stream. Reasoning models go quiet between
  // blocks, and a slow CPU model can take a minute between tokens on a long
  // context, so anything shorter re-rolls replies that were still coming.
  idleTimeoutMs: 90000, // tokens were flowing then stopped this long (mid-stream cutoff). 0 disables.

  // what counts as needing a retry
  retryOnError: true,
  ignoreHardErrors: true,
  retryOnEmpty: true, // also catches a generation cut off mid-reasoning (reasoning seen, content empty)
  retryOnTruncated: true, // final content present but cut off mid-sentence (structural heuristic, see looksTruncated)
  // Also treat "the reply stops on a letter" as cut off. This was off because
  // it was wrong too often: the test for an ending was a list of Latin
  // characters, so a scene closing on an emoji, or on a Japanese, Chinese,
  // Greek or Arabic full stop, counted as having no ending at all. It reads any
  // script's punctuation now, so the only thing it fires on is a reply that
  // stops mid-word, which is what it was always meant to catch.
  retryOnNoPunct: true,
  retryOnShort: false, // off by default. Caused endless regen in the original.
  minChars: 24,
  retryOnRefusal: true, // final content is an out-of-character refusal (see refusalVerdict). Re-fires the SAME request, capped by maxRetries. Does not alter the request.
  refusalExtraPhrases: "", // your own extra refusal phrases, one per line. Any reply containing one counts as a refusal.
  refusalPhraseSubs: "", // reword the built-in phrases: "old => new" rules, one per line, applied to the built-in list before matching.
  refusalIgnorePhrases: "", // a reply containing any of these (one per line) is never counted as a refusal.
  refusalUseBuiltins: true, // use the built-in refusal lists. Turn off to run purely on your own phrases below.
  refusalCatchDisengage: true, // also catch the model ending the scene ("I'll stop here", "I won't continue this conversation"). Only counted near the end of a reply and never inside quotation marks.
  refusalCatchCrisis: false, // also catch the model leaving the scene to offer real-world support and crisis resources. Off by default, and the panel asks you to read a warning before switching it on.
  refusalIgnoreQuoted: true, // a match inside quotation marks is a character speaking, not the model, so it is not counted.
  refusalMaxChars: 2000, // only replies up to this length are considered refusals. Longer = treated as real content. 0 = no limit (scan any length).

  refusalStripThinking: true, // ignore the model's thinking when checking for a refusal, so a refusal that lives only in a <think> block does not trigger a retry when the visible reply is fine.
  refusalThinkTags: "", // extra reasoning tag names (one per line) the model wraps its thinking in, on top of the built-in set. Both <tag> and [tag] forms are handled.
  // A note sent with a refusal retry, and only with a refusal retry. It goes
  // into the prompt for that one generation and is never written to the chat.
  // Off by default, and does nothing at all while the text is empty.
  refusalNote: false,
  // A list rather than one string, so a note can answer the one before it. Each
  // entry carries its own role and its own first try. Sent in order, as one
  // block, at the placement below. Empty entries are skipped, so a half-filled
  // list is not a trap.
  //
  // The first try is per note because that is what having several notes is for.
  // One number for the whole list meant more notes could only ever mean more
  // text at once, never "that did not work, try something stronger". Now a
  // gentle note can start on try 2 and a firmer one on try 4, and the retry
  // carries whichever ones have come due.
  refusalNotes: [{ text: "", role: "system", fromTry: NOTE_FROM_TRY_DEFAULT }] as Array<{ text: string; role: string; fromTry: number }>,
  refusalNotePlacement: "after", // after | before | start, relative to the last real message
  // Off by default. On, the note is only attached when Lumiverse itself calls
  // the generation a regenerate or a swipe. Most builds call every generation
  // "normal", and on those this stops the note going out at all, which is why
  // it is not the default.
  refusalNoteStrictType: false,
  // Find and replace in replies (handled by the backend via the Chat Mutation API).
  replaceEnabled: false, // off by default. When on, applies replaceRules to each finished reply and edits the saved message.
  replaceRules: "", // "old => new" rules, one per line. A single word matches whole words; empty right side deletes it. Same word can appear more than once.
  replaceCaseSensitive: false, // match letter case exactly. Off = case-insensitive with capitalization kept.
  replaceRandom: false, // when a word has more than one replacement, pick one at random per occurrence. Off = always the first listed.
  showReplaceButton: false, // optional button in the input's Extras menu that applies the word swaps to the latest reply on demand.
  showSwapAllButton: false, // adds an Extras button that swaps every generated reply in the chat once.
  allowReSwap: false, // let that button swap a reply again even if it was already swapped this session (can stack swaps).
  swapThinking: false, // also swap inside the model's thinking. Off = only the visible reply is swapped, and any reasoning block is left exactly as it was.
  swapMarkup: false, // also swap inside HTML tags in a reply. Off = tags like <font color="#ff0"> are left alone, so a rule cannot break the markup.
  confirmBeforeEdit: false, // ask for confirmation before any word-swap edit (automatic or manual); the user can cancel.
  swapWaitForEdits: false, // wait for another extension to finish editing a reply before swapping it.
  // How long to give it, in seconds. Only used when the above is on.
  //
  // Hone refines reasoning and non-reasoning replies alike, and that second
  // pass is a whole generation: how long it takes depends on the model, the
  // prompt and how much it has to read. Fifteen seconds covered a fast model
  // and nothing else, so on anything slower the swap landed first and the
  // refinement arrived on top and wiped it, which is the exact failure this
  // setting exists to prevent. Each edit restarts the clock, so a refinement
  // that finishes early is not made to wait this out.
  swapWaitSecs: 85,

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
  // Whether the box below is read at all. Off, the built-in list is used and
  // nothing else, which is what almost everyone wants, and the box stays out of
  // the panel rather than sitting there as one more thing to wonder about.
  confirmButtonsCustom: false,
  // extra button labels Auto Retry may press on a dialog that appears after it
  // clicks retry. One per line. Blank means the built-in list only.
  confirmButtonLabels: "",

  stopSelector:
    '[aria-label="Stop generation"], [data-action="stop"], [data-testid="stop"], ' +
    'button[aria-label*="stop" i], button[title*="stop" i], [class*="_sendBtnStop_"]',

  toast: true,
  // The on-screen panel: what the extension did, what went to the model, and
  // what it has been doing overall, as three tabs of one thing. Handy on
  // mobile, where there is no console to open. Off by default.
  //
  // One setting, not two. The prompt is only captured while its tab is actually
  // open, so there is nothing for a second switch to buy: a switch left on
  // would go on paying for itself in every chat long after somebody looked once.
  liveLog: false,
  // Where that panel lives. "float" is the original: a small box over the chat
  // that the user drags where they want it. "drawer" puts it in Lumiverse's own
  // sidebar, which places it, themes it, lists it in the Ctrl+K palette, and
  // keeps it off the reply the user is reading.
  panelHome: "float",
};

// A hint that quotes a default reads it from the block above rather than
// spelling it out. Five of them were written by hand and went stale the moment
// the timings were retuned: the panel was telling people it waited 30 seconds
// while the extension waited 60, and that a stalled reply was given 90 seconds
// when it was given three minutes. A wrong number in a hint is worse than no
// number, because it is the one thing in the row someone will trust over the
// box next to it. Nothing below is a literal now, so a default cannot be
// changed without every hint that mentions it changing with it.
function humanMs(ms: number): string {
  if (ms >= 60000 && ms % 60000 === 0) {
    const m = ms / 60000;
    return m + (m === 1 ? " minute" : " minutes");
  }
  const s = ms / 1000;
  return s + (s === 1 ? " second" : " seconds");
}
// "60000 = 60 seconds", built from whatever the default actually is.
function defaultMs(key: keyof typeof CONFIG): string {
  const ms = Number((CONFIG as any)[key]);
  return ms + " = " + humanMs(ms);
}
const def = (key: keyof typeof CONFIG): string => String((CONFIG as any)[key]);

// Fields the settings UI can edit, in display order. The one place that defines
// both the form and what gets persisted. Every option above (except the two
// internal timing constants) is listed here, so everything is user-editable.
type FieldType = "bool" | "num" | "text" | "pick" | "notes";
interface Field {
  key: keyof typeof CONFIG;
  label: string;
  type: FieldType;
  hint?: string;
  selector?: boolean;
  min?: number;
  max?: number;
  int?: boolean;
  // "pick" only: the values this setting is allowed to hold, in the order they
  // are offered. Anything else, from a hand-edited backup or an older version,
  // falls back to the first one.
  options?: Array<{ value: string; label: string }>;
  // Puts this setting's description above its row instead of below it. Only
  // worth setting on a row tall enough that "below the row" is a long way from
  // the "?" that was pressed, which is the note list: the whole list, its
  // roles, its buttons and its counter are all one row.
  hintAbove?: boolean;
  // Puts this row under a labelled run inside its group, named in RUNS below.
  // Consecutive rows naming the same run share one heading. It exists because
  // two settings sitting under the note list read as belonging to whichever
  // note was last looked at, and people kept asking which one they changed.
  run?: string;
  // Apply this setting as it is typed rather than waiting for Save, so the
  // thing it controls can be seen changing. Only worth it where the effect is
  // visible on screen and reading a number tells you nothing.
  live?: boolean;
  // Draw the value next to the box at the size it describes.
  // Switches this setting does nothing without. The row is hidden while every
  // one of them is off, so the panel only shows what is currently in use.
  // More than one means any of them is enough, which is the case for a setting
  // two different buttons both read.
  //
  // Only list one where the code genuinely ignores the value. Several settings
  // look dependent and are not: refusalThinkTags still finds the reply when
  // refusalStripThinking is off, ignoreHardErrors is checked before
  // retryOnError rather than under it, and the manual swap buttons read the
  // rules whether or not replaceEnabled is on. Listing those would hide a
  // setting that is still doing something.
  needs?: string[];
  // The other way round: every switch named here has to be on. Use it when a
  // row hangs off two unrelated switches, where needs would show the row as
  // soon as either one was on.
  //
  // It also keeps a chain honest. A row whose parent row is itself hidden has
  // to name the parent's switch as well as its own, or it is left on screen
  // with nothing above it, describing a setting that is not there.
  needsAll?: string[];
}
type ExtraKind = "refusalTester" | "swapPresets" | "notePresets";
interface Group {
  title: string;
  desc?: string;
  fields: Field[];
  // Same idea as a field's, for a whole section: while every switch named here
  // is off, nothing under this heading does anything, so the heading goes too.
  needs?: string[];
  // Starts shut, with a caret to open it. A flag rather than something derived
  // from the heading text, so renaming a heading cannot change how a section
  // behaves. Shut does not mean advanced: backing up settings and building a
  // bug report are things anyone might do, they are just not needed to use the
  // extension.
  collapsed?: boolean;
  // Something built by hand that belongs under this heading, after its rows.
  // Named here rather than matched on the title, so a rename cannot leave the
  // tester or the preset bar silently unbuilt.
  // Extra pieces the section renders under its rows. More than one is allowed,
  // since refusal tuning carries both the tester and its own preset bar.
  extra?: ExtraKind | ExtraKind[];
  // Splits this section's rows by whether a preset carries them. Only find
  // and replace has presets, and the split is worked out from the preset
  // definition rather than written out again.
  splitByPreset?: boolean;
}
// The labelled runs a field can name. A heading over two rows answers the
// question the rows themselves kept raising: the note list gives every note a
// role and a starting try of its own, so the two settings underneath it looked
// like more of the same. They are not. They are for whichever notes are due,
// together, and the heading is where that gets said.
const RUNS: Record<string, { title: string; note: string }> = {
  wholeList: {
    title: "For the whole list",
    note: "These two are set once and apply to every note. What each note sets for itself, its role and the try it starts on, is on its own row in the list above.",
  },
  frozen: {
    title: "Replies that freeze",
    note: "The rows above are about a reply that arrived and was no good. These two are about one that never finished. Both are waits in milliseconds, and both lean long so a slow connection is not read as a freeze. Lower them for quicker retries on a fast provider, or set either to 0 to switch that one off.",
  },
};
const SCHEMA: Group[] = [
  {
    title: "Basics",
    desc: "The main switch, the ways to reach it, and what it shows you while it works.",
    fields: [
      {
        key: "enabled",
        label: "Turn Auto Retry on",
        type: "bool",
        hint: "When on, it quietly tries again whenever a reply fails or gets cut off. Turn it off and it does nothing.",
      },
      {
        key: "showFloatingToggle",
        label: "Floating on/off button",
        type: "bool",
        hint: "Off by default. Puts a small round button on top of the chat. Tap it to turn Auto Retry on or off. It shows which one it is, and you can drag it anywhere. Where you leave it is remembered. Hold the button, or right-click it, to open a menu with the settings, the panel and the swap buttons. While this button is on, those live in its menu instead of in the Extras menu. Useful if you switch Auto Retry on and off a lot.",
      },
      {
        key: "floatingToggleSize",
        needs: ["showFloatingToggle"],
        label: "Size of the floating button",
        type: "num",
        int: true,
        min: 28,
        max: 96,
        live: true,
        hint: "How wide the floating button is, in pixels. The default of " + def("floatingToggleSize") + " is about a comfortable thumb. Larger is easier to hit on a phone, smaller keeps it out of the way. The button itself resizes as you type, so you can see it on the chat before you save. Closing without saving puts it back.",
      },
      {
        key: "showExtrasToggle",
        label: "On/off button in the Extras menu",
        type: "bool",
        hint: "Off by default. Adds an Auto Retry on/off button to the chat input's Extras menu, next to the settings button. It says which one it is, so you can check and change it without opening the settings. It takes up no room on the screen, unlike the floating button. While the floating button is on, this one is hidden: that button is the same on/off switch, and one tap does it.",
      },
      {
        key: "toast",
        label: "Show a pop-up on each retry",
        type: "bool",
        hint: "A small message telling you it is retrying, with a Cancel button to stop it. It counts the wait down as it goes, and says what the retry is for and which try it is, so a long wait looks like a wait rather than like nothing happening.",
      },
      {
        key: "liveLog",
        label: "Show the on-screen panel",
        type: "bool",
        hint: "A panel with three tabs. Log shows what the extension is doing as it happens: generations, retries and why, finishes. Prompt shows the whole prompt that went to the model, every message in order, with your notes marked where they were inserted. Stats shows what it has been doing overall and what it keeps retrying for. Useful without opening the console, especially on a phone. The prompt is only captured while its tab is open, and only ever on your device.",
      },
      {
        key: "panelHome",
        needs: ["liveLog"],
        label: "Where that panel goes",
        type: "pick",
        live: true,
        options: [
          { value: "float", label: "Floating over the chat" },
          { value: "drawer", label: "In the sidebar drawer" },
        ],
        hint: "Floating is a small box in the corner. Drag the top of it to move it, drag the bottom corner to resize it, and where you leave it is remembered. In the sidebar puts it in Lumiverse's own side panel instead. Lumiverse decides the size and place, so it never covers the reply you are reading. To open it: the Extras menu, or the floating button's menu while that button is on, or Ctrl+K on a computer. Its tab shows a dot while a retry is running. If your version of Lumiverse has no side panel for extensions, you get the floating box instead, and the Log says so.",
      },
    ],
  },
  {
    title: "How it retries",
    desc: "How persistent it is, how long it waits between tries, and which button it presses.",
    fields: [
      {
        key: "maxRetries",
        label: "Most tries per message",
        type: "num",
        int: true,
        // One, not zero. Zero meant the give-up check passed on the first
        // failure, so nothing was ever retried: a retry extension sitting there
        // reporting itself as on and doing nothing, with no line anywhere
        // saying why. There are two proper ways to stop it, the master switch
        // and the per-chat switch, and both say so on screen. A number box is
        // not a third one.
        min: 1,
        max: 50,
        hint: "How many times it retries one message before giving up. 3 to 5 suits most people. The lowest is 1, since 0 would leave the extension on and never retrying; to stop it retrying, switch it off instead, either everywhere or in this chat.",
      },
      {
        key: "pauseWhenFailing",
        label: "Pause when everything is failing",
        type: "bool",
        hint: "On by default. If several whole runs give up in a row, the provider is probably down, so Auto Retry stops for a while instead of retrying on every message you send. The next reply that works clears it, and you can still send and regenerate by hand while it's paused. The two boxes below set how many runs and how long.",
      },
      {
        key: "breakerRuns",
        needs: ["pauseWhenFailing"],
        label: "Failed runs before pausing",
        type: "num",
        int: true,
        min: 1,
        max: 20,
        hint: "How many whole runs have to give up back to back before it pauses. A run is one message that used up all its tries. At the default of " + def("breakerRuns") + ", with the try limit at " + def("maxRetries") + ", that is " + (CONFIG.breakerRuns * CONFIG.maxRetries) + " retries before it stops. Raise it if your setup is normally flaky, lower it to give up sooner.",
      },
      {
        key: "breakerPauseMins",
        needs: ["pauseWhenFailing"],
        label: "How long to pause (minutes)",
        type: "num",
        int: true,
        min: 1,
        max: 180,
        hint: "How long Auto Retry stays off once it pauses. A short pause suits a provider that drops out for a moment and comes back. A long one suits a real outage. Any reply that comes back fine ends the pause early, whatever this is set to.",
      },
      {
        key: "retryDelayMs",
        label: "Wait before the first retry (ms)",
        type: "num",
        int: true,
        min: 0,
        max: 600000,
        hint: "How long it pauses before trying again the first time. In milliseconds, so the default is " + defaultMs("retryDelayMs") + ".",
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
        label: "Longest it will ever wait (ms)",
        type: "num",
        int: true,
        min: 0,
        max: 600000,
        hint: "A ceiling so it never pauses forever. The default is " + defaultMs("maxDelayMs") + ".",
      },
      {
        key: "rateLimitDelayMs",
        label: "Wait when the server is busy (ms)",
        type: "num",
        int: true,
        min: 0,
        max: 600000,
        hint: 'If the server says "too many requests," it waits at least this long. The default is ' + defaultMs("rateLimitDelayMs") + '. Most shared and free tiers count per minute, so a shorter wait usually spends another try hitting the same limit.',
      },
      {
        key: "jitter",
        label: "Add a little randomness to waits",
        type: "bool",
        hint: "Nudges each wait by a random amount so retries don't all hit the server at the same instant. Best left on.",
      },
      {
        key: "retryByNewReroll",
        label: "Retry by adding a new reroll",
        type: "bool",
        hint: "On, the default: a retry clicks your next / swipe button, which adds a new reroll and keeps the existing ones, so a reply it was wrong to retry is still there to swipe back to. Off: a retry redoes the reply in place with your regenerate button, and on some setups that clears the other rerolls on that message, which means a retry it should not have made cannot be undone. Either way, if that button isn't on screen or the click starts nothing, it uses the other one, so set both selectors in the buttons section below.",
      },
    ],
  },
  {
    title: "When to count a reply as bad",
    desc: "Pick which kinds of bad reply should set off a retry, including a reply that freezes or never arrives.",
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
        hint: "Retry when a reply stops partway, like an open quote, an unfinished *action*, or a trailing comma. It's careful so it doesn't throw away good writing.",
      },
      {
        key: "retryOnNoPunct",
        label: "It stops on a word, with nothing after it",
        type: "bool",
        hint: "On by default. Catches a reply that stops on a word with no full stop, question mark or anything else after it, which is what being cut off mid-sentence looks like when nothing else was left open. Punctuation in any script counts as an ending, and so does an emoji, so a scene finishing on one is left alone. Turn it off if your model ends replies without punctuation on purpose.",
      },
      {
        key: "retryOnShort",
        label: "It was very short",
        type: "bool",
        hint: "Retry replies shorter than the length below. Off by default, since short replies are often fine.",
      },
      {
        key: "minChars",
        needs: ["retryOnShort"],
        label: 'What counts as "very short"',
        type: "num",
        int: true,
        min: 0,
        max: 100000,
        hint: "Replies with fewer characters than this count as too short. Only the words you read are counted: any reasoning block is left out, and so is markup, so a line wrapped in tags is measured by what it says rather than by the tags around it. Only used when the option above is on.",
      },
      {
        key: "retryOnRefusal",
        label: "It looks like an accidental refusal",
        type: "bool",
        hint: "Retry when the model breaks character to decline (says it's an AI, or that it can't help or continue). It retries the same request unchanged, capped by your Most tries setting, so a refusal the model means will survive the tries and stop. Reads only the final reply, never the thinking, and stays narrow so an in-character \"I can't do that\" is left alone.",
      },
      {
        key: "stuckTimeoutMs",
        run: "frozen",
        label: "Give up waiting for it to start (ms)",
        type: "num",
        int: true,
        min: 0,
        max: 600000,
        hint: "If a reply begins but no words appear in this long, treat it as stuck and retry. The default is " + defaultMs("stuckTimeoutMs") + ", which is long enough for a local model to load and for a long prompt to be read before the first word arrives. Set to 0 to switch off.",
      },
      {
        key: "idleTimeoutMs",
        run: "frozen",
        label: "Give up on a reply that froze (ms)",
        type: "num",
        int: true,
        min: 0,
        max: 600000,
        hint: "If words were appearing and then stop for this long, treat it as frozen and retry. The default is " + defaultMs("idleTimeoutMs") + ". A reasoning model goes quiet between blocks and a slow one can take a while between words, so shorter than this re-rolls replies that were still coming. Set to 0 to switch off.",
      },
    ],
  },
  {
    title: "Refusal tuning",
    collapsed: true,
    extra: ["notePresets", "refusalTester"],
    // Every setting under here feeds refusalVerdict, and all three places
    // that call it sit behind retryOnRefusal, so with that off the section is
    // inert. One exception: refusalThinkTags is still read by the empty and
    // short checks through stripThinkingAlways. Searching finds it, because a
    // search ignores all of this.
    needs: ["retryOnRefusal"],
    desc: "Only matters if the refusal option above is on. Fine-tunes what counts as a refusal.",
    fields: [
      {
        key: "refusalUseBuiltins",
        label: "Use the built-in phrase list",
        type: "bool",
        hint: "On by default. This only controls the built-in list. Your own phrases below are always used either way. On, the built-in list is used together with your own phrases. Off, only your own phrases are used.",
      },
      {
        key: "refusalCatchDisengage",
        needs: ["refusalUseBuiltins"],
        label: "Also catch the model breaking off",
        type: "bool",
        hint: "On by default. Catches a reply that stops rather than declines: \"I'll stop here\", \"I won't continue this conversation\", \"let's change the subject\". Only counted when it is how the reply ends, and never when it is something a character says out loud, so a scene where someone stops walking is left alone. Turn it off if your model writes characters who talk this way.",
      },
      {
        key: "refusalCatchCrisis",
        needs: ["refusalUseBuiltins"],
        label: "Also catch it stopping to offer support",
        type: "bool",
        hint: "Off by default, and it asks you to read a warning before it goes on. Catches a reply that leaves the story to speak to you rather than to your character: what you have written is concerning, you are not alone, please talk to a professional, followed by a list of services. Two separate parts of the reply have to point that way before it counts, and a line inside quotation marks never counts, so a character in the scene saying something kind is left alone. It is the one check the length limit below does not apply to, because these replies are long. Read the safety page in the docs before turning it on.",
      },
      {
        key: "refusalIgnoreQuoted",
        label: "Ignore refusals inside quotation marks",
        type: "bool",
        hint: "On by default. A line inside quotation marks is a character speaking, so it is not counted as the model refusing. This is what keeps \"I can't help with that,\" said the innkeeper from being thrown away. Turn it off only if your model puts its own refusals in quotes. Your own phrases are always counted either way, and the support check above always skips quoted lines.",
      },
      {
        key: "refusalExtraPhrases",
        label: "Your own refusal phrases",
        type: "text",
        hint: "Optional. Extra phrases that should also count as a refusal, one per line. These are always used, whether or not the built-in list above is on. Upper or lower case doesn't matter. Paste the exact wording your model refuses with.",
      },
      {
        key: "refusalPhraseSubs",
        needs: ["refusalUseBuiltins"],
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
        hint: "Replies longer than this are treated as real writing, not a refusal, and left alone. The default of " + def("refusalMaxChars") + " suits most cases. Set to 0 to check replies of any length.",
      },
      {
        key: "refusalStripThinking",
        label: "Ignore the thinking / reasoning",
        type: "bool",
        hint: "On by default. Only the final reply is checked for a refusal, never the model's thinking, so a refusal it weighs up while reasoning but leaves out of the reply won't cause a retry. Turn it off to check the whole raw output. This affects refusal matching only: the empty and cut-off checks always look past the thinking.",
      },
      {
        key: "refusalThinkTags",
        label: "Extra thinking tag names",
        type: "text",
        hint: "Optional, one per line. The common reasoning tags are already handled. Add a tag name only if your model wraps its thinking in an unusual one (for example: mythink). Just the name, no brackets or pipes; underscores and hyphens are part of a name, spaces are not. A name you add is recognised in all four wrappers, and it covers the word swaps and the length checks as well as refusals.",
      },
      {
        key: "refusalNote",
        label: "Send a note with a refusal retry",
        type: "bool",
        hint: "Off by default. Every other kind of retry re-sends your request exactly as it was, and still does. This one adds your note to the prompt for that single try. It goes to the model only: nothing is written to your chat and nothing appears in the reply. Needs the interceptor permission, and does nothing while the box below is empty.",
      },
      {
        key: "refusalNotes",
        needs: ["refusalNote"],
        hintAbove: true,
        label: "What the notes say",
        type: "notes",
        hint: "Your notes go to the model, not into your chat, and exactly as you typed them. Nothing is added, removed or checked. You can have up to ten, and empty ones are skipped. Each note carries its own Role, which decides whether it sits with your setup's instructions, your own messages or the replies, and its own From try, which decides which retry it joins on. Notes that are due go out together, in the order you wrote them.",
      },
      {
        key: "refusalNotePlacement",
        needs: ["refusalNote"],
        run: "wholeList",
        label: "Where the notes go",
        type: "pick",
        options: [
          { value: "after", label: "After the last message" },
          { value: "before", label: "Before the last message" },
          { value: "start", label: "At the very start" },
        ],
        hint: "Whichever notes are due go in together as one block. After the last message puts it at the end, right before the point the reply continues from. Before the last message puts it one place earlier, so the newest line is still last. At the very start puts it ahead of everything, with the setup.",
      },
      {
        key: "refusalNoteStrictType",
        needs: ["refusalNote"],
        run: "wholeList",
        label: "Only send them on a regenerate or a swipe",
        type: "bool",
        hint: "Off by default, and best left off. Lumiverse says what kind of generation is running, and most builds call every one of them \"normal\", including a regenerate, so turning this on stops notes going out at all. Turn it on only if your build reports the kind properly and you want the extra check. Either way a note goes out once, to the chat it was armed in, on the retry that armed it.",
      },
    ],
  },
  {
    title: "Find and replace (beta)",
    collapsed: true,
    splitByPreset: true,
    extra: "swapPresets",
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
        hint: 'Rules are "old => new", one per line. A single word matches whole words only, so cat will not touch category, while a phrase or sentence matches exactly as you type it. Leave the right side empty to delete it. All rules run in one pass, so no rule ever acts on what another just wrote. The Word swaps page in the docs covers the rest.',
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
        hint: "Off by default. Adds a button that applies your word swaps on demand to the latest reply, so you can swap without leaving the automatic swap on. It sits in the chat input's Extras menu, or in the floating button's own menu while that button is showing. Only assistant replies are swapped, never your own messages, and the same reply won't be swapped twice. Needs your swap rules set up.",
      },
      {
        key: "showSwapAllButton",
        label: "Show a swap-whole-chat button",
        type: "bool",
        hint: "Off by default. Adds a button that applies your rules once to every generated reply in the chat you're viewing. It sits in the chat input's Extras menu, or in the floating button's own menu while that button is showing. The greeting is never touched.",
      },
      {
        key: "allowReSwap",
        needs: ["showReplaceButton", "showSwapAllButton"],
        label: "Allow swapping a reply again",
        type: "bool",
        hint: "Off by default. Normally a reply is swapped at most once per session, so swaps don't stack. Turn this on to let the button swap a reply again even if it was already swapped, for example after you change your rules. This can apply your rules on top of an earlier swap.",
      },
      {
        key: "swapThinking",
        label: "Also swap inside the thinking",
        type: "bool",
        hint: "Off by default, so only the reply you read is swapped and the model's thinking is left exactly as it was. Lumiverse shows reasoning in its own block, so a swap there changes nothing you see while still rewriting what the model worked out. Turn it on to swap the thinking too. Reasoning your provider returns separately, rather than in the reply, is never swapped either way.",
      },
      {
        key: "swapMarkup",
        label: "Also swap inside HTML tags",
        type: "bool",
        hint: "Off by default, so a rule only ever changes the words you read. Replies that use tags like <font color=\"#ffff00\"> carry words inside the markup, and a rule such as color => colour would rewrite the tag itself and quietly break it. Turn this on if you want your rules to reach the tags too, for example to change a colour everywhere at once.",
      },
      {
        key: "confirmBeforeEdit",
        label: "Ask before editing a reply",
        type: "bool",
        hint: "Off by default. When on, every word swap (automatic or from the button) asks you to confirm before it changes a reply, and you can cancel. This can get frequent if you use automatic swapping, but nothing is edited without your OK. Needs your Lumiverse to support confirm dialogs.",
      },
      {
        key: "swapWaitForEdits",
        needs: ["replaceEnabled"],
        label: "Wait for other extensions to finish",
        type: "bool",
        hint: "Off by default. Turn this on if another extension also rewrites replies, like Hone with auto-refine on. A swap normally applies the moment a reply lands, and the other extension's rewrite then arrives on top and undoes it. With this on, the swap waits for the reply to stop changing first, so both survive, and it reapplies up to three times if a later edit undoes it. Leave it off if nothing else edits your replies: it only adds a delay. The swap buttons are not affected and always apply straight away.",
      },
      {
        key: "swapWaitSecs",
        needsAll: ["replaceEnabled", "swapWaitForEdits"],
        label: "How long to wait (seconds)",
        type: "num",
        int: true,
        min: 1,
        max: 300,
        hint: "How long to give another extension to make its edit before swapping anyway. Each edit restarts the clock and the swap follows shortly after the last one, so this is only the full wait when nothing else edits at all. The default of " + def("swapWaitSecs") + " covers most models. The other extension is writing a whole new reply, so how long that takes depends on the model, the prompt and how much there is to read. Raise it if your swaps still get overwritten, lower it if you are only waiting on something quick.",
      },
    ],
  },
  {
    title: "Buttons it clicks",
    collapsed: true,
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
        key: "confirmButtonsCustom",
        label: "My dialog's button says something else",
        type: "bool",
        hint: "Leave this off unless a retry opens a dialog that Auto Retry does not get past. It already knows Skip, Regenerate, Confirm, Proceed, Submit and OK, which covers Lumiverse's Regeneration Feedback and every build seen so far, and that list is used whether this is on or off. Turning it on adds a box where you can type the wording your own dialog uses.",
      },
      {
        key: "confirmButtonLabels",
        needs: ["confirmButtonsCustom"],
        label: "Extra dialog buttons it may press",
        type: "text",
        hint: "Type the button's text exactly as it appears, one per line. Capitals are ignored. Anything you add here is tried before the built-in list, which is still used as well. Nothing here is read while the switch above is off.",
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
];

// Final content present but cut off mid-sentence. Lumiverse does not expose
// finish_reason on GENERATION_ENDED (confirmed against the Generation API), so
// this works off the only signal a frontend extension has: the shape of the
// text. Kept conservative to avoid re-rolling good roleplay replies.
// Whole HTML-ish tags, and nothing else. Only the tag is removed; the words
// between an opening and a closing tag are the reply and stay exactly as they
// are. Kept narrow on purpose so a stray "<" typed in a scene is left alone:
// it has to look like a real tag, name and all, before anything is dropped.
// A quoted attribute value may itself contain ">", so quoted runs are skipped
// rather than ending the tag at the first ">". Stopping early leaves the tail
// of the tag behind, and a stray quotation mark in it reads as dialogue opened
// and never closed.
//
// The three branches cannot match the same first character, so there is nothing
// to backtrack between, and the repetition is capped against pathological
// input.
const HTML_TAG = /<\/?[a-zA-Z][a-zA-Z0-9-]*(?:"[^"]*"|'[^']*'|[^'">]){0,400}>/g;

// Also what a length check measures: a line of dialogue wrapped in
// <font color="#ffff00"> carries about thirty characters of markup around what
// was actually said, so counting the tags measures the wrong thing.
function stripMarkup(text: string): string {
  return String(text == null ? "" : text).replace(HTML_TAG, "");
}

// Containers whose closing tag is not optional, and which a model only ever
// writes as a matched pair. A tracker is built out of these. The ones with an
// optional end tag in HTML are left out on purpose (p, li, tr, td, th): models
// write "<li>one<li>two" and mean it, and counting those would re-roll a
// finished reply. When a table really is cut short its own <table> is left
// open, which is in here, so nothing is lost by leaving its cells out.
const HTML_CONTAINERS =
  "div|table|thead|tbody|tfoot|ul|ol|dl|pre|blockquote|details|section|article|figure|figcaption|form|fieldset";
const HTML_CONTAINER_LIST = HTML_CONTAINERS.split("|");

// Element names HTML already knows about. Everything here is dealt with by the
// rules above and below; this list exists so the check after it can tell an
// element from a tag somebody invented.
const HTML_KNOWN =
  ("html|head|body|div|span|p|a|b|i|u|s|em|strong|small|mark|sub|sup|code|pre|kbd|samp|var|" +
   "br|hr|img|picture|source|video|audio|track|embed|object|param|iframe|canvas|svg|path|g|" +
   "ul|ol|li|dl|dt|dd|table|thead|tbody|tfoot|tr|td|th|caption|colgroup|col|" +
   "form|input|button|select|option|optgroup|textarea|label|fieldset|legend|datalist|output|" +
   "h1|h2|h3|h4|h5|h6|header|footer|main|nav|section|article|aside|figure|figcaption|" +
   "blockquote|q|cite|abbr|address|time|data|ruby|rt|rp|bdi|bdo|wbr|" +
   "details|summary|dialog|menu|template|slot|noscript|script|style|link|meta|title|base|" +
   "font|center|strike|big|tt|marquee|progress|meter|del|ins").split("|");

// A tag a model invented, opened on a line of its own and never closed.
//
// Models are asked to wrap a planning or bookkeeping block in a tag of their
// own making: <story_plan>, <plan>, <status>. When a reply is cut off inside
// one of those, nothing else here notices. The block's own prose can end on a
// full stop with its quotation marks balanced, so every check that reads the
// shape of the text says the reply finished, and stripping markup deletes the
// one piece of evidence before anything looks at it.
//
// Two things keep this narrow. The tag has to be alone on its line, which is
// how these blocks are always written and is not how somebody types <sigh> in
// the middle of a sentence. And the name has to be one HTML does not have,
// because every HTML element already has a rule here: containers are counted,
// inline tags are counted only when styled, and a bare <b> left open is
// ignored on purpose.
function customBlockLeftOpen(shown: string): boolean {
  if (shown.indexOf("<") < 0) return false;
  const counts: Record<string, number> = {};
  const re = /^[ \t]*<(\/?)([a-zA-Z][\w:-]*)(?:\s[^>]*)?>[ \t]*$/gm;
  let m: RegExpExecArray | null;
  let seen = 0;
  while ((m = re.exec(shown)) && seen++ < 5000) {
    const name = m[2].toLowerCase();
    if (HTML_KNOWN.indexOf(name) >= 0) continue;
    counts[name] = (counts[name] || 0) + (m[1] === "/" ? -1 : 1);
  }
  for (const name of Object.keys(counts)) if (counts[name] > 0) return true;
  return false;
}

// The reply with every closed container taken out of it, content and all.
//
// Whatever is inside a container that closed is finished writing. The model got
// to the closing tag, so nothing in there was cut off, and none of it can say
// anything about whether the reply was. That matters because the prose checks
// below count characters that mean something else inside a widget: a card that
// prints `6'2"` in a stat line puts one unpaired quotation mark into the reply,
// which flipped the count for every properly closed piece of dialogue around it
// and re-rolled a finished reply.
//
// A reply cut off inside a widget leaves that widget's container open, so it is
// not removed here and markupLeftOpen catches it. Nothing is lost by trusting a
// closing tag.
//
// Scanned with indexOf rather than matched with a pattern. A pattern for a
// balanced pair backtracks over every unclosed opener, which on a reply that is
// nothing but half-written tags is the square of its length, and this file has
// already been round that loop once.
function withoutClosedContainers(shown: string): string {
  if (shown.indexOf("</") < 0) return shown;
  const ranges: Array<[number, number]> = [];
  const open: Array<{ name: string; at: number }> = [];
  let i = 0;
  // Far past any real reply. Stopping early only means less is removed, which
  // is the behaviour this had before it existed.
  let seen = 0;
  while (i < shown.length && seen++ < 20000) {
    const lt = shown.indexOf("<", i);
    if (lt < 0) break;
    const gt = shown.indexOf(">", lt + 1);
    if (gt < 0) break; // a tag that never finished; markupLeftOpen has it
    const tag = shown.slice(lt, gt + 1);
    i = gt + 1;
    const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)/.exec(tag);
    if (!m) continue;
    const name = m[2].toLowerCase();
    if (HTML_CONTAINER_LIST.indexOf(name) < 0) continue;
    if (m[1] === "/") {
      // Back to the nearest opener of the same name, dropping anything left
      // dangling inside it.
      for (let k = open.length - 1; k >= 0; k--) {
        if (open[k].name !== name) continue;
        const from = open[k].at;
        open.length = k;
        // Only the outermost pair is recorded. Removing that takes everything
        // nested inside it along too.
        if (!open.length) ranges.push([from, gt + 1]);
        break;
      }
    } else if (!/\/>$/.test(tag)) {
      open.push({ name: name, at: lt });
    }
  }
  if (!ranges.length) return shown;
  let out = "";
  let at = 0;
  for (const r of ranges) {
    out += shown.slice(at, r[0]) + " ";
    at = r[1];
  }
  return out + shown.slice(at);
}

// Inline tags that only count when they carry an attribute. A bare <b> or <i>
// left open is a finished reply written badly, and models fumble those in
// ordinary prose often enough that counting them would re-roll good writing.
// A <span style="..."> is not that. It is there because a card asked for it,
// and a card that asks for coloured speech gets the closing tag every time, so
// a missing one means the reply stopped rather than that the model was sloppy.
// This is how dialogue gets coloured, and it was the one cut that nothing else
// here noticed: the speech closes its own quotes, so the reply came out even
// and read as finished with the gradient still open.
const HTML_STYLED_INLINE = "span|font|mark|a";

// Markup the reply opened and never closed. This is the code equivalent of an
// opened quote: the reply stopped inside something it had started, and what it
// stopped inside happens to be a tag rather than a sentence.
//
// It also has to run before a block ending is accepted as an ending, or a
// tracker cut off halfway through would be waved past on the strength of the
// last closing tag it managed to write.
function markupLeftOpen(shown: string): boolean {
  // A tag with no closing bracket can only be the last one in the reply, since
  // any "<" with a ">" after it finished. So this looks at the tail rather than
  // searching for one, which matters: the searching version walked to the end
  // of the string from every "<" it found, and a reply that was 50k half-written
  // tags took it 48 seconds. This is one scan.
  const lastLt = shown.lastIndexOf("<");
  if (lastLt >= 0 && shown.indexOf(">", lastLt) < 0) {
    const tail = shown.slice(lastLt, lastLt + 400);
    // Cut inside the tag itself: "<div class=", or "<table" with nothing after.
    // Named tags only, and none of the one-letter ones, so "if x<y then" and
    // "the value was <b" are left alone. A tag being written is worth catching;
    // a comparison someone typed is not.
    if (
      new RegExp(
        "^<(?:" + HTML_CONTAINERS + "|span|img|br|hr|code|strong|input|h[1-6]|font|small|mark|summary)\\b",
        "i",
      ).test(tail)
    )
      return true;
    // Cut inside an attribute value: <x class="wea . Any tag name here, since
    // an attribute half-written is unambiguous on its own.
    if (/^<[a-zA-Z][a-zA-Z0-9]{0,20}\s[^>]{0,300}?[a-zA-Z-]\s*=\s*["']/.test(tail)) return true;
  }
  // A comment with no end. The reply stopped inside it, and everything after
  // would have been hidden anyway.
  if (shown.lastIndexOf("<!--") > shown.lastIndexOf("-->")) return true;

  // How many of a tag were opened and never closed. <div /> closes itself and
  // is not an opening on its own.
  const unclosed = (name: string) => {
    const opened = shown.match(new RegExp("<" + name + "\\b[^>]*>", "gi")) || [];
    let open = 0;
    let withAttribute = false;
    for (const tag of opened) {
      if (/\/>$/.test(tag)) continue;
      open++;
      if (/\s[a-zA-Z-]+\s*=/.test(tag)) withAttribute = true;
    }
    const shut = (shown.match(new RegExp("</" + name + "\\s*>", "gi")) || []).length;
    return { left: open - shut, withAttribute: withAttribute };
  };
  for (const name of HTML_CONTAINERS.split("|")) if (unclosed(name).left > 0) return true;
  for (const name of HTML_STYLED_INLINE.split("|")) {
    const u = unclosed(name);
    if (u.left > 0 && u.withAttribute) return true;
  }
  return false;
}

// A reply can stop on something that is not a sentence and still be finished.
// Trackers are the usual case: a weather box, a stat block or a status line
// that a card asks for at the end of every reply. None of them close on a full
// stop, so with "Retry when a reply has no ending punctuation" on, every one of
// them read as cut off and got re-rolled, on every reply, forever. A block
// ending is an ending. What the no-punctuation check is for is prose that stops
// mid-word, and none of these are that.
//
// `shown` still has its markup; `visible` has had the tags taken out.
function endsOnABlock(shown: string, visible: string): boolean {
  // An HTML element closing the reply: a </div> around a tracker, a <br/>, the
  // last </table> of a stat grid.
  if (/<\/[a-zA-Z][^>]{0,400}>\s*$/.test(shown)) return true;
  if (/<[a-zA-Z][^>]{0,400}\/>\s*$/.test(shown)) return true;

  const lines = visible.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  if (!lines.length) return false;
  // A markdown table row.
  if (/^\|.*\|$/.test(lines[lines.length - 1])) return true;

  // A bullet or numbered list. A reply that ends on its last item has ended,
  // and the item is a fragment rather than a sentence, so the check for closing
  // punctuation was reading every one of them as a reply cut off. Two in a row
  // are needed for the same reason the labels below need two: one line opening
  // with a dash is as likely to be prose.
  const listItem = (l: string) => /^(?:[-*+]\s+|\d+[.)]\s+)\S/.test(l);
  // A list item is a fragment, so it has no closing punctuation to look for and
  // cannot be told from a cut one that way. What tells them apart is the last
  // word: an item that has finished ends on something a phrase can end on, and
  // one cut in half ends on a word that has to be followed by another. "a map
  // she could not" is cut; "half a candle" is not.
  const danglingWord =
    /\b(?:a|an|and|are|as|at|be|been|being|but|by|can|could|for|from|had|has|have|he|her|his|i|in|into|is|it|its|may|might|must|my|no|not|of|on|onto|or|our|over|she|should|that|the|their|they|to|under|was|we|were|which|who|will|with|would|you|your)$/i;
  if (
    lines.length >= 2 &&
    listItem(lines[lines.length - 1]) &&
    listItem(lines[lines.length - 2]) &&
    !danglingWord.test(lines[lines.length - 1])
  )
    return true;

  // A run of label lines: "HP: 20/20", "**Weather:** clear", "Time: 14:00".
  // Two in a row are needed rather than one, because an ordinary sentence can
  // carry a colon and a tracker never has only the one field. That keeps a
  // reply genuinely cut after "he said:" where it belongs.
  const labelled = (l: string) =>
    /^[*_`]{0,2}[^:\n]{1,30}[*_`]{0,2}\s*:\s*\S[^\n]{0,60}$/.test(l);
  return (
    lines.length >= 2 &&
    labelled(lines[lines.length - 1]) &&
    labelled(lines[lines.length - 2])
  );
}

// A wait, said the way a person would. Whole seconds, because tenths flicker
// and nobody is timing anything to a tenth. Larger units appear only once
// they have something to say: a bare count of seconds stops meaning much
// somewhere past a minute, and the same goes for minutes past an hour.
//
// Hours are not hypothetical. The pause after repeated failures can be set to
// as much as 180 minutes, so a three-hour wait counting down in minutes alone
// would read as "179m 59s" and leave you doing the division.
//
// The smaller units keep their leading zero once a larger one is showing, so
// the line does not change width as it counts and the eye has somewhere to
// rest.
function sayTime(ms: number): string {
  const n = Number(ms);
  // NaN survives every comparison below and would reach the screen as "NaNs".
  // Nothing that calls this can produce one, which is exactly why it is worth a
  // line here rather than a promise elsewhere.
  if (!Number.isFinite(n)) return "0s";
  const total = Math.max(0, Math.ceil(n / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => (n < 10 ? "0" + n : String(n));
  if (h) return h + "h " + pad(m) + "m " + pad(s) + "s";
  if (m) return m + "m " + pad(s) + "s";
  return s + "s";
}

// A reasoning block opened and never closed: the reply was cut off inside the
// model's thinking.
//
// The names come from the same place the stripper's do, so the built-in set and
// anything in Extra thinking tag names are both covered. A second hand-written
// list here would drift, and a block the extension knows about would then read
// as finished when it was cut off inside.
function thinkOpenedNeverClosed(raw: string, cfg?: any): boolean {
  const alt = thinkTagNames(cfg).join("|");
  if (!alt) return false;
  const opener = new RegExp("<\\|?(?:" + alt + ")\\|?\\b[^>]*>", "i");
  if (!opener.test(raw)) return false;
  // The closer pattern matches an opening tag too, since the slash is optional,
  // so the first opener goes before the reply is searched for a close.
  const closer = new RegExp("<\\|?\\/?(?:" + alt + ")\\s*\\|?>", "i");
  return !closer.test(raw.replace(opener, ""));
}

// Does the reply end on something that can end a reply?
//
// Punctuation and symbols in any script count, so a scene closing on an emoji
// or on a Japanese, Chinese, Greek or Arabic full stop is an ending. What is
// left reading as unfinished is a reply stopping on a letter or a digit, which
// is what being cut off mid-word looks like.
function endsOnPunctuation(t: string): boolean {
  const cps = Array.from(t);
  let last = "";
  // Walk back past anything that is not a character in its own right. An emoji
  // written with a variation selector ends on U+FE0F, which is a combining
  // mark rather than a symbol, so a reply ending on a heart was read as having
  // no ending at all and re-rolled. The same goes for the joiners inside a
  // multi-part emoji. What is wanted is the last thing that is actually there.
  for (let i = cps.length - 1; i >= 0; i--) {
    try {
      if (/[\p{M}\p{Cf}]/u.test(cps[i])) continue;
    } catch (_) { /* no property escapes; take the last one as it is */ }
    last = cps[i];
    break;
  }
  if (!last) return false;
  try {
    // \p{P} is every punctuation mark in every script, \p{S} covers symbols and
    // emoji. A reply ending on either has an ending.
    return /[\p{P}\p{S}]/u.test(last);
  } catch (_) {
    // No Unicode property escapes on this engine, so fall back to the Latin
    // set. Narrower, but it still answers for most replies.
    return /[.!?\u2026"'*)\]}\u201D~>\-\u2014:]/.test(last);
  }
}

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
    thinkOpenedNeverClosed(raw, cfg)
  )
    return true;
  // The channel form has no closing tag of its own: the block ends at the next
  // control token, so an analysis channel with none after it was cut off.
  if (new RegExp("<\\|channel\\|>\\s*(?:" + THINK_CHANNELS + ")\\b", "i").test(raw) &&
      !/<\|(?:end|return|start)\|>/i.test(raw))
    return true;

  // The checks below count fences, backticks, asterisks and quotes. A closed
  // reasoning block sits outside the visible reply and its punctuation throws
  // those counts off, so it is removed first regardless of the refusal-side
  // thinking option, which governs refusal matching only.
  //
  // Inline markup goes with it, and for the same reason. Models colour their
  // dialogue with a raw <span style="...">, and the two quotes around that
  // style value are counted along with the two around the speech, so a reply
  // whose dialogue was genuinely cut open still came out even and was passed as
  // finished. The closing bracket of a trailing tag was also being read as end
  // punctuation, which hid the same fault from the check below.
  const shown = String(stripThinkingAlways(raw, cfg)).replace(/\s+$/, "");
  const t = stripMarkup(shown).replace(/\s+$/, "");
  if (!t) return false;

  if ((t.match(/```/g) || []).length % 2 === 1) return true; // open code fence
  if ((t.replace(/```/g, "").match(/`/g) || []).length % 2 === 1) return true; // open inline code
  if (markupLeftOpen(shown)) return true; // stopped inside a tag or a container
  // A block the model invented and never closed, <story_plan> and the like.
  // Checked on the raw reply as well as the stripped one: if the name is in
  // Extra thinking tag names the block is already gone from `shown`, and the
  // reasoning check at the top of this function is the one that catches it.
  if (customBlockLeftOpen(shown)) return true;

  // Everything below this line is about prose: dialogue left open, a sentence
  // stopping on a comma, a word cut in half. Code is none of those, and neither
  // is the inside of a widget that closed, and both are full of the same
  // characters meaning something else. One `const a = b * 2;` in a snippet
  // counted as an opened emphasis run, and one `6'2"` in a stat line counted as
  // an opened quotation mark, and each re-rolled a finished reply. The fences,
  // the backticks and the tags themselves were all counted just above, while
  // they were still here; what they hold is not counted at all.
  const prose = stripMarkup(withoutClosedContainers(shown))
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/\s+$/, "");
  // A reply that is nothing but a code block is a finished reply.
  if (!prose) return false;

  // Emphasis asterisks only. Strip markdown bullet markers ("* " at line start)
  // first, or a reply with an odd number of list bullets would read as an open
  // emphasis run and get re-rolled. Emphasis pairs (*x*, **x**) are unaffected.
  // Asterisks standing on their own, with space on both sides, are the other
  // thing that is not emphasis: a gauge a card prints every reply, "Mood: ***",
  // or a row of them used as a divider. Emphasis has to touch the words it
  // marks, so *He nods* and **bold** are left in the count where they belong.
  const emphasis = prose
    .replace(/^[ \t]*\*[ \t]+/gm, "")
    .replace(/(^|\s)\*+(?=\s|$)/gm, "$1")
    // Multiplication, and anything else written between two word characters.
    // Emphasis wraps what it marks, so it always has a boundary on one side:
    // *He nods* and **bold** keep both of theirs. "2*3 = 6" has neither, and
    // counting that one asterisk read a finished reply as an opened action.
    //
    // Written with the leading word character captured rather than as a
    // lookbehind. A lookbehind in a regex literal is a parse error on an engine
    // that does not support one, which takes the whole file with it rather than
    // this one line, and Safari had none until 16.4. The two lookbehinds
    // elsewhere in the extension are built with new RegExp inside a try for
    // exactly that reason, and fall back when it throws.
    .replace(/(\w)\*+(?=\w)/g, "$1");
  if ((emphasis.match(/\*/g) || []).length % 2 === 1) return true; // open emphasis / RP action

  // An odd number of straight quotes means dialogue was opened and never
  // closed. A measurement written with a quote is the exception: a height of
  // 6'2", or a gap 3" wide, puts one straight quote in ordinary prose and made
  // a finished reply read as cut open. Character descriptions are full of
  // heights, so this fired on replies that were plainly complete.
  //
  // The measurement is only discounted when the count is odd, which is to say
  // only when this check was about to fire. Discounting it always would break
  // the opposite case, a quotation that closes on a number: He said "42" is
  // even and correct, and taking that closing quote out would leave it odd.
  if ((prose.match(/"/g) || []).length % 2 === 1) {
    const withoutInches = prose.replace(/(\d)\s*"/g, "$1");
    if ((withoutInches.match(/"/g) || []).length % 2 === 1) return true;
  }
  if ((prose.match(/\u201C/g) || []).length !== (prose.match(/\u201D/g) || []).length)
    return true; // mismatched smart quotes
  if (/[,;]$/.test(prose)) return true; // cut mid-clause
  // A status block written as raw JSON, stopped inside itself: {"temp": 24,
  // "sky": . Counted outside code, where a brace is nearly always half of a
  // pair, and only in the one direction, since a stray closing brace says
  // nothing about the reply having stopped early.
  if ((prose.match(/\{/g) || []).length > (prose.match(/\}/g) || []).length) return true;

  if (retryOnNoPunct && !endsOnPunctuation(t) && !endsOnABlock(shown, t)) return true;

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
// It's layered, since refusal wording drifts between models and over
// time: tight regexes for the shapes that need context, a flat phrase list for
// the many near-identical templates seen across ChatGPT / Claude / Gemini, and
// two user-editable lists (add your own, or whitelist a line that keeps getting
// redone). The length gate keeps a long immersive scene that happens to contain
// one of these phrases from tripping it.
const REFUSAL_MAX_CHARS = 2000;

// Fold curly quotes/apostrophes to straight and squeeze whitespace, so a reply
// with a smart apostrophe ("I can't") matches the same as a straight one.
//
// Line breaks survive, and that matters twice. Several built-in patterns use
// [^.?!\n] to stop a match running past the end of a line, and spanIsQuoted
// walks back to the start of the line to decide whether a match is dialogue.
// Flattening every break to a space made both read a whole reply as one line:
// a pattern could match across a paragraph break, and any reply with dialogue
// somewhere above and below a line looked like that line was inside quotes.
// Runs of blank lines collapse to a single break, and horizontal runs to a
// single space, so a phrase separated by a space still matches as one.
function normalizeForMatch(text: string): string {
  return String(text == null ? "" : text)
    .replace(/[\u2018\u2019\u02BC\u2032]/g, "'")
    .replace(/[\u201C\u201D\u2033]/g, '"')
    .replace(/[^\S\n]*\n[\s]*/g, "\n")
    .replace(/[^\S\n]+/g, " ")
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

// Models write the same refusal both ways: "I'm unable to help with that" and
// "I am unable to help with that" are one phrase spelled two ways, and only
// whichever one happened to be typed into the list was ever matched. Rather
// than listing both forms of every entry and still missing some, the written-out
// form of each is generated from the contracted one. Anything with no
// contraction in it is left exactly as it was, so the list stays the size it
// looks. Generated entries go after the originals, so the reason a match
// reports is the wording that was actually listed wherever both apply.
const CONTRACTIONS: Array<[RegExp, string]> = [
  [/\bi'm\b/g, "i am"],
  [/\bcan't\b/g, "cannot"],
  [/\bwon't\b/g, "will not"],
  [/\bdon't\b/g, "do not"],
  [/\bisn't\b/g, "is not"],
  [/\bdoesn't\b/g, "does not"],
  [/\bthat's\b/g, "that is"],
];
function withLongForms(phrases: string[]): string[] {
  const out = phrases.slice();
  const seen = new Set(phrases);
  for (const p of phrases) {
    let long = p;
    for (const [re, full] of CONTRACTIONS) long = long.replace(re, full);
    if (long !== p && !seen.has(long)) {
      seen.add(long);
      out.push(long);
    }
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
  // Policy / guideline framing. The adjective slot is what "my safety
  // guidelines" and "my content policies" need: without it the pattern only
  // matched when the noun followed the possessive directly, so the two most
  // common wordings of the most common refusal in the list went unmatched.
  /\b(?:against|violates?|violating|goes? against|contrary to) (?:my|our|the|its) (?:safety |content |usage |ethical |core |operating |current )?(?:guidelines|programming|policy|policies|principles|rules|instructions)\b/i,
  // Refusal opener + a task-word a character never says (request, prompt,
  // content, message, scenario, roleplay). This meta object separates "the model
  // refusing a task" from "a character refusing a person," so declining an
  // invitation, a duel, or a marriage proposal in-scene will NOT match.
  /\bI(?: (?:can(?:no|')?t|cannot|will not|won'?t|must not|must|have to|need to|refuse to|decline to|am (?:not able|unable) to|am going to have to)|'m (?:not able|unable) to|'m going to have to)\b[^.?!\n]{0,30}?\b(?:this|that|your|the) (?:request|prompt|content|message|scenario|roleplay)\b/i,
  // Assistant-only verbs (assist / comply / fulfill) that almost never
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
  // "that's not something I can help with" and "that isn't something I can
  // help with" are the same sentence, and only the first was matched. Written
  // as three explicit alternatives rather than an optional "not", so it can
  // never match the opposite sentence ("that's something I can help with").
  /\b(?:that|this)(?:'s not|\s+is not|\s+isn'?t) something I(?: can| am able to|'m able to| could) (?:help with|assist with|create|generate|provide|write|do|engage with|write about)\b/i,
  // The plain future has to end the clause where it lands. "This isn't
  // something I'll write" is the model; "that is not something I would write in
  // a letter to him" is somebody in the scene, and the words after the verb are
  // the only thing telling them apart.
  /\b(?:that|this)(?:'s not|\s+is not|\s+isn'?t) something I(?:'ll| will) (?:write|create|generate|produce|engage with|do)\s*[.!?,;]/i,
  /\bI(?:'m| am) not going to (?:create|generate|produce|write) (?:that|this|such|content|explicit|sexual|those)\b/i,
  // Refusing a category of content rather than a request, which is how a model
  // names what it will not write when the subject is self-harm or suicide.
  /\bI(?: (?:can(?:no|')?t|cannot|will not|won'?t)|'m (?:not able|unable) to) (?:assist with|provide|create|generate|write|produce) content (?:that|which) (?:promotes|depicts|involves|encourages|facilitates|glorifies)\b/i,
  // The disclaimer a reply attaches instead of writing the scene.
  /\bgiven the (?:sensitive|serious) nature of (?:this|that|the) (?:topic|subject|request|content)\b/i,
  // Refusing a category of writing rather than a request or a subject. The
  // pattern above this one reads the word straight after the verb, so
  // "generate sexually explicit content" walked past it: the list held
  // "sexual" and the reply said "sexually". This leaves room for the adverbs
  // and adjectives that stack up in front of the noun, and the noun itself has
  // to be one a model uses about its own output.
  /\bI(?: (?:can(?:no|')?t|cannot|will not|won'?t|do not|don'?t|am (?:not able|unable) to|am not going to)|'m (?:not able|unable) to|'m not going to) (?:be able to )?(?:generate|create|write|produce|provide|depict|describe)\b[^.?!\n]{0,30}?\b(?:explicit|graphic|sexual\w*|erotic\w*|pornograph\w*|nsfw|adult|detailed|realistic|extreme|gratuitous|violent|gory) (?:content|material|descriptions?|depictions?)\b/i,
  // The counter-offer that comes with it: the same scene with the objectionable
  // part left out. Nobody in a scene talks about continuing the narrative.
  /\bcontinue the (?:narrative|story|scene|roleplay) with a focus on\b/i,
  /\bwithout (?:the )?(?:explicit|graphic) (?:anatomical|sexual|physical) (?:details?|descriptions?)\b/i,
  // The model deciding a character is too young, which is a refusal aimed at
  // your cast rather than at your request. Nobody in a scene says a character
  // reads as underage.
  /\b(?:appears? to be|reads as|is described as|seems to be|may be) (?:a |an )?(?:minor|underage|child)\b/i,
  // The same thing with the reason in front of the refusal. The refusal has to
  // follow it, because "that would be illegal, he said, and went back to
  // picking the lock" is a scene.
  /\b(?:that|this|it) would be (?:illegal|unlawful)\b[^.?!\n]{0,30}?\bso I (?:can(?:no|')?t|won'?t|will not)\b/i,
  // Declining on the grounds that it would be against the law. The writing verb
  // has to sit between the refusal and the word, so a character refusing to do
  // something illegal in a scene is left alone.
  /\bI(?: (?:can(?:no|')?t|cannot|will not|won'?t)|'m not going to)\b[^.?!\n]{0,30}?\b(?:write|create|generate|produce|depict|help with|assist with)\b[^.?!\n]{0,30}?\b(?:illegal|unlawful|against the law|violates? the law)\b/i,
  // The flat no. Some models do not soften it at all: the reply opens with the
  // word and then says what it will not do. Anchored to the start of the reply,
  // because a "No." in the middle of a scene is somebody answering a question,
  // and it still needs an object no character has. The writing verbs are kept
  // next to what they write, so "No. I can't tell you that story" stays safe
  // and "No. I won't write a scene like that" does not.
  /^no[\s.,!\u2014\u2013-]*(?:I(?:'m| am) not going to|I won'?t|I can(?:no|')?t|I cannot|I will not)\b[^.?!\n]{0,60}?(?:\b(?:content|request|prompt|roleplay|role-?play|scenario)\b|\b(?:engage|participate) with (?:this|that|it)\b|\b(?:write|generate|create|produce|depict|continue) (?:a |an |any |the |this )?(?:scene|story|passage|narrative)\b)/i,
  // The same refusal without the opening no, aimed at what it was asked to
  // write rather than at "that". A character declines to write a letter, never
  // a scene or a passage.
  /\bI(?:'m| am) not going to (?:write|create|generate|produce|describe|depict) (?:a |an |any |the )?(?:scene|story|passage|narrative|response|reply)\b/i,
  // The refusal stated as a boundary rather than as an inability: "what I won't
  // do is write that scene". It reads as the model setting terms, which is why
  // none of the patterns above see it: there is no "I can't" in the sentence at
  // all. A character can open a line the same way, so the meta object is doing
  // all the work here. "What I won't do is leave you here" has none of them.
  /\bwhat I(?: (?:won'?t|will not|can(?:no|')?t|cannot|am not going to)|'m not going to) do is\b[^.?!\n]{0,40}?\b(?:write|generate|create|produce|depict|simulate|roleplay|role-?play|content|this scene|that scene|this story)\b/i,
  // The other half of the same reply: what it will do instead. Offered in
  // help-desk register, with the thing it is offering to write named.
  /\b(?:here(?:'s| is) what I (?:can|will) do|what I can (?:do|offer) (?:instead )?is)\b[^.?!\n]{0,60}?\b(?:write|scene|story|content|roleplay|role-?play|instead)\b/i,
  // The doubled refusal: "I cannot and will not engage with content that...".
  // Every pattern above expects the verb straight after the modal, so the
  // conjunction hid the most emphatic refusal there is. A meta object is still
  // required, because "I cannot and will not marry him" is a line from a scene.
  /\bI (?:can(?:no|')?t|cannot|will not|won'?t) and (?:will not|won'?t|cannot|can(?:no|')?t) (?:engage|participate|assist|comply|help|create|generate|produce|write|continue)\b[^.?!\n]{0,40}?\b(?:content|request|prompt|scenario|roleplay|role-?play|this|that)\b/i,
  // "I'm not going to fulfil that request", "I'm not going to comply with that
  // request", "I'm not going to assist with that". The refusal opener list
  // above starts at "I can't" and never covered this shape.
  /\bI(?:'m| am) not going to (?:assist|comply|help|engage)\b[^.?!\n]{0,24}?\b(?:that|this|it|your request|the request)\b/i,
  /\bI(?:'m| am) not going to (?:fulfil|fulfill|process|answer)\b[^.?!\n]{0,24}?\b(?:that|this|your|the) (?:request|prompt|message|one)\b/i,
  // "I can't generate that", "I cannot generate that content", "I'm not able to
  // generate that". The object has to follow the verb directly. Allowing
  // anything in between caught "I can't generate enough heat with this flint",
  // because "this" turned up further along the sentence.
  /\bI(?: (?:can(?:no|')?t|cannot|will not|won'?t|am (?:not able|unable) to|do not|don'?t)|'m (?:not able|unable) to) (?:be able to )?generate (?:that|this|it|those|such|content|explicit|sexual|a response)\b/i,
  // "I don't create content like that", "I don't generate that kind of
  // content". The object is content, which is what a model calls its output.
  /\bI (?:do not|don'?t) (?:create|generate|produce|write|make) (?:(?:that|this) (?:kind|sort|type) of content|content(?: like that| of that (?:kind|sort|nature))?)\b/i,
  // "I can't process that request", "I can't provide advice on that". Process
  // and provide are both things a character can say, so a meta object is
  // required: a request, a prompt, instructions, guidance or advice.
  /\bI(?: (?:can(?:no|')?t|cannot|will not|won'?t|am (?:not able|unable) to)|'m (?:not able|unable) to) (?:process|handle)\b[^.?!\n]{0,24}?\b(?:that|this|your|the) (?:request|prompt|message|query)\b/i,
  /\bI(?: (?:can(?:no|')?t|cannot|will not|won'?t|am (?:not able|unable) to)|'m (?:not able|unable) to) provide (?:that |the |any )?(?:information|instructions?|guidance|advice|assistance|details)\b/i,
  // "I can't help with illegal activities", "I can't assist with harmful
  // requests", "I can't help with requests of this nature".
  /\bI(?: (?:can(?:no|')?t|cannot|will not|won'?t|am (?:not able|unable) to)|'m (?:not able|unable) to) (?:help|assist|engage) with\b[^.?!\n]{0,24}?(?:\b(?:illegal|harmful|dangerous|unethical|explicit|violent) (?:activit(?:y|ies)|requests?|content|material)\b|\brequests? of (?:this|that) (?:nature|kind|sort|type)\b)/i,
  // Refusal tied to specific prohibited content policies.
  /\bI(?: (?:can(?:no|')?t|cannot|will not|won'?t|am (?:not able|unable) to)|'m (?:not able|unable) to) (?:participate|engage) in (?:this |the |any )?(?:roleplay|role-?playing) or (?:create|generate|produce|write) (?:content|stories|scenes|text) depicting (?:sexual violence|non-?consensual (?:sexual )?(?:acts|situations|scenarios|content))\b/i,
  // Refusal aimed at roleplay itself. The verb list above is assistant-only
  // (assist / comply / fulfill); this covers "participate" and "engage", which a
  // character could say, so a meta object is required: roleplay, a scenario, or
  // qualified content. "I cannot participate in this duel" has none of those and
  // stays safe. Bare "content" is left out, since "he said, content
  // to wait" would otherwise match.
  /\bI(?: (?:can(?:no|')?t|cannot|will not|won'?t|do not|don'?t|am (?:not able|unable) to)|'m (?:not able|unable) to) (?:participate|engage)\b[^.?!\n]{0,40}?\b(?:role-?play(?:ing|s)?|scenarios?|(?:sexual|explicit|adult|nsfw|romantic|such|this|that) content)\b/i,
  // Fiction disclaimer. Nobody writes this inside a scene; it only appears when
  // the model is explaining that being fictional does not change its answer.
  /\beven (?:in|within) (?:a |an |the )?(?:fictional|fiction|hypothetical|imaginary|make-?believe|creative|roleplay) (?:context|setting|scenario|framing|situation)\b/i,
  // The same disclaimer said the other way round, which is the commoner half:
  // the refusal first and the fiction dismissed after it. Anchored on the word
  // fictional, because "no matter how you frame it" on its own is a line
  // somebody says in an argument.
  /\b(?:regardless of|despite|even with|no matter)\b[^.?!\n]{0,20}?\bfictional (?:framing|context|setting|scenario|premise)\b/i,
  // The same thing with the word fictional dropped, which is how both of the
  // replies that got past 4.9.0 wrote it. "Framing" as a bare noun is the
  // model's word for the wrapper around a request; nobody in a scene has one.
  /\b(?:won'?t|will not|can(?:no|')?t|cannot|do not|don'?t|not going to)\b[^.?!\n]{0,60}?\bregardless of (?:the |any |its )?framing\b/i,
  // Refusing the form rather than the subject. A character never says they do
  // not write roleplay, because a character does not know they are in one.
  /\bI (?:do not|don'?t) (?:write|do|create|generate|engage in) (?:roleplay|role-?play)\b/i,
  /\bI(?:'m| am) not going to (?:roleplay|role-?play)\b/i,
  // "That's something I won't write", which is the sentence the other way up
  // from "that's not something I'll write" and was matched by nothing. The verb
  // has to be one about producing text: "that's something I won't do" is a line
  // from a scene.
  /\b(?:that|this)(?:'s| is) something I (?:won'?t|will not|can(?:no|')?t|cannot) (?:write|create|generate|produce|engage with)(?:\s*[.!?,;]|\s+(?:regardless|even|no matter|under any|in any)\b)/i,
  // Reading your message as a request, and saying which reading it declined.
  /\bif you meant it as a request\b/i,
  // The framing dismissed as a device rather than as a word. "Calling it
  // roleplay doesn't change what it is" is the model arguing with the premise,
  // which is not a thing that happens inside a scene.
  /\b(?:framing|calling|labell?ing|describing|presenting)\b[^.?!\n]{0,60}?\bdoes(?:n'?t| not) change (?:what it is|that|anything|the)\b/i,
  /\bregardless of how\b[^.?!\n]{0,30}?\bis (?:framed|worded|presented|phrased|described)\b/i,
  // The model talking about its own limits, and the offers it closes with.
  /\bI(?:'m| am) here for a genuine conversation\b/i,
  // The redirect offer that closes most refusals. Help-desk register plus a task
  // noun, so an in-scene offer of help does not reach it.
  /\bI(?:'m| am|'d be| would be) (?:available|happy|glad) to (?:assist|help)\b[^.?!\n]{0,60}?\b(?:writing tasks?|creative writing|analysis|queries|other requests?|other topics?|other directions?|another direction|other ideas|a story|a different story|a scene|alternatives)\b/i,
];

// The subjects a model names when it refuses one.
//
// Read this for what it is: a list of words that appear in refusal messages, so
// that a refusal can be recognised as one. It is not a list of things the
// extension produces, asks for, or helps anybody get. Nothing here reaches a
// prompt. All a match does is decide that a reply was a refusal rather than
// writing, which makes the extension press regenerate, the same key you would
// press yourself. A model that means a refusal gives it again on the next
// attempt, and the attempt cap ends it: re-rolling changes what a model is
// willing to write no more than clicking twice does.
//
// Every pattern above needs a meta object, a request or a prompt or a roleplay,
// because those are words a character never uses. A refusal that names what it
// is refusing does not use them: it says it will not write content depicting a
// particular thing, and the thing is the object. Without this list those
// replies had nothing for the patterns above to hold on to.
//
// The subject on its own is never a signal. It only counts as the object of a
// refusal verb, so a scene where a character speaks about any of this, or a
// backstory that turns on it, is untouched: there is no "I will not write" in
// front of it.
const REFUSED_SUBJECT =
  "(?:" +
  // Sexual writing as a category, in the words a model names it by.
  // Written with their endings, because a refusal about a backstory says
  // "a character is raped" rather than "rape", and the bare word missed it.
  // Spelled out rather than left to \\w*, so a rapeseed field is still a field.
  "sexual violence|sexual(?:ly)? (?:assault|abus)(?:e|ed|es|ing)?|sexualized? (?:violence|minors?)|" +
  "smut|erotica|porn\\w*|nsfw|sex scenes?|sexual acts?|sexual content|explicit content|" +
  // Consent, which is refused by name as often as by act.
  "non-?consensual\\w*|non-?consent\\w*|noncon|dubcon|dubious consent|questionable consent|" +
  "unclear consent|consent (?:is|being) (?:unclear|ambiguous|absent|dubious)|coerc\\w+|" +
  // Kink, which was the largest hole: none of this was recognised at all.
  // "choking" is left out on purpose, since a scene can choke on smoke.
  "bdsm|bondage|sadomasochis\\w*|sadis\\w*|masochis\\w*|degradation|humiliation|" +
  "breath ?play|impact play|age ?play|pet ?play|kinks?|fetish\\w*|power exchange|" +
  // Family framings a model reads as incest whether or not it is.
  "incest|step-?sibling\\w*|step-?brother|step-?sister|step-?parent|step-?father|" +
  "step-?mother|step-?son|step-?daughter|" +
  // The -ing forms drop the e, so they are written out rather than built from
  // the noun. A bare "rap" is not in here: it is a knock at a door.
  // Violence, in the forms a model refuses it by. "violence" on its own is not
  // here: "I can't describe the violence" is something a character says.
  "(?:graphic|extreme|gratuitous|realistic|detailed|explicit) violence|" +
  "violence against (?:children|minors|a child|animals)|violent deaths?|" +
  "gore|gory|mutilat\\w+|dismember\\w*|body horror|animal (?:cruelty|abuse)|" +
  "murder scenes?|stalking behaviou?r|depictions? of (?:violence|harm|injury|death)|" +
  "real (?:person|people|individuals?)|" +
  "rape(?:d|s)?|raping|bestiality|csam|child (?:sexual )?abuse|minors?|underage|" +
  "self-?harm(?:ed|ing|s)?|suicid(?:e|al)|torture(?:d|s)?|torturing" +
  ")";
//
// There is one pattern here rather than two. The second read the wrapper on its
// own, "content depicting X" and "scenes involving X", with no refusal in front
// of it, and threw away "the scene involving rape was three chapters long".
// Whatever the model wraps a subject in, the refusal verb is always in front of
// it, so the verb is what this reads.
const REFUSAL_SUBJECT: RegExp[] = [
  // A refusal verb, then the thing being refused, with room for the wrapper it
  // usually arrives in: "content depicting", "scenes involving", "stories about".
  new RegExp(
    "\\bI(?: (?:can(?:no|')?t|cannot|will not|won'?t|do not|don'?t|am not going to|refuse to)|'m not going to) " +
      "(?:write|create|generate|produce|depict|portray|roleplay|role-?play|participate in|engage (?:in|with)|continue with)\\b" +
      "[^.?!\\n]{0,40}?\\b" + REFUSED_SUBJECT + "\\b",
    "i",
  ),
  // The reason named after the fact: "I can't continue as this involves ...".
  // A refusal has to come first, so an ordinary sentence about what a plot
  // involves is untouched.
  new RegExp(
    "\\bI(?: (?:can(?:no|')?t|cannot|will not|won'?t)|'m not going to)\\b[^.?!\\n]{0,30}?" +
      "\\b(?:as|because|since) (?:this|that|it) (?:involves|depicts|features|contains)\\b" +
      "[^.?!\\n]{0,20}?\\b" + REFUSED_SUBJECT + "\\b",
    "i",
  ),
];

// Tier 2: flat phrase list, matched as normalized lowercase substrings. Covers
// the many near-identical refusal templates across providers without a regex
// each. All things a character in a scene almost never says.
//
// Contracted forms only. The written-out form of each ("I am unable" for "I'm
// unable") is generated by withLongForms below, so listing both here would only
// make the list twice as long to read.
const REFUSAL_PHRASES = [
  "i can't help with that",
  "i cannot help with that",
  "i can't assist with that",
  "i cannot assist with that",
  "i'm unable to help with that",
  "i'm unable to assist with that",
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
  "i'm unable to provide that",
  "i'm unable to complete that request",
  "i can't provide instructions for that",
  "i can't provide guidance for that",
  "i can't provide advice on that",
  "i can't provide assistance with that",
  "i can't assist with harmful requests",
  "i won't be able to assist with that",
  "i'm not able to assist with that",
  "i'm not able to create that content",
  "i can't produce that content",
  "i can't write that content",
  "i can't continue with this request",
  "i can't continue with that request",
  "i must decline this request",
  "i must decline that request",
  "i have to decline that request",
  "i'll have to decline that request",
  "that request goes against",
  "goes against my safety",
  "against my content polic",
  "i'm not able to comply",
  // "this" where the list only had "that". Models pick between the two by which
  // word the sentence before it used, so every entry that reads naturally both
  // ways needs both, and half of these were only ever listed one way.
  "i'm unable to help with this",
  "i can't help with this request",
  "i can't assist with this request",
  "i'm unable to assist with this request",
  "i can't engage with this request",
  "i can't continue with this conversation",
  "i can't provide instructions for this",
  "i'm not going to engage with this prompt",
  // The same sentence without the "not", which is a different sentence and was
  // never matched by the one above it.
  "that's something i can't help with",
  "i'm not able to provide information or help with that",
  "i can't provide information that could facilitate harm",
];

// Tier 4: the model closing the scene down rather than declining outright. It
// stops writing, says it is stopping, and offers to talk about something else.
//
// This tier is the one that needs the most care, because half of these are
// things a person says. "I'll stop here" is a refusal from a model and a line
// of narration from a character, and nothing in the words themselves tells the
// two apart. Two structural rules do most of that work, and both are applied to
// this tier only:
//
//  - it has to be near the end of the reply, because a model that is bailing
//    says so last, while a character who stops walking carries on with the
//    scene afterwards;
//  - it cannot be inside quotation marks, because that is a character speaking.
//
// The patterns still lean on a meta object wherever one is available: a
// response, a conversation, a discussion, a topic, a request. Those are things
// a model has and a character in a scene does not. Bare phrases from the
// reference list that carry no object at all and read naturally in a scene
// ("let's move on", "let's stop here", "I'll leave it at that") are left out:
// they cost more in thrown-away replies than they are worth. Add them yourself
// under "Your own refusal phrases" if your model uses them.
const REFUSAL_DISENGAGE: RegExp[] = [
  // Ending the reply itself, with the thing being ended named.
  /\bI(?:'ll| will|'m going to| am going to| must| have to| need to|'ve got to) (?:end|stop|finish|cut) (?:the|this|my) (?:response|reply|conversation|discussion|exchange|answer)\b/i,
  /\bI(?:'m| am) ending (?:the|this|my) (?:response|reply|conversation|discussion|exchange|answer)\b/i,
  /\b(?:this is|that(?:'s| is)) where I(?:'ll| will) (?:stop|end (?:the|this|my) (?:response|reply|answer))\b/i,
  /\bI(?: (?:can(?:no|')?t|cannot|will not|won'?t)) continue (?:generating|writing|producing) (?:this|the)\b/i,
  // Refusing to carry on, with the thing being carried on named.
  /\bI(?: (?:can(?:no|')?t|cannot|will not|won'?t|do not|don'?t want to)) continue (?:with )?(?:this|that|the) (?:conversation|discussion|exchange|topic|subject|request|response|reply|roleplay|role-?play)\b/i,
  /\bI won'?t (?:continue|engage) with (?:this|that) (?:topic|subject|request|conversation|discussion|content)\b/i,
  /\bI(?:'m| am) not continuing (?:with )?(?:this|that) (?:request|conversation|discussion|topic|roleplay|role-?play)\b/i,
  /\bI(?:'ll| will) refrain from (?:continuing|elaborating|responding|going (?:any )?further)\b/i,
  // The redirect out. A meta object again, so "let's move on" in a scene is
  // left alone and "let's redirect the conversation" is not.
  /\blet'?s (?:redirect|change|shift|move away from) (?:the|this) (?:conversation|topic|subject|discussion|direction)\b/i,
  /\bI(?:'d| would) rather (?:discuss|talk about|move on to) something else\b/i,
  /\bI(?:'m| am) going to change the (?:subject|topic)\b/i,
  // The bare stop, which only this tier's tail and quotation rules make safe.
  /\bI(?:'m| am) going to (?:stop|pause) (?:here|there|now)\b/i,
  /\bI(?:'ll| will|'ve got to| have to| need to| must) (?:stop|pause) (?:it )?(?:here|there|now)\b/i,
  /\bI(?:'ll| will) leave (?:it|things) (?:here|there|at that)\b/i,
  // Reading your message as a question with more than one answer, then asking
  // which you meant. The reply stops being the scene and starts sorting out
  // what you were asking for, and it always ends on the question, which is what
  // makes this tier the right home for it: the tail rule and the quotation rule
  // are exactly the guards it needs. A character asking somebody to clarify is
  // in quotes, or has a dialogue tag behind it, or has the scene carrying on
  // after it.
  // The closing offer, which is how most of these replies sign off: the scene
  // is not coming back, so here is a menu instead.
  //
  // The bare form, "is there anything else I can help you with?", is left out
  // on purpose. That is the single most common line a shopkeeper, a clerk or an
  // innkeeper says, and in script-format writing it carries no quotation marks
  // for the rule above to catch. So each of these needs the model's own object
  // alongside it: a different story, another direction, something instead.
  // Anyone whose model signs off with the bare line can add it under "Your own
  // refusal phrases", where it is matched wherever it appears.
  /\bis there (?:anything|something) else (?:I can help (?:you )?with|you(?:'d| would) like)\b[^.?!\n]{0,60}?\b(?:different|instead|another|story|scene|roleplay|role-?play|writing|explore)\b/i,
  /\ba different (?:kind of |type of |sort of )?(?:story|scene|roleplay|role-?play|direction|narrative|premise)\b[^.?!\n]{0,40}?\b(?:you(?:'d| would) like|to explore|instead|we (?:could|can)|I (?:could|can))\b/i,
  /\bwould you like (?:me )?to (?:try|write|explore|take)\b[^.?!\n]{0,50}?\b(?:something (?:else|different)|a different|another (?:story|scene|direction))\b/i,
  /\bI(?:'d| would) be happy to (?:take|move|steer|explore)\b[^.?!\n]{0,50}?\b(?:different|another) (?:direction|story|scene|angle)\b/i,
  /\blet me know if there(?:'s| is) (?:anything|something) else you(?:'d| would) like\b[^.?!\n]{0,40}?\b(?:to (?:explore|write|try)|instead|different)\b/i,
  /\blet'?s focus on something (?:safer|else)\b/i,
  /\bwe can talk about something else\b/i,
  /\bif you (?:meant|mean) something else\b/i,
  /\blet me know if you(?:'d| would) like to (?:start|try|explore|write)\b[^.?!\n]{0,20}?\b(?:different|another) (?:story|scene|roleplay|role-?play|premise|direction|topic)\b/i,
  /\blet me know what you(?:'d| would) like to (?:explore|write|try|do instead)\b/i,
  /\blet me know if you(?:'d| would) like (?:me )?to proceed\b/i,
  /\bis there something (?:along those lines|like that|similar)\b[^.?!\n]{0,30}?\byou(?:'d| would) like\b/i,
  // The sentence has to stop there, or name a thing a character does not have.
  // "I'm not going to continue with this charade" is somebody in the scene.
  /\bI(?:'m| am) not going to continue with (?:this|that)(?:\s*[.!?]|\s+(?:conversation|discussion|request|roleplay|role-?play))/i,
  /\bcould you clarify\b[^.?!\n]{0,50}?\b(?:what you(?:'re| are) (?:looking for|asking|after)|what you(?:'d| would) like|what you want me to|your request)\b/i,
  /\blet me know (?:what|how) you(?:'d| would) like (?:me )?to (?:proceed|continue|take (?:this|the story|the scene))\b/i,
];
// How much text is allowed to follow a tier-4 match. Measured from the end of
// the match to the end of the reply, not from the start of the reply, so a
// short reply is judged the same way a long one is. Counting from the start
// meant a 300-character scene opening with "I'll stop here and wait for the
// rain to pass" was inside the window and was thrown away.
//
// Long enough to sit behind a closing offer ("...if you'd like, we can pick
// this up somewhere else"), short enough that a character saying the same words
// and then carrying on with the scene is left alone.
const DISENGAGE_TAIL_CHARS = 200;
// A dialogue attribution straight after a match: "I'm going to stop now, he
// said, and pulled the cart to the side of the road." That is a character
// speaking with the quotation marks left off, which plenty of writing does, and
// the quotation check alone cannot see it. Only the words a tag is built from
// are listed, so an ordinary sentence starting with "he" is unaffected.
const DIALOGUE_TAG =
  /^[,.!?"'\u2014\u2013 ]{0,4}(?:(?:the|a|an|his|her|their|my|our|your) )?(?:he|she|they|it|i|[A-Za-z][a-z]+)\s+(?:said|says|replied|replies|answered|answers|added|adds|muttered|mutters|murmured|whispered|whispers|told|asked|asks|continued|continues|snapped|snaps|sighed|sighs|declared|announced|insisted|thought|thinks|decided|decides|wrote|writes|breathed|growled|hissed|warned|promised|admitted|agreed|repeated|offered|called|calls)\b/;

// Tier 5: the model leaving the story to check on the reader. Off by default,
// and the only tier that is.
//
// The shape is not a refusal in the usual sense. Nothing is declined. The reply
// stops being the scene and becomes a message addressed to the person at the
// keyboard: what you have written is concerning, you are not alone, please talk
// to someone, and here is a list of numbers to ring. In a heavy scene, where
// the character is the one in pain and the whole point is to stay with them,
// this reads as the story being taken away.
//
// It is also the tier where a wrong answer costs the most in the other
// direction, so it is built to need agreement rather than a single phrase.
//
// Group A is the model addressing the reader from outside the fiction: it
// refers to what *you* wrote, or speaks to your circumstances rather than the
// character's. A character comforting another character does not say "what
// you've shared with me is concerning" or "if you are struggling with difficult
// thoughts"; that register belongs to a form letter.
//
// Group B is the furniture that comes with one: a number to ring, a service by
// name, a professional to be referred to.
//
// One hit decides nothing. A match needs two, and at least one of them from
// group A, so a scene where somebody mentions a helpline is left alone and so
// is a single warm line. Everything here is also subject to the quotation rule,
// which is what keeps a therapist in the scene from reading as the model.
const CRISIS_ADDRESS: RegExp[] = [
  // Referring to the message you just sent, from outside the story.
  /\bwhat you(?:'ve| have)? (?:shared|described|written|told me|been through)\b[^.?!\n]{0,60}?\b(?:concerning|serious|heavy|difficult|not your fault|takes courage)\b/i,
  /\bI(?:'m| am) (?:really |genuinely |very )?(?:concerned|worried) about (?:you|your (?:safety|wellbeing|well-being))\b/i,
  /\bI understand you(?:'re| are) reaching out\b/i,
  /\bsorry to hear (?:that )?you(?:'re| are) expressing\b/i,
  // The conditional that introduces a list, in the forms the published
  // wordings use it. The subject is not always you, the verb is not always
  // "are", and the risk is not always named the same way.
  /\bif you(?:'re| are) (?:struggling|in crisis|in distress|going through)\b[^.?!\n]{0,60}?(?:[:,]|$)/i,
  /\bif you(?:'re| are) (?:having|experiencing) (?:thoughts of|suicidal)\b/i,
  /\bif (?:you|someone|anyone)\b[^.?!\n]{0,40}?\b(?:is|are) struggling with\b/i,
  /\bif (?:you|someone|anyone)\b[^.?!\n]{0,40}?\bhas experienced\b/i,
  /\bif you(?:'re| are)? ?(?:feel|feeling|felt)? ?(?:like )?(?:you )?(?:might|may) (?:hurt|harm) yourself\b/i,
  /\bif you(?:'re| are) at risk of (?:harming|hurting|killing) (?:yourself|someone)\b/i,
  /\bif this is (?:an emergency|a mental health emergency)\b/i,
  /\bif you(?:'re| are) (?:thinking about|considering) (?:suicide|self-?harm|hurting yourself|ending your life)\b/i,
  // "If you or someone you know is in immediate danger" is the commonest form
  // of this line and the one an earlier version missed, because it only knew
  // the sentence where "you" is the subject all the way through.
  /\bif (?:you|someone|anyone)\b[^.?!\n]{0,40}?\b(?:is|are) in (?:immediate |any )?danger\b/i,
  /\bif you(?:'re| are) in (?:immediate |any )?danger\b/i,
  // The line that introduces the list. It is the single most reliable tell
  // there is, because a reply carrying a list of services always announces it
  // and nothing in a scene announces one.
  /\bhere (?:are|is) (?:some |a few |a list of |the )?(?:resources|helplines|hotlines|numbers|places|people|support options)\b/i,
  // The same announcement as a heading rather than a sentence, which is how the
  // longer replies lay out a second list under the first. A line of its own,
  // ending in a colon: a scene does not format itself.
  /^[^\S\n]*(?:international|additional|other|more|global|worldwide)\s+(?:resources|helplines|hotlines|support(?: options)?)\s*:/im,
  /\bresources that (?:may|might|can) (?:be able to )?help\b/i,
  /\b(?:reach out to|contact|call) (?:one of )?(?:these|the above|any of these) (?:resources|services|numbers|lines|organi[sz]ations)\b/i,
  // Referring you on, which is the move that belongs to the model. A character
  // says "see a doctor"; this register does not appear in a scene.
  /\bplease (?:reach out|talk|speak) to (?:a professional|a trusted|your doctor)\b/i,
  /\b(?:please|consider) (?:seek\w*|contact\w*|talk\w*|speak\w*|reach\w*)\b[^.?!\n]{0,40}?\b(?:mental health (?:professional|specialist)|crisis (?:hotline|helpline|line|counsel\w+|service|support)|professional help)\b/i,
  /\bplease (?:seek|get) (?:immediate|urgent|professional|emergency) (?:help|support|medical attention)\b/i,
  /\bplease reach out (?:for (?:help|support)|to someone who)\b/i,
  // Clinical and bureaucratic register. None of this is how one person in a
  // scene talks to another.
  /\bsupport is available\b/i,
  /\b(?:help|there) is help available\b/i,
  /\bthere (?:is|'s) help available\b/i,
  /\bis a valid response to (?:trauma|what)\b/i,
  /\bthis is a (?:very )?serious and sensitive (?:issue|topic|matter)\b/i,
  /\breaching out\b[^.?!\n]{0,30}?\b(?:takes courage|is brave|is a sign of strength)\b/i,
  /\byou deserve (?:support|help|care|safety|to be safe|to feel (?:safe|hope)|care and support)\b/i,
  // The formula with its preamble. A character says "you are not alone"; the
  // preamble in front of it is the part that belongs to a form letter.
  /\bI want you to know (?:that )?you(?:'re| are) not alone\b/i,
  /\bplease (?:know|remember) (?:that )?you(?:'re| are) not alone\b/i,
  // Saying out loud that it is leaving the story. Whatever follows it, the
  // sentence itself is the model talking about the roleplay from outside it.
  /\b(?:stepping|breaking|coming) out of (?:the )?(?:character|roleplay|role-?play|story|scene|fiction)\b/i,
  /\bI(?:'m| am) (?:going to )?(?:pause|stop|break) (?:the|this|our) (?:roleplay|role-?play|story|scene)\b[^.?!\n]{0,40}?\b(?:moment|because|to (?:say|check|ask))\b/i,
  /\bthese are real people who want to help\b/i,
  // The close that comes after the list of services.
  /\bif you(?:'d| would) like(?:,)? (?:we|I) can (?:continue|take|move|steer|shift) (?:the|this|our) (?:story|scene|roleplay|role-?play)\b/i,
  /\bhappy to (?:continue|keep going with) (?:the|this|our) (?:story|scene|roleplay|role-?play)\b[^.?!\n]{0,50}?\b(?:different|another|lighter|elsewhere|instead)\b/i,
];

// The same message's softer half, and the reason this list is separate.
//
// Every line here is one a character in a scene can say to another character,
// and in the kind of scene somebody switches this check on for, they do. So
// these can never be the signal that decides it. They only ever agree with one
// of the lines above, which is a register no scene uses.
//
// Two replies made the case for splitting them, and both are in the checks: a
// man crouching beside somebody saying she does not have to go through this
// alone and that her safety matters, and a nurse saying that if she feels
// unsafe at home there are people who can help. Two hits each, and neither is
// the model.
const CRISIS_COMFORT: RegExp[] = [
  /\byou(?:'re| are) not alone[,\s]+(?:and |in this)?[^.?!\n]{0,40}?\b(?:help|support|people|reach out|care about you)\b/i,
  /\bthere are people who (?:care about you|want to help|can help|will listen)\b/i,
  /\bthere (?:are|is) (?:people|someone|help|support)\b[^.?!\n]{0,40}?\b(?:who|that) (?:can|want to|would) (?:help|listen|support)\b/i,
  /\byou (?:do not|don'?t) have to (?:go through|face|carry|deal with|handle|do) (?:this|it|that) alone\b/i,
  /\b(?:these|those|your) feelings are (?:valid|real)\b/i,
  /\byour (?:safety|wellbeing|well-being) (?:is|comes) (?:important|first|what matters)\b/i,
  /\byour (?:feelings|wellbeing|well-being|safety|life) matters?\b/i,
  /\bI care about (?:you|your (?:safety|wellbeing|well-being))\b/i,
  /\bI want to make sure you(?:'re| are) safe\b/i,
  /\bit sounds like you(?:'re| are) going through\b/i,
  /\bif you(?:'re| are)? ?(?:feel|feeling)? ?unsafe\b/i,
  /\bif you (?:do not|don'?t) feel safe\b/i,
  /\bplease (?:reach out|talk|speak) to someone\b/i,
  /\bplease (?:take care of yourself|be gentle with yourself|stay safe|look after yourself)\b/i,
  /\bI(?:'m| am) here (?:to talk|to listen|if you (?:want|need) to talk|for you if)\b/i,
  // Wordings from replies people have actually been sent. Each one is also a
  // line one character says to another, which is exactly why they are here and
  // not in the list above: two of them are already in the checks as scenes that
  // must not be caught.
  /\bI(?:'m| am) (?:really |so |very )?glad (?:that )?you (?:told me|shared|said|reached out)\b/i,
  /\btakes (?:a lot of |real |so much )?courage to (?:say|share|admit|speak|talk)\b/i,
  /\byou(?:'re| are) carrying (?:so much|such|a lot of) (?:pain|weight|hurt)\b/i,
  /\bI(?:'m| am) not going anywhere\b/i,
  /\bI(?:'m| am) listening\b/i,
  /\bI (?:won'?t|will not) (?:judge|dismiss)\b/i,
  /\byou matter[.,!]/i,
  /\b(?:this|that|the) pain (?:does not|doesn'?t) have to be (?:carried|faced|borne) alone\b/i,
  /\bputting it into words\b/i,
  /\bif you(?:'re| are) willing to share\b/i,
];

const CRISIS_RESOURCE: RegExp[] = [
  // Services by name and by number. Written as whole words so a year or a page
  // count cannot stand in for a hotline.
  /\b(?:988|1-800-273-8255|741741|116 123)\b/,
  /\btext (?:home|hello|talk) to\b/i,
  /\b(?:suicide|crisis|emotional support) (?:and crisis )?(?:lifeline|hotline|helpline|line|text line|centre|center)\b/i,
  /\bcrisis (?:counsel|support|resources|services|team)\w*\b/i,
  // Services by name. "Lifeline" on its own is left out: a rope thrown to
  // somebody in a river is a lifeline too, and the qualified forms above and
  // below cover every real use of it.
  /\b(?:samaritans|befrienders|crisis text line|shout 85258|trevor project|trans lifeline|childline|papyrus|beyond ?blue|kids help(?: phone| line)|samhsa|rainn|hopeline|talk suicide|crisis services canada)\b/i,
  /\b(?:988|crisis|suicide prevention) lifeline\b/i,
  // Named services vary by country and by how the model abbreviates them, so
  // this reads the shape rather than trying to list them: a "national
  // something hotline", however the middle is written.
  /\bnational\b[^.?!\n]{0,30}?\b(?:hotline|helpline|lifeline|crisis line)\b/i,
  /\bnational (?:suicide prevention|domestic violence|eating disorders?|sexual assault)\b/i,
  // The same services with nothing in front of them, which is how a list
  // written as bullet points names them. What they are for, then what they are.
  /\b(?:sexual assault|domestic (?:violence|abuse)|child abuse|eating disorders?|self-?harm|substance abuse|trafficking)\b[^.?!\n]{0,20}?\b(?:hotline|helpline|lifeline|crisis line|support line)\b/i,
  /\b(?:love is respect|childhelp|the ?hotline\.org|veterans crisis)\b/i,
  /\bsomeone you trust\b/i,
  // The numbers, including the ones outside the US. Whole words, so a year or a
  // page count cannot stand in for a hotline.
  /\b(?:13 11 14|1737|116123|0800 58 58 58|1-?800-?656-?4673|0800 543 354)\b/,
  /\b(?:988lifeline|suicidepreventionlifeline|crisistextline|findahelpline|samaritans)\.(?:org|uk|com)\b/i,
  /\bhelpline\b/i,
  /\bwarm ?line\b/i,
  // Being referred on to a person whose job this is.
  /\b(?:mental health|healthcare|medical) (?:professional|provider|practitioner)s?\b/i,
  /\b(?:licensed|qualified|trained) (?:therapist|counsel\w+|professional|volunteer)s?\b/i,
  /\b(?:seek|get) (?:professional|immediate|medical) (?:help|support|attention)\b/i,
  /\breach out to (?:a|your) (?:professional|therapist|doctor|counsel\w+|crisis)\b/i,
  /\bplease reach out (?:for (?:help|support)|to someone)\b/i,
  /\b(?:talk|speak|reach out|tell|stay) (?:to |with )?someone (?:you trust|close to you)\b/i,
  /\bgo to the nearest emergency (?:department|room)\b/i,
  /\bcall your local emergency number\b/i,
  /\bcall or text 988\b/i,
  /\b(?:call|contact|dial) (?:911|999|112|emergency services|your local emergency)\b/i,
  /\bemergency (?:services|room|department)\b/i,
  /\ba trusted (?:adult|friend|person|loved one|someone)\b/i,
];

// Tier 3: soft redirect tells. These lean on a pivot ("...instead", "instead, I
// can...") so an ordinary helpful reply that just offers to help doesn't match.
const REFUSAL_SOFT: RegExp[] = [
  /\bi'?d be happy to help (?:you )?(?:with [^.?!\n]{0,40}? )?instead\b/i,
  /\binstead,? i (?:can|could|would be happy to) (?:help|offer|suggest|provide)\b/i,
  /\bi can (?:provide|offer|give you) general information instead\b/i,
  /\bplease (?:try asking something else|change the topic|rephrase your request)\b/i,
  /\bI can (?:help|suggest|provide|offer)\b[^.?!\n]{0,30}?\ba safer alternative\b/i,
  /\brather than (?:providing|writing|generating|helping with) (?:that|this|those)\b/i,
  /\binstead of (?:providing|writing|generating) (?:instructions|that|this)\b/i,
  /\bI can help you (?:find|explore)\b[^.?!\n]{0,30}?\b(?:support|resources|professional support|a safer)\b/i,
];

// Reasoning/thinking blocks are where a model weighs a refusal before deciding
// to answer. Only the final reply should be judged, so these are stripped before
// matching: a refusal that lives only in the thinking never triggers a retry when
// the visible reply is fine. Built-in tags cover the common wrappers; the user can
// add more with refusalThinkTags. Also used by the empty check to catch a
// reply that is nothing but an inline think block; the truncation and length
// checks still see the raw output.
const THINK_TAGS = ["think", "thinking", "thought", "thoughts", "reasoning", "reflection", "scratchpad", "analysis"];
// The Harmony channels that carry thinking rather than the reply. The final
// channel is the reply itself and must never be treated as thinking. One
// constant because three places ask this question, and the cut-off check used
// to ask it with a shorter list: a reply cut off inside a commentary channel
// was not recognised as cut off, while the stripper had already decided that
// channel was thinking.
const THINK_CHANNELS = "analysis|thinking|thought|reasoning|commentary";

// What a streamed token calls itself when it is the model working rather than
// the reply. A different vocabulary from the channel names above and matched
// loosely, since builds differ: "reasoning_content" and "thinking" both appear.
// A name missed here is not a cosmetic problem. The token is filed as reply
// text, so it lands in the buffer that stands in for the reply when the end
// event carries none, and the panel reports the model's working-out as the
// reply arriving.
const REASONING_TOKEN = /reason|think|thought|analysis|commentary|\bcot\b/i;

// The built-in names plus whatever is in Extra thinking tag names. One place,
// so the stripper and the cut-off check cannot end up knowing different sets.
function thinkTagNames(cfg?: any): string[] {
  const extra = String((cfg && cfg.refusalThinkTags) || "")
    .split(/\r?\n/)
    .map((s) => s.replace(/[^\w-]/g, "").toLowerCase())
    .filter(Boolean);
  return THINK_TAGS.concat(extra);
}

function stripThinking(text: string, cfg?: any): string {
  let t = String(text == null ? "" : text);
  if (cfg && cfg.refusalStripThinking === false) return t;
  const names = thinkTagNames(cfg);
  if (!names.length) return t;
  const alt = names.join("|");

  // The channel form first, because a channel block contains the other shapes
  // and removing the inside of it first would leave its wrapper behind.
  //
  // Models trained on the Harmony format write their reasoning as
  // <|channel|>analysis<|message|>...<|end|>, with the visible reply in a
  // second block whose channel is "final". Only the thinking channels go: the
  // final channel is the reply and has to survive, so this names the channels
  // it removes rather than removing every block it finds.
  t = t.replace(
    new RegExp("<\\|channel\\|>\\s*(?:" + THINK_CHANNELS + ")\\b[\\s\\S]*?(?:<\\|(?:end|return|start)\\|>|$)", "gi"),
    " ",
  );

  // What is left of the channel format once the thinking channels are gone: the
  // header that introduces the visible reply, and the control tokens around it.
  // The host normally strips these before anything is displayed, but when they
  // reach us they count towards the reply's length and sit in the middle of a
  // phrase the checks are trying to match. Only the markers go; the reply
  // between them is what we are keeping.
  t = t.replace(/<\|channel\|>\s*\w+\s*<\|message\|>/gi, " ");
  t = t.replace(/<\|(?:start|end|return|message|constrain)\|>/gi, " ");

  // <tag ...>...</tag> and [tag ...]...[/tag], same tag both ends, across newlines
  //
  // Skipped when there is no closer anywhere in the reply. These patterns walk
  // forward from every opener looking for the matching close, so a reply that
  // is nothing but openers made each of them scan the whole remainder and find
  // nothing: quadratic, and measurably so past a few thousand. One indexOf
  // makes the hopeless case linear, and the openers are handled below anyway.
  if (t.indexOf("</") >= 0)
    t = t.replace(new RegExp("<(" + alt + ")(?:\\s[^>]*)?>[\\s\\S]*?<\\/\\1\\s*>", "gi"), " ");
  if (t.indexOf("[/") >= 0)
    t = t.replace(new RegExp("\\[(" + alt + ")(?:\\s[^\\]]*)?\\][\\s\\S]*?\\[\\/\\1\\s*\\]", "gi"), " ");

  // The pipe forms. Several models wrap their reasoning in <|think|>...<|/think|>
  // or <|think>...<think|> rather than in plain angle brackets, and neither was
  // recognised, so the whole reasoning block was read as part of the reply.
  // Both closers are accepted for either opener, since builds are not
  // consistent about which way round the pipe goes.
  const CLOSE = "<\\|?\\/?(?:" + alt + ")\\|?>";
  // Same guard, same reason: with no closer, every opener would scan to the end.
  if (t.indexOf("|>") >= 0 || t.indexOf("</") >= 0)
    t = t.replace(new RegExp("<\\|(" + alt + ")\\|?>[\\s\\S]*?" + CLOSE, "gi"), " ");

  // an unclosed opener running to the end (thinking cut off before the reply)
  t = t.replace(new RegExp("<\\|(?:" + alt + ")\\|?>[\\s\\S]*$", "i"), " ");
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
// True when the match at `start` sits inside a pair of quotation marks, which
// makes it a character speaking rather than the model stepping out of the
// scene. Straight and curly quotes both count, and an apostrophe is not a
// quotation mark, so contractions are not involved.
//
// Counted by parity: how many quotation marks stand between the start of the
// line and the match. An odd number means one was opened and not yet closed, so
// the match is inside it. An even number means every quotation before it on
// that line has been closed and the match is outside them all.
//
// Parity rather than looking for the nearest mark on each side. With two
// pieces of speech on one line, as in
// `"Go on," he said. I can't help with that. "Please," she said.`, the nearest
// marks are the close of the first and the open of the second, and anything
// between them reads as dialogue when it is not.
//
// A line break ends every quotation, because a reply is checked as it was
// written and dialogue does not run across a paragraph break unclosed.
function spanIsQuoted(text: string, start: number): boolean {
  const QUOTES = "\"\u201c\u201d\u00ab\u00bb";
  let marks = 0;
  for (let i = start - 1; i >= 0; i--) {
    const c = text[i];
    if (c === "\n") break;
    if (QUOTES.indexOf(c) >= 0) marks++;
  }
  return marks % 2 === 1;
}

// The verdict and the reason for it. The reason exists so the tester in the
// settings panel can say *why* a reply was or wasn't counted, rather than
// leaving someone to guess which of four phrase lists decided it. The retry path
// itself reads the boolean, and the crisis flag when one is set.
interface RefusalVerdict {
  refusal: boolean;
  reason: string;
  // Which tier decided it, when it was one that reports under its own name.
  // Absent means the ordinary phrase and pattern lists, which is the common
  // case. Nothing behaves differently for any of them; this only decides what
  // the retry is logged and counted as.
  kind?: "crisis" | "breakoff";
}

function refusalVerdict(text: string, cfg?: any): RefusalVerdict {
  const raw = stripThinking(String(text == null ? "" : text), cfg).trim();
  // empty is handled by the empty branch
  if (!raw)
    return {
      refusal: false,
      reason: "there is no reply text left once the thinking is removed",
    };
  const norm = normalizeForMatch(raw);
  const lower = norm.toLowerCase();

  // Anything inside quotation marks is a character speaking. A model refusing
  // never puts its refusal in quotes, and a character declining almost always
  // is in them, so this is the single cheapest way to tell the two apart.
  //
  // It covers every built-in tier rather than the "I am an AI" patterns alone,
  // or '"I can\'t help with that," she said' counts as a refusal and the reply
  // is thrown away. The user can switch it off.
  //
  // lower is only index-compatible with norm while the two are the same length.
  // Lowercasing grows a handful of letters (Turkish dotted I among them), and a
  // reply containing one would otherwise have its quotation check read the
  // wrong span, so in that case the check is skipped rather than guessed at.
  const canLocate = lower.length === norm.length;
  const quotesOff = !!(cfg && cfg.refusalIgnoreQuoted === false);
  const isQuoted = (start: number, _len: number) =>
    !quotesOff && start >= 0 && spanIsQuoted(norm, start);
  // The crisis tier keeps the quotation rule whatever that switch says.
  //
  // The reason to turn the switch off is a model that wraps its own refusals in
  // quotation marks, and some do. None of them wraps a crisis-support message
  // in them, because that message is not speech: it is addressed to the reader
  // and usually has a list under it. So switching the rule off cannot help this
  // tier find anything real, and it would take the protection off exactly the
  // character the tier is most likely to mistake for the model, which is
  // somebody in the scene whose job is to say these things out loud.
  const isQuotedAlways = (start: number) => start >= 0 && spanIsQuoted(norm, start);

  // Whitelist wins: anything the user parked here is never a refusal. Asked
  // before anything else, including the crisis tier, so a phrase parked here
  // is honoured whatever the reply's length or which tier would have matched.
  for (const p of splitPhrases(cfg && cfg.refusalIgnorePhrases))
    if (lower.includes(p))
      return {
        refusal: false,
        reason: 'your "never treat these as a refusal" list matched: ' + p,
      };

  // The crisis tier runs ahead of the length gate on purpose. A refusal is
  // short, which is what that gate is built around, and one of these is the
  // opposite: several paragraphs of reassurance with a list of services under
  // it. Held to the length limit it would almost never be looked at, and the
  // limit would look like it was working.
  if (cfg && cfg.refusalCatchCrisis === true && cfg.refusalUseBuiltins !== false) {
    // A hit is a span of the reply, not a pattern that matched. Several of
    // these describe the same sentence from different angles, and one sentence
    // counted twice agrees with itself, which is the one thing asking for two
    // signals exists to prevent. A span overlapping one already counted is the
    // same signal said again, so it is skipped. The address list is read first,
    // so where an address and a comfort pattern cover the same words, it is the
    // address that stands.
    const hits: Array<{ at: number; to: number; text: string }> = [];
    const gather = (list: RegExp[]) => {
      for (const re of list) {
        const m = norm.match(re);
        if (!m || typeof m.index !== "number") continue;
        if (isQuotedAlways(m.index)) continue;
        const at = m.index;
        const to = at + m[0].length;
        if (hits.some((h) => at < h.to && h.at < to)) continue;
        hits.push({ at: at, to: to, text: m[0] });
      }
    };
    gather(CRISIS_ADDRESS);
    const addressed = hits.length;
    gather(CRISIS_COMFORT);
    gather(CRISIS_RESOURCE);
    // Two agreeing signals, and one of them has to come from the first list:
    // the register no scene uses. Comfort and services can only ever be the
    // second signal, so a lone helpline in the worldbuilding stops here, and so
    // does a whole paragraph of one character telling another that they are not
    // alone and that their safety matters.
    if (addressed >= 1 && hits.length >= 2)
      return {
        refusal: true,
        kind: "crisis",
        reason:
          'it steps out of the scene to offer support: "' +
          hits[0].text +
          '" and "' +
          hits[1].text +
          '"',
      };
  }

  const maxChars =
    cfg && Number.isFinite(cfg.refusalMaxChars)
      ? cfg.refusalMaxChars
      : REFUSAL_MAX_CHARS;
  // long immersive reply, not a refusal
  if (maxChars > 0 && raw.length > maxChars)
    return {
      refusal: false,
      reason:
        "it is " +
        raw.length +
        " characters, past the " +
        maxChars +
        "-character limit, so it counts as real writing",
    };
  // The user's own additions count as refusals. Not subject to the quotation
  // rule: someone who typed a phrase in meant it, wherever it appears.
  for (const p of splitPhrases(cfg && cfg.refusalExtraPhrases))
    if (lower.includes(p))
      return { refusal: true, reason: "one of your own phrases matched: " + p };

  // Built-in English lists, unless the user has switched them off to run pure-custom.
  if (!cfg || cfg.refusalUseBuiltins !== false) {
    for (const re of REFUSAL_STRONG.concat(REFUSAL_SUBJECT)) {
      const m = norm.match(re);
      if (!m) continue;
      if (typeof m.index === "number" && isQuoted(m.index, m[0].length)) continue;
      return { refusal: true, reason: 'a built-in pattern matched: "' + m[0] + '"' };
    }
    // Reworded first, then expanded: a rule the user wrote against the listed
    // wording has to reach the written-out form of it too.
    const phrases = withLongForms(
      applySubs(REFUSAL_PHRASES, parseSubs(cfg && cfg.refusalPhraseSubs)),
    );
    for (const p of phrases) {
      const at = lower.indexOf(p);
      if (at < 0) continue;
      if (canLocate && isQuoted(at, p.length)) continue;
      return { refusal: true, reason: 'a built-in phrase matched: "' + p + '"' };
    }
    for (const re of REFUSAL_SOFT) {
      const m = norm.match(re);
      if (!m) continue;
      if (typeof m.index === "number" && isQuoted(m.index, m[0].length)) continue;
      return {
        refusal: true,
        reason: 'a built-in redirect tell matched: "' + m[0] + '"',
      };
    }
    // The model closing the scene down. Only counted in the tail of the reply,
    // for the reasons set out above REFUSAL_DISENGAGE.
    if (!cfg || cfg.refusalCatchDisengage !== false) {
      for (const re of REFUSAL_DISENGAGE) {
        // Every occurrence, not just the first. The same words can appear in
        // dialogue earlier in the scene, and stopping at that one would mean
        // never looking at the one that ends the reply.
        const scan = new RegExp(re.source, re.flags.replace("g", "") + "g");
        let m: RegExpExecArray | null;
        while ((m = scan.exec(norm)) !== null) {
          const end = m.index + m[0].length;
          if (scan.lastIndex === m.index) scan.lastIndex++; // never on a zero-width match
          if (norm.length - end > DISENGAGE_TAIL_CHARS) continue;
          if (isQuoted(m.index, m[0].length)) continue;
          // Kept whatever the quotation switch says, for the same reason as
          // above: this rule is about an attribution, not about quotation
          // marks, and no model writes "he said" after its own refusal.
          if (DIALOGUE_TAG.test(norm.slice(end, end + 48))) continue;
          return {
            refusal: true,
            kind: "breakoff",
            reason: 'the reply ends by breaking off: "' + m[0] + '"',
          };
        }
      }
    }
    return {
      refusal: false,
      reason: "nothing in the built-in lists or your own phrases matched",
    };
  }
  return {
    refusal: false,
    reason:
      "the built-in lists are off and none of your own phrases matched",
  };
}

// Some providers deliver a refusal as an error string (e.g. a prohibited-content
// result) rather than as reply text. This matches that, tuned for short error
// messages, and stay narrow to content-moderation wording so it never
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

// ---- keeping text readable on a themed surface ----
// Every colour in this UI comes from the user's Lumiverse theme, and a theme is
// free to set its accent to whatever it likes. On a theme whose accent is close
// to its text colour, a filled button painted accent-on-text came out as a blank
// rectangle: the label was there, in the same colour as the button under it.
// Guessing at extra theme variables would only move the problem, since a
// variable a theme does not define falls back to a colour that may clash just as
// badly. So this measures what the browser actually painted and steps in only
// when the two colours are genuinely too close to read.

type Rgba = [number, number, number, number];

// getComputedStyle hands colours back as rgb()/rgba(), so that is all this needs
// to read. Anything else is reported as unknown and the caller leaves it alone.
function parseColor(value: any): Rgba | null {
  const m = String(value == null ? "" : value)
    .trim()
    .match(
      /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+%?))?\s*\)$/i,
    );
  if (!m) return null;
  let a = 1;
  if (m[4] != null) {
    a =
      m[4].indexOf("%") >= 0
        ? parseFloat(m[4]) / 100
        : parseFloat(m[4]);
    if (!Number.isFinite(a)) a = 1;
  }
  const c: Rgba = [Number(m[1]), Number(m[2]), Number(m[3]), Math.max(0, Math.min(1, a))];
  return c.slice(0, 3).some((n) => !Number.isFinite(n)) ? null : c;
}

// Lay a partly transparent colour over an opaque one.
function blendColor(top: Rgba, under: Rgba): Rgba {
  const a = top[3];
  return [
    top[0] * a + under[0] * (1 - a),
    top[1] * a + under[1] * (1 - a),
    top[2] * a + under[2] * (1 - a),
    1,
  ];
}

function relLuminance(c: Rgba): number {
  const chan = (v: number) => {
    const x = Math.max(0, Math.min(1, v / 255));
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * chan(c[0]) + 0.7152 * chan(c[1]) + 0.0722 * chan(c[2]);
}

// The WCAG contrast ratio, 1 (identical) to 21 (black on white).
function contrastRatio(a: Rgba, b: Rgba): number {
  const la = relLuminance(a);
  const lb = relLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// What is actually behind an element: its own background when that is opaque,
// otherwise the ancestors' backgrounds composited underneath it.
const PAGE_FALLBACK: Rgba = [20, 16, 30, 1]; // Lumiverse ships dark; last resort only
// What a surface actually paints, rather than only what its background-color
// says. Every floating panel here builds an opaque surface by painting a solid
// colour and laying the theme's translucent tint over it as a gradient, because
// the tint alone is 90% opaque and lets the text behind read through.
// getComputedStyle reports the colour underneath and says nothing about the
// gradient, so on a theme that leaves --lumiverse-card-bg-solid unset the
// popover measured as the dark fallback while painting near-white, and its text
// was helpfully repainted white to suit. It vanished.
function paintedBg(el: any): Rgba | null {
  let base: Rgba | null = null;
  let img = "";
  try {
    const cs = getComputedStyle(el);
    base = parseColor(cs.backgroundColor);
    img = String(cs.backgroundImage || "");
  } catch (_) {
    return base;
  }
  if (img.indexOf("gradient") < 0) return base;
  // Only the first stop is read. These gradients are one colour repeated, used
  // to lay a flat tint rather than to shade anything.
  const stop = img.match(/rgba?\([^)]*\)|#[0-9a-fA-F]{3,8}/);
  const over = stop ? parseColor(stop[0]) : null;
  if (!over) return base;
  if (!base || base[3] <= 0) return over;
  const mixed = blendColor(over, base);
  // An opaque layer under a translucent one is still opaque. A translucent one
  // under it is not, so the walk upward has to continue.
  mixed[3] = base[3] >= 0.999 ? 1 : Math.min(1, base[3] + over[3] * (1 - base[3]));
  return mixed;
}

function backdropOf(el: any): Rgba {
  const layers: Rgba[] = [];
  let p: any = el;
  let hops = 0;
  while (p && hops < 24) {
    let c: Rgba | null = null;
    try {
      c = paintedBg(p);
    } catch (_) {}
    if (c && c[3] > 0) {
      layers.push(c);
      if (c[3] >= 0.999) break; // nothing below this can show through
    }
    p = p.parentElement;
    hops++;
  }
  let base: Rgba = PAGE_FALLBACK;
  for (let i = layers.length - 1; i >= 0; i--) base = blendColor(layers[i], base);
  return base;
}

// Below this ratio a label is hard to pick out; at 1 it is invisible.
const MIN_CONTRAST = 3.2;
const NEAR_WHITE = "#ffffff";
const NEAR_BLACK = "#14121a";

// Repaint an element's text only if it fails the contrast floor against what is
// behind it, so a theme that already reads well keeps its own colours exactly.
function fixContrast(el: any, min?: number) {
  try {
    if (!el || typeof getComputedStyle !== "function") return;
    const want = typeof min === "number" ? min : MIN_CONTRAST;
    const fg = parseColor(getComputedStyle(el).color);
    if (!fg) return;
    const bg = backdropOf(el);
    if (contrastRatio(blendColor(fg, bg), bg) >= want) return;
    const light: Rgba = [255, 255, 255, 1];
    const dark: Rgba = [20, 18, 26, 1];
    el.style.color =
      contrastRatio(light, bg) >= contrastRatio(dark, bg) ? NEAR_WHITE : NEAR_BLACK;
  } catch (_) {}
}

// Colours only resolve once the element is in the page and laid out, so the
// check waits a frame rather than running against a half-built tree.
function afterPaint(fn: () => void) {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(fn);
  else fn();
}

// Checkboxes and number spinners are drawn by the browser, not by us. The
// browser picks their colours from the page's colour scheme rather than from
// the theme, and with no scheme set it assumes light, which is why an unchecked
// box came out as a white block sitting on a dark panel. This is the same fault
// that made the search field's clear button white. Rather than assume dark,
// measure what the panel is actually sitting on and say which way round it is,
// so a light theme still gets light controls.
function matchColorScheme(el: any) {
  afterPaint(() => {
    try {
      if (!el || !el.style) return;
      const bg = backdropOf(el);
      if (!bg) return;
      el.style.colorScheme = relLuminance(bg) < 0.5 ? "dark" : "light";
    } catch (_) {}
  });
}

// A filled button whose fill is close to the surface behind it reads as plain
// text, however readable its label is. Repainting the label fixed half of that
// and left the other half: on a theme whose accent is near the panel colour,
// Save was legible and had no edge, so nothing said it was a button.
//
// The threshold is low. Plenty of themes use a quiet accent and still read
// fine; this only catches a fill that has all but vanished. The border is
// already there at one pixel and transparent, so colouring it costs no layout.
const MIN_EDGE = 1.45;

function fixEdge(el: any, min?: number) {
  try {
    if (!el || typeof getComputedStyle !== "function") return;
    const fill = paintedBg(el);
    if (!fill) return;
    const behind = backdropOf(el.parentElement || el);
    if (contrastRatio(blendColor(fill, behind), behind) >= (typeof min === "number" ? min : MIN_EDGE))
      return;
    const light: Rgba = [255, 255, 255, 1];
    const dark: Rgba = [20, 18, 26, 1];
    // Judged against the surface behind the button, since that is what the
    // edge has to separate it from.
    el.style.borderColor =
      contrastRatio(light, behind) >= contrastRatio(dark, behind) ? NEAR_WHITE : NEAR_BLACK;
  } catch (_) {}
}

function ensureEdge(el: any, min?: number) {
  afterPaint(() => fixEdge(el, min));
}

function ensureReadable(el: any, min?: number) {
  afterPaint(() => fixContrast(el, min));
}

// True when the element paints text of its own, rather than only holding other
// elements that do. Form controls carry their value instead of a text child.
function paintsText(el: any): boolean {
  const tag = String((el && el.tagName) || "").toUpperCase();
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || tag === "BUTTON")
    return true;
  const kids = (el && el.childNodes) || [];
  for (let i = 0; i < kids.length; i++) {
    const n: any = kids[i];
    if (n && n.nodeType === 3 && String(n.nodeValue || "").trim()) return true;
  }
  // An element with a colour of its own but no text yet is a status line
  // waiting for something to say. The sweep runs once, while they are all still
  // empty, so skipping them means they are never checked at all. Their colour
  // does not change when the text arrives, so checking now gives the same
  // answer, earlier.
  try {
    if (el && el.style && String(el.style.color || "")) return true;
  } catch (_) {}
  return false;
}

// One sweep over everything a panel painted, once per build. Secondary text
// (hints, section headers) is meant to sit quieter than the main text, so it is
// held to a lower floor and only rescued when it has all but disappeared.
function ensureReadableTree(root: any, min?: number) {
  afterPaint(() => {
    try {
      if (!root || !root.querySelectorAll) return;
      const all: any[] = [root].concat(
        Array.prototype.slice.call(root.querySelectorAll("*")),
      );
      for (const el of all) if (paintsText(el)) fixContrast(el, min);
    } catch (_) {}
  });
}

// Long enough that a normal tap never reaches it, short enough that holding
// the button does not feel broken.
const HOLD_MS = 500;

// The extension's mark: a reply, with the retry arrow sweeping over it.
//
// It was a tumbling die, because Lumiverse calls a fresh attempt a reroll. A
// die on its own says dice, though, and dice say tabletop, which is not what
// this is. What the extension actually acts on is a reply: it reads one,
// decides it failed, and asks for another. So the reply is the shape, and the
// arrow is what is being done to it.
//
// The arrow is drawn a little thinner than the bubble so the two read apart at
// the size the Extras menu draws them, which is 16 pixels and the size that
// decides whether any of this works. Nothing reaches the edge of the 24 box
// once its stroke is on: an arrowhead clipped by the viewBox reads as a shorter
// arrow rather than as a mistake.
//
// Strokes are currentColor so the mark follows the theme, and so fixContrast
// can repaint it by setting colour on the element around it.
const MARK_BODY =
  '<path stroke-width="1.6" d="M 2.74 7.48 A 10.3 10.3 0 0 1 21.8 8.82"/>' +
  '<polyline stroke-width="1.6" points="19.69 7.19 21.8 8.82 22.54 6.26"/>' +
  '<rect stroke-width="2" x="6" y="8.3" width="12" height="8.6" rx="2.8"/>' +
  '<path stroke-width="2" d="M 8.6 16.9 L 7.9 19.6 L 11.6 16.9"/>';
const MARK_SLASH = '<line stroke-width="2" x1="3.5" y1="20.5" x2="20.5" y2="3.5"/>';

// size is passed only for the float widget, which owns its own element. The
// Extras menu sizes the icon it is handed.
function markSvg(off?: boolean, size?: number): string {
  return (
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"' +
    ' stroke-linecap="round" stroke-linejoin="round"' +
    (size ? ' width="' + size + '" height="' + size + '"' : "") +
    ">" +
    MARK_BODY +
    (off ? MARK_SLASH : "") +
    "</svg>"
  );
}

// These buttons appear in the chat input's Extras menu when the floating button
// is off, and in the floating button's own menu when it is on. The wording is
// written once, here, because the same button has to say the same thing in both
// places. Different wording would look like a different button.
const SWAP_ONE_LABEL = "Swap words in the last reply";
const SWAP_ALL_LABEL = "Swap words in every reply";
const OPEN_PANEL_LABEL = "Open the Auto Retry panel";

// Every tick box in the panel, at one size. The settings rows have always set
// this; the reset picker and the import and export lists set nothing and got
// the browser default of 13px, which is a small thing to hit with a thumb and
// smaller than the same control one screen over. The reset picker is the worst
// place for that, since a tick there can delete saved presets.
const CHECKBOX_STYLE =
  "flex:none;width:20px;height:20px;accent-color:var(--lumiverse-primary,rgba(147,112,219,.9));";

function iconSvg(body: string): string {
  return (
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"' +
    ' stroke-linecap="round" stroke-linejoin="round">' +
    body +
    "</svg>"
  );
}

// Two arrows pointing opposite ways: one word replaced by another. The
// whole-chat icon is the same drawing with a line down the middle. That line is
// the only difference between them, and it has to work at 16 pixels, which is
// the size the Extras menu draws these at.
const SWAP_ARROWS =
  '<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/>' +
  '<polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>';
const SWAP_ONE_ICON = iconSvg(SWAP_ARROWS);
const SWAP_ALL_ICON = iconSvg(SWAP_ARROWS + '<line x1="12" y1="7" x2="12" y2="17"/>');
const OPEN_PANEL_ICON = iconSvg(
  '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="15" y1="3" x2="15" y2="21"/>',
);

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
          syncFloat();
          // Settings arriving from the account can switch any of the Extras
          // entries on or off, and this was the one path that did not re-read
          // them. It got away with it because syncFloat happens to run the
          // same sync on its way past, which is not a thing to rely on.
          syncInputBarActions();
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
  // Told outright that no chat is open, as opposed to not having been told
  // anything yet. Both leave lastChatId null and the per-chat switch greyed
  // out, and they are not the same thing to read: one is the home screen, the
  // other is the extension waiting to be told where it is. Only something that
  // could actually look sets this.
  let noChatOpen = false;
  // Always read through here, never the flag on its own. The chat id is set in
  // five places, and a flag that had to be cleared in all five would miss one
  // eventually. Pairing the two at the point of reading means "no chat is open"
  // cannot be believed while a chat is known, whoever forgot to clear it.
  const outsideAnyChat = (): boolean => noChatOpen && lastChatId == null;
  let lastMessageId: any = null;
  // Every Extras button that can come and go, keyed by name. Each one is stored
  // as its registration plus the function that removes its click handler.
  //
  // One map instead of two variables per button, so adding, removing and
  // tearing one down is the same code for all of them. When each button had its
  // own copy of that code, the swap-whole-chat one was left out of teardown and
  // a duplicate piled up on every reload.
  //
  // The on/off button is not in here. Its label changes with the state, and the
  // host has no way to relabel a button once it is registered, so it has to be
  // registered again to change. syncToggleAction handles that one.
  const barEntries: Record<string, { action: any; off: any }> = {};
  let toggleAction: any = null;
  let toggleActionOff: any = null;
  // True from the moment teardown starts. Checked before anything registers an
  // Extras button.
  //
  // Teardown removes the buttons and then hides the floating button. Hiding
  // that button puts back whatever was hidden for it, so without this flag
  // every button was registered again on the way out and left behind. The next
  // load then had two of each.
  let tornDown = false;
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
  // Swap requests that have gone out and have not been picked up yet.
  //
  // Somebody pressed a button to start a swap, so nothing happening is the one
  // outcome they cannot make sense of: it looks exactly like the extension
  // being broken.
  //
  // The backend answers twice. Once straight away to say it has the request,
  // and again when the work is finished. This keeps a timer per request against
  // the first answer, so a backend that is not running, or a message that never
  // arrives, gets a message instead of silence.
  //
  // The timer waits for the first answer rather than the finished work, because
  // swapping a whole chat can take a while and a timer on the finish would
  // report a slow job as a failure.
  const swapWaits = new Map<string, any>();
  // Read from the setup argument rather than from the settings, because it is
  // not a choice anybody should have to make: it is here so the browser checks
  // can drive this path without sitting through the real wait.
  const SWAP_ACK_MS = Number(opts && opts.swapAckMs) > 0 ? Number(opts.swapAckMs) : 8000;

  function clearSwapWait(requestId: any) {
    const id = String(requestId == null ? "" : requestId);
    const timer = swapWaits.get(id);
    if (timer === undefined) return;
    swapWaits.delete(id);
    try { clearTimeout(timer); } catch (_) {}
  }

  // Sends one swap request and starts the timer above. Nothing is returned:
  // what happens next arrives as a message from the backend, or as the timeout
  // saying nothing did.
  function sendSwapRequest(payload: any) {
    // A swap waits on the answer to "which chat is open", and teardown releases
    // that wait rather than leaving it hanging. Without this flag the awaiting
    // code carries on and edits a reply for an extension that has stopped.
    if (tornDown) return;
    const requestId = String(payload.requestId);
    try {
      (ctx as any).sendToBackend(payload);
    } catch (e) {
      // The host would not send the message. Saying nothing here is what made a
      // pressed button look broken.
      log("could not send the swap request", e);
      showToast("Could not send that to the word swapper. Reload the page and try again.");
      return;
    }
    swapWaits.set(
      requestId,
      setTimeout(() => {
        swapWaits.delete(requestId);
        log("no answer to the swap request");
        showToast("No answer from the word swapper. Reload the page and try again.");
      }, SWAP_ACK_MS),
    );
  }

  // Which chat a swap should act on, asked fresh at the moment the button is
  // pressed. Returns null when there is no chat to act on, and the caller has
  // already said so by then.
  //
  // These buttons live in the floating button's menu, which is on screen on the
  // home screen and everywhere else, so they can be pressed with no chat open
  // at all. The id held from the last chat is no answer: some builds never say
  // when you leave one, so it is still the chat you walked away from, and
  // swapping there edits saved replies you are not looking at and cannot undo.
  async function chatForSwap(): Promise<string | null> {
    const open = await whichChatIsOpen();
    // The backend looked and there is no chat. This is the home screen.
    if (open.answered && open.resolved && !open.chatId) {
      showToast("No chat is open. Open a chat and try again.");
      return null;
    }
    // It looked and named one. Fresher than anything held here.
    if (open.answered && open.resolved && open.chatId) return open.chatId;
    // It could not look, which is what a build without the chats permission
    // does. Fall back to the last chat seen, which is all there has ever been.
    if (lastChatId != null && lastChatId !== "") return String(lastChatId);
    showToast("No chat is open. Open a chat and try again.");
    return null;
  }

  async function applyReplaceNow() {
    if (!ctx || typeof (ctx as any).sendToBackend !== "function") {
      showToast("Word swaps need this extension's backend, which your Lumiverse has not loaded.");
      return;
    }
    // Before the confirmation, not after: asking whether to swap every reply in
    // a chat that is not open is a question with no right answer.
    const chatId = await chatForSwap();
    if (chatId == null) return;
    if (cfg.confirmBeforeEdit) {
      if (!(await confirmEdit("Apply your word swaps to the latest reply?"))) return;
    }
    sendSwapRequest({ type: "apply_replace_now", chatId: chatId, messageId: lastMessageId, requestId: "ar-rep-" + Date.now() });
  }
  // Swap every generated reply in the current chat, once, on request.
  async function applyReplaceAllNow() {
    if (!ctx || typeof (ctx as any).sendToBackend !== "function") {
      showToast("Word swaps need this extension's backend, which your Lumiverse has not loaded.");
      return;
    }
    const chatId = await chatForSwap();
    if (chatId == null) return;
    if (cfg.confirmBeforeEdit) {
      if (!(await confirmEdit("Apply your word swaps to every reply in this chat?"))) return;
    }
    sendSwapRequest({ type: "apply_replace_now", chatId: chatId, wholeChat: true, requestId: "ar-rep-all-" + Date.now() });
  }
  // The Extras-menu on/off entry. Its label and icon carry the current state,
  // and the host offers no way to relabel an action once it is registered, so a
  // state change registers it again rather than editing it in place.
  const TOGGLE_ICON_ON = markSvg(false);
  const TOGGLE_ICON_OFF = markSvg(true);
  // The state the registered entry was last labelled for, so it is only rebuilt
  // when the label would actually change. Both switches, because the entry says
  // whether Auto Retry is on and the answer in a chat you switched off is no.
  // Keyed on the pair rather than the master alone, or flipping the per-chat one
  // would leave the label it wrote behind: same master state, nothing rebuilt.
  let toggleActionState: string | null = null;

  function dropToggleAction() {
    if (!toggleAction) return;
    try { toggleActionOff && toggleActionOff(); } catch (_) {}
    try { toggleAction.destroy(); } catch (_) {}
    toggleAction = null;
    toggleActionOff = null;
    toggleActionState = null;
  }

  function syncToggleAction() {
    if (tornDown) return;
    try {
      const canReg = !!(ctx && (ctx as any).ui && typeof (ctx as any).ui.registerInputBarAction === "function");
      const on = cfg.enabled !== false;
      // Off in the chat you are in is off, whatever the master switch says, and
      // the entry showed "on" through it until now. The float button has said
      // both since it was built and this is the same sentence.
      const hereOff = on && chatIsOff(lastChatId);
      // Hidden while the floating button is on, and not moved into that
      // button's menu either. The floating button is already this same on/off
      // switch: one tap, and its icon shows the state. A menu entry for it
      // would be a third way to reach one switch.
      //
      // This checks the button alone, not whether the host can draw a menu,
      // because it is the button that replaces this, not the menu.
      if (!cfg.showExtrasToggle || !canReg || floatIsUp()) {
        dropToggleAction();
        return;
      }
      const want = on ? (hereOff ? "here-off" : "on") : "off";
      if (toggleAction && toggleActionState === want) return;
      dropToggleAction();
      toggleAction = (ctx as any).ui.registerInputBarAction({
        id: "auto-retry-toggle",
        // Tapping is the master switch wherever it is tapped from, so a label
        // saying only "turn it off" in a chat that is already off would be
        // offering the wrong switch under the right words.
        label: hereOff
          ? "Auto Retry is on, but off in this chat. Turn it off everywhere"
          : on
            ? "Auto Retry is on, turn it off"
            : "Auto Retry is off, turn it on",
        iconSvg: on && !hereOff ? TOGGLE_ICON_ON : TOGGLE_ICON_OFF,
      });
      toggleActionState = want;
      toggleActionOff = toggleAction.onClick(() => {
        // Flipping the switch relabels this same entry, which means removing
        // it and registering it again. Doing that inside its own click handler
        // would remove the entry while the host is still dispatching that
        // click, so it waits for the handler to return first.
        setTimeout(() => toggleEnabled(), 0);
      });
    } catch (_) {}
  }

  function dropBarEntry(key: string) {
    const held = barEntries[key];
    if (!held) return;
    // Removed from the map first. If destroy throws, the entry is already gone
    // from the map, so later syncs do not treat a dead button as a live one.
    delete barEntries[key];
    try { held.off && held.off(); } catch (_) {}
    try { held.action && held.action.destroy(); } catch (_) {}
  }

  // Adds or removes one button to match want. Every button here has a fixed
  // label and icon, so none of them ever needs rebuilding: it is either there
  // or it is not.
  function syncBarEntry(key: string, want: boolean, spec: any, onClick: () => void) {
    if (!want) {
      dropBarEntry(key);
      return;
    }
    if (barEntries[key]) return;
    const action = (ctx as any).ui.registerInputBarAction(spec);
    barEntries[key] = { action: action, off: action.onClick(onClick) };
  }

  function dropBarEntries() {
    for (const key of Object.keys(barEntries)) dropBarEntry(key);
  }

  // Add or remove the Extras entries to match their toggles and what else is on
  // screen. Called on load, whenever settings are saved, and whenever the
  // floating button or the drawer tab comes or goes.
  function syncInputBarActions() {
    if (tornDown) return;
    syncToggleAction();
    try {
      const canReg = !!(ctx && (ctx as any).ui && typeof (ctx as any).ui.registerInputBarAction === "function");
      // Each of these is in one place at a time. When the floating button is on
      // screen, its menu holds them. The Extras menu holds them only when there
      // is no floating button to.
      //
      // Two ways to reach the same thing is one more than anybody needs, and
      // clutters a menu that was opened for something else. With the floating
      // button hidden, or refused because ui_panels was not granted, the Extras
      // menu is the only way to reach these on a phone, so they come back.
      const inExtras = canReg && !floatCarriesEntries();
      syncBarEntry(
        "replaceNow",
        inExtras && !!cfg.showReplaceButton,
        { id: "auto-retry-replace-now", label: SWAP_ONE_LABEL, iconSvg: SWAP_ONE_ICON },
        applyReplaceNow,
      );
      syncBarEntry(
        "replaceAll",
        inExtras && !!cfg.showSwapAllButton,
        { id: "auto-retry-replace-all", label: SWAP_ALL_LABEL, iconSvg: SWAP_ALL_ICON },
        applyReplaceAllNow,
      );
      // Only while the panel is set to live in the drawer and the host gave us
      // a tab to bring forward. With the panel floating it is already on
      // screen, and an entry that opens what you can see is noise. Registering
      // the tab already puts it in the Ctrl+K palette for free, which covers a
      // keyboard without any code here.
      syncBarEntry(
        "openPanel",
        inExtras && canOpenPanel(),
        { id: "auto-retry-open-panel", label: OPEN_PANEL_LABEL, iconSvg: OPEN_PANEL_ICON },
        openDrawerPanel,
      );
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
  // The last prompt the backend saw on its way to the model, and which of the
  // panel's two views is showing. Held in memory only, thrown away on teardown
  // and with the tab, the same as the log beside it.
  let lastPrompt: any = null;
  // Set when a generation finishes while the Prompt view is open and no prompt
  // has ever arrived for it. Capturing runs off the interceptor, which is a
  // privileged permission an admin has to approve, and registering without it
  // is a no-op that raises nothing. Without this the view says "send a reply"
  // to somebody who has sent several, which reads as a fault in their chat
  // rather than a permission that was never granted.
  let promptNeverArrived = false;
  // What the host has actually granted, as the backend sees it. Held rather
  // than guessed at: a missing permission raises nothing, so without asking,
  // the only evidence is a feature quietly doing nothing.
  let permGranted: Record<string, boolean | null> = {};
  let permList: Array<{ name: string; costs: string }> = [];
  let permPaint: (() => void) | null = null;
  // Permissions whose note has been put away. Some of these are meant to be
  // refused: somebody who does not want their prompt read declines the
  // interceptor on purpose, and a panel telling them so on every visit is
  // nagging about a decision they already made.
  //
  // Held in memory and nowhere else, so a reload brings them back. Written down
  // it would be a note somebody dismissed once and could never see again, which
  // is a worse failure than the nagging: a permission going missing months
  // later for a reason nobody chose would be silent.
  //
  // By name rather than as one flag, so putting away the note about a
  // permission you chose to refuse does not also hide the next one.
  const permHidden = new Set<string>();
  const permIsHidden = (name: string): boolean => permHidden.has(name);
  // true, false, or null for a host too old to say. null is not a denial and is
  // never shown as one.
  const permIs = (name: string): boolean | null =>
    Object.prototype.hasOwnProperty.call(permGranted, name) ? permGranted[name] : null;
  function askForPermissions() {
    try {
      if (ctx && typeof (ctx as any).sendToBackend === "function")
        (ctx as any).sendToBackend({ type: "get_permissions", requestId: "ar-perm-" + Date.now() });
    } catch (_) {}
  }
  // ---- where things were left ----
  //
  // The floating button and the on-screen panel both went back to their default
  // corner on every reload, which means on every update. Dragging the panel
  // somewhere it does not cover your chat, and sizing it to what you want to
  // read, is work, and having to redo it each time is the sort of thing that
  // makes a panel not worth opening.
  //
  // Kept in the browser rather than in the settings, for the same reason the
  // list of switched-off chats is: a position is a property of the screen you
  // are sitting at, not of your account. Copying it to a phone would put the
  // panel somewhere a phone has no room for, and it does not belong in an
  // export somebody might share.
  const LAYOUT_KEY = "lv-auto-retry:layout:v1";
  type Layout = {
    float?: { x: number; y: number };
    panel?: { x: number; y: number; w: number; h: number };
    tab?: string;
    promptView?: string;
  };
  let layout: Layout = {};
  // Named for what it does rather than what it holds, since there is a "num"
  // elsewhere in here that is a span on the screen.
  const asNumber = (v: any): number | null => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  try {
    if (typeof localStorage !== "undefined") {
      const raw = JSON.parse(localStorage.getItem(LAYOUT_KEY) || "{}");
      if (raw && typeof raw === "object") {
        // Read a field at a time rather than trusting the shape. This is the one
        // store a person can edit by hand, and half of it becoming NaN would put
        // the panel somewhere with no way back to it.
        const f = raw.float;
        if (f && asNumber(f.x) !== null && asNumber(f.y) !== null)
          layout.float = { x: asNumber(f.x)!, y: asNumber(f.y)! };
        const p = raw.panel;
        if (
          p && asNumber(p.x) !== null && asNumber(p.y) !== null &&
          asNumber(p.w) !== null && asNumber(p.h) !== null
        )
          layout.panel = {
            x: asNumber(p.x)!, y: asNumber(p.y)!,
            w: asNumber(p.w)!, h: asNumber(p.h)!,
          };
        if (raw.tab === "log" || raw.tab === "prompt" || raw.tab === "stats")
          layout.tab = raw.tab;
        if (raw.promptView === "raw" || raw.promptView === "rendered")
          layout.promptView = raw.promptView;
      }
    }
  } catch (_) { /* no storage, or nonsense in it: the defaults are fine */ }
  function saveLayout() {
    try {
      if (typeof localStorage !== "undefined")
        localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
    } catch (_) { /* storage full or blocked: the position is not worth an error */ }
  }

  let liveTab: "log" | "prompt" | "stats" =
    (layout.tab as "log" | "prompt" | "stats") || "log";
  // How the Prompt tab draws the prompt. Rendered is the panel as it has always
  // looked: a row per message, its role, its size, and whether it came from the
  // chat or was wrapped around it. Raw is the same prompt with all of that taken
  // off, as the data the model was actually handed, which is the form to read
  // when the question is about structure rather than wording, and the form to
  // paste somewhere else. Rendered is the default, since it is the readable one.
  let promptView: "raw" | "rendered" =
    (layout.promptView as "raw" | "rendered") || "rendered";
  let paintTabs: (() => void) | null = null;
  let focusTab: ((id: string) => void) | null = null;
  // Who each chat is with, once the backend has resolved it. A name is worth
  // more than an id on a row that asks you to switch something off: "this chat"
  // is right but says nothing, and on a phone you may not have the header in
  // view. Empty until the chats and characters permissions are both granted.
  const chatNames = new Map<string, string>();
  // Chats the name has already been asked for, whether or not an answer came
  // back. A host that will not name a chat answers with nothing, and without
  // this the question would go out again every time anything repainted.
  const namesAsked = new Set<string>();
  // Ask who a chat is with, once. Called from every path that makes a chat the
  // current one, and from the row that shows the name.
  //
  // Every one of those paths, not just a message rendering: switching chats and
  // starting a generation also make a chat current, and asking from only one of
  // them leaves the row reading "This chat" with no name.
  function ensureChatName(id: any) {
    if (id == null || id === "") return;
    const key = String(id);
    if (chatNames.has(key) || namesAsked.has(key)) return;
    namesAsked.add(key);
    // An ask that timed out, or came back from a backend that could not look,
    // is not an answer. Holding the key on one would mean this chat never gets
    // a name again for the life of the page, which is what the missing name
    // looked like: a backend still loading at startup answers nothing, and
    // nothing is what the row showed from then on. Released, so the next
    // message or chat switch asks again. A backend that looked and found no
    // card is an answer, keeps the key, and stops the question repeating.
    askActiveChat(key, (r) => {
      if (!r.answered || !r.resolved) namesAsked.delete(key);
    });
  }
  // The host's own token count for the last prompt, when it will give one. The
  // panel falls back to its own estimate, which is characters over four.
  let lastPromptTokens = 0;
  // The "This chat" row's own repaint, while the settings panel is open.
  let chatSwitchPaint: (() => void) | null = null;

  // The one place the tab changes, so what is on screen and what the backend
  // has been asked for cannot come apart.
  function showTab(id: "log" | "prompt" | "stats") {
    liveTab = id;
    layout.tab = id;
    saveLayout();
    renderLiveLog();
    askForPrompts();
  }

  const rough = (n: number) => (n < 1000 ? String(n) : Math.round(n / 100) / 10 + "k");
  // The host's own count when it gives one, and an estimate otherwise. Which
  // of the two it is gets said in words, since a count and a guess are
  // different things to act on.
  const sayTokens = (chars: number): string =>
    lastPromptTokens
      ? rough(lastPromptTokens) + " tokens"
      : "roughly " + rough(Math.round(chars / 4)) + " tokens";

  // The Stats view's own clock, which only the Stats view has. Dropped before
  // anything is drawn, so switching tabs or redrawing cannot leave a second one
  // running against elements that are no longer on the page.
  let statsTick: (() => void) | null = null;
  function stopStatsTick() {
    if (!statsTick) return;
    removeTicker(statsTick);
    statsTick = null;
  }

  function renderLiveLog() {
    if (!liveLogBody) return;
    stopStatsTick();
    if (paintTabs) {
      try { paintTabs(); } catch (_) {}
    }
    if (liveTab === "prompt") return renderPromptView();
    if (liveTab === "stats") return renderStatsView();
    liveLogBody.style.whiteSpace = "pre-wrap";
    liveLogBody.textContent = eventLog.length
      ? eventLog.join("\n")
      : "(nothing yet)";
    liveLogBody.scrollTop = liveLogBody.scrollHeight;
  }

  // What it has actually been doing, since the tab was opened.
  //
  // The counters behind this already existed for the debug report, which is a
  // wall of text you have to ask for and then read. The same numbers on screen
  // answer the question people actually have, which is whether it is doing
  // anything at all and what it keeps tripping on.
  //
  // No graph. A handful of counts and a bar the width of a proportion says
  // everything a chart would, without a drawing surface to maintain.
  function renderStatsView() {
    const body = liveLogBody;
    if (!body) return;
    body.replaceChildren();
    body.style.whiteSpace = "normal";

    const line = (label: string, value: string, quiet?: boolean) => {
      const row = document.createElement("div");
      row.style.cssText =
        "display:flex;gap:8px;align-items:baseline;padding:2px 0" +
        (quiet ? ";color:var(--lumiverse-text-muted,rgba(255,255,255,.65))" : "");
      const l = document.createElement("span");
      l.textContent = label;
      l.style.cssText = "flex:1;min-width:0";
      const v = document.createElement("span");
      v.textContent = value;
      v.style.cssText = "font-weight:600;flex:none";
      row.appendChild(l);
      row.appendChild(v);
      body.appendChild(row);
      // The value, so a line that changes on its own can be rewritten without
      // rebuilding the view around it.
      return v;
    };

    const total = stats.good + stats.retries;
    line("Replies that came back fine", String(stats.good));
    line("Retries fired", String(stats.retries));
    line("Messages it gave up on", String(stats.gaveUp));
    if (cfg.refusalNote || stats.notesSent || stats.notesSkipped) {
      line("Refusal notes sent", String(stats.notesSent));
      if (stats.notesSkipped)
        line("Notes not sent", String(stats.notesSkipped), true);
    }
    // Counts up on its own, so it is written the same way as everything else
    // that does: hours and minutes as they are needed, seconds throughout. A
    // number rounded to the nearest minute sat there saying "1 minute" for the
    // first ninety seconds of every session.
    const watched = line("Watching for", sayTime(Date.now() - stats.since), true);
    if (total)
      line(
        "One reply in",
        stats.retries
          ? String(Math.max(1, Math.round(total / stats.retries))) + " needed a retry"
          : "none needed a retry",
        true,
      );

    // Paused is a state, not a count, and it is the one that explains why
    // nothing is happening.
    let paused: HTMLElement | null = null;
    const pausedWords = () =>
      "Paused after repeated failures. " + sayTime(pausedUntil - Date.now()) +
      " left, or until a reply comes back fine.";
    if (cfg.pauseWhenFailing && Date.now() < pausedUntil) {
      const note = document.createElement("div");
      note.style.cssText =
        "margin:6px 0 0;padding:4px 6px;border-radius:var(--lumiverse-radius-sm,5px);" +
        "border-left:3px solid var(--lumiverse-warning,#f59e0b);" +
        "background:var(--lumiverse-warning-015,rgba(245,158,11,.15))";
      note.textContent = pausedWords();
      body.appendChild(note);
      paused = note;
    }

    const names = Object.keys(stats.reasons).sort(
      (a, b) => stats.reasons[b] - stats.reasons[a],
    );
    if (!names.length) {
      const none = document.createElement("div");
      none.style.cssText =
        "margin-top:6px;color:var(--lumiverse-text-muted,rgba(255,255,255,.65))";
      none.textContent = stats.good
        ? "Nothing has needed a retry yet."
        : "Nothing has happened yet.";
      body.appendChild(none);
    } else {
      body.appendChild(barBlock("What it retried for", stats.reasons, names));
    }

    // One labelled block of bars. Written once because there are two of them
    // now and they must not drift apart.
    function barBlock(title: string, counts: Record<string, number>, order: string[]): HTMLElement {
      const wrap = document.createElement("div");
      const head = document.createElement("div");
      head.textContent = title;
      head.style.cssText =
        "margin:8px 0 4px;font-size:11px;letter-spacing:.05em;text-transform:uppercase;" +
        "color:var(--lumiverse-text-muted,rgba(255,255,255,.65))";
      wrap.appendChild(head);
      const most = counts[order[0]] || 1;
      for (const name of order) {
        const n = counts[name];
        const row = document.createElement("div");
        row.style.cssText = "margin:0 0 4px";
        const top = document.createElement("div");
        top.style.cssText = "display:flex;gap:8px;align-items:baseline";
        const l = document.createElement("span");
        l.textContent = name;
        l.style.cssText = "flex:1;min-width:0";
        const v = document.createElement("span");
        v.textContent = String(n);
        v.style.cssText = "font-weight:600;flex:none";
        top.appendChild(l);
        top.appendChild(v);
        // A bar the width of its share. One div, no drawing surface, and it
        // reads at a glance in a way a column of numbers does not.
        const track = document.createElement("div");
        track.style.cssText =
          "height:4px;margin-top:2px;border-radius:2px;" +
          "background:var(--lumiverse-fill-subtle,rgba(0,0,0,.1))";
        const fill = document.createElement("div");
        fill.style.cssText =
          "height:100%;border-radius:2px;width:" +
          Math.max(4, Math.round((n / most) * 100)) + "%;" +
          "background:var(--lumiverse-primary,rgba(147,112,219,.9))";
        track.appendChild(fill);
        row.appendChild(top);
        row.appendChild(track);
        wrap.appendChild(row);
      }
      return wrap;
    }

    // The same again, by chat. What it retried for says which fault keeps
    // happening; this says where. One card whose replies keep needing a retry
    // does not show up in a total across every chat.
    const chatIds = Object.keys(stats.byChat).sort(
      (a, b) => stats.byChat[b] - stats.byChat[a],
    );
    if (chatIds.length > 1) {
      // Labelled now rather than when counted, so a name that arrived late
      // still covers every retry in that chat.
      const labelled: Record<string, number> = {};
      const order: string[] = [];
      for (const id of chatIds) {
        const name = chatNames.get(id);
        // Retries the host named no chat for. They share one row because there
        // is nothing to tell them apart by.
        let label = id === NO_CHAT
          ? "Chats without an id"
          : name ? "With " + name : "Chat " + id.slice(0, 8);
        // Two chats with the same card would otherwise land on one row.
        if (labelled[label] != null) label += " (" + id.slice(0, 4) + ")";
        labelled[label] = stats.byChat[id];
        order.push(label);
      }
      body.appendChild(barBlock("Which chats it retried in", labelled, order));
    }

    // Word swaps, for the chat on screen. A swap leaves nothing behind to look
    // at once it lands, since the reply reads as though the model wrote it that
    // way, so this is the only answer to "is that rule doing anything".
    const swapKeyNow = lastChatId == null ? NO_CHAT : String(lastChatId);
    const swapsHere = stats.swapsByChat[swapKeyNow] || 0;
    const swapsAll = Object.keys(stats.swapsByChat)
      .reduce((n, k) => n + stats.swapsByChat[k], 0);
    if (swapsAll > 0) {
      const rows: Record<string, number> = {};
      const order2: string[] = [];
      rows["This chat"] = swapsHere;
      order2.push("This chat");
      if (swapsAll !== swapsHere) {
        rows["Everywhere else"] = swapsAll - swapsHere;
        order2.push("Everywhere else");
      }
      body.appendChild(barBlock("Words swapped", rows, order2));
    }
    try { ensureReadableTree(body); } catch (_) {}

    // The two lines here that move on their own, kept moving. Only their words
    // are rewritten: rebuilding the whole view four times a second would throw
    // away the scroll position every tick and redraw a dozen bars that have not
    // changed. Everything else in here only changes when something happens, and
    // something happening already redraws the view.
    statsTick = () => {
      watched.textContent = sayTime(Date.now() - stats.since);
      if (!paused) return;
      // The pause can end while it is on screen, and a note still counting down
      // past zero would be worse than no note.
      if (Date.now() >= pausedUntil) renderLiveLog();
      else paused.textContent = pausedWords();
    };
    addTicker(statsTick);
  }

  // What actually went to the model, as the interceptor saw it: every message
  // in order, with its role, its size, and whether it came from the chat or was
  // wrapped around it. Lumiverse's own Prompt Breakdown answers what the chat is
  // built from, which is a different question from what was sent.
  // Whether the prompt being held describes the chat you are looking at.
  //
  // Snapshots are addressed to a person rather than to a window, so two chats
  // open in two tabs both receive every prompt either one produces, and the tab
  // showing chat B would draw chat A's prompt without a word about it.
  //
  // The prompt is kept either way and only its drawing is gated. Dropping it on
  // arrival would mean trusting that this side already knows which chat the
  // generation was for, and the snapshot and the events that set that are not
  // ordered against each other. Held, a chat id that arrives late costs nothing:
  // the next repaint starts matching. Either side being unknown counts as a
  // match, since a guess is worse than the prompt somebody asked to see.
  function promptIsForThisChat(): boolean {
    if (!lastPrompt || !lastPrompt.chatId || !lastChatId) return true;
    return String(lastPrompt.chatId) === String(lastChatId);
  }

  // The prompt as the model was handed it, with everything this panel adds
  // taken off: no roles coloured, no chat-or-added marks, no note highlighting,
  // none of the rows. Role and content are what actually crossed to the model,
  // so this is also the form that pastes into anything else.
  function promptAsData(): string {
    // Whether a prompt should be shown at all is decided by the two places that
    // call this, and both have decided before they get here. Asking again would
    // be a third copy of that rule to keep in step with the other two.
    if (!lastPrompt) return "[]";
    try {
      return JSON.stringify(
        lastPrompt.messages.map((m: any) => ({
          role: String(m.role || ""),
          content: String(m.content || ""),
        })),
        null,
        2,
      );
    } catch (_) {
      // A prompt large enough to fail here is one the rendered view still shows.
      return "(this prompt is too large to lay out as data; the rendered view still has it)";
    }
  }

  function renderPromptView() {
    const body = liveLogBody;
    if (!body) return;
    body.replaceChildren();
    body.style.whiteSpace = "normal";
    if (!lastPrompt) {
      // Asked for rather than guessed at. A guess about a permission is the one
      // thing a reader cannot check from this panel, so a denial is stated
      // plainly and a grant is not blamed for something else.
      const interceptor = permIs("interceptor");
      body.textContent =
        interceptor === false
          ? "The interceptor permission is not granted, so no prompt can be read. It is privileged, so an admin has to approve it. Everything else in the extension works without it."
          : promptNeverArrived
            ? interceptor === true
              ? "That reply finished without a prompt reaching this tab, and the interceptor permission is granted, so this is worth reporting as a bug."
              : "That reply finished without a prompt reaching this tab. Reading the prompt needs the interceptor permission, which is privileged, so an admin has to approve it before it does anything. Everything else in the extension works without it."
            : "(no prompt seen yet; send a reply)";
      return;
    }
    if (!promptIsForThisChat()) {
      body.textContent =
        "The last prompt captured was for a different chat. Send a reply here to see this one's.";
      return;
    }
    const chars = lastPrompt.messages.reduce(
      (n: number, m: any) => n + String(m.content || "").length,
      0,
    );
    // The count, then the switch on its own line under it. They shared a line
    // that wrapped when there was no room beside the text, which meant the
    // button sat next to the count at one width and under it at another. Worse,
    // the label is the state, so pressing it changed the button's width and
    // could move it between those two places in the act of being pressed. On
    // its own row it is in one place whatever the panel is doing.
    const sum = document.createElement("div");
    sum.style.cssText =
      "margin-bottom:6px;color:var(--lumiverse-text-muted,rgba(255,255,255,.65))";
    sum.textContent =
      lastPrompt.total + (lastPrompt.total === 1 ? " message, " : " messages, ") +
      rough(chars) + " characters, " + sayTokens(chars);
    body.appendChild(sum);
    const viewRow = document.createElement("div");
    viewRow.style.cssText = "margin-bottom:8px";
    const viewBtn = document.createElement("button");
    viewBtn.type = "button";
    viewBtn.textContent = promptView === "raw" ? "Raw" : "Rendered";
    viewBtn.title =
      promptView === "raw"
        ? "Showing the raw data, without the panel's own labels. Tap to go back to the readable view."
        : "Showing the readable view. Tap to see the raw data that was sent to the model.";
    viewBtn.setAttribute("aria-label", viewBtn.title);
    viewBtn.style.cssText =
      "cursor:pointer;font:inherit;min-height:30px;padding:3px 12px;" +
      // Sized for the longer of the two words plus its padding and border, so
      // the box is identical in both states and pressing it cannot resize or
      // move it. In ch rather than px so it follows the font: this panel is
      // monospace, and the host can scale it.
      "min-width:calc(8ch + 28px);text-align:center;" +
      "border:1px solid var(--lumiverse-border,rgba(255,255,255,.18));" +
      "border-radius:var(--lumiverse-radius-sm,5px);background:transparent;" +
      "color:var(--lumiverse-text,#e9e4f0);touch-action:manipulation";
    viewBtn.addEventListener("click", () => {
      promptView = promptView === "raw" ? "rendered" : "raw";
      layout.promptView = promptView;
      saveLayout();
      renderLiveLog();
    });
    viewRow.appendChild(viewBtn);
    body.appendChild(viewRow);

    if (promptView === "raw") {
      const data = document.createElement("pre");
      data.setAttribute("data-ar-raw", "1");
      data.style.cssText =
        "margin:0;white-space:pre-wrap;word-break:break-word;line-height:1.4;" +
        "font-family:var(--lumiverse-font-mono,ui-monospace,monospace);" +
        "color:var(--lumiverse-text,#e9e4f0)";
      data.textContent = promptAsData();
      body.appendChild(data);
      return;
    }

    // Where the notes landed, said in words as well as marked in the list. It
    // is the question this view is most likely to be open for, and counting
    // rows to work it out is not an answer.
    if (lastPrompt.notes) {
      const at = lastPrompt.messages.findIndex((m: any) => m && m.note);
      const where = document.createElement("div");
      where.style.cssText =
        "margin:0 0 6px;padding:4px 6px;border-radius:var(--lumiverse-radius-sm,5px);" +
        "border-left:3px solid var(--lumiverse-primary,rgba(147,112,219,.9));" +
        "background:var(--lumiverse-primary-020,rgba(147,112,219,.2))";
      where.textContent =
        lastPrompt.notes +
        (lastPrompt.notes === 1 ? " Auto Retry note went with this one" : " Auto Retry notes went with this one") +
        (at >= 0
          ? ", at position " + (at + 1) + " of " + lastPrompt.total
          : "") +
        ". Marked below.";
      body.appendChild(where);
    }

    lastPrompt.messages.forEach((m: any) => {
      const row = document.createElement("details");
      row.style.cssText =
        "margin:0 0 4px;border:1px solid " +
        (m.note
          ? "var(--lumiverse-primary-050,rgba(147,112,219,.5))"
          : "var(--lumiverse-border,rgba(255,255,255,.12))") +
        ";border-radius:var(--lumiverse-radius-sm,5px);padding:4px 6px" +
        (m.note
          ? ";background:var(--lumiverse-primary-020,rgba(147,112,219,.2))"
          : "");
      const head = document.createElement("summary");
      // Tall enough for a thumb, since this list is read on a phone as often as
      // on a desktop.
      head.style.cssText =
        "cursor:pointer;list-style:none;display:flex;gap:6px;align-items:baseline;" +
        "min-height:28px;padding:2px 0;touch-action:manipulation";
      const who = document.createElement("span");
      who.textContent = m.role || "?";
      who.style.cssText =
        "font-weight:600;color:" +
        (m.history
          ? "var(--lumiverse-text,#e9e4f0)"
          : "var(--lumiverse-primary-text,rgba(186,135,255,.95))");
      const where = document.createElement("span");
      // The distinction that matters when a prompt misbehaves: what came from
      // the conversation, what something wrapped around it, and which of it is
      // ours. A note is named rather than being one more "added" row, because
      // seeing where it landed is why someone opens this.
      where.textContent =
        (m.note
          ? "Auto Retry note" + (m.noteIndex > 1 || lastPrompt.notes > 1 ? " " + m.noteIndex : "")
          : m.history
            ? "chat"
            : "added") +
        " \u00b7 " + rough(String(m.content || "").length);
      where.style.cssText =
        "font-size:11px;color:var(--lumiverse-text-muted,rgba(255,255,255,.65))";
      const peek = document.createElement("span");
      peek.textContent = String(m.content || "").replace(/\s+/g, " ").slice(0, 60);
      peek.style.cssText =
        "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" +
        "color:var(--lumiverse-text-muted,rgba(255,255,255,.65))";
      head.appendChild(who);
      head.appendChild(where);
      head.appendChild(peek);
      const full = document.createElement("div");
      full.textContent = String(m.content || "");
      full.style.cssText =
        "margin-top:4px;white-space:pre-wrap;line-height:1.4;" +
        "font-family:var(--lumiverse-font-mono,ui-monospace,monospace)";
      row.appendChild(head);
      row.appendChild(full);
      body.appendChild(row);
      // A note is opened, because it is the thing someone came to look at.
      if (m.note) row.open = true;
    });
    try { ensureReadableTree(body); } catch (_) {}
  }
  // Everything the panel is made of that does not depend on where the panel
  // lives: the tab strip, Copy and Clear, the status line, and the body the
  // three views render into. Built here once so the floating panel and the
  // drawer tab are the same panel in two places rather than two panels that
  // have to be kept in step by hand.
  //
  // The caller owns the frame around these and decides what else they do: the
  // floating panel drags by the header it is handed, the drawer tab does not,
  // because the host places that one.
  function buildPanelParts(draggable: boolean): {
    head: HTMLElement;
    statusEl: HTMLElement;
    bodyEl: HTMLElement;
    stopStatus: () => void;
  } {
    const head = document.createElement("div");
    head.style.cssText =
      // One row, not a wrapping one. Measured rather than assumed: the tabs,
      // Copy and Clear need 195px between them, and that does not move with the
      // host's text size because everything in here sets its own in pixels. The
      // floating panel cannot be resized below 200, so the row always fits, and
      // a wrap that never happens is a rule that reads as if it might.
      "display:flex;align-items:center;gap:8px;padding:7px 9px;border-bottom:1px solid var(--lumiverse-border,rgba(255,255,255,.12));font-weight:600;user-select:none;" +
      // The move cursor and the pointer-event opt-out are the drag handle's,
      // and the drawer's header is not one: the host places that panel, so a
      // header offering to be dragged there would be a lie.
      (draggable ? "cursor:move;touch-action:none" : "");
    // Two views, one panel. The log says what the extension did; the prompt
    // view says what went to the model. They answer different questions and
    // both are wanted in the same place.
    const tabs = document.createElement("div");
    tabs.setAttribute("role", "tablist");
    tabs.style.cssText = "display:flex;gap:4px;flex:1;min-width:0";
    const ORDER: Array<"log" | "prompt" | "stats"> = ["log", "prompt", "stats"];
    const tabBtns: Record<string, HTMLButtonElement> = {};
    const mkTab = (id: "log" | "prompt" | "stats", label: string) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.setAttribute("role", "tab");
      b.id = "__lvRetryTab-" + id;
      b.setAttribute("aria-controls", "__lvRetryLogBody");
      b.style.cssText =
        // 32px tall and padded wide enough to be a thumb target. A tab strip
        // that only works with a mouse is the wrong way round here: this panel
        // exists because there is no console on a phone.
        "cursor:pointer;border:0;background:transparent;font:inherit;color:inherit;" +
        "min-height:32px;padding:4px 12px;border-radius:var(--lumiverse-radius-sm,5px);" +
        // The header is the drag handle, and a tap that slides a pixel would
        // otherwise be swallowed as the start of a drag.
        "touch-action:manipulation";
      b.addEventListener("click", () => showTab(id));
      tabs.appendChild(b);
      tabBtns[id] = b;
      return b;
    };
    mkTab("log", "Log");
    mkTab("prompt", "Prompt");
    mkTab("stats", "Stats");
    // Left and right move between tabs, which is how a tab strip is expected to
    // behave for anyone driving this from a keyboard.
    tabs.addEventListener("keydown", (e: any) => {
      if (!e || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
      try { e.preventDefault(); } catch (_) {}
      const at = ORDER.indexOf(liveTab);
      const next = ORDER[(at + (e.key === "ArrowRight" ? 1 : ORDER.length - 1)) % ORDER.length];
      showTab(next);
      if (focusTab) focusTab(next);
    });
    paintTabs = () => {
      for (const id of Object.keys(tabBtns)) {
        const on = id === liveTab;
        const b = tabBtns[id];
        b.style.background = on
          ? "var(--lumiverse-secondary-hover,rgba(128,128,128,.25))"
          : "transparent";
        b.style.fontWeight = on ? "600" : "400";
        b.setAttribute("aria-selected", on ? "true" : "false");
        // Only the selected tab is in the tab order, which is what a tab strip
        // does: Tab reaches the strip, then the arrows move within it.
        b.tabIndex = on ? 0 : -1;
      }
    };
    focusTab = (id: string) => {
      try { tabBtns[id] && tabBtns[id].focus({ preventScroll: true }); } catch (_) {}
    };
    head.appendChild(tabs);
    // The panel exists because the console is out of reach on a phone, which is
    // also where selecting text by hand is worst, so the log needs its own way
    // out. Clear keeps a long session's timeline readable.
    const tinyBtn = (label: string) => {
      const b = btn(label, false);
      b.style.cssText +=
        "min-height:0;padding:3px 9px;font-size:11px;flex:none;cursor:pointer";
      return b;
    };
    // Copy and Clear act on whichever view is showing, so the buttons mean the
    // same thing as what is in front of them.
    // Copy takes everything the tab is showing, in the order it is shown.
    // Anything on screen and missing from here is the button quietly lying
    // about what it did, and the counts left out were the ones somebody would
    // be copying the tab to report.
    const statsAsText = () => {
      const lines = [
        "Replies that came back fine: " + stats.good,
        "Retries fired: " + stats.retries,
        "Messages it gave up on: " + stats.gaveUp,
      ];
      if (cfg.refusalNote || stats.notesSent || stats.notesSkipped) {
        lines.push("Refusal notes sent: " + stats.notesSent);
        if (stats.notesSkipped) lines.push("Notes not sent: " + stats.notesSkipped);
      }
      const swapsAll = Object.keys(stats.swapsByChat)
        .reduce((n, k) => n + stats.swapsByChat[k], 0);
      if (cfg.replaceEnabled || swapsAll) {
        const here = stats.swapsByChat[lastChatId == null ? NO_CHAT : String(lastChatId)] || 0;
        lines.push("Words swapped: " + swapsAll + " (" + here + " in this chat)");
      }
      lines.push("Watching for: " + sayTime(Date.now() - stats.since));
      const total = stats.good + stats.retries;
      if (total)
        lines.push(
          "One reply in: " +
            (stats.retries
              ? String(Math.max(1, Math.round(total / stats.retries))) + " needed a retry"
              : "none needed a retry"),
        );
      if (cfg.pauseWhenFailing && Date.now() < pausedUntil)
        lines.push(
          "Paused after repeated failures. " + sayTime(pausedUntil - Date.now()) +
            " left, or until a reply comes back fine.",
        );
      const names = Object.keys(stats.reasons).sort((a, b) => stats.reasons[b] - stats.reasons[a]);
      if (!names.length) {
        lines.push(stats.good ? "Nothing has needed a retry yet." : "Nothing has happened yet.");
      } else {
        lines.push("");
        lines.push("What it retried for");
        for (const n of names) lines.push("  " + n + ": " + stats.reasons[n]);
      }
      return lines.join("\n");
    };
    const promptAsText = () => {
      if (!lastPrompt) return "(no prompt seen yet; send a reply)";
      if (!promptIsForThisChat())
        return "(the last prompt captured was for a different chat)";
      // Copy takes what is on screen, so in the raw view it takes the data.
      if (promptView === "raw") return promptAsData();
      const chars = lastPrompt.messages.reduce(
        (n: number, m: any) => n + String(m.content || "").length,
        0,
      );
      const lines = [
        lastPrompt.total + (lastPrompt.total === 1 ? " message, " : " messages, ") +
          rough(chars) + " characters, " + sayTokens(chars),
      ];
      if (lastPrompt.notes) {
        const at = lastPrompt.messages.findIndex((m: any) => m && m.note);
        lines.push(
          lastPrompt.notes +
            (lastPrompt.notes === 1
              ? " Auto Retry note went with this one"
              : " Auto Retry notes went with this one") +
            (at >= 0 ? ", at position " + (at + 1) + " of " + lastPrompt.total : "") +
            ". Marked below.",
        );
      }
      // The marking is the point of this view, so it survives being copied
      // rather than being something you had to be looking at the screen for.
      for (let i = 0; i < lastPrompt.messages.length; i++) {
        const m = lastPrompt.messages[i];
        lines.push("");
        lines.push(
          "--- " + (i + 1) + " " + (m.role || "?") + " " +
            (m.history ? "(chat)" : "(added)") +
            (m.note ? " (Auto Retry note)" : "") + " " +
            String(m.content || "").length + " chars ---",
        );
        lines.push(String(m.content || ""));
      }
      return lines.join("\n");
    };
    const copyBtn = tinyBtn("Copy");
    copyBtn.addEventListener("click", async () => {
      const before = copyBtn.textContent;
      const ok = await copyText(
        liveTab === "prompt"
          ? promptAsText()
          : liveTab === "stats"
            ? statsAsText()
            : eventLog.length
              ? eventLog.join("\n")
              : "(nothing yet)",
      );
      copyBtn.textContent = ok ? "Copied" : "Can't";
      setTimeout(() => {
        copyBtn.textContent = before;
      }, 1400);
    });
    const clearBtn = tinyBtn("Clear");
    clearBtn.addEventListener("click", () => {
      if (liveTab === "prompt") {
        lastPrompt = null;
        // And what it was saying about the reply that prompt came from. Left
        // set, Clear emptied the tab and kept it telling you the interceptor
        // permission was missing, about a reply you had just discarded.
        promptNeverArrived = false;
      }
      else if (liveTab === "stats") {
        // Counting starts again from now, so the clock resets with the counts
        // or the rate below them would be measured against the wrong window.
        stats.retries = 0;
        stats.gaveUp = 0;
        stats.good = 0;
        stats.notesSent = 0;
        stats.notesSkipped = 0;
        stats.lastNoteSkip = "";
        for (const k of Object.keys(stats.reasons)) delete stats.reasons[k];
        stats.since = Date.now();
      } else eventLog.length = 0;
      renderLiveLog();
    });
    head.appendChild(copyBtn);
    head.appendChild(clearBtn);
    // A line saying what is happening this second, above all three tabs
    // because the answer is the same whichever one you are reading. The Log
    // tells you what already happened and the Stats tell you what has happened
    // overall; neither answers "is it doing something right now", which is the
    // question anyone opening this panel actually has.
    const statusEl = document.createElement("div");
    statusEl.id = "__lvRetryStatus";
    statusEl.setAttribute("aria-live", "polite");
    statusEl.style.cssText =
      "flex:none;display:flex;align-items:center;gap:7px;padding:5px 9px;" +
      "border-bottom:1px solid var(--lumiverse-border,rgba(255,255,255,.18));" +
      "color:var(--lumiverse-text-muted,rgba(255,255,255,.65))";
    const dot = document.createElement("span");
    dot.style.cssText = "flex:none;width:7px;height:7px;border-radius:50%";
    ensureStatusStyle();
    const words = document.createElement("span");
    words.style.cssText = "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
    statusEl.appendChild(dot);
    statusEl.appendChild(words);
    // Repainted by the shared clock rather than by whatever happened to change,
    // because most of what this says is a number going down on its own with no
    // event behind it.
    const paintStatus = () => {
      const st = liveStatus();
      if (words.textContent !== st.text) words.textContent = st.text;
      // Off is dim and flat. On with nothing to do glows. Something actually
      // happening pulses, so movement means movement rather than decoration.
      if (dot.getAttribute("data-ar-state") !== st.state) {
        dot.setAttribute("data-ar-state", st.state);
        dot.style.background =
          st.state === "off"
            ? "var(--lumiverse-text-muted,rgba(255,255,255,.45))"
            : "var(--lumiverse-primary,rgba(147,112,219,.9))";
        dot.style.boxShadow =
          st.state === "off"
            ? "none"
            : "0 0 6px 1px var(--lumiverse-primary-020,rgba(147,112,219,.45))";
        dot.style.animation = st.state === "busy" ? "lvRetryPulse 1.6s ease-in-out infinite" : "none";
      }
    };
    paintStatus();
    addTicker(paintStatus);

    const bodyEl = document.createElement("div");
    bodyEl.id = "__lvRetryLogBody";
    bodyEl.style.cssText =
      "flex:1;padding:7px 9px;overflow:auto;white-space:pre-wrap;line-height:1.4;font-family:var(--lumiverse-font-mono,ui-monospace,monospace) !important";
    return {
      head: head,
      statusEl: statusEl,
      bodyEl: bodyEl,
      stopStatus: () => removeTicker(paintStatus),
    };
  }

  function showLiveLog() {
    if (liveLogEl || typeof document === "undefined") return;
    const el = document.createElement("div");
    // Named, like the other surfaces the extension owns. Without an id the
    // word-swap pass over the page had no way to tell this panel from the chat,
    // so a rule could rewrite its own log text underneath it.
    el.id = "__lvRetryLog";
    el.style.cssText =
      "position:fixed;right:8px;bottom:8px;z-index:" + Z_LIVE_LOG + ";width:min(340px,92vw);height:min(300px,50vh);min-width:200px;min-height:120px;max-width:96vw;max-height:85vh;display:flex;flex-direction:column;background-color:var(--lumiverse-card-bg-solid,rgb(24,20,34));background-image:linear-gradient(var(--lumiverse-bg-elevated,rgba(35,30,48,.9)),var(--lumiverse-bg-elevated,rgba(35,30,48,.9)));border:1px solid var(--lumiverse-border,rgba(255,255,255,.14));border-radius:var(--lumiverse-radius-md,10px);box-shadow:var(--lumiverse-shadow-md,0 8px 24px rgba(0,0,0,.4));font-family:var(--lumiverse-font-family,system-ui);font-size:13px;color:var(--lumiverse-text,#e9e4f0);overflow:hidden";
    const parts = buildPanelParts(true);
    const head = parts.head;
    const bodyEl = parts.bodyEl;
    (el as any).__stopStatus = parts.stopStatus;
    el.appendChild(head);
    el.appendChild(parts.statusEl);
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
      // A press on one of the header's own buttons belongs to that button.
      // Without this the drag captures the pointer and the control never gets it.
      try {
        if (e && e.target && e.target.closest && e.target.closest("button")) return;
      } catch (_) {}
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
      mx = 0;
      my = 0;
      try {
        head.setPointerCapture(e.pointerId);
      } catch (_) {}
      e.preventDefault();
    };
    // Moved with a transform while dragging rather than by rewriting left and
    // top. Changing left/top makes the browser redo layout on every pointer
    // event, which on a phone cannot keep up with a finger and looks like the
    // panel jumping. A transform is handled by the compositor, so it tracks the
    // finger, and the offset is folded back into left/top once on release.
    let mx = 0,
      my = 0,
      frame: any = null;
    const paintDrag = () => {
      frame = null;
      el.style.transform = "translate3d(" + mx + "px," + my + "px,0)";
    };
    const onMove = (e: any) => {
      if (!dragging) return;
      const w = el.offsetWidth || 0,
        h = el.offsetHeight || 0;
      const vw = (typeof window !== "undefined" && window.innerWidth) || 360;
      const vh = (typeof window !== "undefined" && window.innerHeight) || 640;
      // Clamped as an offset, so the panel cannot be dragged off the screen.
      mx = Math.max(-ox, Math.min(e.clientX - sx, vw - w - ox));
      my = Math.max(-oy, Math.min(e.clientY - sy, vh - h - oy));
      // One paint per frame at most, however fast the pointer events arrive.
      if (!frame) frame = requestAnimationFrame(paintDrag);
    };
    const onUp = (e: any) => {
      if (dragging) {
        dragging = false;
        try {
          head.releasePointerCapture(e.pointerId);
        } catch (_) {}
        if (frame) {
          cancelAnimationFrame(frame);
          frame = null;
        }
        el.style.transform = "none";
        el.style.left = ox + mx + "px";
        el.style.top = oy + my + "px";
        mx = 0;
        my = 0;
        rememberPanel();
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
      "position:absolute;right:0;bottom:0;width:20px;height:20px;cursor:nwse-resize;touch-action:none;background:linear-gradient(135deg,transparent 45%,var(--lumiverse-border,rgba(255,255,255,.5)) 45%,var(--lumiverse-border,rgba(255,255,255,.5)) 55%,transparent 55%,transparent 70%,var(--lumiverse-border,rgba(255,255,255,.5)) 70%,var(--lumiverse-border,rgba(255,255,255,.5)) 80%,transparent 80%);border-bottom-right-radius:var(--lumiverse-radius-md,10px)";
    el.appendChild(grip);
    let rz = false,
      rsx = 0,
      rsy = 0,
      rw = 0,
      rh = 0,
      pendW = 0,
      pendH = 0,
      rzFrame: any = null;
    const paintResize = () => {
      rzFrame = null;
      el.style.width = pendW + "px";
      el.style.height = pendH + "px";
    };
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
      // Resizing has to change layout, so a transform cannot help here the way
      // it does for dragging. Batching to one change per frame still keeps it
      // from thrashing when pointer events arrive faster than the screen redraws.
      pendW = nw;
      pendH = nh;
      if (!rzFrame) rzFrame = requestAnimationFrame(paintResize);
    };
    const rzUp = (e: any) => {
      if (rz) {
        rz = false;
        if (rzFrame) {
          cancelAnimationFrame(rzFrame);
          rzFrame = null;
          paintResize();
        }
        try {
          grip.releasePointerCapture(e.pointerId);
        } catch (_) {}
        rememberPanel();
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
    // Put back where it was left, if it was left anywhere. Clamped against the
    // screen it is opening on rather than the one it was saved from: a panel
    // sized for a desktop window, restored on a phone, would otherwise open
    // mostly off the edge with its header out of reach, and the header is the
    // only way to drag it back.
    if (layout.panel) {
      const w = Math.max(200, Math.min(layout.panel.w, vpW() - 16));
      const h = Math.max(120, Math.min(layout.panel.h, vpH() - 16));
      el.style.width = w + "px";
      el.style.height = h + "px";
      el.style.left = Math.round(Math.max(8, Math.min(layout.panel.x, vpW() - w - 8))) + "px";
      el.style.top = Math.round(Math.max(8, Math.min(layout.panel.y, vpH() - h - 8))) + "px";
      el.style.right = "auto";
      el.style.bottom = "auto";
    }
    liveLogEl = el;
    liveLogBody = bodyEl;
    renderLiveLog();
    ensureReadableTree(el);
  }

  // Called when a drag or a resize finishes. Reads the panel off the screen
  // rather than tracking it, so it cannot drift from where the panel actually
  // is.
  function rememberPanel() {
    const el = liveLogEl;
    if (!el || !el.getBoundingClientRect) return;
    try {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      layout.panel = {
        x: Math.round(r.left),
        y: Math.round(r.top),
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
      saveLayout();
    } catch (_) {}
  }
  function hideLiveLog() {
    // Nothing to take down, so nothing is touched. This guard is the whole
    // point of the function being callable at any time: the three handles
    // below are shared with the drawer, and a sync runs both teardowns to be
    // sure the home it is not using is gone. Without this, taking down the
    // home that was already empty reached over and nulled the handles the
    // other one was still using, and the panel stayed on screen with its tabs,
    // its body and its repaint function all pointing at nothing.
    if (!liveLogEl) return;
    // Off the clock before it leaves the page. A repaint of a panel that is no
    // longer on screen is work nobody sees, and it would hold the interval open
    // for as long as the tab lives.
    if ((liveLogEl as any).__stopStatus) {
      try { (liveLogEl as any).__stopStatus(); } catch (_) {}
    }
    stopStatsTick();
    if (liveLogEl.parentNode) {
      try {
        liveLogEl.parentNode.removeChild(liveLogEl);
      } catch (_) {}
    }
    liveLogEl = null;
    liveLogBody = null;
    paintTabs = null;
    focusTab = null;
    // The panel is gone, so nothing is watching a prompt any more.
    askForPrompts();
  }

  // The same panel, in the sidebar drawer instead of over the chat. This one
  // is free: registerDrawerTab needs no permission, and the host gives it a
  // place, a theme, a Ctrl+K entry built from the title and keywords below,
  // and teardown when the extension is disabled. What it does not give is a
  // position of its own, which is the point: nothing to drag, nothing to
  // remember, and it never covers the reply you are reading.
  let drawerTab: any = null;
  let drawerStop: (() => void) | null = null;
  let drawerBadge: string | null = null;
  let paintBadge: (() => void) | null = null;
  // Returns whether the panel is now in the drawer. False means the host has
  // no drawer to put it in, and the caller falls back to the floating panel
  // rather than leaving the switch on with nothing on screen.
  function showDrawerPanel(): boolean {
    if (drawerTab) return true;
    if (!ctx || !ctx.ui || typeof (ctx as any).ui.registerDrawerTab !== "function") {
      log("this version of Lumiverse has no sidebar panel for extensions, so the panel stays over the chat");
      return false;
    }
    try {
      drawerTab = (ctx as any).ui.registerDrawerTab({
        id: "auto-retry-panel",
        title: "Auto Retry",
        shortName: "Retry",
        description: "What Auto Retry is doing: its log, the prompt that went out, and the totals",
        keywords: ["auto retry", "retry", "log", "prompt", "stats", "regenerate"],
        iconSvg: markSvg(false),
      });
      const root = drawerTab && drawerTab.root;
      if (!root) throw new Error("drawer tab gave no root");
      root.style.cssText =
        "display:flex;flex-direction:column;height:100%;min-height:0;" +
        "font-family:var(--lumiverse-font-family,system-ui);font-size:13px;color:var(--lumiverse-text,#e9e4f0)";
      const parts = buildPanelParts(false);
      root.appendChild(parts.head);
      root.appendChild(parts.statusEl);
      root.appendChild(parts.bodyEl);
      drawerStop = parts.stopStatus;
      liveLogBody = parts.bodyEl;
      // A badge on the tab, so the drawer does not have to be open to see that
      // something is happening. Written only when it changes: the shared clock
      // runs four times a second and the host should not hear from us that
      // often to be told the same thing.
      paintBadge = () => {
        const st = liveStatus();
        const want = st.state === "busy" ? "\u2022" : null;
        if (want === drawerBadge) return;
        drawerBadge = want;
        try { drawerTab && drawerTab.setBadge && drawerTab.setBadge(want); } catch (_) {}
      };
      paintBadge();
      addTicker(paintBadge);
      renderLiveLog();
      ensureReadableTree(root);
      return true;
    } catch (e) {
      log("could not open the sidebar panel, so the panel stays over the chat", e);
      hideDrawerPanel();
      return false;
    }
  }
  function hideDrawerPanel() {
    // Same guard, same reason: see hideLiveLog. Nothing registered means
    // nothing of ours is on screen here, and the handles below belong to
    // whichever home is.
    if (!drawerTab) return;
    if (paintBadge) {
      removeTicker(paintBadge);
      paintBadge = null;
    }
    drawerBadge = null;
    if (drawerStop) {
      try { drawerStop(); } catch (_) {}
      drawerStop = null;
    }
    stopStatsTick();
    if (drawerTab) {
      try { drawerTab.destroy(); } catch (_) {}
      drawerTab = null;
    }
    liveLogBody = null;
    paintTabs = null;
    focusTab = null;
    askForPrompts();
  }
  // A small round button that floats over the chat and turns the extension on or
  // off in one tap. The host owns the placement: ctx.ui.createFloatWidget gives
  // it dragging and edge snapping, which is why this is not a hand-rolled
  // fixed-position element with its own pointer handling. Its right-click menu
  // is the one thing not taken, since ours has to go there instead; see the
  // contextmenu handler below.
  let floatWidget: any = null;
  // Whether there is a panel to bring forward. Asked in two places that have to
  // agree: the Extras button is removed when the floating button's menu has it.
  function canOpenPanel(): boolean {
    return !!(
      cfg.liveLog &&
      cfg.panelHome === "drawer" &&
      drawerTab &&
      typeof drawerTab.activate === "function"
    );
  }

  function openDrawerPanel() {
    try {
      drawerTab && drawerTab.activate();
    } catch (e) {
      log("could not open the drawer tab", e);
    }
  }

  function floatIsUp(): boolean {
    return !!floatWidget && !!floatEl;
  }

  // Whether the floating button can actually hold the buttons that hide for it.
  //
  // Its menu is drawn by Lumiverse. A version without showContextMenu shows a
  // message saying where the settings are instead, so on those the button has
  // no menu at all. A button that hid for it would then have nowhere to be.
  function floatCarriesEntries(): boolean {
    return floatIsUp() && typeof (ctx as any)?.ui?.showContextMenu === "function";
  }

  // The host's menu while it is open, as a token to compare against. Null when
  // there is none. It answers two questions at once: whether one is already up,
  // and whether the answer now arriving belongs to the one still wanted.
  let floatMenuToken: object | null = null;
  // Reassigned each time the button is rebuilt; the document listener below
  // calls through this so only one listener is ever registered.
  let holdMoveWatch: ((e: any) => void) | null = null;
  let floatEl: any = null;
  let floatWidgetSize = 0;
  // What the button was last painted as, so a repaint that says nothing new
  // does not animate. Null until the first paint, which never animates either.
  let floatShownOn: boolean | null = null;

  function floatSize(): number {
    const v = Math.floor(Number(cfg.floatingToggleSize));
    return Number.isFinite(v) && v >= 28 ? Math.min(v, 96) : 44;
  }

  // Whether the pointer can hover at all. A phone cannot, and a browser on one
  // synthesises a hover when a finger rests somewhere, so anything drawn from
  // hover alone arrives on a tap and has nothing to take it off again.
  //
  // Only worth asking about a device as a whole, never about one event. A phone
  // asked to show the desktop site answers yes to this, and so does anything
  // else without the touch flag set, which is what made a highlight stick.
  // Anything deciding what a particular touch or click should do asks
  // fromMouse below instead.
  const canHover = (): boolean => {
    try {
      return (
        typeof window !== "undefined" &&
        !!window.matchMedia &&
        window.matchMedia("(hover: hover)").matches
      );
    } catch (_) {
      return false;
    }
  };

  // What last touched the page. Pointer events carry pointerType, which says
  // "touch" for a finger whatever the screen claims about hovering, so this is
  // the answer the ones below use instead of the media query.
  //
  // Kept because the compatibility events, mouseenter and click, carry no
  // pointerType of their own. Each follows a pointer event from the same
  // gesture, so the kind is already written down by the time one arrives.
  let lastPointerType = "";

  const fromMouse = (e?: any): boolean => {
    const t = e && e.pointerType;
    if (t) return t === "mouse";
    if (lastPointerType) return lastPointerType === "mouse";
    // Nothing has touched the page yet, so the screen is all there is to go on.
    // One touch corrects it for good.
    return canHover();
  };

  // Focus something without marking it as keyboard focus.
  //
  // :focus-visible is a guess. The browser answers from the last kind of input
  // it saw anywhere on the page, so a menu opened with a thumb comes up with
  // its top entry lit if a key was pressed in the chat beforehand.
  //
  // The attribute below says this focus came from us rather than from the
  // reader, and it beats the guess. It comes off at the first key pressed on
  // the element and when focus leaves it, so tabbing and the arrow keys still
  // mark.
  const QUIET_ATTR = "data-ar-quiet";

  const focusQuietly = (el: any): void => {
    if (!el || !el.focus) return;
    const clear = () => {
      try { el.removeAttribute(QUIET_ATTR); } catch (_) {}
      try { el.removeEventListener("keydown", clear, true); } catch (_) {}
      try { el.removeEventListener("blur", onBlur, true); } catch (_) {}
    };
    // Not every blur is somebody moving focus. Leaving the tab blurs whatever
    // was focused and coming back puts it there again, which runs the focus
    // handler a second time; with the mark already cleared on the way out, the
    // guess decided on the way in and the thing lit up on returning to the
    // page. A blur with the whole document out of focus is the window leaving.
    const onBlur = () => {
      try { if (!document.hasFocus()) return; } catch (_) {}
      clear();
    };
    try { el.setAttribute(QUIET_ATTR, "1"); } catch (_) {}
    try { el.addEventListener("keydown", clear, true); } catch (_) {}
    try { el.addEventListener("blur", onBlur, true); } catch (_) {}
    try { el.focus({ preventScroll: true }); } catch (_) {}
  };

  const vpW = (): number =>
    (typeof window !== "undefined" && window.innerWidth) || 360;
  const vpH = (): number =>
    (typeof window !== "undefined" && window.innerHeight) || 640;

  // Put a fixed element at a viewport position and make sure it got there.
  // Where it is told to go is not always where it lands: Lumiverse's UI Scale is
  // applied as a zoom, and anything parented to the page is zoomed with it, so
  // at 0.9 an element set to 800 arrives at 720. Rather than guess at how a host
  // applies its scale, put it somewhere, ask the browser where it actually went,
  // and correct by the difference. That holds for a zoom, a transform, or
  // anything else that moves it, because it is measured rather than assumed.
  function placeFixed(el: any, left: number, top: number) {
    el.style.left = Math.round(left) + "px";
    el.style.top = Math.round(top) + "px";
    const got = el.getBoundingClientRect();
    const scale = el.offsetWidth > 0 ? got.width / el.offsetWidth : 1;
    const dx = left - got.left;
    const dy = top - got.top;
    if (scale > 0.01 && (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5)) {
      el.style.left = Math.round(left + dx / scale) + "px";
      el.style.top = Math.round(top + dy / scale) + "px";
    }
  }

  function paintFloat() {
    if (!floatEl) return;
    const wasOn = floatShownOn;
    // What the button shows is whether a reply would actually be retried right
    // now, which is both switches. Showing only the master one would leave it
    // looking on in a chat it has been told to leave alone.
    const on = retryingHere(lastChatId);
    const onlyHere = cfg.enabled !== false && !on;
    const d = floatSize();
    floatEl.style.width = d + "px";
    floatEl.style.height = d + "px";
    // The mark is drawn, not typed, so it is sized here rather than by font
    // size. Just over half the button leaves the ring around it looking even.
    const glyph = Math.max(14, Math.round(d * 0.56));
    floatEl.style.background = on
      ? "var(--lumiverse-primary-020,rgba(147,112,219,.2))"
      : "var(--lumiverse-fill-subtle,rgba(0,0,0,.1))";
    floatEl.style.borderColor = on
      ? "var(--lumiverse-primary-050,rgba(147,112,219,.5))"
      : "var(--lumiverse-border,rgba(147,112,219,.12))";
    floatEl.style.color = on
      ? "var(--lumiverse-primary-text,rgba(186,135,255,.95))"
      : "var(--lumiverse-text-muted,rgba(255,255,255,.65))";
    floatEl.style.opacity = on ? "1" : "0.75";
    floatEl.innerHTML = markSvg(!on, glyph);
    // A fresh element every paint, so the fade is put on the one just made and
    // there is nothing to clear up afterwards.
    floatShownOn = on;
    if (wasOn !== null && wasOn !== on) {
      const mark: any = floatEl.firstElementChild;
      if (mark && mark.style) mark.style.animation = "lvRetryFloatMark 180ms ease";
    }
    // Tapping is always the master switch, whatever is showing, so the label
    // names the switch a tap reaches rather than leaving somebody to find out
    // by pressing it. It describes only what this button does: on a screen
    // reader the label is the entire description of the button.
    const label = onlyHere
      ? "Auto Retry is on, but off in this chat. Tap to turn it off everywhere"
      : on
        ? "Auto Retry is on, tap to turn off"
        : "Auto Retry is off, tap to turn on";
    floatEl.title = label;
    floatEl.setAttribute("aria-label", label);
    floatEl.setAttribute("aria-pressed", on ? "true" : "false");
    // The tinted fill and the symbol on it both come from the theme's accent, so
    // on some themes they land close enough together to read as an empty circle.
    ensureReadable(floatEl);
  }

  // The delayed read after a drag. Held out here so hideFloat can drop it: it
  // would otherwise fire against a widget that has gone and write its last
  // position over a newer one.
  let floatSettle: any = null;

  // Where this extension last put the button, and the size it put it there at.
  // A resize rebuilds the widget, and the rebuild is handed these figures
  // rather than a reading off the screen. Measuring would make every resize
  // depend on the host reporting a rect the size of the button, and a host
  // whose root does not carry that size reports a middle that is too high, so
  // each resize would nudge the button upward until it reached the top.
  // Nothing here is measured, so a hundred resizes land where one does.
  let floatAt: { x: number; y: number } | null = null;

  function showFloat(at?: { x: number; y: number } | null) {
    if (floatWidget || typeof document === "undefined") return;
    const d = floatSize();
    // Nothing asked for means a fresh start, which is where it was left last
    // time if it was ever moved. An explicit position wins, since that is the
    // caller carrying it across a rebuild.
    if (!at && layout.float) at = layout.float;
    // Bottom right, clear of the input bar, matching where other extensions put
    // theirs. The host remembers wherever the user drags it after that.
    const home = { x: Math.max(16, vpW() - 72), y: Math.max(16, vpH() - 160) };
    // Whatever is asked for, the whole button has to land on screen: a position
    // carried over from a smaller button, or from a larger window, can sit past
    // the edge otherwise.
    const start = at
      ? {
          x: Math.max(8, Math.min(at.x, vpW() - d - 8)),
          y: Math.max(8, Math.min(at.y, vpH() - d - 8)),
        }
      : home;
    // Remembered as asked for, before the host has a say. Snapping moves the
    // button afterwards and this is only ever used to work out where the next
    // size should sit, which is a question about where it was put.
    floatAt = { x: start.x, y: start.y };
    try {
      floatWidget = (ctx as any).ui.createFloatWidget({
        width: d,
        height: d,
        initialPosition: start,
        snapToEdge: true,
        tooltip: "Toggle Auto Retry",
        chromeless: true,
      });
    } catch (_) {
      // Float widgets need the ui_panels permission. Without it the extension
      // still works; there is just no floating button.
      floatWidget = null;
      log("could not create the floating button. Check that the ui_panels permission is granted.");
      return;
    }
    floatWidgetSize = d;
    const el = document.createElement("button");
    el.type = "button";
    el.style.cssText =
      "display:flex;align-items:center;justify-content:center;box-sizing:border-box;" +
      "border-radius:50%;border:1px solid;cursor:pointer;padding:0;line-height:1;" +
      // A long press on a phone otherwise starts a text selection or the
      // browser's own callout, either of which lands on top of the menu.
      "user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;" +
      "font-family:var(--lumiverse-font-family,system-ui);" +
      "box-shadow:var(--lumiverse-shadow-sm,0 2px 8px rgba(0,0,0,.2));";
    // The colours ease between the two states and the mark fades in over the one
    // it replaces, so turning it off reads as one movement rather than a
    // flicker. Only on a real change of state: repainting for a chat switch or
    // after a drag says nothing new, and a device asking for less movement gets
    // the change with none of this.
    //
    // The button itself never moves. A scale dip on every press was here once,
    // and it forced a compositing layer on a control whose whole job is to flip
    // between two states; a press is also how the menu is opened, so dipping on
    // the way in makes a hold look like a tap that took.
    el.setAttribute("data-ar-float", "1");
    markOwnUI(el);
    ensureFloatStyle();

    // A press held down opens the menu instead of toggling. Right-click does the
    // same on a pointer device. Without this the only way to put the button away
    // was to open settings and turn it off, which is a long walk for something
    // that is in your way right now.
    let pressTimer: any = null;
    let pressFrom: { x: number; y: number } | null = null;
    let openedByHold = false;
    const dropPress = () => {
      if (pressTimer) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
      pressFrom = null;
    };
    el.addEventListener("pointerdown", (e: any) => {
      openedByHold = false;
      pressFrom = { x: e && e.clientX, y: e && e.clientY };
      pressTimer = setTimeout(() => {
        pressTimer = null;
        openedByHold = true;
        showFloatMenu();
      }, HOLD_MS);
    });
    // Dragging is the host moving the button, so it is not a hold. The threshold
    // is loose enough that a thumb resting on glass does not cancel it.
    //
    // Watched on the document rather than on the button. The host drags the
    // widget by capturing the pointer on the frame around this button, and once
    // it does that the moves are delivered there instead. They still pass
    // through the document on the way down, so this sees them either way. A
    // listener only on the button would miss a drag entirely and pop the menu
    // open in the middle of one.
    holdMoveWatch = (e: any) => {
      if (!pressFrom || !e) return;
      if (Math.abs(e.clientX - pressFrom.x) > 8 || Math.abs(e.clientY - pressFrom.y) > 8)
        dropPress();
    };
    // Stopped, not just prevented. preventDefault suppresses the browser's own
    // menu and nothing else, so the event went on bubbling to the host, which
    // opened Lumiverse's widget menu underneath ours: two menus, one on top of
    // the other, the lower one clearing when something dismissed it. Capture
    // phase so the host's own listener never runs, and stopImmediatePropagation
    // because the host may have more than one on the same element.
    //
    // Only this event is swallowed. Pointer events still reach the host
    // untouched, which is what drags the button and snaps it to an edge.
    const onMenu = (e: any) => {
      try {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
      } catch (_) {}
      dropPress();
      showFloatMenu();
    };
    // Android raises this on a long press too, so it can arrive alongside the
    // timer above. showFloatMenu drops the second of the two rather than asking
    // the host for a menu it cannot then take back.
    el.addEventListener("contextmenu", onMenu, true);
    // The host owns the element our button sits in, and that is where its own
    // menu is wired, so a press that lands on the padding around the button
    // reaches the host without ever touching ours.
    const widgetRoot = floatWidget && floatWidget.root;
    if (widgetRoot && widgetRoot !== el) {
      widgetRoot.addEventListener("contextmenu", onMenu, true);
    }
    el.addEventListener("pointerup", dropPress);
    el.addEventListener("pointercancel", dropPress);
    // The host does the dragging and does not report where it finished, so the
    // only way to know is to look. Read after a delay rather than straight away
    // because the button snaps to the nearest edge once it is let go, and the
    // position wanted is the one it settles on, not the one your finger left.
    const rememberFloat = () => {
      // Only ever one pending. Both events this is on can land from the same
      // gesture, and an untracked timer is one hideFloat cannot call off.
      if (floatSettle) clearTimeout(floatSettle);
      floatSettle = setTimeout(() => {
        floatSettle = null;
        const at = floatPos();
        if (!at) return;
        // Dragging is the other thing that moves the button, so the next resize
        // has to grow it around where the drag left it rather than where this
        // extension last placed it.
        floatAt = at;
        if (layout.float && layout.float.x === at.x && layout.float.y === at.y) return;
        layout.float = at;
        saveLayout();
      }, 400);
    };
    el.addEventListener("pointerup", rememberFloat);
    el.addEventListener("pointercancel", rememberFloat);
    el.addEventListener("pointerleave", dropPress);
    el.addEventListener("click", () => {
      // The hold already acted. Toggling here as well would undo it in the same
      // gesture.
      if (openedByHold) {
        openedByHold = false;
        return;
      }
      toggleEnabled();
    });
    try {
      floatWidget.root.replaceChildren(el);
    } catch (_) {
      try { floatWidget.root.innerHTML = ""; floatWidget.root.appendChild(el); } catch (__) {}
    }
    floatEl = el;
    paintFloat();
    // Everything the floating button's menu now holds is removed from the
    // Extras menu. This runs here rather than only when a setting is saved,
    // because the button can appear without any setting being changed.
    syncInputBarActions();
  }

  // Not a close: the menu belongs to the host, which shuts it on Escape, on a
  // tap outside, and when its promise resolves. This is for the case where the
  // button goes away while one is still up, so the answer that arrives after is
  // dropped rather than acted on for a button that is no longer there.
  function forgetFloatMenu() {
    floatMenuToken = null;
  }

  // The menu shown by holding or right-clicking the floating button. It holds
  // the ways into the extension's own screens, the two word swap buttons when
  // those are switched on, and hiding the button itself. Nothing here changes
  // how a reply is retried. The settings panel is the only place that does.
  //
  // Drawn by Lumiverse rather than by us. It arrives in the user's own theme,
  // accent and dark or light mode, clamps itself to the screen, and closes on
  // Escape. Ours did all of that by hand, and every part of it that had to
  // guess what a pointer was doing got it wrong on a phone at least once: an
  // entry lit as the menu opened, an entry that stayed lit after a finger left,
  // a highlight that came back on returning to the tab. None of that is ours to
  // get wrong now.
  async function showFloatMenu() {
    const menu = ctx?.ui?.showContextMenu;
    if (typeof menu !== "function") {
      // An older Lumiverse without the API. Say where the settings are rather
      // than opening nothing and looking broken.
      log("this version of Lumiverse cannot open the floating button's menu");
      showToast("Auto Retry settings are in the chat bar's Extras popover.", { force: true });
      return;
    }
    if (typeof document === "undefined" || !floatEl || !floatEl.getBoundingClientRect)
      return;
    // One at a time. Android raises contextmenu on a long press as well as
    // running the timer below, so this is asked for twice on the way to one
    // gesture. The host's menu cannot be taken down and rebuilt, so the second
    // call is dropped rather than stacking a menu on the first.
    if (floatMenuToken) return;

    // Anchored to the middle of the button. Not to the pointer: the menu is
    // also raised from the keyboard, and a hold means the finger is over the
    // button anyway, so the button is the one place that is always right.
    const r = floatEl.getBoundingClientRect();
    const position = { x: Math.round(r.left + r.width / 2), y: Math.round(r.bottom) };

    const token = {};
    floatMenuToken = token;

    let selectedKey: string | null = null;
    try {
      const res = await menu.call(ctx.ui, {
        position,
        items: [
          // Settings first. Reaching them otherwise means the input bar's
          // Extras popover, which is several taps away and is the thing someone
          // holding this button is most likely to be after.
          { key: "settings", label: "Auto Retry settings" },
          // Only when there is a panel in the drawer to bring forward. With the
          // panel floating it is already on screen, and an entry that opens
          // what you can see is noise in a menu opened for something else.
          ...(canOpenPanel() ? [{ key: "panel", label: OPEN_PANEL_LABEL }] : []),
          // The two word swap buttons, on the same terms as the panel one:
          // their setting puts them in the Extras menu, and this menu takes
          // them over while the floating button is on screen.
          ...(cfg.showReplaceButton ? [{ key: "swap", label: SWAP_ONE_LABEL }] : []),
          ...(cfg.showSwapAllButton ? [{ key: "swapAll", label: SWAP_ALL_LABEL }] : []),
          // Last, under everything else, because it is the only entry here
          // that closes this menu for good.
          //
          // Switching Auto Retry off in one chat is not here. It lives in the
          // settings panel, under Basics, on the "This chat" row. This menu
          // opens from a button that sits over the chat, so it is worth keeping
          // to the things that are about the button and the ways into the
          // extension; a per-chat switch among them reads as clutter every time
          // you open it for something else.
          //
          // It could not sit here reliably in any case: the entry needs a chat
          // id, which arrives on a generation event, so on a fresh page load it
          // would be missing until the first reply.
          { key: "hide", label: "Hide this button" },
        ],
      });
      selectedKey = (res && res.selectedKey) || null;
    } catch (e) {
      if (floatMenuToken === token) floatMenuToken = null;
      log("float menu failed", e);
      return;
    }

    // Left behind: the button was hidden, or the extension torn down, while
    // this was on screen.
    if (floatMenuToken !== token) return;
    floatMenuToken = null;
    if (selectedKey === "settings") {
      openSettings();
    } else if (selectedKey === "panel") {
      openDrawerPanel();
    } else if (selectedKey === "swap") {
      applyReplaceNow();
    } else if (selectedKey === "swapAll") {
      applyReplaceAllNow();
    } else if (selectedKey === "hide") {
      cfg.showFloatingToggle = false;
      saveSaved();
      hideFloat();
      // Without this it looks like the button broke. Say where it went.
      showToast("Floating button hidden. Turn it back on in Auto Retry settings.", {
        force: true,
      });
    }
  }

  function hideFloat() {
    forgetFloatMenu();
    if (floatSettle) {
      clearTimeout(floatSettle);
      floatSettle = null;
    }
    // Take back what we put in before handing the widget over. Destroying it is
    // the host's job and normally takes the button with it, but if that throws
    // or does nothing the button would sit there with no code behind it, still
    // accepting taps.
    if (floatEl) {
      try { floatEl.remove(); } catch (_) {}
    }
    if (floatWidget) {
      try { floatWidget.destroy(); } catch (_) {}
    }
    floatWidget = null;
    floatEl = null;
    floatWidgetSize = 0;
    // A button that comes back later starts fresh rather than fading in from
    // whatever the last one was showing.
    floatShownOn = null;
    // The document-level pointermove listener calls through this. Left set, it
    // kept a whole button's worth of handlers alive after the button was gone,
    // and every pointer move on the page went on running its hold check.
    holdMoveWatch = null;
    // The Extras menu takes them all back, now that there is no floating
    // button. Hiding the button from its own menu is why this is needed:
    // nothing else runs afterwards, so without it the buttons that had moved
    // into the menu disappeared along with it.
    syncInputBarActions();
  }

  // Where the button is sitting right now, read off the screen. Used after a
  // drag, which is the one time it moves without this extension placing it.
  // Not for carrying the position across a rebuild: feeding a reading back in
  // on every size change walks the button up the screen.
  function floatPos(): { x: number; y: number } | null {
    try {
      const root = floatWidget && floatWidget.root;
      const r = root && root.getBoundingClientRect ? root.getBoundingClientRect() : null;
      if (!r) return null;
      // A box with no size and no position is a root that is not on screen, and
      // there is nothing to read off it. One with no size but a position is a
      // host whose root does not carry the widget's own box, which still knows
      // where it is. Only the corner is taken from here, never the size: the
      // size is floatWidgetSize, which is what this extension asked for.
      if (!r.width && !r.height && !r.left && !r.top) return null;
      return { x: Math.round(r.left), y: Math.round(r.top) };
    } catch (_) {
      return null;
    }
  }

  function syncFloat() {
    if (!cfg.showFloatingToggle) {
      hideFloat();
      return;
    }
    // Width and height are set when the widget is created, so a size change
    // means building it again rather than restyling it.
    //
    // The place it was last put is carried across in floatAt rather than read
    // back off the screen, or a resize would drop the button at the default
    // corner and lose wherever it had been dragged to. Taken from the middle,
    // so it grows around where it sits rather than away from its corner.
    // showFloat still clamps: a button against an edge that gets bigger has to
    // come back on screen, which is where a snapped button belongs anyway.
    if (floatWidget && floatWidgetSize !== floatSize()) {
      const was = floatAt;
      const d = floatSize();
      const at = was
        ? {
            x: Math.round(was.x + floatWidgetSize / 2 - d / 2),
            y: Math.round(was.y + floatWidgetSize / 2 - d / 2),
          }
        : null;
      hideFloat();
      showFloat(at);
    } else {
      showFloat();
    }
    paintFloat();
  }

  // The one place the switch is flipped, so the floating button, the Extras
  // entry and the settings panel can never disagree about the state.
  function toggleEnabled() {
    cfg.enabled = cfg.enabled === false;
    saveSaved();
    // The panel's Save does this and the quick toggle did not, so the one
    // setting people flip most often, from the control built for flipping it,
    // was the one that stayed in this browser. It also never reached the
    // backend, which is what word swapping reads to know the extension is off.
    saveToAccount();
    // The settings panel can be open while this is flipped from somewhere else.
    // Its own checkbox and the "Auto Retry is off" line are brought into line,
    // and so is the baseline the panel restores on dismiss, or closing the panel
    // would put the switch straight back where it was.
    if (modalBaseline) modalBaseline.enabled = cfg.enabled;
    try {
      if (fieldSetters.enabled) fieldSetters.enabled(cfg.enabled);
      applyDeps();
    } catch (_) {}
    if (cfg.enabled === false) {
      chats.forEach((_s: any, id: string) => standDown(id, false));
    }
    showToast(cfg.enabled === false ? "Auto Retry is off." : "Auto Retry is on.", {
      force: true,
    });
    paintFloat();
    syncInputBarActions();
    paintNow();
  }

  // Settings marked live are applied as they are typed. Nothing is saved by
  // this: cfg is what the panel is holding, and closing the panel without
  // saving restores the baseline and re-syncs, which puts it back.
  function onLiveEdit(key: string) {
    try {
      if (key === "floatingToggleSize") syncFloat();
      // Reading "in the sidebar drawer" off a dropdown tells you nothing about
      // whether you want it there. Moving as you pick does, and closing the
      // panel without saving moves it back with everything else.
      if (key === "panelHome") syncLiveLog();
    } catch (_) {}
  }

  // One panel, in one of two places. Whichever it is not in is taken down
  // first, so switching between them can never leave two on screen sharing one
  // body element, with the views rendering into whichever was built last.
  function syncLiveLog() {
    if (!cfg.liveLog) {
      hideLiveLog();
      hideDrawerPanel();
    } else if (cfg.panelHome === "drawer") {
      hideLiveLog();
      // A host with no drawer to put it in gets the floating panel, rather
      // than the switch being on with nothing to show for it.
      if (!showDrawerPanel()) showLiveLog();
    } else {
      hideDrawerPanel();
      showLiveLog();
    }
    renderLiveLog();
    askForPrompts();
    // The Extras entry that opens the drawer exists only while there is a
    // drawer tab to open, so it is re-read here rather than only when a
    // setting changes: this is the one place that registers and drops one.
    syncInputBarActions();
  }

  // Whether the Prompt tab has been opened while this panel has been up.
  //
  // Tied to the panel rather than to the tab, or switching to the log for a
  // moment loses the prompt sent in between, which is most of what anybody does
  // with the panel open. It still takes one visit to the tab to arm: somebody
  // who opens the panel for the log alone has nothing captured for them.
  // Closing the panel forgets it, so the asking starts over next time.
  let promptTabSeen = false;

  // The backend captures a prompt only while somebody is looking at one. Told
  // on every change of tab, open and close, and on teardown, so the cost stops
  // the moment the view does.
  let promptsAsked = false;
  // Only sent when the answer changes, because there is no point repeating it.
  // That holds as long as the backend heard the first one, and it does not
  // always: the two sides have separate lifetimes, so a backend that was not up
  // yet, or that restarted afterwards, is left knowing nothing while this side
  // is certain it has already asked. Nothing then re-sends it, and the tab
  // stays empty until something happens to toggle the view off and on again,
  // which is why leaving the chat and coming back appeared to fix it. force is
  // for the backend saying it has just started.
  function askForPrompts(force?: boolean) {
    const up = !!(liveLogEl || drawerTab);
    if (!up) promptTabSeen = false;
    else if (liveTab === "prompt") promptTabSeen = true;
    const want = !!(cfg.liveLog && up && promptTabSeen);
    if (want === promptsAsked && !force) return;
    promptsAsked = want;
    try {
      if (ctx && typeof (ctx as any).sendToBackend === "function")
        (ctx as any).sendToBackend({ type: "set_prompt_capture", on: want });
    } catch (_) {}
  }
  const disposers: Array<() => void> = [];

  // Coerce a raw saved object (local cache or account storage) into a clean
  // partial config: keep only known fields, run each through its type.
  function coerceSaved(parsed: any): any {
    const out: any = {};
    if (!parsed || typeof parsed !== "object") return out;
    // 4.2.0 held one note in two keys. Anyone who set it on the testing branch
    // keeps it rather than finding the box empty after updating.
    if (!parsed.refusalNotes && parsed.refusalNoteText != null) {
      const text = String(parsed.refusalNoteText || "");
      if (text.trim())
        parsed = Object.assign({}, parsed, {
          refusalNotes: [{ text: text, role: String(parsed.refusalNoteRole || "system") }],
        });
    }
    // The switch that gates the extra dialog labels is off by default, so a
    // saved set of labels with no switch beside it predates the switch. Turning
    // it on for them keeps those labels working rather than quietly dropping
    // them.
    if (
      parsed.confirmButtonsCustom == null &&
      String(parsed.confirmButtonLabels || "").trim()
    )
      parsed = Object.assign({}, parsed, { confirmButtonsCustom: true });
    for (const g of SCHEMA)
      for (const f of g.fields) {
        if (!(f.key in parsed)) continue;
        // The field itself goes through, not just its type. A "pick" is checked
        // against the values it may hold and those live on the field, so
        // without it every saved choice fails that check and falls back to the
        // first option on every load.
        out[f.key] =
          f.type === "num"
            ? clampField(f, parsed[f.key])
            : coerce(
                f.type,
                parsed[f.key],
                // A saved list from before notes carried their own first try
                // takes the value the single setting held, so upgrading changes
                // nothing about when notes go out.
                f.type === "notes"
                  ? Number(parsed.refusalNoteFromTry) || NOTE_FROM_TRY_DEFAULT
                  : (CONFIG as any)[f.key],
                f,
              );
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
  // Returns whether the browser copy was actually written. A browser with site
  // data blocked, or with no room left, throws here. Swallowing that let the
  // panel say "Saved" over settings that were gone on the next reload, which is
  // the one thing a Save button must never do. savePresets has always said.
  function saveSaved(): boolean {
    try {
      if (typeof localStorage === "undefined") return false;
      const out: any = {};
      for (const g of SCHEMA) for (const f of g.fields) out[f.key] = cfg[f.key];
      localStorage.setItem(STORE_KEY, JSON.stringify(out));
      return true;
    } catch (_) {
      return false;
    }
  }
  function coerce(type: FieldType, val: any, fallback: any, f?: Field) {
    if (type === "bool") return !!val;
    if (type === "num") {
      const n = Number(val);
      return Number.isFinite(n) ? n : fallback;
    }
    if (type === "notes") {
      const list = Array.isArray(val) ? val : [];
      const out: Array<{ text: string; role: string; fromTry: number }> = [];
      for (const item of list.slice(0, MAX_NOTES)) {
        const text = item && item.text != null ? String(item.text) : "";
        const role = item && NOTE_ROLES.indexOf(String(item.role)) >= 0 ? String(item.role) : "system";
        // fallback carries the value from the single-note setting, so a list
        // saved before notes had their own first try behaves the same.
        const raw = item && item.fromTry != null ? Number(item.fromTry) : Number(fallback);
        const fromTry = Number.isFinite(raw)
          ? Math.min(NOTE_FROM_TRY_MAX, Math.max(1, Math.round(raw)))
          : NOTE_FROM_TRY_DEFAULT;
        out.push({ text: text, role: role, fromTry: fromTry });
      }
      return out.length ? out : [{ text: "", role: "system", fromTry: NOTE_FROM_TRY_DEFAULT }];
    }
    if (type === "pick") {
      const want = val == null ? "" : String(val);
      const opts = (f && f.options) || [];
      for (const o of opts) if (o.value === want) return want;
      return opts.length ? opts[0].value : fallback;
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
  // The parts import, export and reset are all divided into. A label has to
  // name everything in its own list, not the heading the list grew out of: a
  // part that sounds narrower than it is gets ticked by somebody who then loses
  // what they did not know was in it, and one that sounds broader gets left
  // ticked by somebody expecting it to cover more than it does. Both read as
  // the export having gone wrong.
  //
  // So retrying also says buttons, since it carries whether they are shown, and
  // refusals also says notes, since the note wording rides with it. The preset
  // entry says all, because it moves every kind at once and naming one kind
  // reads as a promise about that kind alone.
  const EXPORT_CATEGORIES: Array<{
    id: string;
    label: string;
    keys: string[];
  }> = [
    {
      id: "retry",
      label: "Retrying and its buttons",
      keys: [
        "enabled",
        "showFloatingToggle",
        "floatingToggleSize",
        "showExtrasToggle",
        "maxRetries",
        "pauseWhenFailing",
        "breakerRuns",
        "breakerPauseMins",
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
      label: "Refusals and notes",
      keys: [
        "retryOnRefusal",
        "refusalUseBuiltins",
        "refusalCatchDisengage",
        "refusalCatchCrisis",
        "refusalIgnoreQuoted",
        "refusalMaxChars",
        "refusalExtraPhrases",
        "refusalPhraseSubs",
        "refusalIgnorePhrases",
        "refusalStripThinking",
        "refusalThinkTags",
        "refusalNote",
        "refusalNotes",
        "refusalNotePlacement",
        "refusalNoteStrictType",
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
        "swapThinking",
        "swapMarkup",
        "confirmBeforeEdit",
        "swapWaitForEdits",
        "swapWaitSecs",
      ],
    },
    {
      id: "buttons",
      label: "Button selectors",
      keys: [
        "regenerateSelector",
        "swipeNextSelector",
        "stopSelector",
        "confirmButtonsCustom",
        "confirmButtonLabels",
      ],
    },
    { id: "notifications", label: "Panel and pop-up", keys: ["toast", "liveLog", "panelHome"] },
    // Special entry: carried outside cfg. buildExport and the import handler
    // treat it as the whole preset store, every kind of preset in it, rather
    // than as settings keys, which is why the label names every kind.
    { id: "presets", label: "All presets", keys: [] },
  ];
  const fieldByKey: Record<string, Field> = {};
  for (const g of SCHEMA) for (const f of g.fields) fieldByKey[f.key] = f;
  // Safety net for the lists above. A setting added to SCHEMA but forgotten in
  // EXPORT_CATEGORIES would otherwise be dropped from every export, which shows
  // up only when somebody restores a backup and finds it missing. Anything
  // unaccounted for is folded into the retry category rather than lost.
  {
    const covered = new Set<string>();
    for (const c of EXPORT_CATEGORIES) for (const k of c.keys) covered.add(k);
    const orphans = Object.keys(fieldByKey).filter((k) => !covered.has(k));
    if (orphans.length) {
      for (const c of EXPORT_CATEGORIES)
        if (c.id === "retry") c.keys = c.keys.concat(orphans);
    }
  }
  // Per-field functions that push a cfg value back into the on-screen control,
  // so applying a preset can update the visible fields in place without a full
  // rebuild (which would jump the scroll and close open sections). Repopulated
  // each time the settings body is built.
  let fieldSetters: Record<string, (v: any) => void> = {};
  // Reapplies the rows that only matter while some switch is on. Held out here
  // beside fieldSetters because the controls that move those switches are built
  // by buildRow, which is its own function. Does nothing until a panel is built.
  let applyDeps: () => void = () => {};
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
      : coerce(f.type, val, (CONFIG as any)[key], f);
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
  // Named snapshots of part of the settings, which the user switches between.
  // One store holding every kind, keyed by kind, kept in this browser and on
  // the account so they follow the user to another device. What each kind
  // covers is PRESET_KINDS below; the bars that drive them are all one
  // function, so a kind added there needs no new UI code.
  const PRESETS_KEY = "lv-auto-retry:presets:v1";
  const PRESET_KINDS: Record<
    string,
    { catId: string; label: string; omit?: string[]; only?: string[] }
  > = {
    swap: {
      catId: "replace",
      label: "Word swap",
      // A preset is the rules plus what decides how they match, and nothing
      // else. Everything omitted here is about whether the feature runs and how
      // careful it is, which belongs to the person loading the preset rather
      // than the person who saved it. replaceEnabled would let a preset start
      // rewriting replies unasked, and confirmBeforeEdit would let one remove a
      // confirmation someone chose to turn on; those two matter most.
      // Exporting still carries all of them.
      omit: [
        "replaceEnabled",
        "showReplaceButton",
        "showSwapAllButton",
        "allowReSwap",
        "swapThinking",
        "swapMarkup",
        "confirmBeforeEdit",
        "swapWaitForEdits",
        "swapWaitSecs",
      ],
    },
    notes: {
      catId: "refusal",
      // Named by what is in it, not by the section it comes from, since the
      // refusal category also carries the detection settings.
      label: "Refusal note",
      // Listed as what to keep rather than what to leave out. The category this
      // reads from is mostly detection tuning, so an omit list would be twelve
      // keys to hold two, and a refusal setting added later would land in note
      // presets without anyone deciding it should.
      //
      // The on and off switch is kept out. Loading a preset would
      // otherwise start sending notes to the model for somebody who had turned
      // that off, which is not a thing a saved set of wording should decide.
      only: ["refusalNotes", "refusalNotePlacement"],
    },
  };
  // Derived from the export category so the two stay in step, minus whatever
  // that kind omits. Load walks this list rather than the stored values, so a
  // preset saved before an omission ignores the extra keys.
  function keysForKind(kind: string): string[] {
    const k = PRESET_KINDS[kind];
    if (!k) return [];
    const omit = k.omit || [];
    for (const c of EXPORT_CATEGORIES)
      if (c.id === k.catId)
        return k.only && k.only.length
          ? c.keys.filter((key) => (k.only as string[]).indexOf(key) >= 0)
          : c.keys.filter((key) => omit.indexOf(key) < 0);
    return [];
  }
  type Preset = { name: string; values: Record<string, any> };
  // Keep only what a preset is allowed to be, whatever the source. The same
  // check runs on the local copy and on anything the account hands back, so a
  // malformed or hand-edited store cannot put junk into the dropdown.
  function coercePresets(data: any): Record<string, Preset[]> {
    const out: Record<string, Preset[]> = { swap: [], notes: [] };
    if (!data || typeof data !== "object") return out;
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
  }
  function loadPresets(): Record<string, Preset[]> {
    try {
      if (typeof localStorage === "undefined") return coercePresets(null);
      const raw = localStorage.getItem(PRESETS_KEY);
      if (!raw) return coercePresets(null);
      return coercePresets(JSON.parse(raw));
    } catch (_) {
      return coercePresets(null);
    }
  }
  // Presets now follow the account as well, the way settings already did. The
  // browser copy stays the synchronous source every caller reads; the account
  // copy is what makes them turn up on another device.
  function savePresetsToAccount(all: Record<string, Preset[]>) {
    try {
      if (ctx && typeof (ctx as any).sendToBackend === "function") {
        (ctx as any).sendToBackend({ type: "save_presets", presets: all });
      }
    } catch (_) {}
  }
  function savePresets(all: Record<string, Preset[]>): boolean {
    savePresetsToAccount(all);
    try {
      if (typeof localStorage === "undefined") return false;
      localStorage.setItem(PRESETS_KEY, JSON.stringify(all));
      return true;
    } catch (_) {
      return false;
    }
  }
  // Pull the account's presets on load. The account wins when it has any; when
  // it has none but this browser does, this browser's are migrated up, which is
  // the same rule the settings use so the two cannot disagree about which copy
  // is authoritative.
  function loadPresetsFromAccount() {
    try {
      if (!ctx || typeof (ctx as any).sendToBackend !== "function" || typeof (ctx as any).onBackendMessage !== "function") return;
      const reqId = "ar-presets-" + Date.now() + "-" + Math.random().toString(36).slice(2);
      const off = (ctx as any).onBackendMessage((msg: any) => {
        if (!msg || msg.type !== "loaded_presets" || msg.requestId !== reqId) return;
        try { off && off(); } catch (_) {}
        const incoming = coercePresets(msg.presets);
        const local = loadPresets();
        // Per kind, not all or nothing. The account winning outright would drop
        // a kind it has none of, which is exactly what happens the first time
        // somebody saves a note set on a device whose account only knows about
        // word swaps.
        const merged: Record<string, Preset[]> = {};
        let took = 0, kept = 0;
        for (const kind of Object.keys(local)) {
          const there = incoming[kind] || [];
          if (there.length) { merged[kind] = there; took += there.length; }
          else { merged[kind] = local[kind] || []; kept += merged[kind].length; }
        }
        if (took) {
          try {
            if (typeof localStorage !== "undefined")
              localStorage.setItem(PRESETS_KEY, JSON.stringify(merged));
          } catch (_) {}
          for (const r of presetBarRefreshers) r();
          log("brought " + took + (took === 1 ? " preset" : " presets") + " down from the account");
        }
        // Anything the account did not have goes up, so the two agree either
        // way round rather than only when the account was already ahead.
        if (kept) {
          savePresetsToAccount(merged);
          log("sent " + kept + (kept === 1 ? " preset" : " presets") + " up to the account");
        }
      });
      disposers.push(() => { try { off && off(); } catch (_) {} });
      (ctx as any).sendToBackend({ type: "load_presets", requestId: reqId });
    } catch (_) {}
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

  // ---- chats it has been told to leave alone ----
  //
  // The master switch is all or nothing, which is the wrong shape for the case
  // it keeps meeting: a scene where the model is meant to refuse, or a chat
  // being used to test something, in the middle of a day of ordinary chats.
  // Turning the whole extension off for that means remembering to turn it back
  // on, and forgetting looks exactly like the extension having stopped working.
  //
  // Kept in the browser rather than in the settings. It is a list of chat ids,
  // which are not settings, would be meaningless on another account, and have
  // does not belong in an export somebody might share.
  const CHATS_OFF_KEY = "lv-auto-retry:chats-off:v1";
  const CHATS_OFF_CAP = 200;
  let chatsOff: string[] = [];
  try {
    if (typeof localStorage !== "undefined") {
      const raw = JSON.parse(localStorage.getItem(CHATS_OFF_KEY) || "[]");
      if (Array.isArray(raw)) chatsOff = raw.map(String).slice(-CHATS_OFF_CAP);
    }
  } catch (_) { /* no storage: nothing is off, which is the harmless way round */ }

  const chatIsOff = (chatId: any): boolean =>
    chatId != null && chatsOff.indexOf(String(chatId)) >= 0;

  // Chats the host says have no character card on them, which is the temporary
  // chat: a scratch conversation with the model itself, discarded on the way
  // out. Switching one off works for as long as it is open and is not written
  // down, because the chat is thrown away and the next one carries
  // a different id, so a remembered entry could never match anything again. It
  // would sit in storage looking like a setting and doing nothing.
  const cardless = new Set<string>();
  const isCardless = (chatId: any): boolean =>
    chatId != null && cardless.has(String(chatId));

  // The off list lives in this browser and is not a setting, so it is not in
  // what gets saved to the account and the backend cannot read it. Word swaps
  // run on the backend, so without this a chat you switched off carried on
  // having its replies rewritten, which is not what "left alone" means.
  function tellBackendChatsOff() {
    try {
      if (ctx && typeof (ctx as any).sendToBackend === "function")
        (ctx as any).sendToBackend({ type: "set_chats_off", chats: chatsOff.slice() });
    } catch (_) {}
  }

  // Returns whether this browser will remember the change after a reload.
  function setChatOff(chatId: any, off: boolean): boolean {
    if (chatId == null) return false;
    const id = String(chatId);
    const at = chatsOff.indexOf(id);
    if (off && at < 0) chatsOff.push(id);
    else if (!off && at >= 0) chatsOff.splice(at, 1);
    // Oldest first, so a long history of one-off exclusions cannot grow without
    // bound in somebody's browser.
    if (chatsOff.length > CHATS_OFF_CAP) chatsOff = chatsOff.slice(-CHATS_OFF_CAP);
    // Whether this browser will still know about it after a reload. The switch
    // itself works either way, because the list is held in memory; a browser
    // that blocks site data just forgets it. The docs say this is remembered,
    // so a browser that will not remember it has to say so.
    let remembered = false;
    // Temporary chats are filtered out of what gets written, not out of the
    // list itself: the switch has to hold for the chat that is open, and the
    // backend still needs to be told so its word swaps leave that chat alone.
    // Filtering here rather than at the point of the change also keeps a later
    // switch in an ordinary chat from writing the temporary one down with it.
    const keep = chatsOff.filter((c) => !cardless.has(c));
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(CHATS_OFF_KEY, JSON.stringify(keep));
        remembered = !cardless.has(id);
      }
    } catch (_) {}
    tellBackendChatsOff();
    // Anything already in flight for that chat goes with it.
    if (off) standDown(id, false);
    // Every one of these describes the chat that just changed, so they are all
    // repainted here rather than by whoever called. Repainting from a click
    // handler instead would leave any other way in stale: the line at the top
    // of the panel changes the same thing and does not touch the row, so the
    // row would go on offering a switch that had already been flipped.
    if (chatSwitchPaint) {
      try { chatSwitchPaint(); } catch (_) {}
    }
    paintFloat();
    syncMasterNote();
    // The Extras entry carries the state in its label, and it is the one place
    // that has to be registered again to change rather than repainted.
    syncToggleAction();
    paintNow();
    return remembered;
  }

  // Both switches have to be on for anything to happen, and this is the one
  // place that says so.
  const retryingHere = (chatId: any): boolean =>
    cfg.enabled !== false && !chatIsOff(chatId);

  // The line at the top of the panel. Two things can be stopping a retry and
  // they need different answers, so it names which one and offers the way back
  // from the one that has a button.
  let masterNoteEl: any = null;
  function syncMasterNote() {
    if (!masterNoteEl) return;
    const globalOff = cfg.enabled === false;
    const hereOff = chatIsOff(lastChatId);
    masterNoteEl.style.display = globalOff || hereOff ? "block" : "none";
    masterNoteEl.textContent = globalOff
      ? hereOff
        ? "Auto Retry is off everywhere, and this chat is switched off as well. These settings are saved and apply when you turn it back on."
        : "Auto Retry is off. These settings are saved and apply when you turn it back on."
      : "Auto Retry is on, but it is switched off in this chat.";
    try { ensureReadableTree(masterNoteEl, 2.6); } catch (_) {}
  }

  // ---- per-chat state ----
  // Each chat gets a state object that holds its retry budget, its watchdog
  // timers and, while a reply is streaming, the text so far. Only cleared on
  // teardown before, so browsing through a lot of chats in one sitting left a
  // state object behind for every one of them, streamed text and all.
  const chats = new Map<string, any>();
  // Chat ids arrive from the host and nothing promises they are the same type
  // on every event. A build that sent a string on the start of a generation and
  // a number on its end got two state objects for one chat, so the end cleared
  // the watchdogs of a chat that was not running and left the real ones armed.
  // The one that was still armed then fired on a reply that had finished, and
  // re-rolled it as stalled. Every lookup goes through here so that cannot
  // happen again, whatever a build sends.
  const chatKey = (chatId: any): string => String(chatId == null ? "" : chatId);
  // The key a generation is filed under when the host names no chat for it.
  //
  // Everything here is keyed by chat, so a reply arriving with no chatId used
  // to fall out of every handler: no retry, no watchdog, no line in the log,
  // and nothing on the panel to say why. The host names the chat on every
  // build seen so far, which makes this a guard rather than a fix for a known
  // case, and the reason it is worth having is that the failure was silent.
  //
  // A sentinel rather than an empty string, because an empty string is what
  // chatKey already produces for null, and the end event tells "the chat this
  // generation started in" from "nothing was remembered" by that emptiness.
  // Real ids are host uuids, so nothing can collide with this.
  //
  // Only the internal state is keyed on it. Anything the user acts on through
  // a chat id, the per-chat switch and the swap buttons, keeps refusing when
  // there is no real id to act on, since there is nothing for them to name.
  const NO_CHAT = "lv-no-chat";
  const chatOf = (p: any): string => {
    const id = p && p.chatId;
    return id == null || id === "" ? NO_CHAT : String(id);
  };
  // Which chat each generation was started in. A watchdog is armed for one
  // generation but can only be called off through its chat's state, so an end
  // event that cannot find that state leaves the watchdog running. This answers
  // the question the end event sometimes cannot: which chat is this.
  //
  // Bounded, and oldest first, because a long session generates a lot of these
  // and only the ones still in the air can matter.
  const genChats = new Map<string, string>();
  const GEN_MEMORY_MAX = 40;
  const genKey = (generationId: any): string =>
    generationId == null ? "" : String(generationId);
  function rememberGeneration(generationId: any, chatId: any) {
    const g = genKey(generationId);
    if (!g) return;
    genChats.set(g, chatKey(chatId));
    while (genChats.size > GEN_MEMORY_MAX)
      genChats.delete(genChats.keys().next().value as string);
  }
  // Which chat an event that follows a start belongs to. The start is what
  // decides where a generation's state lives, so every later event for that
  // generation is answered from what the start wrote down, and falls back to
  // the event's own chatId only when nothing was remembered for it.
  //
  // Reading the payload first is not the same thing. A build that names the
  // chat differently on a token than it did on the start, or leaves it off,
  // sends the handler to a state the start armed nothing on, and a watchdog
  // nothing can reach re-rolls a reply that is streaming or already finished.
  const chatForGeneration = (p: any): string => {
    const remembered = genChats.get(genKey(p && p.generationId));
    return remembered != null && remembered !== "" ? remembered : chatOf(p);
  };
  const CHATS_MAX = 24; // chats kept before the quietest are let go
  // Anything mid-flight has to stay: dropping it would strand a running
  // watchdog and lose the budget for a retry that is already in the air.
  const chatIsBusy = (s: any): boolean =>
    !!(s && (s.pending || s.timer || s.startTimer || s.idleTimer || s.startWatchdog ||
      s.expectingStart || s.attempts > 0 || Date.now() < s.suppressUntil));
  // Recency is a field rather than the Map's own insertion order. Re-inserting
  // a chat to mark it as used would move it to the end of the Map, and two
  // places walk the Map calling standDown, which touches each chat as it goes:
  // an entry moved past the cursor gets visited again, forever.
  function evictIdleChats() {
    if (chats.size <= CHATS_MAX) return;
    const idle = Array.from(chats.entries())
      .filter(([, s]) => !chatIsBusy(s))
      .sort((a, b) => (a[1].lastSeen || 0) - (b[1].lastSeen || 0));
    for (const [id] of idle) {
      if (chats.size <= CHATS_MAX) break;
      chats.delete(id);
    }
  }
  const st = (chatId: any) => {
    const key = chatKey(chatId);
    let s = chats.get(key);
    if (s) {
      s.lastSeen = Date.now();
      return s;
    }
    s = {
      lastSeen: Date.now(),
      attempts: 0,
      pending: false,
      selfTriggered: false,
      genId: null,
      startTimer: null,
      idleTimer: null,
      timer: null,
      retryAt: 0, // when the pending retry fires, for the live countdown
      retryReason: "",
      live: false, // a reply is in the air right now
      liveSince: 0, // when it went live, so a state with no number of its own has one
      sawReasoning: false,
      sawContent: false,
      buf: "", // streamed reply text, used when the end event carries no content
      ignored: new Set(),
      // Generations whose ending has already been judged. A build that reports
      // one generation as ended twice used to get two verdicts out of it, and
      // the second landed after the extension had given up, which hands back a
      // fresh budget: the cap said two tries and the reply was re-rolled until
      // something else stopped it. One ending, one verdict.
      judged: new Set(),
      suppressUntil: 0,
      startWatchdog: null,
      expectingStart: 0,
    };
    chats.set(key, s);
    evictIdleChats();
    return s;
  };
  // Whether this build streams. Nothing exposes the setting, so it is learned
  // from what arrives: one token proves streaming is on, and a generation that
  // finished with text while never sending one proves it is off. Until a whole
  // generation has gone by, neither is known, and the line says the careful
  // thing rather than guessing.
  let sawStreaming = false;
  let sawWholeReplyAtOnce = false;

  // Circuit breaker. Whole runs that gave up, back to back. Three in a row means
  // the provider is down rather than one reply being unlucky, so retrying again
  // on every message just spends tokens for nothing.
  const BREAKER_RUNS_DEFAULT = 3;
  const BREAKER_PAUSE_DEFAULT_MS = 300000;
  let failedRuns = 0;
  let pausedUntil = 0;
  // A running tally of what the extension has actually done since it loaded.
  // The event log keeps only the last twenty lines, so on a long session the
  // shape of a problem ("it retried ninety times, all of them for 'cut off'")
  // has scrolled away by the time anyone thinks to look. These counters do not
  // scroll away, so a bug report can say what actually happened instead of only
  // "it retries too much".
  const stats = {
    retries: 0,
    gaveUp: 0,
    good: 0,
    // Notes the backend confirmed it attached, and notes it dropped with the
    // reason. Counted because "did my note actually go out" is otherwise only
    // answerable by watching the log at the moment it happened, and a bug
    // report written afterwards cannot say either way.
    notesSent: 0,
    notesSkipped: 0,
    lastNoteSkip: "",
    reasons: {} as Record<string, number>,
    // Retries per chat id. A card whose replies keep needing a retry is the
    // thing this answers, and a count across every chat cannot show it. Ids
    // rather than names, because a name can arrive later than the first retry.
    byChat: {} as Record<string, number>,
    // Words swapped per chat id, counted the same way. A swap leaves no trace
    // in the chat once it has landed, since the reply simply reads as though
    // the model wrote it that way, so without a count there is nothing to look
    // at to answer "is this rule doing anything".
    swapsByChat: {} as Record<string, number>,
    // So a count can be read as a rate rather than as a bare number. Twelve
    // retries in ten minutes and twelve in a whole day are different problems.
    since: Date.now(),
  };
  // ---- what it is doing, right now ----
  //
  // Worked out on demand from the timers that are actually running, with one
  // clock repainting whoever is showing it. Writing a line once, at the moment
  // something happens, leaves it stale: "in 47.3s" would say that for the next
  // forty-seven seconds, and a countdown that does not move looks like an
  // extension that has stopped.


  // The one line that says what is happening. Read fresh every tick.
  //
  // Ordered by what would stop a retry from happening, most final first, so the
  // line never says it is waiting to retry in a chat where it would not.
  // What one chat is doing, or nothing if it is doing nothing worth saying.
  function chatStatus(s: any): { text: string; busy: boolean } | null {
    if (!s) return null;
    // Read from when the retry is due rather than from the timer that fires it.
    // The timer is assigned after the message is built, so asking for the timer
    // meant the first paint fell through to whatever else was true and the
    // pop-up opened saying nothing about the wait, picking the countdown up a
    // quarter of a second later. Both are cleared together in clearTimers, so
    // this says exactly what the timer said and says it sooner.
    if (s.retryAt)
      return {
        text:
          (s.retryReason ? s.retryReason + ". " : "") +
          "Retrying in " + sayTime(s.retryAt - Date.now()) +
          " (try " + s.attempts + " of " + cfg.maxRetries + ")",
        busy: true,
      };
    // Same reasoning as the two below, and this one already holds the moment it
    // began. A click that has not turned into a generation yet can sit here for
    // a while on a slow provider, and it is the state somebody is most likely
    // to be staring at, having just pressed something.
    if (s.expectingStart) {
      const waiting = Date.now() - s.expectingStart;
      return {
        text: "Waiting for the retry to start" + (waiting >= 1000 ? ", " + sayTime(waiting) : ""),
        busy: true,
      };
    }
    if (s.live && s.sawContent)
      return { text: "Reply arriving, " + rough(String(s.buf || "").length) + " characters", busy: true };
    // These two are the only busy states with no figure of their own. A reply
    // arriving counts characters and a retry counts down, so both visibly move;
    // these said one fixed sentence for as long as they lasted, which on a
    // model that thinks for a minute is indistinguishable from the panel having
    // frozen. How long it has been going is the number they were missing.
    const forMs = s.liveSince ? Date.now() - s.liveSince : 0;
    const soFar = forMs >= 1000 ? ", " + sayTime(forMs) : "";
    if (s.live && s.sawReasoning) return { text: "Model is thinking" + soFar, busy: true };
    // With streaming off the reply arrives in one piece at the end, so there is
    // nothing to count and nothing on the way. "Waiting for the reply to start"
    // is then wrong twice over: it has started, and nothing is going to arrive
    // before it is finished.
    if (s.live)
      return {
        text:
          (!sawStreaming && sawWholeReplyAtOnce
            ? "Generating the reply"
            : "Waiting for the reply to start") + soFar,
        busy: true,
      };
    return null;
  }

  function liveStatus(): { text: string; busy: boolean; state: "off" | "idle" | "busy" } {
    const now = Date.now();
    // Three states, not two. Off is not the same as on with nothing to do, and
    // the dot says which without anyone having to read the line.
    const off = (text: string) => ({ text: text, busy: false, state: "off" as const });
    if (cfg.enabled === false) return off("Off");
    if (chatIsOff(lastChatId)) return off("Off in this chat");
    if (pausedUntil > now)
      return off("Paused after repeated failures, back in " + sayTime(pausedUntil - now));
    // The chat in front of you comes first. A retry running in a chat you have
    // since navigated away from is still worth saying, but not over the top of
    // what is happening here.
    if (lastChatId != null) {
      const here = chatStatus(chats.get(chatKey(lastChatId)));
      if (here) return { text: here.text, busy: true, state: "busy" };
    }
    for (const [id, s] of chats) {
      if (id === lastChatId) continue;
      const other = chatStatus(s);
      if (other) return { text: other.text + ", in another chat", busy: true, state: "busy" };
    }
    return { text: "Watching. Nothing to do", busy: false, state: "idle" };
  }

  // One clock for everything that shows a live figure, rather than one per
  // thing. It runs only while something is on screen to repaint and stops on
  // its own the moment nothing is, so an idle tab is not ticking for nobody.
  const TICK_MS = 250;
  let tick: any = null;
  const tickers = new Set<() => void>();
  function retick() {
    if (!tickers.size) {
      if (tick) {
        clearInterval(tick);
        tick = null;
      }
      return;
    }
    if (tick) return;
    tick = setInterval(runTickers, TICK_MS);
  }
  // A snapshot of the list, because a ticker is allowed to add or drop one:
  // the Stats view redraws itself when a pause ends, which replaces its own.
  function runTickers() {
    for (const f of Array.from(tickers)) {
      try { f(); } catch (_) {}
    }
  }
  // Between ticks nothing is happening, so the clock's quarter second is fine
  // for a number counting down on its own. It is not fine for something that
  // just changed: a retry being scheduled, or called off, would sit there
  // unsaid for up to a quarter of a second while the pop-up beside it already
  // said otherwise. Anything that changes the state calls this and the two stay
  // in step.
  function paintNow() {
    runTickers();
  }
  function addTicker(f: () => void) {
    tickers.add(f);
    retick();
  }
  function removeTicker(f: () => void) {
    tickers.delete(f);
    retick();
  }

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
    // Cleared with the timer it belongs to, or the status line would go on
    // counting down to a retry that was called off.
    s.retryAt = 0;
    s.retryReason = "";
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
  // Everything the extension itself puts on the page carries this, and nothing
  // it clicks may sit inside one.
  //
  // The button selectors are patterns, not addresses, and the extension's own
  // panel is full of buttons with words like reroll and swipe on them because
  // that is what its settings are called. Its own description button for
  // "Retry by adding a new reroll" matches the built-in swipe pattern exactly,
  // so with the panel open a retry opened a description instead of retrying,
  // and the reader watching the log saw the extension do nothing.
  //
  // Three guards were already written for this, all of them keyed on an id
  // nothing ever set, so all three were doing nothing.
  const OWN_UI = "[data-ar-ui]";
  const markOwnUI = (el: any) => {
    try { el && el.setAttribute && el.setAttribute("data-ar-ui", "1"); } catch (_) {}
  };
  const clickable = (el: any): boolean => {
    if (!el) return false;
    try {
      if (el.closest && el.closest(OWN_UI)) return false;
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

  // Which control a retry clicks. retryByNewReroll picks the preferred one and
  // the other is the fallback, chosen at click time from what is on screen and
  // clickable. The reason for the retry does not come into it.
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
        "Auto Retry could not find your regenerate button. Set it in Auto Retry settings.",
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
    // Nothing is in the air once we have stood down. Without this the status
    // line went on saying the model was thinking after a reply was stopped,
    // because the flag was only ever cleared when a generation ended and a stop
    // does not always end one. A chunk arriving puts it back, so a reply that
    // really is still streaming corrects this by itself.
    s.live = false;
    // A stopped reply does not end, so nothing else would drop the half of it
    // that streamed. It has no use once the retry is off.
    s.buf = "";
    s.suppressUntil = Date.now() + STAND_DOWN_MS;
    // Unconditionally, not only when something was pending. The pop-up carries
    // the Cancel button that leads here, so it staying on screen after Cancel
    // was pressed is the one outcome it must never have, and that is exactly
    // what happened once the retry had already fired: nothing was pending any
    // more, so the box was left where it was and Cancel looked broken.
    hideToast();
    if (hadPending) {
      // The retry this note was armed for is off, so the note goes with it.
      disarmRefusalNote(chatId);
      if (announce) showToast("Auto Retry stopped.");
      log("stopped retrying in this chat", chatId);
    }
    // Called off is a change too, and the one people are watching for after
    // pressing Cancel.
    paintNow();
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
  // Order is preference. Skip comes first: it means "carry on without
  // the optional step", which is exactly what an unattended retry wants, and it
  // avoids submitting guidance the user saved for a retry they meant to steer
  // themselves. Anything that would abandon the action lives in the deny list
  // below, so Skip can never stand in for Cancel.
  //
  // "continue" is left out too: that is a toolbar action of its own,
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
  // Longest a dialog may stay hidden under any circumstances.
  const HIDE_FAILSAFE_MS = 4000;
  const HIDE_CLASS = "__lvRetryHidden";
  const DIALOG_SELECTOR =
    '[role="dialog"],[role="alertdialog"],[aria-modal="true"],[class*="modal" i],[class*="dialog" i],[class*="overlay" i]';

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
    // Dialogs already open go in the same set, so one the user opened before the
    // retry is never mistaken for one the retry raised, and never hidden.
    try {
      const dialogs = document.querySelectorAll(DIALOG_SELECTOR);
      for (const el of Array.prototype.slice.call(dialogs)) out.add(el);
    } catch (_) {}
    return out;
  }

  // Labels the user added, lower-cased and trimmed. Read fresh each time so a
  // settings change takes effect without a reload.
  //
  // The switch above the box genuinely gates it. A row hidden by a switch has
  // to be a row the code ignores, or the panel is showing one thing and doing
  // another: text left in a hidden box would go on being pressed with nothing
  // on screen to say so.
  function userConfirmLabels(): string[] {
    if (!cfg.confirmButtonsCustom) return [];
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
      // choice they made, so it is allowed through.
      const chosen = userConfirmLabels().indexOf(label.toLowerCase()) >= 0;
      if (!chosen && CONFIRM_DENY.test(label)) continue;
      if (!inDialog(el)) continue; // a bare toolbar button is not a confirmation
      if (!clickable(el)) continue;
      try {
        // Never our own panels.
        if (el.closest && el.closest("[data-ar-ui]")) continue;
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

  // The browser draws its own clear button inside a search field, and picks its
  // colour from the page's colour scheme rather than from any CSS. On a dark
  // page that is a white cross, which is the one thing in this panel that does
  // not follow the theme, because it is the browser's element and not ours.
  // Replacing the glyph with a masked shape lets it take a theme colour like
  // everything else. A pseudo-element cannot be styled inline, so this needs a
  // real stylesheet.
  //
  // The fill is currentColor, which is the field's own text colour, rather than
  // a theme variable. Naming a variable means naming a fallback for the themes
  // that do not set it, and every fallback in this file is a dark one, so a
  // light theme that set the common colours and not that one painted a
  // near-white cross on a near-white field. There is nothing to fall back to
  // here: the field's text colour is whatever the theme asked for, and
  // styleField has already had ensureReadable correct it if it did not read
  // against the field. Whatever the cross inherits is therefore legible by the
  // time it is used, on any theme, with nothing to measure and nothing to keep
  // in step. The opacity is what makes it quieter than the text, and going to
  // full strength is what marks the hover.
  //
  // Chrome and Safari only. Firefox puts no clear button in a search field at
  // all, so there is nothing there to restyle and nothing to break.
  const SEARCH_X =
    "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z'/%3E%3C/svg%3E\")";
  // The only animation in the extension. Everything else paints instantly. This
  // one is here because it is the only thing on screen saying work is happening
  // right now, rather than reporting what already happened. Opacity and a
  // shadow only, so it composites without laying out anything, and it is off
  // for anyone whose system asks for less movement: the glow stays, which is
  // what carries the meaning, and only the movement goes.
  let statusStyleEl: any = null;
  function ensureStatusStyle() {
    if (statusStyleEl || typeof document === "undefined") return;
    try {
      const el = document.createElement("style");
      el.id = "__lvRetryStatusStyle";
      el.textContent =
        "@keyframes lvRetryPulse{0%,100%{opacity:1}50%{opacity:.45}}" +
        "@media (prefers-reduced-motion:reduce){" +
        "#__lvRetryStatus [data-ar-state]{animation:none !important}}";
      (document.head || document.documentElement).appendChild(el);
      statusStyleEl = el;
    } catch (_) {}
  }

  let floatStyleEl: any = null;
  function ensureFloatStyle() {
    if (floatStyleEl || typeof document === "undefined") return;
    try {
      const el = document.createElement("style");
      el.id = "__lvRetryFloatStyle";
      el.textContent =
        "[data-ar-float]{transition:background-color var(--lumiverse-transition-fast,150ms ease)," +
        "border-color var(--lumiverse-transition-fast,150ms ease)," +
        "color var(--lumiverse-transition-fast,150ms ease)," +
        "opacity var(--lumiverse-transition-fast,150ms ease)}" +
        "[data-ar-float] svg{transform-origin:50% 50%}" +
        "@keyframes lvRetryFloatMark{from{opacity:0;transform:scale(.72)}to{opacity:1;transform:scale(1)}}" +
        "@media (prefers-reduced-motion:reduce){" +
        "[data-ar-float]{transition:none}" +
        "[data-ar-float] svg{animation:none !important}}";
      (document.head || document.documentElement).appendChild(el);
      floatStyleEl = el;
    } catch (_) {}
  }

  let panelStyleEl: any = null;
  function ensurePanelStyle() {
    if (panelStyleEl || typeof document === "undefined") return;
    try {
      const el = document.createElement("style");
      el.id = "__lvRetryPanelStyle";
      el.textContent =
        "#" + SEARCH_ID + "::-webkit-search-cancel-button{" +
        "-webkit-appearance:none;appearance:none;width:14px;height:14px;cursor:pointer;" +
        "background-color:currentColor;opacity:.6;" +
        "-webkit-mask:" + SEARCH_X + " center/contain no-repeat;" +
        "mask:" + SEARCH_X + " center/contain no-repeat}" +
        "#" + SEARCH_ID + "::-webkit-search-cancel-button:hover{opacity:1}" +
        // The browser's own up and down arrows on a number box. They are drawn
        // by the browser rather than the theme, so on a dark panel they arrive
        // as a pair of small grey chevrons that belong to no design here. The
        // value is typed, and a focused box still steps with the arrow keys, so
        // nothing is lost with them gone.
        "[data-ar-num]::-webkit-outer-spin-button,[data-ar-num]::-webkit-inner-spin-button" +
        "{-webkit-appearance:none;appearance:none;margin:0}" +
        "[data-ar-num]{-moz-appearance:textfield;appearance:textfield}" +
        // The mark on a button reached by keyboard. In the stylesheet rather
        // than set inline because only a stylesheet can ask :focus-visible.
        // The browser's own ring goes either way. Ours replaces it, and a
        // button the extension focused itself is not meant to be marked at all.
        "[data-ar-btn]:focus-visible{outline:none}" +
        // Ours, and not on one the extension focused itself: see focusQuietly.
        "[data-ar-btn]:not([data-ar-quiet]):focus-visible" +
        "{box-shadow:" + FOCUS_RING + "}" +
        // The "?" beside each setting. Its size is here rather than inline on
        // the button because an inline style cannot be answered by a media
        // query, and this needs one: 18px is comfortable under a mouse and
        // small under a thumb, so a screen that is touched gets 28px, which
        // clears the 24px minimum target size. A computer keeps the smaller
        // one, where the pointer is precise and the rows are read a screenful
        // at a time.
        //
        // The button itself grows rather than an invisible hit area being laid
        // over it. Each "?" sits at the end of a row that is one large label,
        // so a hit area reaching past the button would take taps meant for the
        // setting it explains.
        "button[data-ar-hint]{width:18px;height:18px;font-size:11px}" +
        "@media (pointer:coarse){" +
        "button[data-ar-hint]{width:28px;height:28px;font-size:14px}}";
      (document.head || document.documentElement).appendChild(el);
      panelStyleEl = el;
    } catch (_) {}
  }

  // Dialogs currently hidden. Hiding is done with a class and a rule marked
  // important, not by writing inline styles: the dialog fades itself in by
  // setting inline opacity every frame, so an inline value of ours would just be
  // overwritten and the dialog would appear anyway. A stylesheet rule marked
  // important outranks an inline value that isn't.
  let hidden: any[] = [];
  let hideFailsafe: any = null;
  let hideStyleEl: any = null;

  function ensureHideStyle() {
    if (hideStyleEl || typeof document === "undefined") return;
    try {
      const el = document.createElement("style");
      el.id = "__lvRetryHideStyle";
      el.textContent =
        "." + HIDE_CLASS + "{opacity:0!important;pointer-events:none!important;transition:none!important;animation:none!important}";
      (document.head || document.documentElement).appendChild(el);
      hideStyleEl = el;
    } catch (_) {}
  }

  function restoreHiddenDialogs() {
    if (hideFailsafe) {
      clearTimeout(hideFailsafe);
      hideFailsafe = null;
    }
    for (const el of hidden) {
      try {
        el.classList.remove(HIDE_CLASS);
      } catch (_) {}
    }
    hidden = [];
  }

  // Anything dialog-shaped that has turned up since the retry click. Hidden
  // rather than removed, and with pointer events switched off so that even in
  // the worst case an unseen dialog cannot swallow taps.
  function hideNewDialogs(before: Set<any>) {
    if (typeof document === "undefined") return;
    let list: any = [];
    try {
      list = document.querySelectorAll(DIALOG_SELECTOR);
    } catch (_) {
      return;
    }
    for (const el of Array.prototype.slice.call(list)) {
      if (before.has(el)) continue; // was already on screen, not ours
      if (hidden.indexOf(el) >= 0) continue;
      try {
        if (el.closest && el.closest("[data-ar-ui]")) continue;
      } catch (_) {}
      try {
        ensureHideStyle();
        el.classList.add(HIDE_CLASS);
        hidden.push(el);
      } catch (_) {}
    }
    if (hidden.length && !hideFailsafe) {
      // Independent of everything else. If the watch is somehow never wound up,
      // this still puts the dialog back rather than leaving it invisible.
      hideFailsafe = setTimeout(restoreHiddenDialogs, HIDE_FAILSAFE_MS);
    }
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
    // A dialog only stays hidden while it is actively being clicked through.
    // The moment the watch ends, for any reason, it goes back on screen.
    restoreHiddenDialogs();
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
    // Out of sight before it is identified, so there is nothing to see even on a
    // slow device. If it turns out not to be dismissable, the restore above puts
    // it straight back.
    hideNewDialogs(before);
    const btn = findNewConfirm(before);
    if (!btn) return false;
    if (confirmClicks >= CONFIRM_MAX_CLICKS) {
      log("dialog did not respond to being confirmed; leaving it alone");
      clearConfirmWatch();
      return true;
    }
    confirmClicks += 1;
    log("a dialog opened after the retry click; confirming it");
    // Kept in the hidden list until the watch ends: if this press dismisses it
    // the element goes away and restoring it is a no-op, and if it does not the
    // dialog reappears rather than being stranded.

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

  const START_WAIT_ROUNDS = 3; // extra grace rounds while something is generating
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
      disarmRefusalNote(chatId);
      s.selfTriggered = false;
      s.attempts = 0;
    }, START_GRACE_MS);
  }

  // The chat a note is currently armed for, or null when none is. A chat id
  // rather than a flag, because a retry called off in one chat says nothing
  // about a note waiting on a click in another, and taking that one back would
  // quietly drop a note the user is still owed. The backend holds one at a
  // time, so one id is enough to describe the whole state.
  let armedNoteChat: string | null = null;

  // Take a note back when the click it was armed for never happened. The
  // backend reads an empty list as "nothing armed", so a disarm is the same
  // message carrying nothing. Without it the note sat waiting out its full
  // minute and could then attach itself to a regenerate the user pressed
  // themselves, which is the one thing this feature promises never to do.
  function disarmRefusalNote(chatId: string) {
    try {
      if (armedNoteChat == null || String(chatId) !== armedNoteChat) return;
      armedNoteChat = null;
      if (!ctx || typeof (ctx as any).sendToBackend !== "function") return;
      (ctx as any).sendToBackend({ type: "arm_refusal_note", chatId: chatId, notes: [] });
      log("retry never started; note taken back", chatId);
    } catch (_) {}
  }

  // Resolves once the backend confirms the note is in place. The arm travels the
  // frontend-to-backend bridge while the retry click travels the DOM to the host
  // to the server, and those are independent: the click could reach prompt
  // assembly first, the interceptor would find nothing armed, and the note was
  // silently dropped from that generation. Waiting on the acknowledgement
  // removes the race. The timeout means a host with no backend bridge, or a slow
  // one, still gets its retry.
  function armRefusalNote(
    chatId: string,
    reason: string,
    attempt: number,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        if (!cfg.refusalNote || !isRefusalReason(reason)) return resolve(false);
        // A note is armed on the backend and collected by the interceptor for
        // one named chat. With no id there is nothing to scope it to, and the
        // interceptor's scope check only bites when both sides carry an id, so
        // an unscoped note would attach itself to whichever generation ran
        // next, in any chat. The retry itself still goes ahead without it.
        if (chatId === NO_CHAT) {
          log("no note this time: the host did not say which chat this is, and a note has to belong to one");
          return resolve(false);
        }
        // An empty note is skipped rather than sent blank, so a half-filled list
        // is not a trap. Nothing is armed when they are all empty.
        //
        // Trimmed to decide whether a note counts as empty, and not otherwise:
        // what goes out is what was typed, spacing and all. The panel says the
        // note is sent exactly as written, and a line break someone put at the
        // end of theirs is part of what they wrote.
        // Each note brings its own first try, so this takes the ones that have
        // come due rather than holding or sending the list as a whole. Order is
        // the order they were written, which is what lets one answer another.
        const all = (Array.isArray(cfg.refusalNotes) ? cfg.refusalNotes : [])
          .slice(0, MAX_NOTES)
          .map((n: any) => ({
            text: String((n && n.text) || ""),
            role: NOTE_ROLES.indexOf(String(n && n.role)) >= 0 ? String(n.role) : "system",
            fromTry: Math.max(1, Math.round(Number(n && n.fromTry)) || NOTE_FROM_TRY_DEFAULT),
          }))
          .filter((n: any) => n.text.trim());
        if (!all.length) return resolve(false);
        const due = all.filter((n: any) => attempt >= n.fromTry);
        if (!due.length) {
          const soonest = Math.min.apply(null, all.map((n: any) => n.fromTry));
          log("no note is due yet; the earliest starts on try " + soonest + ", this is try " + attempt);
          return resolve(false);
        }
        const notes = due.map((n: any) => ({ text: n.text, role: n.role }));
        if (due.length < all.length)
          log("sending " + due.length + " of " + all.length + " notes; the rest start on a later try");
        if (!ctx || typeof (ctx as any).sendToBackend !== "function") return resolve(false);
        const reqId = "ar-arm-" + Date.now() + "-" + Math.random().toString(36).slice(2);
        let settled = false;
        let off: any = null;
        let timer: any = null;
        const finish = (ok: boolean) => {
          if (settled) return;
          settled = true;
          try { off && off(); } catch (_) {}
          clearTimeout(timer);
          resolve(ok);
        };
        try {
          off = (ctx as any).onBackendMessage((msg: any) => {
            if (msg && msg.type === "note_armed" && msg.requestId === reqId) {
              log(msg.armed ? "note is in place for the next retry" : "backend accepted no note");
              finish(!!msg.armed);
            }
          });
        } catch (_) {}
        timer = setTimeout(() => {
          log("note was not acknowledged in time; retrying without waiting further");
          finish(false);
        }, NOTE_ACK_MS);
        (ctx as any).sendToBackend({
          type: "arm_refusal_note",
          chatId: chatId,
          notes: notes,
          placement: String(cfg.refusalNotePlacement || "after"),
          strictType: !!cfg.refusalNoteStrictType,
          requestId: reqId,
        });
        armedNoteChat = String(chatId);
      } catch (_) {
        resolve(false);
      }
    });
  }

  function scheduleRetry(chatId: string, reason: string, err?: any) {
    const s = st(chatId);
    if (!cfg.enabled || s.pending) return;
    if (chatIsOff(chatId)) {
      log("this chat is switched off, not retrying", chatId);
      return;
    }
    if (cfg.pauseWhenFailing && Date.now() < pausedUntil) {
      log("paused after repeated failures, not retrying", chatId);
      return;
    }
    if (Date.now() < s.suppressUntil) {
      log("ignored, you had just stopped or cancelled it", chatId);
      return;
    }
    if (s.attempts >= cfg.maxRetries) {
      log("gave up", chatId, reason);
      s.attempts = 0;
      // A second guard on a value that is already clamped. The lowest the box
      // allows is 1, and a saved 0 from before that is clamped on load, so this
      // cannot happen from the panel. It stays because nothing here should
      // assume a number it did not clamp itself: at zero no retry was ever made, so there is no failed run to
      // count and nothing worth announcing.
      if (cfg.maxRetries <= 0) return;
      stats.gaveUp += 1;
      failedRuns += 1;
      const runsNeeded = breakerRuns();
      if (cfg.pauseWhenFailing && failedRuns >= runsNeeded) {
        const pauseMs = breakerPauseMs();
        pausedUntil = Date.now() + pauseMs;
        failedRuns = 0;
        log("paused for " + sayTime(pauseMs) + " after " + runsNeeded + " failed runs");
        // Said the same way as the countdown that follows it on the panel, and
        // for the same reason the countdown grew hours: this pause can be set
        // to three hours, and "180 minutes" leaves you doing the division.
        //
        // Forced: the toast setting covers the pop-up on each retry, and going
        // quiet for minutes at a time is a state change, not a retry. A
        // user who sees nothing has no way to tell this from the thing breaking.
        showToast(
          "Auto Retry paused for " + sayTime(pauseMs) +
          ": the last " + runsNeeded + (runsNeeded === 1 ? " run" : " runs") + " failed.",
          { force: true },
        );
        // Pausing is the state that most looks like the extension having
        // stopped working, so the line saying otherwise should not be a
        // quarter of a second behind the message announcing it.
        paintNow();
      } else {
        showToast("Auto Retry gave up after " + cfg.maxRetries + " tries.");
      }
      return;
    }
    s.attempts += 1;
    stats.retries += 1;
    stats.reasons[reason] = (stats.reasons[reason] || 0) + 1;
    // Keyed by the id, not by the name. The name can arrive after the first
    // retry in a chat, and keying by it would file the same chat under two
    // headings: a short id for the retries before the answer came back, and a
    // name for the ones after. The label is worked out when the tally is drawn.
    stats.byChat[String(chatId)] = (stats.byChat[String(chatId)] || 0) + 1;
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
    // What the countdown reads from. Set before the message goes up, so the
    // first repaint has something to say rather than a blank second.
    s.retryAt = Date.now() + delay;
    s.retryReason = rl ? "Rate limited" : reason.charAt(0).toUpperCase() + reason.slice(1);
    const opening = chatStatus(s);
    showToast(opening ? opening.text : "Retrying", {
      cancel: () => standDown(chatId, true),
      sticky: true,
    });
    startToastCountdown(s);
    paintNow();
    s.timer = setTimeout(async () => {
      s.timer = null;
      s.retryAt = 0;
      s.pending = false;
      s.selfTriggered = true;
      // Before the click, and awaited, so the note is in place by the time the
      // generation starts rather than racing it.
      //
      // Asked first whether there is anything to click at all. Arming and then
      // taking it back worked, but it spent the whole acknowledgement wait
      // finding that out, and for the length of that wait the backend held a
      // note armed for a generation that was never going to happen. A DOM query
      // is free and answers the question before any of that starts.
      if (pickRetryControl()) await armRefusalNote(chatId, reason, s.attempts);
      // Stop or Cancel can land during that wait, and the click below would
      // restart a reply the user had just called off.
      if (Date.now() < s.suppressUntil) {
        disarmRefusalNote(chatId);
        s.selfTriggered = false;
        return;
      }
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
        disarmRefusalNote(chatId);
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
  // A reply that was writing itself out and then went quiet. Two different
  // things wear that description, and only one of them is this watchdog's.
  //
  // Nothing usable arrived: the generation died on its way out and there is
  // nothing to lose by re-rolling it, which is what this is for.
  //
  // Real reply text arrived and then stopped: what the reader has is a reply
  // cut off partway. Whether to re-roll one of those is already a setting, and
  // it is the setting they would go looking for, so this asks it rather than
  // going over its head. Aborting anyway threw away writing that was really
  // there, on a build where the reply had in fact finished, and the reader had
  // switched off the one option that named what they were seeing.
  function onFrozen(chatId: string) {
    const s = st(chatId);
    // What actually streamed, not that a content-shaped event went past.
    // sawContent is true for an empty content token as well, and a generation
    // that died after nothing but those is the case this watchdog exists for.
    const gotText = String(s.buf || "").trim().length > 0;
    if (gotText && !cfg.retryOnTruncated) {
      clearTimers(s);
      log("a reply stopped partway and was left alone: cut-off replies are switched off");
      return;
    }
    abortAndRetry(chatId, "stalled");
  }

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
    if (!p) return;
    const chatId = chatOf(p);
    const s = st(chatId);
    if (s.startWatchdog) {
      clearTimeout(s.startWatchdog);
      s.startWatchdog = null;
    }
    s.expectingStart = 0;
    // Whether the Prompt tab was open and asking at the moment this generation
    // began. The prompt is assembled at the start, which is when the interceptor
    // runs and the only chance there is to capture it, so arming the tab any
    // later cannot produce one for this generation however long it runs.
    s.watchedFromStart = promptsAsked;
    // The id the rest of the panel shows, which stays null when the host named
    // no chat. The per-chat switch and the swap buttons read this, and all of
    // them need a real id to be honest about what they would act on.
    const realId = p.chatId == null || p.chatId === "" ? null : p.chatId;
    const switched = lastChatId !== realId;
    lastChatId = realId;
    lastMessageId = p.messageId;
    if (switched) {
      paintFloat();
      syncMasterNote();
    }
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
    rememberGeneration(p.generationId, chatId);
    ensureChatName(realId);
    // Whether a reply is in the air, as opposed to which one was last seen.
    // genId is never cleared, because the ids of generations already dealt with
    // are wanted afterwards, so it cannot answer this and the status line read
    // "waiting for the reply to start" long after one had finished.
    if (!s.live) s.liveSince = Date.now();
    s.live = true;
    // A reply starting is a change, so the line says so at once rather than up
    // to a quarter of a second later. The character count inside one is not a
    // change of state, so tokens are left to the clock.
    paintNow();
    clearConfirmWatch(); // a reply is running, so no dialog is in the way
    s.sawReasoning = false;
    s.sawContent = false;
    s.buf = "";
    clearTimers(s);
    if (cfg.enabled && cfg.stuckTimeoutMs > 0) {
      s.startTimer = setTimeout(
        () => abortAndRetry(chatId, "stuck"),
        cfg.stuckTimeoutMs,
      );
    }
  }

  // Ask the backend which chat is open. Everything else that sets the chat id
  // waits for something to happen in the chat, which leaves the per-chat switch
  // greyed out after an update: nothing re-renders, so nothing announces where
  // you are. This asks outright. Without the chats permission it answers null
  // and the waiting behaviour stands.
  //
  // Handlers waiting on an answer that may never come. Held so teardown can
  // drop them, and so one is never left listening for a reply to a question
  // asked minutes ago.
  const chatAsks = new Set<() => void>();
  const CHAT_ASK_MS = 8000;
  // Asks which chat is open and hands back the answer, rather than only acting
  // on it. The swap buttons need the answer itself: they edit saved replies and
  // must not do that to a chat the user has walked away from.
  //
  // answered is false when there is no bridge or nothing came back in time.
  // resolved is the backend saying it could actually look. A null chatId with
  // resolved true means no chat is open; with resolved false it means nothing
  // at all, and the caller falls back to what it already knew.
  function whichChatIsOpen(
    forChat?: string,
  ): Promise<{ answered: boolean; resolved: boolean; chatId: string | null }> {
    return new Promise((resolve) => askActiveChat(forChat, resolve));
  }

  function askActiveChat(
    forChat?: string,
    answer?: (r: { answered: boolean; resolved: boolean; chatId: string | null }) => void,
  ) {
    const reply = (r: { answered: boolean; resolved: boolean; chatId: string | null }) => {
      if (!answer) return;
      const send = answer;
      answer = undefined;
      try { send(r); } catch (_) {}
    };
    try {
      if (!ctx || typeof (ctx as any).sendToBackend !== "function") { reply({ answered: false, resolved: false, chatId: null }); return; }
      if (typeof (ctx as any).onBackendMessage !== "function") { reply({ answered: false, resolved: false, chatId: null }); return; }
      const reqId = "ar-chat-" + Date.now() + "-" + Math.random().toString(36).slice(2);
      let done = false;
      let timer: any = null;
      let off: any = null;
      // One way out, however this ends. Without it a host that never answers
      // left a listener behind on every chat switch, and teardown left them all
      // registered, which is a leak that only shows on a long session.
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { off && off(); } catch (_) {}
        chatAsks.delete(finish);
        // Nothing came back, so the caller is told that rather than being left
        // waiting, and it falls back to what it already knew.
        reply({ answered: false, resolved: false, chatId: null });
      };
      off = (ctx as any).onBackendMessage((msg: any) => {
        if (!msg || msg.type !== "active_chat" || msg.requestId !== reqId) return;
        const chatId = msg.chatId ? String(msg.chatId) : null;
        const resolved = !!msg.resolved;
        // The real answer goes out before finish, which otherwise reports that
        // nothing came back when something just did.
        reply({ answered: true, resolved: resolved, chatId: chatId });
        finish();
        // "Which chat is open" answered with "none", from a backend that could
        // actually look, means the user has left the chat. Some builds never
        // say so on their own, and the id we were holding is now the chat they
        // walked away from.
        if (!forChat && resolved && !chatId) {
          noChatOpen = true;
          lastChatId = null;
          lastMessageId = null;
          if (chatSwitchPaint) {
            try { chatSwitchPaint(); } catch (_) {}
          }
          syncMasterNote();
          paintNow();
        }
        if (!msg.chatId) return;
        // An empty answer from a backend that looked is still an answer, and
        // caching it stops the same question going out again every time you
        // switch back to that chat. One from a backend that could not look is
        // not, and caching it would fix "no name" in place for the rest of the
        // page over a lookup that would have worked a second later.
        if (resolved || msg.character) {
          chatNames.set(String(msg.chatId), msg.character ? String(msg.character) : "");
          // A chat with no card is a temporary one, the mode for talking to the
          // model with no character in front of it. Recorded from the chat
          // itself rather than from a missing name, which can also mean the
          // characters permission was refused.
          if (resolved) {
            if (msg.hasCharacter) cardless.delete(String(msg.chatId));
            else cardless.add(String(msg.chatId));
          }
          if (chatSwitchPaint) {
            try { chatSwitchPaint(); } catch (_) {}
          }
        }
        // Only the question that asked "which chat is open" may answer that.
        // A reply about a named chat is just its name arriving, and acting on
        // it would drag the panel back to a chat the user has since left, since
        // an answer can land after they have moved on.
        if (!forChat) noteChat(msg.chatId);
      });
      chatAsks.add(finish);
      timer = setTimeout(finish, CHAT_ASK_MS);
      (ctx as any).sendToBackend({ type: "get_active_chat", requestId: reqId, chatId: forChat || null });
    } catch (_) {
      // A host that refuses to carry the question answers it by throwing. Left
      // to the empty catch this never called back at all, so a swap waiting on
      // the answer waited for ever and the button did nothing, silently, which
      // is the exact fault this whole path exists to stop.
      reply({ answered: false, resolved: false, chatId: null });
    }
  }

  // Where every chat id the extension learns arrives, whatever carried it, and
  // not only the events that announce a change.
  //
  // Generation events alone are not enough. The manual swap buttons need a chat
  // id, so with only those an older chat reports nothing to swap until
  // something has been generated in it, and the per-chat switch stays greyed
  // out on a fresh page load until the user leaves and comes back. A message
  // rendering is what happens when a chat opens and it carries the id, so it is
  // enough on its own.
  // A swap that landed, counted against the chat it happened in and said out
  // loud. Both are here rather than at each call site so the automatic path and
  // the two buttons cannot end up counting differently, or one of them staying
  // silent. n is the number of words changed, which is what the backend reports
  // one entry per.
  function noteSwaps(chatId: any, n: number) {
    if (!(n > 0)) return;
    const key = chatId == null || chatId === "" ? NO_CHAT : String(chatId);
    stats.swapsByChat[key] = (stats.swapsByChat[key] || 0) + n;
    log(
      "swapped " + n + (n === 1 ? " word" : " words") +
      " (" + stats.swapsByChat[key] + " in this chat)",
    );
  }

  function noteChat(id: any) {
    const next = id == null ? null : id;
    if (next == null || next === lastChatId) return;
    lastChatId = next;
    // The last reply seen belonged to the chat just left, so it is not the last
    // reply here. onChatSwitched has always cleared this and noteChat never
    // did, which left the manual swap aiming at a message in another chat. The
    // backend falls back to the latest reply for an id it cannot find, so it
    // did no harm, but it was asking for the wrong thing.
    lastMessageId = null;
    // A chat learned from an event arrives as an id and nothing else, so this
    // is the moment to find out whose it is. Asked once per chat: the answer
    // does not change while you are in it.
    ensureChatName(next);
    // Anything that describes the chat you are in is now out of date.
    if (chatSwitchPaint) {
      try { chatSwitchPaint(); } catch (_) {}
    }
    paintFloat();
    syncMasterNote();
    syncToggleAction();
    paintNow();
  }

  function onChatSwitched(p: any) {
    if (!p || typeof p.chatId === "undefined") return;
    // Set directly rather than through noteChat, because this is the one event
    // that can also mean "no chat any more", which noteChat ignores on purpose.
    lastChatId = p.chatId || null;
    // The host saying "no chat now" is as good an answer as the backend's, so
    // the row says there is no chat rather than that it is still working out
    // which one you are in.
    noChatOpen = lastChatId == null;
    lastMessageId = null;
    ensureChatName(lastChatId);
    // The prompt on screen belongs to the chat that was just left, so the tab
    // has to be told. It is the one thing here that describes a chat and is not
    // repainted by paintNow below.
    if (liveTab === "prompt") renderLiveLog();
    // All of these describe the chat you are in, so all of them go stale on a
    // switch. The line most of all: walking into a chat you had switched off
    // should say so straight away, not on the next tick.
    if (chatSwitchPaint) {
      try { chatSwitchPaint(); } catch (_) {}
    }
    paintFloat();
    syncMasterNote();
    syncToggleAction();
    paintNow();
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
    if (!p) return;
    // Text arriving is what calls off the watchdog that waits for a reply to
    // start, so this has to land on the state that armed it. Token events carry
    // less than the start does on some builds, which is why the generation
    // decides the chat here rather than whatever the token itself says.
    const chatId = chatForGeneration(p);
    const s = st(chatId);
    // Text arriving is the only proof that beats every guess: if anything above
    // decided this reply was over and it was not, this puts it right.
    if (!s.live) s.liveSince = Date.now();
    s.live = true;
    // Matched by shape, not an exact string, so a build that labels these
    // "reasoning_content" or "thinking" is not counted as visible reply text.
    sawStreaming = true;
    if (REASONING_TOKEN.test(String((p && p.type) || ""))) s.sawReasoning = true;
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
        () => onFrozen(chatId),
        cfg.idleTimeoutMs,
      );
    }
  }

  function onEnd(p: any) {
    if (!p) return;
    // The generation id identifies the work, the chat id is only context, and
    // where the two disagree the chat the generation started in is right. An
    // end event landing on the wrong state leaves the watchdogs armed on the
    // real one, and the text streamed so far is then looked for on a state that
    // never saw any, so a good reply reads as empty.
    const chatId = chatForGeneration(p);
    const s = st(chatId);
    // One ending, one verdict. A build that reports the same generation as
    // ended twice was getting two, and the second arrived after the extension
    // had already given up on that reply, which hands the budget back: "most
    // tries" said two and the reply was re-rolled until something else stopped
    // it, taking whatever was there with it each time.
    //
    // Only when there is an id to go on. Without one there is nothing to tell
    // a repeat from the next reply, and dropping a real ending is worse than
    // judging a repeat.
    const genId = genKey(p.generationId);
    if (genId) {
      if (s.judged.has(genId)) {
        log("that reply had already been dealt with, so this ending was ignored");
        return;
      }
      s.judged.add(genId);
      while (s.judged.size > IGNORE_MAX)
        s.judged.delete(s.judged.values().next().value as string);
    }
    // Only a real id goes on the panel. A generation the host named no chat for
    // still gets its state and its retry above, and leaves what the panel says
    // about "this chat" alone rather than claiming the sentinel is a chat.
    if (chatId !== NO_CHAT) {
      lastChatId = chatId;
      ensureChatName(chatId);
    }
    lastMessageId = p.messageId;
    // Text that turned up without a single token behind it is a build that
    // does not stream, which is the other half of what the live line needs to
    // know. An empty or failed reply proves nothing, so it has to have text.
    if (!s.sawContent && !s.sawReasoning && !p.error &&
        String(p.content == null ? "" : p.content).trim())
      sawWholeReplyAtOnce = true;
    s.live = false;
    // A generation has now been all the way through with the view open and
    // asking, so a prompt that has still not arrived is not going to.
    //
    // Both ends have to have been asking, not just this one. Sending a reply
    // with the panel shut, or on the Log tab, and opening the Prompt tab while
    // it ran would arm capture after the prompt had already been assembled and
    // gone: no snapshot could arrive for that generation, and this took the
    // silence for a missing permission and said so. It named the one thing the
    // reader could not check and was wrong about it, which is worse than
    // saying nothing.
    if (s.watchedFromStart && promptsAsked && !lastPrompt && !promptNeverArrived) {
      promptNeverArrived = true;
      if (liveTab === "prompt") renderLiveLog();
    }
    // The streamed copy has done its job the moment the reply ends, so it is
    // taken here and the chat's own copy dropped. Waiting for the next reply to
    // start would keep a finished reply in memory for as long as the chat sits
    // idle. Nothing below reads s.buf, so taking it here loses nothing.
    const streamed = String(s.buf || "");
    s.buf = "";
    paintNow();
    if (s.ignored.has(p.generationId)) return; // aborted gen's trailing event, retry already scheduled
    clearTimers(s);
    if (Date.now() < s.suppressUntil) {
      log("the reply ended just after you stopped it, so ignoring it");
      s.attempts = 0;
      return;
    } // user just stopped; do not retry
    if (p.error) {
      // A content-moderation block we can retry as a refusal is not a permanent
      // failure, so don't let the hard-error skip swallow it before the refusal check.
      if (cfg.ignoreHardErrors && isHardError(p.error) && !(cfg.retryOnRefusal && looksLikeRefusalError(String(p.error), cfg))) {
        log("hard error ignored", p.error);
        showToast("Auto Retry did not retry: that error will not fix itself, so trying again would not help.");
        s.attempts = 0;
        return;
      }
      if (cfg.retryOnError) {
        scheduleRetry(chatId, "error", p.error);
        return;
      }
      if (cfg.retryOnRefusal && looksLikeRefusalError(String(p.error), cfg)) {
        // No reply text ever existed for this one: the provider refused before
        // anything was written, so it is not the phrase list that caught it.
        scheduleRetry(chatId, BLOCKED_REASON);
        return;
      }
      return;
    }
    // Not every build puts the finished text on the end event. When there is
    // none, what actually streamed stands in for it, so a good reply is not
    // read as empty and every check below still has real text to work with.
    //
    // An empty string counts as none. A build reporting one for a reply that
    // really streamed is contradicting the screen, and the text watched
    // arriving is the better evidence, because it is what the reader is
    // looking at. Trusting the field over it re-rolled whole replies that were
    // sitting there finished.
    const hasContentField = typeof p.content === "string";
    const ended = hasContentField ? String(p.content).trim() : "";
    const content = ended.length ? ended : streamed.trim();
    // Empty only when the payload says so, or when nothing streamed either. A
    // missing field plus tokens that carried no readable text is not a verdict,
    // so it is left alone rather than re-rolled on a guess.
    const isEmpty = content.length === 0 && (hasContentField || !s.sawContent);
    if (cfg.retryOnEmpty && isEmpty) {
      scheduleRetry(
        chatId,
        s.sawReasoning && !s.sawContent ? "cut off mid-reasoning" : "empty",
      );
      return;
    }
    if (content.length === 0) {
      log("the reply ended with no text to read, so leaving it alone");
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
      scheduleRetry(chatId, "thinking only, no reply");
      return;
    }
    if (cfg.retryOnTruncated && looksTruncated(content, cfg.retryOnNoPunct, cfg)) {
      scheduleRetry(chatId, "cut off");
      return;
    }
    if (cfg.retryOnRefusal) {
      const verdict = refusalVerdict(content, cfg);
      if (verdict.refusal) {
        scheduleRetry(
          chatId,
          verdict.kind === "crisis"
            ? CRISIS_REASON
            : verdict.kind === "breakoff"
              ? BREAKOFF_REASON
              : REFUSAL_REASON,
        );
        return;
      }
    }
    // Measured on the visible reply, not the raw output. A reasoning block can
    // run to hundreds of characters, and markup adds tens per line, so counting
    // either would let a two-word reply pass a length test set for prose.
    if (
      cfg.retryOnShort &&
      stripMarkup(stripThinkingAlways(content, cfg)).trim().length < cfg.minChars
    ) {
      scheduleRetry(chatId, "short");
      return;
    }
    // A reply that came back fine means whatever was wrong has cleared.
    failedRuns = 0;
    pausedUntil = 0;
    stats.good += 1;
    log("gen ok", content.length + " chars");
    s.attempts = 0; // clean success
  }

  function onStop(p: any) {
    if (!p) return;
    // Resolved through the generation like the rest, so a stop still calls off
    // the retries in the chat the reply actually started in. Reading this
    // handler alone makes that look like a detail; it is not, because standing
    // down is the one thing that must never fail to find the state.
    const chatId = chatForGeneration(p);
    const s = st(chatId);
    if (s.ignored.has(p.generationId)) return; // our own abort, not a user stop
    log("user stop", p.generationId);
    standDown(chatId, true); // genuine user stop: stand down, don't fight them
  }

  // The host saves a swapped reply without redrawing the chat, so the old words
  // stay on screen until the view is rebuilt. This applies the same swaps to the
  // rendered text. Only text nodes are touched, so markdown, formatting and any
  // element structure are left exactly as they were.
  //
  // The backend records one pair per match it made, so the number of pairs is
  // exactly the number of occurrences it changed. Each pair therefore spends
  // itself on exactly one occurrence here, taken from the end of the page
  // backwards, which is the newest text first.
  //
  // One pair must not rewrite more than its own occurrence. Spending a pair on
  // every match inside a node would use up the later pairs on text the backend
  // never touched, and the screen would then disagree with the stored chat
  // until the view was rebuilt.
  //
  // Counting from the end is exact for one reply and approximate for a whole
  // chat, where a message of the user's can sit between two replies and be
  // caught. Being exact needs knowing which element is which message, which is
  // the host dependency this extension avoids, so this stays a heuristic.
  function applySwapsToView(pairs: Array<[string, string]>): number {
    if (typeof document === "undefined" || !pairs || !pairs.length) return 0;
    const SKIP = /^(SCRIPT|STYLE|TEXTAREA|INPUT|SELECT|OPTION)$/;
    let done = 0;

    // The candidate list is the same for every rule, so the page is walked once
    // and the list reused. Building a TreeWalker inside the loop below would
    // mean one full pass over every text node per rule.
    // Only the rendered replies, not the whole page. The host marks each one
    // with data-component="MessageContent", so the walk starts there.
    //
    // Starting at document.body would make every text node a candidate:
    // another extension's panel, a menu, a tooltip, the character list. A rule
    // of "cat => dog" would then rewrite the word inside somebody else's
    // interface. Nothing outside a message is ours to touch.
    //
    // If the host ever renames that attribute this finds nothing and falls back
    // to the old behaviour, which is worth having: a swap that reaches too far
    // is a nuisance, but a swap that silently stops working looks like the
    // feature is broken.
    const roots: any[] = [];
    try {
      const marked = document.querySelectorAll('[data-component="MessageContent"]');
      for (let i = 0; i < marked.length; i++) roots.push(marked[i]);
    } catch (_) {}
    if (!roots.length && document.body) roots.push(document.body);

    const nodes: any[] = [];
    try {
      for (const root of roots) {
        const walker: any = document.createTreeWalker(root, 4 /* SHOW_TEXT */);
        let node: any = walker.nextNode ? walker.nextNode() : null;
        while (node) {
          const parent = node.parentElement;
          let skip = !parent || SKIP.test(String(parent.tagName || ""));
          // Our own panels, anything the user is typing into, and anything that
          // looks like another extension's surface rather than the chat.
          if (!skip && parent.closest) {
            try {
              skip = !!parent.closest(
                "[data-ar-ui],[contenteditable='true'],[role='dialog'],[role='menu'],[role='tooltip']",
              );
            } catch (__) {}
          }
          if (!skip) nodes.push(node);
          node = walker.nextNode();
        }
      }
    } catch (_) {
      return done;
    }

    for (const pair of pairs) {
      const from = String(pair && pair[0] != null ? pair[0] : "");
      const to = String(pair && pair[1] != null ? pair[1] : "");
      if (!from || from === to) continue;
      // The backend matches whole words for single-word rules, so a literal
      // replace here would also hit "dogged" when the rule was "dog". This
      // rebuilds the same boundary the backend used.
      let re: RegExp | null = null;
      const esc = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const needsLead = /^[\p{L}\p{N}]/u.test(from);
      const needsTail = /[\p{L}\p{N}]$/u.test(from);
      const build = (lead: string, tail: string) =>
        new RegExp((needsLead ? lead : "") + esc + (needsTail ? tail : ""), "gu");
      try {
        // Not \b. It is defined against [A-Za-z0-9_] even under the u flag, so
        // it fails at the first accented letter and the visible text would keep
        // the old wording while the saved reply had the new one. The backend
        // matches with these same lookarounds.
        re = build("(?<![\\p{L}\\p{N}_])", "(?![\\p{L}\\p{N}_])");
      } catch (__) {
        // No lookbehind on this engine. Same fallback the backend takes.
        try {
          re = build("\\b", "\\b");
        } catch (___) {
          re = null;
        }
      }
      if (!re) continue;
      // Walk backwards and stop at the first node that still matches, changing
      // the last occurrence in it. Re-read each node as we go: an earlier pair
      // may already have rewritten it, and matching has to see the text as it
      // stands now rather than as it was when the walk started.
      for (let i = nodes.length - 1; i >= 0; i--) {
        const text = String(nodes[i].nodeValue || "");
        re.lastIndex = 0;
        let at = -1;
        let len = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
          at = m.index;
          len = m[0].length;
        }
        if (at < 0) continue;
        try {
          nodes[i].nodeValue = text.slice(0, at) + to + text.slice(at + len);
          done++;
        } catch (__) {}
        break;
      }
    }
    return done;
  }

  // ---- repairing the host's edit box after a swap ----
  //
  // A swap is written to the server through the Chat Mutation API, so the
  // stored message is the swapped one. The host's own copy of that message in
  // the browser does not always pick the change up, and when it does not,
  // pressing Edit fills the box from that stale copy: the pre-swap wording
  // appears, and pressing Save writes it back over the swap. The swap is lost
  // and it looks like the extension undid its own work.
  //
  // Patching what is on screen does not help here, because the edit box is
  // filled from the host's state and not from the text on the page.
  //
  // So each swap is remembered as the exact text before and the exact text
  // after. When an edit box turns up holding a whole message that is character
  // for character the pre-swap text, it is the stale copy, and it is replaced
  // with the swapped one. Nothing heuristic happens: it is a whole-string
  // match or it is left alone, so a box holding anything else, including a
  // message the user has started editing, is never touched.
  const swapUndos: Array<{ before: string; after: string }> = [];
  const SWAP_UNDO_CAP = 40;
  function rememberSwap(before: any, after: any) {
    const b = String(before == null ? "" : before);
    const a = String(after == null ? "" : after);
    if (!b || b === a) return;
    for (const e of swapUndos) if (e.before === b) return;
    swapUndos.push({ before: b, after: a });
    while (swapUndos.length > SWAP_UNDO_CAP) swapUndos.shift();
  }

  // The host's message editor. Matched on the name attribute rather than on a
  // class, because the classes are build-hashed and the name is not.
  const EDIT_BOX_SELECTOR =
    'textarea[name="message-edit-content"],textarea[aria-label="Message content"]';

  function repairEditBox(): boolean {
    if (!swapUndos.length || typeof document === "undefined") return false;
    let fixed = false;
    let boxes: any[] = [];
    try {
      boxes = Array.prototype.slice.call(document.querySelectorAll(EDIT_BOX_SELECTOR));
    } catch (_) {
      return false;
    }
    for (const box of boxes) {
      const v = String(box.value == null ? "" : box.value);
      if (!v) continue;
      for (const e of swapUndos) {
        if (v !== e.before) continue;
        try {
          box.value = e.after;
          // The host tracks the box through its own listeners, so a value set
          // from script has to announce itself or Save writes what the host
          // still thinks is in there.
          box.dispatchEvent(new Event("input", { bubbles: true }));
          box.dispatchEvent(new Event("change", { bubbles: true }));
          fixed = true;
          log("put the swapped wording back into the edit box");
        } catch (__) {}
        break;
      }
    }
    return fixed;
  }

  // The edit box is built after the click that opens it, and the host may take
  // a moment over it, so this looks a few times rather than once. Every pass is
  // a no-op while nothing has been swapped.
  let repairTimers: any[] = [];
  function scheduleEditRepair() {
    if (!swapUndos.length) return;
    for (const t of repairTimers) clearTimeout(t);
    repairTimers = [0, 60, 200, 500].map((ms) => setTimeout(repairEditBox, ms));
  }

  function onDocFocusIn(e: any) {
    try {
      if (!swapUndos.length) return;
      const t = e && e.target;
      if (!t || !t.matches || !t.matches(EDIT_BOX_SELECTOR)) return;
      scheduleEditRepair();
    } catch (_) {}
  }

  // Backup for the user's Stop press: if the host's GENERATION_STOPPED event is
  // late or never fires, catch the click on the stop button itself and stand
  // every pending retry down. Delegated + capture so it survives the host
  // re-rendering its buttons.
  function onDocClick(e: any) {
    try {
      // A stalled reply is halted by clicking that same stop button, and that
      // click reaches here too. Standing down on it would suppress the retry
      // being scheduled right behind it, so our own clicks are skipped.
      if (selfClicking > 0) return;
      // Any click by the user during the short window after a retry means the
      // user is driving. Back off rather than press a dialog button underneath
      // them, which could take a feedback prompt they opened themselves.
      clearConfirmWatch();
      // A click is how an edit box gets opened. Costs nothing until something
      // has actually been swapped.
      scheduleEditRepair();
      const tgt =
        e && e.target && e.target.closest
          ? e.target.closest(cfg.stopSelector)
          : null;
      if (!tgt) return;
      chats.forEach((s: any, id: string) => {
        // The reply on screen is being halted, whether or not a retry was
        // waiting behind it, so nothing is in the air in any of these.
        s.live = false;
        if (s.pending || s.timer || s.attempts > 0) standDown(id, true);
      });
      paintNow();
    } catch (_) {}
  }

  // ---- hint popover ----
  // The description floats over the panel rather than expanding inline, so the
  // list never moves. Expanding in place pushes every option below it down, and
  // on a phone one tap can shove the next two off the screen.
  //
  // Fixed position, parented to the page rather than the row: the options list
  // is a scroll container, and anything inside it would be clipped at its edges.
  // Only ever one open, since there is only ever one of these.
  let hintPop: HTMLElement | null = null;
  let hintAnchor: any = null;
  let hintReset: (() => void) | null = null;

  function hideHint() {
    if (hintPop) {
      try { hintPop.remove(); } catch (_) {}
    }
    hintPop = null;
    hintAnchor = null;
    if (hintReset) {
      try { hintReset(); } catch (_) {}
    }
    hintReset = null;
  }

  function showHint(anchor: any, text: string, onClose: () => void) {
    hideHint();
    if (typeof document === "undefined" || !anchor || !anchor.getBoundingClientRect) return;
    const el = document.createElement("div");
    el.setAttribute("role", "tooltip");
    markOwnUI(el);
    el.textContent = text;
    el.style.cssText =
      "position:fixed;z-index:" + Z_HINT + ";box-sizing:border-box;padding:8px 10px;" +
      "border-radius:var(--lumiverse-radius,8px);" +
      // This has to be fully opaque. It sits directly on top of the options
      // list, and --lumiverse-bg-elevated is only 90% opaque, which left the row
      // underneath legible through the description covering it. The theme's own
      // solid surface is painted first and the elevated colour laid over it, so
      // the tint still follows the theme but nothing shows through.
      "background-color:var(--lumiverse-card-bg-solid,rgb(24,20,34));" +
      "background-image:linear-gradient(var(--lumiverse-bg-elevated,rgba(35,30,48,.98))," +
      "var(--lumiverse-bg-elevated,rgba(35,30,48,.98)));" +
      "border:1px solid var(--lumiverse-border,rgba(255,255,255,.16));" +
      "box-shadow:var(--lumiverse-shadow-md,0 8px 24px rgba(0,0,0,.4));" +
      "color:var(--lumiverse-text,#eee);font:12px/1.45 var(--lumiverse-font-family,system-ui);" +
      // Off screen until it has been measured, so it is never seen in the wrong
      // place for a frame.
      "left:0;top:-9999px";
    (document.body || document.documentElement).appendChild(el);

    const vw = vpW();
    const vh = vpH();
    el.style.width = Math.min(300, vw - 24) + "px";
    // Measured from the whole row, not from the "?" inside it. The button is
    // 18px tall and sits partway down a row that can be two lines high, so
    // hanging the description off the button covered the very setting it was
    // describing. Taking the row's own rendered box also means any scaling the
    // host applies is already accounted for, since this is what was actually
    // painted rather than a size assumed in advance.
    const row = (anchor.closest && anchor.closest("[data-ar-row]")) || anchor;
    const r = row.getBoundingClientRect();
    // Measured as it ends up on screen. Under a host that scales its interface
    // an element's offsetHeight is not the height it actually occupies, and
    // these have to be in the same units as the row's rect to be compared.
    const box = el.getBoundingClientRect();
    const h = box.height || el.offsetHeight || 0;
    const w = box.width || el.offsetWidth || 0;
    const GAP = 6;
    const EDGE = 12;
    // Lined up with the row's left edge rather than centred on the "?", which
    // reads as belonging to the row, and nudged back inside a narrow screen.
    const left = Math.max(EDGE, Math.min(r.left, vw - w - EDGE));
    // Below the row it belongs to unless the field asked otherwise, and never
    // flipped between the two on the fly. Flipping on available room means a
    // long description opens somewhere none of the others do. Where it opens is
    // a property of the setting, so a given row is consistent.
    //
    // Above is for a row tall enough that below it is a long way from the "?"
    // that was pressed. Whichever side it is on, a description too tall for the
    // room there is capped and scrolls rather than moving to the other side.
    let above = false;
    try {
      above = !!(anchor.getAttribute && anchor.getAttribute("data-ar-hint-above"));
    } catch (_) {}
    // However little room there is, it is not bought by moving over the row.
    // Covering the setting is the thing the popover exists to avoid, and a
    // short popover still scrolls, so nothing in it is out of reach.
    // Never below zero. A row pushed to the very top of the screen by the host's
    // own layout leaves negative room above it, and a negative max-height is
    // invalid CSS, which the browser drops: the popover then rendered at full
    // height straight over the row it belongs to, which is the one thing it
    // exists not to do. Measured at a row top of -5, covering it from 12 to 273.
    const room = Math.max(
      0,
      above ? r.top - GAP - EDGE : vh - EDGE - (r.bottom + GAP),
    );
    // Above, the bottom edge is pinned a gap over the row and the top follows
    // from however tall it ends up, capped included. Below, the top is pinned
    // and the bottom follows.
    const top = above
      ? Math.max(EDGE, r.top - GAP - Math.min(h, room))
      : r.bottom + GAP;
    if (h > room) {
      // room is space on the screen; max-height is written in the element's own
      // units, and under a host that applies its UI Scale as a zoom those are
      // not the same. At 1.4 a cap of 120 rendered as 168 and the popover ran
      // off the bottom of the screen. Divide by however much the host is
      // scaling, measured rather than assumed, the same as the left and top
      // below. Without a zoom this is a division by 1 and changes nothing.
      const zoom = el.offsetWidth > 0 ? w / el.offsetWidth : 1;
      el.style.maxHeight = Math.floor(room / (zoom > 0.01 ? zoom : 1)) + "px";
      el.style.overflowY = "auto";
      // Reaching the end of the description must not start scrolling the panel
      // behind it, because a scroll out there is what closes it.
      el.style.overscrollBehavior = "contain";
    }
    // With no room at all, a capped popover is still a box of padding sitting
    // over the row. Nothing is a better answer than an empty frame, and this
    // only happens when the host has pushed the row off the top of the screen,
    // where the anchor is half gone too.
    if (room <= 0) el.style.display = "none";

    placeFixed(el, left, top);

    // Tapping the description dismisses it. On a phone that is the first thing
    // a thumb reaches for, and it did nothing.
    el.addEventListener("click", () => hideHint());
    hintPop = el;
    hintAnchor = anchor;
    hintReset = onClose;
    ensureReadableTree(el, 2.6);
  }

  // Anything that means the anchor has moved or attention has gone elsewhere
  // closes it. Scroll is captured, since the options list scrolls, not the page.
  if (typeof document !== "undefined") {
    const onHintDismiss = (e: any) => {
      const t = e && e.target;
      if (!hintPop) return;
      try {
        // The "?" itself is left alone so its own handler can close it, rather
        // than this closing it and the click reopening it.
        if (t && t.closest && (t === hintAnchor || t.closest("[data-ar-hint]"))) return;
        if (t && hintPop.contains && hintPop.contains(t)) return;
      } catch (_) {}
      hideHint();
    };
    // A long description scrolls inside itself. That scroll is someone reading
    // it, not the anchor moving, so it is the one scroll that leaves it open.
    const onHintScroll = (e: any) => {
      try {
        const t = e && e.target;
        if (hintPop && t && hintPop.contains && hintPop.contains(t)) return;
      } catch (_) {}
      hideHint();
    };
    const onHintResize = () => {
      hideHint();
    };
    // Only the description. The float menu is the host's now, and it clamps
    // itself to a resize and closes itself on Escape; taking its answer away
    // here would throw away a choice the user had gone on to make.
    const onHintKey = (e: any) => {
      if (e && e.key === "Escape") hideHint();
    };
    // Every pointer on the page passes through these two, which is where what
    // kind it is gets written down for the compatibility events that follow.
    // Both are on the hot path, so this rides along with the listeners already
    // there rather than adding two more.
    const noteKind = (e: any) => {
      if (e && e.pointerType) lastPointerType = String(e.pointerType);
    };
    const onHoldMove = (e: any) => {
      noteKind(e);
      if (holdMoveWatch) holdMoveWatch(e);
    };
    const onDown = (e: any) => {
      noteKind(e);
      onHintDismiss(e);
    };
    document.addEventListener("pointermove", onHoldMove, true);
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("scroll", onHintScroll, true);
    document.addEventListener("keydown", onHintKey, true);
    if (typeof window !== "undefined") window.addEventListener("resize", onHintResize);
    disposers.push(() => {
      try { document.removeEventListener("pointermove", onHoldMove, true); } catch (_) {}
      try { document.removeEventListener("pointerdown", onDown, true); } catch (_) {}
      try { document.removeEventListener("scroll", onHintScroll, true); } catch (_) {}
      try { document.removeEventListener("keydown", onHintKey, true); } catch (_) {}
      try { if (typeof window !== "undefined") window.removeEventListener("resize", onHintResize); } catch (_) {}
      hideHint();
    });
  }

  // ---- toast with an optional Cancel button ----
  function ensureToast(): any {
    if (typeof document === "undefined") return null;
    let t: any = document.getElementById("__lvRetryToast");
    if (!t) {
      t = document.createElement("div");
      t.id = "__lvRetryToast";
      markOwnUI(t);
      // Below the hint popover and the float menu, not above them. This appears
      // on its own; those are opened by the user, and a notification landing on
      // top of a menu turns a tap on "Hide this button" into a tap on Cancel.
      t.style.cssText =
        // Centred by pinning both edges and letting the margins share what is
        // left, not by left:50% and a transform. With only a left edge set, the
        // box's containing block starts halfway across the screen and ends at
        // the right edge, so it could never be wider than half the viewport:
        // max-width was 379px on a 412px phone and the box stopped at 206px.
        // Messages that fit on one line wrapped, and the wrap stranded a word.
        // fit-content keeps a short message from being padded out to the cap.
        "position:fixed;bottom:max(20px,env(safe-area-inset-bottom,0px));left:0;right:0;" +
        "margin-left:auto;margin-right:auto;width:fit-content;" +
        // Without this the cap applies to the text and the padding and border
        // sit outside it, so the box came out 26px wider than it was allowed
        // and all but touched both edges of a phone.
        "box-sizing:border-box;" +
        "z-index:" + Z_TOAST + ";display:flex;align-items:center;gap:10px;" +
        "font:13px/1.4 var(--lumiverse-font-family,system-ui);padding:9px 12px;border-radius:var(--lumiverse-radius-lg,12px);" +
        "color:var(--lumiverse-text,#fff);" +
        "background-color:var(--lumiverse-card-bg-solid,rgb(24,20,34));background-image:linear-gradient(var(--lumiverse-bg-elevated,rgba(35,30,48,.94)),var(--lumiverse-bg-elevated,rgba(35,30,48,.94)));" +
        "border:1px solid var(--lumiverse-border,rgba(255,255,255,.18));" +
        "box-shadow:var(--lumiverse-shadow-md,0 8px 24px rgba(0,0,0,.4));transition:opacity var(--lumiverse-transition,200ms ease);" +
        "opacity:0;max-width:min(92vw,460px);text-align:left";
      (document.body || document.documentElement).appendChild(t);
    }
    return t;
  }
  function hideToast() {
    stopToastCountdown();
    const t: any =
      typeof document !== "undefined" &&
      document.getElementById("__lvRetryToast");
    if (t) {
      clearTimeout(t.__h);
      t.style.opacity = "0";
      t.style.pointerEvents = "none";
    }
  }
  // Rewrites what the toast says, leaving the box and its Cancel button where
  // they are. Does nothing if the toast has since been replaced or hidden, so a
  // countdown that outlives its own message cannot write over the next one.
  function setToastText(msg: string) {
    const t: any =
      typeof document !== "undefined" && document.getElementById("__lvRetryToast");
    if (!t || !t.__words || t.style.opacity !== "1") return;
    t.__words.textContent = msg;
  }
  // The countdown behind a sticky retry message. One at a time: a second retry
  // replaces the first message, so it replaces the clock with it.
  let toastTick: (() => void) | null = null;
  function stopToastCountdown() {
    if (!toastTick) return;
    removeTicker(toastTick);
    toastTick = null;
  }
  // Tied to the chat that raised the message rather than to whichever chat is
  // on screen. They are usually the same one, and when they are not, a message
  // about this chat counting down another chat's wait would be worse than no
  // countdown at all.
  function startToastCountdown(s: any) {
    stopToastCountdown();
    // Nothing to repaint when the message is switched off, and a clock ticking
    // for something nobody can see is just work.
    if (!cfg.toast) return;
    toastTick = () => {
      // This message exists to count one wait down, and it is sticky, so
      // nothing takes it away on its own. When the wait ends it has to go.
      // Waiting for the chat to have nothing to say is not enough: a retry that
      // fired successfully does have something to say, the reply it started, so
      // the box would stay up narrating that reply and the next one, offering
      // Cancel for a retry that was long over.
      if (!s.retryAt || Date.now() >= s.retryAt) {
        hideToast();
        return;
      }
      const st = chatStatus(s);
      if (st) setToastText(st.text);
    };
    addTicker(toastTick);
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
      // Kept so a countdown can rewrite the words without rebuilding the box.
      // Rebuilding would replace the Cancel button four times a second, which
      // loses a press that lands mid-rebuild and drops keyboard focus on every
      // tick.
      t.__words = span;
      if (opts && opts.cancel) {
        const c = document.createElement("button");
        c.textContent = "Cancel";
        c.style.cssText =
          "flex:none;min-height:36px;padding:6px 14px;border-radius:var(--lumiverse-radius,8px);cursor:pointer;" +
          "font:13px var(--lumiverse-font-family,system-ui);" +
          "border:1px solid var(--lumiverse-border,rgba(255,255,255,.28));" +
          "background:var(--lumiverse-fill-subtle,rgba(0,0,0,.1));color:var(--lumiverse-text,#fff)";
        c.addEventListener("click", () => {
          // The box goes first, then the action runs. Every cancel action
          // already takes the box away as part of what it does, so this
          // changes nothing when they work. It is here for when one does not:
          // pressing Cancel and watching the box sit there is the one outcome
          // this button must never have, and a missed case anywhere in a
          // cancel action would produce exactly that. Hiding first also leaves
          // an action free to put its own message up afterwards, which the
          // button picker does.
          hideToast();
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
      ensureReadableTree(t);
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
    // Taken from the schema rather than listed again here. The old hand-kept
    // list had drifted, so settings added later were missing from every report,
    // which is exactly the information a bug report is supposed to carry. The
    // selectors are printed in full by the buttons section below instead.
    const keys = Object.keys(fieldByKey).filter(
      (k) => !fieldByKey[k].selector,
    );
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
      // First in this section, because it is the one line that explains a
      // report where nothing happened at all. A refused permission raises
      // nothing, so without it a bug report says the extension did nothing and
      // gives no reason.
      lines.push("");
      if (!permList.length) {
        lines.push("permissions: not reported by this build");
      } else {
        const say = (v: boolean | null) =>
          v === true ? "granted" : v === false ? "MISSING" : "unknown";
        lines.push("permissions:");
        for (const p of permList) lines.push("  " + p.name + " = " + say(permIs(p.name)));
      }
      try {
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
      lines.push("this session:");
      // How long the counters below have been running. Without it they cannot
      // be read: no retries after two minutes and no retries after four hours
      // are the same three zeroes and mean opposite things.
      lines.push("  watching for: " + sayTime(Date.now() - stats.since));
      lines.push("  replies that came back fine: " + stats.good);
      lines.push("  retries fired: " + stats.retries);
      lines.push("  messages it gave up on: " + stats.gaveUp);
      // Only when the feature is in use, so a report from someone who has never
      // touched it is not padded with two zeroes.
      if (cfg.refusalNote || stats.notesSent || stats.notesSkipped) {
        lines.push("  refusal notes sent: " + stats.notesSent);
        lines.push("  refusal notes skipped: " + stats.notesSkipped +
          (stats.lastNoteSkip ? " (last: " + stats.lastNoteSkip + ")" : ""));
      }
      // Same figure the Stats tab shows, on the same terms. A swap leaves
      // nothing on screen to look at, so a report about swaps that did not
      // happen is unanswerable without it: zero here separates a rule that
      // never matched from swapping that never ran.
      const swapsAll = Object.keys(stats.swapsByChat)
        .reduce((n, k) => n + stats.swapsByChat[k], 0);
      if (cfg.replaceEnabled || swapsAll) {
        const here =
          stats.swapsByChat[lastChatId == null ? NO_CHAT : String(lastChatId)] || 0;
        lines.push("  words swapped: " + swapsAll + " (" + here + " in this chat)");
      }
      const reasons = Object.keys(stats.reasons).sort(
        (a, b) => stats.reasons[b] - stats.reasons[a],
      );
      if (reasons.length) {
        lines.push("  retries by reason:");
        for (const r of reasons) lines.push("    " + r + ": " + stats.reasons[r]);
      }
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
  // Every saved value as it stood when the panel opened. Closing with the X or
  // a tap outside puts these back, so nothing sticks unless Save is pressed.
  // Held out here rather than inside openSettings because the on/off switch can
  // also be flipped from the floating button while the panel is open, and that
  // has to land here too or dismissing the panel would quietly undo it.
  let modalBaseline: any = null;
  // Close function for the open expand-editor overlay, if any, so it can be shut
  // when the settings modal closes instead of being left floating.
  let closeExpandEditor: (() => void) | null = null;
  // Same, for the warning that stands in front of the crisis-support check.
  let closeCrisisNotice: (() => void) | null = null;

  // A column of checkboxes, one per entry, all ticked to start with. The debug
  // report and the export dialog both offer the same shape of choice, and had
  // the same fifteen lines each to draw it.
  function buildCheckList(items: Array<{ id: string; label: string }>): {
    wrap: HTMLElement;
    checks: Array<{ id: string; input: HTMLInputElement }>;
  } {
    const wrap = document.createElement("div");
    wrap.style.cssText = "display:flex;flex-direction:column;gap:6px";
    const checks: Array<{ id: string; input: HTMLInputElement }> = [];
    for (const it of items) {
      const row = document.createElement("label");
      row.style.cssText =
        "display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = true;
      cb.style.cssText = CHECKBOX_STYLE + "cursor:pointer";
      const txt = document.createElement("span");
      txt.textContent = it.label;
      row.appendChild(cb);
      row.appendChild(txt);
      wrap.appendChild(row);
      checks.push({ id: it.id, input: cb });
    }
    return { wrap, checks };
  }

  function buildSettingsBody(root: HTMLElement, onSaved?: () => void) {
    ensurePanelStyle();
    // The buttons a popover can be anchored to are about to be thrown away.
    hideHint();
    root.innerHTML = "";
    fieldSetters = {};
    chatSwitchPaint = null;
    // The rows the previous one closed over went with the panel, so it is put
    // back to doing nothing until the next build assigns it.
    applyDeps = () => {};
    permPaint = null;
    presetBarRefreshers = [];
    // Ask again on every open. The backend says so when a grant changes, but
    // only on a build that raises that event at all, and a panel that opens
    // showing what was true at startup is a panel that goes on reporting a
    // permission somebody has already turned on.
    askForPermissions();

    // Flush a field the user is still editing into cfg, then normalise every
    // number so a blank or out-of-range box cannot be saved or captured into a
    // preset.
    const commit = () => {
      const active: any =
        typeof document !== "undefined" ? document.activeElement : null;
      if (active && typeof active.blur === "function") active.blur();
      for (const g of SCHEMA)
        for (const fl of g.fields)
          if (fl.type === "num") cfg[fl.key] = clampField(fl, cfg[fl.key]);
    };
    // Everything a change to cfg needs to take effect: written to both stores,
    // then each surface that reads cfg brought into line. Saving and loading a
    // preset both end here, and missing one line is a surface left stale.
    const applyAndSave = (): boolean => {
      const storedHere = saveSaved();
      saveToAccount();
      syncLiveLog();
      syncFloat();
      syncInputBarActions();
      if (onSaved) onSaved();
      return storedHere;
    };

    // A preset switcher: pick a saved preset and Load it into the settings, or
    // save the current settings as a preset. Load updates the on-screen fields in
    // place (no rebuild), so it never jumps the scroll or closes open sections.
    function buildPresetBar(kind: string): HTMLElement {
      const wrap = document.createElement("div");
      // Which set of presets this bar drives. There is more than one bar on the
      // panel now, and they are identical to look at, so anything reaching for
      // one by position finds whichever section happens to come first.
      wrap.setAttribute("data-ar-presets", kind);
      wrap.style.cssText = "display:flex;flex-direction:column;gap:8px";
      const smallBtn = (b: HTMLButtonElement) => {
        b.style.cssText += "min-height:0;padding:7px 12px";
        return b;
      };
      const miniLabel = (text: string) => {
        const l = document.createElement("div");
        l.textContent = text;
        l.style.cssText =
          "font-size:11px;color:var(--lumiverse-text-muted,rgba(255,255,255,.65))";
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
        "flex:1;min-width:150px;padding:8px 10px;border-radius:var(--lumiverse-radius,8px);border:1px solid var(--lumiverse-border,rgba(255,255,255,.16));background:var(--lumiverse-fill-subtle,rgba(0,0,0,.1));color:var(--lumiverse-text,#eee);font:13px var(--lumiverse-font-family,system-ui)";
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
        "font-size:12px;line-height:1.4;color:var(--lumiverse-text-muted,rgba(255,255,255,.65));min-height:1em";

      const presets = loadPresets();
      const list = () => presets[kind] || [];
      // Only this bar's own kind is this bar's to write. The store holds every
      // kind together, and each bar took its copy when the panel was built, so
      // writing that whole copy back would undo anything another bar has saved
      // since. Re-read, replace one key, write: that also survives another tab
      // saving between this panel opening and somebody pressing a button here.
      // What this bar's presets are called, for the log. Two bars write the
      // same kinds of line, so a line that did not say which would be worse
      // than none: loading a set changes settings, and reading back later that
      // "a preset was loaded" leaves you guessing which half of the panel moved.
      const kindLabel = (PRESET_KINDS[kind] && PRESET_KINDS[kind].label
        ? PRESET_KINDS[kind].label
        : kind).toLowerCase();
      const persist = () => {
        const all = loadPresets();
        all[kind] = list();
        return savePresets(all);
      };
      // A control that cannot do anything yet should look that way, rather than
      // sitting there fully lit and then telling you off when you press it.
      // With nothing saved, Load, Update, Delete and Rename all had a live
      // primary button each and nothing to act on.
      const setEnabled = (b: HTMLButtonElement, on: boolean) => {
        b.disabled = !on;
        b.style.opacity = on ? "1" : "0.45";
        b.style.cursor = on ? "pointer" : "not-allowed";
      };
      const syncPresetButtons = () => {
        const picked = !!select.value;
        setEnabled(loadBtn, picked);
        setEnabled(update, picked);
        setEnabled(del, picked);
        setEnabled(rename, picked);
      };
      select.addEventListener("change", syncPresetButtons);

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
        syncPresetButtons();
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
        applyDeps();
        applyAndSave();
        status.textContent = "Loaded preset: " + name + ". It's in effect now.";
        log("loaded the " + kindLabel + " preset " + JSON.stringify(name));
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
        if (!persist()) {
          status.textContent = "Couldn't save the preset on this browser.";
          return;
        }
        nameInput.value = "";
        refreshSelect(name);
        status.textContent = "Saved current settings as: " + name + ".";
        log("saved a " + kindLabel + " preset called " + JSON.stringify(name));
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
        if (!persist()) {
          status.textContent = "Couldn't save on this browser.";
          return;
        }
        nameInput.value = "";
        refreshSelect(newName);
        status.textContent = "Renamed " + cur + " to " + newName + ".";
        log("renamed a " + kindLabel + " preset to " + JSON.stringify(newName));
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
        if (!persist()) {
          status.textContent = "Couldn't save on this browser.";
          return;
        }
        status.textContent =
          "Updated " + name + " to your current settings.";
        log("updated the " + kindLabel + " preset " + JSON.stringify(name));
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
        if (!persist()) {
          status.textContent = "Couldn't save on this browser.";
          return;
        }
        refreshSelect();
        status.textContent = "Deleted preset: " + name + ".";
        log("deleted the " + kindLabel + " preset " + JSON.stringify(name));
      });

      wrap.appendChild(miniLabel("Saved presets"));
      wrap.appendChild(pickRow);
      wrap.appendChild(manageRow);
      wrap.appendChild(miniLabel("Save or rename"));
      wrap.appendChild(saveRow);
      wrap.appendChild(status);
      return wrap;
    }

    // Somewhere to try the refusal settings on real text. Without this the whole
    // section is guesswork: you edit a phrase list, then have to wait for the
    // model to refuse again to find out whether it worked, and a wrong guess
    // costs a re-roll of good writing. This runs the same check a finished reply
    // goes through, against the values in the boxes above rather than the saved
    // ones, so it answers straight away and nothing is sent anywhere.
    function buildRefusalTester(): HTMLElement {
      const wrap = document.createElement("div");
      wrap.style.cssText = "display:flex;flex-direction:column;gap:8px";

      wrap.appendChild(hairline());
      wrap.appendChild(runHeading("Try it on a reply"));
      wrap.appendChild(
        sectionDesc(
          "See whether a reply would count as a refusal, and what decided it. Use my last reply fills the box from the reply on screen behind this panel, or paste one in yourself. It uses the settings as they are in the boxes above, so you can test a change before saving it. Nothing is sent anywhere and no reply is altered.",
          false,
        ),
      );

      const ta = document.createElement("textarea") as any;
      ta.rows = 3;
      ta.placeholder = "Paste a reply here";
      ta.setAttribute("aria-label", "Reply text to test for a refusal");
      styleField(ta);
      ta.style.width = "100%";
      ta.style.boxSizing = "border-box";
      ta.style.resize = "vertical";
      wrap.appendChild(ta);

      const out = document.createElement("div");
      out.style.cssText =
        "font-size:12px;line-height:1.45;min-height:1em;color:var(--lumiverse-text-muted,rgba(255,255,255,.65))";

      // Read off the page rather than out of a copy the extension kept. The
      // last reply is already on screen behind this panel, and reading it at
      // the moment the button is pressed means nothing has to be held onto
      // between replies. SECURITY.md says a reply is read to check it and no
      // copy is kept; a convenience button is not worth making that untrue.
      const lastRenderedReply = (): string => {
        try {
          if (typeof document === "undefined") return "";
          const all = document.querySelectorAll('[data-component="MessageContent"]');
          for (let i = all.length - 1; i >= 0; i--) {
            const t = String((all[i] as any).innerText || all[i].textContent || "").trim();
            if (t) return t;
          }
        } catch (_) {}
        return "";
      };

      const bar = document.createElement("div");
      bar.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;align-items:center";
      const grab = btn("Use my last reply", false);
      grab.style.cssText += "min-height:0;padding:6px 12px;flex:none";
      grab.addEventListener("click", () => {
        const text = lastRenderedReply();
        if (!text) {
          out.textContent =
            "Couldn't find a reply on screen to read. Open a chat with a reply in it and try again.";
          out.style.color = "var(--lumiverse-text-muted,rgba(255,255,255,.65))";
          ensureReadable(out, 2.6);
          return;
        }
        ta.value = text;
        out.textContent = "Filled in from the last reply on screen. Press Check this text.";
        out.style.color = "var(--lumiverse-text-muted,rgba(255,255,255,.65))";
        ensureReadable(out, 2.6);
      });

      const check = btn("Check this text", false);
      check.style.cssText += "min-height:0;padding:6px 12px;flex:none";
      check.addEventListener("click", () => {
        // A box the user is still typing in has not fired its change event yet,
        // so its edit is not in cfg. Blurring first is what makes the test
        // reflect what is actually on screen.
        const active: any =
          typeof document !== "undefined" ? document.activeElement : null;
        if (active && active !== ta && typeof active.blur === "function")
          active.blur();
        const text = String(ta.value || "");
        if (!text.trim()) {
          out.textContent = "Paste some reply text first.";
          out.style.color = "var(--lumiverse-text-muted,rgba(255,255,255,.65))";
          ensureReadable(out, 2.6);
          return;
        }
        const v = refusalVerdict(text, cfg);
        if (v.refusal) {
          out.textContent =
            "This counts as a refusal, so it would retry: " +
            v.reason +
            (cfg.retryOnRefusal
              ? "."
              : '. (But "It looks like an accidental refusal" is off, so nothing would actually be retried.)');
          out.style.color = "var(--lumiverse-success,#22c55e)";
        } else {
          out.textContent =
            "This reads as normal writing, so it would not retry: " + v.reason + ".";
          out.style.color = "var(--lumiverse-text-muted,rgba(255,255,255,.65))";
        }
        ensureReadable(out, 2.6);
      });

      bar.appendChild(grab);
      bar.appendChild(check);
      wrap.appendChild(bar);
      wrap.appendChild(out);
      return wrap;
    }

    // Cap the whole panel to a real viewport value that sits safely under the
    // modal's max-height once its title bar and padding are counted. With the
    // panel bounded and overflow hidden, the host modal has nothing left to
    // over-scroll, so its own full-height scrollbar never appears; only the
    // options list below scrolls. vh units keep it sane on phones too.
    // The pixel cap tracks the modal's own 720: 720 less its title bar and
    // padding leaves roughly 640, so the panel fills the modal without pushing
    // past it. The vh term is what keeps a short screen from overflowing.
    const panel = document.createElement("div");
    panel.style.cssText =
      "display:flex;flex-direction:column;max-height:min(74vh,640px);overflow:hidden;box-sizing:border-box;font:13px/1.45 var(--lumiverse-font-family,system-ui);color:var(--lumiverse-text,#eee)";
    // No shading down the panel. It was tried and taken back out: this element
    // is only the modal's content area, and the header, the frame and the
    // footer around it belong to the host. Anything painted here stops at a
    // hard line where that chrome takes over, so a wash that is meant to read
    // as depth reads as one panel not matching the window it is in.
    matchColorScheme(panel);

    // the one scroll area: flexes to fill whatever height is left after the
    // footer. min-height:0 lets it actually shrink and scroll inside the flex.
    const scroller = document.createElement("div");
    scroller.style.cssText =
      "display:flex;flex-direction:column;gap:18px;flex:1 1 auto;min-height:0;overflow-y:auto;padding-right:4px";

    // ---- search index ----
    // There are over fifty settings across eight sections, five of them shut,
    // so finding one meant remembering which section it lived under. Each row is
    // registered here with its label, its description and its option name, and
    // the section it sits in, so a search can show the row and open its section.
    interface SectionHandle {
      sec: HTMLElement;
      title: string;
      keywords: string;
      setOpen: ((open: boolean) => void) | null;
    }
    const panelSections: SectionHandle[] = [];
    const searchRows: Array<{ row: HTMLElement; text: string; section: SectionHandle }> = [];
    // Labelled runs of rows inside a group, hidden by a search once none of
    // their rows match so a heading is never left standing over nothing.
    const subRuns: HTMLElement[] = [];
    // Rows that only mean something while some switch is on. Kept out of the
    // panel while it is off, so what is on screen is what is in use.
    // Groups rather than a flat list, matching depNotes below: any switch
    // inside a group is enough, and every group has to be satisfied.
    const depRows: Array<{ row: HTMLElement; groups: string[][] }> = [];
    const depSections: Array<{ sec: HTMLElement; needs: string[] }> = [];
    // A row found by searching while the switch it hangs off is still off. The
    // row is shown, because refusing to find a setting that exists is the worse
    // answer, and this line says which switch would make it do something. Its
    // needs are the row's own plus its section's, since a row inside a section
    // that is switched off is just as inert as one hidden on its own.
    // Held as a list of groups rather than one flat list of switches, because
    // the two kinds of dependency combine differently. Any one switch inside a
    // group is enough, which is the case for a setting two buttons both read.
    // Every group has to be satisfied, because a row inside a section that is
    // switched off is inert whatever its own switch says.
    const depNotes: Array<{ row: HTMLElement; note: HTMLElement; groups: string[][] }> = [];
    const nameOf = (k: string) => {
      const f = fieldByKey[k];
      return f ? f.label : k;
    };
    const paintDepNotes = (searching: boolean) => {
      for (const d of depNotes) {
        const unmet = d.groups.filter((g) => !g.some((k) => !!(cfg as any)[k]));
        const show = searching && unmet.length > 0 && d.row.style.display !== "none";
        d.note.style.display = show ? "block" : "none";
        // Rebuilt each time: which switch is the one still missing changes as
        // the others are turned on.
        d.note.textContent = show
          ? "Needs " +
            unmet
              .map((g) => g.map((k) => '"' + nameOf(k) + '"').join(" or "))
              .join(" and ") +
            " switched on."
          : "";

      }
    };
    // Called whenever one of those switches moves, and after anything that
    // reloads the whole form, which is a preset, an import or a reset.
    //
    // A search is left alone. Searching is someone asking where a setting is,
    // and answering "nothing matches that" for one that exists, because a
    // switch it depends on is off, would be a worse answer than showing it.
    // Held rather than closed over directly, because applyDeps can run before
    // the search box has been built and a const would still be in its dead zone.
    let searchBox: any = null;
    // Same reason as searchBox: applyDeps is defined long before this element
    // is built, and a const would still be in its dead zone if it ever ran early.

    applyDeps = () => {
      // Ahead of the search guard: whether the master switch is off has nothing
      // to do with what is being searched for, and this must not go stale.
      syncMasterNote();
      if (searchBox && String(searchBox.value || "").trim()) {
        // The rows stay where the search put them, but the line naming the
        // switch a row is waiting on does not: turning that switch on from the
        // search results left the row still claiming to be waiting for it.
        paintDepNotes(true);
        return;
      }
      for (const d of depRows) {
        const on = d.groups.every((g) => g.some((k) => !!(cfg as any)[k]));
        d.row.style.display = on ? "flex" : "none";
      }
      for (const d of depSections) {
        const on = d.needs.some((k) => !!(cfg as any)[k]);
        d.sec.style.display = on ? "flex" : "none";
      }
      // A run whose rows have all gone takes its heading with it, the same way
      // it does under a search.
      for (const w of subRuns) {
        const rows = w.querySelectorAll("[data-ar-row]");
        let any = rows.length === 0;
        for (let i = 0; i < rows.length; i++)
          if ((rows[i] as HTMLElement).style.display !== "none") any = true;
        w.style.display = any ? "flex" : "none";
      }
      paintDepNotes(false);
    };
    const searchText = (...parts: any[]) =>
      parts.map((p) => String(p == null ? "" : p)).join(" ").toLowerCase();

    // The three pieces every section is made of. Each of these was written out
    // once per section, so the same heading was styled in three places and the
    // two hand-built sections at the bottom had drifted a little from the ones
    // built from the schema. One copy each, and they cannot drift again.
    const MUTED = "var(--lumiverse-text-muted,rgba(255,255,255,.65))";
    // The box a section's rows sit in. Written out at each of the three places
    // that build one, which is how the two hand-built sections drifted from the
    // schema-built ones in the first place.
    const SECTION_CSS = "display:flex;flex-direction:column;gap:10px";
    const HEADING_CSS =
      "font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:" + MUTED;
    function sectionHeader(
      title: string,
      collapsible: boolean,
    ): { header: HTMLElement; caret: HTMLElement } {
      const header = document.createElement("div");
      // A rule under the heading. Sections were text sitting above rows with
      // nothing between them, so on a long panel one section ran into the next
      // and the headings read as another row rather than as a break. Drawn in
      // the theme's own border colour, which is faint by design: enough to
      // separate, not enough to become furniture.
      header.style.cssText =
        "font-size:11px;letter-spacing:.07em;text-transform:uppercase;font-family:var(--lumiverse-font-family,system-ui);" +
        "padding-bottom:7px;border-bottom:1px solid var(--lumiverse-border,rgba(255,255,255,.12));color:" +
        MUTED;
      const caret = document.createElement("span");
      if (!collapsible) {
        header.textContent = title;
        return { header: header, caret: caret };
      }
      header.style.cursor = "pointer";
      header.style.userSelect = "none";
      header.style.display = "flex";
      header.style.alignItems = "center";
      header.style.gap = "6px";
      caret.textContent = CARET_SHUT;
      caret.style.cssText = "font-size:9px";
      const label = document.createElement("span");
      label.textContent = title;
      header.appendChild(caret);
      header.appendChild(label);
      return { header: header, caret: caret };
    }
    // The line under a heading. Pulled up by a few pixels only when it sits
    // directly under an open section's heading; inside a collapsed section's
    // body the gap is already right.
    function sectionDesc(text: string, tight: boolean): HTMLElement {
      const d = document.createElement("div");
      d.textContent = text;
      d.style.cssText =
        "font-size:12px;line-height:1.45;color:" + MUTED + (tight ? ";margin-top:-4px" : "");
      return d;
    }
    function runHeading(text: string): HTMLElement {
      const h2 = document.createElement("div");
      h2.textContent = text;
      h2.style.cssText = HEADING_CSS;
      return h2;
    }
    function hairline(): HTMLElement {
      const r = document.createElement("div");
      r.style.cssText =
        "height:1px;background:var(--lumiverse-border,rgba(255,255,255,.08));margin:4px 0 2px";
      return r;
    }

    // Every collapsible header goes through here. They were plain elements with
    // a click handler, which left all five collapsed sections unreachable
    // without a pointer: no tab stop, and nothing telling a screen reader that
    // the header opened anything. Doing it in one place also means the caret,
    // the remembered open state and the announced state cannot drift apart,
    // which they could when this was written out three times over.
    function makeCollapsible(
      h: HTMLElement,
      body: HTMLElement,
      caret: HTMLElement,
      title: string,
    ): (open: boolean) => void {
      const apply = (v: boolean) => {
        body.style.display = v ? "flex" : "none";
        caret.textContent = v ? CARET_OPEN : CARET_SHUT;
        h.setAttribute("aria-expanded", v ? "true" : "false");
      };
      h.setAttribute("role", "button");
      h.setAttribute("tabindex", "0");
      const toggle = () => {
        const open = body.style.display !== "none";
        apply(!open);
        if (!open) openGroups.add(title);
        else openGroups.delete(title);
      };
      h.addEventListener("click", toggle);
      h.addEventListener("keydown", (e: any) => {
        if (!e) return;
        // What a real button answers to. Space is swallowed as well, or it
        // would page the panel down at the same time as opening the section.
        if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
          e.preventDefault();
          toggle();
        }
      });
      apply(openGroups.has(title));
      return apply;
    }

    for (const group of SCHEMA) {
      const sec = document.createElement("div");
      sec.style.cssText = SECTION_CSS;
      const handle: SectionHandle = {
        sec: sec,
        title: group.title,
        keywords: searchText(group.title, group.desc),
        setOpen: null,
      };
      panelSections.push(handle);
      if (group.needs && group.needs.length)
        depSections.push({ sec: sec, needs: group.needs });
      const addRow = (row: HTMLElement, f: Field) => {
        searchRows.push({
          row: row,
          text: searchText(f.label, f.hint, f.key, group.title),
          section: handle,
        });
        // The row's own switches, then its section's. Each entry in needsAll
        // is its own group, which is what makes them all required.
        const own: string[][] = [];
        if (f.needs && f.needs.length) own.push(f.needs);
        if (f.needsAll && f.needsAll.length) for (const k of f.needsAll) own.push([k]);
        if (own.length) depRows.push({ row: row, groups: own });
        const groups: string[][] = own.slice();
        if (group.needs && group.needs.length) groups.push(group.needs);
        if (groups.length) {
          const note = document.createElement("div");
          note.style.cssText =
            "display:none;font-size:11px;line-height:1.4;color:var(--lumiverse-text-muted,rgba(255,255,255,.65))";
          row.appendChild(note);
          depNotes.push({ row: row, note: note, groups: groups });
        }
        return row;
      };

      // A labelled run of rows inside a group, so a long list can say what its
      // parts have in common. Registered so a search can hide the whole run,
      // heading included, once none of its rows match.
      const subGroup = (into: HTMLElement, title: string, note: string) => {
        const wrap = document.createElement("div");
        wrap.style.cssText = "display:flex;flex-direction:column;gap:10px";
        wrap.appendChild(runHeading(title));
        wrap.appendChild(sectionDesc(note, true));
        into.appendChild(wrap);
        subRuns.push(wrap);
        return wrap;
      };

      // Find and replace is split by what a preset carries. Half these options
      // change when you load a preset and half never do, and there was no way
      // to tell which from looking. The split is worked out from the preset
      // definition rather than written out a second time, so the headings
      // cannot end up claiming something that is not true.
      const emitFields = (into: HTMLElement) => {
        if (!group.splitByPreset) {
          // Rows naming a run go under one heading together. Anything without
          // a run goes straight into the group, and closes any run above it.
          let open: { key: string; el: HTMLElement } | null = null;
          for (const f of group.fields) {
            const key = f.run;
            if (!key || !RUNS[key]) {
              open = null;
              into.appendChild(addRow(buildRow(f), f));
              continue;
            }
            if (!open || open.key !== key)
              open = { key: key, el: subGroup(into, RUNS[key].title, RUNS[key].note) };
            open.el.appendChild(addRow(buildRow(f), f));
          }
          return;
        }
        const held = keysForKind("swap");
        const isHeld = (f: Field) => held.indexOf(f.key as string) >= 0;
        // The main switch stays at the top on its own; it reads as the heading
        // for the whole section rather than as one of the options below it.
        for (const f of group.fields)
          if (f.key === "replaceEnabled") into.appendChild(addRow(buildRow(f), f));
        const rest = group.fields.filter((f) => f.key !== "replaceEnabled");
        const a = subGroup(
          into,
          "Saved in a preset",
          "Loading a preset replaces these, and saving one stores them.",
        );
        for (const f of rest) if (isHeld(f)) a.appendChild(addRow(buildRow(f), f));
        const b = subGroup(
          into,
          "Yours, whatever preset you load",
          "No preset touches these. Loading a preset cannot switch swapping on for you, or take away the confirmation step.",
        );
        for (const f of rest) if (!isHeld(f)) b.appendChild(addRow(buildRow(f), f));
      };

      if (group.collapsed) {
        const { header, caret } = sectionHeader(group.title, true);
        sec.appendChild(header);

        const body = document.createElement("div");
        body.style.cssText = "display:none;flex-direction:column;gap:10px";
        if (group.desc) body.appendChild(sectionDesc(group.desc, false));
        emitFields(body);
        const hasExtra = (n: string) =>
          Array.isArray(group.extra) ? group.extra.indexOf(n as any) >= 0 : group.extra === n;
        // Two kinds of thing hang off the end of a section, in this order.
        //
        // A preset bar comes first, straight under the settings it saves, so
        // it sits next to what it acts on.
        //
        // A tester comes last. It is not a setting and saves nothing, it is
        // somewhere to try the settings out, so it goes after all of them.
        if (hasExtra("swapPresets")) {
          body.appendChild(hairline());
          body.appendChild(runHeading("Presets"));
          body.appendChild(
            sectionDesc(
              "Save your current word swaps as a named setup and switch between them. Applying takes effect right away. Saved to your account, so they follow you to other devices.",
              false,
            ),
          );
          body.appendChild(buildPresetBar("swap"));
        }
        if (hasExtra("notePresets")) {
          body.appendChild(hairline());
          body.appendChild(runHeading("Note presets"));
          body.appendChild(
            sectionDesc(
              "Save the notes above as a named set and switch between them. A set carries the notes and where they go, and nothing else: loading one never turns notes on or off. Saved to your account, so they follow you to other devices.",
              false,
            ),
          );
          body.appendChild(buildPresetBar("notes"));
        }
        if (hasExtra("refusalTester")) body.appendChild(buildRefusalTester());
        sec.appendChild(body);

        handle.setOpen = makeCollapsible(header, body, caret, group.title);
      } else {
        sec.appendChild(sectionHeader(group.title, false).header);
        if (group.desc) sec.appendChild(sectionDesc(group.desc, true));
        emitFields(sec);
        // The switch for the chat you are in, and the only place it is. Basics
        // is where somebody looks for a switch, and the floating button's menu
        // is not: that button sits over the chat and its menu is opened for the
        // button's own business, so a per-chat switch among those entries read
        // as clutter. Built by hand rather than added to the form because it is
        // not a setting. It belongs to one chat, it is kept in the browser, and
        // it does not belong in an export, an import or a reset with the rest.
        if (group.title === "Basics") sec.appendChild(buildChatSwitchRow());
      }
      scroller.appendChild(sec);
    }

    // debug info section (collapsible): choose what to include, review, redact, copy
    {
      const sec = document.createElement("div");
      sec.style.cssText = SECTION_CSS;
      const { header: h, caret } = sectionHeader("Debug info", true);
      sec.appendChild(h);
      const handle: SectionHandle = {
        sec: sec,
        title: "Debug info",
        keywords: "advanced debug info bug report copy diagnostics activity log version",
        setOpen: null,
      };
      panelSections.push(handle);

      const body = document.createElement("div");
      body.style.cssText = "display:none;flex-direction:column;gap:10px";
      body.appendChild(
        sectionDesc(
          "A snapshot for your own debugging or a bug report. Tick the parts to include, build a preview, edit out anything you would rather not share, then copy. Nothing leaves your device until you paste it somewhere.",
          false,
        ),
      );

      // Named after everything in the section, the same rule the import and
      // export parts follow. Two of these carried something their name did not
      // mention, and both were the part somebody would untick: the selectors
      // you wrote sit with whether they match, and your permissions sit with
      // the browser string. A permission missing is the one line that explains
      // a report where nothing happened at all, so it must not be dropped by
      // someone who thought they were only leaving out their screen size.
      const sections: Array<{
        id: "settings" | "buttons" | "environment" | "activity";
        label: string;
      }> = [
        { id: "settings", label: "Your settings" },
        { id: "buttons", label: "Buttons and selectors" },
        { id: "environment", label: "Permissions, browser and screen" },
        { id: "activity", label: "Session totals and recent activity" },
      ];
      const { wrap: dWrap, checks: dchecks } = buildCheckList(sections);
      body.appendChild(dWrap);

      const opts = () => {
        const o: any = {};
        for (const c of dchecks) o[c.id] = c.input.checked;
        return o;
      };
      const dStatus = document.createElement("div");
      dStatus.style.cssText =
        "font-size:12px;line-height:1.4;color:var(--lumiverse-text-muted,rgba(255,255,255,.65));min-height:1em";
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
      handle.setOpen = makeCollapsible(h, body, caret, "Debug info");
      scroller.appendChild(sec);
    }

    // import / export section (collapsible, same as the schema's own)
    {
      const sec = document.createElement("div");
      sec.style.cssText = SECTION_CSS;
      const { header: h, caret } = sectionHeader("Import / export", true);
      sec.appendChild(h);
      const handle: SectionHandle = {
        sec: sec,
        title: "Import / export",
        keywords: "advanced import export backup file share transfer settings presets json",
        setOpen: null,
      };
      panelSections.push(handle);

      const body = document.createElement("div");
      body.style.cssText = "display:none;flex-direction:column;gap:10px";
      body.appendChild(
        sectionDesc(
          "Save settings to a file or load them from one. Tick the parts to include, then Export or Import. An import fills in the settings above without saving, so you can review first: press Save to keep it, or close to discard.",
          false,
        ),
      );

      const { wrap: checkWrap, checks } = buildCheckList(EXPORT_CATEGORIES);
      body.appendChild(checkWrap);
      const chosen = () =>
        checks.filter((x) => x.input.checked).map((x) => x.id);

      const status = document.createElement("div");
      status.style.cssText =
        "font-size:12px;line-height:1.4;color:var(--lumiverse-text-muted,rgba(255,255,255,.65));min-height:1em";

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
          applyDeps();
          let msg = "";
          if (applied.length)
            msg = "Imported: " + applied.join(", ") + ". Press Save to keep it.";
          if (presetCount > 0)
            msg +=
              (msg ? " " : "") +
              "Also brought in " +
              presetCount +
              " preset" +
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
      handle.setOpen = makeCollapsible(h, body, caret, "Import / export");
      scroller.appendChild(sec);
    }

    // ---- the search box ----
    // Sits above the scroll area so it stays put while the results move. An
    // empty box puts everything back exactly as it was, including which sections
    // the user had open, so searching never quietly rearranges the panel.
    const searchWrap = document.createElement("div");
    searchWrap.style.cssText =
      "display:flex;flex-direction:column;gap:6px;flex:none;margin-bottom:12px";
    const search = document.createElement("input");
    search.type = "search";
    search.id = SEARCH_ID;
    search.placeholder = "Search settings";
    search.setAttribute("aria-label", "Search settings");
    styleField(search, { mark: false });
    search.style.width = "100%";
    search.style.boxSizing = "border-box";
    const searchNote = document.createElement("div");
    searchNote.style.cssText =
      "font-size:12px;min-height:1em;color:var(--lumiverse-text-muted,rgba(255,255,255,.65))";

    const runSearch = () => {
      hideHint();
      const q = search.value.trim().toLowerCase();
      // Every row buildRow makes is a flex column, so hidden rows are put back
      // to "flex" rather than "". Clearing the property instead would drop the
      // display that the row's own inline style set, and a <label> row would
      // fall back to inline and lose its layout.
      if (!q) {
        for (const r of searchRows) r.row.style.display = "flex";
        for (const w of subRuns) w.style.display = "flex";
        for (const s of panelSections) {
          s.sec.style.display = "flex";
          if (s.setOpen) s.setOpen(openGroups.has(s.title));
        }
        // Everything came back, including rows whose switch is off. They go
        // again here rather than being left behind by the search. Clearing the
        // "waiting on" lines is part of that, so it is not repeated here.
        applyDeps();
        searchNote.textContent = "";
        return;
      }
      let hits = 0;
      for (const s of panelSections) {
        // A section whose own title matches keeps all of its rows, so searching
        // for a section name browses it rather than emptying it.
        const titleHit = s.keywords.indexOf(q) >= 0;
        let any = titleHit;
        for (const r of searchRows) {
          if (r.section !== s) continue;
          const hit = titleHit || r.text.indexOf(q) >= 0;
          r.row.style.display = hit ? "flex" : "none";
          if (hit) {
            any = true;
            hits++;
          }
        }
        s.sec.style.display = any ? "flex" : "none";
        if (any && s.setOpen) s.setOpen(true);
      }
      // A heading with nothing left under it reads as a mistake, so a run goes
      // once its last row does.
      for (const w of subRuns) {
        const rows = w.querySelectorAll("[data-ar-row]");
        let any = false;
        for (let i = 0; i < rows.length; i++)
          if ((rows[i] as HTMLElement).style.display !== "none") any = true;
        w.style.display = any ? "flex" : "none";
      }
      // Anything the search turned up that its switch has not enabled says so,
      // rather than looking like a setting that does nothing when changed.
      paintDepNotes(true);
      searchNote.textContent = hits
        ? hits + (hits === 1 ? " setting matches" : " settings match")
        : "Nothing matches that. Clear the box to see everything again.";
    };
    searchBox = search;
    search.addEventListener("input", runSearch);
    searchWrap.appendChild(search);
    searchWrap.appendChild(searchNote);
    // Auto Retry can be switched off from the floating button or the Extras
    // menu without opening this panel, so someone can arrive here with it off
    // and no sign of why nothing is happening. Nothing is hidden or greyed for
    // it: off means paused, not unconfigured, and setting it up while it is off
    // is a normal thing to want to do.
    // Filled in by syncMasterNote, which has two states to describe rather than
    // one: the master switch being off, and this chat being one it was told to
    // leave alone. Someone who switched a chat off and forgot has no way to
    // tell that from the extension having broken, so the panel says which.
    //
    // Words only, no button. Both switches this line describes have their own
    // row below it, and each of those says what it will do. A button here would
    // be a second control for the same switch, far enough from the first that a
    // reader has to work out whether they do the same thing. This says what is
    // true and leaves the doing to the rows.
    const masterNote = document.createElement("div");
    masterNote.style.cssText =
      "display:none;flex:none;margin:0 0 10px;font-size:12px;line-height:1.45;" +
      "color:var(--lumiverse-text-muted,rgba(255,255,255,.65))";
    masterNote.setAttribute("data-ar-master", "1");
    // Above the search box rather than below it. This is the panel's own state
    // and it stays put, while the line under the box is about the search and
    // comes and goes, so the lasting one reads first.
    panel.appendChild(buildPermissionNotice());
    panel.appendChild(masterNote);
    masterNoteEl = masterNote;
    syncMasterNote();
    panel.appendChild(searchWrap);

    panel.appendChild(scroller);

    // footer: a plain bar below the scroll area, set off by a single hairline
    // rule. flex-wrap lets the buttons stack on a narrow phone screen.
    const actions = document.createElement("div");
    actions.style.cssText =
      "display:flex;align-items:center;flex-wrap:wrap;gap:8px;flex:none;margin-top:14px;padding-top:14px;border-top:1px solid var(--lumiverse-border,rgba(255,255,255,.08))";
    const status = document.createElement("span");
    // Named so the browser checks can read this line rather than guessing at it
    // by tag and text, which is how a check ends up passing over nothing.
    status.setAttribute("data-ar-save-status", "");
    status.style.cssText =
      "flex:1;min-width:120px;font-size:12px;color:var(--lumiverse-text-muted,rgba(255,255,255,.65))";

    // Opens the picker rather than resetting on the spot. There is no confirm
    // dialog in front of it any more: the picker itself is the confirmation,
    // it says what each part would change before anything happens, and what it
    // does is undone by closing the panel instead of pressing Save.
    const reset = btn("Reset…", false);
    reset.setAttribute("aria-label", "Reset settings, choose which parts");
    reset.addEventListener("click", () => {
      openResetPicker((done) => {
        // Deleting presets is the one thing here that has already happened, so
        // a line telling the user to press Save after only doing that would be
        // telling them to save something that is not waiting on them.
        status.textContent = done.settings
          ? "Reset in the panel. Press Save to keep it."
          : done.presets
            ? "Presets deleted."
            : "";
      });
    });

    const save = btn("Save", true);
    save.addEventListener("click", () => {
      commit();
      const storedHere = applyAndSave();
      if (!storedHere) {
        // Left on screen rather than cleared after a moment: this one is not a
        // confirmation somebody can miss without cost.
        status.textContent =
          "Could not save in this browser. Check that it is not blocking site data.";
        log("settings could not be saved in this browser");
        return;
      }
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
    // The panel opens showing only what is switched on, rather than showing
    // everything for a frame and then dropping the rows that are not in use.
    applyDeps();
    // Secondary text (hints, section headers, status lines) is meant to read
    // quieter than the rest, so it is held to a gentler floor than the controls
    // and only repainted on a theme where it has all but vanished.
    ensureReadableTree(panel, 2.6);
  }


  // What is missing, and what that costs. Drawn only while something is
  // actually missing, so a correctly installed extension carries no panel
  // furniture for a problem it does not have.
  //
  // This exists because a refused permission is the one failure that raises
  // nothing anywhere: a gated event never fires, and a fire-and-forget
  // registration silently does nothing. Every other fault in here reports
  // itself somewhere. This one leaves the extension installed and apparently
  // working while it does none of what it was asked to.
  function buildPermissionNotice(): HTMLElement {
    const box = document.createElement("div");
    box.setAttribute("data-ar-perms", "1");
    const paint = () => {
      box.replaceChildren();
      const missing = permList.filter(
        (p) => permIs(p.name) === false && !permIsHidden(p.name),
      );
      if (!missing.length) {
        box.style.display = "none";
        return;
      }
      box.style.display = "block";
      box.style.cssText +=
        ";margin:0 0 10px;padding:8px 10px;font-size:12px;line-height:1.45;" +
        "border-radius:var(--lumiverse-radius-sm,5px);" +
        "border-left:3px solid var(--lumiverse-primary,rgba(147,112,219,.9));" +
        "background:var(--lumiverse-primary-020,rgba(147,112,219,.2));" +
        "color:var(--lumiverse-text,#e9e4f0)";
      const head = document.createElement("div");
      head.style.cssText = "font-weight:600;margin-bottom:4px";
      head.textContent =
        missing.length === 1
          ? "A permission this extension needs is not granted"
          : missing.length + " permissions this extension needs are not granted";
      box.appendChild(head);
      for (const p of missing) {
        const line = document.createElement("div");
        line.style.cssText =
          "margin-top:3px;display:flex;align-items:flex-start;gap:8px";
        const words = document.createElement("span");
        words.style.cssText = "flex:1;min-width:0";
        const who = document.createElement("span");
        who.style.fontFamily = "var(--lumiverse-font-mono,ui-monospace,monospace)";
        who.textContent = p.name;
        words.appendChild(who);
        words.appendChild(document.createTextNode(". " + p.costs));
        line.appendChild(words);
        // Puts this one away for good. Sized for a thumb rather than drawn as
        // a hairline cross, since this panel is read on a phone as often as on
        // a computer.
        const shut = document.createElement("button");
        shut.type = "button";
        shut.textContent = "\u00d7";
        shut.title = "Hide this note until you reload. The debug report lists every permission either way.";
        shut.setAttribute("aria-label", "Hide the note about the " + p.name + " permission until you reload");
        shut.style.cssText =
          "flex:none;cursor:pointer;border:0;background:transparent;padding:0;" +
          "width:28px;height:28px;margin:-4px -4px 0 0;line-height:1;font-size:16px;" +
          "font-family:inherit;color:inherit;opacity:.65;border-radius:var(--lumiverse-radius-sm,5px);" +
          "touch-action:manipulation";
        shut.addEventListener("pointerenter", () => { shut.style.opacity = "1"; });
        shut.addEventListener("pointerleave", () => { shut.style.opacity = ".65"; });
        shut.addEventListener("click", () => {
          permHidden.add(p.name);
          paint();
        });
        line.appendChild(shut);
        box.appendChild(line);
      }
      const how = document.createElement("div");
      how.style.cssText = "margin-top:6px;opacity:.85";
      how.textContent =
        "These are approved in Lumiverse's own extension settings. Some are privileged, which means an admin has to grant them. If you turned one off on purpose, press the \u00d7 to hide its note until you reload the page.";
      box.appendChild(how);
      try { ensureReadableTree(box, 2.6); } catch (_) {}
    };
    paint();
    permPaint = paint;
    return box;
  }

  // Per-chat on and off, shaped like the rows around it so it does not read as
  // something bolted on, but holding no setting.
  function buildChatSwitchRow(): HTMLElement {
    const row = document.createElement("div");
    row.setAttribute("data-ar-chat-switch", "1");
    row.style.cssText = "display:flex;flex-direction:column;gap:5px";
    const top = document.createElement("div");
    top.style.cssText =
      "display:flex;align-items:center;gap:10px;justify-content:space-between";
    const label = document.createElement("span");
    label.style.cssText = "flex:1;min-width:0";
    const act = btn("", false);
    act.style.cssText += "min-height:0;padding:5px 12px;font-size:12px;flex:none";
    const note = document.createElement("div");
    note.style.cssText =
      "font-size:12px;line-height:1.45;color:var(--lumiverse-text-muted,rgba(255,255,255,.65))";

    const paint = () => {
      const known = lastChatId != null;
      const off = chatIsOff(lastChatId);
      // Asked from here too, so a chat that reached the extension by some route
      // nobody thought of still gets a name the moment this is looked at.
      if (known) ensureChatName(lastChatId);
      const who = known ? chatNames.get(String(lastChatId)) : "";
      // Named when the host will say who this chat is with, because "this chat"
      // is correct and tells you nothing, and the header naming it may not be
      // in view on a phone. A group chat is named by its primary card.
      label.textContent = who ? "This chat, with " + who : "This chat";
      act.textContent = off ? "Turn on here" : "Turn off here";
      act.disabled = !known;
      act.style.opacity = known ? "1" : "0.45";
      act.style.cursor = known ? "pointer" : "not-allowed";
      note.textContent = !known
        // Two ways to have no chat to act on, and they read as different
        // things. Being told there is none is the home screen, or anywhere else
        // outside a chat, and "open a chat" is the right thing to say there.
        //
        // Not being told anything is the chats permission refused or not yet
        // approved, since with it granted the question above answers itself a
        // moment after the panel opens. Saying "open a chat" there would be
        // wrong in front of somebody sitting in one. Anything happening in a
        // chat tells it: a reply arriving does, and so does sending a message
        // or switching away and back. Updating the extension while sitting in a
        // chat is the case that leaves it waiting, because nothing re-renders
        // and so nothing announces which chat you are in.
        ? outsideAnyChat()
          ? "No chat is open, so there is nothing to switch off here. Open a chat and this is ready. Every chat carries on as it is."
          : "Waiting to find out which chat this is. Send a message, or switch to another chat and back, and this is ready. Every other chat carries on as it is."
        : isCardless(lastChatId)
          // A temporary chat, so the switch is real but lasts only as long as
          // the chat does. Said plainly, since the wording for an ordinary chat
          // promises it is remembered and here it is not.
          ? off
            ? "Auto Retry is off in this temporary chat. Every other chat carries on as it is. This lasts while the chat is open and is not remembered, since the chat itself is not kept."
            : "Switch Auto Retry off for this temporary chat, to watch what the model does without anything re-rolling it. This lasts while the chat is open and is not remembered, since the chat itself is not kept."
          : off
            ? "Auto Retry is switched off in this chat. Every other chat carries on as it is. This is remembered, and it is kept in this browser rather than in your settings."
            : "Switch Auto Retry off in this chat alone, for a scene where the model is meant to refuse. Every other chat carries on as it is.";
    };
    act.addEventListener("click", () => {
      const off = chatIsOff(lastChatId);
      // setChatOff repaints this row along with everything else that describes
      // the chat, so there is nothing to do here but say what happened.
      // Read before the change, since the row repaints during it.
      const temporary = isCardless(lastChatId);
      const remembered = setChatOff(lastChatId, !off);
      const said = off
        ? "Auto Retry is back on in this chat."
        : "Auto Retry is off in this chat. Other chats are unaffected.";
      showToast(
        remembered
          ? said
          : temporary
            // Not a failure to save, which is what the other wording means. A
            // temporary chat is not kept, so neither is anything about it.
            ? said + " It lasts while this temporary chat is open."
            : said + " This browser will not remember it after a reload.",
        { force: true },
      );
    });
    paint();
    // Held so the row can be repainted from outside. It is built once when the
    // panel opens, and the chat it describes can be learned a moment later.
    chatSwitchPaint = paint;
    // Opening the panel is the moment somebody wants to use this row, so it is
    // worth asking outright rather than showing whatever was learned last.
    //
    // Asked every time, not only when there is nothing to show. The id here is
    // learned from things happening in a chat, and leaving one for the home
    // screen is not a thing happening in a chat: on a build that says nothing
    // when you walk away, the row went on naming the chat you had left and
    // offered to switch Auto Retry off in it. The answer to this clears it when
    // the backend can see that no chat is open.
    askActiveChat();
    top.appendChild(label);
    top.appendChild(act);
    row.appendChild(top);
    row.appendChild(note);
    return row;
  }

  function buildRow(f: Field): HTMLElement {
    // bool/num wrap in <label> so the whole row toggles or focuses its control.
    // text rows use <div> because they contain a Test button, which shouldn't sit inside a label.
    const row = document.createElement(f.type === "text" ? "div" : "label");
    // Marks the row as the thing a hint popover measures itself against, and
    // names which setting it holds, which is what the checks read to tell a
    // duration apart from a plain number.
    row.setAttribute("data-ar-row", String(f.key || "1"));
    row.style.cssText =
      "display:flex;flex-direction:column;gap:5px;cursor:" +
      (f.type === "text" ? "default" : "pointer");

    // The description belongs to the "?" next to the label (hover on a mouse,
    // tap on touch) and is shown in a popover over the panel, so revealing one
    // never moves the rows underneath it.
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
    if (f.hint) {
      ensurePanelStyle();
      const info = document.createElement("button");
      info.type = "button";
      info.textContent = "?";
      info.setAttribute("aria-label", "Show description for " + f.label);
      // Marks it for the dismiss handler, which leaves the "?" alone so its own
      // click can close a popover rather than closing and reopening it.
      info.setAttribute("data-ar-hint", "1");
      if (f.hintAbove) info.setAttribute("data-ar-hint-above", "1");
      // Size and text size are in the panel stylesheet, not here, so the
      // coarse-pointer rule can raise them. Everything else is inline.
      info.style.cssText =
        "flex:none;padding:0;line-height:1;border-radius:50%;border:1px solid var(--lumiverse-border,rgba(255,255,255,.3));background:transparent;color:var(--lumiverse-text-muted,rgba(255,255,255,.65));cursor:pointer";
      const paint = (on: boolean) => {
        info.style.borderColor = on
          ? "var(--lumiverse-primary,rgba(147,112,219,.9))"
          : "var(--lumiverse-border,rgba(255,255,255,.3))";
        info.style.color = on
          ? "var(--lumiverse-primary,rgba(147,112,219,.9))"
          : "var(--lumiverse-text-muted,rgba(255,255,255,.65))";
      };
      const mine = () => hintAnchor === info;
      const open = () => {
        showHint(info, String(f.hint), () => paint(false));
        paint(true);
      };
      // A mouse reveals on hover, a keyboard on focus, a finger on tap. Which
      // one is happening is read off each event rather than decided once from
      // the screen: a phone showing the desktop site says it can hover, and
      // that answer wired up the hover pair and switched the tap off, leaving a
      // description that opened on a tap with nothing able to close it.
      const leave = () => {
        if (mine()) hideHint();
      };
      info.addEventListener("mouseenter", (e: any) => {
        if (fromMouse(e)) open();
      });
      // Asked, unlike the menu entry's. A tap opens this one, and the finger
      // leaving afterwards would close it again in the same gesture.
      info.addEventListener("mouseleave", (e: any) => {
        if (fromMouse(e)) leave();
      });
      // Focus opens it only when a key put you there. A tap focuses the button
      // too, and opening from that as well would fight the tap below.
      //
      // Blur closes only what focus opened. A finger reading a long
      // description touches the popover, which takes focus off the button, and
      // closing on that would shut the thing being read.
      let byFocus = false;
      info.addEventListener("focus", () => {
        let byKey = true;
        try { byKey = info.matches(":focus-visible"); } catch (_) {}
        if (!byKey) return;
        byFocus = true;
        open();
      });
      info.addEventListener("blur", () => {
        if (!byFocus) return;
        byFocus = false;
        leave();
      });
      info.addEventListener("click", (e: any) => {
        // Stop the row-label from toggling its control when the button is clicked.
        if (e) {
          e.preventDefault();
          e.stopPropagation();
        }
        // On touch, click toggles. On a mouse, hover already handles it.
        if (fromMouse(e)) return;
        if (mine()) hideHint();
        else open();
      });
      labelWrap.appendChild(info);
    }
    top.appendChild(labelWrap);

    if (f.type === "bool") {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = !!cfg[f.key];
      input.style.cssText = CHECKBOX_STYLE + "cursor:pointer";
      input.addEventListener("change", () => {
        // Turning the crisis check on is the one tick that has to be answered
        // for first. The box goes back to where it was straight away, so the
        // panel never shows it on while the question is still open, and it is
        // put back on only if the answer is yes.
        if (f.key === "refusalCatchCrisis" && input.checked) {
          input.checked = false;
          openCrisisNotice((yes) => {
            if (!yes) return;
            input.checked = true;
            cfg[f.key] = true;
            applyDeps();
          });
          return;
        }
        cfg[f.key] = input.checked;
        // Rows that hang off this switch appear or go with it.
        applyDeps();
      });
      fieldSetters[f.key] = (v: any) => {
        input.checked = !!v;
      };
      top.appendChild(input);
      row.appendChild(top);
    } else if (f.type === "notes") {
      row.appendChild(top);
      const list = document.createElement("div");
      list.style.cssText = "display:flex;flex-direction:column;gap:8px";
      const foot = document.createElement("div");
      foot.style.cssText = "display:flex;align-items:center;gap:8px;flex-wrap:wrap";
      const add = btn("+", false);
      const count = document.createElement("span");
      count.style.cssText =
        "font-size:11px;color:var(--lumiverse-text-muted,rgba(255,255,255,.65))";
      for (const b2 of [add]) b2.style.cssText += "min-height:0;padding:4px 12px;flex:none";

      // Held here rather than read back off the DOM, so a half-typed row is
      // still the value the panel is holding.
      let notes: Array<{ text: string; role: string; fromTry: number }> = coerce(
        "notes", cfg[f.key], (CONFIG as any)[f.key], f,
      );
      const push = () => {
        cfg[f.key] = notes.map((n) => ({
          text: n.text,
          role: n.role,
          fromTry: n.fromTry,
        }));
      };

      const draw = () => {
        list.replaceChildren();
        notes.forEach((note, i) => {
          const wrap = document.createElement("div");
          wrap.style.cssText = "display:flex;flex-direction:column;gap:5px";
          const bar = document.createElement("div");
          bar.style.cssText = "display:flex;align-items:center;gap:8px;flex-wrap:wrap";
          const num = document.createElement("span");
          num.textContent = notes.length > 1 ? "Note " + (i + 1) : "Note";
          num.style.cssText =
            "font-size:11px;color:var(--lumiverse-text-muted,rgba(255,255,255,.65));flex:1";
          const who = document.createElement("select");
          for (const o of NOTE_ROLE_OPTIONS) {
            const opt = document.createElement("option");
            opt.value = o.value;
            opt.textContent = o.label;
            who.appendChild(opt);
          }
          who.value = note.role;
          styleField(who);
          who.style.cssText += "flex:none;padding:5px 8px;font-size:12px";
          who.setAttribute("aria-label", "Who note " + (i + 1) + " comes from");
          who.addEventListener("change", () => {
            note.role = coerce("pick", who.value, "system", {
              options: NOTE_ROLE_OPTIONS,
            } as any);
            push();
          });
          // Which retry this note joins on. Its own, not the list's: that is
          // what lets a gentle note go first and a firmer one follow only if
          // the gentle one did not work.
          const fromWrap = document.createElement("label");
          fromWrap.style.cssText =
            "display:flex;align-items:center;gap:5px;flex:none;font-size:11px;" +
            "color:var(--lumiverse-text-muted,rgba(255,255,255,.65));cursor:pointer";
          const fromLabel = document.createElement("span");
          fromLabel.textContent = "from try";
          const from = document.createElement("input");
          from.type = "number";
          from.inputMode = "numeric";
          from.min = "1";
          from.max = String(NOTE_FROM_TRY_MAX);
          from.value = String(note.fromTry);
          styleField(from);
          from.style.cssText += "flex:none;width:56px;padding:5px 6px;font-size:12px";
          from.setAttribute("aria-label", "Note " + (i + 1) + " starts on try");
          const commitFrom = () => {
            const n = Math.round(Number(from.value));
            note.fromTry = Number.isFinite(n)
              ? Math.min(NOTE_FROM_TRY_MAX, Math.max(1, n))
              : NOTE_FROM_TRY_DEFAULT;
            from.value = String(note.fromTry);
            push();
          };
          from.addEventListener("change", commitFrom);
          fromWrap.appendChild(fromLabel);
          fromWrap.appendChild(from);

          const drop = btn("\u2212", false);
          drop.style.cssText += "min-height:0;padding:4px 12px;flex:none";
          drop.setAttribute("aria-label", "Remove note " + (i + 1));
          // One note is the floor. Removing the last one would leave nothing to
          // type into and no way back except the plus button.
          const canDrop = notes.length > 1;
          drop.disabled = !canDrop;
          drop.style.opacity = canDrop ? "1" : "0.45";
          drop.style.cursor = canDrop ? "pointer" : "not-allowed";
          drop.addEventListener("click", () => {
            if (notes.length <= 1) return;
            notes.splice(i, 1);
            push();
            draw();
          });
          bar.appendChild(num);
          bar.appendChild(fromWrap);
          bar.appendChild(who);
          bar.appendChild(drop);

          const ta = document.createElement("textarea");
          ta.rows = 3;
          ta.value = note.text;
          ta.setAttribute("aria-label", "Note " + (i + 1));
          styleField(ta);
          ta.style.cssText += "width:100%;box-sizing:border-box;resize:vertical";
          ta.addEventListener("input", () => {
            note.text = ta.value;
            push();
          });
          wrap.appendChild(bar);
          wrap.appendChild(ta);
          list.appendChild(wrap);
        });
        const room = notes.length < MAX_NOTES;
        add.disabled = !room;
        add.style.opacity = room ? "1" : "0.45";
        add.style.cursor = room ? "pointer" : "not-allowed";
        count.textContent = room
          ? notes.length + " of " + MAX_NOTES
          : MAX_NOTES + " is the most one retry can carry";
        ensureReadableTree(list, 2.6);
      };

      add.setAttribute("aria-label", "Add another note");
      // Which kind of pointer opened the last press, so the new note can be
      // focused for the people who want that and not for the people it gets in
      // the way of. Focusing a textarea raises the on-screen keyboard, which on
      // a phone covers the panel and the note that was just added. A keyboard
      // press fires no pointerdown at all and leaves this empty, so tabbing to
      // the button and pressing it still lands in the new note.
      let addedWith = "";
      add.addEventListener("pointerdown", (e: any) => {
        addedWith = (e && e.pointerType) || "";
      });
      add.addEventListener("click", () => {
        const finger = addedWith === "touch" || addedWith === "pen";
        addedWith = "";
        if (notes.length >= MAX_NOTES) return;
        // A new note copies the last one's role and its starting try, so
        // adding one does not quietly change when anything goes out. Move it
        // later by hand to make it an escalation.
        const prev = notes.length ? notes[notes.length - 1] : null;
        notes.push({
          text: "",
          role: prev ? prev.role : "system",
          fromTry: prev ? prev.fromTry : NOTE_FROM_TRY_DEFAULT,
        });
        push();
        draw();
        const boxes = list.querySelectorAll("textarea");
        const last: any = boxes[boxes.length - 1];
        if (!last) return;
        // Either way the new note is brought into view. Without focus to do it,
        // a note added at the bottom of a long list would be off screen.
        if (finger) {
          if (last.scrollIntoView) try { last.scrollIntoView({ block: "nearest" }); } catch (_) {}
          return;
        }
        if (last.focus) try { last.focus({ preventScroll: true }); } catch (_) {}
      });

      fieldSetters[f.key] = (v: any) => {
        notes = coerce("notes", v, (CONFIG as any)[f.key], f);
        draw();
      };
      draw();
      foot.appendChild(add);
      foot.appendChild(count);
      row.appendChild(list);
      row.appendChild(foot);
    } else if (f.type === "pick") {
      const sel = document.createElement("select");
      for (const o of f.options || []) {
        const opt = document.createElement("option");
        opt.value = o.value;
        opt.textContent = o.label;
        sel.appendChild(opt);
      }
      sel.value = String(cfg[f.key]);
      styleField(sel);
      sel.style.flex = "none";
      sel.style.maxWidth = "60%";
      sel.addEventListener("change", () => {
        cfg[f.key] = coerce("pick", sel.value, (CONFIG as any)[f.key], f);
        // Honoured here as well as on a number box. It was only ever wired up
        // for numbers, so a dropdown asking to apply as it is picked was
        // accepted by the schema and then quietly did nothing.
        if (f.live) onLiveEdit(String(f.key));
      });
      fieldSetters[f.key] = (v: any) => {
        sel.value = coerce("pick", v, (CONFIG as any)[f.key], f);
      };
      top.appendChild(sel);
      row.appendChild(top);
    } else if (f.type === "num") {
      const input = document.createElement("input");
      input.type = "number";
      input.inputMode = "numeric";
      // Marks it for the rule that takes the browser's spinner off. An
      // attribute of ours rather than a bare input[type=number] selector,
      // because that stylesheet is on the host's page and would reach every
      // number box Lumiverse has.
      input.setAttribute("data-ar-num", "1");
      input.value = String(cfg[f.key]);
      styleField(input);
      input.style.width = "120px";
      input.style.flex = "none";
      // On input, not just on change: a number box only raises change when it
      // is left, and a setting marked live is meant to move while it is typed.
      // The floating button is the one that does, and watching the real button
      // resize on the chat is what a preview beside the box was standing in
      // for. The circle also reserved a box the width of the largest size the
      // setting allows, so it took that much room out of every panel whether
      // or not the button was even switched on.
      input.addEventListener("input", () => {
        if (!f.live) return;
        cfg[f.key] = clampField(f, input.value);
        onLiveEdit(String(f.key));
      });
      input.addEventListener("change", () => {
        cfg[f.key] = clampField(f, input.value);
        input.value = String(cfg[f.key]);
        if (f.live) onLiveEdit(String(f.key));
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
          "font-size:12px;min-height:16px;color:var(--lumiverse-text-muted,rgba(255,255,255,.65))";
        test.addEventListener("click", () => {
          const sel = input.value.trim();
          if (!sel) {
            res.textContent = "type a selector first";
            res.style.color = "var(--lumiverse-text-muted,rgba(255,255,255,.65))";
            return;
          }
          const state = selectorState(sel);
          if (state === "invalid selector") {
            res.textContent = "that selector isn't valid";
            res.style.color = "var(--lumiverse-danger,#ef4444)";
            return;
          }
          if (state === "match") {
            res.textContent = "match found";
            res.style.color = "var(--lumiverse-success,#22c55e)";
            return;
          }
          res.textContent =
            state === "match, not clickable right now"
              ? "found, but not clickable right now"
              : "no match right now";
          res.style.color = "var(--lumiverse-text-muted,rgba(255,255,255,.65))";
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

    return row;
  }

  // The mark on whatever has focus, and the one place it is described.
  //
  // A tinted border on its own is a single hairline, which on a busy theme is
  // easy to lose and on a wide field says very little. This is the same tint
  // with room around it: a soft band just outside the edge, and a wider halo
  // past that, both in the theme's own accent so it follows whatever colour
  // the user runs. Nothing is painted inside the field, so the text is never
  // sat on and contrast is untouched.
  //
  // Two layers rather than one because a single large blur reads as a smudge
  // and a single tight band reads as a second border. Together they give the
  // edge somewhere to fall off to.
  // Kept tight on purpose. A blur of 16 with 2 of spread paints 18 past the
  // edge, and the rows in this panel are nowhere near 18 apart, so it washes
  // over whatever sits above and below and reads as belonging to the row rather
  // than the box. Eight is far enough to be a halo and short enough to stay
  // inside the field's own gap.
  const FOCUS_RING =
    "0 0 0 2px var(--lumiverse-primary-020,rgba(147,112,219,.2))," +
    "0 0 8px 0 var(--lumiverse-primary-020,rgba(147,112,219,.2))";

  // mark:false gives a field the panel's look without the pointer lift or the
  // focus ring. For the search box, which sits alone above the scroll area with
  // nothing to tell it apart from and answers every keystroke by filtering the
  // list underneath it.
  function styleField(
    input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
    opts?: { mark?: boolean },
  ) {
    const mark = !opts || opts.mark !== false;
    input.style.cssText +=
      "padding:9px 10px;border-radius:var(--lumiverse-radius,8px);" +
      "border:1px solid var(--lumiverse-border,rgba(255,255,255,.16));" +
      "background:var(--lumiverse-fill-subtle,rgba(0,0,0,.1));" +
      "color:var(--lumiverse-text,#eee);font:13px var(--lumiverse-font-family,system-ui);outline:none;" +
      // The ring fades in with the border it belongs to rather than appearing
      // out of nowhere. Nothing moves and nothing is laid out again: both of
      // these paint outside the box, so neither can push the row around. No
      // transition on a field that never changes either of them.
      (mark
        ? "transition:border-color var(--lumiverse-transition-fast,150ms ease)," +
          "box-shadow var(--lumiverse-transition-fast,150ms ease)"
        : "");
    ensureReadable(input);
    if (!mark) return;
    // A field lifts its border under the pointer, so it reads as something you
    // can put a cursor in before you have. Focus overwrites this and blur puts
    // it back, so the two never argue over the border.
    let focused = false;
    input.addEventListener("pointerenter", () => {
      if (!focused) input.style.borderColor = "var(--lumiverse-border-hover,rgba(147,112,219,.25))";
    });
    input.addEventListener("pointerleave", () => {
      if (!focused) input.style.borderColor = "var(--lumiverse-border,rgba(255,255,255,.16))";
    });
    // On focus, tint the border and put the ring around it.
    //
    // Except on a dropdown opened by pointer. Clicking one puts its menu on
    // screen with the choice already in front of you, so the mark says nothing
    // you cannot see, and it then stayed on the row after the choosing was done
    // until something else was clicked. Tabbing to one is the opposite case:
    // there is no menu and nothing else saying where you are, so it is marked.
    //
    // Worked out from the pointer rather than asked of :focus-visible, which
    // does not answer this question: a browser counts a dropdown as worth
    // marking on a click, because you can type a letter to jump through its
    // options. That is true and it is not what is being asked here.
    let byPointer = false;
    input.addEventListener("pointerdown", () => {
      byPointer = true;
    });
    input.addEventListener("focus", () => {
      const dropdown = String(input.tagName || "").toUpperCase() === "SELECT";
      const skip = dropdown && byPointer;
      byPointer = false;
      if (!skip) {
        focused = true;
        input.style.borderColor = "var(--lumiverse-primary,rgba(147,112,219,.9))";
        input.style.boxShadow = FOCUS_RING;
      }
    });
    input.addEventListener("blur", () => {
      byPointer = false;
      focused = false;
      input.style.borderColor = "var(--lumiverse-border,rgba(255,255,255,.16))";
      input.style.boxShadow = "none";
    });
  }

  function btn(label: string, primary: boolean): HTMLButtonElement {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.cssText =
      "min-height:36px;padding:8px 14px;border-radius:var(--lumiverse-radius,8px);cursor:pointer;" +
      "font:13px var(--lumiverse-font-family,system-ui);" +
      // Only the hover colour. Nothing here sets filter, and animating it is
      // what forces a button onto its own compositing layer for no benefit.
      "transition:background-color var(--lumiverse-transition-fast,150ms ease)," +
      "box-shadow var(--lumiverse-transition-fast,150ms ease);" +
      (primary
        ? // A filled button's label has to contrast with the fill, not with the
          // panel. Lumiverse has no on-accent colour to ask for, and the body
          // text colour is the wrong answer: on a theme with a light accent it
          // is the same colour as the fill, which is what made this button read
          // as a blank rectangle. White is the right default for the stock
          // accent, and ensureReadable below measures what was actually painted
          // and flips it to near-black on an accent too light for white.
          "border:1px solid transparent;background:var(--lumiverse-primary,rgba(147,112,219,.9));" +
          "color:#ffffff"
        : // Secondary buttons use the theme's own secondary surface rather than
          // going transparent, so they read as buttons at rest instead of as
          // bare text with an outline.
          "border:1px solid var(--lumiverse-secondary-border,rgba(128,128,128,.25));" +
          "background:var(--lumiverse-secondary,rgba(128,128,128,.15));color:var(--lumiverse-text,#eee)");
    ensureReadable(b);
    if (primary) ensureEdge(b);
    // Marks it for the focus rule in the panel's stylesheet. Left to the
    // browser a button focused by tab drew whatever outline the host happened
    // to leave it, which on a dark theme was often nothing anybody could see.
    //
    // The rule asks :focus-visible rather than plain :focus, which is the
    // browser's own answer to "should this be marked", and it is the right one
    // here. Tracking pointer presses by hand got it wrong the moment a dialog
    // moved focus itself: opening the reset picker's second step focuses Go
    // back so a keyboard can act on it, and tracking by hand could not tell
    // that apart from tabbing to it, so the button opened with a focus ring
    // around it that nobody had asked for.
    b.setAttribute("data-ar-btn", "1");
    // Hovering swaps to the theme's own hover colour rather than brightening the
    // resting one, so a button lights up the same way the rest of Lumiverse does.
    let restBg = primary
      ? "var(--lumiverse-primary,rgba(147,112,219,.9))"
      : "var(--lumiverse-secondary,rgba(128,128,128,.15))";
    let hoverBg = primary
      ? "var(--lumiverse-primary-hover,rgba(167,132,239,.95))"
      : "var(--lumiverse-secondary-hover,rgba(128,128,128,.25))";
    const setBg = (v: string) => {
      b.style.background = v;
      // A theme is free to make its hover colour lighter or darker than the
      // resting one, so the label is checked against whichever is showing.
      ensureReadable(b);
    };
    // Changing a button's colour means changing what it rests and hovers at,
    // not just what it is painted right now. Setting the background alone was
    // undone by the next mouseleave, so the reset picker's danger red came off
    // the moment a pointer crossed it and did not come back.
    (b as any).__setTone = (rest: string, hover: string) => {
      restBg = rest;
      hoverBg = hover || rest;
      b.style.borderColor = rest;
      setBg(rest);
    };
    // From a mouse only. A touch browser sends this one at the end of a tap and
    // never sends the matching leave, so every button in the panel stayed in
    // its hover colour after being tapped. pointerleave below cannot undo it
    // either: it has already run by the time this arrives.
    b.addEventListener("mouseenter", (e: any) => {
      if (fromMouse(e)) setBg(hoverBg);
    });
    // Not asked. Going back to the resting colour is right whatever left.
    b.addEventListener("mouseleave", () => setBg(restBg));
    // Press feedback that also works on touch, where hover never fires.
    const pressClear = () => {
      b.style.filter = "none";
    };
    b.addEventListener("pointerdown", () => {
      b.style.filter = "brightness(.9)";
    });
    b.addEventListener("pointerup", pressClear);
    b.addEventListener("pointercancel", pressClear);
    b.addEventListener("pointerleave", () => {
      pressClear();
      setBg(restBg);
    });
    return b;
  }

  // ---- reset ----
  // A picker rather than one button that puts every setting back at once,
  // which is the rarest thing anyone wants. The usual case is one part having
  // been fiddled into a mess, most often the button selectors, since Pick it
  // for me makes those easy to overwrite with the wrong element. Resetting
  // everything to undo that costs the word swaps, the refusal phrases and the
  // notes as well.
  //
  // The parts are the same ones import and export already use, so there is one
  // definition of what a part is and the names match between the two panels.
  //
  // Nothing is reset silently. The picker says, per part, how many settings
  // would actually change, so a part already at its defaults is visibly nothing
  // to press, and it says in plain words what it does not touch.
  function resetPartsFor(): Array<{ id: string; label: string; keys: string[] }> {
    return EXPORT_CATEGORIES.filter((c) => c.id !== "presets").map((c) => ({
      id: c.id,
      label: c.label,
      keys: c.keys.slice(),
    }));
  }

  // Two settings can hold arrays (the note list), so an identity check is not
  // enough to tell "changed" from "the same as it shipped".
  function sameAsDefault(key: string): boolean {
    const a = cfg[key];
    const b = (CONFIG as any)[key];
    if (a === b) return true;
    if (typeof a === "object" || typeof b === "object") {
      try {
        return JSON.stringify(a) === JSON.stringify(b);
      } catch (_) {
        return false;
      }
    }
    return false;
  }

  function changedCount(keys: string[]): number {
    let n = 0;
    for (const k of keys) if (!sameAsDefault(k)) n++;
    return n;
  }

  // Puts the chosen parts back to what the extension shipped with, in the panel
  // only. Save keeps it, closing the panel discards it, which is the same deal
  // import already offers.
  // Presets are the exception and are called out as such in the picker: they
  // live outside the settings object and are deleted for real.
  function applyReset(ids: string[], alsoPresets: boolean): { settings: number; presets: number } {
    let settings = 0;
    for (const part of resetPartsFor()) {
      if (ids.indexOf(part.id) < 0) continue;
      for (const k of part.keys) {
        if (!sameAsDefault(k)) settings++;
        // Copied, not pointed at. The note list is an array, and handing cfg
        // the same array the defaults block holds would leave the two sharing
        // one object for as long as nobody replaced it.
        const def = (CONFIG as any)[k];
        cfg[k] = def && typeof def === "object" ? JSON.parse(JSON.stringify(def)) : def;
        const set = fieldSetters[k];
        if (set) set(cfg[k]);
      }
    }
    let presets = 0;
    if (alsoPresets) {
      const stored = loadPresets();
      // Every kind, counted and cleared. Writing { swap: [] } here dropped the
      // note presets as a side effect of the key being absent, while the line
      // the user ticked named word swaps.
      presets = Object.keys(stored).reduce((n, k) => n + (stored[k] || []).length, 0);
      if (presets) {
        const cleared: Record<string, Preset[]> = {};
        for (const k of Object.keys(stored)) cleared[k] = [];
        savePresets(cleared);
      }
      for (const r of presetBarRefreshers) {
        try { r(); } catch (_) {}
      }
    }
    applyDeps();
    syncLiveLog();
    syncFloat();
    syncInputBarActions();
    return { settings: settings, presets: presets };
  }

  // Open at a time, so a second press replaces the first rather than stacking.
  let closeResetPicker: (() => void) | null = null;

  function openResetPicker(onApplied: (done: { settings: number; presets: number }) => void) {
    if (typeof document === "undefined") return;
    if (closeResetPicker) {
      try { closeResetPicker(); } catch (_) {}
    }
    const parts = resetPartsFor();
    const overlay = document.createElement("div");
    overlay.id = "__lvRetryReset";
    markOwnUI(overlay);
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:" + Z_OVERLAY + ";display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;background:var(--lumiverse-modal-backdrop,rgba(0,0,0,.6));font-family:var(--lumiverse-font-family,system-ui)";
    const box = document.createElement("div");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-label", "Reset settings");
    // Focused on open so Escape and the tab order start inside the box rather
    // than back in the panel behind it.
    box.tabIndex = -1;
    box.style.cssText =
      "display:flex;flex-direction:column;gap:10px;width:min(520px,96vw);max-height:min(86vh,680px);box-sizing:border-box;padding:14px;background-color:var(--lumiverse-card-bg-solid,rgb(24,20,34));background-image:linear-gradient(var(--lumiverse-bg-elevated,rgba(35,30,48,.9)),var(--lumiverse-bg-elevated,rgba(35,30,48,.9)));border:1px solid var(--lumiverse-border,rgba(255,255,255,.16));border-radius:var(--lumiverse-radius-lg,12px);box-shadow:var(--lumiverse-shadow-xl,0 20px 60px rgba(0,0,0,.5));color:var(--lumiverse-text,#eee)";
    const title = document.createElement("div");
    title.textContent = "Reset settings";
    title.style.cssText = "flex:none;font-size:14px";
    const desc = document.createElement("div");
    desc.textContent =
      "Tick the parts to put back to their defaults. Everything you leave unticked is kept exactly as it is. This fills the settings in behind this box without saving, so you can look first: press Save to keep it, or close the panel to discard it.";
    desc.style.cssText =
      "flex:none;font-size:12px;line-height:1.45;color:var(--lumiverse-text-muted,rgba(255,255,255,.65))";

    const list = document.createElement("div");
    list.style.cssText =
      "flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:6px;padding:2px 0";

    const checks: Array<{ id: string; input: HTMLInputElement }> = [];
    for (const part of parts) {
      const n = changedCount(part.keys);
      const row = document.createElement("label");
      row.setAttribute("data-ar-reset", part.id);
      // No opacity for the disabled state. The contrast sweep reads colour
      // against background and cannot see through an opacity, so a faded row on
      // a hostile theme is one it has no way to repair. The disabled box and
      // the "already default" note beside it say it well enough.
      row.style.cssText =
        "display:flex;align-items:center;gap:8px;font-size:13px;cursor:" +
        (n ? "pointer" : "default");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = false;
      // A part already at its defaults is nothing to press. Left tickable it
      // reads as an action that did nothing when the count came back zero.
      cb.disabled = n === 0;
      cb.style.cssText = CHECKBOX_STYLE + "cursor:" + (n ? "pointer" : "default");
      const txt = document.createElement("span");
      txt.textContent = part.label;
      const count = document.createElement("span");
      count.style.cssText =
        "margin-left:auto;font-size:12px;color:var(--lumiverse-text-muted,rgba(255,255,255,.65))";
      count.textContent = n
        ? n + (n === 1 ? " setting changed" : " settings changed")
        : "already default";
      row.appendChild(cb);
      row.appendChild(txt);
      row.appendChild(count);
      list.appendChild(row);
      checks.push({ id: part.id, input: cb });
    }

    // Presets sit under a rule of their own, because they are the one thing
    // here that is deleted for real rather than filled into the panel, and
    // there is no Save to reconsider at.
    const rule = document.createElement("div");
    rule.style.cssText =
      "flex:none;height:1px;background:var(--lumiverse-border,rgba(255,255,255,.08));margin:2px 0";
    const presetStore = loadPresets();
    const presetCount = Object.keys(presetStore)
      .reduce((n, k) => n + (presetStore[k] || []).length, 0);
    const presetRow = document.createElement("label");
    presetRow.setAttribute("data-ar-reset", "presets");
    presetRow.style.cssText =
      "flex:none;display:flex;align-items:center;gap:8px;font-size:13px;cursor:" +
      (presetCount ? "pointer" : "default");
    const presetCb = document.createElement("input");
    presetCb.type = "checkbox";
    presetCb.checked = false;
    presetCb.disabled = presetCount === 0;
    presetCb.style.cssText = CHECKBOX_STYLE + "cursor:" + (presetCount ? "pointer" : "default");
    const presetTxt = document.createElement("span");
    // The one line in the picker that destroys something no Save can take back,
    // so it is the one line that does not look like the others.
    presetTxt.innerHTML = "";
    const presetStrong = document.createElement("strong");
    presetStrong.textContent = "Delete saved presets";
    presetStrong.style.cssText =
      "color:var(--lumiverse-danger,#ef4444);font-weight:600";
    presetTxt.appendChild(presetStrong);
    const presetNum = document.createElement("span");
    presetNum.style.cssText =
      "margin-left:auto;font-size:12px;color:var(--lumiverse-text-muted,rgba(255,255,255,.65))";
    presetNum.textContent = presetCount
      ? presetCount + (presetCount === 1 ? " saved" : " saved")
      : "none saved";
    presetRow.appendChild(presetCb);
    presetRow.appendChild(presetTxt);
    presetRow.appendChild(presetNum);

    // What a reset cannot reach. Worth saying out loud: the word "reset" reads
    // as bigger than it is, and the thing people are actually worried about
    // losing is their chats.
    const keeps = document.createElement("div");
    keeps.style.cssText =
      "flex:none;font-size:12px;line-height:1.45;color:var(--lumiverse-text-muted,rgba(255,255,255,.65))";
    keeps.textContent =
      "Never touched by any of this: your chats, your replies and your characters. " +
      "Auto Retry only ever reads replies, and a reset does not go near them. " +
      "Your saved presets, both word swap and refusal note, are kept too unless you tick the box above, and that one deletes them straight away rather than waiting for Save.";

    const status = document.createElement("div");
    status.style.cssText =
      "flex:none;font-size:12px;line-height:1.4;min-height:1em;color:var(--lumiverse-text-muted,rgba(255,255,255,.65))";

    const row = document.createElement("div");
    row.style.cssText =
      "display:flex;justify-content:flex-end;gap:8px;flex:none;flex-wrap:wrap";
    const all = btn("Tick every setting", false);
    const cancel = btn("Cancel", false);
    const go = btn("Reset ticked", true);

    const chosen = () => checks.filter((x) => x.input.checked).map((x) => x.id);
    // Capture, and the event stops here. Without that, the same Escape that
    // shuts this box carries on to the host's own modal and shuts the settings
    // panel behind it, so cancelling a reset closed everything.
    const onKey = (e: any) => {
      if (!e || e.key !== "Escape") return;
      try { e.stopPropagation(); } catch (_) {}
      try { e.preventDefault(); } catch (_) {}
      close();
    };
    function close() {
      try { overlay.remove(); } catch (_) {}
      try { document.removeEventListener("keydown", onKey, true); } catch (_) {}
      if (closeResetPicker === close) closeResetPicker = null;
    }
    all.addEventListener("click", () => {
      // Only what there is something to do to, so this never ticks a row that
      // reads "already default" right next to it. The presets line is left out
      // of it: that one deletes something for real and has no Save to think
      // again at, so it is only ever ticked by hand.
      for (const c of checks) if (!c.input.disabled) c.input.checked = true;
      status.textContent = "";
    });
    cancel.addEventListener("click", close);

    // ---- the confirmation step ----
    // Pressing Reset ticked asks before it does anything, and the asking is
    // done here rather than through the host's confirm dialog. Two reasons.
    // The host may not offer one, and a missing dialog must not count as a yes
    // for the one control that throws settings away. A host dialog can only be
    // handed a fixed sentence, where this one names the parts, counts the
    // settings in them, and says which of the two things about to happen can be
    // undone.
    //
    // The boxes are frozen while it is up, so what the summary says and what
    // the button does cannot come apart.
    const confirmWrap = document.createElement("div");
    // The question reads as a question, not as another row of the form. A left
    // edge in the theme's danger colour and a tint behind it, which is what the
    // rest of Lumiverse uses to mean "this one is different".
    confirmWrap.style.cssText =
      "display:none;flex-direction:column;gap:8px;flex:none;padding:10px 12px;" +
      "border-radius:var(--lumiverse-radius,8px);border:1px solid;border-left-width:3px";
    // The headline says which of the two situations this is, because they are
    // not equally serious and saying otherwise on the milder one would make the
    // warning worth ignoring on the one that matters.
    const confirmHead = document.createElement("div");
    confirmHead.style.cssText = "font-size:13px;font-weight:600";
    const confirmText = document.createElement("div");
    confirmText.setAttribute("data-ar-reset-confirm", "1");
    confirmText.style.cssText = "font-size:13px;line-height:1.45";
    const confirmRow = document.createElement("div");
    confirmRow.style.cssText =
      "display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap";
    const back = btn("Go back", false);
    const yes = btn("Yes, reset", true);
    confirmRow.appendChild(back);
    confirmRow.appendChild(yes);
    confirmWrap.appendChild(confirmHead);
    confirmWrap.appendChild(confirmText);
    confirmWrap.appendChild(confirmRow);

    // The boxes that were tickable when the picker opened. Held here because
    // freezing sets disabled on them, which would otherwise make the ones that
    // started out disabled indistinguishable from the ones that did not, and
    // Go back would hand them all back tickable.
    const tickable: HTMLInputElement[] = checks
      .filter((c) => !c.input.disabled)
      .map((c) => c.input);
    if (!presetCb.disabled) tickable.push(presetCb);

    // Amber for a reset that Save has not happened to yet, red for one that
    // takes presets with it. Applied to the box, its headline and the button
    // that commits it, so all three agree about how serious this is.
    const dressConfirm = (permanent: boolean) => {
      const edge = permanent
        ? "var(--lumiverse-danger,#ef4444)"
        : "var(--lumiverse-warning,#f59e0b)";
      const wash = permanent
        ? "var(--lumiverse-danger-015,rgba(239,68,68,.15))"
        : "var(--lumiverse-warning-015,rgba(245,158,11,.15))";
      confirmWrap.style.borderColor = edge;
      confirmWrap.style.borderLeftColor = edge;
      confirmWrap.style.background = wash;
      confirmHead.style.color = edge;
      confirmHead.textContent = permanent
        ? "Deleting presets cannot be undone."
        : "Put the ticked parts back to their defaults?";
      yes.textContent = permanent ? "Yes, reset and delete" : "Yes, reset";
      // Through the button's own tone, so hovering it does not put the accent
      // back. ensureReadable runs inside that, measuring the label against
      // whatever is actually painted rather than against the accent it was
      // coloured for.
      const hover = permanent
        ? "var(--lumiverse-danger-hover,#dc2626)"
        : "var(--lumiverse-warning,#f59e0b)";
      try { (yes as any).__setTone(edge, hover); } catch (_) {}
    };

    const freeze = (frozen: boolean) => {
      // disabled rather than pointer-events, so a keyboard cannot change a tick
      // the summary has already been written from. The rows keep their normal
      // colour, so the list stays readable while it is being read.
      for (const input of tickable) input.disabled = frozen;
      all.disabled = frozen;
      go.disabled = frozen;
      row.style.display = frozen ? "none" : "flex";
      confirmWrap.style.display = frozen ? "flex" : "none";
    };

    // What is about to happen, in the order it happens, with the reversible
    // half and the permanent half kept apart.
    const describe = (ids: string[], withPresets: boolean): string => {
      const named = parts
        .filter((p) => ids.indexOf(p.id) >= 0)
        .map((p) => {
          const n = changedCount(p.keys);
          return p.label + " (" + n + (n === 1 ? " setting)" : " settings)");
        });
      const lines: string[] = [];
      if (named.length)
        lines.push(
          "Put back to defaults: " +
            named.join(", ") +
            ". Nothing else is touched, and closing the panel without saving undoes it.",
        );
      if (withPresets)
        lines.push(
          "Delete " +
            presetCount +
            (presetCount === 1 ? " saved preset" : " saved presets") +
            ". This one happens straight away and closing the panel will not bring them back.",
        );
      return lines.join(" ");
    };

    back.addEventListener("click", () => {
      freeze(false);
      status.textContent = "";
      focusQuietly(go);
    });

    go.addEventListener("click", () => {
      const ids = chosen();
      if (!ids.length && !presetCb.checked) {
        status.textContent = "Tick at least one part to reset.";
        return;
      }
      confirmText.textContent = describe(ids, presetCb.checked);
      dressConfirm(presetCb.checked);
      status.textContent = "";
      freeze(true);
      // The safe one is where the finger already is, so a second tap in the
      // same place goes back rather than through.
      focusQuietly(back);
    });

    yes.addEventListener("click", () => {
      const ids = chosen();
      const done = applyReset(ids, presetCb.checked);
      close();
      const bits: string[] = [];
      if (done.settings)
        bits.push(
          done.settings +
            (done.settings === 1 ? " setting put back" : " settings put back") +
            ". Press Save to keep it",
        );
      else if (ids.length) bits.push("those parts were already at their defaults");
      if (done.presets)
        bits.push(
          done.presets +
            (done.presets === 1 ? " preset deleted" : " presets deleted"),
        );
      onApplied(done);
      log("reset: " + ids.join(", ") + (presetCb.checked ? " + presets" : ""));
      showToast("Reset: " + bits.join(", ") + ".", { force: true });
    });
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });
    document.addEventListener("keydown", onKey, true);
    row.appendChild(all);
    row.appendChild(cancel);
    row.appendChild(go);
    box.appendChild(title);
    box.appendChild(desc);
    box.appendChild(list);
    box.appendChild(rule);
    box.appendChild(presetRow);
    box.appendChild(keeps);
    box.appendChild(status);
    box.appendChild(confirmWrap);
    box.appendChild(row);
    overlay.appendChild(box);
    (document.body || document.documentElement).appendChild(overlay);
    ensureReadableTree(box, 2.6);
    try { box.focus({ preventScroll: true }); } catch (_) {}
    closeResetPicker = close;
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
      "position:fixed;inset:0;z-index:" + Z_OVERLAY + ";display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;background:var(--lumiverse-modal-backdrop,rgba(0,0,0,.6));font-family:var(--lumiverse-font-family,system-ui)";
    const box = document.createElement("div");
    box.style.cssText =
      "display:flex;flex-direction:column;gap:10px;width:min(720px,96vw);height:min(80vh,640px);box-sizing:border-box;padding:14px;background-color:var(--lumiverse-card-bg-solid,rgb(24,20,34));background-image:linear-gradient(var(--lumiverse-bg-elevated,rgba(35,30,48,.9)),var(--lumiverse-bg-elevated,rgba(35,30,48,.9)));border:1px solid var(--lumiverse-border,rgba(255,255,255,.16));border-radius:var(--lumiverse-radius-lg,12px);box-shadow:var(--lumiverse-shadow-xl,0 20px 60px rgba(0,0,0,.5));color:var(--lumiverse-text,#eee)";
    const title = document.createElement("div");
    title.textContent = label;
    title.style.cssText =
      "flex:none;font-size:14px;font-family:var(--lumiverse-font-family,system-ui)";
    const ta = document.createElement("textarea");
    ta.value = initial;
    ta.setAttribute("aria-label", label);
    ta.style.cssText =
      "flex:1;width:100%;box-sizing:border-box;resize:none;padding:10px;border-radius:var(--lumiverse-radius,8px);border:1px solid var(--lumiverse-border,rgba(255,255,255,.16));background:var(--lumiverse-fill-subtle,rgba(0,0,0,.1));color:var(--lumiverse-text,#eee);outline:none;font:13px/1.5 var(--lumiverse-font-family,system-ui)";
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
    ensureReadableTree(box);
    closeExpandEditor = close;
    // The textarea is not focused, so opening it doesn't pop the
    // on-screen keyboard on mobile. Tap the text when you want to edit.
  }

  // The one setting that is asked about before it is allowed on.
  //
  // Every other switch here changes how replies are judged. This one decides
  // whether a particular message reaches the person reading it, and the
  // extension has no way of knowing whether that message was wrong about the
  // scene or right about them. Saying so once, in front of the switch, is the
  // least this can do; anything more would be a lecture in a settings panel.
  //
  // Answering no leaves the box unticked, which is why the tick is undone
  // before this opens rather than after it is answered.
  function openCrisisNotice(onAnswer: (yes: boolean) => void) {
    if (typeof document === "undefined") return onAnswer(false);
    if (closeCrisisNotice) {
      try { closeCrisisNotice(); } catch (_) {}
    }
    let answered = false;
    const overlay = document.createElement("div");
    overlay.id = "__lvRetryCrisisNotice";
    markOwnUI(overlay);
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:" + Z_OVERLAY + ";display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;background:var(--lumiverse-modal-backdrop,rgba(0,0,0,.6));font-family:var(--lumiverse-font-family,system-ui)";
    const box = document.createElement("div");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-label", "Before you turn this on");
    box.tabIndex = -1;
    box.style.cssText =
      "display:flex;flex-direction:column;gap:10px;width:min(560px,96vw);max-height:min(86vh,680px);box-sizing:border-box;padding:14px;background-color:var(--lumiverse-card-bg-solid,rgb(24,20,34));background-image:linear-gradient(var(--lumiverse-bg-elevated,rgba(35,30,48,.9)),var(--lumiverse-bg-elevated,rgba(35,30,48,.9)));border:1px solid var(--lumiverse-border,rgba(255,255,255,.16));border-radius:var(--lumiverse-radius-lg,12px);box-shadow:var(--lumiverse-shadow-xl,0 20px 60px rgba(0,0,0,.5));color:var(--lumiverse-text,#eee)";
    const title = document.createElement("div");
    title.textContent = "Before you turn this on";
    title.style.cssText =
      "flex:none;font-size:13px;font-weight:600;color:var(--lumiverse-warning,#f59e0b)";
    const body = document.createElement("div");
    body.style.cssText =
      "flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:8px;font-size:13px;line-height:1.5";
    for (const para of [
      "This setting throws away a reply when the model stops the story to talk to you about your safety, then asks for a new reply instead. In a dark or intense scene, this may simply be the model misreading your fiction.",
      "Sometimes the message may be appropriate. The extension cannot tell the difference because it only reads the reply. It does not know anything about you or your situation.",
      "Keep that limitation in mind. If a chat is making you feel worse, do not rely on this setting to remove messages that might be useful to you. Turning it on means those replies can be discarded automatically.",
      "The setting changes nothing else. It stays off unless you turn it on, and you can switch it off again at any time.",
    ]) {
      const p = document.createElement("div");
      p.textContent = para;
      body.appendChild(p);
    }
    // The last line carries the only link the extension has. Telling somebody
    // to go and read a page, in a box they cannot leave without answering,
    // works out to telling them not to bother: the repository is not open in
    // front of them and the file is four clicks in. Nothing is fetched by
    // drawing this. It opens a tab if it is tapped, and not otherwise.
    {
      const p = document.createElement("div");
      p.appendChild(
        document.createTextNode(
          "There is more information about this setting and its risks on ",
        ),
      );
      const a = document.createElement("a");
      a.href = SAFETY_URL;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = "the safety page";
      a.style.cssText =
        "color:var(--lumiverse-primary,rgba(147,112,219,.9));text-decoration:underline";
      p.appendChild(a);
      p.appendChild(document.createTextNode("."));
      body.appendChild(p);
    }
    const row = document.createElement("div");
    row.style.cssText =
      "display:flex;justify-content:flex-end;gap:8px;flex:none;flex-wrap:wrap";
    const no = btn("Leave it off", false);
    const yes = btn("I understand, turn it on", true);
    // Amber rather than the accent, so the button that commits it carries the
    // same weight as the heading above it.
    try {
      (yes as any).__setTone(
        "var(--lumiverse-warning,#f59e0b)",
        "var(--lumiverse-warning,#f59e0b)",
      );
    } catch (_) {}
    const answer = (v: boolean) => {
      if (answered) return;
      answered = true;
      close();
      onAnswer(v);
    };
    const onKey = (e: any) => {
      // Escape is a no. The safe answer is the one that changes nothing.
      if (e && e.key === "Escape") answer(false);
    };
    function close() {
      try { overlay.remove(); } catch (_) {}
      try { document.removeEventListener("keydown", onKey); } catch (_) {}
      if (closeCrisisNotice === close) closeCrisisNotice = null;
    }
    no.addEventListener("click", () => answer(false));
    yes.addEventListener("click", () => answer(true));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) answer(false);
    });
    document.addEventListener("keydown", onKey);
    row.appendChild(no);
    row.appendChild(yes);
    box.appendChild(title);
    box.appendChild(body);
    box.appendChild(row);
    overlay.appendChild(box);
    (document.body || document.documentElement).appendChild(overlay);
    ensureReadableTree(box);
    try { box.focus(); } catch (_) {}
    // Shut without an answer, by teardown or by the panel closing, is a no: the
    // caller is waiting to hear whether the tick stands.
    closeCrisisNotice = () => {
      close();
      if (!answered) {
        answered = true;
        onAnswer(false);
      }
    };
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
    // Whether to offer Esc. Asked of the pointer that has been driving the
    // page, since the screen alone says a phone showing the desktop site has a
    // keyboard and it would then name a key nobody can press.
    const hasKeyboard = fromMouse();
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
      log("this version of Lumiverse cannot open the settings window");
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
        // A tall phone had most of its screen sitting empty under a panel that
        // stopped at 560, so barely one section fitted before scrolling. The
        // viewport is still the real limit; this just stops leaving room unused.
        maxHeight: Math.min(720, vh - 24),
      });
      modalHandle = modal;
      modalRoot = modal.root;
      // The host owns this element, so it is marked rather than renamed.
      markOwnUI(modal.root);

      // Baseline of every saved setting at open. Edits below change cfg live, but
      // closing the modal with X or tapping outside restores this baseline, so
      // nothing sticks unless Save is pressed. Save and Reset refresh the baseline.
      const snapshot = () => {
        modalBaseline = {};
        for (const g of SCHEMA)
          for (const fl of g.fields) modalBaseline[fl.key] = cfg[fl.key];
      };
      snapshot();
      modalSnapshot = snapshot;

      buildSettingsBody(modal.root, snapshot);
      modal.onDismiss(() => {
        hideHint();
        if (closeExpandEditor) {
          try {
            closeExpandEditor();
          } catch (_) {}
        }
        // Parented to the page as well, and closing it unanswered leaves the
        // switch off, which is the answer that changes nothing.
        if (closeCrisisNotice) {
          try {
            closeCrisisNotice();
          } catch (_) {}
        }
        // Parented to the page like the editor is, so dismissing the panel does
        // not take it with it. Left open it would sit over the chat asking to
        // reset settings in a panel that is no longer there.
        if (closeResetPicker) {
          try {
            closeResetPicker();
          } catch (_) {}
        }
        if (modalBaseline)
          for (const g of SCHEMA)
            for (const fl of g.fields) cfg[fl.key] = modalBaseline[fl.key];
        // A setting applied while it was being typed is on screen right now,
        // and rolling cfg back does not by itself put it back. Without this a
        // size previewed and then discarded stayed on the button until
        // something else happened to rebuild it.
        syncLiveLog();
        syncFloat();
        syncInputBarActions();
        modalHandle = null;
        modalRoot = null;
        modalSnapshot = null;
        modalBaseline = null;
      });
    } catch (e) {
      log("could not open the settings window", e);
    }
  }

  // entry point: a button in the chat input "Extras" popover
  try {
    if (ctx?.ui?.registerInputBarAction) {
      const action = ctx.ui.registerInputBarAction({
        id: "auto-retry-settings",
        label: "Auto Retry settings",
        iconSvg: markSvg(false),
      });
      disposers.push(action.onClick(() => openSettings()));
      disposers.push(() => {
        try {
          action.destroy();
        } catch (_) {}
      });
    } else {
      log("this version of Lumiverse cannot add buttons to the Extras menu");
    }
  } catch (e) {
    log("could not add the settings button to the Extras menu", e);
  }

  // backup stop-press catcher (see onDocClick)
  if (typeof document !== "undefined") {
    document.addEventListener("click", onDocClick, true);
    // A keyboard or a screen reader can reach the edit box without a click
    // anywhere near it, and the host may fill it after focus rather than before.
    document.addEventListener("focusin", onDocFocusIn, true);
    disposers.push(() => {
      try {
        document.removeEventListener("click", onDocClick, true);
        document.removeEventListener("focusin", onDocFocusIn, true);
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
      ctx.events.on("CHAT_CHANGED", safe("CHAT_CHANGED", onChatSwitched)),
      ctx.events.on("CHAT_SWITCHED", safe("CHAT_SWITCHED", onChatSwitched)),
      // Free events, and the ones that fire when a chat is simply opened rather
      // than switched to. Their handlers do one thing: record which chat this
      // is, so the per-chat switch has something to act on straight away.
      ctx.events.on("CHARACTER_MESSAGE_RENDERED", safe("CHARACTER_MESSAGE_RENDERED", (p: any) => noteChat(p && p.chatId))),
      ctx.events.on("USER_MESSAGE_RENDERED", safe("USER_MESSAGE_RENDERED", (p: any) => noteChat(p && p.chatId))),
      ctx.events.on("MESSAGE_SENT", safe("MESSAGE_SENT", (p: any) => noteChat(p && p.chatId))),
    ];
  } catch (e) {
    log("could not listen for replies. Check that the generation permission is granted.", e);
  }
  syncLiveLog();
  syncFloat();
  tellBackendChatsOff();
  askActiveChat();
  loadFromAccount();
  loadPresetsFromAccount();
  syncInputBarActions();
  try {
    if (ctx && typeof (ctx as any).onBackendMessage === "function") {
      const offRep = (ctx as any).onBackendMessage(async (msg: any) => {
        try {
        if (!msg) return;
        if (msg.type === "confirm_edit") {
          // A confirmation about a message in a chat that is not open cannot be
          // acted on, so it is not raised.
          if (msg.chatId && lastChatId && String(msg.chatId) !== String(lastChatId)) {
            log("skipped a swap confirmation for a chat that is not open");
            return;
          }
          const yes = await confirmEdit("Apply your word swaps to this reply?");
          if (yes && ctx && typeof (ctx as any).sendToBackend === "function") {
            sendSwapRequest({ type: "apply_replace_now", chatId: msg.chatId, messageId: msg.messageId, requestId: "ar-rep-" + Date.now() });
          }
          return;
        }
        // The backend has just come up, so whatever it was told before is gone.
        // Only worth a message if this panel actually wants prompts; asking for
        // nothing is what it would already be getting.
        if (msg.type === "backend_ready") {
          askForPermissions();
          if (promptsAsked) {
            log("backend restarted, asking it for prompts again");
            askForPrompts(true);
          }
          return;
        }
        if (msg.type === "permissions") {
          permGranted = (msg && msg.granted) || {};
          permList = Array.isArray(msg && msg.list) ? msg.list : [];
          // Granted again clears the note that was put away, so if it is taken
          // away later that is a new thing to say rather than something already
          // dismissed. Putting a note away answers the permission being off
          // now, not for the rest of time.
          for (const name of Array.from(permHidden))
            if (permIs(name) === true) permHidden.delete(name);
          if (permPaint) {
            try { permPaint(); } catch (_) {}
          }
          if (liveTab === "prompt") renderLiveLog();
          return;
        }
        if (msg.type === "prompt_snapshot") {
          lastPrompt = msg;
          promptNeverArrived = false;
          // The count for the previous prompt does not describe this one, and
          // the follow-up carrying the new one may never arrive.
          lastPromptTokens = 0;
          if (liveTab === "prompt") renderLiveLog();
          return;
        }
        // Sent after the snapshot rather than with it, so counting never holds
        // the view up. Ignored when it belongs to a prompt already replaced.
        if (msg.type === "prompt_tokens") {
          if (!lastPrompt || (msg.at && lastPrompt.at && msg.at !== lastPrompt.at)) return;
          const n = Number(msg.tokens);
          if (!Number.isFinite(n) || n <= 0) return;
          lastPromptTokens = n;
          if (liveTab === "prompt") renderLiveLog();
          return;
        }
        if (msg.type === "note_skipped") {
          stats.notesSkipped += 1;
          stats.lastNoteSkip = String(msg.reason || "unknown");
          log("refusal note not sent: " + stats.lastNoteSkip);
          return;
        }
        // Logged as well as the skip. "Did my note go out?" had no answer here
        // that was not a guess from the reply, so only the failures were ever
        // visible and a working note looked identical to no note at all.
        if (msg.type === "note_sent") {
          stats.notesSent += 1;
          const n = Number(msg.count) || 0;
          log("refusal note sent with the retry (" + n + (n === 1 ? " note" : " notes") + ")");
          return;
        }
        // Sent after an automatic swap. The message is already saved; this only
        // brings what is on screen into line with it. A swap can now land well
        // after the reply did, so a result for a chat we are no longer looking
        // at must not rewrite the one we are.
        if (msg.type === "swapped") {
          // Remembered whatever chat it was for. The edit box for a message in
          // another chat can still be opened after switching back to it.
          rememberSwap(msg.before, msg.after);
          // Counted before the check below, which returns early for a swap that
          // happened in a chat the user has since left. It still happened.
          noteSwaps(msg.chatId, (msg.pairs || []).length);
          if (msg.chatId && lastChatId && String(msg.chatId) !== String(lastChatId)) return;
          applySwapsToView(msg.pairs || []);
          repairEditBox();
          return;
        }
        // The account copy could not be written. The browser copy may well have
        // worked, so this does not say the settings are lost: it says the part
        // that carries them to another device did not happen.
        if (msg.type === "account_save_failed") {
          const what = msg.what === "presets" ? "presets" : "settings";
          log("the account copy of the " + what + " could not be saved");
          showToast(
            "Your " + what + " are saved in this browser, but could not be saved to your account, so they will not follow you to another device.",
            { force: true },
          );
          return;
        }
        // Said as soon as the backend has the request, before any work. It is
        // the only thing the timeout is waiting for.
        if (msg.type === "replace_now_ack") {
          clearSwapWait(msg.requestId);
          return;
        }
        if (msg.type !== "replace_now_result") return;
        // Also here, for a build whose acknowledgement never arrived: the
        // result answers the same question, later.
        clearSwapWait(msg.requestId);
        for (const e of msg.edits || []) rememberSwap(e && e.before, e && e.after);
        if (msg.ok) noteSwaps(msg.chatId, (msg.pairs || []).length);
        if (msg.ok) { applySwapsToView(msg.pairs || []); repairEditBox(); }
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
  // Every Extras button the extension can add is removed here, by walking the
  // map instead of naming them one at a time, so a new entry cannot be left off
  // and survive a reload, piling up a duplicate each time.
  disposers.push(() => dropBarEntries());
  disposers.push(() => dropToggleAction());
  // A swap timer left running would show a message about a backend nobody is
  // waiting on any more, from an extension that has already been closed.
  disposers.push(() => {
    for (const timer of Array.from(swapWaits.values())) {
      try { clearTimeout(timer); } catch (_) {}
    }
    swapWaits.clear();
  });
  askForPermissions();
  log("ready v" + VERSION, cfg);

  return () => {
    tornDown = true;
    clearConfirmWatch();
    // The full-size editor is parented to the page, not to the modal, so
    // dismissing the modal below does not take it with it. Left open it would
    // sit over the chat with nothing behind it.
    if (closeExpandEditor) {
      try {
        closeExpandEditor();
      } catch (_) {}
      closeExpandEditor = null;
    }
    if (closeCrisisNotice) {
      try {
        closeCrisisNotice();
      } catch (_) {}
      closeCrisisNotice = null;
    }
    if (closeResetPicker) {
      try {
        closeResetPicker();
      } catch (_) {}
      closeResetPicker = null;
    }
    if (hideStyleEl) {
      try {
        hideStyleEl.remove();
      } catch (_) {}
      hideStyleEl = null;
    }
    if (panelStyleEl) {
      try {
        panelStyleEl.remove();
      } catch (_) {}
      panelStyleEl = null;
    }
    if (statusStyleEl) {
      try {
        statusStyleEl.remove();
      } catch (_) {}
      statusStyleEl = null;
    }
    if (floatStyleEl) {
      try {
        floatStyleEl.remove();
      } catch (_) {}
      floatStyleEl = null;
    }
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
    for (const t of repairTimers) {
      try { clearTimeout(t); } catch (_) {}
    }
    repairTimers = [];
    swapUndos.length = 0;
    lastPrompt = null;
    paintTabs = null;
    focusTab = null;
    for (const drop of Array.from(chatAsks)) {
      try { drop(); } catch (_) {}
    }
    hideLiveLog();
    hideDrawerPanel();
    hideFloat();
    // Every live figure stops with the extension. hideLiveLog and hideToast
    // each drop their own, and this is the backstop: one interval left running
    // after teardown would keep a dead closure alive for the life of the tab.
    stopToastCountdown();
    tickers.clear();
    retick();
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

// Exported for the test suite in test/ only. setup() above is the whole API the
// host uses; nothing here is part of it. These are the decisions worth pinning
// down in a test: whether a reply counts as a refusal or as cut off, and
// whether a colour pairing is readable. All of them are pure functions of their
// input, so they can be checked without a browser.
export const __testing = {
  parseColor,
  blendColor,
  relLuminance,
  contrastRatio,
  refusalVerdict,
  looksLikeRefusalError,
  looksTruncated,
  sayTime,
  normalizeForMatch,
  splitPhrases,
  parseSubs,
  applySubs,
  stripThinking,
  REASONING_TOKEN,
  stripMarkup,
  splitSelectorList,
  withLongForms,
  REFUSAL_PHRASES,
  // The defaults block and the form built from it, so a check can hold the two
  // against each other. A hint spelling its default out by hand goes stale the
  // first time that value is retuned, with nothing to catch it.
  CONFIG,
  SCHEMA,
};
