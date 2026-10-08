// Static validation of the built extension, run before it is ever loaded.
//
// Chrome reports a bad ruleset with a terse error and refuses the whole
// extension, so every constraint that can be checked offline is checked here:
// referenced files exist, rule ids are unique per ruleset, no diagnostics leaked
// into a ruleset, DNR conditions are well-formed, and the budgets hold.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from './lib/backup.mjs';
import { checkRegex } from './lib/re2check.mjs';
import { VALID_TOP_LEVEL } from './lib/sanitize.mjs';
import { ENV } from './lib/env.mjs';
import { ubolNetworkFilters } from '../src/lib/ubol-compat.js';
import { BUDGET } from '../src/lib/dynamic-rules.js';
import { DNR_OPTIONS } from './lib/env.mjs';
import { loadPopupFilters, loadPublicSuffixList, matchPopup } from '../src/lib/popup-filters.js';
import { planStaticDeltas, planProblems } from '../src/lib/delta-plan.js';
import { dnrRulesetFromRawLists } from '@gorhill/ubo-core/js/static-dnr-filtering.js';

const DELTA_RESERVE = BUDGET.DELTA_RESERVE;

const DIST = resolve(ROOT, 'extension');

// Verbatim from Chrome 152's declarativeNetRequest schema.
const LIMITS = {
    GLOBAL_STATIC_RULE_LIMIT: 330000,
    MAX_NUMBER_OF_REGEX_RULES: 1000,
    MAX_NUMBER_OF_ENABLED_STATIC_RULESETS: 50,
    MAX_NUMBER_OF_STATIC_RULESETS: 100,
    MAX_NUMBER_OF_DYNAMIC_RULES: 30000,
    MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES: 5000,
};

const VALID_ACTIONS = new Set([
    'block', 'allow', 'allowAllRequests', 'upgradeScheme', 'redirect', 'modifyHeaders',
]);
const SAFE_ACTIONS = new Set([ 'block', 'allow', 'allowAllRequests', 'upgradeScheme' ]);
const VALID_RESOURCE_TYPES = new Set([
    'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object',
    'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'webtransport',
    'webbundle', 'other',
]);

// Chrome match pattern host: dot-separated [a-z0-9-] labels. No wildcards inside
// the host, no regex, no uppercase.
const VALID_MATCH_HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

const problems = [];
const notes = [];
// Redirect stand-ins: declared = manifest web_accessible_resources (as
// "/path"), filled before any rule is validated.
const redirects = { declared: new Set(), used: new Set(), rules: 0 };
function fail(msg) { problems.push(msg); }
function note(msg) { notes.push(msg); }

