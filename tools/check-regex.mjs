// Audit every regexFilter in the built extension against real RE2.
// Reports exactly which patterns Chrome would refuse, and from which ruleset.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from './lib/backup.mjs';
import { checkRegex } from './lib/re2check.mjs';

const DIST = resolve(ROOT, 'extension');

function auditRules(label, rules, out) {
    for ( const rule of rules ) {
        const pattern = rule.condition?.regexFilter;
        if ( pattern === undefined ) { continue; }
        out.total += 1;
        const verdict = checkRegex(pattern, {
            caseSensitive: rule.condition.isUrlFilterCaseSensitive !== false,
        });
        if ( verdict.ok ) { continue; }
        out.bad.push({ label, id: rule.id, pattern, reason: verdict.reason });
    }
}

function main() {
    const out = { total: 0, bad: [] };

    const manifest = JSON.parse(readFileSync(resolve(DIST, 'manifest.json'), 'utf-8'));
    for ( const entry of manifest.declarative_net_request.rule_resources ) {
        const rules = JSON.parse(readFileSync(resolve(DIST, entry.path), 'utf-8'));
        auditRules(entry.id, rules, out);
    }

    const seedPath = resolve(DIST, 'rulesets', 'dynamic-seed.json');
    if ( existsSync(seedPath) ) {
        for ( const list of JSON.parse(readFileSync(seedPath, 'utf-8')) ) {
            auditRules(`seed:${list.token}`, list.rules ?? [], out);
        }
    }

    console.log(`regexFilter rules audited: ${out.total}`);
    console.log(`RE2-invalid: ${out.bad.length}`);

    if ( out.bad.length !== 0 ) {
        // Group by reason so the failure modes are visible, not just the count.
        const byReason = new Map();
        for ( const b of out.bad ) {
            const key = b.reason;
            if ( byReason.has(key) === false ) { byReason.set(key, []); }
            byReason.get(key).push(b);
        }
        console.log('\n--- by reason ---');
        for ( const [ reason, items ] of [ ...byReason ].sort((a, b) => b[1].length - a[1].length) ) {
            console.log(`\n  ${items.length}x  ${reason}`);
            for ( const b of items.slice(0, 8) ) {
                console.log(`      [${b.label} id=${b.id}] ${b.pattern.slice(0, 120)}`);
            }
            if ( items.length > 8 ) { console.log(`      ... and ${items.length - 8} more`); }
        }
        console.log('\n--- affected rulesets ---');
        const byLabel = new Map();
        for ( const b of out.bad ) { byLabel.set(b.label, (byLabel.get(b.label) ?? 0) + 1); }
        for ( const [ l, n ] of [ ...byLabel ].sort((a, b) => b[1] - a[1]) ) {
            console.log(`  ${String(n).padStart(4)}  ${l}`);
        }
        process.exitCode = 1;
    } else {
        console.log('\nAll regexFilter patterns are RE2-compatible.');
    }
}

main();
