// Service worker: list management, runtime list updates, whitelist, cosmetic
// lookup and import/export.
//
// uBO's static filtering engine is bundled in here (see tools/bundle.mjs), so
// "Update all lists" can do what the uBO button does -- refetch each list and
// recompile it -- rather than merely re-downloading text it cannot act on.
// Only dynamic rules are writable after install, so runtime updates apply to
// dynamic lists; static rulesets are toggled, not rewritten.
import { dnrRulesetFromRawLists } from '@gorhill/ubo-core/js/static-dnr-filtering.js';
import { ENV } from './lib/env-runtime.js';
import { EXTENSION_PATHS } from './lib/redirect-paths.js';
import { withUbolNetworkFilters } from './lib/ubol-compat.js';
import {
    popupEngineLines, loadPopupFilters, loadPublicSuffixList, matchPopup,
} from './lib/popup-filters.js';
import { SHARD_COUNT, shardOf, hostnameLadder } from './lib/shard.js';
import {
    loadConfig, saveConfig, validateBackup, toBackup, backupFilename,
} from './lib/storage.js';
import {
    BAND, BUDGET, LIMITS, replaceBand, getDynamicRules, auditBudget, whitelistToRules,
    dropUnsupportedRegex, sanitizeRule, inBand,
} from './lib/dynamic-rules.js';
import { ruleHash } from './lib/rulehash.js';
import { planStaticDeltas } from './lib/delta-plan.js';
import {
    applyUserFilters, userScriptsAvailable, USER_COSMETIC_KEY, USER_STATUS_KEY,
} from './lib/user-filters.js';

const STATE_KEY = 'listState';

/* ------------------------------------------------------------------------- */
/* Filter list registry                                                       */

async function loadCatalog() {
    return fetch(chrome.runtime.getURL('data/list-catalog.json')).then(r => r.json());
}

async function loadDynamicSeed() {
    return fetch(chrome.runtime.getURL('rulesets/dynamic-seed.json')).then(r => r.json());
}

// Per-list runtime state: enabled/disabled, last update time, last error.
async function loadListState() {
    const got = await chrome.storage.local.get(STATE_KEY);
    return got[STATE_KEY] ?? {};
}

async function saveListState(state) {
    await chrome.storage.local.set({ [STATE_KEY]: state });
}

/* ------------------------------------------------------------------------- */
/* Compiling filter text to DNR rules at runtime                              */

function isRule(r) { return r._error === undefined && r.action !== undefined; }

async function compileToDNR(lists) {
    // Same options and ext_ubol rewrites as the build (tools/lib/env.mjs), or
    // recompiled lists would drop rules and diverge from the build-time baselines.
    const res = await dnrRulesetFromRawLists(withUbolNetworkFilters(lists, ENV),
        { env: ENV, extensionPaths: EXTENSION_PATHS });
    const emitted = res.network.ruleset || [];
    return {
        rules: emitted.filter(isRule),
        rejected: emitted.length - emitted.filter(isRule).length,
    };
}

const FETCH_TIMEOUT_MS = 45000;

async function fetchList(urls) {
    const errors = [];
    for ( const url of urls ) {
        if ( /^https?:\/\//.test(url) === false ) { continue; }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(url, { cache: 'reload', signal: controller.signal });
            if ( res.ok === false ) { throw new Error(`HTTP ${res.status}`); }
            const text = await res.text();
            if ( text.length < 32 ) { throw new Error(`short response (${text.length} bytes)`); }
            return { text, url };
        } catch ( reason ) {
            errors.push(`${url}: ${reason.message}`);
        } finally {
            clearTimeout(timer);
        }
    }
    throw new Error(`all sources failed -> ${errors.join(' | ')}`);
}

/* ------------------------------------------------------------------------- */
/* Installing dynamic lists                                                   */

// Cached raw text of dynamic lists, so a rebuild after toggling one list does
// not refetch the others.
const LIST_TEXT_KEY = 'listText';

async function getCachedText() {
    const got = await chrome.storage.local.get(LIST_TEXT_KEY);
    return got[LIST_TEXT_KEY] ?? {};
}

async function setCachedText(cache) {
    await chrome.storage.local.set({ [LIST_TEXT_KEY]: cache });
}

// Rebuild the LISTS band from whichever dynamic lists are currently enabled.
// One compile over all enabled lists (not one per list) so cross-list exception
// filters resolve, matching how uBO evaluates them.
async function rebuildDynamicLists() {
    const [ seed, state, cache, config ] = await Promise.all([
        loadDynamicSeed(), loadListState(), getCachedText(), loadConfig(),
    ]);

    const lists = [];
    const usedPrebuilt = [];
    for ( const entry of seed ) {
        if ( state[entry.token]?.enabled === false ) { continue; }
        const text = cache[entry.token];
        if ( typeof text === 'string' ) {
            lists.push({ name: entry.token, text });
        } else {
            // Never refetched since install: use the rules compiled at build time.
            usedPrebuilt.push(entry);
        }
    }

    // My filters (network part). Not a seed list -- the saved text is the only
    // source -- so it is compiled on every rebuild (save, install, startup), in
    // the same pass as the lists. The build reserves its share of the dynamic
    // budget (tools/emit-extension.mjs) but ships none of these rules; before
    // this they were never installed anywhere.
    const userText = String(config.userFilters ?? '');
    if ( userText.trim() !== '' ) {
        lists.push({ name: 'user-filters', text: userText });
    }

    let rules = [];
    if ( lists.length !== 0 ) {
        const compiled = await compileToDNR(lists);
        rules = compiled.rules;
    }
    for ( const entry of usedPrebuilt ) {
        rules = rules.concat(entry.rules);
    }

    const result = await replaceBand(BAND.LISTS, rules);
    return { ...result, compiled: lists.length, prebuilt: usedPrebuilt.length };
}

/* ------------------------------------------------------------------------- */
/* Update-all: the uBO "Update all cached filter lists" behaviour             */

// uBO's custom Update-all marks every enabled+cached list obsolete and refetches
// it regardless of cache age. Reproduced here: force refetch, recompile,
// reinstall. Static-ruleset lists cannot be rewritten at runtime, so they are
// reported as skipped rather than pretended-updated.
let updateInFlight = null;

async function updateAllLists({ tokens = null } = {}) {
    if ( updateInFlight !== null ) { return updateInFlight; }
    updateInFlight = (async () => {
        const [ seed, state, catalog ] = await Promise.all([
            loadDynamicSeed(), loadListState(), loadCatalog(),
        ]);
        const cache = await getCachedText();

        const targets = seed.filter(e => {
            if ( state[e.token]?.enabled === false ) { return false; }
            if ( tokens !== null && tokens.includes(e.token) === false ) { return false; }
            return true;
        });

        const updated = [];
        const failed = [];
        const CONCURRENCY = 6;
        let cursor = 0;
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, async () => {
            for (;;) {
                const i = cursor++;
                if ( i >= targets.length ) { return; }
                const entry = targets[i];
                try {
                    const { text, url } = await fetchList(entry.urls);
                    cache[entry.token] = text;
                    state[entry.token] = {
                        ...(state[entry.token] ?? {}),
                        enabled: state[entry.token]?.enabled !== false,
                        lastUpdated: Date.now(),
                        lastError: null,
                        source: url,
                        bytes: text.length,
                    };
                    updated.push(entry.token);
                } catch ( reason ) {
                    state[entry.token] = {
                        ...(state[entry.token] ?? {}),
                        lastError: reason.message,
                        lastAttempt: Date.now(),
                    };
                    failed.push({ token: entry.token, error: reason.message });
                }
            }
        }));

        await setCachedText(cache);
        await saveListState(state);
        try {
            await savePopupLinesFrom(Object.fromEntries(updated.map(t => [ t, cache[t] ])));
        } catch ( reason ) {
            failed.push({ token: '(popup filters)', error: reason.message });
        }

        let install = null;
        let installError = null;
        try {
            install = await rebuildDynamicLists();
        } catch ( reason ) {
            installError = reason.message;
        }

        // Static lists are no longer skipped: their diffs are applied against the
        // shipped baseline. See applyStaticDeltas().
        const staticEntries = catalog
            .filter(c => c.kind === 'static')
            .filter(c => state[c.token]?.enabled !== false)
            .filter(c => tokens === null || tokens.includes(c.token))
            .map(c => ({ token: c.token, id: c.id, urls: c.urls ?? [] }))
            .filter(c => Array.isArray(c.urls) && c.urls.length !== 0);

        const staticReport = { failed: [] };
        let deltas = null;
        try {
            deltas = await applyStaticDeltas(staticEntries, staticReport);
        } catch ( reason ) {
            staticReport.failed.push({ token: '(static deltas)', error: reason.message });
        }
        for ( const f of staticReport.failed ) { failed.push(f); }

        return {
            updated, failed, install, installError,
            staticLists: staticEntries.length,
            deltas,
        };
    })().finally(() => { updateInFlight = null; });
    return updateInFlight;
}

