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
//   data/cosmetic/scriptlet-NN.json - { "<hostname>": [[token, ...args], ...] }
//   data/cosmetic/generic.css       - selectors that apply to every page
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, readBackup } from './lib/backup.mjs';
import { DNR_OPTIONS } from './lib/env.mjs';
import { SHARD_COUNT, shardOf } from './lib/shardcfg.mjs';
import { dnrRulesetFromRawLists } from '@gorhill/ubo-core/js/static-dnr-filtering.js';

const BUILD = resolve(ROOT, 'build');
const DIST = resolve(ROOT, 'extension');
const OUT = resolve(DIST, 'data', 'cosmetic');

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
        const value = transform(payload, details);
        if ( value === undefined ) { skipped += 1; continue; }
        for ( const host of matches ) {
            let arr = byHost.get(host);
            if ( arr === undefined ) { byHost.set(host, arr = []); }
            arr.push(value);
            placed += 1;
        }
    }
    return { byHost, placed, skipped };
}

// Specific cosmetic payloads are either a bare CSS selector or a JSON blob
// describing a procedural filter ({selector, tasks, raw}).
function parseSpecific(payload) {
    if ( typeof payload !== 'string' ) { return undefined; }
    if ( payload.startsWith('{') === false ) {
        return payload; // plain CSS selector
    }
    try {
        const o = JSON.parse(payload);
        // Procedural filters (:has-text, :upward, ...) cannot be expressed as
        // plain CSS; keep them as structured data for the content script to run.
        return { p: o.selector, t: o.tasks ?? null, raw: o.raw ?? null };
    } catch {
        return undefined;
    }
}

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

function writeShards(prefix, byHost) {
    const shards = Array.from({ length: SHARD_COUNT }, () => ({}));
    for ( const [ host, values ] of byHost ) {
        shards[shardOf(host)][host] = values;
    }
    let bytes = 0, biggest = 0;
    for ( let i = 0; i < SHARD_COUNT; i++ ) {
        const name = `${prefix}-${String(i).padStart(2, '0')}.json`;
        const json = JSON.stringify(shards[i]);
        writeFileSync(resolve(OUT, name), json);
        bytes += json.length;
        if ( json.length > biggest ) { biggest = json.length; }
    }
    return { bytes, biggest, hosts: byHost.size };
}

async function main() {
    const backup = readBackup();
    const fetched = JSON.parse(readFileSync(resolve(BUILD, 'lists.fetched.json'), 'utf-8'));

    const lists = fetched.map(f => ({ name: f.token, text: readFileSync(f.path, 'utf-8') }));
    lists.push({ name: 'user-filters', text: backup.userFilters });

    console.log(`compiling cosmetic corpus from ${lists.length} lists...`);
    const res = await dnrRulesetFromRawLists(lists, { ...DNR_OPTIONS });

    if ( existsSync(OUT) ) { rmSync(OUT, { recursive: true, force: true }); }
    mkdirSync(OUT, { recursive: true });

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
    const scrStats = writeShards('scriptlet', scr.byHost);
    console.log(`\nscriptlet: ${scriptletEntries.length.toLocaleString()} entries -> ` +
        `${scr.placed.toLocaleString()} placed across ${scrStats.hosts.toLocaleString()} hostnames ` +
        `(${scr.skipped.toLocaleString()} unusable)`);
    console.log(`  ${SHARD_COUNT} shards, ${(scrStats.bytes / 1048576).toFixed(2)} MiB total, ` +
        `largest ${(scrStats.biggest / 1024).toFixed(0)} KiB`);

    // --- generic cosmetic ----------------------------------------------------
    // Generic filters apply to every page, so they ship as a single stylesheet
    // injected declaratively -- no lookup, no message round-trip.
    const genericSelectors = [];
    for ( const entry of toPlain(res.genericCosmetic) ) {
        const sels = Array.isArray(entry) ? entry[1] : null;
        if ( Array.isArray(sels) === false ) { continue; }
        for ( const s of sels ) {
            if ( typeof s === 'string' && s !== '' ) { genericSelectors.push(s); }
        }
    }
    const genericHighSelectors = [];
    for ( const entry of toPlain(res.genericHighCosmetic) ) {
        const s = Array.isArray(entry) ? entry[1] : entry;
        if ( typeof s === 'string' && s !== '' ) { genericHighSelectors.push(s); }
    }

    const uniqGeneric = Array.from(new Set(genericSelectors));
    // One declaration block; `display:none!important` is what uBO applies.
    const css = uniqGeneric.join(',\n') + '\n{display:none!important;}\n';
    writeFileSync(resolve(OUT, 'generic.css'), css);
    writeFileSync(resolve(OUT, 'generic-high.json'), JSON.stringify(Array.from(new Set(genericHighSelectors))));
    console.log(`\ngeneric: ${uniqGeneric.length.toLocaleString()} selectors -> generic.css ` +
        `(${(css.length / 1048576).toFixed(2)} MiB)`);
    console.log(`generic-high: ${new Set(genericHighSelectors).size.toLocaleString()} selectors`);

    // --- index ---------------------------------------------------------------
    writeFileSync(resolve(OUT, 'index.json'), JSON.stringify({
        shardCount: SHARD_COUNT,
        hash: 'fnv1a32',
        specificHosts: specStats.hosts,
        scriptletHosts: scrStats.hosts,
        genericSelectors: uniqGeneric.length,
        genericHighSelectors: new Set(genericHighSelectors).size,
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
