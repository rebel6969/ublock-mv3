// User filters ("My filters") compiled at runtime.
//
// The dashboard is the source of truth for user filters. Network filters were
// always recompiled on save (dynamic DNR rules); cosmetic and scriptlet filters
// used to be compiled into the extension at build time from the backup file,
// so editing or deleting one in the dashboard had no effect. They are compiled
// here instead, with uBO's own engine, every time the text changes:
//
//   cosmetic   stored in chrome.storage.local; the service worker merges them
//              into its per-page cosmetic answer (content.js applies them)
//   scriptlets registered with chrome.userScripts, which is the MV3 mechanism
//              for running code that is not part of the packaged extension at
//              document_start. It reuses the packaged scriptlet bundles, so the
//              implementations are uBO's; only the call table is generated.
//
// chrome.userScripts works only after the user enables "Allow user scripts" for
// this extension (chrome://extensions > Details). When it is off, scriptlet
// filters cannot run, and that is recorded in the status rather than hidden.
import { dnrRulesetFromRawLists } from '@gorhill/ubo-core/js/static-dnr-filtering.js';
import { ENV } from './env-runtime.js';
import { parseSpecific } from './cosmetic-parse.js';

export const USER_COSMETIC_KEY = 'userCosmetic';
export const USER_STATUS_KEY = 'userFiltersStatus';

const USER_SCRIPT_IDS = { MAIN: 'ubmv3-user-main', ISOLATED: 'ubmv3-user-isolated' };
const BUNDLE_FILES = { MAIN: 'scriptlets/main-bundle.js', ISOLATED: 'scriptlets/isolated-bundle.js' };

const toPlain = v => {
    if ( !v ) { return []; }
    if ( v instanceof Map ) { return Array.from(v.entries()); }
    if ( v instanceof Set ) { return Array.from(v); }
    return v;
};

let catalogPromise = null;
function loadCatalog() {
    if ( catalogPromise === null ) {
        catalogPromise = fetch(chrome.runtime.getURL('scriptlets/catalog.json'))
            .then(r => r.json())
            .catch(( ) => ({}));
    }
    return catalogPromise;
}

function randomSecret() {
    const a = new Uint8Array(16);
    crypto.getRandomValues(a);
    return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
}

// Compile user filter text into cosmetic and scriptlet tables.
export async function compileUserFilters(text, { trusted = false } = {}) {
    const secret = randomSecret();
    // uBO trusts user filters only when userFiltersTrusted is on; ubo-core
    // accepts trust solely through this directive.
    const body = trusted ? `!#trusted on ${secret}\n${text}\n!#trusted off ${secret}\n` : text;
    const res = await dnrRulesetFromRawLists([ { name: 'user-filters', text: body } ], { env: ENV, secret });

    // Specific cosmetic filters: host -> values, same shape as the build shards.
    const cosmetic = {};
    let cosmeticCount = 0;
    for ( const entry of toPlain(res.specificCosmetic) ) {
        if ( Array.isArray(entry) === false ) { continue; }
        const [ payload, details ] = entry;
        let value = parseSpecific(payload);
        if ( value === undefined || Array.isArray(details?.matches) === false ) { continue; }
        const excludes = Array.isArray(details.excludeMatches) ? Array.from(new Set(details.excludeMatches)) : [];
        if ( excludes.length !== 0 ) { value = { v: value, x: excludes }; }
        for ( const host of new Set(details.matches) ) {
            (cosmetic[host] = cosmetic[host] || []).push(value);
        }
        cosmeticCount += 1;
    }

    // Generic cosmetic filters (`##.sel`), lowly and highly alike.
    const generic = [];
    for ( const [ , selectors ] of toPlain(res.genericCosmetic) ) {
        for ( const s of (selectors ?? []) ) { if ( typeof s === 'string' ) { generic.push(s); } }
    }
    for ( const s of toPlain(res.genericHighCosmetic) ) {
        if ( typeof s === 'string' ) { generic.push(s); }
    }

    // Scriptlets: host -> calls, per world, canonical names from the catalog.
    const catalog = await loadCatalog();
    const scriptlets = { MAIN: {}, ISOLATED: {} };
    const unsupported = [];
    const refused = [];
    let scriptletCount = 0;
    for ( const entry of toPlain(res.scriptlet) ) {
        const details = Array.isArray(entry) ? entry[1] : undefined;
        const args = details?.args;
        if ( Array.isArray(args) === false || args.length === 0 ) { continue; }
        const raw = String(args[0]);
        const token = raw.endsWith('.js') ? raw : `${raw}.js`;
        const known = catalog[token];
        if ( known === undefined ) { unsupported.push(raw); continue; }
        if ( known.trust && details.trustedSource !== true ) { refused.push(known.name); continue; }
        const call = [ known.name, ...args.slice(1) ];
        const excludes = Array.isArray(details.excludeMatches) ? details.excludeMatches : [];
        const item = excludes.length !== 0 ? { c: call, x: excludes } : call;
        for ( const host of new Set(details.matches ?? []) ) {
            (scriptlets[known.world][host] = scriptlets[known.world][host] || []).push(item);
        }
        scriptletCount += 1;
    }

    // ubo-core's DNR compiler discards `#@#` exceptions; user exception filters
    // are therefore not applied at runtime. Counted so the status says so.
    const exceptionLines = text.split('\n').filter(l => l.includes('#@#')).length;

    return {
        cosmetic, generic, scriptlets,
        counts: { cosmetic: cosmeticCount, generic: generic.length, scriptlets: scriptletCount },
        unsupported, refused, exceptionLines,
    };
}