/* ------------------------------------------------------------------------- */
/* Enabling / disabling lists                                                 */

async function setListEnabled(token, enabled) {
    const catalog = await loadCatalog();
    const entry = catalog.find(c => c.token === token);
    if ( entry === undefined ) { throw new Error(`unknown list: ${token}`); }

    const state = await loadListState();
    state[token] = { ...(state[token] ?? {}), enabled };
    await saveListState(state);
    invalidatePopupEngine();

    if ( entry.kind === 'static' ) {
        // Static lists are whole rulesets; toggling one is an enable/disable.
        await chrome.declarativeNetRequest.updateEnabledRulesets(
            enabled ? { enableRulesetIds: [ entry.id ] }
                    : { disableRulesetIds: [ entry.id ] }
        );
        // Its regex rules and update additions are dynamic (see BAND.REGEX and
        // BAND.DELTA) and follow the toggle.
        const regex = await rebuildStaticRegex();
        const deltas = await reconcileStaticDeltas();
        return { kind: 'static', id: entry.id, enabled, regex, deltas };
    }
    const install = await rebuildDynamicLists();
    return { kind: 'dynamic', token, enabled, install };
}

// Add a custom list by URL: fetch, compile, persist, install.
async function addCustomList(url) {
    if ( /^https?:\/\//.test(url) === false ) {
        throw new Error('list URL must start with http:// or https://');
    }
    const { text } = await fetchList([ url ]);

    const cache = await getCachedText();
    cache[url] = text;
    await setCachedText(cache);

    const state = await loadListState();
    state[url] = { enabled: true, lastUpdated: Date.now(), lastError: null, bytes: text.length };
    await saveListState(state);

    // Custom lists are recorded in the config so they survive export/import.
    const config = await loadConfig();
    if ( config.selectedFilterLists.includes(url) === false ) {
        config.selectedFilterLists.push(url);
        await saveConfig(config);
    }

    // Seed entry so rebuild picks it up.
    await addSeedEntry({ token: url, kind: 'url', title: url, urls: [ url ], rules: [] });
    await savePopupLinesFrom({ [url]: text });
    const install = await rebuildDynamicLists();
    return { url, bytes: text.length, install };
}

// The shipped dynamic-seed.json is read-only; user-added lists live alongside it.
const EXTRA_SEED_KEY = 'extraSeed';

async function addSeedEntry(entry) {
    const got = await chrome.storage.local.get(EXTRA_SEED_KEY);
    const extra = got[EXTRA_SEED_KEY] ?? [];
    if ( extra.some(e => e.token === entry.token) === false ) {
        extra.push(entry);
        await chrome.storage.local.set({ [EXTRA_SEED_KEY]: extra });
    }
}

async function removeCustomList(url) {
    const got = await chrome.storage.local.get(EXTRA_SEED_KEY);
    const extra = (got[EXTRA_SEED_KEY] ?? []).filter(e => e.token !== url);
    await chrome.storage.local.set({ [EXTRA_SEED_KEY]: extra });

    const cache = await getCachedText();
    delete cache[url];
    await setCachedText(cache);

    const state = await loadListState();
    delete state[url];
    await saveListState(state);

    const config = await loadConfig();
    config.selectedFilterLists = config.selectedFilterLists.filter(t => t !== url);
    await saveConfig(config);
    await savePopupLinesFrom({ [url]: null });

    const install = await rebuildDynamicLists();
    return { url, install };
}

/* ------------------------------------------------------------------------- */
/* Whitelist                                                                  */

async function applyWhitelist(config) {
    const { rules, unsupported } = whitelistToRules(config.whitelist ?? []);
    const result = await replaceBand(BAND.WHITELIST, rules);
    return { ...result, unsupported };
}

async function setSiteEnabled(hostname, enabled) {
    const config = await loadConfig();
    const set = new Set(config.whitelist ?? []);
    if ( enabled ) {
        // Whitelisting matches parent domains too, so re-enabling a host must
        // remove whichever entry covers it, not just an exact match.
        set.delete(hostname);
        for ( const h of hostnameLadder(hostname) ) { set.delete(h); }
    } else {
        set.add(hostname);
    }
    config.whitelist = Array.from(set).sort();
    await saveConfig(config);
    const applied = await applyWhitelist(config);
    // Network allow rules are not enough: scriptlets and generic CSS are
    // registered content scripts whose excludeMatches carry the whitelist, so
    // they must be re-registered for the toggle to take effect.
    const scripts = await registerScriptletScripts();
    // User scriptlets carry the whitelist as excludeMatches too.
    const user = await reapplyUserFilters().catch(reason => ({ error: reason.message }));
    return { hostname, blocking: enabled, whitelisted: set.has(hostname), applied, scripts: scripts.ok, userFilters: user };
}

/* ------------------------------------------------------------------------- */
/* Cosmetic filtering lookup                                                  */

// Shards are cached in worker memory; a page load touches one shard, and the
// worker keeps it until eviction.
const shardCache = new Map();

async function loadShard(kind, n) {
    const key = `${kind}-${n}`;
    let hit = shardCache.get(key);
    if ( hit !== undefined ) { return hit; }
    const url = chrome.runtime.getURL(
        `data/cosmetic/${kind}-${String(n).padStart(2, '0')}.json`
    );
    hit = await fetch(url).then(r => r.json()).catch(() => ({}));
    shardCache.set(key, hit);
    return hit;
}

let genericExceptedCache = null;
async function loadGenericExcepted() {
    if ( genericExceptedCache === null ) {
        genericExceptedCache = await fetch(chrome.runtime.getURL('data/cosmetic/generic-excepted.json'))
            .then(r => r.json())
            .catch(() => []);
    }
    return genericExceptedCache;
}

async function cosmeticFor(hostname) {
    const [ config, hide ] = await Promise.all([ loadConfig(), loadHideExceptions() ]);
    const ladder = hostnameLadder(hostname);

    // A whitelisted site gets no cosmetic filtering. uBO matches whitelist
    // entries against the hostname AND each parent domain
    // (µb.getNetFilteringSwitch), so "example.com" covers "www.example.com";
    // an exact-match lookup missed every subdomain.
    const whitelist = new Set((config.whitelist ?? []).map(w => String(w).trim().toLowerCase()));
    if ( whitelist.has(hostname) || ladder.some(h => whitelist.has(h)) ) {
        return { selectors: [], styles: [], procedural: [], disabled: true };
    }
    const selectors = [];
    const styles = [];
    const procedural = [];

    // Scriptlets are resolved in the page by the registered lookup scripts;
    // only the specific cosmetic shards are needed here.
    const shards = new Set(ladder.map(shardOf));
    const specific = new Map();
    await Promise.all(Array.from(shards).map(n =>
        loadShard('specific', n).then(o => specific.set(n, o))
    ));

    // uBO exception hosts: plain (covers subdomains), entity "example.*", or
    // regex "/.../". Mirrors the scriptlet bundle's logic.
    const excluded = xs => xs.some(x => {
        if ( typeof x !== 'string' || x === '' ) { return false; }
        if ( x.length > 2 && x.startsWith('/') && x.endsWith('/') ) {
            try { return new RegExp(x.slice(1, -1)).test(hostname); } catch { return false; }
        }
        if ( x.endsWith('.*') ) {
            const base = x.slice(0, -2) + '.';
            return ladder.some(h => h.startsWith(base));
        }
        return ladder.includes(x);
    });

    // $specifichide / $elemhide: no site-specific cosmetic filters here.
    // $generichide / $elemhide: no generic ones (generic-high.css and the
    // generic.js surveyor are excluded at registration; this covers the
    // per-page generic selectors below, and entity/regex forms registration
    // cannot express).
    const noSpecific = excluded(hide.specific ?? []);
    const noGeneric = excluded(hide.generic ?? []);

    // User filters compiled at runtime from "My filters" (src/lib/user-filters.js).
    const user = await loadUserCosmetic();

    // A selector reached via both a host and its parent domain is applied once.
    const seenSel = new Set();
    const seenProc = new Set();
    for ( const host of (noSpecific ? [] : ladder) ) {
        const n = shardOf(host);
        const items = specific.get(n)?.[host] ?? [];
        const userItems = user.byHost?.[host] ?? [];
        for ( const item of (userItems.length === 0 ? items : items.concat(userItems)) ) {
            // { v, x } carries an exception list; skip it where it is excepted.
            let v = item;
            if ( item && typeof item === 'object' && 'v' in item ) {
                if ( Array.isArray(item.x) && excluded(item.x) ) { continue; }
                v = item.v;
            }
            if ( typeof v === 'string' ) {
                if ( seenSel.has(v) === false ) { seenSel.add(v); selectors.push(v); }
            } else if ( v && typeof v.css === 'string' ) {
                // selector:style(decl) expressible as plain CSS
                const k = `${v.css}\n{${v.style}}`;
                if ( seenProc.has(k) === false ) { seenProc.add(k); styles.push(k); }
            } else if ( v && typeof v.selector === 'string' ) {
                // Procedural filter for uBO's engine, keyed like uBO (by raw).
                if ( seenProc.has(v.raw) === false ) { seenProc.add(v.raw); procedural.push(v); }
            }
        }
    }

    // Highly generic selectors that some site excepts (`site#@#sel`). They
    // cannot live in generic-high.css, which applies to every page, so they are
    // applied here, per page. (Lowly generic exceptions are evaluated in the
    // page by generic.js.)
    for ( const { s, x } of (noGeneric ? [] : await loadGenericExcepted()) ) {
        if ( Array.isArray(x) && excluded(x) ) { continue; }
        if ( seenSel.has(s) === false ) { seenSel.add(s); selectors.push(s); }
    }
    // User generic filters (`##.sel` in My filters) apply to every page.
    for ( const s of (noGeneric ? [] : (user.generic ?? [])) ) {
        if ( seenSel.has(s) === false ) { seenSel.add(s); selectors.push(s); }
    }
    return { selectors, styles, procedural, disabled: false };
}

