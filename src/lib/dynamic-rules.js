// Ownership of the dynamic ruleset.
//
// Chrome exposes one dynamic ruleset per extension, so every feature that wants
// dynamic rules shares a single id space. Colliding ids silently overwrite each
// other, so ids are partitioned into fixed bands and every write goes through
// this module. Nothing else may call updateDynamicRules().
//
// Bands (Chrome rule ids must be >= 1):
//   1        .. 999,999   filter lists installed as dynamic rules
//   1,000,000.. 1,999,999 whitelist / per-site allow rules
export const BAND = {
    LISTS: { base: 1, size: 999999 },
    WHITELIST: { base: 1000000, size: 999999 },
    SWITCHES: { base: 2000000, size: 999999 },
    // Additions from updating a list that lives in a static ruleset. Kept in its
    // own band so rebuilding the list band never disturbs accumulated deltas.
    DELTA: { base: 3000000, size: 999999 },
};

// Budget split within the 30,000 dynamic-rule limit. Mirrors the constants in
// tools/emit-extension.mjs.
export const BUDGET = {
    LISTS_AND_WHITELIST: 22000,
    DELTA_RESERVE: 6000,
    TOTAL: 30000,
};

// Verbatim from Chrome 152's declarativeNetRequest schema.
export const LIMITS = {
    MAX_NUMBER_OF_DYNAMIC_RULES: 30000,
    MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES: 5000,
    MAX_NUMBER_OF_REGEX_RULES: 1000,
};

const SAFE_ACTIONS = new Set([ 'block', 'allow', 'allowAllRequests', 'upgradeScheme' ]);

// The only top-level properties chrome.declarativeNetRequest accepts.
//
// ubo-core attaches internal bookkeeping (_warning, __modifierAction,
// __modifierType, __modifierValue) to the rules it emits. updateDynamicRules
// validates strictly and rejects the ENTIRE batch on the first unknown key --
// "Error at index 1508: Unexpected property: '_warning'" -- so a list recompiled
// in the browser by "Update all" must be cleaned before it is installed.
const VALID_TOP_LEVEL = [ 'id', 'priority', 'action', 'condition' ];

export function sanitizeRule(rule) {
    const out = {};
    for ( const key of VALID_TOP_LEVEL ) {
        if ( rule[key] !== undefined ) { out[key] = rule[key]; }
    }
    return out;
}

export function inBand(id, band) {
    return id >= band.base && id < band.base + band.size;
}

export async function getDynamicRules() {
    return chrome.declarativeNetRequest.getDynamicRules();
}

// Drop rules whose regexFilter Chrome will not accept.
//
// Chrome compiles regexFilter with RE2 and rejects the WHOLE updateDynamicRules
// call if any single pattern is unsupported (no backreferences, no lookaround,
// repetition capped at 1000). The build validates static rulesets with the real
// RE2 library, but a list refetched by "Update all" is compiled in the browser,
// so it has to be checked here too -- isRegexSupported is Chrome's own authority.
export async function dropUnsupportedRegex(rules) {
    const dropped = [];
    const kept = [];
    for ( const rule of rules ) {
        const regex = rule.condition?.regexFilter;
        if ( regex === undefined ) { kept.push(rule); continue; }
        try {
            const verdict = await chrome.declarativeNetRequest.isRegexSupported({
                regex,
                isCaseSensitive: rule.condition.isUrlFilterCaseSensitive !== false,
                requireCapturing: rule.action?.type === 'redirect',
            });
            if ( verdict.isSupported ) { kept.push(rule); }
            else { dropped.push({ regex, reason: verdict.reason ?? 'unsupported' }); }
        } catch ( reason ) {
            dropped.push({ regex, reason: `check failed: ${reason.message}` });
        }
    }
    return { kept, dropped };
}

// replaceBand is read-modify-write on the single dynamic ruleset: it reads the
// current rules to compute removeRuleIds, then writes. Two overlapping calls
// (reconcile, the update alarm, a whitelist toggle) would both act on a stale
// read and collide on rule ids. All writes therefore go through one queue.
let bandChain = Promise.resolve();

// Replace every rule in one band, leaving the other bands untouched.
export function replaceBand(band, rules) {
    const run = bandChain.then(() => replaceBandNow(band, rules));
    bandChain = run.catch(() => {});
    return run;
}

async function replaceBandNow(band, rules) {
    const existing = await getDynamicRules();
    const removeRuleIds = existing.filter(r => inBand(r.id, band)).map(r => r.id);

    const { kept, dropped: badRegex } = await dropUnsupportedRegex(rules);
    if ( badRegex.length !== 0 ) {
        console.warn(`[uBlockMV3] dropped ${badRegex.length} rule(s) with regex Chrome rejects`, badRegex);
    }

    const addRules = kept.map((r, i) => sanitizeRule({ ...r, id: band.base + i }));
    if ( addRules.length > band.size ) {
        throw new Error(`band overflow: ${addRules.length} rules exceeds band size ${band.size}`);
    }

    // Pre-flight against the documented quotas. Chrome would reject the whole
    // call anyway; failing here produces a message that says which quota and by
    // how much, instead of an opaque API error.
    const keep = existing.filter(r => inBand(r.id, band) === false);
    const finalRules = keep.concat(addRules);
    const budget = auditBudget(finalRules);
    if ( budget.ok === false ) {
        throw new Error(`dynamic rule budget exceeded: ${budget.problems.join('; ')}`);
    }

    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
    return {
        removed: removeRuleIds.length,
        added: addRules.length,
        droppedRegex: badRegex.length,
    };
}

export function auditBudget(rules) {
    let unsafe = 0, regex = 0;
    for ( const r of rules ) {
        if ( SAFE_ACTIONS.has(r.action?.type) === false ) { unsafe += 1; }
        if ( r.condition?.regexFilter !== undefined ) { regex += 1; }
    }
    const problems = [];
    if ( rules.length > LIMITS.MAX_NUMBER_OF_DYNAMIC_RULES ) {
        problems.push(`${rules.length} dynamic rules > ${LIMITS.MAX_NUMBER_OF_DYNAMIC_RULES}`);
    }
    if ( unsafe > LIMITS.MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES ) {
        problems.push(`${unsafe} unsafe rules > ${LIMITS.MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES}`);
    }
    return { ok: problems.length === 0, problems, total: rules.length, unsafe, regex };
}

// Whitelist entries come from uBO and may be a hostname, a URL, or one of uBO's
// pseudo-hosts ("about-scheme"). Only things that name a real host can become a
// DNR allow rule; the rest are reported so they are not lost in silence.
export function whitelistToRules(entries) {
    const rules = [];
    const unsupported = [];
    for ( const raw of entries ) {
        const entry = String(raw).trim();
        if ( entry === '' || entry.startsWith('#') ) { continue; }
        if ( entry.endsWith('-scheme') ) { unsupported.push(entry); continue; }

        let host = entry;
        if ( /^https?:\/\//.test(entry) ) {
            try { host = new URL(entry).hostname; } catch { unsupported.push(entry); continue; }
        }
        // Strip any path component from bare "host/path" forms.
        const slash = host.indexOf('/');
        if ( slash !== -1 ) { host = host.slice(0, slash); }
        if ( host === '' || /\s/.test(host) ) { unsupported.push(entry); continue; }

        rules.push({
            priority: 100000, // must outrank every blocking rule
            action: { type: 'allowAllRequests' },
            condition: {
                requestDomains: [ host ],
                resourceTypes: [ 'main_frame', 'sub_frame' ],
            },
        });
    }
    return { rules, unsupported };
}
