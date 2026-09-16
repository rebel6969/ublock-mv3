// Pack the built extension into a signed CRX3, plus the update manifest Chrome
// needs to auto-update it.
//
// WHAT A CRX IS AND IS NOT GOOD FOR ON CURRENT CHROME
//
// Chrome will not let a user install a CRX by dragging it onto
// chrome://extensions -- extensions outside the Web Store are refused, the same
// tightening that made --load-extension stop working. So the CRX is NOT the
// easy install path; the zip plus "Load unpacked" is.
//
// It is still worth shipping, because it is the only route to AUTO-UPDATES
// without the Web Store. With an ExtensionSettings policy pointing at the
// update manifest, Chrome installs the CRX and then updates it on its own
// whenever a new release is published. See README for the policy snippet.
//
// The extension ID is derived from the signing key, so the key must be stable
// across releases or every release installs as a different extension. It is
// never committed: supply it as CRX_PRIVATE_KEY (PEM) or key.pem.
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, generateKeyPairSync, createPublicKey } from 'node:crypto';
import crx3 from 'crx3';
import { ROOT } from './lib/backup.mjs';

const DIST = resolve(ROOT, 'extension');
const OUT_CRX = resolve(ROOT, 'ublock-mv3.crx');
const OUT_XML = resolve(ROOT, 'updates.xml');
const KEY_PATH = resolve(ROOT, 'key.pem');

// Where a policy-installed Chrome will look for new versions.
const UPDATE_URL = process.env.CRX_UPDATE_URL
    ?? 'https://github.com/rebel6969/ublock-mv3/releases/latest/download/updates.xml';
const CRX_URL = process.env.CRX_DOWNLOAD_URL
    ?? 'https://github.com/rebel6969/ublock-mv3/releases/latest/download/ublock-mv3.crx';

// Chrome derives the extension ID from the SHA-256 of the DER public key:
// first 16 bytes, each nibble mapped 0-f -> a-p.
function extensionIdFromKey(privatePem) {
    const pub = createPublicKey(privatePem);
    const der = pub.export({ type: 'spki', format: 'der' });
    const hash = createHash('sha256').update(der).digest();
    let id = '';
    for ( let i = 0; i < 16; i++ ) {
        const byte = hash[i];
        id += String.fromCharCode(97 + (byte >> 4));
        id += String.fromCharCode(97 + (byte & 0x0f));
    }
    return id;
}

function loadOrCreateKey() {
    const fromEnv = process.env.CRX_PRIVATE_KEY;
    if ( fromEnv ) {
        writeFileSync(KEY_PATH, fromEnv.includes('\\n') ? fromEnv.replace(/\\n/g, '\n') : fromEnv);
        return { pem: readFileSync(KEY_PATH, 'utf-8'), source: 'CRX_PRIVATE_KEY', generated: false };
    }
    if ( existsSync(KEY_PATH) ) {
        return { pem: readFileSync(KEY_PATH, 'utf-8'), source: 'key.pem', generated: false };
    }
    // Generating a key here is a convenience for a first local build. A NEW key
    // means a NEW extension id, which breaks updates for anyone already running
    // a build signed with the old one -- so this is called out loudly.
    const { privateKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    writeFileSync(KEY_PATH, privateKey);
    return { pem: privateKey, source: 'generated', generated: true };
}

function updateManifest(id, version) {
    return `<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='${id}'>
    <updatecheck codebase='${CRX_URL}' version='${version}' />
  </app>
</gupdate>
`;
}

async function main() {
    if ( existsSync(resolve(DIST, 'manifest.json')) === false ) {
        throw new Error('extension/ not built -- run npm run build:all first');
    }
    const manifest = JSON.parse(readFileSync(resolve(DIST, 'manifest.json'), 'utf-8'));

    const key = loadOrCreateKey();
    const id = extensionIdFromKey(key.pem);

    // Give the packaged copy an update_url so it is self-describing: Chrome can
    // then find new versions on its own once installed.
    //
    // This is injected ONLY into the CRX, never the shipped extension/ folder.
    // The zip is what people load unpacked, and an unpacked extension never
    // auto-updates anyway -- so a custom update_url there would be inert at
    // best. Keeping it out means the two artifacts do not diverge in behaviour.
    const manifestPath = resolve(DIST, 'manifest.json');
    const original = readFileSync(manifestPath, 'utf-8');
    let restored = false;
    const restore = () => {
        if ( restored ) { return; }
        writeFileSync(manifestPath, original);
        restored = true;
    };
    process.on('exit', restore);
    writeFileSync(manifestPath, JSON.stringify(
        { ...manifest, update_url: UPDATE_URL }, null, 2
    ));

    console.log('PACK CRX3');
    console.log('='.repeat(64));
    console.log(`  signing key: ${key.source}`);
    console.log(`  extension id: ${id}`);
    console.log(`  version: ${manifest.version}`);

    try {
        await crx3([ manifestPath ], { keyPath: KEY_PATH, crxPath: OUT_CRX });
    } finally {
        // The extension/ folder must be left exactly as the build produced it,
        // whether packing succeeded or not.
        restore();
    }

    writeFileSync(OUT_XML, updateManifest(id, manifest.version));

    console.log(`\n  ${OUT_CRX} (${(statSync(OUT_CRX).size / 1048576).toFixed(2)} MiB)`);
    console.log(`  ${OUT_XML}`);

    if ( key.generated ) {
        console.log();
        console.log('  ' + '!'.repeat(62));
        console.log('  !! A NEW signing key was generated at key.pem.');
        console.log('  !! The extension id is derived from it, so releases signed with a');
        console.log('  !! different key install as a DIFFERENT extension and will not');
        console.log('  !! update each other. Keep this key: back it up, and add it to the');
        console.log('  !! repository as the CRX_PRIVATE_KEY secret so CI signs every');
        console.log('  !! release identically. key.pem is git-ignored.');
        console.log('  ' + '!'.repeat(62));
    }

    console.log(`\n  Note: Chrome refuses CRX files dragged onto chrome://extensions.`);
    console.log(`  This CRX is for policy-based install + auto-update; the zip plus`);
    console.log(`  "Load unpacked" remains the ordinary install route.`);
}

main().catch(err => {
    console.error('PACK CRX FAILED:', err.message);
    process.exitCode = 1;
});
