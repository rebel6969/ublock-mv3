// Analyze the regexFilter population against Chrome's global 1,000-regex cap.
//
// Chrome compiles each regexFilter with RE2 under a per-rule memory budget and
// rejects patterns that exceed it. Such a rule is dead weight: it costs a slot
// in the 1,000 budget conceptually but never matches anything. Identifying them
// is therefore the correct first move for an over-budget build -- pruning real
// rules should only ever be a last resort, and never silent.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from './lib/backup.mjs';

const BUILD = resolve(ROOT, 'build');
const MAX_REGEX_RULES = 1000;

// RE2's compiled-program budget for DNR is expressed in bytes of pattern memory.
// Pattern length is a sound proxy for triage here; the authoritative verdict comes
// from chrome.declarativeNetRequest.isRegexSupported() inside the extension.
const TRIAGE_BUCKETS = [ 64, 128, 256, 512, 1024, 2048, 4096, 8192, Infinity ];

function main() {
    const rules = JSON.parse(readFileSync(resolve(BUILD, 'dnr.full.json'), 'utf-8'));
    const regexRules = rules.filter(r =>
        r._error === undefined && r.condition && r.condition.regexFilter !== undefined
    );

    console.log(`total rules:       ${rules.length.toLocaleString()}`);
    console.log(`regexFilter rules: ${regexRules.length.toLocaleString()} / ${MAX_REGEX_RULES}` +
        `  (over by ${Math.max(0, regexRules.length - MAX_REGEX_RULES)})`);

    const lengths = regexRules
        .map(r => r.condition.regexFilter.length)
        .sort((a, b) => a - b);
    const at = q => lengths[Math.min(lengths.length - 1, Math.floor(lengths.length * q))];
    console.log(`\npattern length: min=${lengths[0]} p50=${at(0.5)} p90=${at(0.9)} ` +
        `p99=${at(0.99)} max=${lengths[lengths.length - 1].toLocaleString()}`);

    console.log('\n--- length distribution ---');
    let prev = 0;
    for ( const b of TRIAGE_BUCKETS ) {
        const n = lengths.filter(l => l > prev && l <= b).length;
        const label = b === Infinity ? `>${prev}` : `${prev + 1}-${b}`;
        if ( n !== 0 ) {
            console.log(`  ${label.padStart(12)}  ${String(n).padStart(5)}  ${'#'.repeat(Math.ceil(n / 8))}`);
        }
        prev = b;
    }

    // Oversized patterns: the prime suspects for RE2 rejection.
    const OVERSIZE = 2048;
    const oversize = regexRules
        .filter(r => r.condition.regexFilter.length > OVERSIZE)
        .sort((a, b) => b.condition.regexFilter.length - a.condition.regexFilter.length);
    console.log(`\n--- patterns over ${OVERSIZE} chars: ${oversize.length} ---`);
    for ( const r of oversize.slice(0, 12) ) {
        console.log(`  [${String(r.condition.regexFilter.length).padStart(6)}] ${r.condition.regexFilter.slice(0, 90)}...`);
    }

    console.log(`\nIf every pattern over ${OVERSIZE} chars is RE2-rejected, the effective`);
    console.log(`regex count becomes ${regexRules.length - oversize.length} / ${MAX_REGEX_RULES}` +
        ` -> ${regexRules.length - oversize.length <= MAX_REGEX_RULES ? 'WITHIN LIMIT' : 'STILL OVER'}`);

    // Also report how many are negative-lookahead "allowlist-shaped" monsters,
    // which is what the very long patterns tend to be.
    const lookahead = regexRules.filter(r => r.condition.regexFilter.startsWith('^(?!'));
    console.log(`\nnegative-lookahead patterns (^(?!...): ${lookahead.length}`);
    const lookaheadLong = lookahead.filter(r => r.condition.regexFilter.length > OVERSIZE).length;
    console.log(`  of which over ${OVERSIZE} chars: ${lookaheadLong}`);

    writeFileSync(resolve(BUILD, 'regex.analysis.json'), JSON.stringify({
        total: regexRules.length,
        limit: MAX_REGEX_RULES,
        oversizeThreshold: OVERSIZE,
        oversizeCount: oversize.length,
        lengths: { min: lengths[0], p50: at(0.5), p90: at(0.9), p99: at(0.99), max: lengths[lengths.length - 1] },
        oversizePatterns: oversize.map(r => ({
            length: r.condition.regexFilter.length,
            regexFilter: r.condition.regexFilter,
        })),
    }, null, 2));
    console.log(`\nwrote build/regex.analysis.json`);
}

main();
