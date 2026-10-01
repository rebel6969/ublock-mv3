// uBO Lite's network rewrites, for this extension's declarativeNetRequest side.
//
// Lists are resolved the way uBO MV2 resolves them (tools/lib/env.mjs), because
// the in-page side of this extension IS MV2's. Its network side, though, is DNR,
// like uBO Lite's. List maintainers write `!#if ext_ubol` sections for exactly
// that case: RE2-safe rewrites of MV2 filters that DNR cannot compile (regex
// lookaround, entity domains, ...). Under the MV2 env the original is rejected
// and its rewrite is never loaded, so the filter silently vanishes.
//
// Measured 2026-10-02 on yts.vg: its pop-under script
// (https://rw.maggielimper.com/rPkoajTrmrD/144514) is matched only by uBlock
// filters' Galaksion regex, rejected here as "not RE2-compatible" because of a
// `(?=` lookahead, and by that regex's `ext_ubol` rewrite.
//
// Only sections that purely add blocking are taken: every filter in the section
// must be a network block or redirect filter. A section holding an exception, an
// in-page filter, `badfilter` or a non-blocking modifier is uBO Lite's
// substitute for something this extension already does the MV2 way, so taking
// it could only loosen or duplicate that; such a section is skipped whole.
//
// Shared by the build (tools/) and the service worker, so a list recompiled at
// runtime yields the same rules as the build did.
import * as sfp from '@gorhill/ubo-core/js/static-filtering-parser.js';

const UBOL = 'ubol';

// Options whose DNR action is not block / redirect-to-stand-in.
const NON_BLOCKING_OPTIONS = [
    sfp.NODE_TYPE_NET_OPTION_NAME_BADFILTER,
    sfp.NODE_TYPE_NET_OPTION_NAME_CSP,
    sfp.NODE_TYPE_NET_OPTION_NAME_PERMISSIONS,
    sfp.NODE_TYPE_NET_OPTION_NAME_REDIRECTRULE,
    sfp.NODE_TYPE_NET_OPTION_NAME_REMOVEPARAM,
    sfp.NODE_TYPE_NET_OPTION_NAME_REPLACE,
    sfp.NODE_TYPE_NET_OPTION_NAME_URLSKIP,
    sfp.NODE_TYPE_NET_OPTION_NAME_URLTRANSFORM,
];

// [beg, end) character ranges the preparser keeps for `env`, exactly as
// ubo-core's own preparser.prune() slices them.
function keptRanges(text, env) {
    const parts = sfp.utils.preparser.splitter(text, env);
    const out = [];
    for ( let i = 0, n = parts.length - 1; i < n; i += 2 ) {
        if ( parts[i+1] > parts[i] ) { out.push([ parts[i], parts[i+1] ]); }
    }
    return out;
}

// Ranges in `a` not covered by `b` (both sorted and non-overlapping).
function subtractRanges(a, b) {
    const out = [];
    let j = 0;
    for ( let [ beg, end ] of a ) {
        while ( j < b.length && b[j][1] <= beg ) { j += 1; }
        let k = j;
        while ( beg < end && k < b.length && b[k][0] < end ) {
            if ( b[k][0] > beg ) { out.push([ beg, b[k][0] ]); }
            beg = Math.max(beg, b[k][1]);
            k += 1;
        }
        if ( beg < end ) { out.push([ beg, end ]); }
    }
    return out;
}

// A region kept only under ubol can hold several gated sections back to back
// (`!#endif` then `!#if ext_ubol`). Each top-level section is judged on its own;
// a block nested inside one stays part of it.
const reDirective = /^!#(if|else|endif)\b/;

function splitSections(region) {
    const sections = [];
    let lines = [];
    let depth = 0;
    const flush = ( ) => {
        if ( lines.length !== 0 ) { sections.push(lines); }
        lines = [];
    };
    for ( const raw of region.split(/\r?\n|\r/) ) {
        const match = reDirective.exec(raw);
        if ( match === null ) { lines.push(raw); continue; }
        if ( match[1] === 'if' ) {
            if ( depth <= 0 ) { flush(); }
            depth += 1;
        } else if ( match[1] === 'else' ) {
            if ( depth <= 1 ) { flush(); }
        } else {
            depth -= 1;
            if ( depth <= 0 ) { flush(); }
        }
    }
    flush();
    return sections;
}

function sectionFilters(parser, section) {
    const filters = [];
    for ( const raw of section ) {
        const line = raw.trim();
        if ( line === '' ) { continue; }
        // A continued line is parsed differently by ubo-core; do not guess.
        if ( raw.endsWith(' \\') ) { return; }
        parser.parse(line);
        if ( parser.isComment() || parser.isFilter() === false ) { continue; }
        // Unparseable (e.g. an option this ubo-core does not know): its intent
        // cannot be classified, so neither can the section's.
        if ( parser.hasError() ) { return; }
        if ( parser.isNetworkFilter() === false ) { return; }
        if ( parser.isException() ) { return; }
        const types = parser.getNodeTypes();
        if ( NON_BLOCKING_OPTIONS.some(t => types.includes(t)) ) { return; }
        filters.push(line);
    }
    return filters;
}

// The blocking filters `ext_ubol` sections add to `text` under `env`.
export function ubolNetworkFilters(text, env) {
    if ( env.includes(UBOL) || text.includes('ext_ubol') === false ) { return []; }
    const regions = subtractRanges(
        keptRanges(text, [ ...env, UBOL ]),
        keptRanges(text, env)
    );
    if ( regions.length === 0 ) { return []; }
    const parser = new sfp.AstFilterParser({ toDNR: true });
    const out = [];
    for ( const [ beg, end ] of regions ) {
        for ( const section of splitSections(text.slice(beg, end)) ) {
            const filters = sectionFilters(parser, section);
            if ( filters !== undefined ) { out.push(...filters); }
        }
    }
    return out;
}

// `lists` plus, after each list that has some, a companion list holding its
// `ext_ubol` blocking filters. A separate list (rather than appended text) keeps
// them clear of any `!#if` block left open at the end of the original.
export function withUbolNetworkFilters(lists, env) {
    const out = [];
    for ( const list of lists ) {
        out.push(list);
        const filters = ubolNetworkFilters(list.text, env);
        if ( filters.length === 0 ) { continue; }
        out.push({ name: `${list.name} (ext_ubol)`, text: filters.join('\n') });
    }
    return out;
}