// In-memory copy of the compiled user cosmetic filters; dropped whenever they
// are recompiled so the next page sees the new set.
let userCosmeticCache = null;
async function loadUserCosmetic() {
    if ( userCosmeticCache === null ) {
        userCosmeticCache = await chrome.storage.local.get(USER_COSMETIC_KEY)
            .then(g => g[USER_COSMETIC_KEY] ?? { byHost: {}, generic: [] })
            .catch(() => ({ byHost: {}, generic: [] }));
    }
    return userCosmeticCache;
}

// Recompile "My filters" (cosmetic + scriptlets) and apply them. Serialized:
// save, import and the whitelist toggle can all trigger it.
let userFiltersChain = Promise.resolve();
function reapplyUserFilters() {
    const run = userFiltersChain.then(reapplyUserFiltersNow, reapplyUserFiltersNow);
    userFiltersChain = run.catch(() => {});
    return run;
}
async function reapplyUserFiltersNow() {
    const config = await loadConfig();
    const whitelistPatterns = (config.whitelist ?? [])
        .map(w => String(w).trim().toLowerCase())
        .filter(h => VALID_MATCH_HOST.test(h))
        .map(hostPattern);
    const status = await applyUserFilters(config, whitelistPatterns);
    userCosmeticCache = null;
    // My filters may hold $popup filters too.
    invalidatePopupEngine();
    return status;
}

/* ------------------------------------------------------------------------- */
/* Popup filtering ($popup / $popunder / no-popups)                           */

// DNR cannot express these, so they run here through uBO's own engine (see
// src/lib/popup-filters.js), following uBO 1.75.0's tab.js: a tab opened by a
// page is a candidate for 10 s after its last navigation; its URL is tested in
// the opener's context and the tab is closed on a match. When the opener then
// navigates, the opener is tested as a popunder and closed on a match.
const POPUP_LINES_KEY = 'popupLines';
const DNR_COMPILE_OPTIONS = { env: ENV, extensionPaths: EXTENSION_PATHS };
const popupEngine = { stale: true, loading: null, pslLoaded: false, filters: 0 };

async function loadPopupLineUpdates() {
    const got = await chrome.storage.local.get(POPUP_LINES_KEY);
    const stored = got[POPUP_LINES_KEY];
    // Same rule as static regex: a newer build ships newer lists.
    if ( stored?.version !== chrome.runtime.getManifest().version ) { return {}; }
    return stored.lists ?? {};
}

// Record the popup filters of lists just refetched: { token: text }.
async function savePopupLinesFrom(texts) {
    const lists = await loadPopupLineUpdates();
    for ( const [ token, text ] of Object.entries(texts) ) {
        if ( typeof text === 'string' ) {
            lists[token] = await popupEngineLines(text, ENV, DNR_COMPILE_OPTIONS);
        } else {
            delete lists[token];
        }
    }
    await chrome.storage.local.set({
        [POPUP_LINES_KEY]: { version: chrome.runtime.getManifest().version, lists },
    });
    invalidatePopupEngine();
}

function invalidatePopupEngine() { popupEngine.stale = true; }

// Loaded on the first popup after the worker starts, and after any change.
async function ensurePopupEngine() {
    if ( popupEngine.stale === false ) { return; }
    if ( popupEngine.loading !== null ) { return popupEngine.loading; }
    popupEngine.loading = (async () => {
        // Cleared first: a change during the load marks it stale again.
        popupEngine.stale = false;
        if ( popupEngine.pslLoaded === false ) {
            loadPublicSuffixList(await fetch(chrome.runtime.getURL('data/psl.json')).then(r => r.json()));
            popupEngine.pslLoaded = true;
        }
        const [ shipped, updates, state, config ] = await Promise.all([
            fetch(chrome.runtime.getURL('data/popup-filters.json')).then(r => r.json()),
            loadPopupLineUpdates(), loadListState(), loadConfig(),
        ]);
        const byToken = new Map(shipped.map(e => [ e.token, e.lines ]));
        for ( const [ token, lines ] of Object.entries(updates) ) { byToken.set(token, lines); }
        const lists = [];
        for ( const [ token, lines ] of byToken ) {
            if ( state[token]?.enabled === false ) { continue; }
            lists.push({ name: token, lines });
        }
        const userText = String(config.userFilters ?? '');
        if ( userText.trim() !== '' ) {
            lists.push({ name: 'user-filters', lines: await popupEngineLines(userText, ENV, DNR_COMPILE_OPTIONS) });
        }
        popupEngine.filters = loadPopupFilters(lists);
    })().catch(reason => {
        popupEngine.stale = true;
        throw reason;
    }).finally(() => { popupEngine.loading = null; });
    return popupEngine.loading;
}

// uBO: "maybeGoodPopup" -- the link the user last pressed. A tab opened for
// that URL is the user's own, not a popup.
const maybeGoodPopup = { tabId: 0, url: '' };
const popupCandidates = new Map();  // target tab id -> candidate
const POPUP_CANDIDATE_TTL = 10000;

const hostnameOf = url => { try { return new URL(url).hostname; } catch { return ''; } };

// uBO's areDifferentURLs(): ignore the scheme, which the browser may change.
function areDifferentURLs(a, b) {
    if ( b === '' ) { return true; }
    if ( b.startsWith('about:') ) { return false; }
    let pos = a.indexOf('://');
    if ( pos === -1 ) { return false; }
    a = a.slice(pos);
    pos = b.indexOf('://');
    if ( pos !== -1 ) { b = b.slice(pos); }
    return b !== a;
}

// uBO's net filtering switch: off for whitelisted sites (parent domain covers
// subdomains, as in getStatus()).
function filteringOff(config, url) {
    const hostname = hostnameOf(url);
    if ( hostname === '' ) { return false; }
    const wl = new Set((config.whitelist ?? []).map(w => String(w).trim().toLowerCase()));
    return wl.has(hostname) || hostnameLadder(hostname).some(h => wl.has(h));
}

// uBO's no-popups hostname switch: the most specific entry wins, then "*".
function noPopupsSwitch(config, hostname) {
    const entries = parseHostnameSwitches(config.hostnameSwitchesString).filter(sw => sw.name === 'no-popups');
    if ( entries.length === 0 || hostname === '' ) { return false; }
    for ( const h of [ hostname, ...hostnameLadder(hostname), '*' ] ) {
        const sw = entries.find(e => e.hostname === h);
        if ( sw !== undefined ) { return sw.state; }
    }
    return false;
}

