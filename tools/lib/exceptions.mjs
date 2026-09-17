// Collect `#@#` exception filters, which ubo-core's DNR compiler discards.
//
// dnrRulesetFromRawLists skips every exception (`if ( exception ) { continue; }`)
// for both specific cosmetic filters and scriptlets, and returns global generic
// exceptions without subtracting them. uBlock Origin applies all of them, and
// list maintainers rely on that -- e.g. ublock-experimental cancels an older
// `rpnt` on www.youtube.com and ships a replacement; ignoring the cancellation
// ran both rewrites of YouTube's bootstrap script.
//
// Parsing reuses ubo-core's own preparser, filter parser and result fields, so
// the keys produced here equal the keys in its compiled output exactly.
import * as sfp from '@gorhill/ubo-core/js/static-filtering-parser.js';
import { LineIterator } from '@gorhill/ubo-core/js/text-utils.js';

export function collectExceptions(lists, env) {
    // scriptlet: canonical args key ('' = disable all scriptlets) -> { hosts, generic }
    const scriptlet = new Map();
    // specific cosmetic: compiled selector -> Set(host)
    const cosmetic = new Map();
    // `@@...$generichide` / `$specifichide` / `$elemhide` hosts. uBO gates
    // cosmetic filtering on these (shouldApplyGeneric/SpecificCosmeticFilters);
    // ubo-core's DNR compiler emits nothing for them.
    const hideGeneric = new Set();
    const hideSpecific = new Set();
    const parser = new sfp.AstFilterParser({ toDNR: true });

    const add = (map, key) => {
        let e = map.get(key);
        if ( e === undefined ) { map.set(key, e = { hosts: new Set(), generic: false }); }
        return e;
    };

    for ( const { text } of lists ) {
        const it = new LineIterator(sfp.utils.preparser.prune(text, env));
        while ( it.eot() === false ) {
            const line = it.next();
            parser.parse(line);
            if ( parser.isFilter() === false ) { continue; }

            if ( parser.isNetworkFilter() && parser.isException() ) {
                const hide = hideOptionHosts(line);
                if ( hide !== null ) {
                    if ( hide.generic ) { for ( const h of hide.hosts ) { hideGeneric.add(h); } }
                    if ( hide.specific ) { for ( const h of hide.hosts ) { hideSpecific.add(h); } }
                }
                continue;
            }

            if ( parser.hasError() ) { continue; }
            if ( parser.isExtendedFilter() === false || parser.isException() === false ) { continue; }

            const hosts = [];
            if ( parser.hasOptions() ) {
                for ( const { hn, not, bad } of parser.getExtFilterDomainIterator() ) {
                    if ( bad || not ) { continue; }
                    hosts.push(hn);
                }
            }

            if ( parser.isScriptletFilter() ) {
                const args = parser.getScriptletArgs();
                // Keyed by raw args text; the caller canonicalises the token
                // (aliases such as rpnt -> trusted-replace-node-text) before
                // comparing, since filter and exception may spell it differently.
                const e = add(scriptlet, args.length === 0 ? '' : JSON.stringify(args));
                if ( hosts.length === 0 ) { e.generic = true; }
                for ( const h of hosts ) { e.hosts.add(h); }
                continue;
            }

            // Specific cosmetic exception. Global ones (no hosts) are already
            // reported by ubo-core as genericCosmeticExceptions.
            const { compiled } = parser.result;
            if ( typeof compiled !== 'string' || hosts.length === 0 ) { continue; }
            const set = cosmetic.get(compiled) ?? new Set();
            for ( const h of hosts ) { set.add(h); }
            cosmetic.set(compiled, set);
        }
    }
    return { scriptlet, cosmetic, hideGeneric, hideSpecific };
}

// Hosts an `@@pattern$...hide` exception applies to, or null if it has no
// cosmetic-hide option. Patterns seen in the corpus: `||host^`, `||host.*^`,
// `||host/path`, and `*` / empty with `domain=a|b`. A path is widened to its
// host: that disables hiding on more pages than uBO would, which errs toward
// not breaking a page rather than toward hiding more.
function hideOptionHosts(line) {
    const dollar = line.lastIndexOf('$');
    if ( dollar === -1 ) { return null; }
    const opts = line.slice(dollar + 1).split(',').map(s => s.trim());
    const has = names => opts.some(o => names.includes(o));
    const generic = has([ 'generichide', 'ghide', 'elemhide', 'ehide' ]);
    const specific = has([ 'specifichide', 'shide', 'elemhide', 'ehide' ]);
    if ( generic === false && specific === false ) { return null; }

    const hosts = [];
    const domainOpt = opts.find(o => o.startsWith('domain=') || o.startsWith('from='));
    if ( domainOpt ) {
        for ( const d of domainOpt.slice(domainOpt.indexOf('=') + 1).split('|') ) {
            if ( d !== '' && d.startsWith('~') === false ) { hosts.push(d.toLowerCase()); }
        }
    }
    const pattern = line.slice(2, dollar);          // strip leading @@
    const m = /^\|\|([a-z0-9.*-]+)/i.exec(pattern);
    if ( m ) { hosts.push(m[1].toLowerCase().replace(/\^$/, '')); }
    return hosts.length ? { generic, specific, hosts } : null;
}

// Is exception host `e` relevant to a filter that matches `hosts`? An
// exception only needs recording where it can overlap: same host, a subdomain
// of a matched host, or a parent of one. Entity (`x.*`) and regex hosts are
// kept conservatively, since overlap cannot be decided by suffix.
export function relevantExceptionHosts(exceptionHosts, matchHosts) {
    const out = [];
    for ( const e of exceptionHosts ) {
        for ( const h of matchHosts ) {
            if ( hostsOverlap(e, h) ) { out.push(e); break; }
        }
    }
    return out;
}

// Could a page be matched by both uBO host specs `a` and `b`?
//   plain  "foo.com"  -> foo.com and its subdomains
//   entity "foo.*"    -> foo.<any suffix> and its subdomains
//   regex  "/.../"    -> undecidable statically, so treated as overlapping
function hostsOverlap(a, b) {
    if ( a === '*' || b === '*' ) { return true; }
    if ( a.startsWith('/') || b.startsWith('/') ) { return true; }
    const ea = a.endsWith('.*'), eb = b.endsWith('.*');
    if ( ea === false && eb === false ) {
        return a === b || a.endsWith('.' + b) || b.endsWith('.' + a);
    }
    // An entity base "foo" matches a host whose labels contain "foo." at a
    // label boundary: "foo.com", "www.foo.co.uk".
    const hitsEntity = (host, base) =>
        host.startsWith(base + '.') || host.includes('.' + base + '.');
    if ( ea && eb ) {
        const x = a.slice(0, -2), y = b.slice(0, -2);
        return x === y || x.endsWith('.' + y) || y.endsWith('.' + x);
    }
    return ea ? hitsEntity(b, a.slice(0, -2)) : hitsEntity(a, b.slice(0, -2));
}