function validateRule(rule, where, seenIds) {
    if ( rule._error !== undefined ) {
        fail(`${where}: a rejected-filter diagnostic leaked into the ruleset`);
        return null;
    }
    // chrome.declarativeNetRequest rejects an entire updateDynamicRules batch on
    // the first unrecognised top-level property, so any foreign key is fatal.
    for ( const key of Object.keys(rule) ) {
        if ( VALID_TOP_LEVEL.includes(key) === false ) {
            fail(`${where}: rule ${rule.id} has non-DNR property "${key}" ` +
                `(Chrome rejects the whole batch on unknown keys)`);
            return null;
        }
    }
    if ( Number.isInteger(rule.id) === false || rule.id < 1 ) {
        fail(`${where}: rule id must be an integer >= 1, got ${JSON.stringify(rule.id)}`);
        return null;
    }
    if ( seenIds.has(rule.id) ) {
        fail(`${where}: duplicate rule id ${rule.id}`);
        return null;
    }
    seenIds.add(rule.id);

    const action = rule.action;
    if ( action === undefined || VALID_ACTIONS.has(action.type) === false ) {
        fail(`${where}: rule ${rule.id} has invalid action ${JSON.stringify(action?.type)}`);
        return null;
    }
    const cond = rule.condition;
    if ( cond === undefined || typeof cond !== 'object' ) {
        fail(`${where}: rule ${rule.id} has no condition`);
        return null;
    }
    for ( const t of (cond.resourceTypes ?? []) ) {
        if ( VALID_RESOURCE_TYPES.has(t) === false ) {
            fail(`${where}: rule ${rule.id} has unknown resourceType "${t}"`);
        }
    }
    if ( cond.regexFilter !== undefined ) {
        if ( typeof cond.regexFilter !== 'string' ) {
            fail(`${where}: rule ${rule.id} has a non-string regexFilter`);
        } else {
            // Chrome compiles regexFilter with RE2 and refuses the entire
            // ruleset over one bad pattern, so this must be caught here rather
            // than at install time.
            const verdict = checkRegex(cond.regexFilter, {
                caseSensitive: cond.isUrlFilterCaseSensitive !== false,
            });
            if ( verdict.ok === false ) {
                fail(`${where}: rule ${rule.id} regexFilter is not RE2-compatible ` +
                    `(${verdict.reason}): ${cond.regexFilter.slice(0, 100)}`);
            }
        }
    }
    if ( action.type === 'redirect' && action.redirect === undefined ) {
        fail(`${where}: rule ${rule.id} is a redirect with no redirect target`);
    }
    // A redirect to a missing or unlisted stand-in does not fail loudly: the
    // page's request just errors, so the check has to happen here.
    const extensionPath = action.redirect?.extensionPath;
    if ( extensionPath !== undefined ) {
        redirects.rules += 1;
        redirects.used.add(extensionPath);
        if ( redirects.declared.has(extensionPath) === false ) {
            fail(`${where}: rule ${rule.id} redirects to ${extensionPath}, ` +
                'which is not a declared web-accessible resource');
        }
    }
    return {
        regex: cond.regexFilter !== undefined ? 1 : 0,
        unsafe: SAFE_ACTIONS.has(action.type) ? 0 : 1,
    };
}

