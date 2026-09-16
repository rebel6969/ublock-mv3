// Plan the static/dynamic split and emit the loadable extension.
//
// Split policy, derived from measured per-list cost and Chrome 152's real limits:
//
//   STATIC rulesets  - the expensive lists, one ruleset per list so each stays
//                      individually toggleable via updateEnabledRulesets().
//                      Bounded by MAX_NUMBER_OF_ENABLED_STATIC_RULESETS (50).
//   DYNAMIC rules    - the user's own filters, their whitelist, their custom URL
//                      lists, and the cheap catalog lists. These are what the
//                      "Update all lists" button can actually refresh at runtime,
//                      because only dynamic rules are writable after install.
//
// The boundary is chosen to leave real headroom in both budgets rather than
// filling them to the brim, so a list growing upstream does not break the build.
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, readBackup, describeConfig } from './lib/backup.mjs';
import { DNR_OPTIONS } from './lib/env.mjs';
import { filterValidRegexRules } from './lib/re2check.mjs';
import { sanitizeRules } from './lib/sanitize.mjs';
import { ruleHash } from './lib/rulehash.mjs';
import { dnrRulesetFromRawLists } from '@gorhill/ubo-core/js/static-dnr-filtering.js';

const BUILD = resolve(ROOT, 'build');
const DIST = resolve(ROOT, 'extension');

// Verbatim from Chrome 152.0.7977.83's declarativeNetRequest API schema.
const LIMITS = {
    GUARANTEED_MINIMUM_STATIC_RULES: 30000,
    GLOBAL_STATIC_RULE_LIMIT: 330000,
    MAX_NUMBER_OF_DYNAMIC_RULES: 30000,
    MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES: 5000,
    MAX_NUMBER_OF_REGEX_RULES: 1000,
    MAX_NUMBER_OF_ENABLED_STATIC_RULESETS: 50,
    MAX_NUMBER_OF_STATIC_RULESETS: 100,
};

// Headroom targets: deliberately below the hard ceilings.
//
// TARGET_MAX_DYNAMIC_RULES is the important one. Only dynamic rules are writable
// after install, so every list that fits in the dynamic band auto-updates in the
// browser and every list left in a static ruleset needs a rebuild. Filling this
// budget therefore maximises how much updates by itself.
//
// 85% of 30,000 leaves real headroom: lists grow upstream, and "Update all"
// recompiles every enabled list in one pass, which can shift the total either
// way. Measured trade-off (tools/analyze-split.mjs):
//     80% -> 58 auto-updating / 19 static
//     85% -> 59 auto-updating / 18 static   <- chosen
//     95% -> 61 auto-updating / 16 static
//    100% -> 62 auto-updating / 15 static, only 320 rules of slack
// The dynamic band is shared by three things, so it is budgeted explicitly
// rather than letting lists consume all of it:
//
//   lists + whitelist   22,000   full copies of the lists that live here
//   delta reserve        6,000   changes to static lists, added at update time
//   slack                2,000   absorbs upstream list growth between rebuilds
//                       -------
//                        30,000
//
// The delta reserve is what makes every list updatable. A list inside a static
// ruleset cannot be rewritten, but its CHANGES can: rules that disappeared
// upstream are switched off with updateStaticRules(), and new ones are installed
// as dynamic rules out of this reserve. Diffs are small, so all 77 lists stay
// current even though only ~57 fit in the band as full copies.
//
// This is finite, not perpetual: deltas accumulate as lists drift from the
// baseline they were built against. When the reserve fills, a rebuild resets the
// baseline and reclaims it. The dashboard warns before that point.
const TARGET_MAX_STATIC_RULESETS = 50;   // hard ceiling on ENABLED rulesets
const TARGET_MAX_DYNAMIC_RULES = 22000;  // lists + whitelist only
export const DELTA_RESERVE = 6000;

const SAFE_ACTIONS = new Set([ 'block', 'allow', 'allowAllRequests', 'upgradeScheme' ]);

function isRule(r) { return r._error === undefined && r.action !== undefined; }

// Every regexFilter is validated with real RE2 before emission. Chrome refuses
// the ENTIRE ruleset over one incompatible pattern -- "adguard-generic.json:
// Rule with id 5164 specifies an incorrect value for the regexFilter key" cost a
// failed install -- so an unusable pattern must never reach the browser.
const droppedRegex = [];
const strippedKeys = new Map();

