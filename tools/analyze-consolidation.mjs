// Can the whole corpus fit in the 30,000-rule dynamic band?
//
// If it can, there is no static ruleset, no baseline, no delta, and no rebuild:
// every list refetches and recompiles in the browser, exactly like MV2.
//
// The lever is that DNR matches a LIST of domains per rule. uBO already exploits
// this for hosts-format lists (GoodbyeAds: 277,808 domains in ONE rule), but it
// emits one rule per filter for ordinary lists. Rules that differ ONLY by which
// domain they name can be merged into a single rule with a combined domain list.
//
// This measures how far that goes, using the rules already emitted rather than
// theory.
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from './lib/backup.mjs';

const DIST = resolve(ROOT, 'extension');
const BUILD = resolve(ROOT, 'build');

// Domain-valued condition keys. Merging happens across these; everything else
// must match exactly, or the merged rule would change what it matches.
const DOMAIN_KEYS = [
    'requestDomains', 'initiatorDomains',
    'excludedRequestDomains', 'excludedInitiatorDomains',
];

// A rule can only be merged on ONE domain key at a time; combining two rules
// that each constrain a different key would widen both.
function mergeKeyOf(condition) {
    const present = DOMAIN_KEYS.filter(k => Array.isArray(condition[k]) && condition[k].length !== 0);
    return present.length === 1 ? present[0] : null;
}

// Everything about a rule except the domain list it is being merged on. Two rules
// with the same signature are semantically identical apart from their domains.
function signature(rule, mergeKey) {
    const cond = {};
    for ( const key of Object.keys(rule.condition).sort() ) {
        if ( key === mergeKey ) { continue; }
        cond[key] = rule.condition[key];
    }
    return JSON.stringify({
        priority: rule.priority ?? null,
        action: rule.action,
        condition: cond,
    });
}

function loadAllRules() {
    const rules = [];
    const manifestPath = resolve(DIST, 'manifest.json');
    if ( existsSync(manifestPath) ) {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        for ( const e of manifest.declarative_net_request.rule_resources ) {
            rules.push(...JSON.parse(readFileSync(resolve(DIST, e.path), 'utf-8')));
        }
    }
    const seedPath = resolve(DIST, 'rulesets', 'dynamic-seed.json');
    if ( existsSync(seedPath) ) {
        for ( const list of JSON.parse(readFileSync(seedPath, 'utf-8')) ) {
            rules.push(...(list.rules ?? []));
        }
    }
    return rules;
}

function main() {
    const rules = loadAllRules();
    console.log(`rules in the built extension: ${rules.length.toLocaleString()}`);

    // --- what shape are they? ----------------------------------------------
    let urlFilterOnly = 0;       // urlFilter, no domain constraint at all
    let mergeable = 0;           // exactly one domain key -> candidate
    let unmergeable = 0;         // zero or multiple domain keys
    const byMergeKey = new Map();

    const groups = new Map();    // signature -> { key, domains:Set, count }

    for ( const rule of rules ) {
        const cond = rule.condition ?? {};
        const key = mergeKeyOf(cond);
        if ( key === null ) {
            unmergeable += 1;
            if ( cond.urlFilter !== undefined ) { urlFilterOnly += 1; }
            continue;
        }
        mergeable += 1;
        byMergeKey.set(key, (byMergeKey.get(key) ?? 0) + 1);

        const sig = signature(rule, key);
        let g = groups.get(sig);
        if ( g === undefined ) { groups.set(sig, g = { key, domains: new Set(), count: 0 }); }
        for ( const d of cond[key] ) { g.domains.add(d); }
        g.count += 1;
    }

    console.log(`\n--- rule shapes ---`);
    console.log(`  exactly one domain key (mergeable) : ${mergeable.toLocaleString()}`);
    for ( const [ k, n ] of [ ...byMergeKey ].sort((a, b) => b[1] - a[1]) ) {
        console.log(`      ${k.padEnd(28)} ${n.toLocaleString()}`);
    }
    console.log(`  no/multiple domain keys            : ${unmergeable.toLocaleString()}`);
    console.log(`      of which plain urlFilter       : ${urlFilterOnly.toLocaleString()}`);

    // --- how much does merging save? ---------------------------------------
    const mergedRuleCount = groups.size;
    const saved = mergeable - mergedRuleCount;
    console.log(`\n--- merging rules that differ only by domain ---`);
    console.log(`  ${mergeable.toLocaleString()} mergeable rules -> ${mergedRuleCount.toLocaleString()} merged rules`);
    console.log(`  saved: ${saved.toLocaleString()}`);

    const projected = unmergeable + mergedRuleCount;
    console.log(`\n  projected total: ${unmergeable.toLocaleString()} unmergeable + ` +
        `${mergedRuleCount.toLocaleString()} merged = ${projected.toLocaleString()}`);
    console.log(`  dynamic budget:  30,000`);
    console.log(`  FITS ENTIRELY IN DYNAMIC: ${projected <= 30000 ? 'YES' : 'NO'}` +
        (projected > 30000 ? `  (over by ${(projected - 30000).toLocaleString()})` : ''));

    // The biggest groups show where the win comes from.
    const top = [ ...groups.values() ].sort((a, b) => b.count - a.count).slice(0, 10);
    console.log(`\n--- largest merge groups ---`);
    for ( const g of top ) {
        console.log(`  ${String(g.count).padStart(6)} rules -> 1 rule, ${g.domains.size.toLocaleString()} domains (${g.key})`);
    }

    // Domain-array size matters: one rule holding 100k domains is fine for the
    // rule budget but the ruleset JSON still has to be parsed at install.
    const sizes = [ ...groups.values() ].map(g => g.domains.size).sort((a, b) => b - a);
    console.log(`\n  largest merged domain lists: ${sizes.slice(0, 8).map(n => n.toLocaleString()).join(', ')}`);
    const totalDomains = sizes.reduce((a, b) => a + b, 0);
    console.log(`  total domains across merged rules: ${totalDomains.toLocaleString()}`);
}

main();
