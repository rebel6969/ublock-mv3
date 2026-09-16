// Compile the fetched filter lists into declarativeNetRequest rules using uBO's
// own static filtering engine, then report the result against Chrome's DNR
// budget. This step is measurement-first: it prints exactly what fits and what
// does not, so the architecture is chosen from real numbers, not estimates.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, readBackup } from './lib/backup.mjs';
import { dnrRulesetFromRawLists } from '@gorhill/ubo-core/js/static-dnr-filtering.js';
import { DNR_OPTIONS } from './lib/env.mjs';

const BUILD = resolve(ROOT, 'build');

// Chrome DNR budget, extracted verbatim from the declarativeNetRequest API
// schema compiled into Chrome 152.0.7977.83's chrome.dll. Not from memory:
// the combined dynamic+session limit of 5000 is deprecated there in favour of
// separate 30000/5000 budgets, which materially changes what is buildable.
const LIMITS = {
    GUARANTEED_MINIMUM_STATIC_RULES: 30000,
    GLOBAL_STATIC_RULE_LIMIT: 330000,
    MAX_NUMBER_OF_DYNAMIC_RULES: 30000,
    MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES: 5000,
    MAX_NUMBER_OF_SESSION_RULES: 5000,
    MAX_REGEX_RULES: 1000,
    MAX_ENABLED_STATIC_RULESETS: 50,
    MAX_STATIC_RULESETS: 100,
};

function pct(n, d) {
    return `${((n / d) * 100).toFixed(1)}%`;
}

