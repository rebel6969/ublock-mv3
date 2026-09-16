// Measure each selected list's DNR cost individually, and classify every rule as
// DNR-"safe" or "unsafe" per Chrome's definition. This decides, from real numbers,
// which lists can live in the runtime-updatable dynamic ruleset (30,000 rules,
// of which at most 5,000 unsafe) and which must ship as immutable static rulesets.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, readBackup } from './lib/backup.mjs';
import { dnrRulesetFromRawLists } from '@gorhill/ubo-core/js/static-dnr-filtering.js';
import { DNR_OPTIONS } from './lib/env.mjs';

const BUILD = resolve(ROOT, 'build');

// Verbatim from the Chrome 152 API schema.
const LIMITS = {
    MAX_NUMBER_OF_DYNAMIC_RULES: 30000,
    MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES: 5000,
    MAX_NUMBER_OF_REGEX_RULES: 1000,
    GUARANTEED_MINIMUM_STATIC_RULES: 30000,
    MAX_NUMBER_OF_ENABLED_STATIC_RULESETS: 50,
};

// Chrome: a rule is "safe" if its action is block, allow, allowAllRequests or
// upgradeScheme. redirect and modifyHeaders are unsafe and use the smaller quota.
const SAFE_ACTIONS = new Set([ 'block', 'allow', 'allowAllRequests', 'upgradeScheme' ]);

function classify(ruleset) {
    let safe = 0, unsafe = 0, regex = 0, errors = 0;
    for ( const r of ruleset ) {
        if ( r._error !== undefined || r.action === undefined ) { errors += 1; continue; }
        if ( SAFE_ACTIONS.has(r.action.type) ) { safe += 1; } else { unsafe += 1; }
        if ( r.condition && r.condition.regexFilter !== undefined ) { regex += 1; }
    }
    return { total: safe + unsafe, safe, unsafe, regex, errors };
}

async function compileOne(name, text) {
    const result = await dnrRulesetFromRawLists([ { name, text } ], {
        ...DNR_OPTIONS,
    });
    return classify(result.network.ruleset || []);
}

async function main() {
    const backup = readBackup();
    const fetched = JSON.parse(readFileSync(resolve(BUILD, 'lists.fetched.json'), 'utf-8'));
    const resolvedMeta = JSON.parse(readFileSync(resolve(BUILD, 'lists.resolved.json'), 'utf-8')).resolved;
    const metaByToken = new Map(resolvedMeta.map(r => [ r.token, r ]));

    const jobs = fetched.map(f => ({
        token: f.token,
        kind: metaByToken.get(f.token)?.kind ?? 'filters',
        text: readFileSync(f.path, 'utf-8'),
    }));
    jobs.push({ token: 'user-filters', kind: 'user', text: backup.userFilters });

    const rows = [];
    for ( const job of jobs ) {
        const stats = await compileOne(job.token, job.text);
        rows.push({ token: job.token, kind: job.kind, ...stats });
    }
    rows.sort((a, b) => b.total - a.total);

    console.log('PER-LIST DNR COST (compiled individually)');
    console.log('='.repeat(84));
    console.log('  rules     safe   unsafe  regex  err   kind      list');
    console.log('-'.repeat(84));
    for ( const r of rows ) {
        console.log(
            `  ${String(r.total).padStart(7)} ${String(r.safe).padStart(8)} ${String(r.unsafe).padStart(7)} ` +
            `${String(r.regex).padStart(6)} ${String(r.errors).padStart(4)}   ${r.kind.padEnd(9)} ${r.token}`
        );
    }

    const sum = k => rows.reduce((n, r) => n + r[k], 0);
    console.log('-'.repeat(84));
    console.log(`  ${String(sum('total')).padStart(7)} ${String(sum('safe')).padStart(8)} ${String(sum('unsafe')).padStart(7)} ${String(sum('regex')).padStart(6)} ${String(sum('errors')).padStart(4)}   TOTAL (sum of isolated compiles)`);

    // Candidates for the runtime-updatable dynamic ruleset: the user's own
    // filters plus the custom URL-based lists they added by hand.
    const dynamicCandidates = rows.filter(r => r.kind === 'url' || r.kind === 'user');
    const dynTotal = dynamicCandidates.reduce((n, r) => n + r.total, 0);
    const dynUnsafe = dynamicCandidates.reduce((n, r) => n + r.unsafe, 0);
    const dynRegex = dynamicCandidates.reduce((n, r) => n + r.regex, 0);

    console.log();
    console.log('='.repeat(84));
    console.log('RUNTIME-UPDATABLE CANDIDATES (custom URL lists + your own filters)');
    console.log('='.repeat(84));
    for ( const r of dynamicCandidates ) {
        console.log(`  ${String(r.total).padStart(7)} rules  ${r.token}`);
    }
    const fits = dynTotal <= LIMITS.MAX_NUMBER_OF_DYNAMIC_RULES
        && dynUnsafe <= LIMITS.MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES;
    console.log(`  ----`);
    console.log(`  total  ${dynTotal} / ${LIMITS.MAX_NUMBER_OF_DYNAMIC_RULES} dynamic`);
    console.log(`  unsafe ${dynUnsafe} / ${LIMITS.MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES} unsafe-dynamic`);
    console.log(`  regex  ${dynRegex}`);
    console.log(`  plus whitelist ${backup.whitelist.length} allow rules -> ${dynTotal + backup.whitelist.length} / ${LIMITS.MAX_NUMBER_OF_DYNAMIC_RULES}`);
    console.log(`  VERDICT: runtime "Update all" for these lists ${fits ? 'IS FEASIBLE' : 'DOES NOT FIT'}`);

    writeFileSync(resolve(BUILD, 'split.measurement.json'), JSON.stringify({ rows, LIMITS }, null, 2));
    console.log(`\nwrote build/split.measurement.json`);
}

main().catch(err => {
    console.error('MEASURE FAILED:', err.message);
    console.error(err.stack);
    process.exitCode = 1;
});
