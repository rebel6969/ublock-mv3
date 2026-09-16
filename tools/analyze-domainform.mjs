// How many rules are pure domain anchors that could be rewritten to domain form?
//
// uBO emits `||ads.example.com^` as `urlFilter: "||ads.example.com^"`, one rule
// per filter. But that pattern means "host is ads.example.com or a subdomain of
// it", which is exactly what `requestDomains: ["ads.example.com"]` means. Rules
// rewritten that way can then be merged by the thousand into a single rule with a
// packed domain list -- the same trick that turns GoodbyeAds' 277,808 hosts
// entries into ONE rule.
//
// If enough of the corpus converts, everything fits in the 30,000 dynamic band
// and no list ever needs a rebuild.
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from './lib/backup.mjs';

const DIST = resolve(ROOT, 'extension');

// `||host^` with nothing else: no path, no wildcard, no query. The trailing ^ is
// a separator anchor, which for a bare host means "end of host".
const PURE_DOMAIN_ANCHOR = /^\|\|([a-z0-9][a-z0-9.-]*[a-z0-9])\^$/i;

// Condition keys that are safe to carry through a rewrite unchanged. Anything
// else means the rule constrains something we would have to preserve per-rule,
// so it must not be merged.
const CARRYABLE = new Set([
    'urlFilter', 'resourceTypes', 'excludedResourceTypes',
    'domainType', 'isUrlFilterCaseSensitive', 'requestMethods',
    'initiatorDomains', 'excludedInitiatorDomains',
    'excludedRequestDomains', 'requestDomains',
]);

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
    console.log(`rules: ${rules.length.toLocaleString()}`);

    let convertible = 0;
    let notPureAnchor = 0;
    let blockedByOtherKeys = 0;
    let alreadyDomainForm = 0;
    const reasons = new Map();

    // Group convertible rules by everything except the domain, so we can count
    // how few rules they collapse into.
    const groups = new Map();

    for ( const rule of rules ) {
        const cond = rule.condition ?? {};
        const uf = cond.urlFilter;
        if ( uf === undefined ) {
            alreadyDomainForm += 1;
            continue;
        }
        const m = PURE_DOMAIN_ANCHOR.exec(uf);
        if ( m === null ) {
            notPureAnchor += 1;
            // Record why, to see what the remainder actually looks like.
            const kind = /[*^]/.test(uf.slice(2, -1)) ? 'wildcard/separator inside'
                : uf.startsWith('||') === false ? 'not domain-anchored'
                : uf.endsWith('^') === false ? 'no trailing separator'
                : 'other';
            reasons.set(kind, (reasons.get(kind) ?? 0) + 1);
            continue;
        }
        // requestDomains already present would conflict with the rewrite.
        if ( cond.requestDomains !== undefined ) { blockedByOtherKeys += 1; continue; }
        const foreign = Object.keys(cond).filter(k => CARRYABLE.has(k) === false);
        if ( foreign.length !== 0 ) {
            blockedByOtherKeys += 1;
            reasons.set(`foreign key: ${foreign.join(',')}`,
                (reasons.get(`foreign key: ${foreign.join(',')}`) ?? 0) + 1);
            continue;
        }

        convertible += 1;
        const rest = {};
        for ( const k of Object.keys(cond).sort() ) {
            if ( k === 'urlFilter' ) { continue; }
            rest[k] = cond[k];
        }
        const sig = JSON.stringify({ priority: rule.priority ?? null, action: rule.action, condition: rest });
        let g = groups.get(sig);
        if ( g === undefined ) { groups.set(sig, g = { domains: new Set(), count: 0 }); }
        g.domains.add(m[1].toLowerCase());
        g.count += 1;
    }

    console.log(`\n--- classification ---`);
    console.log(`  pure domain anchors, convertible : ${convertible.toLocaleString()}`);
    console.log(`  already domain-form (no urlFilter): ${alreadyDomainForm.toLocaleString()}`);
    console.log(`  urlFilter but not a pure anchor  : ${notPureAnchor.toLocaleString()}`);
    console.log(`  blocked by other condition keys  : ${blockedByOtherKeys.toLocaleString()}`);

    console.log(`\n--- why the rest cannot convert ---`);
    for ( const [ k, n ] of [ ...reasons ].sort((a, b) => b[1] - a[1]).slice(0, 8) ) {
        console.log(`  ${String(n).padStart(7)}  ${k}`);
    }

    console.log(`\n--- after rewriting + merging ---`);
    console.log(`  ${convertible.toLocaleString()} convertible rules -> ${groups.size.toLocaleString()} merged rules`);
    const remainder = rules.length - convertible;
    const projected = remainder + groups.size;
    console.log(`  untouched rules: ${remainder.toLocaleString()}`);
    console.log(`  projected total: ${projected.toLocaleString()} / 30,000 dynamic`);
    console.log(`  FITS: ${projected <= 30000 ? 'YES' : 'NO'}` +
        (projected > 30000 ? `  (over by ${(projected - 30000).toLocaleString()})` : ''));

    const top = [ ...groups.values() ].sort((a, b) => b.count - a.count).slice(0, 8);
    console.log(`\n--- largest groups ---`);
    for ( const g of top ) {
        console.log(`  ${String(g.count).padStart(7)} rules -> 1 rule, ${g.domains.size.toLocaleString()} domains`);
    }
}

main();
