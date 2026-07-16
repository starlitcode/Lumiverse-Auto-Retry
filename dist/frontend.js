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
 * and pick "Auto Retry settings". Changes are saved to localStorage and applied
 * to the next generation, so you never have to touch the GitHub files.
 */
const STORE_KEY = 'lv-auto-retry:settings:v1';
// How long (ms) to suppress automatic retries after the user stops or cancels.
// Long enough to swallow the stopped generation's own trailing events.
const STAND_DOWN_MS = 2500;
const IGNORE_MAX = 16; // most aborted-generation ids kept around to swallow their late events
// Bumped on each release. Shown in the startup log and in the Copy debug info
// report, so a bug report always says which version it came from.
const VERSION = '2.3.0';
// ---- defaults (the UI overrides these; editing here changes the fallback) ----
const CONFIG = {
    enabled: true,
    // retry budget
    maxRetries: 4,
    retryDelayMs: 1200,
    // first retry fires a touch sooner; backoff still climbs
    backoffFactor: 2,
    maxDelayMs: 30000,
    jitter: true,
    // rate limiting (HTTP 429 / overloaded)
    rateLimitDelayMs: 8000,
    // watchdogs. Tuned to tolerate a slow connection and slow local models so a
    // slow-but-fine generation is not mistaken for a stall and retried into a pile-up.
    stuckTimeoutMs: 90000,
    // started but never produced a token or an end. 0 disables.
    idleTimeoutMs: 45000,
    // tokens were flowing then stopped this long (mid-stream cutoff). 0 disables.
    // what counts as needing a retry
    retryOnError: true,
    ignoreHardErrors: true,
    retryOnEmpty: true,
    // also catches a generation cut off mid-reasoning (reasoning seen, content empty)
    retryOnTruncated: true,
    // final content present but cut off mid-sentence (structural heuristic, see looksTruncated)
    retryOnNoPunct: false,
    // extra: also treat "ends with no punctuation" as truncated. Noisy in RP, off by default.
    retryOnShort: false,
    // off by default. Caused endless regen in the original.
    minChars: 24,
    retryOnRefusal: true,
    // final content is an out-of-character refusal (see looksLikeRefusal). Re-fires the SAME request, capped by maxRetries. Does not alter the request.
    refusalExtraPhrases: '',
    // your own extra refusal phrases, one per line. Any reply containing one counts as a refusal.
    refusalPhraseSubs: '',
    // reword the built-in phrases: "old => new" rules, one per line, applied to the built-in list before matching.
    refusalIgnorePhrases: '',
    // a reply containing any of these (one per line) is never counted as a refusal.
    refusalUseBuiltins: true,
    // use the built-in refusal lists. Turn off to run purely on your own phrases below.
    refusalMaxChars: 2000,
    // only replies up to this length are considered refusals. Longer = treated as real content. 0 = no limit (scan any length).
    refusalStripThinking: true,
    // ignore the model's thinking when checking for a refusal, so a refusal that lives only in a <think> block does not trigger a retry when the visible reply is fine.
    refusalThinkTags: '',
    // extra reasoning tag names (one per line) the model wraps its thinking in, on top of the built-in set. Both <tag> and [tag] forms are handled.
    // Find and replace in replies (handled by the backend via the Chat Mutation API).
    replaceEnabled: false,
    // off by default. When on, applies replaceRules to each finished reply and edits the saved message.
    replaceRules: '',
    // "old => new" rules, one per line. A single word matches whole words; empty right side deletes it. Same word can appear more than once.
    replaceCaseSensitive: false,
    // match letter case exactly. Off = case-insensitive with capitalization kept.
    replaceRandom: false,
    // when a word has more than one replacement, pick one at random per occurrence. Off = always the first listed.
    // host controls (the only DOM-dependent part). Use the Test buttons in settings.
    // Multiple patterns are listed so a Lumiverse build that renames one attribute
    // is still likely covered; if a build changes them all, fix it via the Test UI.
    regenerateSelector: '[data-action="regenerate"], [data-testid="regenerate"], ' + 'button[aria-label*="regenerate" i], button[title*="regenerate" i]',
    swipeNextSelector: '[data-action="swipe-right"], button[aria-label*="next swipe" i], button[aria-label*="next" i]',
    stopSelector: '[data-action="stop"], [data-testid="stop"], ' + 'button[aria-label*="stop" i], button[title*="stop" i], [class*="_sendBtnStop_"]',
    toast: true,
    liveLog: false,
    // show a small on-screen panel with recent activity, updating live. Handy on mobile where dev tools aren't available.
};
const SCHEMA = [{
    title: 'Basics',
    desc: 'The main switch, and whether it tells you when it retries.',
    fields: [{
        key: 'enabled',
        label: 'Turn auto-retry on',
        type: 'bool',
        hint: "When on, it quietly tries again whenever a reply fails or gets cut off. Turn it off and it does nothing."
    },
    {
        key: 'toast',
        label: 'Show a pop-up on each retry',
        type: 'bool',
        hint: 'A small message telling you it is retrying, with a Cancel button to stop it.'
    },
    ]
},
{
    title: 'How hard it tries',
    desc: 'How persistent it is, and how long it waits between tries.',
    fields: [{
        key: 'maxRetries',
        label: 'Most tries per message',
        type: 'num',
        int: true,
        min: 0,
        max: 50,
        hint: 'How many times it retries one message before giving up. 3 to 5 suits most people.'
    },
    {
        key: 'retryDelayMs',
        label: 'Wait before the first retry',
        type: 'num',
        int: true,
        min: 0,
        max: 600000,
        hint: 'How long it pauses before trying again the first time. In milliseconds, so the 1200 default is 1.2 seconds.'
    },
    {
        key: 'backoffFactor',
        label: 'How much longer each wait gets',
        type: 'num',
        min: 1,
        max: 10,
        hint: "Each retry waits this many times longer than the last, so it doesn't hammer the server. 2 means the wait doubles each time. Stays at 1 or above."
    },
    {
        key: 'maxDelayMs',
        label: 'Longest it will ever wait',
        type: 'num',
        int: true,
        min: 0,
        max: 600000,
        hint: "A ceiling so it never pauses forever. 30000 = 30 seconds."
    },
    {
        key: 'rateLimitDelayMs',
        label: 'Wait when the server is busy',
        type: 'num',
        int: true,
        min: 0,
        max: 600000,
        hint: 'If the server says "too many requests," it waits at least this long. 8000 = 8 seconds.'
    },
    {
        key: 'jitter',
        label: 'Add a little randomness to waits',
        type: 'bool',
        hint: "Nudges each wait by a random amount so retries don't all hit the server at the same instant. Best left on."
    },
    ]
},
{
    title: 'Watch for frozen replies',
    desc: "These notice when a reply freezes or never shows up, and step in. The defaults lean long so a slow connection or a slow local model isn't mistaken for a freeze; lower them if your provider is fast and you want quicker retries.",
    fields: [{
        key: 'stuckTimeoutMs',
        label: 'Give up waiting for it to start',
        type: 'num',
        int: true,
        min: 0,
        max: 600000,
        hint: "If a reply begins but no words appear in this long, treat it as stuck and retry. 90000 = 90 seconds. Set to 0 to switch off."
    },
    {
        key: 'idleTimeoutMs',
        label: 'Give up on a reply that froze',
        type: 'num',
        int: true,
        min: 0,
        max: 600000,
        hint: "If words were appearing and then stop for this long, treat it as frozen and retry. 45000 = 45 seconds. Set to 0 to switch off."
    },
    ]
},
{
    title: 'When to count a reply as bad',
    desc: 'Pick which kinds of bad reply should trigger a retry.',
    fields: [{
        key: 'retryOnError',
        label: 'It came back as an error',
        type: 'bool',
        hint: 'Retry when the reply fails outright with an error.'
    },
    {
        key: 'ignoreHardErrors',
        label: 'Skip hard failures',
        type: 'bool',
        hint: 'Stops it from retrying when an error is permanent, like a missing model, an invalid API key, or an authentication failure.'
    },
    {
        key: 'retryOnEmpty',
        label: 'It came back blank',
        type: 'bool',
        hint: 'Retry when nothing comes back, including a reply that thinks but never writes anything.'
    },
    {
        key: 'retryOnTruncated',
        label: 'It cut off mid-sentence',
        type: 'bool',
        hint: "Retry when a reply clearly stops partway, like an open quote, an unfinished *action*, or a trailing comma. It's intentionally careful so it doesn't throw away good writing."
    },
    {
        key: 'retryOnNoPunct',
        label: "Also: it ends with no punctuation",
        type: 'bool',
        hint: "A stricter version of the line above. It can wrongly redo a reply that simply ends on a word, so most people leave this off."
    },
    {
        key: 'retryOnShort',
        label: 'It was very short',
        type: 'bool',
        hint: 'Retry replies shorter than the length below. Off by default, since short replies are often fine.'
    },
    {
        key: 'minChars',
        label: 'What counts as "very short"',
        type: 'num',
        int: true,
        min: 0,
        max: 100000,
        hint: 'Replies with fewer characters than this count as too short. Only used when the option above is on.'
    },
    {
        key: 'retryOnRefusal',
        label: 'It looks like an accidental refusal (beta)',
        type: 'bool',
        hint: "Retry when the model breaks character to decline (says it's an AI, or that it can't help or continue). It just tries the same request again, capped by your Most tries setting, so a refusal the model really means will survive the tries and stop. Nothing in your request is changed. Kept narrow so it won't touch an in-character \"I can't do that\" line. New and still being tuned, so leave it off if you'd rather not risk a re-roll. It reads only the final reply, never the model's thinking."
    },
    ]
},
{
    title: 'Find and replace in replies (beta)',
    desc: "Swaps words in a reply after it arrives and saves the change, so the swap sticks and the model reads it on later turns. It never changes what the model generated, only the text afterward. Needs the chat editing permission. Off by default.",
    fields: [{
        key: 'replaceEnabled',
        label: 'Swap words in replies',
        type: 'bool',
        hint: "When on, applies your swaps below to each new reply and edits the saved message. If nothing here matches, the reply is left untouched."
    },
    {
        key: 'replaceRules',
        label: 'Word swaps (old => new)',
        type: 'text',
        hint: "Rules are \"old => new\", one per line. The left side can be a single word, a phrase, or a whole sentence, and commas inside it are fine. A single word matches whole words only (so cat won't touch category), while a phrase or sentence matches exactly as you type it. Leave the right side empty to delete it. Put the same left side on more than one line (like sky => blue on one line and sky => aqua on another) to give it options for the random toggle below."
    },
    {
        key: 'replaceRandom',
        label: 'Pick randomly when a word has more than one swap',
        type: 'bool',
        hint: "Off by default. When the same word is listed on more than one line (like sky => blue on one line and sky => aqua on another), each time it appears one of its options is picked at random. Off, it always uses the first one you listed."
    },
    {
        key: 'replaceCaseSensitive',
        label: 'Match case exactly',
        type: 'bool',
        hint: "Off by default. When off, a swap matches any case and keeps the original capitalization. Turn on to swap only when the case matches your rule exactly, so sky and Sky can have different swaps."
    },
    ]
},
{
    title: 'Advanced: refusal tuning (beta)',
    desc: "Only matters if the refusal option above is on. Most people can leave all of this alone. It's here for fine-tuning what counts as a refusal.",
    fields: [{
        key: 'refusalUseBuiltins',
        label: 'Use the built-in phrase list',
        type: 'bool',
        hint: "On by default. This only controls the built-in list. Your own phrases below are always used either way. On, the built-in list is used together with your own phrases. Off, only your own phrases are used."
    },
    {
        key: 'refusalExtraPhrases',
        label: 'Your own refusal phrases',
        type: 'text',
        hint: "Optional. Extra phrases that should also count as a refusal, one per line. These are always used, whether or not the built-in list above is on. Upper or lower case doesn't matter. Paste the exact wording your model refuses with."
    },
    {
        key: 'refusalPhraseSubs',
        label: 'Reword the built-in phrases',
        type: 'text',
        hint: 'Optional. Swap wording inside the built-in list using "old => new" rules, one per line. Example: assist => help. It changes what the built-in list matches, so only swap for wording your model actually uses.'
    },
    {
        key: 'refusalIgnorePhrases',
        label: 'Never treat these as a refusal',
        type: 'text',
        hint: "Optional. If a reply contains any of these phrases, one per line, it's never counted as a refusal. This wins over everything else."
    },
    {
        key: 'refusalMaxChars',
        label: 'Longest reply to treat as a refusal',
        type: 'num',
        int: true,
        min: 0,
        max: 100000,
        hint: 'Replies longer than this are assumed to be real writing, not a refusal, and are left alone. 2000 suits most cases. Raise it if your model writes long, padded refusals; lower it to protect long scenes. Set it to 0 to check replies of any length, which catches every refusal but is more likely to re-roll a long reply that happens to look refusal-shaped.'
    },
    {
        key: 'refusalStripThinking',
        label: 'Ignore the thinking / reasoning',
        type: 'bool',
        hint: "On by default. Only the final reply is checked, never the model's thinking. Known reasoning blocks (like <think> or <thinking>) are stripped before checking, so a refusal the model weighs while reasoning but doesn't put in the reply won't cause a retry. Turn it off to check the whole raw output."
    },
    {
        key: 'refusalThinkTags',
        label: 'Extra thinking tag names',
        type: 'text',
        hint: "Optional, one per line. The common reasoning tags are already handled. Add a tag name only if your model wraps its thinking in an unusual one (for example: mythink). Just the name, no brackets. Both <name> and [name] forms are covered."
    },
    ]
},
{
    title: 'Advanced: buttons it clicks',
    desc: "It works by clicking your own on-screen buttons. The three boxes below are three different buttons it needs for three different jobs: redoing a reply, swiping to a fresh one as a backup, and stopping a frozen reply. Each box takes one CSS selector, the kind you'd use in your browser's inspector, and you can list a few separated by commas as fallbacks since it uses the first that matches. You only need this if retries aren't happening. Paste a selector and press Test until it says match found. A no match doesn't always mean the selector is wrong; the button may just not be on screen yet, so test each one while its button is actually visible. The Stop button, for one, only appears while a reply is generating.",
    fields: [{
        key: 'regenerateSelector',
        label: 'Your regenerate button',
        type: 'text',
        selector: true,
        hint: 'The retry button it clicks to redo a reply.'
    },
    {
        key: 'swipeNextSelector',
        label: 'Your next / swipe button',
        type: 'text',
        selector: true,
        hint: 'A backup it clicks if your setup retries by swiping to a new reply instead.'
    },
    {
        key: 'stopSelector',
        label: 'Your stop button',
        type: 'text',
        selector: true,
        hint: 'The stop button, so it can halt a frozen reply before retrying.'
    },
    ]
},
{
    title: 'Advanced: on-screen log',
    desc: 'A live panel that shows what the extension is doing, for debugging.',
    fields: [{
        key: 'liveLog',
        label: 'Show a live log on screen',
        type: 'bool',
        hint: "Puts a small panel in the corner that shows recent activity as it happens (generations, retries and why, finishes). Useful for watching what it does without opening the console, especially on mobile. Drag it to move it, drag its corner to resize, and turn this off to hide it."
    },
    ]
},
];
// Final content present but cut off mid-sentence. Lumiverse does not expose
// finish_reason on GENERATION_ENDED (confirmed against the Generation API), so
// this works off the only signal a frontend extension has: the shape of the
// text. Conservative on purpose to avoid re-rolling good roleplay replies.
function looksTruncated(text, retryOnNoPunct) {
    const t = String(text == null ? '': text).replace(/\s+$/, '');
    if (!t) return false; // empty is handled by the empty branch
    if ((t.match(/```/g) || []).length % 2 === 1) return true; // open code fence
    if ((t.replace(/```/g, '').match(/`/g) || []).length % 2 === 1) return true; // open inline code
    // Emphasis asterisks only. Strip markdown bullet markers ("* " at line start)
    // first, or a reply with an odd number of list bullets would read as an open
    // emphasis run and get re-rolled. Emphasis pairs (*x*, **x**) are unaffected.
    const emphasis = t.replace(/^[ \t]*\*[ \t]+/gm, '');
    if ((emphasis.match(/\*/g) || []).length % 2 === 1) return true; // open emphasis / RP action
    if ((t.match(/"/g) || []).length % 2 === 1) return true; // open straight-quote dialogue
    if ((t.match(/\u201C/g) || []).length !== (t.match(/\u201D/g) || []).length) return true; // mismatched smart quotes
    if (/[,;]$/.test(t)) return true; // cut mid-clause
    if (retryOnNoPunct && !/[.!?\u2026"'*)\]}\u201D~>\-\u2014:]$/.test(t)) return true;
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
function normalizeForMatch(text) {
    return String(text == null ? '': text).replace(/[\u2018\u2019\u02BC\u2032]/g, "'").replace(/[\u201C\u201D\u2033]/g, '"').replace(/\s+/g, ' ').trim();
}
// A user list is newline-separated (one entry per line). Lowercased + normalized for a
// case-insensitive substring test.
function splitPhrases(raw) {
    return String(raw == null ? '': raw).split(/\r?\n/).map((p) => normalizeForMatch(p).toLowerCase()).filter((p) => p.length > 0);
}
// Reword rules: "old => new" pairs, one per line. Lets a user
// swap a word or bit of phrasing in the built-in list for wording they prefer.
// Empty "new" is allowed (deletes the old text).
function parseSubs(raw) {
    const out = [];
    for (const rule of String(raw == null ? '': raw).split(/\r?\n/)) {
        const i = rule.indexOf('=>');
        if (i < 0) continue;
        const from = normalizeForMatch(rule.slice(0, i)).toLowerCase();
        const to = normalizeForMatch(rule.slice(i + 2)).toLowerCase();
        if (from) out.push({
            from,
            to
        });
    }
    return out;
}
// Apply the reword rules to the built-in phrase list. Each phrase is already
// lowercase/normalized, matching how rules are parsed.
function applySubs(phrases, subs) {
    if (!subs.length) return phrases;
    return phrases.map((p) => {
        let out = p;
        for (const s of subs) if (s.from) out = out.split(s.from).join(s.to);
        return out;
    }).filter((p) => p.length > 0);
}
// Tier 1: strong regexes. Anchored so an in-character "I can't help you carry
// that" doesn't trip them. These carry the precision.
const REFUSAL_STRONG = [
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
/\bI(?: (?:can(?:no|')?t|cannot|will not|won'?t|am (?:not able|unable) to)|'m (?:not able|unable) to) (?:be able to )?(?:assist|comply|fulfil|fulfill)\b/i,
// Out-of-character comfort hedge, only in the assistant-action sense.
/\bI don'?t feel comfortable (?:continuing|writing|creating|generating|producing|proceeding|providing|helping|assisting)\b/i,
// Common modern refusal openers and bodies: "I'm sorry, but I can't create/generate...",
// "that's not something I can help with", "I'm not going to generate that". Anchored on
// assistant-action verbs so an in-character line like "I can't marry you" stays safe.
/\bI(?:'m| am) sorry,? but I(?: can'?t| cannot| won'?t|'m (?:not able|unable) to| am (?:not able|unable) to) (?:create|generate|write|produce|provide|assist|comply|fulfil|fulfill|help you with|engage with)\b/i,
/\b(?:that|this)(?:'s| is) not something I(?: can| am able to|'m able to) (?:help with|assist with|create|generate|provide|write)\b/i,
/\bI(?:'m| am) not going to (?:create|generate|produce|write) (?:that|this|such|content|explicit|sexual|those)\b/i,
];
// Tier 2: flat phrase list, matched as normalized lowercase substrings. Covers
// the many near-identical refusal templates across providers without a regex
// each. All things a character in a scene basically never says.
const REFUSAL_PHRASES = ["i can't help with that", "i cannot help with that", "i can't assist with that", "i cannot assist with that", "i'm unable to help with that", "i'm unable to assist with that", "i am unable to assist with that", "i'm not able to help with that", "i can't comply with that", "i cannot comply with that", "i can't provide that information", "i cannot provide that information", "i can't provide instructions", "i can't provide guidance on that", "i can't fulfill that request", "i can't fulfil that request", "i can't support that request", "i won't be able to help with that", "i can't generate a response to that", "i can't provide a response to that", "i can't generate that content", "i can't engage with that request", "can't help with requests like this", "can't assist with requests like this", "violates our polic", "violates the safety polic", "violates the content polic", "for safety reasons", "due to safety concerns", "i have to prioritize safety", "i cannot create that content", "i cannot generate that content", "i can't create that content", ];
// Tier 3: soft redirect tells. These lean on a pivot ("...instead", "instead, I
// can...") so an ordinary helpful reply that just offers to help doesn't match.
const REFUSAL_SOFT = [/\bi'?d be happy to help (?:you )?(?:with [^.?!\n]{0,40}? )?instead\b/i, /\binstead,? i (?:can|could|would be happy to) (?:help|offer|suggest|provide)\b/i, /\bi can (?:provide|offer|give you) general information instead\b/i, /\bplease (?:try asking something else|change the topic|rephrase your request)\b/i, ];
// Reasoning/thinking blocks are where a model weighs a refusal before deciding
// to answer. Only the final reply should be judged, so these are stripped before
// matching: a refusal that lives only in the thinking never triggers a retry when
// the visible reply is fine. Built-in tags cover the common wrappers; the user can
// add more with refusalThinkTags. Applied here only, so the empty/truncation
// checks still see the raw output.
const THINK_TAGS = ['think', 'thinking', 'thought', 'thoughts', 'reasoning', 'reflection', 'scratchpad', 'analysis'];
function stripThinking(text, cfg) {
    let t = String(text == null ? '' : text);
    if (cfg && cfg.refusalStripThinking === false) return t;
    const extra = String((cfg && cfg.refusalThinkTags) || '').split(/\r?\n/).map((s) => s.replace(/[^\w-]/g, '').toLowerCase()).filter(Boolean);
    const names = THINK_TAGS.concat(extra);
    if (!names.length) return t;
    const alt = names.join('|');
    // <tag ...>...</tag> and [tag ...]...[/tag], same tag both ends, across newlines
    t = t.replace(new RegExp('<(' + alt + ')(?:\\s[^>]*)?>[\\s\\S]*?<\\/\\1\\s*>', 'gi'), ' ');
    t = t.replace(new RegExp('\\[(' + alt + ')(?:\\s[^\\]]*)?\\][\\s\\S]*?\\[\\/\\1\\s*\\]', 'gi'), ' ');
    // an unclosed opener running to the end (thinking cut off before the reply)
    t = t.replace(new RegExp('<(?:' + alt + ')(?:\\s[^>]*)?>[\\s\\S]*$', 'i'), ' ');
    t = t.replace(new RegExp('\\[(?:' + alt + ')(?:\\s[^\\]]*)?\\][\\s\\S]*$', 'i'), ' ');
    return t;
}
function looksLikeRefusal(text, cfg) {
    const raw = stripThinking(String(text == null ? '': text), cfg).trim();
    if (!raw) return false; // empty is handled by the empty branch
    const maxChars = (cfg && Number.isFinite(cfg.refusalMaxChars)) ? cfg.refusalMaxChars: REFUSAL_MAX_CHARS;
    if (maxChars > 0 && raw.length > maxChars) return false; // long immersive reply, not a refusal
    const norm = normalizeForMatch(raw);
    const lower = norm.toLowerCase();
    // Whitelist wins: anything the user parked here is never a refusal.
    for (const p of splitPhrases(cfg && cfg.refusalIgnorePhrases)) if (lower.includes(p)) return false;
    // The user's own additions count as refusals.
    for (const p of splitPhrases(cfg && cfg.refusalExtraPhrases)) if (lower.includes(p)) return true;
    // Built-in English lists, unless the user has switched them off to run pure-custom.
    if (!cfg || cfg.refusalUseBuiltins !== false) {
        for (const re of REFUSAL_STRONG) if (re.test(norm)) return true;
        const phrases = applySubs(REFUSAL_PHRASES, parseSubs(cfg && cfg.refusalPhraseSubs));
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
const REFUSAL_ERROR = /\b(?:prohibited[_ ]?content|content[_ ]?polic(?:y|ies)|safety[_ ]?(?:polic(?:y|ies)|filter|settings?)|response was blocked|blocked (?:by|for) (?:safety|content|moderation)|content[_ ]?filter|moderation|flagged as|violat\w* (?:content|safety|polic)|finish[_ ]?reason["'\s:=]*(?:safety|prohibited|blocklist|recitation)|blocklist)\b/i;
function looksLikeRefusalError(errText, cfg) {
    const norm = normalizeForMatch(errText);
    if (!norm) return false;
    const lower = norm.toLowerCase();
    for (const p of splitPhrases(cfg && cfg.refusalIgnorePhrases)) if (lower.includes(p)) return false;
    for (const p of splitPhrases(cfg && cfg.refusalExtraPhrases)) if (lower.includes(p)) return true;
    if (!cfg || cfg.refusalUseBuiltins !== false) {
        if (REFUSAL_ERROR.test(norm)) return true;
    }
    return false;
}
export function setup(ctx, opts) {
    // cfg is mutable so the settings modal can change it live. Order: code
    // defaults, then GitHub opts, then whatever the user saved in the UI.
    const cfg = Object.assign({},
    CONFIG, opts || {},
    loadSaved());
    // Persist the whole settings object to account storage (through the backend) so
    // settings follow the user across browsers. The backend also derives its
    // find-and-replace state from this. Safe to call with no backend bridge.
    function saveToAccount() {
        try {
            if (ctx && typeof ctx.sendToBackend === 'function') {
                const out = {};
                for (const g of SCHEMA) for (const f of g.fields) out[f.key] = cfg[f.key];
                ctx.sendToBackend({ type: 'save_settings', settings: out });
            }
        } catch(_) {}
    }
    // Pull account-synced settings on load. localStorage is a fast local cache and
    // offline fallback; the account copy wins when present. If the account has
    // nothing yet but this browser does, migrate this browser's settings up.
    function loadFromAccount() {
        try {
            if (!ctx || typeof ctx.sendToBackend !== 'function' || typeof ctx.onBackendMessage !== 'function') return;
            const reqId = 'ar-load-' + Date.now() + '-' + Math.random().toString(36).slice(2);
            const off = ctx.onBackendMessage((msg) => {
                if (!msg || msg.type !== 'loaded_settings' || msg.requestId !== reqId) return;
                try { off && off(); } catch(_) {}
                const s = msg.settings;
                if (s && typeof s === 'object' && Object.keys(s).length) {
                    Object.assign(cfg, coerceSaved(s));
                    saveSaved();
                    syncLiveLog();
                    if (modalHandle && modalRoot) { if (modalSnapshot) modalSnapshot(); buildSettingsBody(modalRoot, modalSnapshot); }
                    log('settings loaded from account');
                } else {
                    try {
                        if (typeof localStorage !== 'undefined' && localStorage.getItem(STORE_KEY)) { saveToAccount(); log('settings migrated to account'); }
                    } catch(_) {}
                }
            });
            disposers.push(() => { try { off && off(); } catch(_) {} });
            ctx.sendToBackend({ type: 'load_settings', requestId: reqId });
        } catch(_) {}
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
                if (typeof a === 'string') return a;
                try {
                    return JSON.stringify(a);
                } catch(_) {
                    return String(a);
                }
            });
            let line = new Date().toISOString().slice(11, 23) + ' ' + parts.join(' ');
            if (line.length > 220) line = line.slice(0, 217) + '...';
            eventLog.push(line);
            if (eventLog.length > EVENTLOG_MAX) eventLog.shift();
            if (liveLogBody) renderLiveLog();
        } catch(_) {}
    }
    const log = (...a) => {
        recordEvent(a);
    };
    // Optional on-screen log. A small fixed panel that shows recent activity live,
    // so someone can watch what the extension is doing without opening dev tools,
    // which matters most on mobile. Driven by the liveLog setting.
    function renderLiveLog() {
        if (!liveLogBody) return;
        liveLogBody.textContent = eventLog.length ? eventLog.join('\n') : '(nothing yet)';
        liveLogBody.scrollTop = liveLogBody.scrollHeight;
    }
    function showLiveLog() {
        if (liveLogEl || typeof document === 'undefined') return;
        const el = document.createElement('div');
        el.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:2147483000;width:min(340px,92vw);height:min(300px,50vh);min-width:200px;min-height:120px;max-width:96vw;max-height:85vh;display:flex;flex-direction:column;background:var(--lumiverse-surface,rgba(20,18,26,.96));border:1px solid var(--lumiverse-border,rgba(255,255,255,.14));border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.4);font-family:var(--lumiverse-font-family,system-ui);font-size:13px;color:var(--lumiverse-text,#e9e4f0);overflow:hidden';
        const head = document.createElement('div');
        head.style.cssText = 'display:flex;align-items:center;gap:8px;padding:7px 9px;border-bottom:1px solid var(--lumiverse-border,rgba(255,255,255,.12));font-weight:600;cursor:move;user-select:none;touch-action:none';
        const title = document.createElement('span');
        title.textContent = 'Auto Retry log';
        head.appendChild(title);
        const bodyEl = document.createElement('div');
        bodyEl.style.cssText = 'flex:1;padding:7px 9px;overflow:auto;white-space:pre-wrap;line-height:1.4;font-family:monospace';
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
        const onDown = (e) => {
            dragging = true;
            const r = el.getBoundingClientRect();
            el.style.left = r.left + 'px';
            el.style.top = r.top + 'px';
            el.style.right = 'auto';
            el.style.bottom = 'auto';
            sx = e.clientX;
            sy = e.clientY;
            ox = r.left;
            oy = r.top;
            try {
                head.setPointerCapture(e.pointerId);
            } catch(_) {}
            e.preventDefault();
        };
        const onMove = (e) => {
            if (!dragging) return;
            let nx = ox + (e.clientX - sx),
            ny = oy + (e.clientY - sy);
            nx = Math.max(0, Math.min(nx, window.innerWidth - el.offsetWidth));
            ny = Math.max(0, Math.min(ny, window.innerHeight - el.offsetHeight));
            el.style.left = nx + 'px';
            el.style.top = ny + 'px';
        };
        const onUp = (e) => {
            if (dragging) {
                dragging = false;
                try {
                    head.releasePointerCapture(e.pointerId);
                } catch(_) {}
            }
        };
        head.addEventListener('pointerdown', onDown);
        head.addEventListener('pointermove', onMove);
        head.addEventListener('pointerup', onUp);
        head.addEventListener('pointercancel', onUp);
        // Resize by a corner grip. CSS resize only works with a mouse, so this uses
        // the same pointer events as the drag so it also works with touch on mobile.
        const grip = document.createElement('div');
        grip.style.cssText = 'position:absolute;right:0;bottom:0;width:20px;height:20px;cursor:nwse-resize;touch-action:none;background:linear-gradient(135deg,transparent 45%,var(--lumiverse-border,rgba(255,255,255,.5)) 45%,var(--lumiverse-border,rgba(255,255,255,.5)) 55%,transparent 55%,transparent 70%,var(--lumiverse-border,rgba(255,255,255,.5)) 70%,var(--lumiverse-border,rgba(255,255,255,.5)) 80%,transparent 80%);border-bottom-right-radius:10px';
        el.appendChild(grip);
        let rz = false,
        rsx = 0,
        rsy = 0,
        rw = 0,
        rh = 0;
        const rzDown = (e) => {
            rz = true;
            const r = el.getBoundingClientRect();
            el.style.left = r.left + 'px';
            el.style.top = r.top + 'px';
            el.style.right = 'auto';
            el.style.bottom = 'auto';
            rsx = e.clientX;
            rsy = e.clientY;
            rw = el.offsetWidth;
            rh = el.offsetHeight;
            try {
                grip.setPointerCapture(e.pointerId);
            } catch(_) {}
            e.preventDefault();
        };
        const rzMove = (e) => {
            if (!rz) return;
            let nw = rw + (e.clientX - rsx),
            nh = rh + (e.clientY - rsy);
            nw = Math.max(200, Math.min(nw, window.innerWidth - 16));
            nh = Math.max(120, Math.min(nh, window.innerHeight - 16));
            el.style.width = nw + 'px';
            el.style.height = nh + 'px';
        };
        const rzUp = (e) => {
            if (rz) {
                rz = false;
                try {
                    grip.releasePointerCapture(e.pointerId);
                } catch(_) {}
            }
        };
        grip.addEventListener('pointerdown', rzDown);
        grip.addEventListener('pointermove', rzMove);
        grip.addEventListener('pointerup', rzUp);
        grip.addEventListener('pointercancel', rzUp);
        try {
            document.body.appendChild(el);
        } catch(_) {
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
            } catch(_) {}
        }
        liveLogEl = null;
        liveLogBody = null;
    }
    function syncLiveLog() {
        if (cfg.liveLog) showLiveLog();
        else hideLiveLog();
    }
    const disposers = [];
    // Coerce a raw saved object (local cache or account storage) into a clean
    // partial config: keep only known fields, run each through its type.
    function coerceSaved(parsed) {
        const out = {};
        if (!parsed || typeof parsed !== 'object') return out;
        for (const g of SCHEMA) for (const f of g.fields) {
            if (! (f.key in parsed)) continue;
            out[f.key] = f.type === 'num' ? clampField(f, parsed[f.key]) : coerce(f.type, parsed[f.key], CONFIG[f.key]);
        }
        return out;
    }
    function loadSaved() {
        try {
            if (typeof localStorage === 'undefined') return {};
            const raw = localStorage.getItem(STORE_KEY);
            if (!raw) return {};
            return coerceSaved(JSON.parse(raw));
        } catch(_) {
            return {};
        }
    }
    function saveSaved() {
        try {
            if (typeof localStorage === 'undefined') return;
            const out = {};
            for (const g of SCHEMA) for (const f of g.fields) out[f.key] = cfg[f.key];
            localStorage.setItem(STORE_KEY, JSON.stringify(out));
        } catch(_) {}
    }
    function coerce(type, val, fallback) {
        if (type === 'bool') return !! val;
        if (type === 'num') {
            const n = Number(val);
            return Number.isFinite(n) ? n: fallback;
        }
        return val == null ? fallback: String(val);
    }
    // Turn whatever is in a number box into a safe value: a blank or non-numeric
    // box falls back to that field's default, then the result is clamped to the
    // field's range and rounded if it's a whole-number field. Stops an empty or
    // silly box from poisoning the retry maths.
    function clampField(f, raw) {
        const s = (raw == null ? '': String(raw)).trim();
        let n = s === '' ? CONFIG[f.key] : Number(s);
        if (!Number.isFinite(n)) n = CONFIG[f.key];
        if (typeof f.min === 'number') n = Math.max(f.min, n);
        if (typeof f.max === 'number') n = Math.min(f.max, n);
        if (f.int) n = Math.round(n);
        return n;
    }
    // ---- import / export ----
    // Settings are just values. These group them so a user can share or back up
    // only the parts they want. Import runs every value back through the same
    // coerce/clamp as saved settings, so an imported file can only set known keys to
    // safe values; anything unrecognised is ignored.
    const EXPORT_CATEGORIES = [{
        id: 'retry',
        label: 'Retry behavior',
        keys: ['enabled', 'maxRetries', 'retryDelayMs', 'backoffFactor', 'maxDelayMs', 'jitter', 'rateLimitDelayMs', 'stuckTimeoutMs', 'idleTimeoutMs', 'retryOnError', 'ignoreHardErrors', 'retryOnEmpty', 'retryOnTruncated', 'retryOnNoPunct', 'retryOnShort', 'minChars']
    },
    {
        id: 'refusal',
        label: 'Refusal detection',
        keys: ['retryOnRefusal', 'refusalUseBuiltins', 'refusalMaxChars', 'refusalExtraPhrases', 'refusalPhraseSubs', 'refusalIgnorePhrases', 'refusalStripThinking', 'refusalThinkTags']
    },
    {
        id: 'replace',
        label: 'Word swaps',
        keys: ['replaceEnabled', 'replaceRules', 'replaceRandom', 'replaceCaseSensitive']
    },
    {
        id: 'buttons',
        label: 'Button selectors',
        keys: ['regenerateSelector', 'swipeNextSelector', 'stopSelector']
    },
    {
        id: 'notifications',
        label: 'On-screen',
        keys: ['toast', 'liveLog']
    },
    ];
    const fieldByKey = {};
    for (const g of SCHEMA) for (const f of g.fields) fieldByKey[f.key] = f;
    let ioStatus = '';
    function coerceKey(key, val) {
        const f = fieldByKey[key];
        if (!f) return undefined;
        return f.type === 'num' ? clampField(f, val) : coerce(f.type, val, CONFIG[key]);
    }
    function buildExport(catIds) {
        const settings = {};
        for (const c of EXPORT_CATEGORIES) {
            if (catIds.indexOf(c.id) < 0) continue;
            const bucket = {};
            for (const k of c.keys) bucket[k] = cfg[k];
            settings[c.id] = bucket;
        }
        return JSON.stringify({
            autoRetry: VERSION,
            settings: settings
        },
        null, 2);
    }
    // Apply an imported blob, only the chosen categories actually present. Returns
    // the labels applied, or null if the text was not a valid export.
    function applyImport(text, catIds) {
        let data;
        try {
            data = JSON.parse(text);
        } catch(_) {
            return null;
        }
        if (!data || typeof data !== 'object' || !data.settings || typeof data.settings !== 'object') return null;
        const applied = [];
        for (const c of EXPORT_CATEGORIES) {
            if (catIds.indexOf(c.id) < 0) continue;
            const bucket = data.settings[c.id];
            if (!bucket || typeof bucket !== 'object') continue;
            let touched = false;
            for (const k of c.keys) {
                if (! (k in bucket)) continue;
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
    // ---- per-chat state ----
    const chats = new Map();
    const st = (chatId) => {
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
                ignored: new Set(),
                suppressUntil: 0,
            };
            chats.set(chatId, s);
        }
        return s;
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
        s.pending = false;
    };
    const isRateLimit = (err) => !!err && /\b(?:408|429|500|502|503|504|520|521|522|523|524)\b|rate.?limit|too many requests|quota|overloaded|timeout|temporary|network/i.test(String(err));
    const isHardError = (err) => !!err && /\b(?:400|401|402|403|404|405|406|411|413|415|422|invalid api key|authentication|unauthorized|not found|does not exist|model missing|insufficient balance|permission|forbidden|not allowed)\b/i.test(String(err));
    const computeDelay = (attempt, rateLimited) => {
        let d = cfg.retryDelayMs * Math.pow(cfg.backoffFactor, Math.max(0, attempt - 1));
        d = Math.min(d, cfg.maxDelayMs);
        if (rateLimited) d = Math.max(d, cfg.rateLimitDelayMs * attempt);
        if (cfg.jitter) d = Math.round(d * (0.85 + Math.random() * 0.3));
        return d;
    };
    const find = (selector) => {
        let el = null;
        try {
            el = ctx && ctx.dom && ctx.dom.query ? ctx.dom.query(selector) : null;
        } catch(_) {}
        if (!el && typeof document !== 'undefined') {
            try {
                el = document.querySelector(selector);
            } catch(_) {}
        }
        return el;
    };
    const fireRetry = () => {
        let btn = null;
        try {
            btn = find(cfg.regenerateSelector) || find(cfg.swipeNextSelector);
        } catch(_) {}
        if (btn) {
            try {
                hideToast();
                btn.click();
                return true;
            } catch(e) {
                log('regenerate click failed', e);
                return false;
            }
        }
        log('no regenerate control found, set the regenerate selector in settings');
        showToast("Auto-retry: couldn't find your regenerate button. Set it in Auto Retry settings.");
        return false;
    };
    const stopGenerating = () => {
        try {
            const stop = find(cfg.stopSelector);
            if (stop) {
                stop.click();
                return true;
            }
        } catch(e) {
            log('stop click failed', e);
        }
        return false;
    };
    // The user wins, always. Cancel any pending retry for this chat, reset its
    // budget, and briefly suppress new automatic retries so a stopped
    // generation's trailing events can't immediately restart the loop. This is
    // what makes Stop and Cancel actually stop things.
    function standDown(chatId, announce) {
        const s = st(chatId);
        const hadPending = s.pending || !!s.timer || s.attempts > 0;
        clearTimers(s);
        s.attempts = 0;
        s.suppressUntil = Date.now() + STAND_DOWN_MS;
        if (hadPending) {
            hideToast();
            if (announce) showToast('Auto-retry stopped.');
            log('stood down', chatId);
        }
    }
    function scheduleRetry(chatId, reason, err) {
        const s = st(chatId);
        if (!cfg.enabled || s.pending) return;
        if (Date.now() < s.suppressUntil) {
            log('suppressed (just stopped/cancelled)', chatId);
            return;
        }
        if (s.attempts >= cfg.maxRetries) {
            showToast('Auto-retry: gave up after ' + cfg.maxRetries + ' tries.');
            log('gave up', chatId, reason);
            s.attempts = 0;
            return;
        }
        s.attempts += 1;
        const rl = isRateLimit(err);
        const delay = computeDelay(s.attempts, rl);
        clearTimers(s);
        s.pending = true;
        log('retry ' + s.attempts + '/' + cfg.maxRetries + ' in ' + delay + 'ms (' + reason + (rl ? ', rate-limited': '') + ')');
        showToast('Retrying ' + s.attempts + '/' + cfg.maxRetries + ' (' + reason + ') in ' + (delay / 1000).toFixed(1) + 's', {
            cancel: () => standDown(chatId, true),
            sticky: true
        });
        s.timer = setTimeout(() => {
            s.timer = null;
            s.pending = false;
            s.selfTriggered = true;
            if (!fireRetry()) {
                s.selfTriggered = false;
                s.attempts = 0;
            } // click failed, do not leave stale state
        },
        delay);
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
            while (s.ignored.size > IGNORE_MAX) s.ignored.delete(s.ignored.values().next().value);
        }
        stopGenerating();
        scheduleRetry(chatId, reason);
    }
    function onStart(p) {
        if (!p || !p.chatId) return;
        const s = st(p.chatId);
        log('gen start', p.generationId, s.selfTriggered ? '(auto-retry)': '(user)');
        if (!s.selfTriggered) {
            s.attempts = 0;
            s.suppressUntil = 0;
        } // fresh, user-initiated generation
        s.selfTriggered = false;
        s.genId = p.generationId;
        s.sawReasoning = false;
        s.sawContent = false;
        clearTimers(s);
        if (cfg.enabled && cfg.stuckTimeoutMs > 0) {
            s.startTimer = setTimeout(() => abortAndRetry(p.chatId, 'stuck'), cfg.stuckTimeoutMs);
        }
    }
    function onToken(p) {
        if (!p || !p.chatId) return;
        const s = st(p.chatId);
        if (p.type === 'reasoning') s.sawReasoning = true;
        else s.sawContent = true;
        // streaming is alive: drop the start watchdog, arm the idle watchdog
        if (s.startTimer) {
            clearTimeout(s.startTimer);
            s.startTimer = null;
        }
        if (cfg.enabled && cfg.idleTimeoutMs > 0) {
            if (s.idleTimer) clearTimeout(s.idleTimer);
            s.idleTimer = setTimeout(() => abortAndRetry(p.chatId, 'stalled'), cfg.idleTimeoutMs);
        }
    }
    function onEnd(p) {
        if (!p || !p.chatId) return;
        const s = st(p.chatId);
        if (s.ignored.has(p.generationId)) return; // aborted gen's trailing event, retry already scheduled
        clearTimers(s);
        if (Date.now() < s.suppressUntil) {
            log('gen end ignored (just stopped)');
            s.attempts = 0;
            return;
        } // user just stopped; do not retry
        if (p.error) {
            // A content-moderation block we can retry as a refusal is not a permanent
            // failure, so don't let the hard-error skip swallow it before the refusal check.
            if (cfg.ignoreHardErrors && isHardError(p.error) && !(cfg.retryOnRefusal && looksLikeRefusalError(String(p.error), cfg))) {
                log('hard error ignored', p.error);
                showToast('Auto-retry skipped: hard failure (auth/model).');
                s.attempts = 0;
                return;
            }
            if (cfg.retryOnError) {
                scheduleRetry(p.chatId, 'error', p.error);
                return;
            }
            if (cfg.retryOnRefusal && looksLikeRefusalError(String(p.error), cfg)) {
                scheduleRetry(p.chatId, 'looks like an accidental refusal');
                return;
            }
            return;
        }
        const content = String(p.content || '').trim();
        if (cfg.retryOnEmpty && content.length === 0) {
            scheduleRetry(p.chatId, (s.sawReasoning && !s.sawContent) ? 'cut off mid-reasoning': 'empty');
            return;
        }
        if (cfg.retryOnTruncated && looksTruncated(content, cfg.retryOnNoPunct)) {
            scheduleRetry(p.chatId, 'cut off');
            return;
        }
        if (cfg.retryOnRefusal && looksLikeRefusal(content, cfg)) {
            scheduleRetry(p.chatId, 'looks like an accidental refusal');
            return;
        }
        if (cfg.retryOnShort && content.length < cfg.minChars) {
            scheduleRetry(p.chatId, 'short');
            return;
        }
        log('gen ok', content.length + ' chars');
        s.attempts = 0; // clean success
    }
    function onStop(p) {
        if (!p || !p.chatId) return;
        const s = st(p.chatId);
        if (s.ignored.has(p.generationId)) return; // our own abort, not a user stop
        log('user stop', p.generationId);
        standDown(p.chatId, true); // genuine user stop: stand down, don't fight them
    }
    // Backup for the user's Stop press: if the host's GENERATION_STOPPED event is
    // late or never fires, catch the click on the stop button itself and stand
    // every pending retry down. Delegated + capture so it survives the host
    // re-rendering its buttons.
    function onDocClick(e) {
        try {
            const tgt = e && e.target && e.target.closest ? e.target.closest(cfg.stopSelector) : null;
            if (!tgt) return;
            chats.forEach((s, id) => {
                if (s.pending || s.timer || s.attempts > 0) standDown(id, true);
            });
        } catch(_) {}
    }
    // ---- toast with an optional Cancel button ----
    function ensureToast() {
        if (typeof document === 'undefined') return null;
        let t = document.getElementById('__lvRetryToast');
        if (!t) {
            t = document.createElement('div');
            t.id = '__lvRetryToast';
            t.style.cssText = 'position:fixed;bottom:max(20px,env(safe-area-inset-bottom,0px));left:50%;transform:translateX(-50%);' + 'z-index:2147483647;display:flex;align-items:center;gap:10px;' + 'font:13px/1.4 var(--lumiverse-font-family,system-ui);padding:9px 12px;border-radius:12px;' + 'color:var(--lumiverse-text,#fff);background:var(--lumiverse-fill,rgba(20,16,30,.96));' + 'border:1px solid var(--lumiverse-border,rgba(255,255,255,.18));' + 'box-shadow:0 8px 24px rgba(0,0,0,.45);transition:opacity .2s ease;' + 'opacity:0;max-width:min(92vw,460px);text-align:left';
            (document.body || document.documentElement).appendChild(t);
        }
        return t;
    }
    function hideToast() {
        const t = (typeof document !== 'undefined') && document.getElementById('__lvRetryToast');
        if (t) {
            clearTimeout(t.__h);
            t.style.opacity = '0';
            t.style.pointerEvents = 'none';
        }
    }
    function showToast(msg, opts) {
        if (!cfg.toast) return;
        const t = ensureToast();
        if (!t) return;
        try {
            t.innerHTML = '';
            const span = document.createElement('span');
            span.textContent = msg;
            span.style.cssText = 'flex:1';
            t.appendChild(span);
            if (opts && opts.cancel) {
                const c = document.createElement('button');
                c.textContent = 'Cancel';
                c.style.cssText = 'flex:none;min-height:36px;padding:6px 14px;border-radius:8px;cursor:pointer;' + 'font:13px var(--lumiverse-font-family,system-ui);' + 'border:1px solid var(--lumiverse-border,rgba(255,255,255,.28));' + 'background:var(--lumiverse-fill-subtle,rgba(255,255,255,.08));color:var(--lumiverse-text,#fff)';
                c.addEventListener('click', () => {
                    try {
                        opts.cancel && opts.cancel();
                    } catch(_) {}
                });
                const cClear = () => {
                    c.style.filter = 'none';
                };
                c.addEventListener('pointerdown', () => {
                    c.style.filter = 'brightness(1.2)';
                });
                c.addEventListener('pointerup', cClear);
                c.addEventListener('pointercancel', cClear);
                c.addEventListener('pointerleave', cClear);
                t.appendChild(c);
                t.style.pointerEvents = 'auto';
            } else {
                t.style.pointerEvents = 'none';
            }
            t.style.opacity = '1';
            clearTimeout(t.__h);
            if (! (opts && opts.sticky)) {
                t.__h = setTimeout(() => {
                    t.style.opacity = '0';
                    t.style.pointerEvents = 'none';
                },
                3200);
            }
        } catch(_) {}
    }
    // ---- debug info for bug reports ----
    // A one-tap snapshot anyone can paste into a report without opening dev tools:
    // version, current settings, whether each button selector matches right now,
    // and the browser string. The console log (above) is the live timeline; this
    // is the still photo.
    function selectorState(sel) {
        try {
            return document.querySelector(sel) ? 'match': 'no match';
        } catch(_) {
            return 'invalid selector';
        }
    }
    function buildDebugInfo(opts) {
        const o = opts || {};
        const inc = (v) => v !== false; // sections default to on
        const keys = ['enabled', 'maxRetries', 'retryDelayMs', 'backoffFactor', 'maxDelayMs', 'jitter', 'rateLimitDelayMs', 'stuckTimeoutMs', 'idleTimeoutMs', 'retryOnError', 'ignoreHardErrors', 'retryOnEmpty', 'retryOnTruncated', 'retryOnNoPunct', 'retryOnShort', 'minChars', 'retryOnRefusal', 'refusalUseBuiltins', 'refusalMaxChars', 'refusalExtraPhrases', 'refusalPhraseSubs', 'refusalIgnorePhrases', 'refusalStripThinking', 'refusalThinkTags', 'replaceEnabled', 'replaceRules', 'replaceRandom', 'replaceCaseSensitive', 'liveLog', 'toast'];
        const lines = [];
        lines.push('Auto Retry v' + VERSION + ' debug info');
        lines.push('time: ' + new Date().toISOString());
        if (inc(o.settings)) {
            lines.push('');
            lines.push('settings:');
            for (const k of keys) lines.push('  ' + k + ': ' + JSON.stringify(cfg[k]));
        }
        if (inc(o.buttons)) {
            lines.push('');
            lines.push('buttons (checked right now):');
            lines.push('  regenerate: ' + selectorState(cfg.regenerateSelector));
            lines.push('  swipeNext:  ' + selectorState(cfg.swipeNextSelector));
            lines.push('  stop:       ' + selectorState(cfg.stopSelector));
            lines.push('  regenerateSelector = ' + cfg.regenerateSelector);
            lines.push('  swipeNextSelector  = ' + cfg.swipeNextSelector);
            lines.push('  stopSelector       = ' + cfg.stopSelector);
        }
        if (inc(o.environment)) {
            try {
                lines.push('');
                lines.push('browser: ' + ((navigator && navigator.userAgent) || 'unknown'));
            } catch(_) {}
            try {
                lines.push('screen: ' + ((window && window.innerWidth) || '?') + ' x ' + ((window && window.innerHeight) || '?'));
            } catch(_) {}
        }
        if (inc(o.activity)) {
            lines.push('');
            lines.push('recent activity (oldest first):');
            if (eventLog.length === 0) lines.push('  (nothing recorded yet)');
            else for (const e of eventLog) lines.push('  ' + e);
        }
        return lines.join('\n');
    }
    function fallbackCopy(text) {
        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0';
            (document.body || document.documentElement).appendChild(ta);
            ta.focus();
            ta.select();
            const ok = !!(document.execCommand && document.execCommand('copy'));
            ta.remove();
            return ok;
        } catch(_) {
            return false;
        }
    }
    function copyText(text) {
        try {
            if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
                return navigator.clipboard.writeText(text).then(() => true, () => fallbackCopy(text));
            }
        } catch(_) {}
        return Promise.resolve(fallbackCopy(text));
    }
    // Save text as a file download. Returns false if the browser blocks it.
    function downloadText(filename, text) {
        try {
            const blob = new Blob([text], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => {
                try {
                    URL.revokeObjectURL(url);
                } catch(_) {}
            },
            1000);
            return true;
        } catch(_) {
            return false;
        }
    }
    // Read a chosen file as text and hand it to cb.
    function readFileAsText(file, cb) {
        try {
            const reader = new FileReader();
            reader.onload = () => cb(typeof reader.result === 'string' ? reader.result: null);
            reader.onerror = () => cb(null);
            reader.readAsText(file);
        } catch(_) {
            cb(null);
        }
    }
    // ---- settings UI ----
    let modalHandle = null;
    let modalRoot = null;
    let modalSnapshot = null;
    function buildSettingsBody(root, onSaved) {
        root.innerHTML = '';
        // Cap the whole panel to a real viewport value that sits safely under the
        // modal's max-height once its title bar and padding are counted. With the
        // panel bounded and overflow hidden, the host modal has nothing left to
        // over-scroll, so its own full-height scrollbar never appears; only the
        // options list below scrolls. vh units keep it sane on phones too.
        const panel = document.createElement('div');
        panel.style.cssText = 'display:flex;flex-direction:column;max-height:min(72vh,460px);overflow:hidden;box-sizing:border-box;font:13px/1.45 var(--lumiverse-font-family,system-ui);color:var(--lumiverse-text,#eee)';
        // the one scroll area: flexes to fill whatever height is left after the
        // footer. min-height:0 lets it actually shrink and scroll inside the flex.
        const scroller = document.createElement('div');
        scroller.style.cssText = 'display:flex;flex-direction:column;gap:18px;flex:1 1 auto;min-height:0;overflow-y:auto;padding-right:4px';
        for (const group of SCHEMA) {
            const sec = document.createElement('div');
            sec.style.cssText = 'display:flex;flex-direction:column;gap:10px';
            // Groups titled "Advanced..." collapse by default so the basic options
            // aren't buried under them. Tap the header to reveal.
            const advanced = /^advanced\b/i.test(group.title);
            const h = document.createElement('div');
            h.style.cssText = 'font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:var(--lumiverse-text-muted,#9a93a8)';
            if (advanced) {
                h.style.cursor = 'pointer';
                h.style.userSelect = 'none';
                h.style.display = 'flex';
                h.style.alignItems = 'center';
                h.style.gap = '6px';
                const caret = document.createElement('span');
                caret.textContent = '\u25B8'; // right triangle when collapsed
                caret.style.cssText = 'font-size:9px';
                const label = document.createElement('span');
                label.textContent = group.title;
                h.appendChild(caret);
                h.appendChild(label);
                sec.appendChild(h);
                const body = document.createElement('div');
                body.style.cssText = 'display:none;flex-direction:column;gap:10px';
                if (group.desc) {
                    const d = document.createElement('div');
                    d.textContent = group.desc;
                    d.style.cssText = 'font-size:12px;line-height:1.45;color:var(--lumiverse-text-muted,#9a93a8)';
                    body.appendChild(d);
                }
                for (const f of group.fields) body.appendChild(buildRow(f));
                sec.appendChild(body);
                let open = false;
                h.addEventListener('click', () => {
                    open = !open;
                    body.style.display = open ? 'flex': 'none';
                    caret.textContent = open ? '\u25BE': '\u25B8'; // down triangle when open
                });
            } else {
                h.textContent = group.title;
                sec.appendChild(h);
                if (group.desc) {
                    const d = document.createElement('div');
                    d.textContent = group.desc;
                    d.style.cssText = 'font-size:12px;line-height:1.45;color:var(--lumiverse-text-muted,#9a93a8);margin-top:-4px';
                    sec.appendChild(d);
                }
                for (const f of group.fields) sec.appendChild(buildRow(f));
            }
            scroller.appendChild(sec);
        }
        // debug info section (collapsible): choose what to include, review, redact, copy
        {
            const sec = document.createElement('div');
            sec.style.cssText = 'display:flex;flex-direction:column;gap:10px';
            const h = document.createElement('div');
            h.style.cssText = 'font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:var(--lumiverse-text-muted,#9a93a8);cursor:pointer;user-select:none;display:flex;align-items:center;gap:6px';
            const caret = document.createElement('span');
            caret.textContent = '\u25B8';
            caret.style.cssText = 'font-size:9px';
            const label = document.createElement('span');
            label.textContent = 'Advanced: debug info';
            h.appendChild(caret);
            h.appendChild(label);
            sec.appendChild(h);
            const body = document.createElement('div');
            body.style.cssText = 'display:none;flex-direction:column;gap:10px';
            const desc = document.createElement('div');
            desc.textContent = 'A snapshot for your own debugging or a bug report. Tick the parts to include, build a preview, edit out anything you would rather not share, then copy. Nothing leaves your device until you paste it somewhere.';
            desc.style.cssText = 'font-size:12px;line-height:1.45;color:var(--lumiverse-text-muted,#9a93a8)';
            body.appendChild(desc);
            const sections = [{
                id: 'settings',
                label: 'Your settings'
            },
            {
                id: 'buttons',
                label: 'Button match status'
            },
            {
                id: 'environment',
                label: 'Browser and screen'
            },
            {
                id: 'activity',
                label: 'Recent activity log'
            },
            ];
            const dchecks = [];
            const dWrap = document.createElement('div');
            dWrap.style.cssText = 'display:flex;flex-direction:column;gap:6px';
            for (const s of sections) {
                const row = document.createElement('label');
                row.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer';
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.checked = true;
                cb.style.cssText = 'accent-color:var(--lumiverse-primary,#7c5cff);cursor:pointer';
                const txt = document.createElement('span');
                txt.textContent = s.label;
                row.appendChild(cb);
                row.appendChild(txt);
                dWrap.appendChild(row);
                dchecks.push({
                    id: s.id,
                    input: cb
                });
            }
            body.appendChild(dWrap);
            const opts = () => {
                const o = {};
                for (const c of dchecks) o[c.id] = c.input.checked;
                return o;
            };
            const dStatus = document.createElement('div');
            dStatus.style.cssText = 'font-size:12px;line-height:1.4;color:var(--lumiverse-text-muted,#9a93a8);min-height:1em';
            const dArea = document.createElement('textarea');
            dArea.rows = 6;
            dArea.placeholder = 'Press Build preview to fill this, then edit out anything private before copying.';
            dArea.style.cssText = 'width:100%;box-sizing:border-box;font-family:monospace;font-size:12px;padding:8px;border-radius:8px;border:1px solid var(--lumiverse-border,#3a3543);background:var(--lumiverse-bg,#1a1720);color:var(--lumiverse-text,#e9e4f0);resize:vertical';
            const buildBtn = btn('Build preview', false);
            buildBtn.addEventListener('click', () => {
                dArea.value = buildDebugInfo(opts());
                dStatus.textContent = 'Built. Edit anything you want to remove, then Copy.';
            });
            const copyBtn = btn('Copy', false);
            copyBtn.addEventListener('click', async () => {
                if (!dArea.value.trim()) dArea.value = buildDebugInfo(opts());
                const ok = await copyText(dArea.value);
                dStatus.textContent = ok ? 'Copied. Paste it into your bug report.': "Couldn't copy here; select the text and copy by hand.";
            });
            body.appendChild(buildBtn);
            body.appendChild(dArea);
            body.appendChild(copyBtn);
            body.appendChild(dStatus);
            sec.appendChild(body);
            let open = false;
            h.addEventListener('click', () => {
                open = !open;
                body.style.display = open ? 'flex': 'none';
                caret.textContent = open ? '\u25BE': '\u25B8';
            });
            scroller.appendChild(sec);
        }
        // import / export section (collapsible, same look as the Advanced groups)
        {
            const sec = document.createElement('div');
            sec.style.cssText = 'display:flex;flex-direction:column;gap:10px';
            const h = document.createElement('div');
            h.style.cssText = 'font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:var(--lumiverse-text-muted,#9a93a8);cursor:pointer;user-select:none;display:flex;align-items:center;gap:6px';
            const caret = document.createElement('span');
            caret.textContent = '\u25B8';
            caret.style.cssText = 'font-size:9px';
            const label = document.createElement('span');
            label.textContent = 'Advanced: import / export';
            h.appendChild(caret);
            h.appendChild(label);
            sec.appendChild(h);
            const body = document.createElement('div');
            body.style.cssText = 'display:none;flex-direction:column;gap:10px';
            const desc = document.createElement('div');
            desc.textContent = 'Save your settings to a file, or load them from one. Tick which parts to include (retry behavior, refusal detection, word swaps, button selectors, on-screen), then Export to file to save the ticked parts, or Import from file to load a file. An import puts the values from the file into the settings above without saving them, so you can review them first: press Save to keep them, or close the settings to discard them.';
            desc.style.cssText = 'font-size:12px;line-height:1.45;color:var(--lumiverse-text-muted,#9a93a8)';
            body.appendChild(desc);
            const checks = [];
            const checkWrap = document.createElement('div');
            checkWrap.style.cssText = 'display:flex;flex-direction:column;gap:6px';
            for (const c of EXPORT_CATEGORIES) {
                const row = document.createElement('label');
                row.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer';
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.checked = true;
                cb.style.cssText = 'accent-color:var(--lumiverse-primary,#7c5cff);cursor:pointer';
                const txt = document.createElement('span');
                txt.textContent = c.label;
                row.appendChild(cb);
                row.appendChild(txt);
                checkWrap.appendChild(row);
                checks.push({
                    id: c.id,
                    input: cb
                });
            }
            body.appendChild(checkWrap);
            const chosen = () => checks.filter((x) => x.input.checked).map((x) => x.id);
            const status = document.createElement('div');
            status.style.cssText = 'font-size:12px;line-height:1.4;color:var(--lumiverse-text-muted,#9a93a8);min-height:1em';
            status.textContent = ioStatus;
            ioStatus = '';
            const exportBtn = btn('Export to file', false);
            exportBtn.addEventListener('click', () => {
                const ids = chosen();
                if (!ids.length) {
                    status.textContent = 'Tick at least one part to export.';
                    return;
                }
                const ok = downloadText('auto-retry-settings.json', buildExport(ids));
                status.textContent = ok ? 'Saved a file with the ticked parts.': "Couldn't save a file here.";
            });
            const fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.accept = 'application/json,.json';
            fileInput.style.display = 'none';
            fileInput.addEventListener('change', () => {
                const f = fileInput.files && fileInput.files[0];
                fileInput.value = '';
                if (!f) return;
                const ids = chosen();
                if (!ids.length) {
                    status.textContent = 'Tick at least one part to import.';
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
                    if (!applied.length) {
                        status.textContent = 'Nothing matched the ticked parts in that file.';
                        return;
                    }
                    ioStatus = 'Imported: ' + applied.join(', ') + '. Press Save to keep it.';
                    buildSettingsBody(root, onSaved);
                });
            });
            const importBtn = btn('Import from file', false);
            importBtn.addEventListener('click', () => {
                if (!chosen().length) {
                    status.textContent = 'Tick at least one part to import first.';
                    return;
                }
                fileInput.click();
            });
            const btnRow = document.createElement('div');
            btnRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px';
            btnRow.appendChild(exportBtn);
            btnRow.appendChild(importBtn);
            body.appendChild(btnRow);
            body.appendChild(fileInput);
            body.appendChild(status);
            sec.appendChild(body);
            let open = false;
            h.addEventListener('click', () => {
                open = !open;
                body.style.display = open ? 'flex': 'none';
                caret.textContent = open ? '\u25BE': '\u25B8';
            });
            scroller.appendChild(sec);
        }
        panel.appendChild(scroller);
        // footer: a plain bar below the scroll area, set off by a single hairline
        // rule. flex-wrap lets the buttons stack on a narrow phone screen.
        const actions = document.createElement('div');
        actions.style.cssText = 'display:flex;align-items:center;flex-wrap:wrap;gap:8px;flex:none;margin-top:14px;padding-top:14px;border-top:1px solid var(--lumiverse-border,rgba(255,255,255,.08))';
        const status = document.createElement('span');
        status.style.cssText = 'flex:1;min-width:120px;font-size:12px;color:var(--lumiverse-text-muted,#9a93a8)';
        const reset = btn('Reset to defaults', false);
        reset.addEventListener('click', async () => {
            let ok = true;
            try {
                if (ctx?.ui?.showConfirm) {
                    const r = await ctx.ui.showConfirm({
                        title: 'Reset settings',
                        message: 'Put every Auto Retry setting back to its default?',
                        variant: 'warning',
                        confirmLabel: 'Reset',
                    });
                    ok = !!r?.confirmed;
                }
            } catch(_) {}
            if (!ok) return;
            for (const g of SCHEMA) for (const fl of g.fields) cfg[fl.key] = CONFIG[fl.key];
            saveSaved();
            saveToAccount();
            syncLiveLog();
            if (onSaved) onSaved();
            buildSettingsBody(root, onSaved);
            log('settings reset to defaults');
        });
        const save = btn('Save', true);
        save.addEventListener('click', () => {
            // Commit a field the user is still editing, then normalise every number
            // so a blank or out-of-range box can't be saved.
            const active = (typeof document !== 'undefined') ? document.activeElement: null;
            if (active && typeof active.blur === 'function') active.blur();
            for (const g of SCHEMA) for (const fl of g.fields) if (fl.type === 'num') cfg[fl.key] = clampField(fl, cfg[fl.key]);
            saveSaved();
            saveToAccount();
            syncLiveLog();
            if (onSaved) onSaved();
            status.textContent = 'Saved. Takes effect on the next reply.';
            log('settings saved', cfg);
            setTimeout(() => {
                status.textContent = '';
            },
            2600);
        });
        actions.appendChild(status);
        actions.appendChild(reset);
        actions.appendChild(save);
        panel.appendChild(actions);
        root.appendChild(panel);
    }
    function buildRow(f) {
        // bool/num wrap in <label> so the whole row toggles or focuses its control.
        // text rows use <div> because they contain a Test button, which shouldn't sit inside a label.
        const row = document.createElement(f.type === 'text' ? 'div': 'label');
        row.style.cssText = 'display:flex;flex-direction:column;gap:5px;cursor:' + (f.type === 'text' ? 'default': 'pointer');
        const top = document.createElement('div');
        top.style.cssText = 'display:flex;align-items:center;gap:10px;justify-content:space-between';
        const name = document.createElement('span');
        name.textContent = f.label;
        name.style.cssText = 'font-size:13.5px';
        top.appendChild(name);
        if (f.type === 'bool') {
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.checked = !!cfg[f.key];
            input.style.cssText = 'flex:none;width:20px;height:20px;accent-color:var(--lumiverse-primary,#7c5cff);cursor:pointer';
            input.addEventListener('change', () => {
                cfg[f.key] = input.checked;
            });
            top.appendChild(input);
            row.appendChild(top);
        } else if (f.type === 'num') {
            const input = document.createElement('input');
            input.type = 'number';
            input.inputMode = 'numeric';
            input.value = String(cfg[f.key]);
            styleField(input);
            input.style.width = '120px';
            input.style.flex = 'none';
            input.addEventListener('change', () => {
                cfg[f.key] = clampField(f, input.value);
                input.value = String(cfg[f.key]);
            });
            top.appendChild(input);
            row.appendChild(top);
        } else {
            row.appendChild(top);
            const isMultiline = !f.selector;
            const input = document.createElement(isMultiline ? 'textarea': 'input');
            if (isMultiline) {
                input.rows = 4;
                input.style.resize = 'vertical';
            } else {
                input.type = 'text';
            }
            input.value = String(cfg[f.key]);
            input.setAttribute('aria-label', f.label);
            styleField(input);
            input.addEventListener('change', () => {
                cfg[f.key] = input.value;
            });
            row.appendChild(input);
            if (f.selector) {
                const testRow = document.createElement('div');
                testRow.style.cssText = 'display:flex;align-items:center;gap:8px';
                const test = btn('Test', false);
                test.style.padding = '5px 12px';
                const res = document.createElement('span');
                res.style.cssText = 'font-size:12px;color:var(--lumiverse-text-muted,#9a93a8)';
                test.addEventListener('click', () => {
                    const sel = input.value.trim();
                    if (!sel) {
                        res.textContent = 'type a selector first';
                        res.style.color = 'var(--lumiverse-text-muted,#9a93a8)';
                        return;
                    }
                    let match = false;
                    try {
                        match = !!document.querySelector(sel);
                    } catch(_) {
                        res.textContent = "that selector isn't valid";
                        res.style.color = 'var(--lumiverse-danger,#ff6b6b)';
                        return;
                    }
                    res.textContent = match ? 'match found': 'no match right now';
                    res.style.color = match ? 'var(--lumiverse-success,#46d39a)': 'var(--lumiverse-text-muted,#9a93a8)';
                });
                testRow.appendChild(test);
                testRow.appendChild(res);
                row.appendChild(testRow);
            }
        }
        if (f.hint) {
            const hint = document.createElement('span');
            hint.textContent = f.hint;
            hint.style.cssText = 'font-size:12px;line-height:1.45;color:var(--lumiverse-text-muted,#9a93a8)';
            row.appendChild(hint);
        }
        return row;
    }
    function styleField(input) {
        input.style.cssText += 'padding:9px 10px;border-radius:var(--lumiverse-radius,8px);' + 'border:1px solid var(--lumiverse-border,rgba(255,255,255,.16));' + 'background:var(--lumiverse-fill-subtle,rgba(255,255,255,.05));' + 'color:var(--lumiverse-text,#eee);font:13px var(--lumiverse-font-family,system-ui);outline:none;' + 'transition:border-color .12s ease';
        input.addEventListener('focus', () => {
            input.style.borderColor = 'var(--lumiverse-primary,#7c5cff)';
        });
        input.addEventListener('blur', () => {
            input.style.borderColor = 'var(--lumiverse-border,rgba(255,255,255,.16))';
        });
    }
    function btn(label, primary) {
        const b = document.createElement('button');
        b.textContent = label;
        b.style.cssText = 'min-height:36px;padding:8px 14px;border-radius:var(--lumiverse-radius,8px);cursor:pointer;' + 'font:13px var(--lumiverse-font-family,system-ui);transition:filter .12s ease;' + (primary ? 'border:1px solid transparent;background:var(--lumiverse-primary,#7c5cff);color:var(--lumiverse-primary-contrast,#fff)': 'border:1px solid var(--lumiverse-border,rgba(255,255,255,.16));background:transparent;color:var(--lumiverse-text,#eee)');
        b.addEventListener('mouseenter', () => {
            b.style.filter = 'brightness(1.12)';
        });
        b.addEventListener('mouseleave', () => {
            b.style.filter = 'none';
        });
        // Press feedback that also works on touch, where hover never fires.
        const pressClear = () => {
            b.style.filter = 'none';
        };
        b.addEventListener('pointerdown', () => {
            b.style.filter = 'brightness(.9)';
        });
        b.addEventListener('pointerup', pressClear);
        b.addEventListener('pointercancel', pressClear);
        b.addEventListener('pointerleave', pressClear);
        return b;
    }
    function openSettings() {
        if (!ctx?.ui?.showModal) {
            log('host has no modal API; cannot open settings');
            return;
        }
        try {
            if (modalHandle) {
                try {
                    modalHandle.dismiss();
                } catch(_) {}
                modalHandle = null;
            }
            // Size to the screen so it fits on a phone as well as a desktop.
            const vw = (typeof window !== 'undefined' && window.innerWidth) ? window.innerWidth: 480;
            const vh = (typeof window !== 'undefined' && window.innerHeight) ? window.innerHeight: 720;
            const modal = ctx.ui.showModal({
                title: 'Auto Retry settings',
                width: Math.min(460, vw - 24),
                maxHeight: Math.min(560, vh - 24),
            });
            modalHandle = modal;
            modalRoot = modal.root;
            let baseline = {};
            const snapshot = () => {
                baseline = {};
                for (const g of SCHEMA) for (const fl of g.fields) baseline[fl.key] = cfg[fl.key];
            };
            snapshot();
            modalSnapshot = snapshot;
            buildSettingsBody(modal.root, snapshot);
            modal.onDismiss(() => {
                for (const g of SCHEMA) for (const fl of g.fields) cfg[fl.key] = baseline[fl.key];
                modalHandle = null;
                modalRoot = null;
                modalSnapshot = null;
            });
        } catch(e) {
            log('failed to open settings', e);
        }
    }
    // entry point: a button in the chat input "Extras" popover
    try {
        if (ctx?.ui?.registerInputBarAction) {
            const action = ctx.ui.registerInputBarAction({
                id: 'auto-retry-settings',
                label: 'Auto Retry settings',
                iconSvg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><polyline points="21 4 21 9 16 9"/></svg>',
            });
            disposers.push(action.onClick(() => openSettings()));
            disposers.push(() => {
                try {
                    action.destroy();
                } catch(_) {}
            });
        } else {
            log('host has no input bar action API; open settings via ctx only');
        }
    } catch(e) {
        log('failed to register settings action', e);
    }
    // backup stop-press catcher (see onDocClick)
    if (typeof document !== 'undefined') {
        document.addEventListener('click', onDocClick, true);
        disposers.push(() => {
            try {
                document.removeEventListener('click', onDocClick, true);
            } catch(_) {}
        });
    }
    // Wrap each listener so a throw inside a handler is logged, never escapes into
    // the host's event dispatcher, and never stops later events from arriving.
    const safe = (label, fn) => (p) => {
        try {
            fn(p);
        } catch(e) {
            log('handler error in ' + label, e);
        }
    };
    let offs = [];
    try {
        offs = [ctx.events.on('GENERATION_STARTED', safe('GENERATION_STARTED', onStart)), ctx.events.on('STREAM_TOKEN_RECEIVED', safe('STREAM_TOKEN_RECEIVED', onToken)), ctx.events.on('GENERATION_ENDED', safe('GENERATION_ENDED', onEnd)), ctx.events.on('GENERATION_STOPPED', safe('GENERATION_STOPPED', onStop)), ];
    } catch(e) {
        log('failed to subscribe to generation events', e);
    }
    syncLiveLog();
    loadFromAccount();
    log('ready v' + VERSION, cfg);
    return () => {
        offs.forEach((o) => {
            try {
                o && o();
            } catch(_) {}
        });
        disposers.forEach((d) => {
            try {
                d && d();
            } catch(_) {}
        });
        if (modalHandle) {
            try {
                modalHandle.dismiss();
            } catch(_) {}
            modalHandle = null;
        }
        hideLiveLog();
        chats.forEach(clearTimers);
        chats.clear();
        eventLog.length = 0;
        try {
            if (typeof document !== 'undefined' && document.getElementById) {
                const t = document.getElementById('__lvRetryToast');
                if (t) {
                    clearTimeout(t.__h);
                    if (t.remove) t.remove();
                }
            }
        } catch(_) {}
    };
}