function popupMatchOne(config, rootOpenerURL, localOpenerURL, targetURL, type) {
    if ( filteringOff(config, targetURL) ) { return 0; }
    if ( type === 'popup' && targetURL !== 'about:blank' && noPopupsSwitch(config, hostnameOf(rootOpenerURL)) ) {
        return 1;
    }
    return matchPopup({ rootOpenerURL, localOpenerURL, targetURL, type });
}

async function testPopupCandidate(targetTabId, candidate) {
    const { opener } = candidate;
    const rootOpenerURL = opener.tabURL;
    const targetURL = candidate.targetURL;
    if ( rootOpenerURL === '' || targetURL === '' ) { return false; }
    const config = await loadConfig();
    // Popups are allowed where uBO is turned off in the opener's context.
    if ( filteringOff(config, rootOpenerURL) ) { return false; }
    await ensurePopupEngine();
    const localOpenerURL = opener.frameId !== 0 && opener.frameURL !== 'about:blank'
        ? opener.frameURL
        : undefined;
    let type = 'popup';
    let result = 0;
    if (
        areDifferentURLs(targetURL, opener.trustedURL) &&
        areDifferentURLs(targetURL, maybeGoodPopup.url)
    ) {
        result = popupMatchOne(config, rootOpenerURL, localOpenerURL, targetURL, 'popup');
    }
    if ( result === 0 && opener.popunder ) {
        // uBO's popunderMatch(): the opener's URL in the popup's context.
        result = popupMatchOne(config, targetURL, undefined, rootOpenerURL, 'popunder');
        if ( result === 1 ) { type = 'popunder'; }
    }
    if ( result !== 1 ) { return false; }
    const closeTabId = type === 'popup' ? targetTabId : opener.tabId;
    await chrome.tabs.remove(closeTabId).catch(() => {});
    console.log(`[uBlockMV3] closed ${type}`, type === 'popup' ? targetURL : rootOpenerURL);
    return true;
}

async function popupCandidateTest(tabId) {
    const now = Date.now();
    for ( const [ targetTabId, candidate ] of popupCandidates ) {
        if ( candidate.expires < now ) { popupCandidates.delete(targetTabId); continue; }
        if ( tabId !== targetTabId && tabId !== candidate.opener.tabId ) { continue; }
        // A navigation of the opener makes it a popunder candidate.
        if ( tabId === candidate.opener.tabId ) { candidate.opener.popunder = true; }
        let closed = false;
        try {
            closed = await testPopupCandidate(targetTabId, candidate);
        } catch ( reason ) {
            console.warn('[uBlockMV3] popup test failed', reason);
        }
        if ( closed ) {
            popupCandidates.delete(targetTabId);
        } else {
            candidate.expires = Date.now() + POPUP_CANDIDATE_TTL;
        }
    }
}

chrome.webNavigation.onCreatedNavigationTarget.addListener(async details => {
    const { sourceTabId, sourceFrameId, tabId, url } = details;
    if ( popupCandidates.has(tabId) === false ) {
        let frames;
        try {
            frames = await Promise.all([
                chrome.webNavigation.getFrame({ tabId: sourceTabId, frameId: 0 }),
                chrome.webNavigation.getFrame({ tabId: sourceTabId, frameId: sourceFrameId }),
            ]);
        } catch {
            return;
        }
        if ( frames[1] === null || frames[1] === undefined ) { return; }
        // uBO: a tab opened from about:newtab or a chrome: page is no popup.
        if ( frames[1].url === 'about:newtab' || frames[1].url.startsWith('chrome:') ) { return; }
        popupCandidates.set(tabId, {
            targetURL: url ?? '',
            expires: Date.now() + POPUP_CANDIDATE_TTL,
            opener: {
                tabId: sourceTabId,
                tabURL: frames[0]?.url ?? frames[1].url,
                frameId: sourceFrameId,
                frameURL: frames[1].url,
                popunder: false,
                trustedURL: sourceTabId === maybeGoodPopup.tabId ? maybeGoodPopup.url : '',
            },
        });
    }
    popupCandidateTest(tabId);
});

// The popup's URL as soon as it navigates; the opener's once it commits.
chrome.webNavigation.onBeforeNavigate.addListener(details => {
    if ( details.frameId !== 0 ) { return; }
    const candidate = popupCandidates.get(details.tabId);
    if ( candidate === undefined ) { return; }
    candidate.targetURL = details.url;
    popupCandidateTest(details.tabId);
});

chrome.webNavigation.onCommitted.addListener(details => {
    if ( details.frameId !== 0 ) { return; }
    const target = popupCandidates.get(details.tabId);
    if ( target !== undefined ) { target.targetURL = details.url; }
    for ( const candidate of popupCandidates.values() ) {
        if ( candidate.opener.tabId === details.tabId ) { candidate.opener.tabURL = details.url; }
    }
    popupCandidateTest(details.tabId);
});

chrome.tabs.onRemoved.addListener(tabId => {
    for ( const [ targetTabId, candidate ] of popupCandidates ) {
        if ( targetTabId === tabId || candidate.opener.tabId === tabId ) { popupCandidates.delete(targetTabId); }
    }
});

/* ------------------------------------------------------------------------- */
/* Regex rules of static lists                                                */

// Chrome cannot switch off a static regex rule (see BAND.REGEX), so the regex
// rules of static lists ship as data (rulesets/static-regex.json) and live in
// the dynamic REGEX band, rebuilt wholesale from the enabled lists. A list's
// set comes from its latest update when that update ran under this build, and
// from the build otherwise.
const STATIC_REGEX_KEY = 'staticRegex';

async function loadStaticRegexSeed() {
    return fetch(chrome.runtime.getURL('rulesets/static-regex.json')).then(r => r.json());
}

async function loadStaticRegexUpdates() {
    const got = await chrome.storage.local.get(STATIC_REGEX_KEY);
    const stored = got[STATIC_REGEX_KEY];
    // A newer build ships newer lists; sets fetched under an older one are stale.
    if ( stored?.version !== chrome.runtime.getManifest().version ) { return {}; }
    return stored.lists ?? {};
}

async function saveStaticRegexUpdates(lists) {
    await chrome.storage.local.set({
        [STATIC_REGEX_KEY]: { version: chrome.runtime.getManifest().version, lists },
    });
}

async function rebuildStaticRegex() {
    const [ seed, updates, state ] = await Promise.all([
        loadStaticRegexSeed(), loadStaticRegexUpdates(), loadListState(),
    ]);
    const bySeed = new Map(seed.map(e => [ e.token, e.rules ]));
    const tokens = new Set([ ...bySeed.keys(), ...Object.keys(updates) ]);
    let rules = [];
    let lists = 0;
    for ( const token of tokens ) {
        if ( state[token]?.enabled === false ) { continue; }
        const set = updates[token] ?? bySeed.get(token) ?? [];
        if ( set.length === 0 ) { continue; }
        rules = rules.concat(set);
        lists += 1;
    }
    const result = await replaceBand(BAND.REGEX, rules);
    return { ...result, lists };
}

// Chrome restores the manifest's set of enabled static rulesets on every
// extension update ("not persisted across extension updates"), so a static list
// the user switched off comes back on. Re-apply the stored choices.
async function applyStaticListStates() {
    const [ catalog, state, enabledNow ] = await Promise.all([
        loadCatalog(), loadListState(), chrome.declarativeNetRequest.getEnabledRulesets(),
    ]);
    const enabled = new Set(enabledNow);
    const enableRulesetIds = [];
    const disableRulesetIds = [];
    for ( const c of catalog ) {
        if ( c.kind !== 'static' ) { continue; }
        const want = state[c.token]?.enabled !== false;
        if ( want && enabled.has(c.id) === false ) { enableRulesetIds.push(c.id); }
        if ( want === false && enabled.has(c.id) ) { disableRulesetIds.push(c.id); }
    }
    if ( enableRulesetIds.length !== 0 || disableRulesetIds.length !== 0 ) {
        await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds, disableRulesetIds });
    }
    return { enabled: enableRulesetIds.length, disabled: disableRulesetIds.length };
}

// Deltas are diffs against the baselines of the build that computed them; the
// per-list update record (deltaState) is reset when the build changes. See
// reconcileStaticDeltas().
const DELTA_BUILD_KEY = 'deltaBuild';

