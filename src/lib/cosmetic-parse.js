// Shape of a specific cosmetic filter as applied by content.js, shared by the
// build (tools/emit-cosmetic.mjs) and the service worker (user filters compiled
// at runtime), so both produce identical values.
//
// ubo-core's compiled payload is either a bare CSS selector or a JSON blob
// describing a procedural filter ({selector, tasks, action, cssable, raw}).
export function parseSpecific(payload) {
    if ( typeof payload !== 'string' ) { return undefined; }
    if ( payload.startsWith('{') === false ) {
        return payload; // plain CSS selector
    }
    let o;
    try { o = JSON.parse(payload); } catch { return undefined; }
    if ( typeof o.selector !== 'string' || typeof o.raw !== 'string' ) { return undefined; }

    // `selector:style(decl)` with no procedural tasks is plain CSS; uBO injects
    // it as a stylesheet rule rather than running JS for it.
    if ( o.cssable === true && Array.isArray(o.action) && o.action[0] === 'style' &&
         (Array.isArray(o.tasks) === false || o.tasks.length === 0) ) {
        return { css: o.selector, style: o.action[1] };
    }

    // Everything else goes to uBO's procedural engine UNCHANGED. An earlier
    // shape kept only selector and tasks, dropping `action`, so 10,547
    // :style()/:remove-attr()/:remove-class() filters were executed as hides.
    const out = { selector: o.selector, raw: o.raw };
    if ( Array.isArray(o.tasks) ) { out.tasks = o.tasks; }
    if ( Array.isArray(o.action) ) { out.action = o.action; }
    return out;
}
