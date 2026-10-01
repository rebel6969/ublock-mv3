// Popup filtering: uBO MV2's `$popup` / `$popunder`, which DNR cannot express.
//
// uBO closes a tab a page opened when its URL matches a popup filter, and closes
// the opener when the opener is the ad (popunder). DNR has no notion of "a tab
// another page opened", so ubo-core's DNR emitter drops these filters without a
// rule or an error (6,139 on this build's lists). This module runs them through
// uBO's own static filtering engine, exactly as uBO's tab.js popupMatch() does.
//
// Only filters typed popup, popunder or all can match: for those types
// matchRequest() skips typeless buckets (static-net-filtering.js, exactType).
// Of the `$all` block filters, only those DNR does not already block as a
// main_frame are loaded: the rest (35,000+, malware and phishing hosts) cost
// ~0.8 s to load for no protection gained -- uBO closes such a popup, here its
// page is blocked in the new tab instead. Measured: 6,180 popup-typed filters
// plus those few load in ~60 ms.
//
// The engine is a module singleton shared with the DNR compiler. The compiler
// works on a per-call context and never reads the loaded filters, and loading
// these never changes its output (both measured, tools/verify.mjs re-checks).
import * as sfp from '@gorhill/ubo-core/js/static-filtering-parser.js';
import { dnrRulesetFromRawLists } from '@gorhill/ubo-core/js/static-dnr-filtering.js';
import staticNetFilteringEngine from '@gorhill/ubo-core/js/static-net-filtering.js';
import { CompiledListReader, CompiledListWriter } from '@gorhill/ubo-core/js/static-filtering-io.js';
import { FilteringContext } from '@gorhill/ubo-core/js/filtering-context.js';
import publicSuffixList from '@gorhill/ubo-core/lib/publicsuffixlist/publicsuffixlist.js';

const POPUP_TYPES = [
    sfp.NODE_TYPE_NET_OPTION_NAME_POPUP,
    sfp.NODE_TYPE_NET_OPTION_NAME_POPUNDER,
    sfp.NODE_TYPE_NET_OPTION_NAME_ALL,
];

function newParser() {
    return new sfp.AstFilterParser({ maxTokenLength: staticNetFilteringEngine.MAX_TOKEN_LENGTH });
}

// Iterate filter lines the way ubo-core's compileList() does, joining
// `\`-continued lines.
function* filterLines(text) {
    const lines = text.split(/\r?\n|\r/);
    for ( let i = 0; i < lines.length; i++ ) {
        let line = lines[i].trim();
        while ( line.endsWith(' \\') && i + 1 < lines.length && lines[i+1].startsWith('    ') ) {
            i += 1;
            line = line.slice(0, -2).trim() + lines[i].trim();
        }
        if ( line !== '' ) { yield line; }
    }
}

// The network filters in `text` that can match a popup or popunder, after
// resolving `!#if` for `env` (ubo-core's own preparser).
export function popupFilterLines(text, env) {
    if ( typeof text !== 'string' || /popup|popunder|\ball\b/.test(text) === false ) { return []; }
    const parser = newParser();
    const out = [];
    for ( const line of filterLines(sfp.utils.preparser.prune(text, env)) ) {
        parser.parse(line);
        if ( parser.isFilter() === false || parser.isNetworkFilter() === false ) { continue; }
        if ( parser.hasError() ) { continue; }
        const types = parser.getNodeTypes();
        if ( POPUP_TYPES.some(t => types.includes(t) && parser.isNegatedOption(t) === false) ) {
            out.push(line);
        }
    }
    return out;
}

const POPUP_TYPED = [ sfp.NODE_TYPE_NET_OPTION_NAME_POPUP, sfp.NODE_TYPE_NET_OPTION_NAME_POPUNDER ];

// Does DNR block `line` (an `$all` block filter) as a main_frame? Asked of the
// DNR compiler itself, one filter at a time, so its verdict is the authority.
async function dnrBlocksDocument(line, dnrOptions) {
    const res = await dnrRulesetFromRawLists([ { name: 'popup-check', text: line } ], dnrOptions);
    for ( const r of res.network.ruleset || [] ) {
        if ( r._error !== undefined || r.action?.type !== 'block' ) { continue; }
        const c = r.condition ?? {};
        const types = c.resourceTypes;
        if ( types !== undefined ? types.includes('main_frame') : (c.excludedResourceTypes ?? []).includes('main_frame') === false ) {
            return true;
        }
    }
    return false;
}

// What the popup engine loads from one list: every popup/popunder-typed filter,
// every exception that can apply to a popup, and the `$all` block filters DNR
// cannot already enforce on the popup's page.
export async function popupEngineLines(text, env, dnrOptions) {
    const parser = newParser();
    const out = [];
    for ( const line of popupFilterLines(text, env) ) {
        parser.parse(line);
        const types = parser.getNodeTypes();
        const typed = POPUP_TYPED.some(t => types.includes(t) && parser.isNegatedOption(t) === false);
        if ( typed || parser.isException() || await dnrBlocksDocument(line, dnrOptions) === false ) {
            out.push(line);
        }
    }
    return out;
}

// Public suffix list: needed for party (1p/3p) and domain= matching.
export function loadPublicSuffixList(selfie) {
    publicSuffixList.fromSelfie(selfie);
}

// Load `lists` ([{ name, lines }]) into the engine, replacing what was there,
// the same way ubo-core's useLists() does.
export function loadPopupFilters(lists) {
    staticNetFilteringEngine.reset();
    const compiler = staticNetFilteringEngine.createCompiler();
    const parser = newParser();
    let count = 0;
    for ( const { name, lines } of lists ) {
        const writer = new CompiledListWriter();
        writer.properties.set('name', name);
        for ( const line of lines ) {
            parser.parse(line);
            if ( parser.isFilter() === false || parser.isNetworkFilter() === false ) { continue; }
            if ( compiler.compile(parser, writer) ) { count += 1; }
        }
        staticNetFilteringEngine.fromCompiled(new CompiledListReader(writer.toString()));
    }
    staticNetFilteringEngine.freeze();
    staticNetFilteringEngine.optimize();
    return count;
}

// 0 = no match, 1 = block (close the tab), 2 = allowed by an exception.
// type: 'popup' tests the new tab's URL in the opener's context; 'popunder'
// tests the opener's URL in the new tab's context (uBO's popunderMatch()).
export function matchPopup({ rootOpenerURL, localOpenerURL, targetURL, type = 'popup' }) {
    const fctxt = new FilteringContext();
    fctxt.setTabOriginFromURL(rootOpenerURL)
         .setDocOriginFromURL(localOpenerURL || rootOpenerURL)
         .setURL(targetURL)
         .setType(type);
    return staticNetFilteringEngine.matchRequest(fctxt, 0b0001);
}