/* ------------------------------------------------------------------------- */
/* Updating lists that live in static rulesets                                */

// A static ruleset is immutable once packaged, so a list inside one cannot be
// rewritten. It can still be UPDATED, because Chrome exposes the two halves of a
// diff:
//   - updateStaticRules({ rulesetId, disableRuleIds }) switches off individual
//     baseline rules that disappeared upstream
//   - dynamic rules carry the additions
//
// Regex rules are the exception: Chrome ignores disableRuleIds for them, so they
// are never in a static ruleset. A list's current regex set replaces its old one
// in the REGEX band instead (see rebuildStaticRegex).
//
// Rotating whole lists through the dynamic band was the obvious alternative and
// does not work: with ~113,000 static rules against a 30,000 budget, refreshing
// group B means group A reverts to its stale baseline. Holding only the DIFFS
// keeps every list current at once, because diffs are small.
//
// This is finite. Deltas accumulate as lists drift from the baseline they were
// built against; when the reserve fills, a rebuild resets it.

async function loadBaseline(rulesetId) {
    return fetch(chrome.runtime.getURL(`rulesets/${rulesetId}.baseline.json`))
        .then(r => r.json())
        .catch(() => null);
}

const DELTA_STATE_KEY = 'deltaState';

async function loadDeltaState() {
    const got = await chrome.storage.local.get(DELTA_STATE_KEY);
    return got[DELTA_STATE_KEY] ?? {};
}

async function saveDeltaState(state) {
    await chrome.storage.local.set({ [DELTA_STATE_KEY]: state });
}

// Diff one static list against its baseline. applyStaticDeltas() decides
// whether the diff is applied.
async function updateStaticList(entry) {
    const baseline = await loadBaseline(entry.id);
    if ( baseline === null ) {
        throw new Error(`no baseline for "${entry.id}" -- rebuild required`);
    }

    const { text } = await fetchList(entry.urls);
    const { rules } = await compileToDNR([ { name: entry.token, text } ]);
    const popup = await popupEngineLines(text, ENV, DNR_COMPILE_OPTIONS);

    // Chrome rejects the whole batch over one bad regex, and a static ruleset
    // will not load with one, so additions get the same treatment as any other
    // dynamic rule.
    const { kept } = await dropUnsupportedRegex(rules.map(sanitizeRule));
    const regex = kept.filter(r => r.condition?.regexFilter !== undefined);

    const seen = new Set();
    const additions = [];
    for ( const rule of kept ) {
        if ( rule.condition?.regexFilter !== undefined ) { continue; }
        const h = ruleHash(rule);
        seen.add(h);
        if ( baseline[h] === undefined ) { additions.push(rule); }
    }
    const disableRuleIds = [];
    for ( const [ h, id ] of Object.entries(baseline) ) {
        if ( seen.has(h) === false ) { disableRuleIds.push(id); }
    }

    return {
        token: entry.token,
        rulesetId: entry.id,
        baselineSize: Object.keys(baseline).length,
        upstreamSize: kept.length,
        additions,
        disableRuleIds,
        regex,
        popup,
    };
}

// The delta applied to each static list: which baseline rules are switched off
// and which new rules stand in for them. Stored per list, so a list that is not
// refreshed in a run (its fetch failed, or only other lists were asked for)
// keeps its pair intact instead of keeping the switches-off without additions.
const STATIC_DELTAS_KEY = 'staticDeltas';

async function loadStaticDeltas() {
    const got = await chrome.storage.local.get(STATIC_DELTAS_KEY);
    const stored = got[STATIC_DELTAS_KEY];
    // Deltas are diffs against this build's baselines.
    if ( stored?.version !== chrome.runtime.getManifest().version ) { return {}; }
    return stored.lists ?? {};
}

async function saveStaticDeltas(lists) {
    await chrome.storage.local.set({
        [STATIC_DELTAS_KEY]: { version: chrome.runtime.getManifest().version, lists },
    });
}

// Make Chrome match `deltas` ({ token: { rulesetId, additions, disableRuleIds } }):
// the enabled static lists' additions form the DELTA band, and each ruleset's
// switched-off rules are exactly its list's removals (none for a list kept at
// its baseline or switched off). Switches-off are lifted first and additions
// installed before new ones apply, so no rule is ever off without its stand-in.
async function applyStaticDeltaState(deltas, report) {
    const [ catalog, state ] = await Promise.all([ loadCatalog(), loadListState() ]);
    const additions = [];
    const pendingDisable = [];
    let enabledCount = 0;
    for ( const c of catalog.filter(e => e.kind === 'static') ) {
        const d = state[c.token]?.enabled !== false ? deltas[c.token] : undefined;
        if ( d !== undefined ) { additions.push(...d.additions); }
        const want = new Set(d?.disableRuleIds ?? []);
        try {
            const current = new Set(await chrome.declarativeNetRequest.getDisabledRuleIds({ rulesetId: c.id }));
            const enableRuleIds = [ ...current ].filter(id => want.has(id) === false);
            const disableRuleIds = [ ...want ].filter(id => current.has(id) === false);
            if ( enableRuleIds.length !== 0 ) {
                await chrome.declarativeNetRequest.updateStaticRules({ rulesetId: c.id, enableRuleIds });
                enabledCount += enableRuleIds.length;
            }
            if ( disableRuleIds.length !== 0 ) { pendingDisable.push({ token: c.token, rulesetId: c.id, disableRuleIds }); }
        } catch ( reason ) {
            report.failed.push({ token: c.token, error: `static rule state: ${reason.message}` });
        }
    }
    const band = await replaceBand(BAND.DELTA, additions);
    let disabledCount = 0;
    for ( const p of pendingDisable ) {
        try {
            await chrome.declarativeNetRequest.updateStaticRules({ rulesetId: p.rulesetId, disableRuleIds: p.disableRuleIds });
            disabledCount += p.disableRuleIds.length;
        } catch ( reason ) {
            report.failed.push({ token: p.token, error: `disable failed (${p.disableRuleIds.length} rules): ${reason.message}` });
        }
    }
    return { additions: additions.length, band, reEnabled: enabledCount, newlyDisabled: disabledCount };
}

// Apply the diffs for every static list, honouring the delta reserve and
// Chrome's cap on switched-off static rules.
//
// A list is either UPDATED (its removed rules switched off and its new rules
// installed) or left as it was, never half of each; planStaticDeltas() decides.
// Switching off a list's removed rules while its replacements did not fit made
// blocking weaker than the build: on 2026-10-08 urlhaus-1 had grown by 13,831
// rules, filled the 6,000-rule reserve, and every list after it lost rules it
// still had upstream (EasyList's rule for adsboosters.xyz among them).
async function applyStaticDeltas(entries, report) {
    const [ deltaState, applied ] = await Promise.all([ loadDeltaState(), loadStaticDeltas() ]);
    const diffs = [];
    for ( const entry of entries ) {
        try {
            diffs.push(await updateStaticList(entry));
        } catch ( reason ) {
            report.failed.push({ token: entry.token, error: reason.message });
        }
    }

    // What the additions may use: the reserve, capped by what the other bands
    // actually leave of Chrome's dynamic quotas (lists grow after a build).
    const others = auditBudget((await getDynamicRules()).filter(r => inBand(r.id, BAND.DELTA) === false));
    const { next, mode } = planStaticDeltas(diffs, applied, {
        additions: Math.min(BUDGET.DELTA_RESERVE, LIMITS.MAX_NUMBER_OF_DYNAMIC_RULES - others.total),
        unsafe: LIMITS.MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES - others.unsafe,
        disabled: LIMITS.MAX_NUMBER_OF_DISABLED_STATIC_RULES,
    }, rules => auditBudget(rules).unsafe);
    // Stored only once Chrome holds it; a failed apply leaves the previous state
    // as the one reconcile converges on.
    const result = await applyStaticDeltaState(next, report);
    await saveStaticDeltas(next);
    // Not updated: a refreshed list whose diff did not fit, or a list not
    // refreshed this run whose update in force no longer fits.
    const byToken = new Map(diffs.map(d => [ d.token, d ]));
    const notUpdated = Object.entries(mode)
        .filter(([ token, m ]) => byToken.has(token) ? m !== 'updated' : m === 'baseline')
        .map(([ token, m ]) => {
            const d = byToken.get(token) ?? applied[token];
            return { token, mode: m, additions: d.additions.length, removals: d.disableRuleIds.length };
        });

    // Each updated list's regex set replaces its previous one wholesale.
    let regex = null;
    if ( diffs.length !== 0 ) {
        const popupLists = await loadPopupLineUpdates();
        for ( const d of diffs ) { popupLists[d.token] = d.popup; }
        await chrome.storage.local.set({
            [POPUP_LINES_KEY]: { version: chrome.runtime.getManifest().version, lists: popupLists },
        });
        invalidatePopupEngine();
        const updates = await loadStaticRegexUpdates();
        for ( const d of diffs ) { updates[d.token] = d.regex; }
        await saveStaticRegexUpdates(updates);
        try {
            regex = await rebuildStaticRegex();
        } catch ( reason ) {
            report.failed.push({ token: '(static regex)', error: reason.message });
        }
    }

    // A list that was not updated keeps the time of its last real update.
    const now = Date.now();
    for ( const d of diffs ) {
        const updated = mode[d.token] === 'updated';
        deltaState[d.token] = {
            lastUpdated: updated ? now : (deltaState[d.token]?.lastUpdated ?? null),
            mode: mode[d.token],
            added: d.additions.length,
            disabled: d.disableRuleIds.length,
            regex: d.regex.length,
            baselineSize: d.baselineSize,
            upstreamSize: d.upstreamSize,
        };
    }
    for ( const n of notUpdated ) {
        if ( byToken.has(n.token) === false && deltaState[n.token] !== undefined ) {
            deltaState[n.token] = { ...deltaState[n.token], mode: n.mode };
        }
    }
    await saveDeltaState(deltaState);

    const reserved = Object.values(next).reduce((n, d) => n + d.additions.length, 0);
    return {
        lists: diffs.length,
        updated: Object.values(mode).filter(m => m === 'updated').length,
        notUpdated,
        added: result.additions,
        disabled: Object.values(next).reduce((n, d) => n + d.disableRuleIds.length, 0),
        reEnabled: result.reEnabled,
        regex,
        reserve: BUDGET.DELTA_RESERVE,
        reserveUsedPct: Math.round((reserved / BUDGET.DELTA_RESERVE) * 100),
        rebuildRecommended: notUpdated.length !== 0 || reserved > BUDGET.DELTA_RESERVE * 0.8,
    };
}

