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
 *
 * The user is always in charge: pressing Stop, or tapping Cancel on the retry
 * pop-up, stands the extension down immediately and briefly suppresses any
 * further automatic retries, so it can never fight you or pile up.
 */
const STORE_KEY = 'lv-auto-retry:settings:v1';
// How long (ms) to suppress automatic retries after the user stops or cancels.
// Long enough to swallow the stopped generation's own trailing events.
const STAND_DOWN_MS = 2500;
const IGNORE_MAX = 16; // most aborted-generation ids kept around to swallow their late events
// Bumped on each release. Shown in the startup log and in the Copy debug info
// report, so a bug report always says which version it came from.
const VERSION = '1.1.5';
// ---- defaults (the UI overrides these; editing here changes the fallback) ----
const CONFIG = {
    enabled: true,
    // retry budget
    maxRetries: 4,
    retryDelayMs: 1200, // first retry fires a touch sooner; backoff still climbs
    backoffFactor: 2,
    maxDelayMs: 30000,
    jitter: true,
    // rate limiting (HTTP 429 / overloaded)
    rateLimitDelayMs: 8000,
    // watchdogs. Tuned to tolerate a slow connection and slow local models so a
    // slow-but-fine generation is not mistaken for a stall and retried into a pile-up.
    stuckTimeoutMs: 90000, // started but never produced a token or an end. 0 disables.
    idleTimeoutMs: 45000, // tokens were flowing then stopped this long (mid-stream cutoff). 0 disables.
    // what counts as needing a retry
    retryOnError: true,
    retryOnEmpty: true, // also catches a generation cut off mid-reasoning (reasoning seen, content empty)
    retryOnTruncated: true, // final content present but cut off mid-sentence (structural heuristic, see looksTruncated)
    retryOnNoPunct: false, // extra: also treat "ends with no punctuation" as truncated. Noisy in RP, off by default.
    retryOnShort: false, // off by default. Caused endless regen in the original.
    minChars: 24,
    // host controls (the only DOM-dependent part). Use the Test buttons in settings.
    // Multiple patterns are listed so a Lumiverse build that renames one attribute
    // is still likely covered; if a build changes them all, fix it via the Test UI.
    regenerateSelector: '[data-action="regenerate"], [data-testid="regenerate"], ' +
        'button[aria-label*="regenerate" i], button[title*="regenerate" i]',
    swipeNextSelector: '[data-action="swipe-right"], button[aria-label*="next swipe" i], button[aria-label*="next" i]',
    stopSelector: '[data-action="stop"], [data-testid="stop"], ' +
        'button[aria-label*="stop" i], button[title*="stop" i], [class*="_sendBtnStop_"]',
    toast: true,
    log: false,
};
const SCHEMA = [
    { title: 'On / off',
        desc: 'The main switch for the whole extension.',
        fields: [
            { key: 'enabled', label: 'Turn auto-retry on', type: 'bool', hint: "When on, it quietly tries again whenever a reply fails or gets cut off. Turn it off and it does nothing." },
        ] },
    { title: 'How hard it tries',
        desc: 'How persistent it is, and how long it waits between tries.',
        fields: [
            { key: 'maxRetries', label: 'Most tries per message', type: 'num', int: true, min: 0, max: 50, hint: 'How many times it retries one message before giving up. 3 to 5 suits most people.' },
            { key: 'retryDelayMs', label: 'Wait before the first retry', type: 'num', int: true, min: 0, max: 600000, hint: 'How long it pauses before trying again the first time. In milliseconds, so the 1200 default is 1.2 seconds.' },
            { key: 'backoffFactor', label: 'How much longer each wait gets', type: 'num', min: 1, max: 10, hint: "Each retry waits this many times longer than the last, so it doesn't hammer the server. 2 means the wait doubles each time. Stays at 1 or above." },
            { key: 'maxDelayMs', label: 'Longest it will ever wait', type: 'num', int: true, min: 0, max: 600000, hint: "A ceiling so it never pauses forever. 30000 = 30 seconds." },
            { key: 'rateLimitDelayMs', label: 'Wait when the server is busy', type: 'num', int: true, min: 0, max: 600000, hint: 'If the server says "too many requests," it waits at least this long. 8000 = 8 seconds.' },
            { key: 'jitter', label: 'Add a little randomness to waits', type: 'bool', hint: "Nudges each wait by a random amount so retries don't all hit the server at the same instant. Best left on." },
        ] },
    { title: 'Watch for frozen replies',
        desc: "These notice when a reply freezes or never shows up, and step in. On a slow connection or a slow local model, make these numbers bigger.",
        fields: [
            { key: 'stuckTimeoutMs', label: 'Give up waiting for it to start', type: 'num', int: true, min: 0, max: 600000, hint: "If a reply begins but no words appear in this long, treat it as stuck and retry. 90000 = 90 seconds. Set to 0 to switch off." },
            { key: 'idleTimeoutMs', label: 'Give up on a reply that froze', type: 'num', int: true, min: 0, max: 600000, hint: "If words were appearing and then stop for this long, treat it as frozen and retry. 45000 = 45 seconds. Set to 0 to switch off. Raise it if your model takes long natural pauses." },
        ] },
    { title: 'When to count a reply as bad',
        desc: 'Pick which kinds of bad reply should trigger a retry.',
        fields: [
            { key: 'retryOnError', label: 'It came back as an error', type: 'bool', hint: 'Retry when the reply fails outright with an error.' },
            { key: 'retryOnEmpty', label: 'It came back blank', type: 'bool', hint: 'Retry when nothing comes back, including a reply that thinks but never writes anything.' },
            { key: 'retryOnTruncated', label: 'It cut off mid-sentence', type: 'bool', hint: "Retry when a reply clearly stops partway, like an open quote, an unfinished *action*, or a trailing comma. It's intentionally careful so it doesn't throw away good writing." },
            { key: 'retryOnNoPunct', label: "Also: it ends with no punctuation", type: 'bool', hint: "A stricter version of the line above. It can wrongly redo a reply that simply ends on a word, so most people leave this off." },
            { key: 'retryOnShort', label: 'It was very short', type: 'bool', hint: 'Retry replies shorter than the length below. Off by default, since short replies are often fine.' },
            { key: 'minChars', label: 'What counts as "very short"', type: 'num', int: true, min: 0, max: 100000, hint: 'Replies with fewer characters than this count as too short. Only used when the option above is on.' },
        ] },
    { title: 'Advanced: buttons it clicks',
        desc: "It works by clicking your own on-screen buttons. The three boxes below are three different buttons it needs for three different jobs: redoing a reply, swiping to a fresh one as a backup, and stopping a frozen reply. Each box takes one CSS selector, the kind you'd use in your browser's inspector, and you can list a few separated by commas as fallbacks since it uses the first that matches. You only need this if retries aren't happening. Paste a selector and press Test until it says match found. A no match doesn't always mean the selector is wrong; the button may just not be on screen yet, so test each one while its button is actually visible. The Stop button, for one, only appears while a reply is generating.",
        fields: [
            { key: 'regenerateSelector', label: 'Your regenerate button', type: 'text', selector: true, hint: 'The retry button it clicks to redo a reply.' },
            { key: 'swipeNextSelector', label: 'Your next / swipe button', type: 'text', selector: true, hint: 'A backup it clicks if your setup retries by swiping to a new reply instead.' },
            { key: 'stopSelector', label: 'Your stop button', type: 'text', selector: true, hint: 'The stop button, so it can halt a frozen reply before retrying.' },
        ] },
    { title: 'Advanced: feedback',
        desc: 'Small extras for how it talks to you.',
        fields: [
            { key: 'toast', label: 'Show a pop-up on each retry', type: 'bool', hint: 'A small message telling you it is retrying, with a Cancel button to stop it.' },
            { key: 'log', label: 'Write technical details to the console', type: 'bool', hint: "For bug reports. Turn it on, make the problem happen again, then copy whatever shows up in the browser console (press F12). Leave it off the rest of the time." },
        ] },
];
// Final content present but cut off mid-sentence. Lumiverse does not expose
// finish_reason on GENERATION_ENDED (confirmed against the Generation API), so
// this works off the only signal a frontend extension has: the shape of the
// text. Conservative on purpose to avoid re-rolling good roleplay replies.
function looksTruncated(text, retryOnNoPunct) {
    const t = String(text == null ? '' : text).replace(/\s+$/, '');
    if (!t)
        return false; // empty is handled by the empty branch
    if ((t.match(/```/g) || []).length % 2 === 1)
        return true; // open code fence
    if ((t.replace(/```/g, '').match(/`/g) || []).length % 2 === 1)
        return true; // open inline code
    // Emphasis asterisks only. Strip markdown bullet markers ("* " at line start)
    // first, or a reply with an odd number of list bullets would read as an open
    // emphasis run and get re-rolled. Emphasis pairs (*x*, **x**) are unaffected.
    const emphasis = t.replace(/^[ \t]*\*[ \t]+/gm, '');
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
export function setup(ctx, opts) {
    // cfg is mutable so the settings modal can change it live. Order: code
    // defaults, then GitHub opts, then whatever the user saved in the UI.
    const cfg = Object.assign({}, CONFIG, opts || {}, loadSaved());
    // A short in-memory ring buffer of what the extension did, captured whether or
    // not console logging is on, so the Copy debug info report carries a timeline
    // and the user never has to open dev tools to report a behavioural bug.
    const EVENTLOG_MAX = 20;
    const eventLog = [];
    function recordEvent(args) {
        try {
            const parts = args.map((a) => {
                if (typeof a === 'string')
                    return a;
                try {
                    return JSON.stringify(a);
                }
                catch (_) {
                    return String(a);
                }
            });
            let line = new Date().toISOString().slice(11, 23) + ' ' + parts.join(' ');
            if (line.length > 220)
                line = line.slice(0, 217) + '...';
            eventLog.push(line);
            if (eventLog.length > EVENTLOG_MAX)
                eventLog.shift();
        }
        catch (_) { }
    }
    const log = (...a) => { recordEvent(a); if (cfg.log)
        console.log('[auto-retry]', ...a); };
    const disposers = [];
    function loadSaved() {
        try {
            if (typeof localStorage === 'undefined')
                return {};
            const raw = localStorage.getItem(STORE_KEY);
            if (!raw)
                return {};
            const parsed = JSON.parse(raw);
            const out = {};
            for (const g of SCHEMA)
                for (const f of g.fields) {
                    if (!(f.key in parsed))
                        continue;
                    out[f.key] = f.type === 'num' ? clampField(f, parsed[f.key]) : coerce(f.type, parsed[f.key], CONFIG[f.key]);
                }
            return out;
        }
        catch (_) {
            return {};
        }
    }
    function saveSaved() {
        try {
            if (typeof localStorage === 'undefined')
                return;
            const out = {};
            for (const g of SCHEMA)
                for (const f of g.fields)
                    out[f.key] = cfg[f.key];
            localStorage.setItem(STORE_KEY, JSON.stringify(out));
        }
        catch (_) { }
    }
    function coerce(type, val, fallback) {
        if (type === 'bool')
            return !!val;
        if (type === 'num') {
            const n = Number(val);
            return Number.isFinite(n) ? n : fallback;
        }
        return val == null ? fallback : String(val);
    }
    // Turn whatever is in a number box into a safe value: a blank or non-numeric
    // box falls back to that field's default, then the result is clamped to the
    // field's range and rounded if it's a whole-number field. Stops an empty or
    // silly box from poisoning the retry maths.
    function clampField(f, raw) {
        const s = (raw == null ? '' : String(raw)).trim();
        let n = s === '' ? CONFIG[f.key] : Number(s);
        if (!Number.isFinite(n))
            n = CONFIG[f.key];
        if (typeof f.min === 'number')
            n = Math.max(f.min, n);
        if (typeof f.max === 'number')
            n = Math.min(f.max, n);
        if (f.int)
            n = Math.round(n);
        return n;
    }
    // ---- per-chat state ----
    const chats = new Map();
    const st = (chatId) => {
        let s = chats.get(chatId);
        if (!s) {
            s = {
                attempts: 0, pending: false, selfTriggered: false,
                genId: null, startTimer: null, idleTimer: null, timer: null,
                sawReasoning: false, sawContent: false, ignored: new Set(),
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
    const isRateLimit = (err) => !!err && /\b429\b|rate.?limit|too many requests|quota|overloaded/i.test(String(err));
    const computeDelay = (attempt, rateLimited) => {
        let d = cfg.retryDelayMs * Math.pow(cfg.backoffFactor, Math.max(0, attempt - 1));
        d = Math.min(d, cfg.maxDelayMs);
        if (rateLimited)
            d = Math.max(d, cfg.rateLimitDelayMs * attempt);
        if (cfg.jitter)
            d = Math.round(d * (0.85 + Math.random() * 0.3));
        return d;
    };
    const find = (selector) => {
        let el = null;
        try {
            el = ctx && ctx.dom && ctx.dom.query ? ctx.dom.query(selector) : null;
        }
        catch (_) { }
        if (!el && typeof document !== 'undefined') {
            try {
                el = document.querySelector(selector);
            }
            catch (_) { }
        }
        return el;
    };
    const fireRetry = () => {
        let btn = null;
        try {
            btn = find(cfg.regenerateSelector) || find(cfg.swipeNextSelector);
        }
        catch (_) { }
        if (btn) {
            try {
                hideToast();
                btn.click();
                return true;
            }
            catch (e) {
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
        }
        catch (e) {
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
            if (announce)
                showToast('Auto-retry stopped.');
            log('stood down', chatId);
        }
    }
    function scheduleRetry(chatId, reason, err) {
        const s = st(chatId);
        if (!cfg.enabled || s.pending)
            return;
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
        log('retry ' + s.attempts + '/' + cfg.maxRetries + ' in ' + delay + 'ms (' + reason + (rl ? ', rate-limited' : '') + ')');
        showToast('Retrying ' + s.attempts + '/' + cfg.maxRetries + ' (' + reason + ') in ' + (delay / 1000).toFixed(1) + 's', { cancel: () => standDown(chatId, true), sticky: true });
        s.timer = setTimeout(() => {
            s.timer = null;
            s.pending = false;
            s.selfTriggered = true;
            if (!fireRetry()) {
                s.selfTriggered = false;
                s.attempts = 0;
            } // click failed, do not leave stale state
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
        log('gen start', p.generationId, s.selfTriggered ? '(auto-retry)' : '(user)');
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
        if (!p || !p.chatId)
            return;
        const s = st(p.chatId);
        if (p.type === 'reasoning')
            s.sawReasoning = true;
        else
            s.sawContent = true;
        // streaming is alive: drop the start watchdog, arm the idle watchdog
        if (s.startTimer) {
            clearTimeout(s.startTimer);
            s.startTimer = null;
        }
        if (cfg.enabled && cfg.idleTimeoutMs > 0) {
            if (s.idleTimer)
                clearTimeout(s.idleTimer);
            s.idleTimer = setTimeout(() => abortAndRetry(p.chatId, 'stalled'), cfg.idleTimeoutMs);
        }
    }
    function onEnd(p) {
        if (!p || !p.chatId)
            return;
        const s = st(p.chatId);
        if (s.ignored.has(p.generationId))
            return; // aborted gen's trailing event, retry already scheduled
        clearTimers(s);
        if (Date.now() < s.suppressUntil) {
            log('gen end ignored (just stopped)');
            s.attempts = 0;
            return;
        } // user just stopped; do not retry
        if (p.error) {
            if (cfg.retryOnError)
                scheduleRetry(p.chatId, 'error', p.error);
            return;
        }
        const content = String(p.content || '').trim();
        if (cfg.retryOnEmpty && content.length === 0) {
            scheduleRetry(p.chatId, (s.sawReasoning && !s.sawContent) ? 'cut off mid-reasoning' : 'empty');
            return;
        }
        if (cfg.retryOnTruncated && looksTruncated(content, cfg.retryOnNoPunct)) {
            scheduleRetry(p.chatId, 'cut off');
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
        if (!p || !p.chatId)
            return;
        const s = st(p.chatId);
        if (s.ignored.has(p.generationId))
            return; // our own abort, not a user stop
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
            if (!tgt)
                return;
            chats.forEach((s, id) => { if (s.pending || s.timer || s.attempts > 0)
                standDown(id, true); });
        }
        catch (_) { }
    }
    // ---- toast with an optional Cancel button ----
    function ensureToast() {
        if (typeof document === 'undefined')
            return null;
        let t = document.getElementById('__lvRetryToast');
        if (!t) {
            t = document.createElement('div');
            t.id = '__lvRetryToast';
            t.style.cssText =
                'position:fixed;bottom:max(20px,env(safe-area-inset-bottom,0px));left:50%;transform:translateX(-50%);' +
                    'z-index:2147483647;display:flex;align-items:center;gap:10px;' +
                    'font:13px/1.4 var(--lumiverse-font-family,system-ui);padding:9px 12px;border-radius:12px;' +
                    'color:var(--lumiverse-text,#fff);background:var(--lumiverse-fill,rgba(20,16,30,.96));' +
                    'border:1px solid var(--lumiverse-border,rgba(255,255,255,.18));' +
                    'box-shadow:0 8px 24px rgba(0,0,0,.45);transition:opacity .2s ease;' +
                    'opacity:0;max-width:min(92vw,460px);text-align:left';
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
        if (!cfg.toast)
            return;
        const t = ensureToast();
        if (!t)
            return;
        try {
            t.innerHTML = '';
            const span = document.createElement('span');
            span.textContent = msg;
            span.style.cssText = 'flex:1';
            t.appendChild(span);
            if (opts && opts.cancel) {
                const c = document.createElement('button');
                c.textContent = 'Cancel';
                c.style.cssText =
                    'flex:none;min-height:36px;padding:6px 14px;border-radius:8px;cursor:pointer;' +
                        'font:13px var(--lumiverse-font-family,system-ui);' +
                        'border:1px solid var(--lumiverse-border,rgba(255,255,255,.28));' +
                        'background:var(--lumiverse-fill-subtle,rgba(255,255,255,.08));color:var(--lumiverse-text,#fff)';
                c.addEventListener('click', () => { try {
                    opts.cancel && opts.cancel();
                }
                catch (_) { } });
                const cClear = () => { c.style.filter = 'none'; };
                c.addEventListener('pointerdown', () => { c.style.filter = 'brightness(1.2)'; });
                c.addEventListener('pointerup', cClear);
                c.addEventListener('pointercancel', cClear);
                c.addEventListener('pointerleave', cClear);
                t.appendChild(c);
                t.style.pointerEvents = 'auto';
            }
            else {
                t.style.pointerEvents = 'none';
            }
            t.style.opacity = '1';
            clearTimeout(t.__h);
            if (!(opts && opts.sticky)) {
                t.__h = setTimeout(() => { t.style.opacity = '0'; t.style.pointerEvents = 'none'; }, 3200);
            }
        }
        catch (_) { }
    }
    // ---- debug info for bug reports ----
    // A one-tap snapshot anyone can paste into a report without opening dev tools:
    // version, current settings, whether each button selector matches right now,
    // and the browser string. The console log (above) is the live timeline; this
    // is the still photo.
    function selectorState(sel) {
        try {
            return document.querySelector(sel) ? 'match' : 'no match';
        }
        catch (_) {
            return 'invalid selector';
        }
    }
    function buildDebugInfo() {
        const keys = ['enabled', 'maxRetries', 'retryDelayMs', 'backoffFactor', 'maxDelayMs',
            'jitter', 'rateLimitDelayMs', 'stuckTimeoutMs', 'idleTimeoutMs', 'retryOnError',
            'retryOnEmpty', 'retryOnTruncated', 'retryOnNoPunct', 'retryOnShort', 'minChars', 'toast', 'log'];
        const lines = [];
        lines.push('Auto Retry v' + VERSION + ' debug info');
        lines.push('time: ' + new Date().toISOString());
        lines.push('');
        lines.push('settings:');
        for (const k of keys)
            lines.push('  ' + k + ': ' + JSON.stringify(cfg[k]));
        lines.push('');
        lines.push('buttons (checked right now):');
        lines.push('  regenerate: ' + selectorState(cfg.regenerateSelector));
        lines.push('  swipeNext:  ' + selectorState(cfg.swipeNextSelector));
        lines.push('  stop:       ' + selectorState(cfg.stopSelector));
        lines.push('  regenerateSelector = ' + cfg.regenerateSelector);
        lines.push('  swipeNextSelector  = ' + cfg.swipeNextSelector);
        lines.push('  stopSelector       = ' + cfg.stopSelector);
        try {
            lines.push('');
            lines.push('browser: ' + ((navigator && navigator.userAgent) || 'unknown'));
        }
        catch (_) { }
        try {
            lines.push('screen: ' + ((window && window.innerWidth) || '?') + ' x ' + ((window && window.innerHeight) || '?'));
        }
        catch (_) { }
        lines.push('');
        lines.push('recent activity (oldest first):');
        if (eventLog.length === 0)
            lines.push('  (nothing recorded yet)');
        else
            for (const e of eventLog)
                lines.push('  ' + e);
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
        }
        catch (_) {
            return false;
        }
    }
    function copyText(text) {
        try {
            if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
                return navigator.clipboard.writeText(text).then(() => true, () => fallbackCopy(text));
            }
        }
        catch (_) { }
        return Promise.resolve(fallbackCopy(text));
    }
    // ---- settings UI ----
    let modalHandle = null;
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
            const h = document.createElement('div');
            h.textContent = group.title;
            h.style.cssText = 'font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:var(--lumiverse-text-muted,#9a93a8)';
            sec.appendChild(h);
            if (group.desc) {
                const d = document.createElement('div');
                d.textContent = group.desc;
                d.style.cssText = 'font-size:12px;line-height:1.45;color:var(--lumiverse-text-muted,#9a93a8);margin-top:-4px';
                sec.appendChild(d);
            }
            for (const f of group.fields)
                sec.appendChild(buildRow(f));
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
                        title: 'Reset settings', message: 'Put every Auto Retry setting back to its default?',
                        variant: 'warning', confirmLabel: 'Reset',
                    });
                    ok = !!r?.confirmed;
                }
            }
            catch (_) { }
            if (!ok)
                return;
            for (const g of SCHEMA)
                for (const fl of g.fields)
                    cfg[fl.key] = CONFIG[fl.key];
            saveSaved();
            if (onSaved) onSaved();
            buildSettingsBody(root, onSaved);
            log('settings reset to defaults');
        });
        const dbg = btn('Copy debug info', false);
        dbg.addEventListener('click', async () => {
            const ok = await copyText(buildDebugInfo());
            status.textContent = ok
                ? 'Copied. Paste it into your bug report.'
                : "Couldn't copy here. Turn on console logging instead.";
            setTimeout(() => { status.textContent = ''; }, 4000);
        });
        const save = btn('Save', true);
        save.addEventListener('click', () => {
            // Commit a field the user is still editing, then normalise every number
            // so a blank or out-of-range box can't be saved.
            const active = (typeof document !== 'undefined') ? document.activeElement : null;
            if (active && typeof active.blur === 'function')
                active.blur();
            for (const g of SCHEMA)
                for (const fl of g.fields)
                    if (fl.type === 'num')
                        cfg[fl.key] = clampField(fl, cfg[fl.key]);
            saveSaved();
            if (onSaved) onSaved();
            status.textContent = 'Saved. Takes effect on the next reply.';
            log('settings saved', cfg);
            setTimeout(() => { status.textContent = ''; }, 2600);
        });
        actions.appendChild(status);
        actions.appendChild(dbg);
        actions.appendChild(reset);
        actions.appendChild(save);
        panel.appendChild(actions);
        root.appendChild(panel);
    }
    function buildRow(f) {
        // bool/num wrap in <label> so the whole row toggles or focuses its control.
        // text rows use <div> because they contain a Test button, which shouldn't sit inside a label.
        const row = document.createElement(f.type === 'text' ? 'div' : 'label');
        row.style.cssText = 'display:flex;flex-direction:column;gap:5px;cursor:' + (f.type === 'text' ? 'default' : 'pointer');
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
            input.addEventListener('change', () => { cfg[f.key] = input.checked; });
            top.appendChild(input);
            row.appendChild(top);
        }
        else if (f.type === 'num') {
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
        }
        else {
            row.appendChild(top);
            const input = document.createElement('input');
            input.type = 'text';
            input.value = String(cfg[f.key]);
            input.setAttribute('aria-label', f.label);
            styleField(input);
            input.addEventListener('change', () => { cfg[f.key] = input.value; });
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
                    }
                    catch (_) {
                        res.textContent = "that selector isn't valid";
                        res.style.color = 'var(--lumiverse-danger,#ff6b6b)';
                        return;
                    }
                    res.textContent = match ? 'match found' : 'no match right now';
                    res.style.color = match ? 'var(--lumiverse-success,#46d39a)' : 'var(--lumiverse-text-muted,#9a93a8)';
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
        input.style.cssText +=
            'padding:9px 10px;border-radius:var(--lumiverse-radius,8px);' +
                'border:1px solid var(--lumiverse-border,rgba(255,255,255,.16));' +
                'background:var(--lumiverse-fill-subtle,rgba(255,255,255,.05));' +
                'color:var(--lumiverse-text,#eee);font:13px var(--lumiverse-font-family,system-ui);outline:none;' +
                'transition:border-color .12s ease';
        input.addEventListener('focus', () => { input.style.borderColor = 'var(--lumiverse-primary,#7c5cff)'; });
        input.addEventListener('blur', () => { input.style.borderColor = 'var(--lumiverse-border,rgba(255,255,255,.16))'; });
    }
    function btn(label, primary) {
        const b = document.createElement('button');
        b.textContent = label;
        b.style.cssText =
            'min-height:36px;padding:8px 14px;border-radius:var(--lumiverse-radius,8px);cursor:pointer;' +
                'font:13px var(--lumiverse-font-family,system-ui);transition:filter .12s ease;' +
                (primary
                    ? 'border:1px solid transparent;background:var(--lumiverse-primary,#7c5cff);color:var(--lumiverse-primary-contrast,#fff)'
                    : 'border:1px solid var(--lumiverse-border,rgba(255,255,255,.16));background:transparent;color:var(--lumiverse-text,#eee)');
        b.addEventListener('mouseenter', () => { b.style.filter = 'brightness(1.12)'; });
        b.addEventListener('mouseleave', () => { b.style.filter = 'none'; });
        // Press feedback that also works on touch, where hover never fires.
        const pressClear = () => { b.style.filter = 'none'; };
        b.addEventListener('pointerdown', () => { b.style.filter = 'brightness(.9)'; });
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
                }
                catch (_) { }
                modalHandle = null;
            }
            // Size to the screen so it fits on a phone as well as a desktop.
            const vw = (typeof window !== 'undefined' && window.innerWidth) ? window.innerWidth : 480;
            const vh = (typeof window !== 'undefined' && window.innerHeight) ? window.innerHeight : 720;
            const modal = ctx.ui.showModal({
                title: 'Auto Retry settings',
                width: Math.min(460, vw - 24),
                maxHeight: Math.min(560, vh - 24),
            });
            modalHandle = modal;
            let baseline = {};
            const snapshot = () => {
                baseline = {};
                for (const g of SCHEMA)
                    for (const fl of g.fields)
                        baseline[fl.key] = cfg[fl.key];
            };
            snapshot();
            buildSettingsBody(modal.root, snapshot);
            modal.onDismiss(() => {
                for (const g of SCHEMA)
                    for (const fl of g.fields)
                        cfg[fl.key] = baseline[fl.key];
                modalHandle = null;
            });
        }
        catch (e) {
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
            disposers.push(() => { try {
                action.destroy();
            }
            catch (_) { } });
        }
        else {
            log('host has no input bar action API; open settings via ctx only');
        }
    }
    catch (e) {
        log('failed to register settings action', e);
    }
    // backup stop-press catcher (see onDocClick)
    if (typeof document !== 'undefined') {
        document.addEventListener('click', onDocClick, true);
        disposers.push(() => { try {
            document.removeEventListener('click', onDocClick, true);
        }
        catch (_) { } });
    }
    // Wrap each listener so a throw inside a handler is logged, never escapes into
    // the host's event dispatcher, and never stops later events from arriving.
    const safe = (label, fn) => (p) => {
        try {
            fn(p);
        }
        catch (e) {
            log('handler error in ' + label, e);
        }
    };
    let offs = [];
    try {
        offs = [
            ctx.events.on('GENERATION_STARTED', safe('GENERATION_STARTED', onStart)),
            ctx.events.on('STREAM_TOKEN_RECEIVED', safe('STREAM_TOKEN_RECEIVED', onToken)),
            ctx.events.on('GENERATION_ENDED', safe('GENERATION_ENDED', onEnd)),
            ctx.events.on('GENERATION_STOPPED', safe('GENERATION_STOPPED', onStop)),
        ];
    }
    catch (e) {
        log('failed to subscribe to generation events', e);
    }
    log('ready v' + VERSION, cfg);
    return () => {
        offs.forEach((o) => { try {
            o && o();
        }
        catch (_) { } });
        disposers.forEach((d) => { try {
            d && d();
        }
        catch (_) { } });
        if (modalHandle) {
            try {
                modalHandle.dismiss();
            }
            catch (_) { }
            modalHandle = null;
        }
        chats.forEach(clearTimers);
        chats.clear();
        eventLog.length = 0;
        try {
            if (typeof document !== 'undefined' && document.getElementById) {
                const t = document.getElementById('__lvRetryToast');
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
