// Site-specific cosmetic filtering in the page.
//
// Declared in the manifest: runs at document_start in every frame. Generic
// hiding is handled elsewhere (generic-high.css and the generic.js surveyor are
// registered by the service worker); scriptlets are registered scripts too.
// This file applies what the service worker resolves for this hostname:
//
//   selectors   plain CSS selectors            -> one display:none rule
//   styles      `sel:style(decl)` without tasks -> CSS rules, as uBO injects them
//   procedural  :has-text/:upward/:remove-* ... -> uBO's ProceduralFilterer
//
// uBO's procedural engine (procedural.js = js/contentscript-extra.js, unmodified)
// is ~23 KB and most frames never need it, so it is not declared here: the
// worker injects it into this frame only when there are procedural filters.
(() => {
    const hostname = location.hostname;
    if ( hostname === '' ) { return; }

    /* --------------------------------------------------------------------- */
    /* Minimal vAPI for uBO's procedural engine                               */

    // The engine reads only vAPI.randomToken, vAPI.hideStyle, vAPI.domFilterer
    // and vAPI.domWatcher, and defines vAPI.DOMProceduralFilterer when loaded.
    if ( typeof self.vAPI !== 'object' || self.vAPI === null ) {
        self.vAPI = {
            // Same construction as uBO: a letter first, so the token is a valid
            // attribute name for the [token] selectors the engine generates.
            randomToken: ( ) =>
                String.fromCharCode(Date.now() % 26 + 97) +
                Math.floor(Math.random() * 982451653 + 982451653).toString(36),
            hideStyle: 'display:none!important;',
        };
    }
    const vAPI = self.vAPI;

    /* --------------------------------------------------------------------- */
    /* Stylesheet sink, shared with generic.js in this isolated world          */

    let styleEl = null;
    const pendingCSS = [];
    const attachStyle = ( ) => {
        const parent = document.head || document.documentElement;
        if ( parent === null ) { return false; }
        if ( styleEl === null ) {
            styleEl = document.createElement('style');
            styleEl.setAttribute('data-ubmv3', '');
        }
        if ( styleEl.isConnected === false ) { parent.appendChild(styleEl); }
        if ( pendingCSS.length !== 0 ) {
            styleEl.appendChild(document.createTextNode(pendingCSS.join('\n') + '\n'));
            pendingCSS.length = 0;
        }
        return true;
    };
    const addCSS = css => {
        pendingCSS.push(css);
        if ( attachStyle() === false ) {
            document.addEventListener('DOMContentLoaded', attachStyle, { once: true });
        }
    };
    self.__ubmv3_addCSS = addCSS;

    /* --------------------------------------------------------------------- */
    /* domFilterer + domWatcher: the two objects the engine calls into        */

    const domFilterer = {
        proceduralFilterer: null,
        pending: false,
        addCSS(css) { addCSS(css); },
        // Batch commits: animation frame when visible, timer as a fallback
        // because hidden tabs and frames do not run animation frames.
        commit() {
            if ( this.pending ) { return; }
            this.pending = true;
            let done = false;
            const run = ( ) => {
                if ( done ) { return; }
                done = true;
                this.pending = false;
                const pf = this.proceduralFilterer;
                if ( pf !== null && pf.mustApplySelectors ) { pf.commitNow(); }
            };
            requestAnimationFrame(run);
            setTimeout(run, 250);
        },
        hasListeners() { return false; },
        triggerListeners() {},
    };

    const listeners = [];
    let observer = null;
    const startObserver = ( ) => {
        if ( observer !== null ) { return; }
        const root = document.documentElement;
        if ( root === null ) {
            document.addEventListener('DOMContentLoaded', startObserver, { once: true });
            return;
        }
        observer = new MutationObserver(mutations => {
            const added = [];
            let removed = false;
            for ( const m of mutations ) {
                for ( const n of m.addedNodes ) {
                    if ( n.nodeType === 1 ) { added.push(n); }
                }
                if ( m.removedNodes.length !== 0 ) { removed = true; }
            }
            if ( added.length === 0 && removed === false ) { return; }
            for ( const l of listeners ) { l.onDOMChanged(added, removed); }
        });
        // Kept running for the life of the page, as uBO does: single-page apps
        // render filtered content long after load. Only started when a page
        // has procedural filters (the engine registers the only listener).
        observer.observe(root, { childList: true, subtree: true });
    };
    const domWatcher = {
        addListener(l) { listeners.push(l); startObserver(); },
    };

    vAPI.domFilterer = domFilterer;
    vAPI.domWatcher = domWatcher;

    /* --------------------------------------------------------------------- */

    chrome.runtime.sendMessage({ what: 'getCosmetic', hostname })
        .then(async reply => {
            const r = reply?.result;
            if ( r === undefined || r.disabled === true ) { return; }

            const css = [];
            if ( Array.isArray(r.selectors) && r.selectors.length !== 0 ) {
                css.push(`${r.selectors.join(',\n')}\n{display:none!important;}`);
            }
            if ( Array.isArray(r.styles) ) { css.push(...r.styles); }
            if ( css.length !== 0 ) { addCSS(css.join('\n')); }

            if ( Array.isArray(r.procedural) === false || r.procedural.length === 0 ) { return; }
            if ( typeof vAPI.DOMProceduralFilterer !== 'function' ) {
                await chrome.runtime.sendMessage({ what: 'injectProcedural' });
            }
            if ( typeof vAPI.DOMProceduralFilterer !== 'function' ) { return; }
            const pf = new vAPI.DOMProceduralFilterer(domFilterer);
            domFilterer.proceduralFilterer = pf;
            pf.addProceduralSelectors(r.procedural);
        })
        .catch(( ) => { /* extension reloading, or worker unavailable */ });
})();