async function compile(lists) {
    const res = await dnrRulesetFromRawLists(lists, { ...DNR_OPTIONS });
    const emitted = res.network.ruleset || [];
    const { kept, dropped } = filterValidRegexRules(emitted.filter(isRule));
    for ( const d of dropped ) {
        droppedRegex.push({ from: lists.map(l => l.name).join(','), ...d });
    }
    // Remove ubo-core's internal bookkeeping keys; Chrome's dynamic-rule API
    // rejects the whole batch over a single unknown property.
    const { rules, stripped } = sanitizeRules(kept);
    for ( const [ k, n ] of stripped ) {
        strippedKeys.set(k, (strippedKeys.get(k) ?? 0) + n);
    }
    return { rules, result: res };
}

// Rules are renumbered per ruleset; Chrome requires unique ids within a ruleset.
function renumber(rules, startAt = 1) {
    return rules.map((r, i) => ({ ...r, id: startAt + i }));
}

function statsOf(rules) {
    let unsafe = 0, regex = 0;
    for ( const r of rules ) {
        if ( SAFE_ACTIONS.has(r.action.type) === false ) { unsafe += 1; }
        if ( r.condition && r.condition.regexFilter !== undefined ) { regex += 1; }
    }
    return { total: rules.length, unsafe, regex };
}