// In-page code for one world: resolve this page's calls and hand them to the
// scriptlet bundle loaded just before it (same hostname rules as the packaged
// lookup: ladder, "*", entity "name.*", regex "/.../").
function userScriptCode(world, table) {
    const key = `__ubmv3_${world.toLowerCase()}`;
    return `(() => {
"use strict";
const api = globalThis[${JSON.stringify(key)}];
if ( api === undefined ) { return; }
const hn = location.hostname;
if ( hn === '' ) { return; }
const T = ${JSON.stringify(table)};
const calls = [];
const add = h => { const c = T[h]; if ( c !== undefined ) { calls.push(...c); } };
const ladder = [ hn ];
for ( let pos = hn.indexOf('.'); pos !== -1; pos = hn.indexOf('.', pos + 1) ) { ladder.push(hn.slice(pos + 1)); }
for ( const h of ladder ) { add(h); }
add('*');
for ( const h of ladder ) {
    let s = h;
    for ( let pos = s.lastIndexOf('.'); pos !== -1; pos = s.lastIndexOf('.') ) { s = s.slice(0, pos); add(s + '.*'); }
}
for ( const k of Object.keys(T) ) {
    if ( k.length > 2 && k.startsWith('/') && k.endsWith('/') ) {
        try { if ( new RegExp(k.slice(1, -1)).test(hn) ) { add(k); } } catch { }
    }
}
if ( calls.length !== 0 ) { api.apply(calls); }
})();`;
}

export async function userScriptsAvailable() {
    try {
        await chrome.userScripts.getScripts();
        return true;
    } catch {
        return false;
    }
}

// Converge chrome.userScripts on the compiled scriptlet tables.
async function registerUserScriptlets(scriptlets, excludeMatches) {
    const wanted = [];
    for ( const world of [ 'MAIN', 'ISOLATED' ] ) {
        const table = scriptlets[world];
        if ( Object.keys(table).length === 0 ) { continue; }
        wanted.push({
            id: USER_SCRIPT_IDS[world],
            matches: [ 'http://*/*', 'https://*/*' ],
            excludeMatches,
            allFrames: true,
            runAt: 'document_start',
            // MAIN-world scriptlets patch page globals; ISOLATED ones only need
            // the DOM, which the user-script world has.
            world: world === 'MAIN' ? 'MAIN' : 'USER_SCRIPT',
            js: [ { file: BUNDLE_FILES[world] }, { code: userScriptCode(world, table) } ],
        });
    }
    const existing = await chrome.userScripts.getScripts();
    const ours = new Set(Object.values(USER_SCRIPT_IDS));
    const stale = existing.map(s => s.id).filter(id => ours.has(id));
    if ( stale.length !== 0 ) {
        await chrome.userScripts.unregister({ ids: stale });
    }
    if ( wanted.length !== 0 ) {
        await chrome.userScripts.register(wanted);
    }
    return wanted.map(w => w.id);
}

// Compile, store and register. `excludeMatches` are the whitelist patterns.
export async function applyUserFilters(config, excludeMatches) {
    const text = String(config.userFilters ?? '');
    const trusted = config.userSettings?.userFiltersTrusted === true;
    const compiled = await compileUserFilters(text, { trusted });

    await chrome.storage.local.set({
        [USER_COSMETIC_KEY]: { byHost: compiled.cosmetic, generic: compiled.generic },
    });

    const hasScriptlets = compiled.counts.scriptlets !== 0;
    let userScripts;
    let registered = [];
    let error = null;
    if ( await userScriptsAvailable() ) {
        try {
            registered = await registerUserScriptlets(compiled.scriptlets, excludeMatches);
            userScripts = 'enabled';
        } catch ( reason ) {
            userScripts = 'error';
            error = reason.message;
        }
    } else {
        userScripts = 'unavailable';
    }

    const status = {
        at: Date.now(),
        counts: compiled.counts,
        userScripts,
        registered,
        // Scriptlet filters exist but cannot run until the user enables
        // "Allow user scripts" for this extension.
        scriptletsBlocked: hasScriptlets && userScripts !== 'enabled',
        unsupportedScriptlets: compiled.unsupported,
        refusedUntrusted: compiled.refused,
        exceptionLinesNotApplied: compiled.exceptionLines,
        error,
    };
    await chrome.storage.local.set({ [USER_STATUS_KEY]: status });
    return status;
}
