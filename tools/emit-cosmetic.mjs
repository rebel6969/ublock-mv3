// Turn the cosmetic/scriptlet corpus into a shape a service worker can actually
// use, and emit it into extension/data/cosmetic/.
//
// WHY SHARDING: the flat corpus is ~29 MB of JSON (175,848 specific rules,
// 44,540 generic, 18,303 scriptlets). An MV3 service worker is evicted
// aggressively and re-parsing 29 MB on every wake would dominate page load; a
// content script cannot hold it at all. So the corpus is split by hostname into
// fixed shards. A page load touches exactly one shard, which stays cached in the
// worker until eviction.
//
// Layout:
//   data/cosmetic/index.json        - tiny: shard count + generic payload refs
//   data/cosmetic/specific-NN.json  - { "<hostname>": [selector, ...] }
//   build/scriptlet-data/scriptlet-NN.json - build input for emit-scriptlets.mjs
//                                     (not shipped: scriptlets resolve in the page)
//   data/cosmetic/generic-lookup.js - generic cosmetic data for the in-page
//                                     surveyor (src/generic.js)
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { collectExceptions, relevantExceptionHosts } from './lib/exceptions.mjs';
import { ENV as ENV_TOKENS } from './lib/env.mjs';
import { resolve } from 'node:path';
import { ROOT } from './lib/backup.mjs';
import { DNR_OPTIONS } from './lib/env.mjs';
import { SHARD_COUNT, shardOf } from './lib/shardcfg.mjs';
import { dnrRulesetFromRawLists } from '@gorhill/ubo-core/js/static-dnr-filtering.js';
import { parseSpecific } from '../src/lib/cosmetic-parse.js';

const BUILD = resolve(ROOT, 'build');
const DIST = resolve(ROOT, 'extension');
const OUT = resolve(DIST, 'data', 'cosmetic');
// Scriptlet data is only an input to tools/emit-scriptlets.mjs, which compiles it
// into the in-page lookup; nothing at runtime reads it, so it is not shipped.
const SCRIPTLET_DATA = resolve(BUILD, 'scriptlet-data');

// Sharding comes from tools/lib/shardcfg.mjs so build and runtime cannot drift.

const toPlain = v => {
    if ( !v ) { return []; }
    if ( v instanceof Map ) { return Array.from(v.entries()); }
    if ( v instanceof Set ) { return Array.from(v); }
    return v;
};

// A specific entry is [ payload, details ] where details.matches lists hostnames
// and details.excludeMatches (when present) lists exceptions.
function indexByHostname(entries, transform) {
    const byHost = new Map();
    let placed = 0, skipped = 0;
    for ( const entry of entries ) {
        if ( Array.isArray(entry) === false || entry.length < 2 ) { skipped += 1; continue; }
        const [ payload, details ] = entry;
        const matches = details && Array.isArray(details.matches) ? details.matches : null;
        if ( matches === null || matches.length === 0 ) { skipped += 1; continue; }
        let value = transform(payload, details);
        if ( value === undefined ) { skipped += 1; continue; }
        // Exceptions (`#@#`) arrive as excludeMatches. Dropping them makes a
        // filter run on sites it was explicitly switched off for, so they are
        // carried as { v, x } and evaluated against the page at runtime.
        const excludes = Array.isArray(details.excludeMatches)
            ? Array.from(new Set(details.excludeMatches))
            : [];
        const trusted = details.trustedSource === true;
        if ( excludes.length !== 0 || trusted ) {
            value = { v: value };
            if ( excludes.length !== 0 ) { value.x = excludes; }
            // Scriptlet requiring trust may only run if its list was trusted.
            if ( trusted ) { value.t = 1; }
        }
        const key = JSON.stringify(value);
        // `matches` can list the same host twice; without this, one filter was
        // stored -- and a scriptlet executed -- once per duplicate.
        for ( const host of new Set(matches) ) {
            let entry = byHost.get(host);
            if ( entry === undefined ) { byHost.set(host, entry = new Map()); }
            if ( entry.has(key) ) { continue; }
            entry.set(key, value);
            placed += 1;
        }
    }
    for ( const [ host, entry ] of byHost ) { byHost.set(host, Array.from(entry.values())); }
    return { byHost, placed, skipped };
}

