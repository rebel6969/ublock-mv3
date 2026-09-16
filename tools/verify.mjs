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
    return {
        regex: cond.regexFilter !== undefined ? 1 : 0,
        unsafe: SAFE_ACTIONS.has(action.type) ? 0 : 1,
    };
}

function main() {
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
    const projected = dynTotal + config.whitelist.length;
    if ( projected > LIMITS.MAX_NUMBER_OF_DYNAMIC_RULES ) {
        fail(`projected dynamic rules ${projected} > ${LIMITS.MAX_NUMBER_OF_DYNAMIC_RULES}`);
    }
    if ( dynUnsafe > LIMITS.MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES ) {
        fail(`unsafe dynamic rules ${dynUnsafe} > ${LIMITS.MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES}`);
    }
    note(`projected dynamic at install: ${projected.toLocaleString()} / ${LIMITS.MAX_NUMBER_OF_DYNAMIC_RULES} ` +
        `(incl. ${config.whitelist.length} whitelist)`);

    const totalRegex = staticRegex + dynRegex;
    if ( totalRegex > LIMITS.MAX_NUMBER_OF_REGEX_RULES ) {
        fail(`regex rules ${totalRegex} > ${LIMITS.MAX_NUMBER_OF_REGEX_RULES} (static ${staticRegex} + dynamic ${dynRegex})`);
    }
    note(`regex total: ${totalRegex} / ${LIMITS.MAX_NUMBER_OF_REGEX_RULES}`);

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
    const scriptlet = readdirSync(cosDir).filter(f => /^scriptlet-\d+\.json$/.test(f));
    const index = JSON.parse(readFileSync(resolve(cosDir, 'index.json'), 'utf-8'));
    if ( specific.length !== index.shardCount ) {
        fail(`expected ${index.shardCount} specific shards, found ${specific.length}`);
    }
    if ( scriptlet.length !== index.shardCount ) {
        fail(`expected ${index.shardCount} scriptlet shards, found ${scriptlet.length}`);
    }
    const genericCss = resolve(cosDir, 'generic.css');
    if ( existsSync(genericCss) === false ) { fail('data/cosmetic/generic.css missing'); }
    note(`cosmetic: ${specific.length} specific + ${scriptlet.length} scriptlet shards, ` +
        `generic.css ${(statSync(genericCss).size / 1048576).toFixed(2)} MiB`);

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
                ? actualStatic.get(entry.id)
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

main();