async function main() {
    const backup = readBackup();
    const fetched = JSON.parse(readFileSync(resolve(BUILD, 'lists.fetched.json'), 'utf-8'));

    const lists = fetched.map(f => ({
        name: f.token,
        text: readFileSync(f.path, 'utf-8'),
    }));
    // The user's own filters are part of the corpus, not an afterthought.
    lists.push({ name: 'user-filters', text: backup.userFilters });

    const rawBytes = lists.reduce((n, l) => n + l.text.length, 0);
    const rawLines = lists.reduce((n, l) => n + l.text.split('\n').length, 0);
    console.log(`compiling ${lists.length} lists: ${(rawBytes / 1048576).toFixed(2)} MiB, ${rawLines.toLocaleString()} lines`);

    const t0 = Date.now();
    const result = await dnrRulesetFromRawLists(lists, { ...DNR_OPTIONS });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    // ubo-core returns real DNR rules and `_error` diagnostics in one array.
    // A diagnostic may still carry a `condition` (e.g. a rejected regex filter),
    // so it must be excluded by `_error`, not by shape -- counting them inflates
    // both the rule total and, more dangerously, the regex budget.
    const emitted = result.network.ruleset || [];
    const ruleset = emitted.filter(r => r._error === undefined);
    const rejected = emitted.filter(r => r._error !== undefined);

    const regexRules = ruleset.filter(r => r.condition && r.condition.regexFilter !== undefined);
    const removeParam = ruleset.filter(r => r.action && r.action.type === 'redirect' && r.action.redirect && r.action.redirect.transform);
    const byAction = {};
    for ( const r of ruleset ) {
        const t = (r.action && r.action.type) || '?';
        byAction[t] = (byAction[t] || 0) + 1;
    }

    // Classify why filters were rejected, so the loss is visible and explicable
    // rather than an opaque count.
    // ubo-core formats these as "<reason>: <offending filter>". Grouping on the
    // reason prefix yields the real taxonomy of what MV3 cannot express.
    const rejectReasons = {};
    for ( const r of rejected ) {
        const msg = Array.isArray(r._error) ? r._error[0] : String(r._error);
        const kind = msg.split(':', 1)[0].trim();
        rejectReasons[kind] = (rejectReasons[kind] || 0) + 1;
    }

    console.log(`\ncompiled in ${elapsed}s`);
    console.log('='.repeat(64));
    console.log('NETWORK (declarativeNetRequest)');
    console.log('='.repeat(64));
    console.log(`  total DNR rules        ${ruleset.length.toLocaleString()}`);
    for ( const [ t, n ] of Object.entries(byAction).sort((a, b) => b[1] - a[1]) ) {
        console.log(`    action=${t.padEnd(18)} ${n.toLocaleString()}`);
    }
    console.log(`  rejected filters       ${rejected.length.toLocaleString()} (not rules; excluded from every count below)`);
    for ( const [ k, n ] of Object.entries(rejectReasons).sort((a, b) => b[1] - a[1]) ) {
        console.log(`    ${k.padEnd(24)} ${n.toLocaleString()}`);
    }
    console.log(`  regex rules            ${regexRules.length.toLocaleString()} / ${LIMITS.MAX_REGEX_RULES} (${pct(regexRules.length, LIMITS.MAX_REGEX_RULES)})`);
    console.log(`  removeparam/transform  ${removeParam.length.toLocaleString()}`);
    console.log();
    console.log(`  vs GUARANTEED_MINIMUM_STATIC_RULES (${LIMITS.GUARANTEED_MINIMUM_STATIC_RULES.toLocaleString()}): ${pct(ruleset.length, LIMITS.GUARANTEED_MINIMUM_STATIC_RULES)}`);
    console.log(`  vs GLOBAL_STATIC_RULE_LIMIT (${LIMITS.GLOBAL_STATIC_RULE_LIMIT.toLocaleString()}):        ${pct(ruleset.length, LIMITS.GLOBAL_STATIC_RULE_LIMIT)}`);
    const rulesetsNeeded = Math.ceil(ruleset.length / LIMITS.GUARANTEED_MINIMUM_STATIC_RULES);
    console.log(`  static rulesets needed @30k each: ${rulesetsNeeded} (max enabled ${LIMITS.MAX_ENABLED_STATIC_RULESETS})`);
    console.log(`  FITS IN GLOBAL LIMIT: ${ruleset.length <= LIMITS.GLOBAL_STATIC_RULE_LIMIT ? 'YES' : 'NO'}`);
    console.log(`  REGEX WITHIN LIMIT:   ${regexRules.length <= LIMITS.MAX_REGEX_RULES ? 'YES' : 'NO'}`);

    const count = v => {
        if ( v === undefined || v === null ) { return 0; }
        if ( Array.isArray(v) ) { return v.length; }
        if ( v instanceof Map || v instanceof Set ) { return v.size; }
        if ( typeof v === 'object' ) { return Object.keys(v).length; }
        return 0;
    };
    console.log();
    console.log('='.repeat(64));
    console.log('COSMETIC / SCRIPTLET (content-script side, no DNR budget)');
    console.log('='.repeat(64));
    console.log(`  genericCosmetic        ${count(result.genericCosmetic).toLocaleString()}`);
    console.log(`  genericHighCosmetic    ${count(result.genericHighCosmetic).toLocaleString()}`);
    console.log(`  genericCosmeticExcept. ${count(result.genericCosmeticExceptions).toLocaleString()}`);
    console.log(`  specificCosmetic       ${count(result.specificCosmetic).toLocaleString()}`);
    console.log(`  scriptlet              ${count(result.scriptlet).toLocaleString()}`);

    console.log();
    console.log('='.repeat(64));
    console.log("USER'S OWN CONFIG (must fit in dynamic rules)");
    console.log('='.repeat(64));
    console.log(`  whitelist entries      ${backup.whitelist.length} / ${LIMITS.MAX_NUMBER_OF_DYNAMIC_RULES} dynamic (${pct(backup.whitelist.length, LIMITS.MAX_NUMBER_OF_DYNAMIC_RULES)})`);

    mkdirSync(BUILD, { recursive: true });
    // dnr.full.json must contain only valid rules: shipping an `_error` entry to
    // Chrome would fail the whole ruleset load.
    writeFileSync(resolve(BUILD, 'dnr.full.json'), JSON.stringify(ruleset));
    writeFileSync(resolve(BUILD, 'dnr.rejected.json'), JSON.stringify(
        rejected.map(r => (Array.isArray(r._error) ? r._error[0] : String(r._error))),
        null, 2
    ));
    const summary = {
        generatedAt: new Date().toISOString(),
        lists: lists.length,
        rawBytes, rawLines,
        compileSeconds: Number(elapsed),
        network: {
            total: ruleset.length,
            byAction,
            regex: regexRules.length,
            rejected: rejected.length,
            rejectReasons,
        },
        cosmetic: {
            genericCosmetic: count(result.genericCosmetic),
            genericHighCosmetic: count(result.genericHighCosmetic),
            genericCosmeticExceptions: count(result.genericCosmeticExceptions),
            specificCosmetic: count(result.specificCosmetic),
            scriptlet: count(result.scriptlet),
        },
        limits: LIMITS,
    };
    writeFileSync(resolve(BUILD, 'build.summary.json'), JSON.stringify(summary, null, 2));
    console.log(`\nwrote build/dnr.full.json and build/build.summary.json`);
}

main().catch(err => {
    console.error('\nBUILD FAILED:', err.message);
    console.error(err.stack);
    process.exitCode = 1;
});
