// Locate and read the configuration that drives the build.
//
// PRIVACY: a uBlock Origin backup lists every site you have disabled blocking
// on, which is effectively a slice of browsing history, plus any personal
// filters. It must never be committed or shipped in a public release. So the
// build uses config/default.json unless a personal config is explicitly pointed
// at, and personal configs are git-ignored.
//
// Resolution order:
//   1. UBLOCK_MV3_CONFIG=<path>        explicit, wins
//   2. config/my-config.json           local personal config (git-ignored)
//   3. my-ublock-backup_*.txt          a uBO export in the parent directory
//   4. config/default.json             clean defaults, no personal data
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const PARENT = resolve(ROOT, '..');

const DEFAULT_CONFIG = resolve(ROOT, 'config/default.json');

function newestBackupInParent() {
    let found = null;
    try {
        const names = readdirSync(PARENT)
            .filter(n => /^my-ublock-backup_.*\.txt$/.test(n))
            .sort();
        if ( names.length !== 0 ) { found = resolve(PARENT, names[names.length - 1]); }
    } catch { /* parent not readable; fall through to defaults */ }
    return found;
}

export function resolveConfigPath() {
    const fromEnv = process.env.UBLOCK_MV3_CONFIG;
    if ( fromEnv ) {
        const p = resolve(fromEnv);
        if ( existsSync(p) === false ) {
            throw new Error(`UBLOCK_MV3_CONFIG points at a missing file: ${p}`);
        }
        // Being pointed at the shipped defaults is not a personal build; marking
        // it as one would make CI refuse a perfectly publishable build.
        return { path: p, source: `env (${fromEnv})`, personal: p !== DEFAULT_CONFIG };
    }
    const local = resolve(ROOT, 'config/my-config.json');
    if ( existsSync(local) ) {
        return { path: local, source: 'config/my-config.json', personal: true };
    }
    const backup = newestBackupInParent();
    if ( backup !== null ) {
        return { path: backup, source: 'uBO backup in parent directory', personal: true };
    }
    return { path: DEFAULT_CONFIG, source: 'config/default.json', personal: false };
}

// Kept for compatibility with tools that imported the old constant.
export const BACKUP_PATH = resolveConfigPath().path;

export function readBackup(path) {
    const chosen = path !== undefined
        ? { path, source: path, personal: true }
        : resolveConfigPath();

    const raw = readFileSync(chosen.path, 'utf-8');
    let data;
    try {
        data = JSON.parse(raw);
    } catch ( reason ) {
        throw new Error(`config is not valid JSON (${chosen.path}): ${reason.message}`);
    }
    for ( const key of [ 'selectedFilterLists', 'whitelist', 'userFilters' ] ) {
        if ( data[key] === undefined ) {
            throw new Error(`config is missing required key "${key}": ${chosen.path}`);
        }
    }
    data.__source = chosen.source;
    data.__personal = chosen.personal;
    return data;
}

// Printed once per tool so it is never ambiguous whose data went into a build.
export function describeConfig(data) {
    return `config: ${data.__source}` +
        (data.__personal
            ? ` (PERSONAL -- ${data.whitelist.length} whitelisted sites, ` +
              `${data.userFilters.split('\n').filter(Boolean).length} own filters; do not publish this build)`
            : ' (clean defaults)');
}

// A selection entry is either a uBO asset token ("easylist") or a bare URL.
export function isURL(token) {
    return /^https?:\/\//.test(token);
}
