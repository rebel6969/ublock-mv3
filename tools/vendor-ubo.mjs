// Fetch the uBlock Origin sources this project builds on.
//
// Two things are vendored rather than reimplemented:
//   js/resources/*            the scriptlet library (~100 scriptlets)
//   web_accessible_resources/ the redirectable resources (nofab, noeval, ...)
//
// Reimplementing scriptlets is where homegrown blockers quietly break real
// sites, so uBO's own implementations are used. They are fetched at a pinned
// ref rather than committed, so the upstream version in use is always explicit
// and updating it is a one-line change.
//
// uBlock Origin is GPL-3.0-or-later, Copyright (C) Raymond Hill. This project is
// therefore GPL-3.0-or-later as well.
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from './lib/backup.mjs';

// Pin to a tag, not a branch: a moving branch would make builds irreproducible.
const UBO_REF = process.env.UBO_REF ?? '1.75.0';
const REPO = 'gorhill/uBlock';

const API = `https://api.github.com/repos/${REPO}/contents`;
const RAW = `https://raw.githubusercontent.com/${REPO}/${UBO_REF}`;

// Modules under js/resources/ that import from outside that directory.
const EXTRA_JS = [ 'arglist-parser.js', 'jsonpath.js', 'urlskip.js' ];

const headers = { 'User-Agent': 'ublock-mv3-build' };
if ( process.env.GITHUB_TOKEN ) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
}

async function listDir(path) {
    const res = await fetch(`${API}/${path}?ref=${UBO_REF}`, { headers });
    if ( res.ok === false ) {
        throw new Error(`GitHub API ${res.status} listing ${path}` +
            (res.status === 403 ? ' (rate limited: set GITHUB_TOKEN)' : ''));
    }
    return res.json();
}

async function fetchFile(path) {
    const res = await fetch(`${RAW}/${path}`, { headers });
    if ( res.ok === false ) { throw new Error(`HTTP ${res.status} for ${path}`); }
    return res.text();
}

async function fetchInto(paths, outDir, label) {
    mkdirSync(outDir, { recursive: true });
    let bytes = 0;
    for ( const p of paths ) {
        const text = await fetchFile(p);
        writeFileSync(resolve(outDir, p.split('/').pop()), text);
        bytes += text.length;
    }
    console.log(`  ${label}: ${paths.length} files, ${(bytes / 1024).toFixed(0)} KiB`);
    return paths.length;
}

async function main() {
    console.log(`vendoring uBlock Origin @ ${UBO_REF}`);

    const vendor = resolve(ROOT, 'vendor');
    if ( existsSync(vendor) ) { rmSync(vendor, { recursive: true, force: true }); }

    const resources = (await listDir('src/js/resources'))
        .filter(e => e.type === 'file' && e.name.endsWith('.js'))
        .map(e => `src/js/resources/${e.name}`);
    await fetchInto(resources, resolve(vendor, 'ubo-resources'), 'scriptlet modules');

    await fetchInto(
        EXTRA_JS.map(n => `src/js/${n}`),
        resolve(vendor),
        'shared modules'
    );

    const war = (await listDir('src/web_accessible_resources'))
        .filter(e => e.type === 'file' && e.name.endsWith('.js'))
        .map(e => `src/web_accessible_resources/${e.name}`);
    await fetchInto(war, resolve(vendor, 'ubo-war'), 'redirect resources');

    // Icons. Fetched rather than read from a sibling uBlock0.chromium folder,
    // which only exists on the machine this project was first built on and made
    // CI fail with "missing icons".
    const iconDir = resolve(vendor, 'ubo-icons');
    mkdirSync(iconDir, { recursive: true });
    let iconBytes = 0;
    for ( const name of [ 'icon_16.png', 'icon_32.png', 'icon_64.png', 'icon_128.png' ] ) {
        const res = await fetch(`${RAW}/src/img/${name}`, { headers });
        if ( res.ok === false ) { throw new Error(`HTTP ${res.status} for icon ${name}`); }
        const buf = Buffer.from(await res.arrayBuffer());
        writeFileSync(resolve(iconDir, name), buf);
        iconBytes += buf.length;
    }
    console.log(`  icons: 4 files, ${(iconBytes / 1024).toFixed(0)} KiB`);

    const license = await fetchFile('LICENSE.txt');
    writeFileSync(resolve(vendor, 'ubo-resources', 'LICENSE.txt'), license);
    writeFileSync(resolve(vendor, 'UBO-VERSION.txt'),
        `uBlock Origin ${UBO_REF}\nhttps://github.com/${REPO}\nGPL-3.0-or-later\n`);

    console.log(`\nvendored into ${vendor}`);
}

main().catch(err => {
    console.error('VENDOR FAILED:', err.message);
    console.error('\nIf this is a rate limit, set GITHUB_TOKEN, or copy the files');
    console.error('manually from a local uBlock Origin checkout.');
    process.exitCode = 1;
});
