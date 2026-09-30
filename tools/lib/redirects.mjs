// uBO's redirect resources: the stand-ins that network `redirect=` and
// `redirect-rule=` filters serve in place of a blocked request (noop.js,
// google-ima.js, 1x1.gif, ...).
//
// ubo-core compiles such a filter into a DNR redirect only when it can map the
// filter's token to a packaged file (`extensionPaths`); otherwise it rejects it
// as "Unpatchable redirect filter" and the filter does nothing at all -- it
// neither blocks nor serves the stand-in. That was 2,842 filters. uBO Lite
// supplies the same map (platform/mv3/make-rulesets.js).
//
// The token table (every resource name and its aliases) is uBO's own
// redirect-resources.js from the same pinned release as the files, vendored by
// tools/vendor-ubo.mjs -- ubo-core's packaged copy is older and misses newer
// resources. Only files actually vendored are mapped, so no rule can point at a
// file the extension does not ship. Every resource is shipped, not only the
// ones the static lists use today, because lists recompiled at runtime (list
// updates, My filters) may name any of them.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from './backup.mjs';

// Folder inside the extension, as extensionPath and web_accessible_resources name it.
export const REDIRECT_DIR = 'web_accessible_resources';
export const VENDOR_WAR = resolve(ROOT, 'vendor', 'ubo-war');
const VENDOR_MAP = resolve(ROOT, 'vendor', 'redirect-resources.js');

const stale = what => new Error(`${what} missing: vendored uBO files are stale -- run \`npm run vendor\``);
if ( existsSync(VENDOR_MAP) === false ) { throw stale('vendor/redirect-resources.js'); }
const { default: resources } = await import(`file://${VENDOR_MAP}`);

export function redirectResources() {
    const listPath = resolve(VENDOR_WAR, '.files.json');
    if ( existsSync(listPath) === false ) { throw stale('vendor/ubo-war/.files.json'); }
    const vendored = new Set(JSON.parse(readFileSync(listPath, 'utf-8')));
    const files = [];
    const extensionPaths = [];
    const notVendored = [];
    for ( const [ name, details ] of resources ) {
        if ( vendored.has(name) === false ) { notVendored.push(name); continue; }
        const path = `/${REDIRECT_DIR}/${name}`;
        files.push(name);
        extensionPaths.push([ name, path ]);
        for ( const alias of [].concat(details.alias ?? []) ) { extensionPaths.push([ alias, path ]); }
    }
    return { files, extensionPaths, notVendored };
}
