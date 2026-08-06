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
// The section-header carets. Named so the open and shut states are set from
// one place instead of repeating the escapes at every call site.
const CARET_OPEN = "\u25BE"; // down triangle
const CARET_SHUT = "\u25B8"; // right triangle
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
// Largest amount of streamed text kept per chat as a fallback when the end
// event arrives without a content field. Trimmed from the front past this.
const STREAM_BUF_MAX = 200000;
// Bumped on each release. Shown in the startup log and in the Copy debug info
// report, so a bug report always says which version it came from.
const VERSION = "4.4.0";
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
    retryByNewReroll: false,
    // watchdogs. Both are deliberately generous. A watchdog that fires early on a
    // slow but healthy model is worse than one that fires late: it throws away a
    // reply that was still arriving, and the replacement is generated by the same
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
    retryOnNoPunct: false, // extra: also treat "ends with no punctuation" as truncated. Noisy in RP, off by default.
    retryOnShort: false, // off by default. Caused endless regen in the original.
    minChars: 24,
    retryOnRefusal: true, // final content is an out-of-character refusal (see looksLikeRefusal). Re-fires the SAME request, capped by maxRetries. Does not alter the request.
    refusalExtraPhrases: "", // your own extra refusal phrases, one per line. Any reply containing one counts as a refusal.
    refusalPhraseSubs: "", // reword the built-in phrases: "old => new" rules, one per line, applied to the built-in list before matching.
    refusalIgnorePhrases: "", // a reply containing any of these (one per line) is never counted as a refusal.
    refusalUseBuiltins: true, // use the built-in refusal lists. Turn off to run purely on your own phrases below.
    refusalCatchDisengage: true, // also catch the model ending the scene ("I'll stop here", "I won't continue this conversation"). Only counted near the end of a reply and never inside quotation marks.
    refusalIgnoreQuoted: true, // a match inside quotation marks is a character speaking, not the model, so it is not counted.
    refusalMaxChars: 2000, // only replies up to this length are considered refusals. Longer = treated as real content. 0 = no limit (scan any length).
    refusalStripThinking: true, // ignore the model's thinking when checking for a refusal, so a refusal that lives only in a <think> block does not trigger a retry when the visible reply is fine.
    refusalThinkTags: "", // extra reasoning tag names (one per line) the model wraps its thinking in, on top of the built-in set. Both <tag> and [tag] forms are handled.
    // A note sent with a refusal retry, and only with a refusal retry. It goes
    // into the prompt for that one generation and is never written to the chat.
    // Off by default, and does nothing at all while the text is empty.
    refusalNote: false,
    // A list rather than one string, so a note can answer the one before it. Each
    // entry carries its own role. Sent in order, as one block, at the placement
    // below. Empty entries are skipped, so a half-filled list is not a trap.
    refusalNotes: [{ text: "", role: "system" }],
    refusalNotePlacement: "after", // after | before | start, relative to the last real message
    refusalNoteFromTry: 2, // which retry it starts on. 1 sends it every time.
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
    confirmBeforeEdit: false, // ask for confirmation before any word-swap edit (automatic or manual); the user can cancel.
    swapWaitForEdits: false, // wait for another extension to finish editing a reply before swapping it.
    swapWaitSecs: 15, // how long to give it, in seconds. Only used when the above is on.
    // host controls (the only DOM-dependent part). Use the Test buttons in settings.
    // Multiple patterns are listed so a Lumiverse build that renames one attribute
    // is still likely covered; if a build changes them all, fix it via the Test UI.
    regenerateSelector: '[title="Regenerate"], [data-action="regenerate"], [data-testid="regenerate"], ' +
        'button[aria-label*="regenerate" i], button[title*="regenerate" i]',
    swipeNextSelector: '[aria-label="Next swipe"], [data-action="swipe-right"], [data-testid="swipe-right"], ' +
        'button[aria-label*="next swipe" i], button[aria-label*="swipe right" i], ' +
        'button[aria-label*="reroll" i], button[title*="swipe" i]',
    // extra button labels Auto Retry may press on a dialog that appears after it
    // clicks retry. One per line. Blank means the built-in list only.
    confirmButtonLabels: "",
    stopSelector: '[aria-label="Stop generation"], [data-action="stop"], [data-testid="stop"], ' +
        'button[aria-label*="stop" i], button[title*="stop" i], [class*="_sendBtnStop_"]',
    toast: true,
    liveLog: false, // show a small on-screen panel with recent activity, updating live. Handy on mobile where dev tools aren't available.
};
// A hint that quotes a default reads it from the block above rather than
// spelling it out. Five of them were written by hand and went stale the moment
// the timings were retuned: the panel was telling people it waited 30 seconds
// while the extension waited 60, and that a stalled reply was given 90 seconds
// when it was given three minutes. A wrong number in a hint is worse than no
// number, because it is the one thing in the row someone will trust over the
// box next to it. Nothing below is a literal now, so a default cannot be
// changed without every hint that mentions it changing with it.
function humanMs(ms) {
    if (ms >= 60000 && ms % 60000 === 0) {
        const m = ms / 60000;
        return m + (m === 1 ? " minute" : " minutes");
    }
    const s = ms / 1000;
    return s + (s === 1 ? " second" : " seconds");
}
// "60000 = 60 seconds", built from whatever the default actually is.
function defaultMs(key) {
    const ms = Number(CONFIG[key]);
    return ms + " = " + humanMs(ms);
}
const def = (key) => String(CONFIG[key]);
const SCHEMA = [
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
                key: "showFloatingToggle",
                label: "Floating on/off button",
                type: "bool",
                hint: "Off by default. Puts a small round button on top of the chat that turns Auto Retry on or off in one tap. It shows which state it is in, and you can drag it anywhere; where you leave it is remembered. Handy if you switch it on and off a lot.",
            },
            {
                key: "floatingToggleSize",
                needs: ["showFloatingToggle"],
                label: "Size of the floating button",
                type: "num",
                int: true,
                min: 28,
                max: 96,
                hint: "How wide the floating button is, in pixels. The default of " + def("floatingToggleSize") + " is about a comfortable thumb. Larger is easier to hit on a phone, smaller keeps it out of the way.",
            },
            {
                key: "showExtrasToggle",
                label: "On/off button in the Extras menu",
                type: "bool",
                hint: "Off by default. Adds an Auto Retry on/off entry to the chat input's Extras menu, next to the settings button. It says which state it is in, so you can check and change it without opening settings. Unlike the floating button it takes up no room on screen.",
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
                hint: "On by default. If several whole runs give up in a row, the provider is probably down, so auto-retry stops for a while instead of retrying on every message you send. The next reply that works clears it, and you can still send and regenerate by hand while it's paused. The two boxes below set how many runs and how long.",
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
                hint: "How long auto-retry stays off once it pauses. Shorter suits a provider that hiccups and recovers; longer suits a real outage. Any reply that comes back fine ends the pause early, whatever this is set to.",
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
                hint: "Off: a retry redoes the reply in place with your regenerate button. On some setups that clears the other rerolls on that message. On: a retry clicks your next / swipe button, which adds a new reroll and keeps the existing ones. Either way, if that button isn't on screen or the click starts nothing, it uses the other one, so set both selectors in the buttons section below.",
            },
        ],
    },
    {
        title: "Watch for frozen replies",
        desc: "Notices when a reply freezes or never arrives, and retries. Defaults lean long so a slow connection isn't mistaken for a freeze; lower them for quicker retries on a fast provider.",
        fields: [
            {
                key: "stuckTimeoutMs",
                label: "Give up waiting for it to start (ms)",
                type: "num",
                int: true,
                min: 0,
                max: 600000,
                hint: "If a reply begins but no words appear in this long, treat it as stuck and retry. The default is " + defaultMs("stuckTimeoutMs") + ", which is long enough for a local model to load and for a long prompt to be read before the first word arrives. Set to 0 to switch off.",
            },
            {
                key: "idleTimeoutMs",
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
                hint: "Retry when a reply stops partway, like an open quote, an unfinished *action*, or a trailing comma. It's careful so it doesn't throw away good writing.",
            },
            {
                key: "retryOnNoPunct",
                label: "Also: it ends with no punctuation",
                type: "bool",
                hint: "A stricter version of the line above. It can wrongly redo a reply that ends on a word, so most people leave this off.",
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
                needs: ["showReplaceButton", "showSwapAllButton"],
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
            {
                key: "swapWaitForEdits",
                label: "Wait for other extensions to finish",
                type: "bool",
                hint: "Off by default. Turn this on if another extension also rewrites replies, like Hone with auto-refine on. Normally a swap is applied the moment a reply lands, and the other extension's rewrite then arrives on top and undoes it. With this on, the swap waits for the reply to stop changing and then applies to whatever the text has become, so both survive. If a later edit undoes a swap anyway, it is applied again, up to three times per reply. Leave it off if nothing else edits your replies: it only adds a delay.",
            },
            {
                key: "swapWaitSecs",
                needs: ["swapWaitForEdits"],
                label: "How long to wait (seconds)",
                type: "num",
                int: true,
                min: 1,
                max: 120,
                hint: "How long to give another extension to make its edit before swapping anyway. Each edit restarts the clock and the swap follows shortly after the last one, so this is only the full wait when nothing else edits at all. The default of " + def("swapWaitSecs") + " suits a refinement pass on a fast model; raise it for a slow one. A reply that never stops changing is swapped after three minutes regardless.",
            },
        ],
    },
    {
        title: "Advanced: refusal tuning (beta)",
        // Every setting under here feeds looksLikeRefusal, and all three places
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
                key: "refusalIgnoreQuoted",
                label: "Ignore refusals inside quotation marks",
                type: "bool",
                hint: "On by default. A line inside quotation marks is a character speaking, so it is not counted as the model refusing. This is what keeps \"I can't help with that,\" said the innkeeper from being thrown away. Turn it off only if your model puts its own refusals in quotes. Your own phrases are always counted either way.",
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
                hint: "Optional, one per line. The common reasoning tags are already handled. Add a tag name only if your model wraps its thinking in an unusual one (for example: mythink). Just the name, no brackets. Both <name> and [name] forms are covered.",
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
                hint: "Goes to the model, not to your chat. Whatever you type is sent exactly as written: nothing is added to it, nothing is removed, and nothing in it is checked. Add up to ten with the plus button and they are sent in order, as one block, so a note can answer the one before it. Each carries its own role: system puts it alongside the instructions your setup already sends, you puts it in the same role as your own messages, and the character puts it in the same role as the replies. Models treat the three differently, so which one works best depends on your model and your setup. An empty note is skipped.",
            },
            {
                key: "refusalNotePlacement",
                needs: ["refusalNote"],
                label: "Where the note goes",
                type: "pick",
                options: [
                    { value: "after", label: "After the last message" },
                    { value: "before", label: "Before the last message" },
                    { value: "start", label: "At the very start" },
                ],
                hint: "Where the note is inserted. After the last message puts it at the end, right before the point the reply continues from. Before the last message puts it one place earlier, so the newest line is still last. At the very start puts it ahead of everything, with the setup.",
            },
            {
                key: "refusalNoteFromTry",
                needs: ["refusalNote"],
                label: "Start the note on try",
                type: "num",
                int: true,
                min: 1,
                max: 20,
                hint: "Which retry the note starts on. At 2, the first retry re-sends unchanged and the note is added from the second onward. At 1, it is added to every refusal retry.",
            },
            {
                key: "refusalNoteStrictType",
                needs: ["refusalNote"],
                label: "Only send it on a regenerate or a swipe",
                type: "bool",
                hint: "Off by default, and best left off. Lumiverse tells the extension what kind of generation is running, and most builds call every one of them \"normal\", including a regenerate. With this on, the note is only attached when your build says \"regenerate\" or \"swipe\", so on a build that says \"normal\" the note is never sent at all. Turn it on only if your build reports the kind properly and you want the extra check. Either way the note goes out once, to the chat it was armed in, on the retry that armed it.",
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
                hint: "Almost nobody needs this. If you use Lumiverse's Regeneration Feedback, a retry opens that box and Auto Retry presses Skip to carry on. Use this box if your button says something else, so it gets pressed too. Type the button's text exactly as it appears, one per line. Capitals are ignored. It already knows Skip, Regenerate, Confirm, Proceed, Submit and OK, and anything you add is tried first.",
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
// text. Kept conservative to avoid re-rolling good roleplay replies.
function looksTruncated(text, retryOnNoPunct, cfg) {
    const raw = String(text == null ? "" : text).replace(/\s+$/, "");
    if (!raw)
        return false; // empty is handled by the empty branch
    // An opened reasoning block with no close means the reply was cut inside the
    // model's thinking. Checked on the raw text, before anything is removed.
    if (/<(?:think|thinking|reasoning|reflection|thought)\b[^>]*>/i.test(raw) &&
        !/<\/(?:think|thinking|reasoning|reflection|thought)\s*>/i.test(raw))
        return true;
    // The checks below count fences, backticks, asterisks and quotes. A closed
    // reasoning block sits outside the visible reply and its punctuation throws
    // those counts off, so it is removed first regardless of the refusal-side
    // thinking option, which governs refusal matching only.
    const t = stripThinkingAlways(raw, cfg).replace(/\s+$/, "");
    if (!t)
        return false;
    if ((t.match(/```/g) || []).length % 2 === 1)
        return true; // open code fence
    if ((t.replace(/```/g, "").match(/`/g) || []).length % 2 === 1)
        return true; // open inline code
    // Emphasis asterisks only. Strip markdown bullet markers ("* " at line start)
    // first, or a reply with an odd number of list bullets would read as an open
    // emphasis run and get re-rolled. Emphasis pairs (*x*, **x**) are unaffected.
    const emphasis = t.replace(/^[ \t]*\*[ \t]+/gm, "");
    if ((emphasis.match(/\*/g) || []).length % 2 === 1)
        return true; // open emphasis / RP action
    if ((t.match(/"/g) || []).length % 2 === 1)
        return true; // open straight-quote dialogue
    if ((t.match(/\u201C/g) || []).length !== (t.match(/\u201D/g) || []).length)
        return true; // mismatched smart quotes
    if (/[,;]$/.test(t))
        return true; // cut mid-clause
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
function normalizeForMatch(text) {
    return String(text == null ? "" : text)
        .replace(/[\u2018\u2019\u02BC\u2032]/g, "'")
        .replace(/[\u201C\u201D\u2033]/g, '"')
        .replace(/[^\S\n]*\n[\s]*/g, "\n")
        .replace(/[^\S\n]+/g, " ")
        .trim();
}
// A user list is newline-separated (one entry per line). Lowercased + normalized for a
// case-insensitive substring test.
function splitPhrases(raw) {
    return String(raw == null ? "" : raw)
        .split(/\r?\n/)
        .map((p) => normalizeForMatch(p).toLowerCase())
        .filter((p) => p.length > 0);
}
// Reword rules: "old => new" pairs, one per line. Lets a user
// swap a word or bit of phrasing in the built-in list for wording they prefer.
// Empty "new" is allowed (deletes the old text).
function parseSubs(raw) {
    const out = [];
    for (const rule of String(raw == null ? "" : raw).split(/\r?\n/)) {
        const i = rule.indexOf("=>");
        if (i < 0)
            continue;
        const from = normalizeForMatch(rule.slice(0, i)).toLowerCase();
        const to = normalizeForMatch(rule.slice(i + 2)).toLowerCase();
        if (from)
            out.push({ from, to });
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
const CONTRACTIONS = [
    [/\bi'm\b/g, "i am"],
    [/\bcan't\b/g, "cannot"],
    [/\bwon't\b/g, "will not"],
    [/\bdon't\b/g, "do not"],
    [/\bisn't\b/g, "is not"],
    [/\bdoesn't\b/g, "does not"],
    [/\bthat's\b/g, "that is"],
];
function withLongForms(phrases) {
    const out = phrases.slice();
    const seen = new Set(phrases);
    for (const p of phrases) {
        let long = p;
        for (const [re, full] of CONTRACTIONS)
            long = long.replace(re, full);
        if (long !== p && !seen.has(long)) {
            seen.add(long);
            out.push(long);
        }
    }
    return out;
}
// Apply the reword rules to the built-in phrase list. Each phrase is already
// lowercase/normalized, matching how rules are parsed.
function applySubs(phrases, subs) {
    if (!subs.length)
        return phrases;
    return phrases
        .map((p) => {
        let out = p;
        for (const s of subs)
            if (s.from)
                out = out.split(s.from).join(s.to);
        return out;
    })
        .filter((p) => p.length > 0);
}
// Tier 1: strong regexes. Anchored so an in-character "I can't help you carry
// that" doesn't trip them. These carry the precision.
const REFUSAL_STRONG = [
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
    /\b(?:that|this)(?:'s not|\s+is not|\s+isn'?t) something I(?: can| am able to|'m able to| could) (?:help with|assist with|create|generate|provide|write|do)\b/i,
    /\bI(?:'m| am) not going to (?:create|generate|produce|write) (?:that|this|such|content|explicit|sexual|those)\b/i,
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
    // The redirect offer that closes most refusals. Help-desk register plus a task
    // noun, so an in-scene offer of help does not reach it.
    /\bI(?:'m| am) (?:available|happy|glad) to (?:assist|help)\b[^.?!\n]{0,60}?\b(?:writing tasks?|creative writing|analysis|queries|other requests?|other topics?)\b/i,
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
// ("let's move on", "let's stop here", "I'll leave it at that") are left out
// on purpose: they cost more in thrown-away replies than they are worth. Add
// them yourself under "Your own refusal phrases" if your model uses them.
const REFUSAL_DISENGAGE = [
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
const DIALOGUE_TAG = /^[,.!?"'\u2014\u2013 ]{0,4}(?:he|she|they|it|i|[A-Z][a-z]+)\s+(?:said|says|replied|replies|answered|answers|added|adds|muttered|mutters|murmured|whispered|whispers|told|asked|asks|continued|continues|snapped|snaps|sighed|sighs|declared|announced|insisted|thought|thinks|decided|decides)\b/;
// Tier 3: soft redirect tells. These lean on a pivot ("...instead", "instead, I
// can...") so an ordinary helpful reply that just offers to help doesn't match.
const REFUSAL_SOFT = [
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
function stripThinking(text, cfg) {
    let t = String(text == null ? "" : text);
    if (cfg && cfg.refusalStripThinking === false)
        return t;
    const extra = String((cfg && cfg.refusalThinkTags) || "").split(/\r?\n/).map((s) => s.replace(/[^\w-]/g, "").toLowerCase()).filter(Boolean);
    const names = THINK_TAGS.concat(extra);
    if (!names.length)
        return t;
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
function stripThinkingAlways(text, cfg) {
    return stripThinking(text, { refusalThinkTags: cfg && cfg.refusalThinkTags });
}
// True when the span at [start,end) sits inside a pair of quotation marks.
// Used only for the "I am an AI" patterns: a character in a story can say that
// line, and when they do it is dialogue, not the model stepping out of the
// scene. Straight and curly quotes both count.
function spanIsQuoted(text, start, end) {
    const QUOTES = "\"\u201c\u201d\u00ab\u00bb";
    let open = -1;
    for (let i = start - 1; i >= 0; i--) {
        const c = text[i];
        if (c === "\n")
            break; // a line break ends any quotation for our purposes
        if (QUOTES.indexOf(c) >= 0) {
            open = i;
            break;
        }
    }
    if (open < 0)
        return false;
    for (let i = end; i < text.length; i++) {
        const c = text[i];
        if (c === "\n")
            return false;
        if (QUOTES.indexOf(c) >= 0)
            return true;
    }
    return false;
}
function refusalVerdict(text, cfg) {
    const raw = stripThinking(String(text == null ? "" : text), cfg).trim();
    // empty is handled by the empty branch
    if (!raw)
        return {
            refusal: false,
            reason: "there is no reply text left once the thinking is removed",
        };
    const maxChars = cfg && Number.isFinite(cfg.refusalMaxChars)
        ? cfg.refusalMaxChars
        : REFUSAL_MAX_CHARS;
    // long immersive reply, not a refusal
    if (maxChars > 0 && raw.length > maxChars)
        return {
            refusal: false,
            reason: "it is " +
                raw.length +
                " characters, past the " +
                maxChars +
                "-character limit, so it counts as real writing",
        };
    const norm = normalizeForMatch(raw);
    const lower = norm.toLowerCase();
    // Whitelist wins: anything the user parked here is never a refusal.
    for (const p of splitPhrases(cfg && cfg.refusalIgnorePhrases))
        if (lower.includes(p))
            return {
                refusal: false,
                reason: 'your "never treat these as a refusal" list matched: ' + p,
            };
    // The user's own additions count as refusals. Not subject to the quotation
    // rule below: someone who typed a phrase in meant it, wherever it appears.
    for (const p of splitPhrases(cfg && cfg.refusalExtraPhrases))
        if (lower.includes(p))
            return { refusal: true, reason: "one of your own phrases matched: " + p };
    // Anything inside quotation marks is a character speaking. A model refusing
    // never puts its refusal in quotes, and a character declining almost always
    // is in them, so this is the single cheapest way to tell the two apart.
    //
    // It used to apply only to the "I am an AI" patterns, which left every other
    // built-in matching dialogue: '"I can\'t help with that," she said' was
    // counted as a refusal and the reply was thrown away. It now covers every
    // built-in tier, and the user can switch it off.
    //
    // lower is only index-compatible with norm while the two are the same length.
    // Lowercasing grows a handful of letters (Turkish dotted I among them), and a
    // reply containing one would otherwise have its quotation check read the
    // wrong span, so in that case the check is skipped rather than guessed at.
    const canLocate = lower.length === norm.length;
    const quotesOff = !!(cfg && cfg.refusalIgnoreQuoted === false);
    const isQuoted = (start, len) => !quotesOff && start >= 0 && spanIsQuoted(norm, start, start + len);
    // Built-in English lists, unless the user has switched them off to run pure-custom.
    if (!cfg || cfg.refusalUseBuiltins !== false) {
        for (const re of REFUSAL_STRONG) {
            const m = norm.match(re);
            if (!m)
                continue;
            if (typeof m.index === "number" && isQuoted(m.index, m[0].length))
                continue;
            return { refusal: true, reason: 'a built-in pattern matched: "' + m[0] + '"' };
        }
        // Reworded first, then expanded: a rule the user wrote against the listed
        // wording has to reach the written-out form of it too.
        const phrases = withLongForms(applySubs(REFUSAL_PHRASES, parseSubs(cfg && cfg.refusalPhraseSubs)));
        for (const p of phrases) {
            const at = lower.indexOf(p);
            if (at < 0)
                continue;
            if (canLocate && isQuoted(at, p.length))
                continue;
            return { refusal: true, reason: 'a built-in phrase matched: "' + p + '"' };
        }
        for (const re of REFUSAL_SOFT) {
            const m = norm.match(re);
            if (!m)
                continue;
            if (typeof m.index === "number" && isQuoted(m.index, m[0].length))
                continue;
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
                let m;
                while ((m = scan.exec(norm)) !== null) {
                    const end = m.index + m[0].length;
                    if (scan.lastIndex === m.index)
                        scan.lastIndex++; // never on a zero-width match
                    if (norm.length - end > DISENGAGE_TAIL_CHARS)
                        continue;
                    if (isQuoted(m.index, m[0].length))
                        continue;
                    if (!quotesOff && DIALOGUE_TAG.test(norm.slice(end, end + 48)))
                        continue;
                    return {
                        refusal: true,
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
        reason: "the built-in lists are off and none of your own phrases matched",
    };
}
function looksLikeRefusal(text, cfg) {
    return refusalVerdict(text, cfg).refusal;
}
// Some providers deliver a refusal as an error string (e.g. a prohibited-content
// result) rather than as reply text. This matches that, tuned for short error
// messages, and stay narrow to content-moderation wording so it never
// fires on a network error like "connection refused" or a timeout. Only used as
// a fallback when the user has turned normal error-retries off but still wants
// refusals caught. Respects the user's phrase lists and the built-ins toggle.
const REFUSAL_ERROR = /\b(?:prohibited[_ ]?content|content[_ ]?polic(?:y|ies)|safety[_ ]?(?:polic(?:y|ies)|filter|settings?)|response was blocked|blocked (?:by|for) (?:safety|content|moderation)|content[_ ]?filter|moderation|flagged as|violat\w* (?:content|safety|polic)|finish[_ ]?reason["'\s:=]*(?:safety|prohibited|blocklist|recitation)|blocklist)\b/i;
function looksLikeRefusalError(errText, cfg) {
    const norm = normalizeForMatch(errText);
    if (!norm)
        return false;
    const lower = norm.toLowerCase();
    for (const p of splitPhrases(cfg && cfg.refusalIgnorePhrases))
        if (lower.includes(p))
            return false;
    for (const p of splitPhrases(cfg && cfg.refusalExtraPhrases))
        if (lower.includes(p))
            return true;
    if (!cfg || cfg.refusalUseBuiltins !== false) {
        if (REFUSAL_ERROR.test(norm))
            return true;
    }
    return false;
}
// Splits a selector list on its top-level commas only. A comma inside brackets,
// parentheses or quotes belongs to the selector rather than separating the list,
// so :is(a, b) and [aria-label="Next, swipe"] survive whole. Entries come back
// trimmed, with blanks dropped.
function splitSelectorList(raw) {
    const src = String(raw == null ? "" : raw);
    const out = [];
    let buf = "";
    let depth = 0;
    let quote = "";
    for (let i = 0; i < src.length; i++) {
        const c = src[i];
        if (quote) {
            buf += c;
            if (c === "\\" && i + 1 < src.length) {
                buf += src[i + 1];
                i++;
                continue;
            }
            if (c === quote)
                quote = "";
            continue;
        }
        if (c === "\\" && i + 1 < src.length) {
            buf += c + src[i + 1];
            i++;
            continue;
        }
        if (c === '"' || c === "'") {
            quote = c;
            buf += c;
            continue;
        }
        if (c === "(" || c === "[" || c === "{") {
            depth++;
            buf += c;
            continue;
        }
        if (c === ")" || c === "]" || c === "}") {
            if (depth > 0)
                depth--;
            buf += c;
            continue;
        }
        if (c === "," && depth === 0) {
            out.push(buf.trim());
            buf = "";
            continue;
        }
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
function deriveSelector(start) {
    let el = start;
    let hops = 0;
    // Clicks usually land on an icon or a span inside the control, so walk up to
    // the thing that actually behaves like a button.
    while (el && hops < 6) {
        const tag = String(el.tagName || "").toLowerCase();
        const role = el.getAttribute ? el.getAttribute("role") : null;
        if (tag === "button" || tag === "a" || role === "button")
            break;
        el = el.parentElement;
        hops++;
    }
    if (!el || !el.getAttribute)
        el = start;
    if (!el || !el.getAttribute)
        return null;
    const tag = String(el.tagName || "").toLowerCase() || "*";
    const q = (v) => '"' + String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
    for (const attr of ["data-testid", "data-test-id", "data-test", "data-action", "aria-label", "title", "name"]) {
        const v = el.getAttribute(attr);
        if (v && String(v).trim())
            return tag + "[" + attr + "=" + q(String(v).trim()) + "]";
    }
    const id = el.getAttribute("id");
    if (id && SAFE_NAME.test(id) && !UNSTABLE_NAME.test(id))
        return "#" + id;
    const cls = String(el.className || "")
        .split(/\s+/)
        .filter((c) => c && SAFE_NAME.test(c) && !UNSTABLE_NAME.test(c));
    if (cls.length)
        return tag + "." + cls.slice(0, 2).join(".");
    return null;
}
// getComputedStyle hands colours back as rgb()/rgba(), so that is all this needs
// to read. Anything else is reported as unknown and the caller leaves it alone.
function parseColor(value) {
    const m = String(value == null ? "" : value)
        .trim()
        .match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+%?))?\s*\)$/i);
    if (!m)
        return null;
    let a = 1;
    if (m[4] != null) {
        a =
            m[4].indexOf("%") >= 0
                ? parseFloat(m[4]) / 100
                : parseFloat(m[4]);
        if (!Number.isFinite(a))
            a = 1;
    }
    const c = [Number(m[1]), Number(m[2]), Number(m[3]), Math.max(0, Math.min(1, a))];
    return c.slice(0, 3).some((n) => !Number.isFinite(n)) ? null : c;
}
// Lay a partly transparent colour over an opaque one.
function blendColor(top, under) {
    const a = top[3];
    return [
        top[0] * a + under[0] * (1 - a),
        top[1] * a + under[1] * (1 - a),
        top[2] * a + under[2] * (1 - a),
        1,
    ];
}
function relLuminance(c) {
    const chan = (v) => {
        const x = Math.max(0, Math.min(1, v / 255));
        return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * chan(c[0]) + 0.7152 * chan(c[1]) + 0.0722 * chan(c[2]);
}
// The WCAG contrast ratio, 1 (identical) to 21 (black on white).
function contrastRatio(a, b) {
    const la = relLuminance(a);
    const lb = relLuminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
// What is actually behind an element: its own background when that is opaque,
// otherwise the ancestors' backgrounds composited underneath it.
const PAGE_FALLBACK = [20, 16, 30, 1]; // Lumiverse ships dark; last resort only
// What a surface actually paints, rather than only what its background-color
// says. Every floating panel here builds an opaque surface by painting a solid
// colour and laying the theme's translucent tint over it as a gradient, because
// the tint alone is 90% opaque and lets the text behind read through.
// getComputedStyle reports the colour underneath and says nothing about the
// gradient, so on a theme that leaves --lumiverse-card-bg-solid unset the
// popover measured as the dark fallback while painting near-white, and its text
// was helpfully repainted white to suit. It vanished.
function paintedBg(el) {
    let base = null;
    let img = "";
    try {
        const cs = getComputedStyle(el);
        base = parseColor(cs.backgroundColor);
        img = String(cs.backgroundImage || "");
    }
    catch (_) {
        return base;
    }
    if (img.indexOf("gradient") < 0)
        return base;
    // Only the first stop is read. These gradients are one colour repeated, used
    // to lay a flat tint rather than to shade anything.
    const stop = img.match(/rgba?\([^)]*\)|#[0-9a-fA-F]{3,8}/);
    const over = stop ? parseColor(stop[0]) : null;
    if (!over)
        return base;
    if (!base || base[3] <= 0)
        return over;
    const mixed = blendColor(over, base);
    // An opaque layer under a translucent one is still opaque. A translucent one
    // under it is not, so the walk upward has to continue.
    mixed[3] = base[3] >= 0.999 ? 1 : Math.min(1, base[3] + over[3] * (1 - base[3]));
    return mixed;
}
function backdropOf(el) {
    const layers = [];
    let p = el;
    let hops = 0;
    while (p && hops < 24) {
        let c = null;
        try {
            c = paintedBg(p);
        }
        catch (_) { }
        if (c && c[3] > 0) {
            layers.push(c);
            if (c[3] >= 0.999)
                break; // nothing below this can show through
        }
        p = p.parentElement;
        hops++;
    }
    let base = PAGE_FALLBACK;
    for (let i = layers.length - 1; i >= 0; i--)
        base = blendColor(layers[i], base);
    return base;
}
// Below this ratio a label is hard to pick out; at 1 it is invisible.
const MIN_CONTRAST = 3.2;
const NEAR_WHITE = "#ffffff";
const NEAR_BLACK = "#14121a";
// Repaint an element's text only if it fails the contrast floor against what is
// behind it, so a theme that already reads well keeps its own colours exactly.
function fixContrast(el, min) {
    try {
        if (!el || typeof getComputedStyle !== "function")
            return;
        const want = typeof min === "number" ? min : MIN_CONTRAST;
        const fg = parseColor(getComputedStyle(el).color);
        if (!fg)
            return;
        const bg = backdropOf(el);
        if (contrastRatio(blendColor(fg, bg), bg) >= want)
            return;
        const light = [255, 255, 255, 1];
        const dark = [20, 18, 26, 1];
        el.style.color =
            contrastRatio(light, bg) >= contrastRatio(dark, bg) ? NEAR_WHITE : NEAR_BLACK;
    }
    catch (_) { }
}
// Colours only resolve once the element is in the page and laid out, so the
// check waits a frame rather than running against a half-built tree.
function afterPaint(fn) {
    if (typeof requestAnimationFrame === "function")
        requestAnimationFrame(fn);
    else
        fn();
}
// Checkboxes and number spinners are drawn by the browser, not by us. The
// browser picks their colours from the page's colour scheme rather than from
// the theme, and with no scheme set it assumes light, which is why an unchecked
// box came out as a white block sitting on a dark panel. This is the same fault
// that made the search field's clear button white. Rather than assume dark,
// measure what the panel is actually sitting on and say which way round it is,
// so a light theme still gets light controls.
function matchColorScheme(el) {
    afterPaint(() => {
        try {
            if (!el || !el.style)
                return;
            const bg = backdropOf(el);
            if (!bg)
                return;
            el.style.colorScheme = relLuminance(bg) < 0.5 ? "dark" : "light";
        }
        catch (_) { }
    });
}
// A filled button whose fill is close to the surface behind it reads as plain
// text, however readable its label is. Repainting the label fixed half of that
// and left the other half: on a theme whose accent is near the panel colour,
// Save was legible and had no edge, so nothing said it was a button.
//
// The threshold is deliberately low. Plenty of themes use a quiet accent on
// purpose and still read fine; this is only meant to catch a fill that has all
// but vanished. The border is already there at one pixel and transparent, so
// colouring it costs no layout.
const MIN_EDGE = 1.45;
function fixEdge(el, min) {
    try {
        if (!el || typeof getComputedStyle !== "function")
            return;
        const fill = paintedBg(el);
        if (!fill)
            return;
        const behind = backdropOf(el.parentElement || el);
        if (contrastRatio(blendColor(fill, behind), behind) >= (typeof min === "number" ? min : MIN_EDGE))
            return;
        const light = [255, 255, 255, 1];
        const dark = [20, 18, 26, 1];
        // Judged against the surface behind the button, since that is what the
        // edge has to separate it from.
        el.style.borderColor =
            contrastRatio(light, behind) >= contrastRatio(dark, behind) ? NEAR_WHITE : NEAR_BLACK;
    }
    catch (_) { }
}
function ensureEdge(el, min) {
    afterPaint(() => fixEdge(el, min));
}
function ensureReadable(el, min) {
    afterPaint(() => fixContrast(el, min));
}
// True when the element paints text of its own, rather than only holding other
// elements that do. Form controls carry their value instead of a text child.
function paintsText(el) {
    const tag = String((el && el.tagName) || "").toUpperCase();
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || tag === "BUTTON")
        return true;
    const kids = (el && el.childNodes) || [];
    for (let i = 0; i < kids.length; i++) {
        const n = kids[i];
        if (n && n.nodeType === 3 && String(n.nodeValue || "").trim())
            return true;
    }
    // An element that has been given a colour of its own but is empty right now
    // is a status line waiting for something to say. The sweep runs once, while
    // they are all still empty, so on the old rule it walked past every one of
    // them and they were never checked against the surface they sit on. The
    // colour does not change when the text arrives, so checking it now is the
    // same answer, arrived at before anyone has to read it.
    try {
        if (el && el.style && String(el.style.color || ""))
            return true;
    }
    catch (_) { }
    return false;
}
// One sweep over everything a panel painted, once per build. Secondary text
// (hints, section headers) is meant to sit quieter than the main text, so it is
// held to a lower floor and only rescued when it has all but disappeared.
function ensureReadableTree(root, min) {
    afterPaint(() => {
        try {
            if (!root || !root.querySelectorAll)
                return;
            const all = [root].concat(Array.prototype.slice.call(root.querySelectorAll("*")));
            for (const el of all)
                if (paintsText(el))
                    fixContrast(el, min);
        }
        catch (_) { }
    });
}
// Long enough that a normal tap never reaches it, short enough that holding
// the button does not feel broken.
const HOLD_MS = 500;
// True when the device has been asked to keep movement down. Read at the point
// of use rather than once at load, so turning the setting on takes effect
// without reloading the page.
function stillness() {
    try {
        return (typeof matchMedia === "function" &&
            matchMedia("(prefers-reduced-motion: reduce)").matches);
    }
    catch (_) {
        return false;
    }
}
// The extension's mark: a die caught mid-tumble. Lumiverse calls a fresh
// attempt a reroll, so this says what the extension does rather than reusing
// the refresh arrow every other extension already draws. Strokes are
// currentColor so the mark follows the theme, and so fixContrast can repaint it
// by setting colour on the element around it.
const DIE_BODY = '<g transform="rotate(14 12 12)">' +
    '<rect x="4" y="4" width="16" height="16" rx="5"/>' +
    '<circle cx="8.8" cy="8.8" r="1.6" fill="currentColor" stroke="none"/>' +
    '<circle cx="15.2" cy="15.2" r="1.6" fill="currentColor" stroke="none"/>' +
    "</g>";
const DIE_SLASH = '<line x1="4" y1="20" x2="20" y2="4"/>';
// size is passed only for the float widget, which owns its own element. The
// Extras menu sizes the icon it is handed.
function dieSvg(off, size) {
    return ('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"' +
        ' stroke-linecap="round" stroke-linejoin="round"' +
        (size ? ' width="' + size + '" height="' + size + '"' : "") +
        ">" +
        DIE_BODY +
        (off ? DIE_SLASH : "") +
        "</svg>");
}
export function setup(ctx, opts) {
    // cfg is mutable so the settings modal can change it live. Order: code
    // defaults, then GitHub opts, then whatever the user saved in the UI.
    const cfg = Object.assign({}, CONFIG, opts || {}, loadSaved());
    // Persist the whole settings object to account storage (through the backend) so
    // settings follow the user across browsers. The backend also derives its
    // find-and-replace state from this. Safe to call with no backend bridge.
    function saveToAccount() {
        try {
            if (ctx && typeof ctx.sendToBackend === "function") {
                const out = {};
                for (const g of SCHEMA)
                    for (const f of g.fields)
                        out[f.key] = cfg[f.key];
                ctx.sendToBackend({ type: "save_settings", settings: out });
            }
        }
        catch (_) { }
    }
    // Pull account-synced settings on load. localStorage is a fast local cache and
    // offline fallback; the account copy wins when present. If the account has
    // nothing yet but this browser does, migrate this browser's settings up.
    function loadFromAccount() {
        try {
            if (!ctx || typeof ctx.sendToBackend !== "function" || typeof ctx.onBackendMessage !== "function")
                return;
            const reqId = "ar-load-" + Date.now() + "-" + Math.random().toString(36).slice(2);
            const off = ctx.onBackendMessage((msg) => {
                if (!msg || msg.type !== "loaded_settings" || msg.requestId !== reqId)
                    return;
                try {
                    off && off();
                }
                catch (_) { }
                const s = msg.settings;
                if (s && typeof s === "object" && Object.keys(s).length) {
                    Object.assign(cfg, coerceSaved(s));
                    saveSaved();
                    syncLiveLog();
                    syncFloat();
                    if (modalHandle && modalRoot) {
                        if (modalSnapshot)
                            modalSnapshot();
                        buildSettingsBody(modalRoot, modalSnapshot);
                    }
                    log("settings loaded from account");
                }
                else {
                    try {
                        if (typeof localStorage !== "undefined" && localStorage.getItem(STORE_KEY)) {
                            saveToAccount();
                            log("settings migrated to account");
                        }
                    }
                    catch (_) { }
                }
            });
            disposers.push(() => { try {
                off && off();
            }
            catch (_) { } });
            ctx.sendToBackend({ type: "load_settings", requestId: reqId });
        }
        catch (_) { }
    }
    let lastChatId = null;
    let lastMessageId = null;
    let replaceAction = null;
    let replaceActionOff = null;
    let replaceAllAction = null;
    let replaceAllActionOff = null;
    let toggleAction = null;
    let toggleActionOff = null;
    // Manual "swap words now": an optional Extras-menu button that applies the word
    // swaps to the latest reply on demand, instead of only automatically on finish.
    // Optional consent dialog before any edit, for people who don't want surprises.
    // Returns true to proceed. If the host has no confirm dialog, proceeds.
    async function confirmEdit(message) {
        try {
            if (ctx && ctx.ui && typeof ctx.ui.showConfirm === "function") {
                const r = await ctx.ui.showConfirm({ title: "Apply word swaps?", message: message, confirmLabel: "Swap", cancelLabel: "Cancel" });
                return !!(r && r.confirmed);
            }
        }
        catch (_) { }
        return true;
    }
    async function applyReplaceNow() {
        try {
            if (!ctx || typeof ctx.sendToBackend !== "function") {
                showToast("Find and replace needs the backend, which this host does not offer.");
                return;
            }
            if (cfg.confirmBeforeEdit) {
                if (!(await confirmEdit("Apply your word swaps to the latest reply?")))
                    return;
            }
            ctx.sendToBackend({ type: "apply_replace_now", chatId: lastChatId, messageId: lastMessageId, requestId: "ar-rep-" + Date.now() });
        }
        catch (_) { }
    }
    // Swap every generated reply in the current chat, once, on request.
    async function applyReplaceAllNow() {
        try {
            if (!ctx || typeof ctx.sendToBackend !== "function") {
                showToast("Find and replace needs the backend, which this host does not offer.");
                return;
            }
            if (cfg.confirmBeforeEdit) {
                if (!(await confirmEdit("Apply your word swaps to every reply in this chat?")))
                    return;
            }
            ctx.sendToBackend({ type: "apply_replace_now", chatId: lastChatId, wholeChat: true, requestId: "ar-rep-all-" + Date.now() });
        }
        catch (_) { }
    }
    // The Extras-menu on/off entry. Its label and icon carry the current state,
    // and the host offers no way to relabel an action once it is registered, so a
    // state change registers it again rather than editing it in place.
    const TOGGLE_ICON_ON = dieSvg(false);
    const TOGGLE_ICON_OFF = dieSvg(true);
    // The state the registered entry was last labelled for, so it is only rebuilt
    // when the label would actually change.
    let toggleActionState = null;
    function dropToggleAction() {
        if (!toggleAction)
            return;
        try {
            toggleActionOff && toggleActionOff();
        }
        catch (_) { }
        try {
            toggleAction.destroy();
        }
        catch (_) { }
        toggleAction = null;
        toggleActionOff = null;
        toggleActionState = null;
    }
    function syncToggleAction() {
        try {
            const canReg = !!(ctx && ctx.ui && typeof ctx.ui.registerInputBarAction === "function");
            const on = cfg.enabled !== false;
            if (!cfg.showExtrasToggle || !canReg) {
                dropToggleAction();
                return;
            }
            if (toggleAction && toggleActionState === on)
                return;
            dropToggleAction();
            toggleAction = ctx.ui.registerInputBarAction({
                id: "auto-retry-toggle",
                label: on ? "Auto Retry is on, turn it off" : "Auto Retry is off, turn it on",
                iconSvg: on ? TOGGLE_ICON_ON : TOGGLE_ICON_OFF,
            });
            toggleActionState = on;
            toggleActionOff = toggleAction.onClick(() => {
                // Flipping the switch relabels this very entry, which means destroying
                // it and registering it again. Doing that from inside its own click
                // handler would pull the entry out from under the host mid-dispatch, so
                // it waits for the handler to return first.
                setTimeout(() => toggleEnabled(), 0);
            });
        }
        catch (_) { }
    }
    // Add or remove the Extras-menu buttons to match their toggles. Called on load
    // and whenever settings are saved, so flipping a toggle takes effect at once.
    function syncInputBarActions() {
        syncToggleAction();
        try {
            const canReg = !!(ctx && ctx.ui && typeof ctx.ui.registerInputBarAction === "function");
            if (cfg.showReplaceButton && canReg && !replaceAction) {
                replaceAction = ctx.ui.registerInputBarAction({
                    id: "auto-retry-replace-now",
                    label: "Swap words in the last reply",
                    iconSvg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
                });
                replaceActionOff = replaceAction.onClick(() => applyReplaceNow());
            }
            else if ((!cfg.showReplaceButton || !canReg) && replaceAction) {
                try {
                    replaceActionOff && replaceActionOff();
                }
                catch (_) { }
                try {
                    replaceAction.destroy();
                }
                catch (_) { }
                replaceAction = null;
                replaceActionOff = null;
            }
            if (cfg.showSwapAllButton && canReg && !replaceAllAction) {
                replaceAllAction = ctx.ui.registerInputBarAction({
                    id: "auto-retry-replace-all",
                    label: "Swap words in every reply",
                    iconSvg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/><line x1="12" y1="7" x2="12" y2="17"/></svg>',
                });
                replaceAllActionOff = replaceAllAction.onClick(() => applyReplaceAllNow());
            }
            else if ((!cfg.showSwapAllButton || !canReg) && replaceAllAction) {
                try {
                    replaceAllActionOff && replaceAllActionOff();
                }
                catch (_) { }
                try {
                    replaceAllAction.destroy();
                }
                catch (_) { }
                replaceAllAction = null;
                replaceAllActionOff = null;
            }
        }
        catch (_) { }
    }
    // A short in-memory ring buffer of what the extension did, captured whether or
    // not console logging is on, so the Copy debug info report carries a timeline
    // and the user never has to open dev tools to report a behavioural bug.
    const EVENTLOG_MAX = 20;
    const eventLog = [];
    let liveLogEl = null;
    let liveLogBody = null;
    function recordEvent(args) {
        try {
            const parts = args.map((a) => {
                if (typeof a === "string")
                    return a;
                try {
                    return JSON.stringify(a);
                }
                catch (_) {
                    return String(a);
                }
            });
            let line = new Date().toISOString().slice(11, 23) + " " + parts.join(" ");
            if (line.length > 220)
                line = line.slice(0, 217) + "...";
            eventLog.push(line);
            if (eventLog.length > EVENTLOG_MAX)
                eventLog.shift();
            if (liveLogBody)
                renderLiveLog();
        }
        catch (_) { }
    }
    const log = (...a) => {
        recordEvent(a);
    };
    // Optional on-screen log. A small fixed panel that shows recent activity live,
    // so someone can watch what the extension is doing without opening dev tools,
    // which matters most on mobile. Driven by the liveLog setting.
    function renderLiveLog() {
        if (!liveLogBody)
            return;
        liveLogBody.textContent = eventLog.length
            ? eventLog.join("\n")
            : "(nothing yet)";
        liveLogBody.scrollTop = liveLogBody.scrollHeight;
    }
    function showLiveLog() {
        if (liveLogEl || typeof document === "undefined")
            return;
        const el = document.createElement("div");
        el.style.cssText =
            "position:fixed;right:8px;bottom:8px;z-index:2147483000;width:min(340px,92vw);height:min(300px,50vh);min-width:200px;min-height:120px;max-width:96vw;max-height:85vh;display:flex;flex-direction:column;background-color:var(--lumiverse-card-bg-solid,rgb(24,20,34));background-image:linear-gradient(var(--lumiverse-bg-elevated,rgba(35,30,48,.9)),var(--lumiverse-bg-elevated,rgba(35,30,48,.9)));border:1px solid var(--lumiverse-border,rgba(255,255,255,.14));border-radius:var(--lumiverse-radius-md,10px);box-shadow:var(--lumiverse-shadow-md,0 8px 24px rgba(0,0,0,.4));font-family:var(--lumiverse-font-family,system-ui);font-size:13px;color:var(--lumiverse-text,#e9e4f0);overflow:hidden";
        const head = document.createElement("div");
        head.style.cssText =
            "display:flex;align-items:center;gap:8px;padding:7px 9px;border-bottom:1px solid var(--lumiverse-border,rgba(255,255,255,.12));font-weight:600;cursor:move;user-select:none;touch-action:none";
        const title = document.createElement("span");
        title.textContent = "Auto Retry log";
        title.style.cssText = "flex:1;min-width:0";
        head.appendChild(title);
        // The panel exists because the console is out of reach on a phone, which is
        // also where selecting text by hand is worst, so the log needs its own way
        // out. Clear keeps a long session's timeline readable.
        const tinyBtn = (label) => {
            const b = btn(label, false);
            b.style.cssText +=
                "min-height:0;padding:3px 9px;font-size:11px;flex:none;cursor:pointer";
            return b;
        };
        const copyBtn = tinyBtn("Copy");
        copyBtn.addEventListener("click", async () => {
            const before = copyBtn.textContent;
            const ok = await copyText(eventLog.join("\n"));
            copyBtn.textContent = ok ? "Copied" : "Can't";
            setTimeout(() => {
                copyBtn.textContent = before;
            }, 1400);
        });
        const clearBtn = tinyBtn("Clear");
        clearBtn.addEventListener("click", () => {
            eventLog.length = 0;
            renderLiveLog();
        });
        head.appendChild(copyBtn);
        head.appendChild(clearBtn);
        const bodyEl = document.createElement("div");
        bodyEl.style.cssText =
            "flex:1;padding:7px 9px;overflow:auto;white-space:pre-wrap;line-height:1.4;font-family:var(--lumiverse-font-mono,ui-monospace,monospace) !important";
        el.appendChild(head);
        el.appendChild(bodyEl);
        // Drag by the header. Pointer events cover mouse and touch; the header
        // captures the pointer so a fast drag outside it still tracks, and the panel
        // is kept inside the viewport.
        let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
        const onDown = (e) => {
            // A press on one of the header's own buttons belongs to that button.
            // Without this the drag captures the pointer out from under it.
            try {
                if (e && e.target && e.target.closest && e.target.closest("button"))
                    return;
            }
            catch (_) { }
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
            }
            catch (_) { }
            e.preventDefault();
        };
        // Moved with a transform while dragging rather than by rewriting left and
        // top. Changing left/top makes the browser redo layout on every pointer
        // event, which on a phone cannot keep up with a finger and looks like the
        // panel jumping. A transform is handled by the compositor, so it tracks the
        // finger, and the offset is folded back into left/top once on release.
        let mx = 0, my = 0, frame = null;
        const paintDrag = () => {
            frame = null;
            el.style.transform = "translate3d(" + mx + "px," + my + "px,0)";
        };
        const onMove = (e) => {
            if (!dragging)
                return;
            const w = el.offsetWidth || 0, h = el.offsetHeight || 0;
            const vw = (typeof window !== "undefined" && window.innerWidth) || 360;
            const vh = (typeof window !== "undefined" && window.innerHeight) || 640;
            // Clamped as an offset, so the panel cannot be dragged off the screen.
            mx = Math.max(-ox, Math.min(e.clientX - sx, vw - w - ox));
            my = Math.max(-oy, Math.min(e.clientY - sy, vh - h - oy));
            // One paint per frame at most, however fast the pointer events arrive.
            if (!frame)
                frame = requestAnimationFrame(paintDrag);
        };
        const onUp = (e) => {
            if (dragging) {
                dragging = false;
                try {
                    head.releasePointerCapture(e.pointerId);
                }
                catch (_) { }
                if (frame) {
                    cancelAnimationFrame(frame);
                    frame = null;
                }
                el.style.transform = "none";
                el.style.left = ox + mx + "px";
                el.style.top = oy + my + "px";
                mx = 0;
                my = 0;
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
        let rz = false, rsx = 0, rsy = 0, rw = 0, rh = 0, pendW = 0, pendH = 0, rzFrame = null;
        const paintResize = () => {
            rzFrame = null;
            el.style.width = pendW + "px";
            el.style.height = pendH + "px";
        };
        const rzDown = (e) => {
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
            }
            catch (_) { }
            e.preventDefault();
        };
        const rzMove = (e) => {
            if (!rz)
                return;
            let nw = rw + (e.clientX - rsx), nh = rh + (e.clientY - rsy);
            nw = Math.max(200, Math.min(nw, window.innerWidth - 16));
            nh = Math.max(120, Math.min(nh, window.innerHeight - 16));
            // Resizing has to change layout, so a transform cannot help here the way
            // it does for dragging. Batching to one change per frame still keeps it
            // from thrashing when pointer events arrive faster than the screen redraws.
            pendW = nw;
            pendH = nh;
            if (!rzFrame)
                rzFrame = requestAnimationFrame(paintResize);
        };
        const rzUp = (e) => {
            if (rz) {
                rz = false;
                if (rzFrame) {
                    cancelAnimationFrame(rzFrame);
                    rzFrame = null;
                    paintResize();
                }
                try {
                    grip.releasePointerCapture(e.pointerId);
                }
                catch (_) { }
            }
        };
        grip.addEventListener("pointerdown", rzDown);
        grip.addEventListener("pointermove", rzMove);
        grip.addEventListener("pointerup", rzUp);
        grip.addEventListener("pointercancel", rzUp);
        try {
            document.body.appendChild(el);
        }
        catch (_) {
            return;
        }
        liveLogEl = el;
        liveLogBody = bodyEl;
        renderLiveLog();
        ensureReadableTree(el);
    }
    function hideLiveLog() {
        if (liveLogEl && liveLogEl.parentNode) {
            try {
                liveLogEl.parentNode.removeChild(liveLogEl);
            }
            catch (_) { }
        }
        liveLogEl = null;
        liveLogBody = null;
    }
    // A small round button that floats over the chat and turns the extension on or
    // off in one tap. The host owns the placement: ctx.ui.createFloatWidget gives
    // it dragging, edge snapping, remembered position, and the right-click hide and
    // reset-position options users get on any float widget. That is why this is not
    // a hand-rolled fixed-position element with its own pointer handling.
    let floatWidget = null;
    let floatMenu = null;
    // Reassigned each time the button is rebuilt; the document listener below
    // calls through this so only one listener is ever registered.
    let holdMoveWatch = null;
    let floatEl = null;
    let floatWidgetSize = 0;
    function floatSize() {
        const v = Math.floor(Number(cfg.floatingToggleSize));
        return Number.isFinite(v) && v >= 28 ? Math.min(v, 96) : 44;
    }
    const vpW = () => (typeof window !== "undefined" && window.innerWidth) || 360;
    const vpH = () => (typeof window !== "undefined" && window.innerHeight) || 640;
    function paintFloat() {
        if (!floatEl)
            return;
        const on = cfg.enabled !== false;
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
        floatEl.innerHTML = dieSvg(!on, glyph);
        const label = on
            ? "Auto Retry is on, tap to turn off"
            : "Auto Retry is off, tap to turn on";
        floatEl.title = label;
        floatEl.setAttribute("aria-label", label);
        floatEl.setAttribute("aria-pressed", on ? "true" : "false");
        // The tinted fill and the symbol on it both come from the theme's accent, so
        // on some themes they land close enough together to read as an empty circle.
        ensureReadable(floatEl);
    }
    function showFloat() {
        if (floatWidget || typeof document === "undefined")
            return;
        const d = floatSize();
        try {
            floatWidget = ctx.ui.createFloatWidget({
                width: d,
                height: d,
                // Bottom right, clear of the input bar, matching where other extensions
                // put theirs. The host remembers wherever the user drags it after that.
                initialPosition: { x: Math.max(16, vpW() - 72), y: Math.max(16, vpH() - 160) },
                snapToEdge: true,
                tooltip: "Toggle Auto Retry",
                chromeless: true,
            });
        }
        catch (_) {
            // Float widgets need the ui_panels permission. Without it the extension
            // still works; there is just no floating button.
            floatWidget = null;
            log("host would not create a float widget; is ui_panels granted?");
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
                "box-shadow:var(--lumiverse-shadow-sm,0 2px 8px rgba(0,0,0,.2));" +
                // Only colour and scale are animated. Position is the host's business, and
                // a transition on transform would fight its dragging.
                "transition:background var(--lumiverse-transition-fast,150ms ease)," +
                "border-color var(--lumiverse-transition-fast,150ms ease)," +
                "color var(--lumiverse-transition-fast,150ms ease)," +
                "opacity var(--lumiverse-transition-fast,150ms ease)" +
                (stillness() ? "" : ",transform 120ms ease");
        el.addEventListener("pointerdown", () => {
            // The press dip is the one thing here that actually moves. Someone who
            // has asked their device for less movement still gets the colour change,
            // so the button is no less responsive, it just does not spring.
            if (!stillness())
                el.style.transform = "scale(.94)";
        });
        const springBack = () => {
            el.style.transform = "none";
        };
        // A press held down opens the menu instead of toggling. Right-click does the
        // same on a pointer device. Without this the only way to put the button away
        // was to open settings and turn it off, which is a long walk for something
        // that is in your way right now.
        let pressTimer = null;
        let pressFrom = null;
        let openedByHold = false;
        const dropPress = () => {
            if (pressTimer) {
                clearTimeout(pressTimer);
                pressTimer = null;
            }
            pressFrom = null;
        };
        el.addEventListener("pointerdown", (e) => {
            openedByHold = false;
            pressFrom = { x: e && e.clientX, y: e && e.clientY };
            pressTimer = setTimeout(() => {
                pressTimer = null;
                openedByHold = true;
                springBack();
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
        holdMoveWatch = (e) => {
            if (!pressFrom || !e)
                return;
            if (Math.abs(e.clientX - pressFrom.x) > 8 || Math.abs(e.clientY - pressFrom.y) > 8)
                dropPress();
        };
        // Android raises this on a long press too, so it can arrive alongside the
        // timer above. showFloatMenu closes any open menu first, so a second call
        // reopens rather than stacking.
        el.addEventListener("contextmenu", (e) => {
            try {
                e.preventDefault();
            }
            catch (_) { }
            dropPress();
            springBack();
            showFloatMenu();
        });
        const endPress = () => {
            dropPress();
            springBack();
        };
        el.addEventListener("pointerup", endPress);
        el.addEventListener("pointercancel", endPress);
        el.addEventListener("pointerleave", endPress);
        el.addEventListener("click", () => {
            springBack();
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
        }
        catch (_) {
            try {
                floatWidget.root.innerHTML = "";
                floatWidget.root.appendChild(el);
            }
            catch (__) { }
        }
        floatEl = el;
        paintFloat();
    }
    function hideFloatMenu() {
        if (floatMenu) {
            try {
                floatMenu.remove();
            }
            catch (_) { }
        }
        floatMenu = null;
    }
    // The menu behind a hold or a right-click on the floating button. Two entries,
    // both about the button itself rather than about retrying, so nothing here can
    // change what the extension does to a reply.
    function showFloatMenu() {
        hideFloatMenu();
        if (typeof document === "undefined" || !floatEl || !floatEl.getBoundingClientRect)
            return;
        const el = document.createElement("div");
        el.setAttribute("role", "menu");
        el.style.cssText =
            "position:fixed;z-index:2147483647;box-sizing:border-box;padding:4px;" +
                "border-radius:var(--lumiverse-radius-md,10px);min-width:180px;" +
                // Opaque for the same reason the hint is: it lands over the chat, and the
                // elevated colour alone is see-through enough to read words underneath it.
                "background-color:var(--lumiverse-card-bg-solid,rgb(24,20,34));" +
                "background-image:linear-gradient(var(--lumiverse-bg-elevated,rgba(35,30,48,.98))," +
                "var(--lumiverse-bg-elevated,rgba(35,30,48,.98)));" +
                "border:1px solid var(--lumiverse-border,rgba(255,255,255,.16));" +
                "box-shadow:var(--lumiverse-shadow-md,0 8px 24px rgba(0,0,0,.4));" +
                "color:var(--lumiverse-text,#eee);font:13px/1.4 var(--lumiverse-font-family,system-ui);" +
                "left:0;top:-9999px";
        const entry = (label, run) => {
            const b = document.createElement("button");
            b.type = "button";
            b.setAttribute("role", "menuitem");
            b.textContent = label;
            b.style.cssText =
                "display:block;width:100%;box-sizing:border-box;text-align:left;cursor:pointer;" +
                    "padding:9px 10px;border:0;border-radius:var(--lumiverse-radius-sm,5px);" +
                    // The browser's own focus ring is drawn from its colour scheme, which
                    // on this menu is a hard white rectangle. Replaced below with a ring in
                    // the theme's accent, so keyboard focus is still plain to see.
                    "outline:none;background:transparent;color:inherit;font:inherit";
            const lit = (on) => {
                b.style.background = on
                    ? "var(--lumiverse-secondary-hover,rgba(128,128,128,.25))"
                    : "transparent";
            };
            const ring = (on) => {
                b.style.boxShadow = on
                    ? "inset 0 0 0 2px var(--lumiverse-primary-050,rgba(147,112,219,.5))"
                    : "none";
            };
            b.addEventListener("mouseenter", () => lit(true));
            b.addEventListener("mouseleave", () => lit(false));
            b.addEventListener("focus", () => {
                lit(true);
                ring(true);
            });
            b.addEventListener("blur", () => {
                lit(false);
                ring(false);
            });
            b.addEventListener("click", () => {
                hideFloatMenu();
                run();
            });
            el.appendChild(b);
            return b;
        };
        // Rebuilding the widget is what puts it back, since where it sits belongs to
        // the host and a fresh one starts at the position it is handed.
        const first = entry("Move back to the corner", () => {
            hideFloat();
            showFloat();
        });
        entry("Hide this button", () => {
            cfg.showFloatingToggle = false;
            saveSaved();
            hideFloat();
            // Without this it looks like the button broke. Say where it went.
            showToast("Floating button hidden. Turn it back on in Auto Retry settings.", {
                force: true,
            });
        });
        (document.body || document.documentElement).appendChild(el);
        // Beside the button, nudged back on screen. The button snaps to whichever
        // edge is nearest, so the menu has to be able to sit on either side of it
        // and above it as well as below.
        const vw = vpW();
        const vh = vpH();
        const r = floatEl.getBoundingClientRect();
        const box = el.getBoundingClientRect();
        const w = box.width || el.offsetWidth || 0;
        const h = box.height || el.offsetHeight || 0;
        const GAP = 8;
        const left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, vw - w - 8));
        let top = r.bottom + GAP;
        if (top + h > vh - 8) {
            const above = r.top - h - GAP;
            top = above >= 8 ? above : Math.max(8, vh - h - 8);
        }
        // Same correction the hint popover needs: under a host that applies its UI
        // Scale as a zoom, a fixed element does not land where it was told to. Put
        // it down, measure where it went, and close the gap.
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
        floatMenu = el;
        ensureReadableTree(el, 2.6);
        try {
            first.focus({ preventScroll: true });
        }
        catch (_) { }
    }
    function hideFloat() {
        hideFloatMenu();
        // Take back what we put in before handing the widget over. Destroying it is
        // the host's job and normally takes the button with it, but if that throws
        // or does nothing the button would sit there with no code behind it, still
        // accepting taps.
        if (floatEl) {
            try {
                floatEl.remove();
            }
            catch (_) { }
        }
        if (floatWidget) {
            try {
                floatWidget.destroy();
            }
            catch (_) { }
        }
        floatWidget = null;
        floatEl = null;
        floatWidgetSize = 0;
        // The document-level pointermove listener calls through this. Left set, it
        // kept a whole button's worth of handlers alive after the button was gone,
        // and every pointer move on the page went on running its hold check.
        holdMoveWatch = null;
    }
    function syncFloat() {
        if (!cfg.showFloatingToggle) {
            hideFloat();
            return;
        }
        // Width and height are set when the widget is created, so a size change
        // means building it again rather than restyling it.
        if (floatWidget && floatWidgetSize !== floatSize())
            hideFloat();
        showFloat();
        paintFloat();
    }
    // The one place the switch is flipped, so the floating button, the Extras
    // entry and the settings panel can never disagree about the state.
    function toggleEnabled() {
        cfg.enabled = cfg.enabled === false;
        saveSaved();
        // The settings panel can be open while this is flipped from somewhere else.
        // Its own checkbox and the "Auto Retry is off" line are brought into line,
        // and so is the baseline the panel restores on dismiss, or closing the panel
        // would put the switch straight back where it was.
        if (modalBaseline)
            modalBaseline.enabled = cfg.enabled;
        try {
            if (fieldSetters.enabled)
                fieldSetters.enabled(cfg.enabled);
            applyDeps();
        }
        catch (_) { }
        if (cfg.enabled === false) {
            chats.forEach((_s, id) => standDown(id, false));
        }
        showToast(cfg.enabled === false ? "Auto Retry is off." : "Auto Retry is on.", {
            force: true,
        });
        paintFloat();
        syncInputBarActions();
    }
    function syncLiveLog() {
        if (cfg.liveLog)
            showLiveLog();
        else
            hideLiveLog();
    }
    const disposers = [];
    // Coerce a raw saved object (local cache or account storage) into a clean
    // partial config: keep only known fields, run each through its type.
    function coerceSaved(parsed) {
        const out = {};
        if (!parsed || typeof parsed !== "object")
            return out;
        // 4.2.0 held one note in two keys. Anyone who set it on the testing branch
        // keeps it rather than finding the box empty after updating.
        if (!parsed.refusalNotes && parsed.refusalNoteText != null) {
            const text = String(parsed.refusalNoteText || "");
            if (text.trim())
                parsed = Object.assign({}, parsed, {
                    refusalNotes: [{ text: text, role: String(parsed.refusalNoteRole || "system") }],
                });
        }
        for (const g of SCHEMA)
            for (const f of g.fields) {
                if (!(f.key in parsed))
                    continue;
                // The field itself goes through, not just its type. A "pick" is checked
                // against the values it is allowed to hold, and those live on the field,
                // so without it every saved choice failed that check and fell back to
                // the first option: "Where the note goes" read back as "after" however
                // it had been set, on every load, in every browser.
                out[f.key] =
                    f.type === "num"
                        ? clampField(f, parsed[f.key])
                        : coerce(f.type, parsed[f.key], CONFIG[f.key], f);
            }
        return out;
    }
    function loadSaved() {
        try {
            if (typeof localStorage === "undefined")
                return {};
            const raw = localStorage.getItem(STORE_KEY);
            if (!raw)
                return {};
            return coerceSaved(JSON.parse(raw));
        }
        catch (_) {
            return {};
        }
    }
    function saveSaved() {
        try {
            if (typeof localStorage === "undefined")
                return;
            const out = {};
            for (const g of SCHEMA)
                for (const f of g.fields)
                    out[f.key] = cfg[f.key];
            localStorage.setItem(STORE_KEY, JSON.stringify(out));
        }
        catch (_) { }
    }
    function coerce(type, val, fallback, f) {
        if (type === "bool")
            return !!val;
        if (type === "num") {
            const n = Number(val);
            return Number.isFinite(n) ? n : fallback;
        }
        if (type === "notes") {
            const list = Array.isArray(val) ? val : [];
            const out = [];
            for (const item of list.slice(0, MAX_NOTES)) {
                const text = item && item.text != null ? String(item.text) : "";
                const role = item && NOTE_ROLES.indexOf(String(item.role)) >= 0 ? String(item.role) : "system";
                out.push({ text: text, role: role });
            }
            return out.length ? out : [{ text: "", role: "system" }];
        }
        if (type === "pick") {
            const want = val == null ? "" : String(val);
            const opts = (f && f.options) || [];
            for (const o of opts)
                if (o.value === want)
                    return want;
            return opts.length ? opts[0].value : fallback;
        }
        return val == null ? fallback : String(val);
    }
    // Turn whatever is in a number box into a safe value: a blank or non-numeric
    // box falls back to that field's default, then the result is clamped to the
    // field's range and rounded if it's a whole-number field. Stops an empty or
    // silly box from poisoning the retry maths.
    function clampField(f, raw) {
        const s = (raw == null ? "" : String(raw)).trim();
        let n = s === "" ? CONFIG[f.key] : Number(s);
        if (!Number.isFinite(n))
            n = CONFIG[f.key];
        if (typeof f.min === "number")
            n = Math.max(f.min, n);
        if (typeof f.max === "number")
            n = Math.min(f.max, n);
        if (f.int)
            n = Math.round(n);
        return n;
    }
    // ---- import / export ----
    // Settings are just values. These group them so a user can share or back up
    // only the parts they want. Import runs every value back through the same
    // coerce/clamp as saved settings, so an imported file can only set known keys to
    // safe values; anything unrecognised is ignored.
    const EXPORT_CATEGORIES = [
        {
            id: "retry",
            label: "Retry behavior",
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
            label: "Refusal detection",
            keys: [
                "retryOnRefusal",
                "refusalUseBuiltins",
                "refusalCatchDisengage",
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
                "refusalNoteFromTry",
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
                "confirmButtonLabels",
            ],
        },
        { id: "notifications", label: "On-screen", keys: ["toast", "liveLog"] },
        // Special entry: carried outside cfg. buildExport and the import handler
        // treat it as the saved word-swap presets, not settings keys.
        { id: "presets", label: "Word swap presets", keys: [] },
    ];
    const fieldByKey = {};
    for (const g of SCHEMA)
        for (const f of g.fields)
            fieldByKey[f.key] = f;
    // Safety net for the lists above. A setting added to SCHEMA but forgotten in
    // EXPORT_CATEGORIES used to be silently dropped from every export and backup,
    // which is invisible until someone restores a file and finds a setting missing.
    // Anything unaccounted for is folded into the retry category rather than lost.
    {
        const covered = new Set();
        for (const c of EXPORT_CATEGORIES)
            for (const k of c.keys)
                covered.add(k);
        const orphans = Object.keys(fieldByKey).filter((k) => !covered.has(k));
        if (orphans.length) {
            for (const c of EXPORT_CATEGORIES)
                if (c.id === "retry")
                    c.keys = c.keys.concat(orphans);
        }
    }
    // Per-field functions that push a cfg value back into the on-screen control,
    // so applying a preset can update the visible fields in place without a full
    // rebuild (which would jump the scroll and close open sections). Repopulated
    // each time the settings body is built.
    let fieldSetters = {};
    // Reapplies the rows that only matter while some switch is on. Held out here
    // beside fieldSetters because the controls that move those switches are built
    // by buildRow, which is its own function. Does nothing until a panel is built.
    let applyDeps = () => { };
    // Rebuild-free refreshers for the preset dropdowns, so an import that adds
    // presets can update them without rebuilding the panel.
    let presetBarRefreshers = [];
    // Titles of collapsible sections the user has opened, kept so a rebuild
    // (import) doesn't collapse everything back.
    const openGroups = new Set();
    function coerceKey(key, val) {
        const f = fieldByKey[key];
        if (!f)
            return undefined;
        return f.type === "num"
            ? clampField(f, val)
            : coerce(f.type, val, CONFIG[key], f);
    }
    function buildExport(catIds) {
        const settings = {};
        let presetsOut = null;
        for (const c of EXPORT_CATEGORIES) {
            if (catIds.indexOf(c.id) < 0)
                continue;
            if (c.id === "presets") {
                presetsOut = loadPresets();
                continue;
            }
            const bucket = {};
            for (const k of c.keys)
                bucket[k] = cfg[k];
            settings[c.id] = bucket;
        }
        const out = { autoRetry: VERSION, settings: settings };
        if (presetsOut)
            out.presets = presetsOut;
        return JSON.stringify(out, null, 2);
    }
    // Apply an imported blob, only the chosen categories actually present. Returns
    // the labels applied, or null if the text was not a valid export.
    function applyImport(text, catIds) {
        let data;
        try {
            data = JSON.parse(text);
        }
        catch (_) {
            return null;
        }
        if (!data ||
            typeof data !== "object" ||
            !data.settings ||
            typeof data.settings !== "object")
            return null;
        const applied = [];
        for (const c of EXPORT_CATEGORIES) {
            if (catIds.indexOf(c.id) < 0)
                continue;
            const bucket = data.settings[c.id];
            if (!bucket || typeof bucket !== "object")
                continue;
            let touched = false;
            for (const k of c.keys) {
                if (!(k in bucket))
                    continue;
                const v = coerceKey(k, bucket[k]);
                if (v !== undefined) {
                    cfg[k] = v;
                    touched = true;
                }
            }
            if (touched)
                applied.push(c.label);
        }
        return applied;
    }
    // ---- presets ----
    // Named word-swap snapshots the user can switch between, stored per browser.
    const PRESETS_KEY = "lv-auto-retry:presets:v1";
    const PRESET_KINDS = {
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
                "confirmBeforeEdit",
                "swapWaitForEdits",
                "swapWaitSecs",
            ],
        },
    };
    // Derived from the export category so the two stay in step, minus whatever
    // that kind omits. Load walks this list rather than the stored values, so a
    // preset saved before an omission ignores the extra keys.
    function keysForKind(kind) {
        const k = PRESET_KINDS[kind];
        if (!k)
            return [];
        const omit = k.omit || [];
        for (const c of EXPORT_CATEGORIES)
            if (c.id === k.catId)
                return c.keys.filter((key) => omit.indexOf(key) < 0);
        return [];
    }
    // Keep only what a preset is allowed to be, whatever the source. The same
    // check runs on the local copy and on anything the account hands back, so a
    // malformed or hand-edited store cannot put junk into the dropdown.
    function coercePresets(data) {
        const out = { swap: [] };
        if (!data || typeof data !== "object")
            return out;
        for (const kind of Object.keys(out)) {
            const arr = Array.isArray(data[kind]) ? data[kind] : [];
            out[kind] = arr
                .filter((p) => p &&
                typeof p.name === "string" &&
                p.values &&
                typeof p.values === "object")
                .map((p) => ({ name: p.name, values: p.values }));
        }
        return out;
    }
    function loadPresets() {
        try {
            if (typeof localStorage === "undefined")
                return coercePresets(null);
            const raw = localStorage.getItem(PRESETS_KEY);
            if (!raw)
                return coercePresets(null);
            return coercePresets(JSON.parse(raw));
        }
        catch (_) {
            return coercePresets(null);
        }
    }
    // Presets now follow the account as well, the way settings already did. The
    // browser copy stays the synchronous source every caller reads; the account
    // copy is what makes them turn up on another device.
    function savePresetsToAccount(all) {
        try {
            if (ctx && typeof ctx.sendToBackend === "function") {
                ctx.sendToBackend({ type: "save_presets", presets: all });
            }
        }
        catch (_) { }
    }
    function savePresets(all) {
        savePresetsToAccount(all);
        try {
            if (typeof localStorage === "undefined")
                return false;
            localStorage.setItem(PRESETS_KEY, JSON.stringify(all));
            return true;
        }
        catch (_) {
            return false;
        }
    }
    // Pull the account's presets on load. The account wins when it has any; when
    // it has none but this browser does, this browser's are migrated up, which is
    // the same rule the settings use so the two cannot disagree about which copy
    // is authoritative.
    function loadPresetsFromAccount() {
        try {
            if (!ctx || typeof ctx.sendToBackend !== "function" || typeof ctx.onBackendMessage !== "function")
                return;
            const reqId = "ar-presets-" + Date.now() + "-" + Math.random().toString(36).slice(2);
            const off = ctx.onBackendMessage((msg) => {
                if (!msg || msg.type !== "loaded_presets" || msg.requestId !== reqId)
                    return;
                try {
                    off && off();
                }
                catch (_) { }
                const incoming = coercePresets(msg.presets);
                const localCount = loadPresets().swap.length;
                if (incoming.swap.length) {
                    try {
                        if (typeof localStorage !== "undefined")
                            localStorage.setItem(PRESETS_KEY, JSON.stringify(incoming));
                    }
                    catch (_) { }
                    for (const r of presetBarRefreshers)
                        r();
                    log("word swap presets loaded from account");
                }
                else if (localCount) {
                    savePresetsToAccount(loadPresets());
                    log("word swap presets migrated to account");
                }
            });
            disposers.push(() => { try {
                off && off();
            }
            catch (_) { } });
            ctx.sendToBackend({ type: "load_presets", requestId: reqId });
        }
        catch (_) { }
    }
    // Merge presets from an imported blob into storage. Same-named presets are
    // replaced by the imported one, new names are added. Returns how many came
    // in, or -1 if saving failed. Zero (including a file with none) is harmless.
    function importPresets(data) {
        const incoming = data && data.presets ? data.presets : null;
        if (!incoming || typeof incoming !== "object")
            return 0;
        const stored = loadPresets();
        let n = 0;
        for (const kind of Object.keys(stored)) {
            const arr = Array.isArray(incoming[kind]) ? incoming[kind] : [];
            for (const p of arr) {
                if (!p || typeof p.name !== "string" || !p.values || typeof p.values !== "object")
                    continue;
                const i = stored[kind].findIndex((x) => x.name === p.name);
                if (i >= 0)
                    stored[kind][i] = { name: p.name, values: p.values };
                else
                    stored[kind].push({ name: p.name, values: p.values });
                n++;
            }
        }
        if (n && !savePresets(stored))
            return -1;
        return n;
    }
    // Snapshot the current values of a kind's keys.
    function snapshotKind(kind) {
        const values = {};
        for (const k of keysForKind(kind))
            values[k] = cfg[k];
        return values;
    }
    // Copy a preset's stored values into the live config, coercing each key.
    function applyPresetValues(kind, values) {
        let n = 0;
        for (const k of keysForKind(kind)) {
            if (!values || !(k in values))
                continue;
            const v = coerceKey(k, values[k]);
            if (v !== undefined) {
                cfg[k] = v;
                n++;
            }
        }
        return n;
    }
    // ---- per-chat state ----
    // Each chat gets a state object that holds its retry budget, its watchdog
    // timers and, while a reply is streaming, the text so far. Only cleared on
    // teardown before, so browsing through a lot of chats in one sitting left a
    // state object behind for every one of them, streamed text and all.
    const chats = new Map();
    const CHATS_MAX = 24; // chats kept before the quietest are let go
    // Anything mid-flight has to stay: dropping it would strand a running
    // watchdog and lose the budget for a retry that is already in the air.
    const chatIsBusy = (s) => !!(s && (s.pending || s.timer || s.startTimer || s.idleTimer || s.startWatchdog ||
        s.expectingStart || s.attempts > 0 || Date.now() < s.suppressUntil));
    // Recency is a field rather than the Map's own insertion order. Re-inserting
    // a chat to mark it as used would move it to the end of the Map, and two
    // places walk the Map calling standDown, which touches each chat as it goes:
    // an entry moved past the cursor gets visited again, forever.
    function evictIdleChats() {
        if (chats.size <= CHATS_MAX)
            return;
        const idle = Array.from(chats.entries())
            .filter(([, s]) => !chatIsBusy(s))
            .sort((a, b) => (a[1].lastSeen || 0) - (b[1].lastSeen || 0));
        for (const [id] of idle) {
            if (chats.size <= CHATS_MAX)
                break;
            chats.delete(id);
        }
    }
    const st = (chatId) => {
        let s = chats.get(chatId);
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
            sawReasoning: false,
            sawContent: false,
            buf: "", // streamed reply text, used when the end event carries no content
            ignored: new Set(),
            suppressUntil: 0,
            startWatchdog: null,
            expectingStart: 0,
        };
        chats.set(chatId, s);
        evictIdleChats();
        return s;
    };
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
    // has scrolled away by the time anyone thinks to look. This survives it, and
    // is the difference between a bug report that can be acted on and one that
    // says "it retries too much".
    const stats = {
        retries: 0,
        gaveUp: 0,
        good: 0,
        reasons: {},
    };
    // Read at the moment they are needed so a settings change takes effect without
    // a reload. Anything missing or nonsensical falls back to the default rather
    // than switching the feature off by accident.
    const breakerRuns = () => {
        const v = Math.floor(Number(cfg.breakerRuns));
        return Number.isFinite(v) && v >= 1 ? v : BREAKER_RUNS_DEFAULT;
    };
    const breakerPauseMs = () => {
        const v = Math.floor(Number(cfg.breakerPauseMins));
        return Number.isFinite(v) && v >= 1 ? v * 60000 : BREAKER_PAUSE_DEFAULT_MS;
    };
    const clearTimers = (s) => {
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
    const isRateLimit = (err) => !!err &&
        /\b(?:408|429|500|502|503|504|520|521|522|523|524)\b|rate.?limit|too many requests|quota|overloaded|timeout|temporary|network/i.test(String(err));
    const isHardError = (err) => !!err &&
        /\b(?:400|401|402|403|404|405|406|411|413|415|422|invalid api key|authentication|unauthorized|not found|does not exist|model missing|insufficient balance|permission|forbidden|not allowed)\b/i.test(String(err));
    const computeDelay = (attempt, rateLimited) => {
        let d = cfg.retryDelayMs * Math.pow(cfg.backoffFactor, Math.max(0, attempt - 1));
        d = Math.min(d, cfg.maxDelayMs);
        if (rateLimited)
            d = Math.max(d, cfg.rateLimitDelayMs * attempt);
        if (cfg.jitter)
            d = Math.round(d * (0.85 + Math.random() * 0.3));
        return d;
    };
    // A control only does something when it is enabled and actually laid out.
    // A hidden or disabled button accepts .click() and silently does nothing,
    // which would otherwise be counted as a retry that fired.
    const clickable = (el) => {
        if (!el)
            return false;
        try {
            if (el.disabled)
                return false;
            if (el.getAttribute && el.getAttribute("aria-disabled") === "true")
                return false;
            if (el.hasAttribute && el.hasAttribute("hidden"))
                return false;
            if (el.closest && el.closest("[inert]"))
                return false;
            if (typeof el.getClientRects === "function" &&
                el.getClientRects().length === 0)
                return false;
        }
        catch (_) { }
        return true;
    };
    const find = (selector) => {
        // Checked in list order, not DOM order, so the first entry that yields a
        // usable control wins wherever it sits on the page.
        const parts = splitSelectorList(selector);
        if (typeof document === "undefined")
            return null;
        for (const part of parts) {
            let list = null;
            try {
                list = document.querySelectorAll(part);
            }
            catch (_) {
                continue; // an invalid selector shouldn't stop the rest of the list
            }
            if (!list || !list.length)
                continue;
            // Walk from the end: messages render in order, so the last match belongs
            // to the newest message. Skip anything that isn't clickable, which is
            // usually a hidden control left on an older message.
            for (let i = list.length - 1; i >= 0; i--) {
                if (clickable(list[i]))
                    return list[i];
            }
        }
        return null;
    };
    // Set while the extension clicks a host control itself, so the document-level
    // stop-press catcher can tell our synthetic click from the user's.
    let selfClicking = 0;
    const clickHostControl = (el) => {
        if (!el)
            return false;
        selfClicking += 1;
        try {
            el.click();
            return true;
        }
        catch (e) {
            log("click failed", e);
            return false;
        }
        finally {
            selfClicking -= 1;
        }
    };
    // Which control a retry clicks. retryByNewReroll picks the preferred one; the
    // other is the fallback. The choice is made at click time from what is on
    // screen and clickable, so the reason for the retry (empty, error, cut off)
    // no longer forces a particular control.
    const pickRetryControl = () => {
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
            if (btn)
                return { btn: btn, via: step.via };
        }
        return null;
    };
    // Returns which control it clicked, or null if nothing was clicked.
    const fireRetry = () => {
        const picked = pickRetryControl();
        if (!picked) {
            log("no retry control found, set the button selectors in settings");
            showToast("Auto-retry: couldn't find your retry button. Set it in Auto Retry settings.");
            return null;
        }
        hideToast();
        return clickHostControl(picked.btn) ? picked.via : null;
    };
    const stopGenerating = () => {
        const stop = find(cfg.stopSelector);
        if (!stop)
            return false;
        return clickHostControl(stop);
    };
    // The user wins, always. Cancel any pending retry for this chat, reset its
    // budget, and briefly suppress new automatic retries so a stopped
    // generation's trailing events can't immediately restart the loop. This is
    // what makes Stop and Cancel actually stop things.
    function standDown(chatId, announce) {
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
            // The retry this note was armed for is off, so the note goes with it.
            disarmRefusalNote(chatId);
            if (announce)
                showToast("Auto-retry stopped.");
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
    const CONFIRM_DENY = /cancel|close|dismiss|delete|discard|remove|revert|undo|back|no thanks|never ?mind/i;
    // The first look is almost immediate so a dialog that has to be clicked
    // through is on screen for as little time as possible. Later looks are spaced
    // out, for a build that animates the dialog in more slowly.
    const CONFIRM_FIRST_MS = 40;
    const CONFIRM_POLL_MS = 150;
    const CONFIRM_TRIES = 11; // about 1.5s in total, then it leaves things alone
    let confirmTimer = null;
    // Watches for the dialog being inserted rather than checking on a timer, so it
    // can be pressed in the same frame it appears and is usually gone again before
    // it has been drawn. The timer below stays as a backstop.
    let confirmObserver = null;
    // Presses made in the current window. A press can land before the dialog is
    // ready to act on it, so the watch keeps looking afterwards instead of
    // standing down on the first try. Capped so it can never sit on a button.
    let confirmClicks = 0;
    const CONFIRM_MAX_CLICKS = 3;
    // Longest a dialog may stay hidden under any circumstances.
    const HIDE_FAILSAFE_MS = 4000;
    const HIDE_CLASS = "__lvRetryHidden";
    const DIALOG_SELECTOR = '[role="dialog"],[role="alertdialog"],[aria-modal="true"],[class*="modal" i],[class*="dialog" i],[class*="overlay" i]';
    // A confirm button lives inside a dialog. The toolbar's own Regenerate button
    // carries the same label, so without this the scan could press that instead
    // and loop. Element identity alone is not enough to tell them apart, because
    // the app rebuilds those nodes when it re-renders and they then look new.
    function inDialog(el) {
        let p = el;
        let hops = 0;
        while (p && hops < 12) {
            try {
                const role = p.getAttribute && p.getAttribute("role");
                if (role === "dialog" || role === "alertdialog")
                    return true;
                if (p.getAttribute && p.getAttribute("data-component") === "RegenFeedbackModal")
                    return true;
                if (p.getAttribute && p.getAttribute("aria-modal") === "true")
                    return true;
                const cls = String((p && p.className) || "");
                if (/modal|dialog|popover|popup|overlay|sheet|drawer/i.test(cls))
                    return true;
            }
            catch (_) { }
            p = p.parentElement;
            hops++;
        }
        return false;
    }
    const buttonLabel = (el) => {
        let v = "";
        try {
            v =
                (el.getAttribute && el.getAttribute("aria-label")) ||
                    (el.getAttribute && el.getAttribute("title")) ||
                    el.textContent ||
                    "";
        }
        catch (_) { }
        return String(v).replace(/\s+/g, " ").trim();
    };
    // Everything currently on screen that could pass as a confirm button. Taken
    // before our click so anything already there is ruled out afterwards.
    function confirmSnapshot() {
        const out = new Set();
        if (typeof document === "undefined")
            return out;
        let list = [];
        try {
            list = document.querySelectorAll('button,[role="button"]');
        }
        catch (_) {
            return out;
        }
        for (const el of Array.prototype.slice.call(list)) {
            const label = buttonLabel(el);
            if (label && CONFIRM_LABELS.some((re) => re.test(label)))
                out.add(el);
        }
        // Dialogs already open go in the same set, so one the user opened before the
        // retry is never mistaken for one the retry raised, and never hidden.
        try {
            const dialogs = document.querySelectorAll(DIALOG_SELECTOR);
            for (const el of Array.prototype.slice.call(dialogs))
                out.add(el);
        }
        catch (_) { }
        return out;
    }
    // Labels the user added, lower-cased and trimmed. Read fresh each time so a
    // settings change takes effect without a reload.
    function userConfirmLabels() {
        return String(cfg.confirmButtonLabels || "")
            .split(/[\r\n]+/)
            .map((x) => x.trim().toLowerCase())
            .filter((x) => x.length > 0);
    }
    function findNewConfirm(before) {
        if (typeof document === "undefined")
            return null;
        let list = [];
        try {
            list = document.querySelectorAll('button,[role="button"]');
        }
        catch (_) {
            return null;
        }
        const fresh = [];
        for (const el of Array.prototype.slice.call(list)) {
            if (before.has(el))
                continue; // was already there, so our click didn't raise it
            const label = buttonLabel(el);
            if (!label)
                continue;
            // The deny list guards the built-in guesses. A label typed by hand is a
            // choice they made, so it is allowed through.
            const chosen = userConfirmLabels().indexOf(label.toLowerCase()) >= 0;
            if (!chosen && CONFIRM_DENY.test(label))
                continue;
            if (!inDialog(el))
                continue; // a bare toolbar button is not a confirmation
            if (!clickable(el))
                continue;
            try {
                // Never our own panels.
                if (el.closest && el.closest("#__lvRetryToast,#__lvRetrySettings"))
                    continue;
            }
            catch (_) { }
            fresh.push(el);
        }
        // Anything the user listed comes first: they know their own setup, and a
        // build in another language will not match the built-in wording.
        for (const want of userConfirmLabels()) {
            for (const el of fresh)
                if (buttonLabel(el).toLowerCase() === want)
                    return el;
        }
        // Then the built-ins, in preference order.
        for (const re of CONFIRM_LABELS) {
            for (const el of fresh)
                if (re.test(buttonLabel(el)))
                    return el;
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
    const SEARCH_X = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z'/%3E%3C/svg%3E\")";
    let panelStyleEl = null;
    function ensurePanelStyle() {
        if (panelStyleEl || typeof document === "undefined")
            return;
        try {
            const el = document.createElement("style");
            el.id = "__lvRetryPanelStyle";
            el.textContent =
                "#" + SEARCH_ID + "::-webkit-search-cancel-button{" +
                    "-webkit-appearance:none;appearance:none;width:14px;height:14px;cursor:pointer;" +
                    "background-color:currentColor;opacity:.6;" +
                    "-webkit-mask:" + SEARCH_X + " center/contain no-repeat;" +
                    "mask:" + SEARCH_X + " center/contain no-repeat}" +
                    "#" + SEARCH_ID + "::-webkit-search-cancel-button:hover{opacity:1}";
            (document.head || document.documentElement).appendChild(el);
            panelStyleEl = el;
        }
        catch (_) { }
    }
    // Dialogs currently hidden. Hiding is done with a class and a rule marked
    // important, not by writing inline styles: the dialog fades itself in by
    // setting inline opacity every frame, so an inline value of ours would just be
    // overwritten and the dialog would appear anyway. A stylesheet rule marked
    // important outranks an inline value that isn't.
    let hidden = [];
    let hideFailsafe = null;
    let hideStyleEl = null;
    function ensureHideStyle() {
        if (hideStyleEl || typeof document === "undefined")
            return;
        try {
            const el = document.createElement("style");
            el.id = "__lvRetryHideStyle";
            el.textContent =
                "." + HIDE_CLASS + "{opacity:0!important;pointer-events:none!important;transition:none!important;animation:none!important}";
            (document.head || document.documentElement).appendChild(el);
            hideStyleEl = el;
        }
        catch (_) { }
    }
    function restoreHiddenDialogs() {
        if (hideFailsafe) {
            clearTimeout(hideFailsafe);
            hideFailsafe = null;
        }
        for (const el of hidden) {
            try {
                el.classList.remove(HIDE_CLASS);
            }
            catch (_) { }
        }
        hidden = [];
    }
    // Anything dialog-shaped that has turned up since the retry click. Hidden
    // rather than removed, and with pointer events switched off so that even in
    // the worst case an unseen dialog cannot swallow taps.
    function hideNewDialogs(before) {
        if (typeof document === "undefined")
            return;
        let list = [];
        try {
            list = document.querySelectorAll(DIALOG_SELECTOR);
        }
        catch (_) {
            return;
        }
        for (const el of Array.prototype.slice.call(list)) {
            if (before.has(el))
                continue; // was already on screen, not ours
            if (hidden.indexOf(el) >= 0)
                continue;
            try {
                if (el.closest && el.closest("#__lvRetryToast,#__lvRetrySettings"))
                    continue;
            }
            catch (_) { }
            try {
                ensureHideStyle();
                el.classList.add(HIDE_CLASS);
                hidden.push(el);
            }
            catch (_) { }
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
            }
            catch (_) { }
            confirmObserver = null;
        }
        // A dialog only stays hidden while it is actively being clicked through.
        // The moment the watch ends, for any reason, it goes back on screen.
        restoreHiddenDialogs();
    }
    // One look for a dialog to click through. Returns true when there is nothing
    // left to wait for, either because it pressed something or because the reply
    // is already running.
    function tryConfirm(before) {
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
        if (!btn)
            return false;
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
            }
            catch (_) { }
            confirmObserver = null;
        }
        clickHostControl(btn);
        return false;
    }
    function watchForConfirm(before, tries) {
        const first = typeof tries !== "number";
        const left = first ? CONFIRM_TRIES : tries;
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
            }
            catch (_) {
                confirmObserver = null;
            }
        }
        else if (confirmTimer) {
            clearTimeout(confirmTimer);
            confirmTimer = null;
        }
        if (left <= 0) {
            clearConfirmWatch();
            return;
        }
        confirmTimer = setTimeout(() => {
            confirmTimer = null;
            if (tryConfirm(before))
                return;
            watchForConfirm(before, left - 1);
        }, first ? CONFIRM_FIRST_MS : CONFIRM_POLL_MS);
    }
    const START_WAIT_ROUNDS = 3; // extra grace rounds while something is generating
    function armStartWatchdog(chatId, via, allowFallback, waits) {
        const s = st(chatId);
        // The caller marks the click before making it. If a start already arrived,
        // which happens when the host dispatches its event straight off the click,
        // there is nothing left to watch.
        if (!s.expectingStart)
            return;
        const left = typeof waits === "number" ? waits : START_WAIT_ROUNDS;
        if (s.startWatchdog)
            clearTimeout(s.startWatchdog);
        s.startWatchdog = setTimeout(() => {
            s.startWatchdog = null;
            if (!s.expectingStart)
                return; // a generation started, nothing to do
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
                const otherSel = via === "swipe" ? cfg.regenerateSelector : cfg.swipeNextSelector;
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
    let armedNoteChat = null;
    // Take a note back when the click it was armed for never happened. The
    // backend reads an empty list as "nothing armed", so a disarm is the same
    // message carrying nothing. Without it the note sat waiting out its full
    // minute and could then attach itself to a regenerate the user pressed
    // themselves, which is the one thing this feature promises never to do.
    function disarmRefusalNote(chatId) {
        try {
            if (armedNoteChat == null || String(chatId) !== armedNoteChat)
                return;
            armedNoteChat = null;
            if (!ctx || typeof ctx.sendToBackend !== "function")
                return;
            ctx.sendToBackend({ type: "arm_refusal_note", chatId: chatId, notes: [] });
            log("retry never started; note taken back", chatId);
        }
        catch (_) { }
    }
    // Resolves once the backend confirms the note is in place. The arm travels the
    // frontend-to-backend bridge while the retry click travels the DOM to the host
    // to the server, and those are independent: the click could reach prompt
    // assembly first, the interceptor would find nothing armed, and the note was
    // silently dropped from that generation. Waiting on the acknowledgement
    // removes the race. The timeout means a host with no backend bridge, or a slow
    // one, still gets its retry.
    function armRefusalNote(chatId, reason, attempt) {
        return new Promise((resolve) => {
            try {
                if (!cfg.refusalNote || reason !== REFUSAL_REASON)
                    return resolve(false);
                // An empty note is skipped rather than sent blank, so a half-filled list
                // is not a trap. Nothing is armed when they are all empty.
                //
                // Trimmed to decide whether a note counts as empty, and not otherwise:
                // what goes out is what was typed, spacing and all. The panel says the
                // note is sent exactly as written, and a line break someone put at the
                // end of theirs is part of what they wrote.
                const notes = (Array.isArray(cfg.refusalNotes) ? cfg.refusalNotes : [])
                    .slice(0, MAX_NOTES)
                    .map((n) => ({
                    text: String((n && n.text) || ""),
                    role: NOTE_ROLES.indexOf(String(n && n.role)) >= 0 ? String(n.role) : "system",
                }))
                    .filter((n) => n.text.trim());
                if (!notes.length)
                    return resolve(false);
                const from = Math.max(1, Number(cfg.refusalNoteFromTry) || 1);
                if (attempt < from) {
                    log("note starts on try " + from + ", this is try " + attempt);
                    return resolve(false);
                }
                if (!ctx || typeof ctx.sendToBackend !== "function")
                    return resolve(false);
                const reqId = "ar-arm-" + Date.now() + "-" + Math.random().toString(36).slice(2);
                let settled = false;
                let off = null;
                let timer = null;
                const finish = (ok) => {
                    if (settled)
                        return;
                    settled = true;
                    try {
                        off && off();
                    }
                    catch (_) { }
                    clearTimeout(timer);
                    resolve(ok);
                };
                try {
                    off = ctx.onBackendMessage((msg) => {
                        if (msg && msg.type === "note_armed" && msg.requestId === reqId) {
                            log(msg.armed ? "note is in place for the next retry" : "backend accepted no note");
                            finish(!!msg.armed);
                        }
                    });
                }
                catch (_) { }
                timer = setTimeout(() => {
                    log("note was not acknowledged in time; retrying without waiting further");
                    finish(false);
                }, NOTE_ACK_MS);
                ctx.sendToBackend({
                    type: "arm_refusal_note",
                    chatId: chatId,
                    notes: notes,
                    placement: String(cfg.refusalNotePlacement || "after"),
                    strictType: !!cfg.refusalNoteStrictType,
                    requestId: reqId,
                });
                armedNoteChat = String(chatId);
            }
            catch (_) {
                resolve(false);
            }
        });
    }
    function scheduleRetry(chatId, reason, err) {
        const s = st(chatId);
        if (!cfg.enabled || s.pending)
            return;
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
            if (cfg.maxRetries <= 0)
                return;
            stats.gaveUp += 1;
            failedRuns += 1;
            const runsNeeded = breakerRuns();
            if (cfg.pauseWhenFailing && failedRuns >= runsNeeded) {
                const pauseMs = breakerPauseMs();
                const mins = Math.round(pauseMs / 60000);
                pausedUntil = Date.now() + pauseMs;
                failedRuns = 0;
                log("paused for " + mins + " min after " + runsNeeded + " failed runs");
                // Forced: the toast setting covers the pop-up on each retry, and going
                // quiet for minutes at a time is a state change, not a retry. A
                // user who sees nothing has no way to tell this from the thing breaking.
                showToast("Auto-retry paused for " + mins + (mins === 1 ? " minute" : " minutes") +
                    ": the last " + runsNeeded + (runsNeeded === 1 ? " run" : " runs") + " failed.", { force: true });
            }
            else {
                showToast("Auto-retry: gave up after " + cfg.maxRetries + " tries.");
            }
            return;
        }
        s.attempts += 1;
        stats.retries += 1;
        stats.reasons[reason] = (stats.reasons[reason] || 0) + 1;
        const rl = isRateLimit(err);
        const delay = computeDelay(s.attempts, rl);
        clearTimers(s);
        s.pending = true;
        log("retry " +
            s.attempts +
            "/" +
            cfg.maxRetries +
            " in " +
            delay +
            "ms (" +
            reason +
            (rl ? ", rate-limited" : "") +
            ")");
        showToast("Retrying " +
            s.attempts +
            "/" +
            cfg.maxRetries +
            " (" +
            reason +
            ") in " +
            (delay / 1000).toFixed(1) +
            "s", { cancel: () => standDown(chatId, true), sticky: true });
        s.timer = setTimeout(async () => {
            s.timer = null;
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
            if (pickRetryControl())
                await armRefusalNote(chatId, reason, s.attempts);
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
    function abortAndRetry(chatId, reason) {
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
    function onStart(p) {
        if (!p || !p.chatId)
            return;
        const s = st(p.chatId);
        if (s.startWatchdog) {
            clearTimeout(s.startWatchdog);
            s.startWatchdog = null;
        }
        s.expectingStart = 0;
        lastChatId = p.chatId;
        lastMessageId = p.messageId;
        log("gen start", p.generationId, s.selfTriggered ? "(auto-retry)" : "(user)");
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
            s.startTimer = setTimeout(() => abortAndRetry(p.chatId, "stuck"), cfg.stuckTimeoutMs);
        }
    }
    // The manual swap buttons need a chat id, and generation events were the only
    // thing setting one, so opening an older chat and pressing swap reported that
    // there was no reply to swap until something had been generated in it.
    function onChatSwitched(p) {
        if (!p || typeof p.chatId === "undefined")
            return;
        lastChatId = p.chatId || null;
        lastMessageId = null;
    }
    // The text a token event carries. Builds name this field differently, so the
    // first string among the known names is used and anything else is ignored.
    function tokenText(p) {
        for (const k of ["token", "text", "delta", "content", "chunk"]) {
            if (p && typeof p[k] === "string")
                return p[k];
        }
        return "";
    }
    function onToken(p) {
        if (!p || !p.chatId)
            return;
        const s = st(p.chatId);
        // Matched by shape, not an exact string, so a build that labels these
        // "reasoning_content" or "thinking" is not counted as visible reply text.
        if (/reason|think/i.test(String((p && p.type) || "")))
            s.sawReasoning = true;
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
            if (s.idleTimer)
                clearTimeout(s.idleTimer);
            s.idleTimer = setTimeout(() => abortAndRetry(p.chatId, "stalled"), cfg.idleTimeoutMs);
        }
    }
    function onEnd(p) {
        if (!p || !p.chatId)
            return;
        const s = st(p.chatId);
        lastChatId = p.chatId;
        lastMessageId = p.messageId;
        if (s.ignored.has(p.generationId))
            return; // aborted gen's trailing event, retry already scheduled
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
                scheduleRetry(p.chatId, REFUSAL_REASON);
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
            scheduleRetry(p.chatId, s.sawReasoning && !s.sawContent ? "cut off mid-reasoning" : "empty");
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
        if (cfg.retryOnEmpty &&
            content.length > 0 &&
            stripThinkingAlways(content, cfg).trim().length === 0) {
            scheduleRetry(p.chatId, "thinking only, no reply");
            return;
        }
        if (cfg.retryOnTruncated && looksTruncated(content, cfg.retryOnNoPunct, cfg)) {
            scheduleRetry(p.chatId, "cut off");
            return;
        }
        if (cfg.retryOnRefusal && looksLikeRefusal(content, cfg)) {
            scheduleRetry(p.chatId, REFUSAL_REASON);
            return;
        }
        // Measured on the visible reply, not the raw output. A reasoning block can
        // run to hundreds of characters, so counting it would let a two-word reply
        // pass the length test on a thinking model.
        if (cfg.retryOnShort &&
            stripThinkingAlways(content, cfg).trim().length < cfg.minChars) {
            scheduleRetry(p.chatId, "short");
            return;
        }
        // A reply that came back fine means whatever was wrong has cleared.
        failedRuns = 0;
        pausedUntil = 0;
        stats.good += 1;
        log("gen ok", content.length + " chars");
        s.attempts = 0; // clean success
    }
    function onStop(p) {
        if (!p || !p.chatId)
            return;
        const s = st(p.chatId);
        if (s.ignored.has(p.generationId))
            return; // our own abort, not a user stop
        log("user stop", p.generationId);
        standDown(p.chatId, true); // genuine user stop: stand down, don't fight them
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
    // It used to take the last matching node and rewrite every occurrence inside
    // it, which does not add up: a reply matching twice in one paragraph had both
    // done by the first pair, and the second pair then went looking further up
    // and rewrote an older message the backend had never touched. The whole-chat
    // path replaced every occurrence everywhere, which caught the user's own
    // messages, and the backend only ever edits replies. Both left the screen
    // saying something the stored chat did not, until it was next reopened.
    //
    // Counting from the end is right for one reply and close for a whole chat.
    // A whole-chat swap changes every reply, so the occurrences to change are not
    // guaranteed to be the last N on the page: a message of the user's sitting
    // between two replies can still be caught. Fixing that needs knowing which
    // element is which message, which is the host dependency this extension is
    // built to avoid, so this stays a heuristic and stays honest about it.
    function applySwapsToView(pairs) {
        if (typeof document === "undefined" || !pairs || !pairs.length)
            return 0;
        const SKIP = /^(SCRIPT|STYLE|TEXTAREA|INPUT|SELECT|OPTION)$/;
        let done = 0;
        // The page is walked once, not once per rule. This used to build a fresh
        // TreeWalker inside the loop below, so a chat swapped with forty rules made
        // forty full passes over every text node on the page. The candidate list is
        // the same for every rule, so it is gathered here and reused.
        const nodes = [];
        try {
            const walker = document.createTreeWalker(document.body, 4 /* SHOW_TEXT */);
            let node = walker.nextNode ? walker.nextNode() : null;
            while (node) {
                const parent = node.parentElement;
                let skip = !parent || SKIP.test(String(parent.tagName || ""));
                // Our own panels and anything the user is typing into are off limits.
                if (!skip && parent.closest) {
                    try {
                        skip = !!parent.closest("#__lvRetryToast,#__lvRetrySettings,[contenteditable='true']");
                    }
                    catch (__) { }
                }
                if (!skip)
                    nodes.push(node);
                node = walker.nextNode();
            }
        }
        catch (_) {
            return done;
        }
        for (const pair of pairs) {
            const from = String(pair && pair[0] != null ? pair[0] : "");
            const to = String(pair && pair[1] != null ? pair[1] : "");
            if (!from || from === to)
                continue;
            // The backend matches whole words for single-word rules, so a literal
            // replace here would also hit "dogged" when the rule was "dog". This
            // rebuilds the same boundary the backend used.
            let re = null;
            const esc = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const needsLead = /^[\p{L}\p{N}]/u.test(from);
            const needsTail = /[\p{L}\p{N}]$/u.test(from);
            const build = (lead, tail) => new RegExp((needsLead ? lead : "") + esc + (needsTail ? tail : ""), "gu");
            try {
                // Not \b. It is defined against [A-Za-z0-9_] even under the u flag, so
                // it fails at the first accented letter and the visible text would keep
                // the old wording while the saved reply had the new one. The backend
                // matches with these same lookarounds.
                re = build("(?<![\\p{L}\\p{N}_])", "(?![\\p{L}\\p{N}_])");
            }
            catch (__) {
                // No lookbehind on this engine. Same fallback the backend takes.
                try {
                    re = build("\\b", "\\b");
                }
                catch (___) {
                    re = null;
                }
            }
            if (!re)
                continue;
            // Walk backwards and stop at the first node that still matches, changing
            // the last occurrence in it. Re-read each node as we go: an earlier pair
            // may already have rewritten it, and matching has to see the text as it
            // stands now rather than as it was when the walk started.
            for (let i = nodes.length - 1; i >= 0; i--) {
                const text = String(nodes[i].nodeValue || "");
                re.lastIndex = 0;
                let at = -1;
                let len = 0;
                let m;
                while ((m = re.exec(text)) !== null) {
                    at = m.index;
                    len = m[0].length;
                }
                if (at < 0)
                    continue;
                try {
                    nodes[i].nodeValue = text.slice(0, at) + to + text.slice(at + len);
                    done++;
                }
                catch (__) { }
                break;
            }
        }
        return done;
    }
    // Backup for the user's Stop press: if the host's GENERATION_STOPPED event is
    // late or never fires, catch the click on the stop button itself and stand
    // every pending retry down. Delegated + capture so it survives the host
    // re-rendering its buttons.
    function onDocClick(e) {
        try {
            // A stalled reply is halted by clicking that same stop button, and that
            // click reaches here too. Standing down on it would suppress the retry
            // being scheduled right behind it, so our own clicks are skipped.
            if (selfClicking > 0)
                return;
            // Any click by the user during the short window after a retry means the
            // user is driving. Back off rather than press a dialog button underneath
            // them, which could take a feedback prompt they opened themselves.
            clearConfirmWatch();
            const tgt = e && e.target && e.target.closest
                ? e.target.closest(cfg.stopSelector)
                : null;
            if (!tgt)
                return;
            chats.forEach((s, id) => {
                if (s.pending || s.timer || s.attempts > 0)
                    standDown(id, true);
            });
        }
        catch (_) { }
    }
    // ---- hint popover ----
    // A setting's description used to expand inline, which pushed every option
    // below it down the list. On a phone one tap could shove the next two options
    // off the screen, and opening a second description moved everything again, so
    // reading two descriptions meant losing your place twice. This floats the text
    // over the panel instead, so the list never moves.
    //
    // Fixed position, parented to the page rather than the row: the options list
    // is a scroll container, and anything inside it would be clipped at its edges.
    // Only ever one open, since there is only ever one of these.
    let hintPop = null;
    let hintAnchor = null;
    let hintReset = null;
    function hideHint() {
        if (hintPop) {
            try {
                hintPop.remove();
            }
            catch (_) { }
        }
        hintPop = null;
        hintAnchor = null;
        if (hintReset) {
            try {
                hintReset();
            }
            catch (_) { }
        }
        hintReset = null;
    }
    function showHint(anchor, text, onClose) {
        hideHint();
        if (typeof document === "undefined" || !anchor || !anchor.getBoundingClientRect)
            return;
        const el = document.createElement("div");
        el.setAttribute("role", "tooltip");
        el.textContent = text;
        el.style.cssText =
            "position:fixed;z-index:2147483647;box-sizing:border-box;padding:8px 10px;" +
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
        // flipped between the two on the fly. It used to flip whenever there was no
        // room below, which meant a long description opened somewhere none of the
        // others do. Where it opens is now a property of the setting, so it is the
        // same place every time for a given row.
        //
        // Above is for a row tall enough that below it is a long way from the "?"
        // that was pressed. Whichever side it is on, a description too tall for the
        // room there is capped and scrolls rather than moving to the other side.
        let above = false;
        try {
            above = !!(anchor.getAttribute && anchor.getAttribute("data-ar-hint-above"));
        }
        catch (_) { }
        // However little room there is, it is not bought by moving over the row.
        // Covering the setting is the thing the popover exists to avoid, and a
        // short popover still scrolls, so nothing in it is out of reach.
        // Never below zero. A row pushed to the very top of the screen by the host's
        // own layout leaves negative room above it, and a negative max-height is
        // invalid CSS, which the browser drops: the popover then rendered at full
        // height straight over the row it belongs to, which is the one thing it
        // exists not to do. Measured at a row top of -5, covering it from 12 to 273.
        const room = Math.max(0, above ? r.top - GAP - EDGE : vh - EDGE - (r.bottom + GAP));
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
        if (room <= 0)
            el.style.display = "none";
        // Where it is told to go is not always where it lands. Lumiverse's UI Scale
        // is applied as a zoom, and this is parented to the page so the zoom applies
        // to it too: at 0.9 a popover set to 800 arrives at 720, most of a row too
        // high and back on top of the setting it was describing. Rather than guess
        // at how a host applies its scale, put it somewhere, ask the browser where
        // it actually went, and correct by the difference. That holds for a zoom, a
        // transform, or anything else that moves it, because it is measured rather
        // than assumed.
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
        const onHintDismiss = (e) => {
            const t = e && e.target;
            // The float menu shares these listeners rather than adding its own. A
            // press on the button itself is left alone, or opening the menu would
            // immediately close it again.
            if (floatMenu) {
                let inside = false;
                try {
                    inside =
                        (!!t && floatMenu.contains && floatMenu.contains(t)) ||
                            (!!t && !!floatEl && (t === floatEl || (floatEl.contains && floatEl.contains(t))));
                }
                catch (_) { }
                if (!inside)
                    hideFloatMenu();
            }
            if (!hintPop)
                return;
            try {
                // The "?" itself is left alone so its own handler can close it, rather
                // than this closing it and the click reopening it.
                if (t && t.closest && (t === hintAnchor || t.closest("[data-ar-hint]")))
                    return;
                if (t && hintPop.contains && hintPop.contains(t))
                    return;
            }
            catch (_) { }
            hideHint();
        };
        // The float button is fixed, so a scroll does not move it and the menu can
        // stay. A resize can put it somewhere else entirely, so that closes it.
        // A long description scrolls inside itself. That scroll is someone reading
        // it, not the anchor moving, so it is the one scroll that leaves it open.
        const onHintScroll = (e) => {
            try {
                const t = e && e.target;
                if (hintPop && t && hintPop.contains && hintPop.contains(t))
                    return;
            }
            catch (_) { }
            hideHint();
        };
        const onHintResize = () => {
            hideHint();
            hideFloatMenu();
        };
        const onHintKey = (e) => {
            if (e && e.key === "Escape") {
                hideHint();
                hideFloatMenu();
            }
        };
        const onHoldMove = (e) => {
            if (holdMoveWatch)
                holdMoveWatch(e);
        };
        document.addEventListener("pointermove", onHoldMove, true);
        document.addEventListener("pointerdown", onHintDismiss, true);
        document.addEventListener("scroll", onHintScroll, true);
        document.addEventListener("keydown", onHintKey, true);
        if (typeof window !== "undefined")
            window.addEventListener("resize", onHintResize);
        disposers.push(() => {
            try {
                document.removeEventListener("pointermove", onHoldMove, true);
            }
            catch (_) { }
            try {
                document.removeEventListener("pointerdown", onHintDismiss, true);
            }
            catch (_) { }
            try {
                document.removeEventListener("scroll", onHintScroll, true);
            }
            catch (_) { }
            try {
                document.removeEventListener("keydown", onHintKey, true);
            }
            catch (_) { }
            try {
                if (typeof window !== "undefined")
                    window.removeEventListener("resize", onHintResize);
            }
            catch (_) { }
            hideHint();
        });
    }
    // ---- toast with an optional Cancel button ----
    function ensureToast() {
        if (typeof document === "undefined")
            return null;
        let t = document.getElementById("__lvRetryToast");
        if (!t) {
            t = document.createElement("div");
            t.id = "__lvRetryToast";
            // Deliberately below the hint popover and the float menu. This appears on
            // its own; those are opened on purpose, and a notification landing on top
            // of a menu turns a tap on "Hide this button" into a tap on Cancel.
            t.style.cssText =
                "position:fixed;bottom:max(20px,env(safe-area-inset-bottom,0px));left:50%;transform:translateX(-50%);" +
                    "z-index:2147483645;display:flex;align-items:center;gap:10px;" +
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
        const t = typeof document !== "undefined" &&
            document.getElementById("__lvRetryToast");
        if (t) {
            clearTimeout(t.__h);
            t.style.opacity = "0";
            t.style.pointerEvents = "none";
        }
    }
    function showToast(msg, opts) {
        // force is for messages the user has to see to understand what the app is
        // doing right now, like the button picker waiting for a click. Everything
        // else still respects the toast setting.
        if (!cfg.toast && !(opts && opts.force))
            return;
        const t = ensureToast();
        if (!t)
            return;
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
                        "background:var(--lumiverse-fill-subtle,rgba(0,0,0,.1));color:var(--lumiverse-text,#fff)";
                c.addEventListener("click", () => {
                    try {
                        opts.cancel && opts.cancel();
                    }
                    catch (_) { }
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
            }
            else {
                t.style.pointerEvents = "none";
            }
            // Both edges are set every time, so a normal toast after a top-anchored one
            // goes back to the bottom. The picker anchors to the top because the
            // buttons it is asking you to click sit at the bottom, under this.
            if (opts && opts.top) {
                t.style.top = "max(20px,env(safe-area-inset-top,0px))";
                t.style.bottom = "auto";
            }
            else {
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
        }
        catch (_) { }
    }
    // ---- debug info for bug reports ----
    // A one-tap snapshot anyone can paste into a report without opening dev tools:
    // version, current settings, whether each button selector matches right now,
    // and the browser string. The console log (above) is the live timeline; this
    // is the still photo.
    // Reports what the retry itself would find, not just whether the selector
    // matches anything, so a match on a hidden or disabled control is not read as
    // a working button.
    function selectorState(sel) {
        const raw = String(sel || "").trim();
        if (!raw)
            return "not set";
        if (find(raw))
            return "match";
        const parts = splitSelectorList(raw);
        let anyValid = false;
        for (const part of parts) {
            try {
                if (document.querySelector(part))
                    return "match, not clickable right now";
                anyValid = true;
            }
            catch (_) { }
        }
        return anyValid ? "no match" : "invalid selector";
    }
    function buildDebugInfo(opts) {
        const o = opts || {};
        const inc = (v) => v !== false; // sections default to on
        // Taken from the schema rather than listed again here. The old hand-kept
        // list had drifted, so settings added later were missing from every report,
        // which is exactly the information a bug report is supposed to carry. The
        // selectors are printed in full by the buttons section below instead.
        const keys = Object.keys(fieldByKey).filter((k) => !fieldByKey[k].selector);
        const lines = [];
        lines.push("Auto Retry v" + VERSION + " debug info");
        lines.push("time: " + new Date().toISOString());
        // Always included, whatever categories are ticked. This is the first thing
        // to check when retries have stopped happening, so it must never be the
        // part someone left out of the report.
        const pauseLeftMs = pausedUntil - Date.now();
        lines.push("auto-retry: " +
            (cfg.enabled === false
                ? "off in settings"
                : cfg.pauseWhenFailing && pauseLeftMs > 0
                    ? "PAUSED by the failure breaker, " +
                        Math.ceil(pauseLeftMs / 1000) +
                        "s left"
                    : "active") +
            " (failed runs in a row: " + failedRuns + " of " + breakerRuns() + ")");
        if (inc(o.settings)) {
            lines.push("");
            lines.push("settings:");
            for (const k of keys)
                lines.push("  " + k + ": " + JSON.stringify(cfg[k]));
        }
        if (inc(o.buttons)) {
            lines.push("");
            lines.push("buttons (checked right now):");
            lines.push("  retry mode: " +
                (cfg.retryByNewReroll
                    ? "new reroll (swipe first, regenerate as fallback)"
                    : "regenerate (swipe as fallback)"));
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
                lines.push("browser: " + ((navigator && navigator.userAgent) || "unknown"));
            }
            catch (_) { }
            try {
                lines.push("screen: " +
                    ((window && window.innerWidth) || "?") +
                    " x " +
                    ((window && window.innerHeight) || "?"));
            }
            catch (_) { }
        }
        if (inc(o.activity)) {
            lines.push("");
            lines.push("this session:");
            lines.push("  replies that came back fine: " + stats.good);
            lines.push("  retries fired: " + stats.retries);
            lines.push("  messages it gave up on: " + stats.gaveUp);
            const reasons = Object.keys(stats.reasons).sort((a, b) => stats.reasons[b] - stats.reasons[a]);
            if (reasons.length) {
                lines.push("  retries by reason:");
                for (const r of reasons)
                    lines.push("    " + r + ": " + stats.reasons[r]);
            }
            lines.push("");
            lines.push("recent activity (oldest first):");
            if (eventLog.length === 0)
                lines.push("  (nothing recorded yet)");
            else
                for (const e of eventLog)
                    lines.push("  " + e);
        }
        return lines.join("\n");
    }
    function fallbackCopy(text) {
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
        }
        catch (_) {
            return false;
        }
    }
    function copyText(text) {
        try {
            if (typeof navigator !== "undefined" &&
                navigator.clipboard &&
                navigator.clipboard.writeText) {
                return navigator.clipboard.writeText(text).then(() => true, () => fallbackCopy(text));
            }
        }
        catch (_) { }
        return Promise.resolve(fallbackCopy(text));
    }
    // Save text as a file download. Returns false if the browser blocks it.
    function downloadText(filename, text) {
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
                }
                catch (_) { }
            }, 1000);
            return true;
        }
        catch (_) {
            return false;
        }
    }
    // Read a chosen file as text and hand it to cb.
    function readFileAsText(file, cb) {
        try {
            const reader = new FileReader();
            reader.onload = () => cb(typeof reader.result === "string" ? reader.result : null);
            reader.onerror = () => cb(null);
            reader.readAsText(file);
        }
        catch (_) {
            cb(null);
        }
    }
    // ---- settings UI ----
    let modalHandle = null;
    let modalRoot = null;
    let modalSnapshot = null;
    // Every saved value as it stood when the panel opened. Closing with the X or
    // a tap outside puts these back, so nothing sticks unless Save is pressed.
    // Held out here rather than inside openSettings because the on/off switch can
    // also be flipped from the floating button while the panel is open, and that
    // has to land here too or dismissing the panel would quietly undo it.
    let modalBaseline = null;
    // Close function for the open expand-editor overlay, if any, so it can be shut
    // when the settings modal closes instead of being left floating.
    let closeExpandEditor = null;
    function buildSettingsBody(root, onSaved) {
        ensurePanelStyle();
        // The buttons a popover can be anchored to are about to be thrown away.
        hideHint();
        root.innerHTML = "";
        fieldSetters = {};
        // The rows the old one closed over have just been thrown away with the
        // panel, so it is put back to doing nothing until the new one assigns it.
        applyDeps = () => { };
        presetBarRefreshers = [];
        // A preset switcher: pick a saved preset and Load it into the settings, or
        // save the current settings as a preset. Load updates the on-screen fields in
        // place (no rebuild), so it never jumps the scroll or closes open sections.
        function buildPresetBar(kind) {
            const wrap = document.createElement("div");
            wrap.style.cssText = "display:flex;flex-direction:column;gap:8px";
            const smallBtn = (b) => {
                b.style.cssText += "min-height:0;padding:7px 12px";
                return b;
            };
            const miniLabel = (text) => {
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
            // Flush a field the user is still editing into cfg before we snapshot it.
            const commit = () => {
                const active = typeof document !== "undefined" ? document.activeElement : null;
                if (active && typeof active.blur === "function")
                    active.blur();
                for (const g of SCHEMA)
                    for (const fl of g.fields)
                        if (fl.type === "num")
                            cfg[fl.key] = clampField(fl, cfg[fl.key]);
            };
            // A control that cannot do anything yet should look that way, rather than
            // sitting there fully lit and then telling you off when you press it.
            // With nothing saved, Load, Update, Delete and Rename all had a live
            // primary button each and nothing to act on.
            const setEnabled = (b, on) => {
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
            const refreshSelect = (selectName) => {
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
                if (selectName)
                    select.value = selectName;
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
                    if (fld && fld.type === "num")
                        cfg[k] = clampField(fld, cfg[k]);
                    if (fieldSetters[k])
                        fieldSetters[k](cfg[k]);
                }
                applyDeps();
                saveSaved();
                saveToAccount();
                syncLiveLog();
                syncFloat();
                syncInputBarActions();
                if (onSaved)
                    onSaved();
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
                }
                catch (_) { }
                if (!ok)
                    return;
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
        // Somewhere to try the refusal settings on real text. Without this the whole
        // section is guesswork: you edit a phrase list, then have to wait for the
        // model to refuse again to find out whether it worked, and a wrong guess
        // costs a re-roll of good writing. This runs the same check a finished reply
        // goes through, against the values in the boxes above rather than the saved
        // ones, so it answers straight away and nothing is sent anywhere.
        function buildRefusalTester() {
            const wrap = document.createElement("div");
            wrap.style.cssText = "display:flex;flex-direction:column;gap:8px";
            const rule = document.createElement("div");
            rule.style.cssText =
                "height:1px;background:var(--lumiverse-border,rgba(255,255,255,.08));margin:4px 0 2px";
            wrap.appendChild(rule);
            const title = document.createElement("div");
            title.textContent = "Try it on a reply";
            title.style.cssText =
                "font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--lumiverse-text-muted,rgba(255,255,255,.65))";
            wrap.appendChild(title);
            const desc = document.createElement("div");
            desc.textContent =
                "Paste a reply and see whether it would count as a refusal, and what decided it. It uses the settings as they are in the boxes above, so you can test a change before saving it. Nothing is sent anywhere and no reply is altered.";
            desc.style.cssText =
                "font-size:12px;line-height:1.45;color:var(--lumiverse-text-muted,rgba(255,255,255,.65))";
            wrap.appendChild(desc);
            const ta = document.createElement("textarea");
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
            const check = btn("Check this text", false);
            check.style.cssText += "min-height:0;padding:6px 12px;align-self:flex-start";
            check.addEventListener("click", () => {
                // A box the user is still typing in has not fired its change event yet,
                // so its edit is not in cfg. Blurring first is what makes the test
                // reflect what is actually on screen.
                const active = typeof document !== "undefined" ? document.activeElement : null;
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
                        "Counts as a refusal, so a retry would fire - " +
                            v.reason +
                            (cfg.retryOnRefusal
                                ? "."
                                : '. (But "It looks like an accidental refusal" is off, so nothing would actually be retried.)');
                    out.style.color = "var(--lumiverse-success,#22c55e)";
                }
                else {
                    out.textContent =
                        "Reads as normal writing, so no retry - " + v.reason + ".";
                    out.style.color = "var(--lumiverse-text-muted,rgba(255,255,255,.65))";
                }
                ensureReadable(out, 2.6);
            });
            wrap.appendChild(check);
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
        matchColorScheme(panel);
        // the one scroll area: flexes to fill whatever height is left after the
        // footer. min-height:0 lets it actually shrink and scroll inside the flex.
        const scroller = document.createElement("div");
        scroller.style.cssText =
            "display:flex;flex-direction:column;gap:18px;flex:1 1 auto;min-height:0;overflow-y:auto;padding-right:4px";
        const panelSections = [];
        const searchRows = [];
        // Labelled runs of rows inside a group, hidden by a search once none of
        // their rows match so a heading is never left standing over nothing.
        const subRuns = [];
        // Rows that only mean something while some switch is on. Kept out of the
        // panel while it is off, so what is on screen is what is in use.
        const depRows = [];
        const depSections = [];
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
        const depNotes = [];
        const nameOf = (k) => {
            const f = fieldByKey[k];
            return f ? f.label : k;
        };
        const paintDepNotes = (searching) => {
            for (const d of depNotes) {
                const unmet = d.groups.filter((g) => !g.some((k) => !!cfg[k]));
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
        let searchBox = null;
        // Same reason as searchBox: applyDeps is defined long before this element
        // is built, and a const would still be in its dead zone if it ever ran early.
        let masterNoteEl = null;
        applyDeps = () => {
            // Ahead of the search guard: whether the master switch is off has nothing
            // to do with what is being searched for, and this must not go stale.
            if (masterNoteEl)
                masterNoteEl.style.display = cfg.enabled === false ? "block" : "none";
            if (searchBox && String(searchBox.value || "").trim()) {
                // The rows stay where the search put them, but the line naming the
                // switch a row is waiting on does not: turning that switch on from the
                // search results left the row still claiming to be waiting for it.
                paintDepNotes(true);
                return;
            }
            for (const d of depRows) {
                const on = d.needs.some((k) => !!cfg[k]);
                d.row.style.display = on ? "flex" : "none";
            }
            for (const d of depSections) {
                const on = d.needs.some((k) => !!cfg[k]);
                d.sec.style.display = on ? "flex" : "none";
            }
            // A run whose rows have all gone takes its heading with it, the same way
            // it does under a search.
            for (const w of subRuns) {
                const rows = w.querySelectorAll("[data-ar-row]");
                let any = rows.length === 0;
                for (let i = 0; i < rows.length; i++)
                    if (rows[i].style.display !== "none")
                        any = true;
                w.style.display = any ? "flex" : "none";
            }
            paintDepNotes(false);
        };
        const searchText = (...parts) => parts.map((p) => String(p == null ? "" : p)).join(" ").toLowerCase();
        // Every collapsible header goes through here. They were plain elements with
        // a click handler, which left all five collapsed sections unreachable
        // without a pointer: no tab stop, and nothing telling a screen reader that
        // the header opened anything. Doing it in one place also means the caret,
        // the remembered open state and the announced state cannot drift apart,
        // which they could when this was written out three times over.
        function makeCollapsible(h, body, caret, title) {
            const apply = (v) => {
                body.style.display = v ? "flex" : "none";
                caret.textContent = v ? CARET_OPEN : CARET_SHUT;
                h.setAttribute("aria-expanded", v ? "true" : "false");
            };
            h.setAttribute("role", "button");
            h.setAttribute("tabindex", "0");
            const toggle = () => {
                const open = body.style.display !== "none";
                apply(!open);
                if (!open)
                    openGroups.add(title);
                else
                    openGroups.delete(title);
            };
            h.addEventListener("click", toggle);
            h.addEventListener("keydown", (e) => {
                if (!e)
                    return;
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
            sec.style.cssText = "display:flex;flex-direction:column;gap:10px";
            const handle = {
                sec: sec,
                title: group.title,
                keywords: searchText(group.title, group.desc),
                setOpen: null,
            };
            panelSections.push(handle);
            if (group.needs && group.needs.length)
                depSections.push({ sec: sec, needs: group.needs });
            const addRow = (row, f) => {
                searchRows.push({
                    row: row,
                    text: searchText(f.label, f.hint, f.key, group.title),
                    section: handle,
                });
                if (f.needs && f.needs.length)
                    depRows.push({ row: row, needs: f.needs });
                const groups = [];
                if (group.needs && group.needs.length)
                    groups.push(group.needs);
                if (f.needs && f.needs.length)
                    groups.push(f.needs);
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
            const subGroup = (into, title, note) => {
                const wrap = document.createElement("div");
                wrap.style.cssText = "display:flex;flex-direction:column;gap:10px";
                const h2 = document.createElement("div");
                h2.textContent = title;
                h2.style.cssText =
                    "font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--lumiverse-text-muted,rgba(255,255,255,.65))";
                wrap.appendChild(h2);
                const n = document.createElement("div");
                n.textContent = note;
                n.style.cssText =
                    "font-size:12px;line-height:1.45;margin-top:-4px;color:var(--lumiverse-text-muted,rgba(255,255,255,.65))";
                wrap.appendChild(n);
                into.appendChild(wrap);
                subRuns.push(wrap);
                return wrap;
            };
            // Find and replace is split by what a preset carries. Half these options
            // change when you load a preset and half never do, and there was no way
            // to tell which from looking. The split is worked out from the preset
            // definition rather than written out a second time, so the headings
            // cannot end up claiming something that is not true.
            const emitFields = (into) => {
                if (!/find and replace/i.test(group.title)) {
                    for (const f of group.fields)
                        into.appendChild(addRow(buildRow(f), f));
                    return;
                }
                const held = keysForKind("swap");
                const isHeld = (f) => held.indexOf(f.key) >= 0;
                // The main switch stays at the top on its own; it reads as the heading
                // for the whole section rather than as one of the options below it.
                for (const f of group.fields)
                    if (f.key === "replaceEnabled")
                        into.appendChild(addRow(buildRow(f), f));
                const rest = group.fields.filter((f) => f.key !== "replaceEnabled");
                const a = subGroup(into, "Saved in a preset", "Loading a preset replaces these, and saving one stores them.");
                for (const f of rest)
                    if (isHeld(f))
                        a.appendChild(addRow(buildRow(f), f));
                const b = subGroup(into, "Yours, whatever preset you load", "No preset touches these. Loading a preset cannot switch swapping on for you, or take away the confirmation step.");
                for (const f of rest)
                    if (!isHeld(f))
                        b.appendChild(addRow(buildRow(f), f));
            };
            // Groups titled "Advanced..." collapse by default so the basic options
            // aren't buried under them. Tap the header to reveal.
            const advanced = /^advanced\b/i.test(group.title);
            const h = document.createElement("div");
            h.style.cssText =
                "font-size:11px;letter-spacing:.07em;text-transform:uppercase;font-family:var(--lumiverse-font-family,system-ui);color:var(--lumiverse-text-muted,rgba(255,255,255,.65))";
            if (advanced) {
                h.style.cursor = "pointer";
                h.style.userSelect = "none";
                h.style.display = "flex";
                h.style.alignItems = "center";
                h.style.gap = "6px";
                const caret = document.createElement("span");
                caret.textContent = CARET_SHUT;
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
                        "font-size:12px;line-height:1.45;color:var(--lumiverse-text-muted,rgba(255,255,255,.65))";
                    body.appendChild(d);
                }
                emitFields(body);
                // The refusal tuning options are all guesswork without a way to try
                // them, so the section carries its own tester.
                if (/refusal tuning/i.test(group.title)) {
                    body.appendChild(buildRefusalTester());
                }
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
                        "font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--lumiverse-text-muted,rgba(255,255,255,.65))";
                    body.appendChild(pl);
                    const pd = document.createElement("div");
                    pd.textContent =
                        "Save your current word swaps as a named setup and switch between them. Applying takes effect right away. Saved to your account, so they follow you to other devices.";
                    pd.style.cssText =
                        "font-size:12px;line-height:1.45;color:var(--lumiverse-text-muted,rgba(255,255,255,.65))";
                    body.appendChild(pd);
                    body.appendChild(buildPresetBar("swap"));
                }
                sec.appendChild(body);
                handle.setOpen = makeCollapsible(h, body, caret, group.title);
            }
            else {
                h.textContent = group.title;
                sec.appendChild(h);
                if (group.desc) {
                    const d = document.createElement("div");
                    d.textContent = group.desc;
                    d.style.cssText =
                        "font-size:12px;line-height:1.45;color:var(--lumiverse-text-muted,rgba(255,255,255,.65));margin-top:-4px";
                    sec.appendChild(d);
                }
                emitFields(sec);
            }
            scroller.appendChild(sec);
        }
        // debug info section (collapsible): choose what to include, review, redact, copy
        {
            const sec = document.createElement("div");
            sec.style.cssText = "display:flex;flex-direction:column;gap:10px";
            const h = document.createElement("div");
            h.style.cssText =
                "font-size:11px;letter-spacing:.07em;text-transform:uppercase;font-family:var(--lumiverse-font-family,system-ui);color:var(--lumiverse-text-muted,rgba(255,255,255,.65));cursor:pointer;user-select:none;display:flex;align-items:center;gap:6px";
            const caret = document.createElement("span");
            caret.textContent = CARET_SHUT;
            caret.style.cssText = "font-size:9px";
            const label = document.createElement("span");
            label.textContent = "Advanced: debug info";
            h.appendChild(caret);
            h.appendChild(label);
            sec.appendChild(h);
            const handle = {
                sec: sec,
                title: "Advanced: debug info",
                keywords: "advanced debug info bug report copy diagnostics activity log version",
                setOpen: null,
            };
            panelSections.push(handle);
            const body = document.createElement("div");
            body.style.cssText = "display:none;flex-direction:column;gap:10px";
            const desc = document.createElement("div");
            desc.textContent =
                "A snapshot for your own debugging or a bug report. Tick the parts to include, build a preview, edit out anything you would rather not share, then copy. Nothing leaves your device until you paste it somewhere.";
            desc.style.cssText =
                "font-size:12px;line-height:1.45;color:var(--lumiverse-text-muted,rgba(255,255,255,.65))";
            body.appendChild(desc);
            const sections = [
                { id: "settings", label: "Your settings" },
                { id: "buttons", label: "Button match status" },
                { id: "environment", label: "Browser and screen" },
                { id: "activity", label: "Session totals and recent activity" },
            ];
            const dchecks = [];
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
                    "accent-color:var(--lumiverse-primary,rgba(147,112,219,.9));cursor:pointer";
                const txt = document.createElement("span");
                txt.textContent = s.label;
                row.appendChild(cb);
                row.appendChild(txt);
                dWrap.appendChild(row);
                dchecks.push({ id: s.id, input: cb });
            }
            body.appendChild(dWrap);
            const opts = () => {
                const o = {};
                for (const c of dchecks)
                    o[c.id] = c.input.checked;
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
                if (!dArea.value.trim())
                    dArea.value = buildDebugInfo(opts());
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
            handle.setOpen = makeCollapsible(h, body, caret, "Advanced: debug info");
            scroller.appendChild(sec);
        }
        // import / export section (collapsible, same look as the Advanced groups)
        {
            const sec = document.createElement("div");
            sec.style.cssText = "display:flex;flex-direction:column;gap:10px";
            const h = document.createElement("div");
            h.style.cssText =
                "font-size:11px;letter-spacing:.07em;text-transform:uppercase;font-family:var(--lumiverse-font-family,system-ui);color:var(--lumiverse-text-muted,rgba(255,255,255,.65));cursor:pointer;user-select:none;display:flex;align-items:center;gap:6px";
            const caret = document.createElement("span");
            caret.textContent = CARET_SHUT;
            caret.style.cssText = "font-size:9px";
            const label = document.createElement("span");
            label.textContent = "Advanced: import / export";
            h.appendChild(caret);
            h.appendChild(label);
            sec.appendChild(h);
            const handle = {
                sec: sec,
                title: "Advanced: import / export",
                keywords: "advanced import export backup file share transfer settings presets json",
                setOpen: null,
            };
            panelSections.push(handle);
            const body = document.createElement("div");
            body.style.cssText = "display:none;flex-direction:column;gap:10px";
            const desc = document.createElement("div");
            desc.textContent =
                "Save settings to a file or load them from one. Tick the parts to include, then Export or Import. An import fills in the settings above without saving, so you can review first: press Save to keep it, or close to discard.";
            desc.style.cssText =
                "font-size:12px;line-height:1.45;color:var(--lumiverse-text-muted,rgba(255,255,255,.65))";
            body.appendChild(desc);
            const checks = [];
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
                    "accent-color:var(--lumiverse-primary,rgba(147,112,219,.9));cursor:pointer";
                const txt = document.createElement("span");
                txt.textContent = c.label;
                row.appendChild(cb);
                row.appendChild(txt);
                checkWrap.appendChild(row);
                checks.push({ id: c.id, input: cb });
            }
            body.appendChild(checkWrap);
            const chosen = () => checks.filter((x) => x.input.checked).map((x) => x.id);
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
                if (!f)
                    return;
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
                        let data = null;
                        try {
                            data = JSON.parse(text);
                        }
                        catch (_) { }
                        presetCount = importPresets(data);
                        if (presetCount === -1) {
                            status.textContent =
                                "Couldn't save the imported presets on this browser.";
                            return;
                        }
                        if (presetCount > 0)
                            for (const r of presetBarRefreshers)
                                r();
                    }
                    if (!applied.length && !presetCount) {
                        status.textContent = "Nothing matched the ticked parts in that file.";
                        return;
                    }
                    // Reflect imported settings in the visible fields without a rebuild,
                    // so the panel doesn't jump back to the top.
                    for (const k of Object.keys(fieldSetters))
                        fieldSetters[k](cfg[k]);
                    applyDeps();
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
            handle.setOpen = makeCollapsible(h, body, caret, "Advanced: import / export");
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
        styleField(search);
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
                for (const r of searchRows)
                    r.row.style.display = "flex";
                for (const w of subRuns)
                    w.style.display = "flex";
                for (const s of panelSections) {
                    s.sec.style.display = "flex";
                    if (s.setOpen)
                        s.setOpen(openGroups.has(s.title));
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
                    if (r.section !== s)
                        continue;
                    const hit = titleHit || r.text.indexOf(q) >= 0;
                    r.row.style.display = hit ? "flex" : "none";
                    if (hit) {
                        any = true;
                        hits++;
                    }
                }
                s.sec.style.display = any ? "flex" : "none";
                if (any && s.setOpen)
                    s.setOpen(true);
            }
            // A heading with nothing left under it reads as a mistake, so a run goes
            // once its last row does.
            for (const w of subRuns) {
                const rows = w.querySelectorAll("[data-ar-row]");
                let any = false;
                for (let i = 0; i < rows.length; i++)
                    if (rows[i].style.display !== "none")
                        any = true;
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
        const masterNote = document.createElement("div");
        masterNote.style.cssText =
            "display:none;flex:none;margin:0 0 10px;font-size:12px;line-height:1.45;" +
                "color:var(--lumiverse-text-muted,rgba(255,255,255,.65))";
        masterNote.textContent =
            "Auto Retry is off. These settings are saved and apply when you turn it back on.";
        // Above the search box rather than below it. This is the panel's own state
        // and it stays put, while the line under the box is about the search and
        // comes and goes, so the lasting one reads first.
        panel.appendChild(masterNote);
        masterNoteEl = masterNote;
        panel.appendChild(searchWrap);
        panel.appendChild(scroller);
        // footer: a plain bar below the scroll area, set off by a single hairline
        // rule. flex-wrap lets the buttons stack on a narrow phone screen.
        const actions = document.createElement("div");
        actions.style.cssText =
            "display:flex;align-items:center;flex-wrap:wrap;gap:8px;flex:none;margin-top:14px;padding-top:14px;border-top:1px solid var(--lumiverse-border,rgba(255,255,255,.08))";
        const status = document.createElement("span");
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
            // Commit a field the user is still editing, then normalise every number
            // so a blank or out-of-range box can't be saved.
            const active = typeof document !== "undefined" ? document.activeElement : null;
            if (active && typeof active.blur === "function")
                active.blur();
            for (const g of SCHEMA)
                for (const fl of g.fields)
                    if (fl.type === "num")
                        cfg[fl.key] = clampField(fl, cfg[fl.key]);
            saveSaved();
            saveToAccount();
            syncLiveLog();
            syncFloat();
            syncInputBarActions();
            if (onSaved)
                onSaved();
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
    function buildRow(f) {
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
            const info = document.createElement("button");
            info.type = "button";
            info.textContent = "?";
            info.setAttribute("aria-label", "Show description for " + f.label);
            // Marks it for the dismiss handler, which leaves the "?" alone so its own
            // click can close a popover rather than closing and reopening it.
            info.setAttribute("data-ar-hint", "1");
            if (f.hintAbove)
                info.setAttribute("data-ar-hint-above", "1");
            info.style.cssText =
                "flex:none;width:18px;height:18px;padding:0;line-height:1;border-radius:50%;border:1px solid var(--lumiverse-border,rgba(255,255,255,.3));background:transparent;color:var(--lumiverse-text-muted,rgba(255,255,255,.65));font-size:11px;cursor:pointer";
            const paint = (on) => {
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
            // Mouse devices reveal on hover (and keyboard focus); touch devices, which
            // can't hover, toggle on tap.
            const canHover = typeof window !== "undefined" &&
                !!window.matchMedia &&
                window.matchMedia("(hover: hover)").matches;
            if (canHover) {
                info.addEventListener("mouseenter", open);
                info.addEventListener("mouseleave", () => {
                    if (mine())
                        hideHint();
                });
                info.addEventListener("focus", open);
                info.addEventListener("blur", () => {
                    if (mine())
                        hideHint();
                });
            }
            info.addEventListener("click", (e) => {
                // Stop the row-label from toggling its control when the button is clicked.
                if (e) {
                    e.preventDefault();
                    e.stopPropagation();
                }
                // On touch, click toggles. On a mouse, hover already handles it.
                if (canHover)
                    return;
                if (mine())
                    hideHint();
                else
                    open();
            });
            labelWrap.appendChild(info);
        }
        top.appendChild(labelWrap);
        if (f.type === "bool") {
            const input = document.createElement("input");
            input.type = "checkbox";
            input.checked = !!cfg[f.key];
            input.style.cssText =
                "flex:none;width:20px;height:20px;accent-color:var(--lumiverse-primary,rgba(147,112,219,.9));cursor:pointer";
            input.addEventListener("change", () => {
                cfg[f.key] = input.checked;
                // Rows that hang off this switch appear or go with it.
                applyDeps();
            });
            fieldSetters[f.key] = (v) => {
                input.checked = !!v;
            };
            top.appendChild(input);
            row.appendChild(top);
        }
        else if (f.type === "notes") {
            row.appendChild(top);
            const list = document.createElement("div");
            list.style.cssText = "display:flex;flex-direction:column;gap:8px";
            const foot = document.createElement("div");
            foot.style.cssText = "display:flex;align-items:center;gap:8px;flex-wrap:wrap";
            const add = btn("+", false);
            const count = document.createElement("span");
            count.style.cssText =
                "font-size:11px;color:var(--lumiverse-text-muted,rgba(255,255,255,.65))";
            for (const b2 of [add])
                b2.style.cssText += "min-height:0;padding:4px 12px;flex:none";
            // Held here rather than read back off the DOM, so a half-typed row is
            // still the value the panel is holding.
            let notes = coerce("notes", cfg[f.key], CONFIG[f.key], f);
            const push = () => {
                cfg[f.key] = notes.map((n) => ({ text: n.text, role: n.role }));
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
                        });
                        push();
                    });
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
                        if (notes.length <= 1)
                            return;
                        notes.splice(i, 1);
                        push();
                        draw();
                    });
                    bar.appendChild(num);
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
            add.addEventListener("pointerdown", (e) => {
                addedWith = (e && e.pointerType) || "";
            });
            add.addEventListener("click", () => {
                const finger = addedWith === "touch" || addedWith === "pen";
                addedWith = "";
                if (notes.length >= MAX_NOTES)
                    return;
                notes.push({ text: "", role: notes.length ? notes[notes.length - 1].role : "system" });
                push();
                draw();
                const boxes = list.querySelectorAll("textarea");
                const last = boxes[boxes.length - 1];
                if (!last)
                    return;
                // Either way the new note is brought into view. Without focus to do it,
                // a note added at the bottom of a long list would be off screen.
                if (finger) {
                    if (last.scrollIntoView)
                        try {
                            last.scrollIntoView({ block: "nearest" });
                        }
                        catch (_) { }
                    return;
                }
                if (last.focus)
                    try {
                        last.focus({ preventScroll: true });
                    }
                    catch (_) { }
            });
            fieldSetters[f.key] = (v) => {
                notes = coerce("notes", v, CONFIG[f.key], f);
                draw();
            };
            draw();
            foot.appendChild(add);
            foot.appendChild(count);
            row.appendChild(list);
            row.appendChild(foot);
        }
        else if (f.type === "pick") {
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
                cfg[f.key] = coerce("pick", sel.value, CONFIG[f.key], f);
            });
            fieldSetters[f.key] = (v) => {
                sel.value = coerce("pick", v, CONFIG[f.key], f);
            };
            top.appendChild(sel);
            row.appendChild(top);
        }
        else if (f.type === "num") {
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
            fieldSetters[f.key] = (v) => {
                input.value = String(v);
            };
            top.appendChild(input);
            row.appendChild(top);
        }
        else {
            row.appendChild(top);
            const isMultiline = !f.selector;
            const input = document.createElement(isMultiline ? "textarea" : "input");
            if (isMultiline) {
                input.rows = 4;
                input.style.resize = "vertical";
                const expand = btn("Expand", false);
                expand.style.cssText +=
                    "min-height:0;padding:3px 10px;font-size:12px;flex:none";
                expand.addEventListener("click", () => {
                    openExpandEditor(f.label, input.value, (val) => {
                        input.value = val;
                        cfg[f.key] = val;
                    });
                });
                top.appendChild(expand);
            }
            else {
                input.type = "text";
            }
            input.value = String(cfg[f.key]);
            input.setAttribute("aria-label", f.label);
            styleField(input);
            input.addEventListener("change", () => {
                cfg[f.key] = input.value;
            });
            fieldSetters[f.key] = (v) => {
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
    function styleField(input) {
        input.style.cssText +=
            "padding:9px 10px;border-radius:var(--lumiverse-radius,8px);" +
                "border:1px solid var(--lumiverse-border,rgba(255,255,255,.16));" +
                "background:var(--lumiverse-fill-subtle,rgba(0,0,0,.1));" +
                "color:var(--lumiverse-text,#eee);font:13px var(--lumiverse-font-family,system-ui);outline:none;" +
                "transition:border-color var(--lumiverse-transition-fast,150ms ease)";
        ensureReadable(input);
        // On focus, tint the border so the active field is clear. No glow ring.
        input.addEventListener("focus", () => {
            input.style.borderColor = "var(--lumiverse-primary,rgba(147,112,219,.9))";
        });
        input.addEventListener("blur", () => {
            input.style.borderColor = "var(--lumiverse-border,rgba(255,255,255,.16))";
        });
    }
    function btn(label, primary) {
        const b = document.createElement("button");
        b.textContent = label;
        b.style.cssText =
            "min-height:36px;padding:8px 14px;border-radius:var(--lumiverse-radius,8px);cursor:pointer;" +
                "font:13px var(--lumiverse-font-family,system-ui);" +
                "transition:filter var(--lumiverse-transition-fast,150ms ease)," +
                "background-color var(--lumiverse-transition-fast,150ms ease);" +
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
        if (primary)
            ensureEdge(b);
        // Hovering swaps to the theme's own hover colour rather than brightening the
        // resting one, so a button lights up the same way the rest of Lumiverse does.
        const restBg = primary
            ? "var(--lumiverse-primary,rgba(147,112,219,.9))"
            : "var(--lumiverse-secondary,rgba(128,128,128,.15))";
        const hoverBg = primary
            ? "var(--lumiverse-primary-hover,rgba(167,132,239,.95))"
            : "var(--lumiverse-secondary-hover,rgba(128,128,128,.25))";
        const setBg = (v) => {
            b.style.background = v;
            // A theme is free to make its hover colour lighter or darker than the
            // resting one, so the label is checked against whichever is showing.
            ensureReadable(b);
        };
        b.addEventListener("mouseenter", () => setBg(hoverBg));
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
    // Reset used to be one button that put every setting back at once. That is
    // the rarest thing anyone actually wants: the usual case is one part having
    // been fiddled into a mess, most often the button selectors, since Pick it
    // for me makes those easy to overwrite with the wrong element. Undoing that
    // meant losing your word swaps, your refusal phrases and your note along with
    // it, so there was a second button for selectors alone and nothing for
    // anything else.
    //
    // The parts are the same ones import and export already use, so there is one
    // definition of what a part is and the names match between the two panels.
    //
    // Nothing is reset silently. The picker says, per part, how many settings
    // would actually change, so a part already at its defaults is visibly nothing
    // to press, and it says in plain words what it does not touch.
    function resetPartsFor() {
        return EXPORT_CATEGORIES.filter((c) => c.id !== "presets").map((c) => ({
            id: c.id,
            label: c.label,
            keys: c.keys.slice(),
        }));
    }
    // Two settings can hold arrays (the note list), so an identity check is not
    // enough to tell "changed" from "the same as it shipped".
    function sameAsDefault(key) {
        const a = cfg[key];
        const b = CONFIG[key];
        if (a === b)
            return true;
        if (typeof a === "object" || typeof b === "object") {
            try {
                return JSON.stringify(a) === JSON.stringify(b);
            }
            catch (_) {
                return false;
            }
        }
        return false;
    }
    function changedCount(keys) {
        let n = 0;
        for (const k of keys)
            if (!sameAsDefault(k))
                n++;
        return n;
    }
    // Puts the chosen parts back to what the extension shipped with, in the panel
    // only. Save keeps it, closing the panel discards it, which is the same deal
    // import already offers and the same one the old selector-only reset offered.
    // Presets are the exception and are called out as such in the picker: they
    // live outside the settings object and are deleted for real.
    function applyReset(ids, alsoPresets) {
        let settings = 0;
        for (const part of resetPartsFor()) {
            if (ids.indexOf(part.id) < 0)
                continue;
            for (const k of part.keys) {
                if (!sameAsDefault(k))
                    settings++;
                // Copied, not pointed at. The note list is an array, and handing cfg
                // the same array the defaults block holds would leave the two sharing
                // one object for as long as nobody replaced it.
                const def = CONFIG[k];
                cfg[k] = def && typeof def === "object" ? JSON.parse(JSON.stringify(def)) : def;
                const set = fieldSetters[k];
                if (set)
                    set(cfg[k]);
            }
        }
        let presets = 0;
        if (alsoPresets) {
            const stored = loadPresets();
            presets = (stored.swap || []).length;
            if (presets)
                savePresets({ swap: [] });
            for (const r of presetBarRefreshers) {
                try {
                    r();
                }
                catch (_) { }
            }
        }
        applyDeps();
        syncLiveLog();
        syncFloat();
        syncInputBarActions();
        return { settings: settings, presets: presets };
    }
    // Open at a time, so a second press replaces the first rather than stacking.
    let closeResetPicker = null;
    function openResetPicker(onApplied) {
        if (typeof document === "undefined")
            return;
        if (closeResetPicker) {
            try {
                closeResetPicker();
            }
            catch (_) { }
        }
        const parts = resetPartsFor();
        const overlay = document.createElement("div");
        overlay.id = "__lvRetryReset";
        overlay.style.cssText =
            "position:fixed;inset:0;z-index:2147483600;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;background:var(--lumiverse-modal-backdrop,rgba(0,0,0,.6));font-family:var(--lumiverse-font-family,system-ui)";
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
        const checks = [];
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
            cb.style.cssText =
                "accent-color:var(--lumiverse-primary,rgba(147,112,219,.9));cursor:" +
                    (n ? "pointer" : "default");
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
        const presetCount = (loadPresets().swap || []).length;
        const presetRow = document.createElement("label");
        presetRow.setAttribute("data-ar-reset", "presets");
        presetRow.style.cssText =
            "flex:none;display:flex;align-items:center;gap:8px;font-size:13px;cursor:" +
                (presetCount ? "pointer" : "default");
        const presetCb = document.createElement("input");
        presetCb.type = "checkbox";
        presetCb.checked = false;
        presetCb.disabled = presetCount === 0;
        presetCb.style.cssText =
            "accent-color:var(--lumiverse-primary,rgba(147,112,219,.9));cursor:" +
                (presetCount ? "pointer" : "default");
        const presetTxt = document.createElement("span");
        presetTxt.textContent = "Delete saved word swap presets";
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
                "Your saved word swap presets are kept too unless you tick the box above, and that one deletes them straight away rather than waiting for Save.";
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
        const onKey = (e) => {
            if (!e || e.key !== "Escape")
                return;
            try {
                e.stopPropagation();
            }
            catch (_) { }
            try {
                e.preventDefault();
            }
            catch (_) { }
            close();
        };
        function close() {
            try {
                overlay.remove();
            }
            catch (_) { }
            try {
                document.removeEventListener("keydown", onKey, true);
            }
            catch (_) { }
            if (closeResetPicker === close)
                closeResetPicker = null;
        }
        all.addEventListener("click", () => {
            // Only what there is something to do to, so this never ticks a row that
            // reads "already default" right next to it. Deliberately does not reach
            // the presets line: that one deletes something for real and has no Save
            // to think again at, so it is only ever ticked on purpose.
            for (const c of checks)
                if (!c.input.disabled)
                    c.input.checked = true;
            status.textContent = "";
        });
        cancel.addEventListener("click", close);
        // ---- the confirmation step ----
        // Pressing Reset ticked asks before it does anything, and the asking is
        // done here rather than through the host's confirm dialog. Two reasons.
        // The host may not offer one, and the old all-or-nothing reset treated a
        // missing dialog as a yes, which is the wrong way round for the one control
        // that throws settings away. And a host dialog can only be handed a fixed
        // sentence, where this one names the parts, counts the settings in them,
        // and says which of the two things about to happen can be undone.
        //
        // The boxes are frozen while it is up, so what the summary says and what
        // the button does cannot come apart.
        const confirmWrap = document.createElement("div");
        confirmWrap.style.cssText =
            "display:none;flex-direction:column;gap:8px;flex:none;padding:10px;border-radius:var(--lumiverse-radius,8px);border:1px solid var(--lumiverse-border,rgba(255,255,255,.16));background:var(--lumiverse-fill-subtle,rgba(0,0,0,.1))";
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
        confirmWrap.appendChild(confirmText);
        confirmWrap.appendChild(confirmRow);
        // The boxes that were tickable when the picker opened. Held here because
        // freezing sets disabled on them, which would otherwise make the ones that
        // started out disabled indistinguishable from the ones that did not, and
        // Go back would hand them all back tickable.
        const tickable = checks
            .filter((c) => !c.input.disabled)
            .map((c) => c.input);
        if (!presetCb.disabled)
            tickable.push(presetCb);
        const freeze = (frozen) => {
            // disabled rather than pointer-events, so a keyboard cannot change a tick
            // the summary has already been written from. The rows keep their normal
            // colour, so the list stays readable while it is being read.
            for (const input of tickable)
                input.disabled = frozen;
            all.disabled = frozen;
            go.disabled = frozen;
            row.style.display = frozen ? "none" : "flex";
            confirmWrap.style.display = frozen ? "flex" : "none";
        };
        // What is about to happen, in the order it happens, with the reversible
        // half and the permanent half kept apart.
        const describe = (ids, withPresets) => {
            const named = parts
                .filter((p) => ids.indexOf(p.id) >= 0)
                .map((p) => {
                const n = changedCount(p.keys);
                return p.label + " (" + n + (n === 1 ? " setting)" : " settings)");
            });
            const lines = [];
            if (named.length)
                lines.push("Put back to defaults: " +
                    named.join(", ") +
                    ". Nothing else is touched, and closing the panel without saving undoes it.");
            if (withPresets)
                lines.push("Delete " +
                    presetCount +
                    (presetCount === 1 ? " saved word swap preset" : " saved word swap presets") +
                    ". This one happens straight away and closing the panel will not bring them back.");
            return lines.join(" ");
        };
        back.addEventListener("click", () => {
            freeze(false);
            status.textContent = "";
            try {
                go.focus({ preventScroll: true });
            }
            catch (_) { }
        });
        go.addEventListener("click", () => {
            const ids = chosen();
            if (!ids.length && !presetCb.checked) {
                status.textContent = "Tick at least one part to reset.";
                return;
            }
            confirmText.textContent = describe(ids, presetCb.checked);
            status.textContent = "";
            freeze(true);
            // The safe one is where the finger already is, so a second tap in the
            // same place goes back rather than through.
            try {
                back.focus({ preventScroll: true });
            }
            catch (_) { }
        });
        yes.addEventListener("click", () => {
            const ids = chosen();
            const done = applyReset(ids, presetCb.checked);
            close();
            const bits = [];
            if (done.settings)
                bits.push(done.settings +
                    (done.settings === 1 ? " setting put back" : " settings put back") +
                    ". Press Save to keep it");
            else if (ids.length)
                bits.push("those parts were already at their defaults");
            if (done.presets)
                bits.push(done.presets +
                    (done.presets === 1 ? " preset deleted" : " presets deleted"));
            onApplied(done);
            log("reset: " + ids.join(", ") + (presetCb.checked ? " + presets" : ""));
            showToast("Reset: " + bits.join(", ") + ".", { force: true });
        });
        overlay.addEventListener("click", (e) => {
            if (e.target === overlay)
                close();
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
        try {
            box.focus({ preventScroll: true });
        }
        catch (_) { }
        closeResetPicker = close;
    }
    // Full-size editor for a multiline field. Opens a large textarea over the
    // modal so long rule lists are easier to read and edit. Done writes the text
    // back; Cancel, Escape, or a click outside discards.
    function openExpandEditor(label, initial, onDone) {
        if (typeof document === "undefined")
            return;
        // Only one open at a time; shut a stray previous one first.
        if (closeExpandEditor) {
            try {
                closeExpandEditor();
            }
            catch (_) { }
        }
        const overlay = document.createElement("div");
        overlay.style.cssText =
            "position:fixed;inset:0;z-index:2147483600;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;background:var(--lumiverse-modal-backdrop,rgba(0,0,0,.6));font-family:var(--lumiverse-font-family,system-ui)";
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
        const onKey = (e) => {
            if (e && e.key === "Escape")
                close();
        };
        function close() {
            try {
                overlay.remove();
            }
            catch (_) { }
            try {
                document.removeEventListener("keydown", onKey);
            }
            catch (_) { }
            if (closeExpandEditor === close)
                closeExpandEditor = null;
        }
        cancel.addEventListener("click", close);
        done.addEventListener("click", () => {
            onDone(ta.value);
            close();
        });
        overlay.addEventListener("click", (e) => {
            if (e.target === overlay)
                close();
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
    function startPicking(key, label) {
        if (typeof document === "undefined")
            return;
        // Refresh the baseline first: dismissing the modal rolls cfg back to it, so
        // without this every unsaved edit would be lost by opening the picker.
        if (modalSnapshot) {
            try {
                modalSnapshot();
            }
            catch (_) { }
        }
        if (modalHandle) {
            try {
                modalHandle.dismiss();
            }
            catch (_) { }
            modalHandle = null;
        }
        let done = false;
        const finish = (sel, message) => {
            if (done)
                return;
            done = true;
            try {
                document.removeEventListener("click", onPick, true);
            }
            catch (_) { }
            try {
                document.removeEventListener("keydown", onKey, true);
            }
            catch (_) { }
            for (const type of PRESS_EVENTS) {
                try {
                    document.removeEventListener(type, swallow, true);
                }
                catch (_) { }
            }
            hideToast();
            if (sel)
                cfg[key] = sel;
            openSettings();
            if (message)
                showToast(message, { force: true, top: true });
        };
        const onPick = (e) => {
            const t = e && e.target;
            // Our own toast is on screen during this, so let its buttons work.
            try {
                if (t && t.closest && t.closest("#__lvRetryToast"))
                    return;
            }
            catch (_) { }
            // Swallowed so picking the stop or regenerate control doesn't also fire it.
            try {
                e.preventDefault();
                e.stopPropagation();
            }
            catch (_) { }
            const sel = deriveSelector(t);
            if (!sel) {
                finish(null, "Couldn't identify that one. Try clicking the button itself rather than an icon inside it.");
                return;
            }
            finish(sel, "Set to " + sel);
        };
        const onKey = (e) => {
            if (e && e.key === "Escape")
                finish(null, "Picking cancelled.");
        };
        // Some controls act on pointerdown rather than click. Their listeners are cut
        // off here so nothing fires while picking. Only propagation is stopped: a
        // preventDefault on touchstart would also stop the browser synthesising the
        // click that the picker itself needs.
        const swallow = (e) => {
            const t = e && e.target;
            try {
                if (t && t.closest && t.closest("#__lvRetryToast"))
                    return;
            }
            catch (_) { }
            try {
                e.stopPropagation();
            }
            catch (_) { }
        };
        for (const type of PRESS_EVENTS)
            document.addEventListener(type, swallow, true);
        document.addEventListener("click", onPick, true);
        document.addEventListener("keydown", onKey, true);
        // The field labels already read "Your ... button", so the leading "your" is
        // dropped rather than repeated back.
        const what = String(label || "").replace(/^your\s+/i, "").trim() || "retry button";
        const hasKeyboard = typeof window !== "undefined" &&
            !!window.matchMedia &&
            window.matchMedia("(hover: hover)").matches;
        showToast("Click your " + what + ". " + (hasKeyboard ? "Esc or Cancel to stop." : "Or press Cancel."), {
            sticky: true,
            force: true,
            top: true,
            cancel: () => finish(null, "Picking cancelled."),
        });
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
                }
                catch (_) { }
                modalHandle = null;
            }
            // Size to the screen so it fits on a phone as well as a desktop.
            const vw = typeof window !== "undefined" && window.innerWidth
                ? window.innerWidth
                : 480;
            const vh = typeof window !== "undefined" && window.innerHeight
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
            // Baseline of every saved setting at open. Edits below change cfg live, but
            // closing the modal with X or tapping outside restores this baseline, so
            // nothing sticks unless Save is pressed. Save and Reset refresh the baseline.
            const snapshot = () => {
                modalBaseline = {};
                for (const g of SCHEMA)
                    for (const fl of g.fields)
                        modalBaseline[fl.key] = cfg[fl.key];
            };
            snapshot();
            modalSnapshot = snapshot;
            buildSettingsBody(modal.root, snapshot);
            modal.onDismiss(() => {
                hideHint();
                if (closeExpandEditor) {
                    try {
                        closeExpandEditor();
                    }
                    catch (_) { }
                }
                // Parented to the page like the editor is, so dismissing the panel does
                // not take it with it. Left open it would sit over the chat asking to
                // reset settings in a panel that is no longer there.
                if (closeResetPicker) {
                    try {
                        closeResetPicker();
                    }
                    catch (_) { }
                }
                if (modalBaseline)
                    for (const g of SCHEMA)
                        for (const fl of g.fields)
                            cfg[fl.key] = modalBaseline[fl.key];
                modalHandle = null;
                modalRoot = null;
                modalSnapshot = null;
                modalBaseline = null;
            });
        }
        catch (e) {
            log("failed to open settings", e);
        }
    }
    // entry point: a button in the chat input "Extras" popover
    try {
        if (ctx?.ui?.registerInputBarAction) {
            const action = ctx.ui.registerInputBarAction({
                id: "auto-retry-settings",
                label: "Auto Retry settings",
                iconSvg: dieSvg(false),
            });
            disposers.push(action.onClick(() => openSettings()));
            disposers.push(() => {
                try {
                    action.destroy();
                }
                catch (_) { }
            });
        }
        else {
            log("host has no input bar action API; open settings via ctx only");
        }
    }
    catch (e) {
        log("failed to register settings action", e);
    }
    // backup stop-press catcher (see onDocClick)
    if (typeof document !== "undefined") {
        document.addEventListener("click", onDocClick, true);
        disposers.push(() => {
            try {
                document.removeEventListener("click", onDocClick, true);
            }
            catch (_) { }
        });
    }
    // Wrap each listener so a throw inside a handler is logged, never escapes into
    // the host's event dispatcher, and never stops later events from arriving.
    const safe = (label, fn) => (p) => {
        try {
            fn(p);
        }
        catch (e) {
            log("handler error in " + label, e);
        }
    };
    let offs = [];
    try {
        offs = [
            ctx.events.on("GENERATION_STARTED", safe("GENERATION_STARTED", onStart)),
            ctx.events.on("STREAM_TOKEN_RECEIVED", safe("STREAM_TOKEN_RECEIVED", onToken)),
            ctx.events.on("GENERATION_ENDED", safe("GENERATION_ENDED", onEnd)),
            ctx.events.on("GENERATION_STOPPED", safe("GENERATION_STOPPED", onStop)),
            ctx.events.on("CHAT_CHANGED", safe("CHAT_CHANGED", onChatSwitched)),
            ctx.events.on("CHAT_SWITCHED", safe("CHAT_SWITCHED", onChatSwitched)),
        ];
    }
    catch (e) {
        log("failed to subscribe to generation events", e);
    }
    syncLiveLog();
    syncFloat();
    loadFromAccount();
    loadPresetsFromAccount();
    syncInputBarActions();
    try {
        if (ctx && typeof ctx.onBackendMessage === "function") {
            const offRep = ctx.onBackendMessage(async (msg) => {
                try {
                    if (!msg)
                        return;
                    if (msg.type === "confirm_edit") {
                        // A confirmation about a message in a chat that is not open cannot be
                        // acted on, so it is not raised.
                        if (msg.chatId && lastChatId && String(msg.chatId) !== String(lastChatId)) {
                            log("skipped a swap confirmation for a chat that is not open");
                            return;
                        }
                        const yes = await confirmEdit("Apply your word swaps to this reply?");
                        if (yes && ctx && typeof ctx.sendToBackend === "function") {
                            ctx.sendToBackend({ type: "apply_replace_now", chatId: msg.chatId, messageId: msg.messageId, requestId: "ar-rep-" + Date.now() });
                        }
                        return;
                    }
                    if (msg.type === "note_skipped") {
                        log("refusal note not sent: " + String(msg.reason || "unknown"));
                        return;
                    }
                    // Logged as well as the skip. "Did my note go out?" had no answer here
                    // that was not a guess from the reply, so only the failures were ever
                    // visible and a working note looked identical to no note at all.
                    if (msg.type === "note_sent") {
                        const n = Number(msg.count) || 0;
                        log("refusal note sent with the retry (" + n + (n === 1 ? " note" : " notes") + ")");
                        return;
                    }
                    // Sent after an automatic swap. The message is already saved; this only
                    // brings what is on screen into line with it. A swap can now land well
                    // after the reply did, so a result for a chat we are no longer looking
                    // at must not rewrite the one we are.
                    if (msg.type === "swapped") {
                        if (msg.chatId && lastChatId && String(msg.chatId) !== String(lastChatId))
                            return;
                        applySwapsToView(msg.pairs || []);
                        return;
                    }
                    if (msg.type !== "replace_now_result")
                        return;
                    if (msg.ok)
                        applySwapsToView(msg.pairs || []);
                    if (!msg.ok)
                        showToast("Could not swap words.");
                    else if (!msg.hasRules)
                        showToast("No word swaps are set up yet.");
                    else if (!msg.found)
                        showToast("No reply found to swap in this chat.");
                    else if (msg.changed > 0)
                        showToast("Swapped words in " + msg.changed + (msg.changed === 1 ? " reply." : " replies."));
                    else if (msg.skipped > 0)
                        showToast("Already swapped. Turn on re-swapping to redo it.");
                    else
                        showToast("No matching words to swap.");
                }
                catch (_) { }
            });
            disposers.push(() => { try {
                offRep && offRep();
            }
            catch (_) { } });
        }
    }
    catch (_) { }
    // Every Extras entry the extension can register is torn down here. The
    // swap-whole-chat one used to be missed, so it survived a reload and stacked
    // up a duplicate button each time.
    disposers.push(() => { try {
        replaceActionOff && replaceActionOff();
    }
    catch (_) { } try {
        replaceAction && replaceAction.destroy();
    }
    catch (_) { } });
    disposers.push(() => { try {
        replaceAllActionOff && replaceAllActionOff();
    }
    catch (_) { } try {
        replaceAllAction && replaceAllAction.destroy();
    }
    catch (_) { } });
    disposers.push(() => { try {
        toggleActionOff && toggleActionOff();
    }
    catch (_) { } try {
        toggleAction && toggleAction.destroy();
    }
    catch (_) { } });
    log("ready v" + VERSION, cfg);
    return () => {
        clearConfirmWatch();
        // The full-size editor is parented to the page, not to the modal, so
        // dismissing the modal below does not take it with it. Left open it would
        // sit over the chat with nothing behind it.
        if (closeExpandEditor) {
            try {
                closeExpandEditor();
            }
            catch (_) { }
            closeExpandEditor = null;
        }
        if (closeResetPicker) {
            try {
                closeResetPicker();
            }
            catch (_) { }
            closeResetPicker = null;
        }
        if (hideStyleEl) {
            try {
                hideStyleEl.remove();
            }
            catch (_) { }
            hideStyleEl = null;
        }
        if (panelStyleEl) {
            try {
                panelStyleEl.remove();
            }
            catch (_) { }
            panelStyleEl = null;
        }
        offs.forEach((o) => {
            try {
                o && o();
            }
            catch (_) { }
        });
        disposers.forEach((d) => {
            try {
                d && d();
            }
            catch (_) { }
        });
        if (modalHandle) {
            try {
                modalHandle.dismiss();
            }
            catch (_) { }
            modalHandle = null;
        }
        hideLiveLog();
        hideFloat();
        chats.forEach(clearTimers);
        chats.clear();
        eventLog.length = 0;
        try {
            if (typeof document !== "undefined" && document.getElementById) {
                const t = document.getElementById("__lvRetryToast");
                if (t) {
                    clearTimeout(t.__h);
                    if (t.remove)
                        t.remove();
                }
            }
        }
        catch (_) { }
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
    looksLikeRefusal,
    looksLikeRefusalError,
    looksTruncated,
    normalizeForMatch,
    splitPhrases,
    parseSubs,
    applySubs,
    stripThinking,
    splitSelectorList,
    withLongForms,
    REFUSAL_PHRASES,
    REFUSAL_DISENGAGE,
    // The defaults block and the form built from it, so a check can hold the two
    // against each other. Hints used to spell their default out by hand and went
    // stale every time one was retuned, with nothing to catch it.
    CONFIG,
    SCHEMA,
};
