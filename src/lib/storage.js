// Persisted configuration, kept in uBlock Origin's backup shape.
//
// Storing the config in uBO's own schema means import/export is a straight
// read/write rather than a lossy translation, so a backup taken here restores
// into uBO and vice versa.
const KEY = 'config';

export const DEFAULT_CONFIG = {
    version: '1.0.0',
    timeStamp: 0,
    userSettings: {},
    selectedFilterLists: [],
    hiddenSettings: {},
    whitelist: [],
    dynamicFilteringString: '',
    urlFilteringString: '',
    hostnameSwitchesString: '',
    userFilters: '',
};

// Shape of a uBO backup. Used to validate imports before they touch anything.
const REQUIRED_KEYS = [ 'selectedFilterLists', 'whitelist', 'userFilters' ];

export async function loadConfig() {
    const got = await chrome.storage.local.get(KEY);
    if ( got[KEY] === undefined ) {
        // First run: seed from the configuration this build was generated from.
        const seed = await fetch(chrome.runtime.getURL('data/default-config.json'))
            .then(r => r.json())
            .catch(() => null);
        const config = Object.assign({}, DEFAULT_CONFIG, seed || {});
        await chrome.storage.local.set({ [KEY]: config });
        return config;
    }
    return Object.assign({}, DEFAULT_CONFIG, got[KEY]);
}

export async function saveConfig(config) {
    const merged = Object.assign({}, DEFAULT_CONFIG, config);
    merged.timeStamp = Date.now();
    await chrome.storage.local.set({ [KEY]: merged });
    return merged;
}

// Validate an imported backup. Returns { ok, errors, config }.
// Rejecting a malformed import outright is deliberate: partially applying one
// would leave the blocker in a state the user never chose.
export function validateBackup(data) {
    const errors = [];
    if ( data === null || typeof data !== 'object' ) {
        return { ok: false, errors: [ 'not a JSON object' ], config: null };
    }
    for ( const k of REQUIRED_KEYS ) {
        if ( data[k] === undefined ) { errors.push(`missing required key "${k}"`); }
    }
    if ( data.selectedFilterLists !== undefined && Array.isArray(data.selectedFilterLists) === false ) {
        errors.push('"selectedFilterLists" must be an array');
    }
    if ( data.whitelist !== undefined && Array.isArray(data.whitelist) === false ) {
        errors.push('"whitelist" must be an array');
    }
    if ( data.userFilters !== undefined && typeof data.userFilters !== 'string' ) {
        errors.push('"userFilters" must be a string');
    }
    if ( errors.length !== 0 ) { return { ok: false, errors, config: null }; }
    return {
        ok: true,
        errors: [],
        config: Object.assign({}, DEFAULT_CONFIG, data),
    };
}

// Produce a backup in exactly uBO's export format.
export function toBackup(config) {
    return {
        timeStamp: Date.now(),
        version: config.version || '1.0.0',
        userSettings: config.userSettings || {},
        selectedFilterLists: config.selectedFilterLists || [],
        hiddenSettings: config.hiddenSettings || {},
        whitelist: config.whitelist || [],
        dynamicFilteringString: config.dynamicFilteringString || '',
        urlFilteringString: config.urlFilteringString || '',
        hostnameSwitchesString: config.hostnameSwitchesString || '',
        userFilters: config.userFilters || '',
    };
}

// uBO names its exports my-ublock-backup_YYYY-MM-DD_HH.MM.SS.txt
export function backupFilename(now = new Date()) {
    const p = n => String(n).padStart(2, '0');
    return `my-ublock-backup_${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}` +
        `_${p(now.getHours())}.${p(now.getMinutes())}.${p(now.getSeconds())}.txt`;
}