// Converge Chrome on the stored static deltas. After an extension update the
// stored deltas belong to the old build's baselines, so none apply: the DELTA
// band empties and every switched-off rule comes back on. Chrome documents
// resetting switched-off rules on update; this does not depend on it.
async function reconcileStaticDeltas() {
    const version = chrome.runtime.getManifest().version;
    const got = await chrome.storage.local.get(DELTA_BUILD_KEY);
    if ( got[DELTA_BUILD_KEY] !== version ) {
        await saveDeltaState({});
        await chrome.storage.local.set({ [DELTA_BUILD_KEY]: version });
    }
    const report = { failed: [] };
    const result = await applyStaticDeltaState(await loadStaticDeltas(), report);
    if ( report.failed.length !== 0 ) {
        throw new Error(report.failed.map(f => `${f.token}: ${f.error}`).join('; '));
    }
    return result;
}

/* ------------------------------------------------------------------------- */
/* Scriptlet content-script registration                                      */

// Scriptlets must execute before the page's own scripts, so they are registered
// as document_start content scripts scoped to the hostnames that need them --
// a message round-trip would always lose that race. MAIN-world entries patch
// page globals; ISOLATED ones run in the content-script realm.
//
// Chrome's cap on registered content scripts is not documented as a constant, so
// registration is done in chunks and any rejection is reported with the count
// that failed rather than silently leaving scriptlets uninstalled.
// Chrome match-pattern host: dot-separated [a-z0-9-] labels only.
const VALID_MATCH_HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const hostPattern = h => (VALID_MATCH_HOST.test(h) ? `*://*.${h}/*` : null);
const hostFromPattern = p => /^\*:\/\/\*\.([^/]+)\/\*$/.exec(p)?.[1] ?? null;
const hostsRelated = (a, b) => a === b || a.endsWith('.' + b) || b.endsWith('.' + a);

async function loadHideExceptions() {
    return fetch(chrome.runtime.getURL('data/cosmetic/hide-exceptions.json'))
        .then(r => r.json())
        .catch(() => ({ generic: [], specific: [] }));
}

// Registration reads the current registrations and converges on the desired
// set; reconcile() and the per-site toggle can both trigger it, so it is queued
// to keep two runs from computing against the same stale read.
let registrationChain = Promise.resolve();
function registerScriptletScripts() {
    const run = registrationChain.then(registerScriptletScriptsNow, registerScriptletScriptsNow);
    registrationChain = run.catch(() => {});
    return run;
}

async function registerScriptletScriptsNow() {
    const [ registrations, config ] = await Promise.all([
        fetch(chrome.runtime.getURL('scriptlets/registrations.json')).then(r => r.json()).catch(() => []),
        loadConfig(),
    ]);

    // uBlock Origin injects neither scriptlets nor cosmetic filters on a
    // whitelisted site (getNetFilteringSwitch gates both). Expressed here as
    // excludeMatches, so the browser itself skips injection there.
    const whitelistHosts = (config.whitelist ?? []).map(w => String(w).trim().toLowerCase())
        .filter(h => VALID_MATCH_HOST.test(h));

    const scripts = registrations.map(r => {
        // A shard only needs the whitelist hosts that can overlap its matches;
        // the everywhere-matching wildcard registration needs all of them.
        const matchHosts = r.matches.map(hostFromPattern);
        const everywhere = matchHosts.includes(null);
        const excludes = whitelistHosts
            .filter(w => everywhere || matchHosts.some(m => m !== null && hostsRelated(w, m)))
            .map(hostPattern);
        // Always sent, even when empty: updateContentScripts only changes the
        // fields it is given, so omitting it would leave exclusions from a
        // whitelist entry the user has since removed.
        return {
            id: r.id,
            js: r.js,
            matches: r.matches,
            excludeMatches: excludes,
            runAt: 'document_start',
            world: r.world,
            allFrames: true,
            persistAcrossSessions: true,
        };
    });

    // Generic cosmetic filtering (highly generic stylesheet + lowly generic DOM
    // surveyor), skipped on whitelisted sites. $generichide/$elemhide sites are
    // checked in the page by generic.js rather than listed here: Chrome keeps
    // every registered match pattern in every renderer process, and the page
    // check also covers entity and regex hostname forms.
    scripts.push({
        id: 'ubmv3-generic',
        js: [ 'data/cosmetic/generic-lookup.js', 'generic.js' ],
        matches: [ 'http://*/*', 'https://*/*' ],
        excludeMatches: whitelistHosts.map(hostPattern),
        runAt: 'document_start',
        world: 'ISOLATED',
        allFrames: true,
        matchOriginAsFallback: true,
        persistAcrossSessions: true,
    });

    // Converge on the desired set rather than unregister-then-register. The old
    // approach failed with "Duplicate script ID" whenever two reconciles ran
    // concurrently: both cleared, then both registered the same ids. Updating
    // what exists and registering only what is missing is safe to repeat.
    const existing = await chrome.scripting.getRegisteredContentScripts().catch(() => []);
    const have = new Set(existing.filter(s => s.id.startsWith('ubmv3-')).map(s => s.id));
    const want = new Set(scripts.map(s => s.id));

    const stale = [ ...have ].filter(id => want.has(id) === false);
    if ( stale.length !== 0 ) {
        await chrome.scripting.unregisterContentScripts({ ids: stale }).catch(() => {});
    }

    const failed = [];
    let registered = 0;
    const toUpdate = scripts.filter(s => have.has(s.id));
    const toAdd = scripts.filter(s => have.has(s.id) === false);

    // Apply in chunks; on a chunk failure retry per script so one bad entry does
    // not cost the rest, and treat a duplicate id as "update instead".
    const CHUNK = 16;
    const applyChunked = async (list, fn, fallback) => {
        for ( let i = 0; i < list.length; i += CHUNK ) {
            const chunk = list.slice(i, i + CHUNK);
            try {
                await fn(chunk);
                registered += chunk.length;
            } catch {
                for ( const s of chunk ) {
                    try {
                        await fn([ s ]);
                        registered += 1;
                    } catch ( inner ) {
                        if ( fallback ) {
                            try { await fallback([ s ]); registered += 1; continue; }
                            catch ( again ) { failed.push({ id: s.id, error: again.message }); continue; }
                        }
                        failed.push({ id: s.id, matches: s.matches.length, error: inner.message });
                    }
                }
            }
        }
    };
    const update = list => chrome.scripting.updateContentScripts(list);
    const register = list => chrome.scripting.registerContentScripts(list);
    await applyChunked(toUpdate, update, register);
    await applyChunked(toAdd, register, update);
    // Persist the outcome. Registration happens on install/startup, long before
    // anyone opens the dashboard, and a silent total failure here disables every
    // scriptlet while the rest of the extension looks perfectly healthy -- which
    // is exactly what happened when 2,548 invalid match patterns were shipped.
    const outcome = {
        registered, failed, total: scripts.length,
        whitelistExcluded: whitelistHosts.length,
        at: Date.now(),
        ok: failed.length === 0 && registered === scripts.length,
    };
    await chrome.storage.local.set({ scriptletRegistration: outcome });
    if ( outcome.ok === false ) {
        // Stringified: a bare object logs as "[object Object]" in extension error
        // views, which hid the actual failure reasons.
        console.error('[uBlockMV3] scriptlet registration incomplete ' + JSON.stringify(outcome));
    }
    return outcome;
}