// Specific cosmetic payload parsing lives in src/lib/cosmetic-parse.js, shared
// with the service worker's runtime compilation of user filters.

function parseScriptlet(payload, details) {
    if ( details && Array.isArray(details.args) ) { return details.args; }
    if ( typeof payload !== 'string' ) { return undefined; }
    try {
        const a = JSON.parse(payload);
        return Array.isArray(a) ? a : undefined;
    } catch {
        return undefined;
    }
}

function writeShards(prefix, byHost, dir = OUT) {
    const shards = Array.from({ length: SHARD_COUNT }, () => ({}));
    for ( const [ host, values ] of byHost ) {
        shards[shardOf(host)][host] = values;
    }
    let bytes = 0, biggest = 0;
    for ( let i = 0; i < SHARD_COUNT; i++ ) {
        const name = `${prefix}-${String(i).padStart(2, '0')}.json`;
        const json = JSON.stringify(shards[i]);
        writeFileSync(resolve(dir, name), json);
        bytes += json.length;
        if ( json.length > biggest ) { biggest = json.length; }
    }
    return { bytes, biggest, hosts: byHost.size };
}

async function main() {
    const fetched = JSON.parse(readFileSync(resolve(BUILD, 'lists.fetched.json'), 'utf-8'));

    // Trust, exactly as uBlock Origin grants it: lists whose asset key starts
    // with "ublock-" (µb.trustedListPrefixes). (User filters, trusted only when
    // userFiltersTrusted is on, are compiled at runtime by the service worker.)
    // Only trusted lists may use scriptlets that require trust
    // (trusted-replace-*, trusted-set-cookie, ...).
    //
    // ubo-core 0.1.30 accepts trust solely through a `!#trusted on <secret>`
    // directive, so trusted lists are prefixed with one. They are compiled first
    // because scriptlet details are keyed by argument list and the trust flag is
    // set only when an entry is first created.
    const secret = randomBytes(16).toString('hex');
    const isTrusted = name => name.startsWith('ublock-');
    const lists = fetched.map(f => ({ name: f.token, text: readFileSync(f.path, 'utf-8') }));
    // User filters are NOT compiled here. The dashboard's "My filters" is their
    // source of truth, and the service worker compiles them at runtime (cosmetic
    // filters per page, scriptlets via chrome.userScripts). Baking them in meant
    // an edit or deletion there never reached cosmetic or scriptlet filtering.
    for ( const l of lists ) {
        if ( isTrusted(l.name) ) { l.text = `!#trusted on ${secret}\n${l.text}\n!#trusted off ${secret}\n`; }
    }
    lists.sort((a, b) => Number(isTrusted(b.name)) - Number(isTrusted(a.name)));
    console.log(`trusted lists: ${lists.filter(l => isTrusted(l.name)).map(l => l.name).join(', ')}`);

    console.log(`compiling cosmetic corpus from ${lists.length} lists...`);
    const res = await dnrRulesetFromRawLists(lists, { ...DNR_OPTIONS, secret });

    if ( existsSync(OUT) ) { rmSync(OUT, { recursive: true, force: true }); }
    mkdirSync(OUT, { recursive: true });
    if ( existsSync(SCRIPTLET_DATA) ) { rmSync(SCRIPTLET_DATA, { recursive: true, force: true }); }
    mkdirSync(SCRIPTLET_DATA, { recursive: true });

    // --- exceptions (#@#) ------------------------------------------------------
    // ubo-core drops these; apply them the way uBlock Origin does.
    const exc = collectExceptions(lists, ENV_TOKENS);
    await import(pathToFileURL(resolve(ROOT, 'vendor/ubo-resources/scriptlets.js')).href);
    const { registeredScriptlets } = await import(
        pathToFileURL(resolve(ROOT, 'vendor/ubo-resources/base.js')).href
    );
    const aliasOf = new Map();
    for ( const d of registeredScriptlets ) {
        aliasOf.set(d.name, d.name);
        for ( const a of (d.aliases ?? []) ) { aliasOf.set(a, d.name); }
    }
    const canonKey = args => {
        const t = String(args[0]);
        const j = t.endsWith('.js') ? t : `${t}.js`;
        return JSON.stringify([ aliasOf.get(j) ?? j, ...args.slice(1) ]);
    };
    const scriptletExc = new Map();   // canonical key -> { hosts:Set, generic }
    for ( const [ raw, e ] of exc.scriptlet ) {
        const k = raw === '' ? '' : canonKey(JSON.parse(raw));
        const into = scriptletExc.get(k) ?? { hosts: new Set(), generic: false };
        for ( const h of e.hosts ) { into.hosts.add(h); }
        into.generic ||= e.generic;
        scriptletExc.set(k, into);
    }
    const disableAll = scriptletExc.get('') ?? { hosts: new Set(), generic: false };

    let scrCancelled = 0, scrExcluded = 0, cosExcluded = 0;
    for ( const entry of toPlain(res.scriptlet) ) {
        const details = entry[1];
        if ( !details || Array.isArray(details.args) === false ) { continue; }
        const e = scriptletExc.get(canonKey(details.args));
        if ( e?.generic || disableAll.generic ) { details.matches = []; scrCancelled += 1; continue; }
        // "Disable all scriptlets" hosts are NOT copied into each filter: they
        // are written once to scriptlet-disable-all.json and checked per page.
        const rel = relevantExceptionHosts([ ...(e?.hosts ?? []) ], details.matches ?? []);
        if ( rel.length ) {
            details.excludeMatches = [ ...(details.excludeMatches ?? []), ...rel ];
            scrExcluded += 1;
        }
    }
    for ( const entry of toPlain(res.specificCosmetic) ) {
        const [ compiled, details ] = entry;
        const hosts = exc.cosmetic.get(compiled);
        if ( !hosts || !details ) { continue; }
        const rel = relevantExceptionHosts(hosts, details.matches ?? []);
        if ( rel.length ) {
            details.excludeMatches = [ ...(details.excludeMatches ?? []), ...rel ];
            cosExcluded += 1;
        }
    }
    // Hosts where uBO's `site#@#+js()` switches off every scriptlet.
    const disableAllHosts = Array.from(disableAll.hosts).sort();
    writeFileSync(resolve(SCRIPTLET_DATA, 'scriptlet-disable-all.json'), JSON.stringify(disableAllHosts));
    // Sites where uBO lists switch cosmetic filtering off ($generichide etc.).
    const hide = {
        generic: Array.from(exc.hideGeneric).sort(),
        specific: Array.from(exc.hideSpecific).sort(),
    };
    writeFileSync(resolve(OUT, 'hide-exceptions.json'), JSON.stringify(hide));
    console.log(`  $generichide/$elemhide hosts: ${hide.generic.length}, $specifichide/$elemhide hosts: ${hide.specific.length}`);
    console.log(`\nexceptions: ${exc.scriptlet.size} scriptlet, ${exc.cosmetic.size} cosmetic`);
    console.log(`  hosts with ALL scriptlets disabled: ${disableAllHosts.length} (${disableAllHosts.join(', ')})`);
    console.log(`  scriptlet filters cancelled everywhere: ${scrCancelled}, narrowed by site: ${scrExcluded}`);
    console.log(`  specific cosmetic filters narrowed by site: ${cosExcluded}`);

    // --- specific cosmetic ---------------------------------------------------
    const specificEntries = toPlain(res.specificCosmetic);
    const spec = indexByHostname(specificEntries, parseSpecific);
    const specStats = writeShards('specific', spec.byHost);
    console.log(`\nspecific: ${specificEntries.length.toLocaleString()} entries -> ` +
        `${spec.placed.toLocaleString()} placed across ${specStats.hosts.toLocaleString()} hostnames ` +
        `(${spec.skipped.toLocaleString()} unusable)`);
    console.log(`  ${SHARD_COUNT} shards, ${(specStats.bytes / 1048576).toFixed(2)} MiB total, ` +
        `largest ${(specStats.biggest / 1024).toFixed(0)} KiB`);

    // --- scriptlets ----------------------------------------------------------
    const scriptletEntries = toPlain(res.scriptlet);
    const scr = indexByHostname(scriptletEntries, parseScriptlet);
    const scrStats = writeShards('scriptlet', scr.byHost, SCRIPTLET_DATA);
    console.log(`\nscriptlet: ${scriptletEntries.length.toLocaleString()} entries -> ` +
        `${scr.placed.toLocaleString()} placed across ${scrStats.hosts.toLocaleString()} hostnames ` +
        `(${scr.skipped.toLocaleString()} unusable)`);
    console.log(`  ${SHARD_COUNT} shards, ${(scrStats.bytes / 1048576).toFixed(2)} MiB total, ` +
        `largest ${(scrStats.biggest / 1024).toFixed(0)} KiB`);

    // --- generic cosmetic ----------------------------------------------------
    // uBlock Origin splits generic hiding filters in two, and so does this build:
    //
    //  lowly generic  -- the selector has a class or id key (".ad-banner > div"
    //    keys on ".ad-banner"). ubo-core buckets them by uBO's hashFromStr of
    //    that key. They are applied only when the key occurs in the page: a
    //    surveyor (src/generic.js) hashes the page's class/id tokens and injects
    //    the matching selectors. Same approach as uBO MV2's DOM surveyor and uBO
    //    Lite's css-generic.js.
    //  highly generic -- no usable key ("div[class^='ad']"). Shipped as one
    //    stylesheet for every page.
    //
    // The previous build put every lowly generic selector (~44k, 0.82 MiB) in a
    // stylesheet injected into every frame, and never applied highly generic
    // ones. Measured on 8 real sites that stylesheet cost ~28 MB of renderer
    // memory, and every frame paid style matching against all of it.
    //
    // Exceptions: a global `#@#sel` removes the selector outright. A site one
    // (`example.com#@#sel`) is carried with the selector as a list of hostnames
    // and evaluated in the page (lowly), or moves the selector to the worker's
    // per-page path (highly generic, which cannot be conditional in a stylesheet).
    const globalGenericExc = new Set(toPlain(res.genericCosmeticExceptions));

    const GENERIC_BUCKET_BITS = 11;
    // U+0001 separates a selector from its exception-list index.
    const GENERIC_EXC_SEP = String.fromCharCode(1);
    const GENERIC_BUCKETS = 1 << GENERIC_BUCKET_BITS;
    const buckets = Array.from({ length: GENERIC_BUCKETS }, ( ) => []);
    const exceptionLists = [];
    const exceptionIndex = new Map();
    const exceptionRef = hosts => {
        const s = JSON.stringify(Array.from(hosts).sort());
        let i = exceptionIndex.get(s);
        if ( i === undefined ) { i = exceptionLists.length; exceptionLists.push(s); exceptionIndex.set(s, i); }
        return i;
    };
    let lowlyCount = 0, lowlyExcepted = 0, lowlyDroppedGlobal = 0;
    for ( const [ hash, selectors ] of toPlain(res.genericCosmetic) ) {
        if ( Number.isInteger(hash) === false || Array.isArray(selectors) === false ) {
            throw new Error(`unexpected genericCosmetic entry shape: ${JSON.stringify([ hash, selectors ]).slice(0, 200)}`);
        }
        const kept = [];
        for ( const sel of new Set(selectors) ) {
            if ( typeof sel !== 'string' || sel === '' ) { continue; }
            if ( globalGenericExc.has(sel) ) { lowlyDroppedGlobal += 1; continue; }
            // The in-page format uses newline, tab and GENERIC_EXC_SEP as delimiters.
            if ( /[\n\t]/.test(sel) || sel.includes(GENERIC_EXC_SEP) ) { throw new Error(`generic selector contains a delimiter: ${JSON.stringify(sel)}`); }
            const siteExc = exc.cosmetic.get(sel);
            if ( siteExc !== undefined && siteExc.size !== 0 ) {
                kept.push(`${sel}${GENERIC_EXC_SEP}${exceptionRef(siteExc)}`);
                lowlyExcepted += 1;
            } else {
                kept.push(sel);
            }
            lowlyCount += 1;
        }
        if ( kept.length === 0 ) { continue; }
        buckets[hash & (GENERIC_BUCKETS - 1)].push(`\n${hash.toString(36)}\t${kept.join('\t')}`);
    }

    const highSelectors = new Set();
    const genericExcepted = [];
    let highDroppedGlobal = 0;
    for ( const entry of toPlain(res.genericHighCosmetic) ) {
        const sel = Array.isArray(entry) ? entry[1] : entry;
        if ( typeof sel !== 'string' || sel === '' ) { continue; }
        if ( globalGenericExc.has(sel) ) { highDroppedGlobal += 1; continue; }
        const siteExc = exc.cosmetic.get(sel);
        if ( siteExc !== undefined && siteExc.size !== 0 ) {
            genericExcepted.push({ s: sel, x: Array.from(siteExc) });
            continue;
        }
        highSelectors.add(sel);
    }
    // One declaration block; `display:none!important` is what uBO applies.
    const highCss = highSelectors.size === 0
        ? ''
        : `${Array.from(highSelectors).join(',\n')}\n{display:none!important;}\n`;
    // One file for the page: lowly buckets, their site exceptions, the highly
    // generic stylesheet and the $generichide/$elemhide hostnames. The hostname
    // check happens in the page (src/generic.js) rather than as excludeMatches:
    // Chrome keeps every registered match pattern in every renderer process
    // (measured ~3 KB each), and in-page matching also covers the entity and
    // regex hostname forms that match patterns cannot express.
    const genericData = `// Generated by tools/emit-cosmetic.mjs -- do not edit.
// Generic cosmetic filtering data for src/generic.js.
//   B  ${GENERIC_BUCKETS} buckets of lowly generic selectors (${lowlyCount} total):
//      "\\n<hash base36>\\t<sel>\\t<sel>..."; "<sel>\\u0001<n>" is excepted on the
//      hostnames in JSON.parse(E[n])
//   H  highly generic stylesheet (${highSelectors.size} selectors)
//   G  hostnames where generic cosmetic filtering is off ($generichide/$elemhide)
self.__ubmv3_genericData = {
B: ${JSON.stringify(buckets.map(b => b.join('')))},
E: ${JSON.stringify(exceptionLists)},
H: ${JSON.stringify(highCss)},
G: ${JSON.stringify(hide.generic)},
};
`;
    writeFileSync(resolve(OUT, 'generic-lookup.js'), genericData);
    writeFileSync(resolve(OUT, 'generic-excepted.json'), JSON.stringify(genericExcepted));

    console.log(`\ngeneric (lowly): ${lowlyCount.toLocaleString()} selectors in ${GENERIC_BUCKETS} buckets -> ` +
        `generic-lookup.js (${(genericData.length / 1048576).toFixed(2)} MiB); ` +
        `${lowlyExcepted} carry site exceptions, ${lowlyDroppedGlobal} removed by global exceptions`);
    console.log(`generic (highly): ${highSelectors.size.toLocaleString()} selectors -> generic-lookup.js ` +
        `(${(highCss.length / 1024).toFixed(0)} KiB); ${genericExcepted.length} site-excepted -> worker, ` +
        `${highDroppedGlobal} removed by global exceptions`);

    // --- index ---------------------------------------------------------------
    writeFileSync(resolve(OUT, 'index.json'), JSON.stringify({
        shardCount: SHARD_COUNT,
        hash: 'fnv1a32',
        specificHosts: specStats.hosts,
        scriptletHosts: scrStats.hosts,
        genericLowlySelectors: lowlyCount,
        genericHighSelectors: highSelectors.size,
        genericSiteExceptedHigh: genericExcepted.length,
        generatedAt: new Date().toISOString(),
    }, null, 2));

    // Remove the monolithic file the first emit produced; it is superseded.
    const monolith = resolve(DIST, 'data', 'cosmetic.json');
    if ( existsSync(monolith) ) {
        const mb = (statSync(monolith).size / 1048576).toFixed(1);
        rmSync(monolith);
        console.log(`\nremoved superseded data/cosmetic.json (${mb} MiB)`);
    }
    console.log(`wrote extension/data/cosmetic/`);
}

main().catch(err => {
    console.error('EMIT COSMETIC FAILED:', err.message);
    console.error(err.stack);
    process.exitCode = 1;
});
