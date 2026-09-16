// Cosmetic filtering in the page.
//
// Runs at document_start in every frame. Generic selectors arrive as a
// declarative stylesheet (no round-trip). Host-specific selectors and scriptlets
// need the service worker, so they are requested once per frame and applied as
// soon as they land.
//
// Plain CSS selectors are applied as a single stylesheet -- one style element,
// one parse, no per-node work. Procedural filters (:has-text, :upward, ...) have
// no CSS equivalent and are evaluated against the DOM, so they are handled
// separately and kept off the fast path.
(() => {
    // about:blank and similar inherit the parent's origin; there is nothing to
    // filter and hostname is empty.
    const hostname = location.hostname;
    if ( hostname === '' ) { return; }

    const STYLE_ID = 'ublock-mv3-cosmetic';

    function applySelectors(selectors) {
        if ( selectors.length === 0 ) { return; }
        // One rule with many selectors: cheaper for the CSS engine than many
        // rules, and a single insertion point to remove if the site is disabled.
        const css = selectors.join(',\n') + '\n{display:none!important;}';
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = css;
        const parent = document.head || document.documentElement;
        if ( parent !== null ) { parent.appendChild(style); }
    }

    /* --------------------------------------------------------------------- */
    /* Procedural filters                                                     */

    // Supported tasks mirror the subset uBO expresses in its DNR build. An
    // unrecognised task makes the whole filter inert rather than mis-hiding
    // content: a false positive here removes real page content.
    function matchesTasks(el, tasks) {
        for ( const task of tasks ) {
            const [ name, arg ] = task;
            switch ( name ) {
            case 'has-text': {
                const text = el.textContent || '';
                if ( arg instanceof Object ) { return false; }
                if ( typeof arg === 'string' && arg.startsWith('/') ) {
                    const m = /^\/(.+)\/([a-z]*)$/.exec(arg);
                    if ( m === null ) { return false; }
                    let re;
                    try { re = new RegExp(m[1], m[2]); } catch { return false; }
                    if ( re.test(text) === false ) { return false; }
                } else if ( text.includes(String(arg)) === false ) {
                    return false;
                }
                break;
            }
            case 'not-has-text': {
                const text = el.textContent || '';
                if ( text.includes(String(arg)) ) { return false; }
                break;
            }
            case 'has': {
                if ( typeof arg !== 'string' ) { return false; }
                try { if ( el.querySelector(arg) === null ) { return false; } }
                catch { return false; }
                break;
            }
            default:
                return false; // unknown task -> filter does not apply
            }
        }
        return true;
    }

    function runProcedural(procedural) {
        if ( procedural.length === 0 ) { return; }
        const hide = el => {
            if ( el instanceof Element ) { el.style.setProperty('display', 'none', 'important'); }
        };
        const pass = () => {
            for ( const f of procedural ) {
                if ( typeof f.p !== 'string' || f.p === '' ) { continue; }
                let nodes;
                try { nodes = document.querySelectorAll(f.p); }
                catch { continue; }
                if ( f.t === null || f.t === undefined ) {
                    for ( const el of nodes ) { hide(el); }
                    continue;
                }
                for ( const el of nodes ) {
                    if ( matchesTasks(el, f.t) ) { hide(el); }
                }
            }
        };

        pass();
        // Procedural filters depend on text/subtree state that arrives later, so
        // re-run on mutations -- rate-limited, because these selectors are the
        // expensive ones and an unthrottled observer on a busy page is a
        // measurable regression.
        let scheduled = false;
        const observer = new MutationObserver(() => {
            if ( scheduled ) { return; }
            scheduled = true;
            requestAnimationFrame(() => { scheduled = false; pass(); });
        });
        const start = () => observer.observe(document.documentElement, {
            childList: true, subtree: true,
        });
        if ( document.documentElement !== null ) { start(); }
        else { document.addEventListener('DOMContentLoaded', start, { once: true }); }

        // Stop observing once the page has settled; procedural filters that
        // matter have applied by then, and a permanent observer is a cost on
        // every page for the rest of its life.
        addEventListener('load', () => {
            setTimeout(() => observer.disconnect(), 5000);
        }, { once: true });
    }

    /* --------------------------------------------------------------------- */

    // Scriptlets are NOT handled here. They must run before the page's own
    // scripts, which rules out a message round-trip: by the time the worker
    // replied, the globals a scriptlet needs to patch would already be in use.
    // They are instead registered as content scripts at document_start, scoped
    // to the hostnames that need them, in both MAIN and ISOLATED worlds.
    // See tools/emit-scriptlets.mjs and registerScriptletScripts() in
    // background.js.

    chrome.runtime.sendMessage({ what: 'getCosmetic', hostname })
        .then(reply => {
            if ( reply === undefined || reply.error !== undefined ) { return; }
            const r = reply.result;
            if ( r === undefined || r.disabled === true ) { return; }
            applySelectors(r.selectors ?? []);
            runProcedural(r.procedural ?? []);
        })
        .catch(() => { /* extension reloading, or worker unavailable */ });
})();
