// How many filter lists can be made runtime-updatable?
//
// Only dynamic rules are writable after install, so every list in the dynamic
// band auto-updates and every list in a static ruleset needs a rebuild. The
// current boundary was chosen to keep static ruleset COUNT low; this asks the
// better question: what boundary maximises the number of AUTO-UPDATING lists
// within the 30,000 dynamic-rule budget?
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, readBackup } from './lib/backup.mjs';

const BUILD = resolve(ROOT, 'build');
const MAX_DYNAMIC = 30000;
const MAX_ENABLED_STATIC_RULESETS = 50;

function main() {
    const { rows } = JSON.parse(readFileSync(resolve(BUILD, 'split.measurement.json'), 'utf-8'));
    const backup = readBackup();
    const whitelist = backup.whitelist.length;

    // Cheapest first: each additional list costs its rule count, and buys one
    // more list that updates without a rebuild.
    const sorted = rows
        .filter(r => r.token !== 'user-filters')
        .slice()
        .sort((a, b) => a.total - b.total);

    console.log(`lists: ${sorted.length}, whitelist: ${whitelist} rules`);
    console.log(`dynamic budget: ${MAX_DYNAMIC.toLocaleString()}`);
    console.log();
    console.log('  dynamic   static   dyn rules   headroom   boundary (largest dynamic list)');
    console.log('-'.repeat(80));

    let cum = whitelist;
    const marks = [];
    for ( let i = 0; i < sorted.length; i++ ) {
        cum += sorted[i].total;
        const staticCount = sorted.length - (i + 1);
        const fits = cum <= MAX_DYNAMIC && staticCount <= MAX_ENABLED_STATIC_RULESETS;
        marks.push({ dynamic: i + 1, staticCount, cum, fits, token: sorted[i].token });
    }

    // Print every few rows plus the region where it stops fitting.
    const interesting = marks.filter((m, i) =>
        i % 5 === 0 || m.fits === false || (marks[i + 1] && marks[i + 1].fits === false)
    );
    for ( const m of interesting ) {
        const pct = ((m.cum / MAX_DYNAMIC) * 100).toFixed(0);
        console.log(
            `  ${String(m.dynamic).padStart(7)} ${String(m.staticCount).padStart(8)} ` +
            `${String(m.cum).padStart(11)} ${String(MAX_DYNAMIC - m.cum).padStart(10)} ` +
            `  ${m.fits ? '' : 'OVER '}${pct}%  ${m.token}`
        );
    }

    const best = [ ...marks ].reverse().find(m => m.fits);
    console.log();
    console.log('='.repeat(80));
    console.log(`MAX auto-updating lists: ${best.dynamic} of ${sorted.length}`);
    console.log(`  dynamic rules at that boundary: ${best.cum.toLocaleString()} / ${MAX_DYNAMIC.toLocaleString()}`);
    console.log(`  static rulesets remaining:      ${best.staticCount}`);

    // A safety margin matters: lists grow upstream, and "Update all" recompiles
    // every enabled list together, which can shift the total either way.
    for ( const target of [ 0.95, 0.90, 0.85, 0.80 ] ) {
        const limit = MAX_DYNAMIC * target;
        const m = [ ...marks ].reverse().find(x => x.cum <= limit && x.staticCount <= MAX_ENABLED_STATIC_RULESETS);
        console.log(`  at ${(target * 100).toFixed(0)}% budget (${limit.toLocaleString()}): ` +
            `${m.dynamic} dynamic / ${m.staticCount} static, ${m.cum.toLocaleString()} rules`);
    }

    console.log();
    console.log('lists that must stay static at the 85% boundary (largest first):');
    const chosen = [ ...marks ].reverse().find(x => x.cum <= MAX_DYNAMIC * 0.85);
    const staticTokens = sorted.slice(chosen.dynamic).reverse();
    for ( const r of staticTokens ) {
        console.log(`  ${String(r.total).padStart(7)}  ${r.token}`);
    }
}

main();