/* ------------------------------------------------------------------------- */
/* Hostname switches                                                          */

// uBO's per-site switches. Only those with an MV3 equivalent are applied; the
// rest are reported by the diagnostics handler rather than quietly ignored.
//
//   no-large-media     - no DNR equivalent (uBO decides per response size)
//   no-csp-reports     - expressible: block the csp_report resource type
//   no-strict-blocking - uBO-internal behaviour, nothing to apply in DNR
//   no-cosmetic-filtering / no-scripting - handled in the cosmetic path
function parseHostnameSwitches(str) {
    const out = [];
    for ( const line of String(str || '').split('\n') ) {
        const s = line.trim();
        if ( s === '' ) { continue; }
        const m = /^([a-z-]+):\s*(\S+)\s+(true|false)$/.exec(s);
        if ( m === null ) { continue; }
        out.push({ name: m[1], hostname: m[2], state: m[3] === 'true' });
    }
    return out;
}

const SWITCH_SUPPORT = {
    'no-csp-reports': 'applied',
    'no-large-media': 'unsupported: DNR cannot match on response size',
    'no-strict-blocking': 'not applicable: uBO-internal blocking behaviour',
    'no-cosmetic-filtering': 'applied',
    'no-scripting': 'unsupported: MV3 cannot disable page JS per-site',
    'no-remote-fonts': 'applied',
    'no-popups': 'applied',
};

async function applyHostnameSwitches(config) {
    const switches = parseHostnameSwitches(config.hostnameSwitchesString);
    const applied = [];
    const skipped = [];
    const rules = [];

    for ( const sw of switches ) {
        const support = SWITCH_SUPPORT[sw.name] ?? 'unknown switch';
        if ( support !== 'applied' || sw.state !== true ) {
            skipped.push({ ...sw, why: sw.state ? support : 'switch is off' });
            continue;
        }
        if ( sw.name === 'no-csp-reports' ) {
            rules.push({
                priority: 90000,
                action: { type: 'block' },
                condition: {
                    resourceTypes: [ 'csp_report' ],
                    ...(sw.hostname === '*' ? {} : { requestDomains: [ sw.hostname ] }),
                },
            });
            applied.push(sw);
        } else if ( sw.name === 'no-remote-fonts' ) {
            rules.push({
                priority: 90000,
                action: { type: 'block' },
                condition: {
                    resourceTypes: [ 'font' ],
                    ...(sw.hostname === '*' ? {} : { requestDomains: [ sw.hostname ] }),
                },
            });
            applied.push(sw);
        } else if ( sw.name === 'no-popups' ) {
            // Enforced when a page opens a tab (see noPopupsSwitch), not by DNR.
            applied.push(sw);
        }
    }

    await replaceBand(BAND.SWITCHES, rules);
    return { applied, skipped, rules: rules.length };
}

/* ------------------------------------------------------------------------- */
/* Install / startup                                                          */

// Bring the browser's state in line with the stored config. Each step is
// isolated: one failing must not prevent the others from applying, or a single
// bad list would leave the user with no blocking at all.
// onInstalled, onStartup and an import can all trigger a reconcile, and in MV3
// they can overlap. Every step mutates shared browser state (dynamic rules,
// registered scripts), so overlapping runs race. Queue them instead.
let reconcileChain = Promise.resolve();
function reconcile() {
    const run = reconcileChain.then(reconcileOnce, reconcileOnce);
    reconcileChain = run.catch(() => {});
    return run;
}

async function reconcileOnce() {
    const config = await loadConfig();
    const results = { };
    invalidatePopupEngine();
    try {
        results.whitelist = await applyWhitelist(config);
    } catch ( reason ) {
        results.whitelistError = reason.message;
    }
    try {
        results.switches = await applyHostnameSwitches(config);
    } catch ( reason ) {
        results.switchesError = reason.message;
    }
    try {
        results.lists = await rebuildDynamicLists();
    } catch ( reason ) {
        results.listsError = reason.message;
    }
    try {
        results.staticLists = await applyStaticListStates();
    } catch ( reason ) {
        results.staticListsError = reason.message;
    }
    try {
        results.staticDeltas = await reconcileStaticDeltas();
    } catch ( reason ) {
        results.staticDeltasError = reason.message;
    }
    try {
        results.staticRegex = await rebuildStaticRegex();
    } catch ( reason ) {
        results.staticRegexError = reason.message;
    }
    try {
        results.scriptlets = await registerScriptletScripts();
    } catch ( reason ) {
        results.scriptletsError = reason.message;
    }
    try {
        results.userFilters = await reapplyUserFilters();
    } catch ( reason ) {
        results.userFiltersError = reason.message;
    }
    const rules = await getDynamicRules();
    results.budget = auditBudget(rules);
    return results;
}

chrome.runtime.onInstalled.addListener(async details => {
    const r = await reconcile();
    console.log('[uBlockMV3] installed/updated', details.reason, r);
    // uBO refreshes lists on a timer; mirror that.
    chrome.alarms.create('listUpdate', { periodInMinutes: 60 * 12, delayInMinutes: 60 });
});

chrome.runtime.onStartup.addListener(async () => {
    const r = await reconcile();
    console.log('[uBlockMV3] startup', r);
});

chrome.alarms.onAlarm.addListener(async alarm => {
    if ( alarm.name !== 'listUpdate' ) { return; }
    const r = await updateAllLists();
    console.log('[uBlockMV3] scheduled update', r);
});

/* ------------------------------------------------------------------------- */
/* Messaging                                                                  */

