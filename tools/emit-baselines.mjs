// Emit a baseline hash index for every static ruleset.
//
// A static ruleset is immutable once packaged, but its rules can be switched off
// individually with updateStaticRules(). Pairing that with dynamic rules for
// additions makes a static list updatable: refetch, recompile, diff against this
// baseline, disable what disappeared, add what is new.
//
// This runs AFTER the regex prune, so the baseline describes the rules that
// actually shipped. Generating it earlier would record rules the prune removed,
// and every update would then try to "disable" ids that were never installed.
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from './lib/backup.mjs';
import { ruleHash } from './lib/rulehash.mjs';

const ROOT_DIR = ROOT;
const DIST = resolve(ROOT_DIR, 'extension');
const BUILD = resolve(ROOT_DIR, 'build');

function main() {
    const resources = JSON.parse(readFileSync(resolve(BUILD, 'rule_resources.json'), 'utf-8'));

    let totalRules = 0;
    let totalBytes = 0;
    let collisions = 0;

    for ( const entry of resources ) {
        const rules = JSON.parse(readFileSync(resolve(DIST, entry.path), 'utf-8'));
        const baseline = {};
        for ( const rule of rules ) {
            const h = ruleHash(rule);
            // A collision would make a changed rule look unchanged, so it is
            // counted rather than silently overwritten.
            if ( baseline[h] !== undefined ) { collisions += 1; }
            baseline[h] = rule.id;
        }
        const path = resolve(DIST, `rulesets/${entry.id}.baseline.json`);
        writeFileSync(path, JSON.stringify(baseline));
        totalRules += rules.length;
        totalBytes += statSync(path).size;
    }

    console.log('BASELINE HASHES');
    console.log('='.repeat(64));
    console.log(`  rulesets:   ${resources.length}`);
    console.log(`  rules:      ${totalRules.toLocaleString()}`);
    console.log(`  hash files: ${(totalBytes / 1048576).toFixed(2)} MiB`);
    console.log(`  hash collisions: ${collisions}`);
    if ( collisions !== 0 ) {
        console.error('\n  ! collisions mean a changed rule can look unchanged; widen the hash.');
        process.exitCode = 1;
    }
}

main();
