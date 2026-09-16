// Resolve every filter list selected in the backup to a concrete download URL.
//
// Selections are uBO asset tokens ("easylist", "RUS-0") or bare URLs. Tokens are
// looked up in uBO's asset catalog. The local catalog shipped with the MV2 build
// is authoritative for what that build used, but it is not complete, so the live
// catalog is merged in as a fallback. Anything still unresolved is reported
// explicitly rather than silently dropped.
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, PARENT, readBackup, isURL } from './lib/backup.mjs';

const LOCAL_CATALOG = resolve(PARENT, 'uBlock0.chromium/assets/assets.json');
const REMOTE_CATALOGS = [
    'https://ublockorigin.github.io/uAssetsCDN/ublock/assets.json',
    'https://raw.githubusercontent.com/gorhill/uBlock/master/assets/assets.json',
];

async function fetchJSON(url) {
    const res = await fetch(url, { redirect: 'follow' });
    if ( res.ok === false ) {
        throw new Error(`HTTP ${res.status} for ${url}`);
    }
    return res.json();
}

async function loadCatalog() {
    const catalog = {};
    let localCount = 0;
    if ( existsSync(LOCAL_CATALOG) ) {
        const local = JSON.parse(readFileSync(LOCAL_CATALOG, 'utf-8'));
        Object.assign(catalog, local);
        localCount = Object.keys(local).length;
    }
    let remoteCount = 0;
    let remoteSource = 'none';
    for ( const url of REMOTE_CATALOGS ) {
        try {
            const remote = await fetchJSON(url);
            // Remote entries fill gaps but never override the local build's view.
            for ( const [ key, value ] of Object.entries(remote) ) {
                if ( catalog[key] === undefined ) { catalog[key] = value; }
            }
            remoteCount = Object.keys(remote).length;
            remoteSource = url;
            break;
        } catch ( reason ) {
            console.warn(`  ! catalog fetch failed: ${url} (${reason.message})`);
        }
    }
    console.log(`catalog: local=${localCount} remote=${remoteCount} (${remoteSource}) merged=${Object.keys(catalog).length}`);
    return catalog;
}

// Prefer CDN mirrors, then canonical content URLs. Local relative paths (entries
// without a scheme) are the bundled copies and are kept as a last resort.
function urlsFor(entry) {
    const out = [];
    const push = v => {
        if ( typeof v === 'string' ) { out.push(v); }
        else if ( Array.isArray(v) ) { out.push(...v.filter(x => typeof x === 'string')); }
    };
    push(entry.cdnURLs);
    push(entry.contentURL);
    const remote = out.filter(isURL);
    return remote.length !== 0 ? remote : out;
}

async function main() {
    const backup = readBackup();
    const catalog = await loadCatalog();
    const selections = backup.selectedFilterLists;

    const resolved = [];
    const unresolved = [];
    for ( const token of selections ) {
        if ( token === 'user-filters' ) {
            // Not a downloadable list; it comes from backup.userFilters directly.
            continue;
        }
        if ( isURL(token) ) {
            resolved.push({ token, kind: 'url', urls: [ token ] });
            continue;
        }
        const entry = catalog[token];
        if ( entry === undefined ) {
            unresolved.push({ token, why: 'not in catalog' });
            continue;
        }
        const urls = urlsFor(entry);
        if ( urls.length === 0 ) {
            unresolved.push({ token, why: 'catalog entry has no URL' });
            continue;
        }
        resolved.push({
            token,
            kind: entry.content === 'internal' ? 'internal' : 'filters',
            title: entry.title,
            lang: entry.lang,
            urls,
        });
    }

    console.log(`\nselections: ${selections.length} (incl. user-filters)`);
    console.log(`resolved:   ${resolved.length}`);
    console.log(`unresolved: ${unresolved.length}`);
    if ( unresolved.length !== 0 ) {
        console.log('\n--- UNRESOLVED (these would be silently lost; fix before building) ---');
        for ( const u of unresolved ) {
            console.log(`  ${u.token.padEnd(28)} ${u.why}`);
        }
    }

    const outDir = resolve(ROOT, 'build');
    mkdirSync(outDir, { recursive: true });
    const outPath = resolve(outDir, 'lists.resolved.json');
    writeFileSync(outPath, JSON.stringify({ resolved, unresolved }, null, 2));
    console.log(`\nwrote ${outPath}`);

    if ( unresolved.length !== 0 ) { process.exitCode = 1; }
}

main();