const HANDLERS = {
    async getCosmetic({ hostname }) { return cosmeticFor(hostname); },

    // uBO's procedural engine, injected only into frames that have procedural
    // filters (content.js asks). Declaring it for every frame cost memory and
    // parse time on the large majority of frames that never use it.
    async injectProcedural(msg, sender) {
        const tabId = sender?.tab?.id;
        const frameId = sender?.frameId;
        if ( typeof tabId !== 'number' || typeof frameId !== 'number' ) {
            return { injected: false, error: 'no sender frame' };
        }
        await chrome.scripting.executeScript({
            target: { tabId, frameIds: [ frameId ] },
            files: [ 'procedural.js' ],
            injectImmediately: true,
        });
        return { injected: true };
    },

    async getStatus({ hostname }) {
        const config = await loadConfig();
        const rules = await getDynamicRules();
        const enabledRulesets = await chrome.declarativeNetRequest.getEnabledRulesets();
        const wl = new Set((config.whitelist ?? []).map(w => String(w).trim().toLowerCase()));
        return {
            hostname,
            // Same ladder rule as uBO: a parent-domain entry covers subdomains.
            whitelisted: hostname !== '' && (wl.has(hostname) || hostnameLadder(hostname).some(h => wl.has(h))),
            whitelistSize: (config.whitelist ?? []).length,
            dynamicRules: rules.length,
            enabledRulesets: enabledRulesets.length,
            budget: auditBudget(rules),
        };
    },

    async setSiteEnabled({ hostname, enabled }) { return setSiteEnabled(hostname, enabled); },

    // content.js: the link the user just pressed (uBO's maybeGoodPopup).
    async maybeGoodPopup({ url }, sender) {
        maybeGoodPopup.tabId = sender?.tab?.id ?? 0;
        maybeGoodPopup.url = typeof url === 'string' ? url : '';
        return true;
    },

    async getLists() {
        const [ catalog, state, extra, deltaState ] = await Promise.all([
            loadCatalog(),
            loadListState(),
            chrome.storage.local.get(EXTRA_SEED_KEY).then(g => g[EXTRA_SEED_KEY] ?? []),
            loadDeltaState(),
        ]);
        const enabledRulesets = new Set(await chrome.declarativeNetRequest.getEnabledRulesets());
        const rows = catalog.map(c => {
            // A patched (static) list records its refresh in deltaState, not
            // listState -- without this the UI shows "never updated" for lists
            // that were in fact just patched.
            const delta = deltaState[c.token];
            return {
                ...c,
                mode: c.kind === 'static' ? 'patched' : 'full',
                enabled: c.kind === 'static'
                    ? enabledRulesets.has(c.id)
                    : state[c.token]?.enabled !== false,
                lastUpdated: c.kind === 'static'
                    ? (delta?.lastUpdated ?? null)
                    : (state[c.token]?.lastUpdated ?? null),
                lastError: state[c.token]?.lastError ?? (
                    delta?.mode !== undefined && delta.mode !== 'updated'
                        ? `latest upstream changes (+${delta.added} / -${delta.disabled} rules) did not fit; ` +
                          `${delta.mode === 'baseline' ? 'kept at the version this build shipped' : 'kept its previous update'}` +
                          ' -- installing a newer build picks them up'
                        : null
                ),
                delta: delta
                    ? { mode: delta.mode ?? null, added: delta.added, disabled: delta.disabled, upstream: delta.upstreamSize }
                    : null,
            };
        });
        for ( const e of extra ) {
            rows.push({
                token: e.token, id: e.token, kind: 'dynamic', title: e.title,
                rules: null, custom: true,
                enabled: state[e.token]?.enabled !== false,
                lastUpdated: state[e.token]?.lastUpdated ?? null,
                lastError: state[e.token]?.lastError ?? null,
            });
        }
        return rows;
    },

    async setListEnabled({ token, enabled }) { return setListEnabled(token, enabled); },
    async addList({ url }) { return addCustomList(url); },
    async removeList({ url }) { return removeCustomList(url); },
    async updateAll({ tokens }) { return updateAllLists({ tokens: tokens ?? null }); },

    async exportConfig() {
        const config = await loadConfig();
        return { filename: backupFilename(), data: toBackup(config) };
    },

    async importConfig({ text }) {
        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch ( reason ) {
            return { ok: false, errors: [ `not valid JSON: ${reason.message}` ] };
        }
        const check = validateBackup(parsed);
        if ( check.ok === false ) { return check; }
        await saveConfig(check.config);
        const applied = await reconcile();
        return { ok: true, errors: [], applied };
    },

    async getUserFilters() {
        const config = await loadConfig();
        return { userFilters: config.userFilters ?? '' };
    },

    async setUserFilters({ userFilters }) {
        const config = await loadConfig();
        config.userFilters = userFilters;
        await saveConfig(config);
        const cache = await getCachedText();
        cache['user-filters'] = userFilters;
        await setCachedText(cache);
        const install = await rebuildDynamicLists();
        // Cosmetic and scriptlet user filters, compiled from the saved text.
        const user = await reapplyUserFilters();
        return { install, user };
    },

    // Status of "My filters" for the dashboard. If scriptlet filters were
    // waiting on "Allow user scripts" and it has since been enabled, apply now:
    // Chrome raises no event when the user flips that switch.
    async getUserFiltersStatus() {
        let status = await chrome.storage.local.get(USER_STATUS_KEY).then(g => g[USER_STATUS_KEY] ?? null);
        if ( status === null || (status.userScripts !== 'enabled' && await userScriptsAvailable()) ) {
            status = await reapplyUserFilters();
        }
        return status;
    },

    // Chrome enforces a cap on disabled static rules -- the error string
    // "The number of disabled static rules exceeds the disabled rule count
    // limit." exists in the binary -- but the number is a compile-time constant
    // and is not exposed through the API. The delta mechanism's headroom depends
    // on it, so it is measured here by binary search instead of assumed.
    async probeDisabledStaticLimit({ rulesetId }) {
        const enabled = await chrome.declarativeNetRequest.getEnabledRulesets();
        const target = rulesetId ?? enabled[0];
        if ( target === undefined ) { return { error: 'no enabled static ruleset' }; }

        const before = await chrome.declarativeNetRequest.getDisabledRuleIds({ rulesetId: target })
            .catch(() => []);

        const tryCount = async n => {
            const ids = Array.from({ length: n }, (_, i) => i + 1);
            try {
                await chrome.declarativeNetRequest.updateStaticRules({
                    rulesetId: target, disableRuleIds: ids,
                });
                return true;
            } catch {
                return false;
            }
        };

        let lo = 0;
        let hi = 60000;
        if ( await tryCount(hi) ) { lo = hi; }
        else {
            while ( hi - lo > 1 ) {
                const mid = Math.floor((lo + hi) / 2);
                if ( await tryCount(mid) ) { lo = mid; } else { hi = mid; }
            }
        }

        // Restore whatever was disabled before probing.
        await chrome.declarativeNetRequest.updateStaticRules({
            rulesetId: target,
            enableRuleIds: Array.from({ length: Math.max(lo, 1) }, (_, i) => i + 1),
        }).catch(() => {});
        if ( before.length !== 0 ) {
            await chrome.declarativeNetRequest.updateStaticRules({
                rulesetId: target, disableRuleIds: before,
            }).catch(() => {});
        }

        return {
            rulesetId: target,
            maxDisabledStaticRules: lo,
            restoredPreviouslyDisabled: before.length,
            note: 'measured by binary search against the live API',
        };
    },

    async diagnostics() {
        const config = await loadConfig();
        const rules = await getDynamicRules();
        const enabled = await chrome.declarativeNetRequest.getEnabledRulesets();
        const index = await fetch(chrome.runtime.getURL('data/cosmetic/index.json'))
            .then(r => r.json()).catch(() => null);
        const registered = await chrome.scripting.getRegisteredContentScripts().catch(() => []);
        const regOutcome = await chrome.storage.local.get('scriptletRegistration')
            .then(g => g.scriptletRegistration ?? null);
        const expected = await fetch(chrome.runtime.getURL('scriptlets/registrations.json'))
            // +1: the generic cosmetic registration (ubmv3-generic).
            .then(r => r.json()).then(a => a.length + 1).catch(() => null);
        const switches = parseHostnameSwitches(config.hostnameSwitchesString).map(sw => ({
            ...sw, support: SWITCH_SUPPORT[sw.name] ?? 'unknown switch',
        }));
        return {
            dynamic: auditBudget(rules),
            enabledRulesets: enabled,
            enabledRulesetCount: enabled.length,
            scriptlets: {
                registeredNow: registered.length,
                expected,
                mainWorld: registered.filter(s => s.world === 'MAIN').length,
                isolatedWorld: registered.filter(s => s.world === 'ISOLATED').length,
                healthy: expected !== null && registered.length === expected,
                lastRegistration: regOutcome,
            },
            hostnameSwitches: switches,
            userFilters: await chrome.storage.local.get(USER_STATUS_KEY).then(g => g[USER_STATUS_KEY] ?? null),
            cosmeticIndex: index,
            shardCount: SHARD_COUNT,
            limits: chrome.declarativeNetRequest
                ? {
                    MAX_NUMBER_OF_DYNAMIC_RULES: chrome.declarativeNetRequest.MAX_NUMBER_OF_DYNAMIC_RULES,
                    MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES: chrome.declarativeNetRequest.MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES,
                    MAX_NUMBER_OF_REGEX_RULES: chrome.declarativeNetRequest.MAX_NUMBER_OF_REGEX_RULES,
                    MAX_NUMBER_OF_ENABLED_STATIC_RULESETS: chrome.declarativeNetRequest.MAX_NUMBER_OF_ENABLED_STATIC_RULESETS,
                    GUARANTEED_MINIMUM_STATIC_RULES: chrome.declarativeNetRequest.GUARANTEED_MINIMUM_STATIC_RULES,
                }
                : null,
        };
    },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const handler = HANDLERS[msg?.what];
    if ( handler === undefined ) {
        sendResponse({ error: `unknown message: ${msg?.what}` });
        return false;
    }
    handler(msg, sender)
        .then(result => sendResponse({ result }))
        .catch(reason => sendResponse({ error: reason.message, stack: reason.stack }));
    return true; // async response
});
