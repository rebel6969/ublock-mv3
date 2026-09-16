// Inspect how individual filter lists compile to DNR. Use this to explain any
// list whose rule count looks wrong, instead of assuming the number is fine.
//
//   node tools/inspect-list.mjs plowe-0 KOR-1
//   node tools/inspect-list.mjs --anomalies
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from './lib/backup.mjs';
import { dnrRulesetFromRawLists } from '@gorhill/ubo-core/js/static-dnr-filtering.js';
import { DNR_OPTIONS } from './lib/env.mjs';

const BUILD = resolve(ROOT, 'build');
const fetched = JSON.parse(readFileSync(resolve(BUILD, 'lists.fetched.json'), 'utf-8'));
const byToken = new Map(fetched.map(f => [ f.token, f ]));

const count = v => {
    if ( !v ) { return 0; }
    if ( Array.isArray(v) ) { return v.length; }
    return v.size ?? Object.keys(v).length;
};

async function inspect(token) {
    const f = byToken.get(token);
    console.log('='.repeat(72));
    if ( f === undefined ) {
        console.log(`### ${token}: NOT FETCHED`);
        return;
    }
    const text = readFileSync(f.path, 'utf-8');
    const lines = text.split('\n');
    const payload = lines.filter(l => {
        const s = l.trim();
        return s !== '' && s.startsWith('!') === false && s.startsWith('#') === false;
    });
    console.log(`### ${token}`);
    console.log(`  bytes=${text.length.toLocaleString()} lines=${lines.length.toLocaleString()} payload=${payload.length.toLocaleString()}`);
    for ( const l of payload.slice(0, 3) ) {
        console.log(`    | ${l.slice(0, 96)}`);
    }

    const res = await dnrRulesetFromRawLists([ { name: token, text } ], DNR_OPTIONS);
    const all = res.network.ruleset || [];
    const rules = all.filter(r => r._error === undefined);
    console.log(`  -> ${rules.length} DNR rule(s), ${all.length - rules.length} rejected`);

    let domainTotal = 0;
    for ( const r of rules ) {
        const c = r.condition || {};
        const doms = c.requestDomains || c.initiatorDomains;
        if ( doms ) { domainTotal += doms.length; }
    }
    if ( domainTotal !== 0 ) {
        console.log(`  -> ${domainTotal.toLocaleString()} domains packed into condition arrays`);
    }
    for ( const r of rules.slice(0, 2) ) {
        const c = r.condition || {};
        const doms = c.requestDomains || c.initiatorDomains;
        console.log(`     action=${r.action?.type} urlFilter=${JSON.stringify(c.urlFilter ?? null)} ` +
            `domains=${doms ? doms.length : 0} types=${c.resourceTypes ? c.resourceTypes.length : 'all'}`);
        if ( doms ) { console.log(`     sample: ${doms.slice(0, 4).join(', ')}`); }
    }
    console.log(`  cosmetic: specific=${count(res.specificCosmetic)} generic=${count(res.genericCosmetic)} scriptlet=${count(res.scriptlet)}`);
}

const ANOMALIES = [ 'plowe-0', 'dpollock-0', 'POL-3', 'ublock-experimental', 'KOR-1', 'IRN-0' ];

async function main() {
    let tokens = process.argv.slice(2);
    if ( tokens.length === 0 || tokens[0] === '--anomalies' ) {
        tokens = ANOMALIES.slice();
        for ( const f of fetched ) {
            if ( /GoodbyeAds|winhelp2002|pup-filter/.test(f.token) ) { tokens.push(f.token); }
        }
    }
    for ( const t of tokens ) { await inspect(t); }
}

main().catch(err => { console.error(err); process.exitCode = 1; });