async function main() {
    console.log('VERIFY BUILT EXTENSION');
    console.log('='.repeat(70));

    if ( existsSync(DIST) === false ) {
        fail('extension/ does not exist -- run npm run build:all');
        return report();
    }

    // --- manifest ---------------------------------------------------------
    const manifestPath = resolve(DIST, 'manifest.json');
    if ( existsSync(manifestPath) === false ) {
        fail('manifest.json missing');
        return report();
    }
    let manifest;
    try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    } catch ( reason ) {
        fail(`manifest.json is not valid JSON: ${reason.message}`);
        return report();
    }
    if ( manifest.manifest_version !== 3 ) {
        fail(`manifest_version must be 3, got ${manifest.manifest_version}`);
    }
    note(`manifest: ${manifest.name} ${manifest.version}, min Chrome ${manifest.minimum_chrome_version}`);

    // Every file the manifest names must exist.
    const referenced = [];
    if ( manifest.background?.service_worker ) { referenced.push(manifest.background.service_worker); }
    if ( manifest.action?.default_popup ) { referenced.push(manifest.action.default_popup); }
    if ( manifest.options_ui?.page ) { referenced.push(manifest.options_ui.page); }
    for ( const cs of (manifest.content_scripts ?? []) ) {
        referenced.push(...(cs.js ?? []), ...(cs.css ?? []));
    }
    for ( const icons of [ manifest.icons, manifest.action?.default_icon ] ) {
        for ( const p of Object.values(icons ?? {}) ) { referenced.push(p); }
    }
    for ( const f of referenced ) {
        if ( existsSync(resolve(DIST, f)) === false ) {
            fail(`manifest references a missing file: ${f}`);
        }
    }
    note(`manifest references ${referenced.length} files, all present`);

    // Every declared web-accessible resource must exist.
    for ( const entry of (manifest.web_accessible_resources ?? []) ) {
        for ( const res of (entry.resources ?? []) ) {
            redirects.declared.add(`/${res}`);
            if ( existsSync(resolve(DIST, res)) === false ) {
                fail(`web_accessible_resources lists a missing file: ${res}`);
            }
        }
    }

    // --- static rulesets --------------------------------------------------
    const rr = manifest.declarative_net_request?.rule_resources ?? [];
    if ( rr.length > LIMITS.MAX_NUMBER_OF_STATIC_RULESETS ) {
        fail(`${rr.length} static rulesets > ${LIMITS.MAX_NUMBER_OF_STATIC_RULESETS}`);
    }
    const enabled = rr.filter(r => r.enabled !== false);
    if ( enabled.length > LIMITS.MAX_NUMBER_OF_ENABLED_STATIC_RULESETS ) {
        fail(`${enabled.length} enabled rulesets > ${LIMITS.MAX_NUMBER_OF_ENABLED_STATIC_RULESETS}`);
    }

    const ids = new Set();
    let staticTotal = 0, staticRegex = 0;
    for ( const entry of rr ) {
        if ( ids.has(entry.id) ) { fail(`duplicate ruleset id "${entry.id}"`); }
        ids.add(entry.id);
        const p = resolve(DIST, entry.path);
        if ( existsSync(p) === false ) {
            fail(`ruleset "${entry.id}" path missing: ${entry.path}`);
            continue;
        }
        let rules;
        try {
            rules = JSON.parse(readFileSync(p, 'utf-8'));
        } catch ( reason ) {
            fail(`ruleset "${entry.id}" is not valid JSON: ${reason.message}`);
            continue;
        }
        if ( Array.isArray(rules) === false ) {
            fail(`ruleset "${entry.id}" must be a JSON array`);
            continue;
        }
        const seen = new Set();
        for ( const rule of rules ) {
            const r = validateRule(rule, `ruleset ${entry.id}`, seen);
            if ( r === null ) { continue; }
            staticRegex += r.regex;
        }
        staticTotal += rules.length;
    }
    note(`static: ${rr.length} rulesets (${enabled.length} enabled), ` +
        `${staticTotal.toLocaleString()} rules, ${staticRegex} regex`);
    if ( staticTotal > LIMITS.GLOBAL_STATIC_RULE_LIMIT ) {
        fail(`${staticTotal} static rules > ${LIMITS.GLOBAL_STATIC_RULE_LIMIT}`);
    }
    // Chrome cannot switch off a static regex rule (BAND.REGEX in
    // src/lib/dynamic-rules.js), so a delta update could never retire one.
    if ( staticRegex !== 0 ) {
        fail(`${staticRegex} regex rule(s) in static rulesets -- they belong in rulesets/static-regex.json`);
    }

    // --- static lists' regex rules (dynamic REGEX band) --------------------
    const staticRegexPath = resolve(DIST, 'rulesets', 'static-regex.json');
    let regexBandTotal = 0, regexBandUnsafe = 0;
    const actualStaticRegex = new Map();
    if ( existsSync(staticRegexPath) === false ) {
        fail('rulesets/static-regex.json missing');
    } else {
        for ( const list of JSON.parse(readFileSync(staticRegexPath, 'utf-8')) ) {
            const seen = new Set();
            for ( const rule of (list.rules ?? []) ) {
                const r = validateRule({ ...rule, id: rule.id ?? 1 }, `static-regex ${list.token}`, seen);
                if ( r === null ) { continue; }
                if ( r.regex !== 1 ) { fail(`static-regex ${list.token}: non-regex rule ${rule.id}`); }
                regexBandUnsafe += r.unsafe;
            }
            regexBandTotal += (list.rules ?? []).length;
            actualStaticRegex.set(list.token, (list.rules ?? []).length);
        }
        note(`static lists' regex rules: ${regexBandTotal} across ${actualStaticRegex.size} lists, installed as dynamic rules`);
    }

    // --- dynamic seed ------------------------------------------------------
    const seedPath = resolve(DIST, 'rulesets', 'dynamic-seed.json');
    let dynTotal = 0, dynRegex = 0, dynUnsafe = 0;
    if ( existsSync(seedPath) === false ) {
        fail('rulesets/dynamic-seed.json missing');
    } else {
        const seed = JSON.parse(readFileSync(seedPath, 'utf-8'));
        for ( const list of seed ) {
            const seen = new Set();
            for ( const rule of (list.rules ?? []) ) {
                // Seed rules are renumbered at install time, so ids may repeat
                // across lists; validate shape only.
                const r = validateRule({ ...rule, id: rule.id ?? 1 }, `seed ${list.token}`, seen);
                if ( r === null ) { continue; }
                dynRegex += r.regex;
                dynUnsafe += r.unsafe;
            }
            dynTotal += (list.rules ?? []).length;
        }
        note(`dynamic seed: ${seed.length} lists, ${dynTotal.toLocaleString()} rules, ` +
            `${dynRegex} regex, ${dynUnsafe} unsafe`);
    }

    const config = JSON.parse(readFileSync(resolve(DIST, 'data', 'default-config.json'), 'utf-8'));
    // At install: lists + whitelist + static lists' regex. The delta reserve is
    // added on top, because updates fill it later out of the same 30,000.
    const projected = dynTotal + config.whitelist.length + regexBandTotal;
    const withReserve = projected + DELTA_RESERVE;
    if ( withReserve > LIMITS.MAX_NUMBER_OF_DYNAMIC_RULES ) {
        fail(`projected dynamic rules ${projected} + delta reserve ${DELTA_RESERVE} > ${LIMITS.MAX_NUMBER_OF_DYNAMIC_RULES}`);
    }
    if ( dynUnsafe + regexBandUnsafe > LIMITS.MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES ) {
        fail(`unsafe dynamic rules ${dynUnsafe + regexBandUnsafe} > ${LIMITS.MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES}`);
    }
    note(`projected dynamic at install: ${projected.toLocaleString()} / ${LIMITS.MAX_NUMBER_OF_DYNAMIC_RULES} ` +
        `(incl. ${config.whitelist.length} whitelist, ${regexBandTotal} static-list regex); ` +
        `${withReserve.toLocaleString()} with the ${DELTA_RESERVE} delta reserve`);

    // Chrome evaluates the regex cap separately for dynamic and static rules.
    const dynamicRegex = dynRegex + regexBandTotal;
    if ( dynamicRegex > LIMITS.MAX_NUMBER_OF_REGEX_RULES ) {
        fail(`dynamic regex rules ${dynamicRegex} > ${LIMITS.MAX_NUMBER_OF_REGEX_RULES} (lists ${dynRegex} + static-list regex ${regexBandTotal})`);
    }
    note(`regex: ${dynamicRegex} / ${LIMITS.MAX_NUMBER_OF_REGEX_RULES} dynamic, ${staticRegex} static`);
    note(`redirects: ${redirects.rules.toLocaleString()} rules to ${redirects.used.size} stand-ins, ` +
        `all declared (${redirects.declared.size} web-accessible files present)`);

    // --- scriptlet registrations -------------------------------------------
    const regPath = resolve(DIST, 'scriptlets', 'registrations.json');
    if ( existsSync(regPath) === false ) {
        fail('scriptlets/registrations.json missing');
    } else {
        const regs = JSON.parse(readFileSync(regPath, 'utf-8'));
        const regIds = new Set();
        let patterns = 0;
        for ( const r of regs ) {
            if ( regIds.has(r.id) ) { fail(`duplicate content script id "${r.id}"`); }
            regIds.add(r.id);
            if ( r.world !== 'MAIN' && r.world !== 'ISOLATED' ) {
                fail(`registration "${r.id}" has invalid world "${r.world}"`);
            }
            for ( const f of r.js ) {
                if ( existsSync(resolve(DIST, f)) === false ) {
                    fail(`registration "${r.id}" references missing file ${f}`);
                }
            }
            if ( r.matches.length === 0 ) { fail(`registration "${r.id}" has no match patterns`); }
            // Chrome rejects the entire registerContentScripts() call on one bad
            // pattern, which silently disables every scriptlet. 2,548 invalid
            // patterns once took all 128 registrations down at once, so each is
            // validated here rather than discovered in the browser.
            for ( const p of r.matches ) {
                if ( p === '*://*/*' || p === '<all_urls>' ) { continue; }
                if ( p === 'http://*/*' || p === 'https://*/*' ) { continue; }
                const m = /^\*:\/\/\*\.([^/]+)\/\*$/.exec(p);
                if ( m === null || VALID_MATCH_HOST.test(m[1]) === false ) {
                    fail(`registration "${r.id}" has an invalid match pattern: ${p}`);
                    break;
                }
            }
            patterns += r.matches.length;
        }
        note(`scriptlets: ${regs.length} registrations, ${patterns.toLocaleString()} match patterns`);
    }

    // --- cosmetic shards ----------------------------------------------------
    const cosDir = resolve(DIST, 'data', 'cosmetic');
    const specific = readdirSync(cosDir).filter(f => /^specific-\d+\.json$/.test(f));
    const index = JSON.parse(readFileSync(resolve(cosDir, 'index.json'), 'utf-8'));
    if ( specific.length !== index.shardCount ) {
        fail(`expected ${index.shardCount} specific shards, found ${specific.length}`);
    }
    // Scriptlet shards are build input only; they must not ship.
    const shippedScriptletShards = readdirSync(cosDir).filter(f => /^scriptlet-/.test(f));
    if ( shippedScriptletShards.length !== 0 ) {
        fail(`build-only scriptlet data shipped in data/cosmetic: ${shippedScriptletShards.slice(0, 3).join(', ')}`);
    }
    const genericLookup = resolve(cosDir, 'generic-lookup.js');
    if ( existsSync(genericLookup) === false ) { fail('data/cosmetic/generic-lookup.js missing'); }
    for ( const retired of [ 'generic.css', 'generic-high.json', 'generic-high.css' ] ) {
        if ( existsSync(resolve(cosDir, retired)) ) { fail(`retired file still shipped: data/cosmetic/${retired}`); }
    }
    note(`cosmetic: ${specific.length} specific shards, generic-lookup.js ` +
        `${(statSync(genericLookup).size / 1048576).toFixed(2)} MiB ` +
        `(${index.genericLowlySelectors} lowly + ${index.genericHighSelectors} highly generic)`);

    // --- delta-update baselines ---------------------------------------------
    // Every static ruleset needs a baseline, and it must describe exactly the
    // rules that shipped. A stale or missing baseline makes an update try to
    // disable ids that were never installed, or re-add rules that already exist.
    let baselineRules = 0;
    let baselineMissing = 0;
    for ( const entry of rr ) {
        const bPath = resolve(DIST, `rulesets/${entry.id}.baseline.json`);
        if ( existsSync(bPath) === false ) {
            fail(`ruleset "${entry.id}" has no baseline (delta updates would fail)`);
            baselineMissing += 1;
            continue;
        }
        const baseline = JSON.parse(readFileSync(bPath, 'utf-8'));
        const rules = JSON.parse(readFileSync(resolve(DIST, entry.path), 'utf-8'));
        const n = Object.keys(baseline).length;
        if ( n !== rules.length ) {
            fail(`baseline for "${entry.id}" has ${n} entries but the ruleset ships ` +
                `${rules.length} rules (stale baseline)`);
        }
        baselineRules += n;
    }
    if ( baselineMissing === 0 ) {
        note(`baselines: ${rr.length} files covering ${baselineRules.toLocaleString()} rules, all current`);
    }

    // --- list catalog accuracy ---------------------------------------------
    // The dashboard renders these counts. They are written before the regex
    // prune, so they must be re-checked against what actually shipped: a count
    // that does not describe what is enforced is worse than no count.
    const catalogPath = resolve(DIST, 'data', 'list-catalog.json');
    if ( existsSync(catalogPath) === false ) {
        fail('data/list-catalog.json missing');
    } else {
        const catalog = JSON.parse(readFileSync(catalogPath, 'utf-8'));
        const actualStatic = new Map();
        for ( const entry of rr ) {
            const p = resolve(DIST, entry.path);
            if ( existsSync(p) ) {
                actualStatic.set(entry.id, JSON.parse(readFileSync(p, 'utf-8')).length);
            }
        }
        const actualSeed = new Map();
        if ( existsSync(seedPath) ) {
            for ( const list of JSON.parse(readFileSync(seedPath, 'utf-8')) ) {
                actualSeed.set(list.token, (list.rules ?? []).length);
            }
        }
        let mismatches = 0;
        for ( const entry of catalog ) {
            const expected = entry.kind === 'static'
                ? (actualStatic.has(entry.id) ? actualStatic.get(entry.id) + (actualStaticRegex.get(entry.token) ?? 0) : undefined)
                : actualSeed.get(entry.token);
            if ( expected === undefined ) { continue; }
            if ( entry.rules !== expected ) {
                fail(`list-catalog: "${entry.token}" claims ${entry.rules} rules but ` +
                    `${expected} shipped (stale count would be shown in the dashboard)`);
                mismatches += 1;
            }
        }
        if ( mismatches === 0 ) {
            note(`list-catalog: ${catalog.length} entries, all rule counts match what shipped`);
        }
    }

    // --- page scripts are one-byte ------------------------------------------
    // These run in every frame. V8 keeps a script one-byte only if every
    // character is <= U+00FF; one character above that doubles the source in
    // memory and moves it to the slower two-byte scanner, in every frame.
    // Generated data is emitted ASCII-escaped (tools/lib/ascii-json.mjs).
    {
        const pageScripts = new Set();
        for ( const cs of manifest.content_scripts ?? [] ) { for ( const f of cs.js ?? [] ) { pageScripts.add(f); } }
        const regFile = resolve(DIST, 'scriptlets', 'registrations.json');
        if ( existsSync(regFile) ) {
            for ( const r of JSON.parse(readFileSync(regFile, 'utf-8')) ) { for ( const f of r.js ) { pageScripts.add(f); } }
        }
        // Registered by background.js (ubmv3-generic) and injected on demand.
        for ( const f of [ 'data/cosmetic/generic-lookup.js', 'generic.js', 'procedural.js' ] ) { pageScripts.add(f); }
        let chars = 0;
        let twoByte = 0;
        for ( const f of pageScripts ) {
            const p = resolve(DIST, f);
            if ( existsSync(p) === false ) { fail(`page script missing: ${f}`); continue; }
            const src = readFileSync(p, 'utf-8');
            chars += src.length;
            let wide = 0;
            for ( let i = 0; i < src.length; i++ ) { if ( src.charCodeAt(i) > 0xFF ) { wide += 1; } }
            if ( wide !== 0 ) {
                fail(`${f}: ${wide} character(s) above U+00FF make it two-byte in every frame -- emit it with asciiJSON`);
                twoByte += 1;
            }
        }
        if ( twoByte === 0 ) {
            note(`page scripts: ${pageScripts.size} files, ${(chars / 1048576).toFixed(2)} M chars, all one-byte`);
        }
    }

    // --- ext_ubol network rewrites (src/lib/ubol-compat.js) -----------------
    // Fixture with known answers: only sections made purely of blocking network
    // filters may be taken. Each skipped section is a negative control.
    {
        const fixture = [
            '||common.example^',
            '!#if ext_ubol',
            '/^https:\\/\\/[a-z]{2}\\.[a-z]{7,14}\\.com\\/[rt][0-9A-Za-z]{10,16}\\/\\d{3,6}(?:\\?|$)/$script,3p,match-case',
            '||stand-in.example^$script,redirect=noop.js',
            '!#endif',
            '!#if !ext_ubol',
            '||mv2-only.example^',
            '!#else',
            '||else-branch.example^',
            '!#endif',
            '!#if ext_ubol', '||paired-block.example^', '@@||paired-allow.example^', '!#endif',
            '!#if ext_ubol', '||x.example^$removeparam=utm_source', '!#endif',
            '!#if ext_ubol', '||y.example^$csp=worker-src \'none\'', '!#endif',
            '!#if ext_ubol', '||z.example^$badfilter', '!#endif',
            '!#if ext_ubol', '||t.example^$xhr', '||u.example^$xhr,uritransform=/a/b/', '!#endif',
            '!#if ext_ubol', '||cos-block.example^', 'example.com##.ad', '!#endif',
            '!#if env_safari', '!#if ext_ubol', '||safari-only.example^', '!#endif', '!#endif',
            '!#if ext_ubol', '||nested-outer.example^',
            '!#if env_chromium', '@@||nested-allow.example^', '!#endif', '!#endif',
            '!#if ext_ubol',
            '||unterminated.example^',
        ].join('\n');
        const want = [
            '/^https:\\/\\/[a-z]{2}\\.[a-z]{7,14}\\.com\\/[rt][0-9A-Za-z]{10,16}\\/\\d{3,6}(?:\\?|$)/$script,3p,match-case',
            '||stand-in.example^$script,redirect=noop.js',
            '||else-branch.example^',
            '||unterminated.example^',
        ];
        const got = ubolNetworkFilters(fixture, ENV);
        if ( JSON.stringify(got) !== JSON.stringify(want) ) {
            fail(`ext_ubol selection fixture: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
        } else if ( ubolNetworkFilters(fixture, [ ...ENV, 'ubol' ]).length !== 0 ) {
            fail('ext_ubol selection must be empty when the env already includes ubol');
        } else {
            note(`ext_ubol selection: fixture ok (${want.length} taken, 8 sections correctly skipped)`);
        }
        const fetchedFile = resolve(ROOT, 'build', 'lists.fetched.json');
        if ( existsSync(fetchedFile) ) {
            let taken = 0;
            for ( const f of JSON.parse(readFileSync(fetchedFile, 'utf-8')) ) {
                taken += ubolNetworkFilters(readFileSync(f.path, 'utf-8'), ENV).length;
            }
            note(`ext_ubol rewrites: ${taken} blocking filter(s) taken from the fetched lists`);
        }
    }

    // --- popup filters (src/lib/popup-filters.js) ----------------------------
    {
        const popupPath = resolve(DIST, 'data', 'popup-filters.json');
        const pslPath = resolve(DIST, 'data', 'psl.json');
        if ( existsSync(popupPath) === false || existsSync(pslPath) === false ) {
            fail('data/popup-filters.json or data/psl.json missing (popup filtering would be off)');
        } else {
            const lists = JSON.parse(readFileSync(popupPath, 'utf-8')).map(e => ({ name: e.token, lines: e.lines }));
            // The engine is module state shared with the DNR compiler: loading it
            // must leave the compiler's output untouched.
            const probe = [ { name: 'probe', text: '||example.com^\n||ads.example^$script,3p\n/^https:\\/\\/[a-z]{3}\\.example\\//$xhr,3p' } ];
            const dnrOut = async () => JSON.stringify((await dnrRulesetFromRawLists(probe, DNR_OPTIONS)).network.ruleset);
            const before = await dnrOut();
            loadPublicSuffixList(JSON.parse(readFileSync(pslPath, 'utf-8')));
            const loaded = loadPopupFilters(lists);
            if ( await dnrOut() !== before ) {
                fail('loading the popup engine changed DNR compiler output');
            }
            // Known answers from the shipped data itself.
            let host;
            for ( const l of lists ) {
                const line = l.lines.find(s => /^\|\|[a-z0-9.-]+\^\$popup$/.test(s));
                if ( line ) { host = line.slice(2, line.indexOf('^')); break; }
            }
            const opener = 'https://opener.example/';
            if ( host === undefined ) {
                fail('popup-filters.json has no plain ||host^$popup filter to self-test with');
            } else if ( matchPopup({ rootOpenerURL: opener, targetURL: `https://${host}/p` }) !== 1 ) {
                fail(`popup engine does not block a popup to ${host}, which a shipped $popup filter names`);
            } else if ( matchPopup({ rootOpenerURL: opener, targetURL: `https://${host}/p`, type: 'script' }) !== 0 ) {
                fail('popup engine matched a non-popup request (popup filters must only apply to popups)');
            } else if ( matchPopup({ rootOpenerURL: opener, targetURL: 'https://unlisted.invalid/' }) !== 0 ) {
                fail('popup engine blocked an unlisted host');
            } else {
                note(`popup filters: ${loaded} loaded from ${lists.length} lists; self-test ok (${host}); DNR output unaffected`);
            }
        }
    }

    // --- static delta planner (src/lib/delta-plan.js) -------------------------
    {
        const rules = (n, type = 'block') => Array.from({ length: n }, () => ({ action: { type } }));
        const ids = n => Array.from({ length: n }, (_, i) => i + 1);
        const countUnsafe = rs => rs.filter(r => SAFE_ACTIONS.has(r.action.type) === false).length;
        const limits = { additions: 6000, unsafe: 5, disabled: 5000 };
        const diff = (token, adds, dis, type) => ({ token, rulesetId: token, additions: rules(adds, type), disableRuleIds: ids(dis) });
        // The 2026-10-08 shape: a list with a huge diff ahead of small ones.
        const diffs = [
            diff('huge', 13831, 53),
            diff('small', 14, 19),
            diff('mid', 3900, 10),
            diff('grow', 4500, 7),
            diff('phish', 10, 5001),
            diff('redir', 10, 0, 'redirect'),
        ];
        const applied = {
            grow: { rulesetId: 'grow', additions: rules(300), disableRuleIds: ids(4) },
            idle: { rulesetId: 'idle', additions: rules(20), disableRuleIds: ids(2) },
        };
        const { next, mode } = planStaticDeltas(diffs, applied, limits, countUnsafe);
        const want = { huge: 'baseline', small: 'updated', mid: 'updated', grow: 'previous update', phish: 'baseline', redir: 'baseline', idle: 'previous update' };
        const wrong = Object.keys(want).filter(t => mode[t] !== want[t]).map(t => `${t}=${mode[t]} (want ${want[t]})`);
        const inPlan = Object.keys(next).sort().join(',');
        const problemsNow = planProblems(next, diffs, applied, limits, countUnsafe);
        // Negative control: the pre-1.0.12 updater switched off every list's
        // removals but installed only the first 6,000 additions in list order.
        let left = limits.additions;
        const old = {};
        for ( const d of diffs ) {
            const take = Math.max(0, Math.min(left, d.additions.length));
            left -= take;
            old[d.token] = { rulesetId: d.rulesetId, additions: d.additions.slice(0, take), disableRuleIds: d.disableRuleIds };
        }
        const oldProblems = planProblems(old, diffs, {}, limits, countUnsafe);
        const shrunk = planStaticDeltas([], applied, { additions: 10, unsafe: 5, disabled: 5000 }, countUnsafe);
        if ( wrong.length !== 0 ) {
            fail(`delta planner: ${wrong.join(', ')}`);
        } else if ( inPlan !== 'grow,idle,mid,small' || next.grow !== applied.grow ) {
            fail(`delta planner: plan holds ${inPlan}, want grow(previous),idle,mid,small`);
        } else if ( problemsNow.length !== 0 ) {
            fail(`delta planner: its own plan fails the invariant: ${problemsNow.join('; ')}`);
        } else if ( oldProblems.some(p => p.startsWith('small:')) === false ) {
            fail('delta planner invariant does not catch the pre-1.0.12 half-applied update (negative control)');
        } else if ( shrunk.mode.idle !== 'baseline' || shrunk.next.idle !== undefined ) {
            fail('delta planner keeps an update in force that no longer fits');
        } else {
            note(`static delta planner: whole-list updates, smallest first, quotas held; old half-applied plan flagged (${oldProblems.length} problems)`);
        }
    }

    // --- service worker bundle ---------------------------------------------
    const sw = resolve(DIST, 'background.js');
    const swSrc = readFileSync(sw, 'utf-8');
    // A bare import surviving the bundle would break the worker at load.
    if ( /^\s*import\s.+\sfrom\s+['"][^.\/]/m.test(swSrc) ) {
        fail('background.js still contains a bare module specifier -- bundling did not inline it');
    }
    note(`background.js: ${(statSync(sw).size / 1024).toFixed(0)} KiB bundled`);

    report();
}

function report() {
    console.log();
    for ( const n of notes ) { console.log(`  ok   ${n}`); }
    console.log();
    if ( problems.length === 0 ) {
        console.log(`PASS -- ${notes.length} checks, no problems found.`);
        return;
    }
    console.log(`FAIL -- ${problems.length} problem(s):`);
    for ( const p of problems ) { console.log(`  !!   ${p}`); }
    process.exitCode = 1;
}

main().catch(reason => {
    console.error('VERIFY FAILED:', reason.stack ?? reason);
    process.exitCode = 1;
});
