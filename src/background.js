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
import { SHARD_COUNT, shardOf, hostnameLadder } from './lib/shard.js';
import {
    loadConfig, saveConfig, validateBackup, toBackup, backupFilename,
} from './lib/storage.js';
import {
    BAND, BUDGET, replaceBand, getDynamicRules, auditBudget, whitelistToRules,
    dropUnsupportedRegex, sanitizeRule,
} from './lib/dynamic-rules.js';
import { ruleHash } from './lib/rulehash.js';

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
    const res = await dnrRulesetFromRawLists(lists, { env: ENV });
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
    const [ seed, state, cache ] = await Promise.all([
        loadDynamicSeed(), loadListState(), getCachedText(),
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

    if ( entry.kind === 'static' ) {
        // Static lists are whole rulesets; toggling one is an enable/disable.
        await chrome.declarativeNetRequest.updateEnabledRulesets(
            enabled ? { enableRulesetIds: [ entry.id ] }
                    : { disableRulesetIds: [ entry.id ] }
        );
        return { kind: 'static', id: entry.id, enabled };
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
    if ( enabled ) { set.delete(hostname); } else { set.add(hostname); }
    config.whitelist = Array.from(set).sort();
    await saveConfig(config);
    const applied = await applyWhitelist(config);
    return { hostname, blocking: enabled, whitelisted: set.has(hostname), applied };
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

async function cosmeticFor(hostname) {
    const config = await loadConfig();
    // A whitelisted site gets no cosmetic filtering, matching uBO.
    if ( (config.whitelist ?? []).includes(hostname) ) {
        return { selectors: [], procedural: [], scriptlets: [], disabled: true };
    }

    const ladder = hostnameLadder(hostname);
    const selectors = [];
    const procedural = [];
    const scriptlets = [];

    const shards = new Set(ladder.map(shardOf));
    const specific = new Map();
    const scriptletMap = new Map();
    await Promise.all(Array.from(shards).flatMap(n => [
        loadShard('specific', n).then(o => specific.set(n, o)),
        loadShard('scriptlet', n).then(o => scriptletMap.set(n, o)),
    ]));

    for ( const host of ladder ) {
        const n = shardOf(host);
        for ( const v of (specific.get(n)?.[host] ?? []) ) {
            if ( typeof v === 'string' ) { selectors.push(v); }
            else if ( v && v.p ) { procedural.push(v); }
        }
        for ( const args of (scriptletMap.get(n)?.[host] ?? []) ) {
            scriptlets.push(args);
        }
    }
    return { selectors, procedural, scriptlets, disabled: false };
}

/* ------------------------------------------------------------------------- */
/* Updating lists that live in static rulesets                                */

// A static ruleset is immutable once packaged, so a list inside one cannot be
// rewritten. It can still be UPDATED, because Chrome exposes the two halves of a
// diff:
//   - updateStaticRules({ rulesetId, disableRuleIds }) switches off individual
//     baseline rules that disappeared upstream
//   - dynamic rules carry the additions
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

// Diff one static list against its baseline and apply the result.
async function updateStaticList(entry, deltaState) {
    const baseline = await loadBaseline(entry.id);
    if ( baseline === null ) {
        throw new Error(`no baseline for "${entry.id}" -- rebuild required`);
    }

    const { text } = await fetchList(entry.urls);
    const { rules } = await compileToDNR([ { name: entry.token, text } ]);

    // Chrome rejects the whole batch over one bad regex, and a static ruleset
    // will not load with one, so additions get the same treatment as any other
    // dynamic rule.
    const { kept } = await dropUnsupportedRegex(rules.map(sanitizeRule));

    const seen = new Set();
    const additions = [];
    for ( const rule of kept ) {
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
    };
}

// Apply the diffs for every static list, honouring the delta reserve.
async function applyStaticDeltas(entries, report) {
    const deltaState = await loadDeltaState();
    const diffs = [];
    for ( const entry of entries ) {
        try {
            diffs.push(await updateStaticList(entry, deltaState));
        } catch ( reason ) {
            report.failed.push({ token: entry.token, error: reason.message });
        }
    }

    // Additions share one reserve. If the diffs overflow it, apply what fits and
    // say so plainly -- silently dropping half a list's new rules would leave the
    // user believing they are protected by filters that were never installed.
    const allAdditions = [];
    for ( const d of diffs ) {
        for ( const rule of d.additions ) { allAdditions.push({ rule, token: d.token }); }
    }
    let installed = allAdditions;
    let overflow = 0;
    if ( allAdditions.length > BUDGET.DELTA_RESERVE ) {
        overflow = allAdditions.length - BUDGET.DELTA_RESERVE;
        installed = allAdditions.slice(0, BUDGET.DELTA_RESERVE);
    }
    await replaceBand(BAND.DELTA, installed.map(x => x.rule));

    // Disabling is per-ruleset and has its own quota; a failure there must not
    // discard the additions that already applied.
    const disabled = [];
    for ( const d of diffs ) {
        if ( d.disableRuleIds.length === 0 ) { continue; }
        try {
            await chrome.declarativeNetRequest.updateStaticRules({
                rulesetId: d.rulesetId,
                disableRuleIds: d.disableRuleIds,
            });
            disabled.push({ rulesetId: d.rulesetId, count: d.disableRuleIds.length });
        } catch ( reason ) {
            report.failed.push({
                token: d.token,
                error: `disable failed (${d.disableRuleIds.length} rules): ${reason.message}`,
            });
        }
    }

    for ( const d of diffs ) {
        deltaState[d.token] = {
            lastUpdated: Date.now(),
            added: d.additions.length,
            disabled: d.disableRuleIds.length,
            baselineSize: d.baselineSize,
            upstreamSize: d.upstreamSize,
        };
    }
    await saveDeltaState(deltaState);

    return {
        lists: diffs.length,
        added: installed.length,
        overflow,
        disabled,
        reserve: BUDGET.DELTA_RESERVE,
        reserveUsedPct: Math.round((installed.length / BUDGET.DELTA_RESERVE) * 100),
        rebuildRecommended: overflow > 0 || installed.length > BUDGET.DELTA_RESERVE * 0.8,
    };
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
async function registerScriptletScripts() {
    const registrations = await fetch(chrome.runtime.getURL('scriptlets/registrations.json'))
        .then(r => r.json())
        .catch(() => []);
    if ( registrations.length === 0 ) { return { registered: 0, failed: [] }; }

    // Start from a clean slate so a rebuild never leaves stale registrations.
    const existing = await chrome.scripting.getRegisteredContentScripts().catch(() => []);
    const ours = existing.filter(s => s.id.startsWith('ubmv3-')).map(s => s.id);
    if ( ours.length !== 0 ) {
        await chrome.scripting.unregisterContentScripts({ ids: ours }).catch(() => {});
    }

    const scripts = registrations.map(r => ({
        id: r.id,
        js: r.js,
        matches: r.matches,
        runAt: 'document_start',
        world: r.world,
        allFrames: true,
        persistAcrossSessions: true,
    }));

    const failed = [];
    let registered = 0;
    const CHUNK = 16;
    for ( let i = 0; i < scripts.length; i += CHUNK ) {
        const chunk = scripts.slice(i, i + CHUNK);
        try {
            await chrome.scripting.registerContentScripts(chunk);
            registered += chunk.length;
        } catch ( reason ) {
            // Retry one at a time so a single bad entry does not cost the chunk.
            for ( const s of chunk ) {
                try {
                    await chrome.scripting.registerContentScripts([ s ]);
                    registered += 1;
                } catch ( inner ) {
                    failed.push({ id: s.id, matches: s.matches.length, error: inner.message });
                }
            }
        }
    }
    // Persist the outcome. Registration happens on install/startup, long before
    // anyone opens the dashboard, and a silent total failure here disables every
    // scriptlet while the rest of the extension looks perfectly healthy -- which
    // is exactly what happened when 2,548 invalid match patterns were shipped.
    const outcome = {
        registered, failed, total: scripts.length,
        at: Date.now(),
        ok: failed.length === 0 && registered === scripts.length,
    };
    await chrome.storage.local.set({ scriptletRegistration: outcome });
    if ( outcome.ok === false ) {
        console.error('[uBlockMV3] scriptlet registration incomplete', outcome);
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
async function reconcile() {
    const config = await loadConfig();
    const results = { };
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
        results.scriptlets = await registerScriptletScripts();
    } catch ( reason ) {
        results.scriptletsError = reason.message;
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

    async getStatus({ hostname }) {
        const config = await loadConfig();
        const rules = await getDynamicRules();
        const enabledRulesets = await chrome.declarativeNetRequest.getEnabledRulesets();
        return {
            hostname,
            whitelisted: (config.whitelist ?? []).includes(hostname),
            whitelistSize: (config.whitelist ?? []).length,
            dynamicRules: rules.length,
            enabledRulesets: enabledRulesets.length,
            budget: auditBudget(rules),
        };
    },

    async setSiteEnabled({ hostname, enabled }) { return setSiteEnabled(hostname, enabled); },

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
                lastError: state[c.token]?.lastError ?? null,
                delta: delta
                    ? { added: delta.added, disabled: delta.disabled, upstream: delta.upstreamSize }
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
        return { install };
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
            .then(r => r.json()).then(a => a.length).catch(() => null);
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
