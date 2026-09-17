// Rank scriptlet tokens by how many (hostname, filter) pairs depend on them.
// Scriptlet coverage has to be built in priority order; this makes that order
// evidence rather than intuition.
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from './lib/backup.mjs';

const SHARD_DIR = resolve(ROOT, 'build/scriptlet-data');

function main() {
    const files = readdirSync(SHARD_DIR).filter(f => /^scriptlet-\d+\.json$/.test(f));
    const byToken = new Map();
    let pairs = 0;
    const hostsByToken = new Map();

    for ( const f of files ) {
        const shard = JSON.parse(readFileSync(resolve(SHARD_DIR, f), 'utf-8'));
        for ( const [ host, list ] of Object.entries(shard) ) {
            for ( const args of list ) {
                if ( Array.isArray(args) === false || args.length === 0 ) { continue; }
                const token = String(args[0]);
                byToken.set(token, (byToken.get(token) ?? 0) + 1);
                if ( hostsByToken.has(token) === false ) { hostsByToken.set(token, new Set()); }
                hostsByToken.get(token).add(host);
                pairs += 1;
            }
        }
    }

    const rows = Array.from(byToken.entries()).sort((a, b) => b[1] - a[1]);
    console.log(`total (hostname, scriptlet) pairs: ${pairs.toLocaleString()}`);
    console.log(`distinct scriptlet tokens: ${rows.length}`);
    console.log();
    console.log('  pairs    hosts   cum%   scriptlet');
    console.log('-'.repeat(64));
    let cum = 0;
    for ( const [ token, n ] of rows.slice(0, 40) ) {
        cum += n;
        console.log(
            `  ${String(n).padStart(6)}  ${String(hostsByToken.get(token).size).padStart(6)}  ` +
            `${((cum / pairs) * 100).toFixed(1).padStart(5)}   ${token}`
        );
    }
    const top = k => rows.slice(0, k).reduce((s, r) => s + r[1], 0) / pairs * 100;
    console.log();
    for ( const k of [ 5, 10, 15, 20, 30 ] ) {
        console.log(`  top ${String(k).padStart(2)} scriptlets cover ${top(k).toFixed(1)}% of all pairs`);
    }
}

main();
