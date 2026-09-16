// Download every resolved filter list into build/lists/, with on-disk caching.
//
// Each list is tried against its mirrors in order. A list that fails every mirror
// is reported loudly and fails the build: silently building without a list the
// user selected would produce a blocker that is quietly weaker than expected.
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { ROOT } from './lib/backup.mjs';

const BUILD = resolve(ROOT, 'build');
const CACHE = resolve(BUILD, 'lists');
const MAX_AGE_MS = 12 * 60 * 60 * 1000; // re-download lists older than 12h
const CONCURRENCY = 8;
const TIMEOUT_MS = 45000;

function cachePathFor(token) {
    const safe = createHash('sha1').update(token).digest('hex').slice(0, 16);
    return resolve(CACHE, `${safe}.txt`);
}

function isFresh(path) {
    if ( existsSync(path) === false ) { return false; }
    return (Date.now() - statSync(path).mtimeMs) < MAX_AGE_MS;
}

async function fetchText(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const res = await fetch(url, { redirect: 'follow', signal: controller.signal });
        if ( res.ok === false ) { throw new Error(`HTTP ${res.status}`); }
        const text = await res.text();
        if ( text.length < 32 ) { throw new Error(`suspiciously short (${text.length} bytes)`); }
        return text;
    } finally {
        clearTimeout(timer);
    }
}

async function fetchOne(item) {
    const path = cachePathFor(item.token);
    if ( isFresh(path) ) {
        const text = readFileSync(path, 'utf-8');
        return { token: item.token, path, bytes: text.length, source: 'cache' };
    }
    const errors = [];
    for ( const url of item.urls ) {
        if ( /^https?:\/\//.test(url) === false ) { continue; }
        try {
            const text = await fetchText(url);
            mkdirSync(CACHE, { recursive: true });
            writeFileSync(path, text);
            return { token: item.token, path, bytes: text.length, source: url };
        } catch ( reason ) {
            errors.push(`${url} -> ${reason.message}`);
        }
    }
    // Every mirror failed. A stale cache copy is better than losing the list.
    if ( existsSync(path) ) {
        const text = readFileSync(path, 'utf-8');
        console.warn(`  ! ${item.token}: all mirrors failed, using stale cache`);
        return { token: item.token, path, bytes: text.length, source: 'stale-cache' };
    }
    return { token: item.token, failed: true, errors };
}

async function pool(items, worker, limit) {
    const results = new Array(items.length);
    let next = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        for (;;) {
            const i = next++;
            if ( i >= items.length ) { return; }
            results[i] = await worker(items[i]);
        }
    });
    await Promise.all(runners);
    return results;
}

async function main() {
    const manifestPath = resolve(BUILD, 'lists.resolved.json');
    if ( existsSync(manifestPath) === false ) {
        throw new Error('run "npm run resolve" first (build/lists.resolved.json missing)');
    }
    const { resolved } = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    console.log(`fetching ${resolved.length} lists (concurrency ${CONCURRENCY})...`);

    const results = await pool(resolved, fetchOne, CONCURRENCY);
    const ok = results.filter(r => r.failed !== true);
    const bad = results.filter(r => r.failed === true);

    const totalBytes = ok.reduce((n, r) => n + r.bytes, 0);
    const fromNet = ok.filter(r => r.source !== 'cache' && r.source !== 'stale-cache').length;
    console.log(`\nok: ${ok.length}  (downloaded ${fromNet}, cached ${ok.length - fromNet})`);
    console.log(`total: ${(totalBytes / 1048576).toFixed(2)} MiB of raw filter text`);

    if ( bad.length !== 0 ) {
        console.error(`\nFAILED: ${bad.length} list(s) could not be fetched:`);
        for ( const b of bad ) {
            console.error(`  ${b.token}`);
            for ( const e of b.errors ) { console.error(`      ${e}`); }
        }
        process.exitCode = 1;
        return;
    }

    writeFileSync(resolve(BUILD, 'lists.fetched.json'), JSON.stringify(ok, null, 2));
    console.log(`\nwrote ${resolve(BUILD, 'lists.fetched.json')}`);
}

main();