function slug(token) {
    return token
        .replace(/^https?:\/\//, '')
        .replace(/[^a-zA-Z0-9._-]+/g, '_')
        .slice(0, 60);
}

async function main() {
    const backup = readBackup();
    console.log(describeConfig(backup));
    console.log();
    const fetched = JSON.parse(readFileSync(resolve(BUILD, 'lists.fetched.json'), 'utf-8'));
    const resolvedMeta = JSON.parse(readFileSync(resolve(BUILD, 'lists.resolved.json'), 'utf-8')).resolved;
    const measurement = JSON.parse(readFileSync(resolve(BUILD, 'split.measurement.json'), 'utf-8'));

    const metaByToken = new Map(resolvedMeta.map(r => [ r.token, r ]));
    const textByToken = new Map(fetched.map(f => [ f.token, readFileSync(f.path, 'utf-8') ]));
    const costByToken = new Map(measurement.rows.map(r => [ r.token, r.total ]));

    // --- plan the split -------------------------------------------------------
    // Custom URL lists and the user's own filters are always dynamic: they are
    // the ones the user edits and expects "Update all" to refresh.
    const alwaysDynamic = new Set(
        resolvedMeta.filter(r => r.kind === 'url').map(r => r.token)
    );

    const catalogTokens = resolvedMeta
        .filter(r => alwaysDynamic.has(r.token) === false)
        .map(r => r.token)
        .sort((a, b) => (costByToken.get(b) ?? 0) - (costByToken.get(a) ?? 0));

    // Policy: fill the dynamic band with as MANY lists as it will hold, cheapest
    // first, because each list that lands there is one more that updates without
    // a rebuild. Whatever will not fit becomes a static ruleset.
    //
    // Cheapest-first is what maximises the count: spending the budget on a few
    // expensive lists would buy far fewer auto-updating lists for the same rules.
    // The user's own custom URL lists are forced dynamic regardless of cost --
    // those are the ones they edit and most expect to refresh.
    const cheapestFirst = catalogTokens.slice().sort(
        (a, b) => (costByToken.get(a) ?? 0) - (costByToken.get(b) ?? 0)
    );

    const dynamicTokens = [ ...alwaysDynamic ];
    let dynamicBudget = backup.whitelist.length
        + (costByToken.get('user-filters') ?? 0)
        + [ ...alwaysDynamic ].reduce((n, t) => n + (costByToken.get(t) ?? 0), 0);

    if ( dynamicBudget > TARGET_MAX_DYNAMIC_RULES ) {
        throw new Error(
            `the always-dynamic set alone needs ${dynamicBudget} rules, over the ` +
            `${TARGET_MAX_DYNAMIC_RULES} target (hard limit ${LIMITS.MAX_NUMBER_OF_DYNAMIC_RULES})`
        );
    }

    const staticTokens = [];
    for ( const token of cheapestFirst ) {
        const cost = costByToken.get(token) ?? 0;
        if ( (dynamicBudget + cost) <= TARGET_MAX_DYNAMIC_RULES ) {
            dynamicTokens.push(token);
            dynamicBudget += cost;
        } else {
            staticTokens.push(token);
        }
    }
    // Largest first, so the biggest rulesets are emitted (and reported) first.
    staticTokens.sort((a, b) => (costByToken.get(b) ?? 0) - (costByToken.get(a) ?? 0));

    if ( staticTokens.length > LIMITS.MAX_NUMBER_OF_ENABLED_STATIC_RULESETS ) {
        throw new Error(
            `${staticTokens.length} static rulesets exceeds the enabled limit of ` +
            `${LIMITS.MAX_NUMBER_OF_ENABLED_STATIC_RULESETS}; lower TARGET_MAX_DYNAMIC_RULES ` +
            `so more lists stay static`
        );
    }

    const totalLists = staticTokens.length + dynamicTokens.length;
    console.log('SPLIT PLAN');
    console.log('='.repeat(70));
    console.log(`  AUTO-UPDATING (dynamic): ${dynamicTokens.length} of ${totalLists} lists ` +
        `(${((dynamicTokens.length / totalLists) * 100).toFixed(0)}%)`);
    console.log(`     ~${dynamicBudget.toLocaleString()} rules / ${TARGET_MAX_DYNAMIC_RULES.toLocaleString()} target ` +
        `(${LIMITS.MAX_NUMBER_OF_DYNAMIC_RULES.toLocaleString()} hard)`);
    console.log(`  REBUILD-ONLY (static):   ${staticTokens.length} lists, ` +
        `${LIMITS.MAX_NUMBER_OF_ENABLED_STATIC_RULESETS} ruleset limit`);

    // --- emit static rulesets -------------------------------------------------
    if ( existsSync(DIST) ) { rmSync(DIST, { recursive: true, force: true }); }
    mkdirSync(resolve(DIST, 'rulesets'), { recursive: true });

    const rulesetManifest = [];
    const listCatalog = [];
    let totalStaticRules = 0;
    let totalStaticRegex = 0;

    for ( const token of staticTokens ) {
        const text = textByToken.get(token);
        if ( text === undefined ) { throw new Error(`no text for static list ${token}`); }
        const { rules } = await compile([ { name: token, text } ]);
        const numbered = renumber(rules);
        const s = statsOf(numbered);
        totalStaticRules += s.total;
        totalStaticRegex += s.regex;

        const id = slug(token);
        const path = `rulesets/${id}.json`;
        writeFileSync(resolve(DIST, path), JSON.stringify(numbered));

        // Baselines are NOT written here: the regex prune runs after this step
        // and removes rules, so a baseline captured now would describe rules that
        // never shipped. tools/emit-baselines.mjs derives them from the final
        // ruleset files instead.
        rulesetManifest.push({ id, enabled: true, path });
        listCatalog.push({
            token, id, kind: 'static',
            title: metaByToken.get(token)?.title ?? token,
            rules: s.total, regex: s.regex,
            // Needed at runtime: a static list is refetched from these to diff
            // against its baseline, which is how it stays updatable despite
            // living in an immutable ruleset.
            urls: metaByToken.get(token)?.urls ?? [],
        });
        console.log(`  [static]  ${String(s.total).padStart(6)} rules  ${token}`);
    }

    // --- emit dynamic seed ----------------------------------------------------
    // Shipped as data, installed into the dynamic ruleset by the service worker,
    // and refreshable from source at runtime.
    const dynamicLists = [];
    for ( const token of dynamicTokens ) {
        const text = textByToken.get(token);
        if ( text === undefined ) { continue; }
        const { rules } = await compile([ { name: token, text } ]);
        const s = statsOf(rules);
        dynamicLists.push({
            token,
            kind: metaByToken.get(token)?.kind === 'url' ? 'url' : 'catalog',
            title: metaByToken.get(token)?.title ?? token,
            urls: metaByToken.get(token)?.urls ?? [ token ],
            rules,
        });
        listCatalog.push({
            token, id: slug(token), kind: 'dynamic',
            title: metaByToken.get(token)?.title ?? token,
            rules: s.total, regex: s.regex,
        });
    }
    const dynamicRuleCount = dynamicLists.reduce((n, l) => n + l.rules.length, 0);
    console.log(`  [dynamic] ${dynamicRuleCount} rules across ${dynamicLists.length} lists`);

    writeFileSync(resolve(DIST, 'rulesets', 'dynamic-seed.json'), JSON.stringify(dynamicLists));

    // Cosmetic and scriptlet payloads are NOT emitted here. tools/emit-cosmetic.mjs
    // owns them, because they need per-hostname sharding rather than one blob.
    // This step used to compile the whole corpus a second time just to write a
    // 27.7 MiB data/cosmetic.json that emit-cosmetic then deleted.
    mkdirSync(resolve(DIST, 'data'), { recursive: true });

    // --- emit the user's config, in uBO backup shape --------------------------
    writeFileSync(resolve(DIST, 'data', 'default-config.json'), JSON.stringify({
        version: backup.version,
        timeStamp: backup.timeStamp,
        userSettings: backup.userSettings,
        selectedFilterLists: backup.selectedFilterLists,
        hiddenSettings: backup.hiddenSettings ?? {},
        whitelist: backup.whitelist,
        dynamicFilteringString: backup.dynamicFilteringString ?? '',
        urlFilteringString: backup.urlFilteringString ?? '',
        hostnameSwitchesString: backup.hostnameSwitchesString ?? '',
        userFilters: backup.userFilters,
    }));
    writeFileSync(resolve(DIST, 'data', 'list-catalog.json'), JSON.stringify(listCatalog, null, 2));

    // --- report ---------------------------------------------------------------
    console.log();
    console.log('BUDGET CHECK');
    console.log('='.repeat(70));
    const ok = [];
    const check = (label, value, limit) => {
        const pass = value <= limit;
        ok.push(pass);
        console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label.padEnd(42)} ${String(value).padStart(7)} / ${limit}`);
    };
    check('enabled static rulesets', rulesetManifest.length, LIMITS.MAX_NUMBER_OF_ENABLED_STATIC_RULESETS);
    check('total static rules', totalStaticRules, LIMITS.GLOBAL_STATIC_RULE_LIMIT);
    check('dynamic rules (lists only)', dynamicRuleCount, LIMITS.MAX_NUMBER_OF_DYNAMIC_RULES);
    check('dynamic rules (+ whitelist)', dynamicRuleCount + backup.whitelist.length, LIMITS.MAX_NUMBER_OF_DYNAMIC_RULES);
    check('regex rules (static + dynamic)',
        totalStaticRegex + dynamicLists.reduce((n, l) => n + statsOf(l.rules).regex, 0),
        LIMITS.MAX_NUMBER_OF_REGEX_RULES);

    if ( strippedKeys.size !== 0 ) {
        console.log();
        console.log('STRIPPED non-DNR properties (ubo-core internals):');
        for ( const [ k, n ] of [ ...strippedKeys ].sort((a, b) => b[1] - a[1]) ) {
            console.log(`  ${k.padEnd(22)} ${n.toLocaleString()}`);
        }
    }

    // Report every regex dropped for RE2 incompatibility. These are real filters
    // that will not be enforced, so the loss is named rather than counted.
    console.log();
    if ( droppedRegex.length === 0 ) {
        console.log('RE2: all regexFilter patterns compatible');
    } else {
        // The full-corpus cosmetic compile re-walks every list, so the same
        // pattern is seen more than once; report each distinct pattern once.
        const unique = new Map();
        for ( const d of droppedRegex ) {
            if ( unique.has(d.regexFilter) === false ) { unique.set(d.regexFilter, d); }
        }
        console.log(`RE2-INCOMPATIBLE REGEX DROPPED: ${unique.size} distinct pattern(s)`);
        for ( const d of unique.values() ) {
            console.log(`  [${d.from}] ${d.reason}`);
            console.log(`      ${d.regexFilter.slice(0, 130)}`);
        }
        writeFileSync(resolve(BUILD, 'regex.dropped.json'),
            JSON.stringify([ ...unique.values() ], null, 2));
    }

    writeFileSync(resolve(BUILD, 'emit.plan.json'), JSON.stringify({
        staticTokens, dynamicTokens, rulesetManifest,
        totalStaticRules, dynamicRuleCount, totalStaticRegex,
    }, null, 2));

    // The ruleset declarations the manifest needs.
    writeFileSync(resolve(BUILD, 'rule_resources.json'), JSON.stringify(rulesetManifest, null, 2));
    console.log(`\nwrote extension/ (${rulesetManifest.length} static rulesets) and build/rule_resources.json`);

    if ( ok.includes(false) ) {
        console.error('\nBUDGET EXCEEDED - not shippable as planned.');
        process.exitCode = 1;
    }
}

main().catch(err => {
    console.error('EMIT FAILED:', err.message);
    console.error(err.stack);
    process.exitCode = 1;
});
