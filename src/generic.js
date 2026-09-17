// Generic cosmetic filtering in the page.
//
// Registered by the service worker after data/cosmetic/generic-lookup.js (which
// defines self.__ubmv3_genericData) in every frame except whitelisted sites.
// $generichide/$elemhide sites are checked here, against data.G, so that
// entity and regex hostname forms apply too.
//
//  - highly generic filters (no class/id key): one stylesheet, injected at once
//  - lowly generic filters: the DOM surveyor collects the page's class and id
//    tokens, hashes each with uBO's hashFromStr, and injects only the selectors
//    keyed on tokens that are present; it keeps surveying added nodes and
//    class/id changes.
//
// Adapted from uBO Lite's js/scripting/css-generic.js (GPL-3.0-or-later,
// Copyright (C) 2014-present Raymond Hill), which does the same for MV3. The
// hash below must stay identical to ubo-core's hashFromStr in
// static-dnr-filtering.js (24-bit mask), which keyed the data at build time.
(() => {
    const data = self.__ubmv3_genericData;
    self.__ubmv3_genericData = undefined;
    if ( typeof data !== 'object' || data === null ) { return; }
    if ( document.documentElement === null ) { return; }

    const { B, E, H, G } = data;
    const BUCKET_MASK = B.length - 1;
    // U+0001 separates a selector from its exception-list index.
    const EXC_SEP = String.fromCharCode(1);

    // uBO hostname forms: plain ("example.com" covers subdomains), entity
    // ("example.*", any TLD), regex ("/.../").
    const hostname = location.hostname;
    const ladder = [];
    for ( let h = hostname; h !== ''; ) {
        ladder.push(h);
        const i = h.indexOf('.');
        if ( i === -1 ) { break; }
        h = h.slice(i + 1);
    }
    const hostMatches = x => {
        if ( typeof x !== 'string' || x === '' ) { return false; }
        if ( x.length > 2 && x.startsWith('/') && x.endsWith('/') ) {
            try { return new RegExp(x.slice(1, -1)).test(hostname); } catch { return false; }
        }
        if ( x.endsWith('.*') ) {
            const base = x.slice(0, -1);
            return ladder.some(h => h.startsWith(base));
        }
        return ladder.includes(x);
    };

    // $generichide / $elemhide: no generic cosmetic filtering on this site.
    if ( Array.isArray(G) && G.some(hostMatches) ) { return; }

    const hashFromStr = (type, s) => {
        const len = s.length;
        const step = len + 7 >>> 3;
        let hash = (type << 5) + type ^ len;
        for ( let i = 0; i < len; i += step ) {
            hash = (hash << 5) + hash ^ s.charCodeAt(i);
        }
        return hash & 0xFFFFFF;
    };

    /* --------------------------------------------------------------------- */
    /* Site exceptions (`example.com#@#.sel`), uBO hostname forms            */

    const exceptedCache = new Map();
    const isExcepted = ref => {
        let verdict = exceptedCache.get(ref);
        if ( verdict !== undefined ) { return verdict; }
        let hosts = [];
        try { hosts = JSON.parse(E[ref]); } catch { }
        verdict = hosts.some(hostMatches);
        exceptedCache.set(ref, verdict);
        return verdict;
    };

    /* --------------------------------------------------------------------- */
    /* Hash -> selectors                                                      */

    const seenHashes = new Set();
    const pendingHashes = new Set();

    const selectorsForHash = hash => {
        const bucket = B[hash & BUCKET_MASK];
        if ( bucket === '' ) { return; }
        const needle = `\n${hash.toString(36)}\t`;
        const at = bucket.indexOf(needle);
        if ( at === -1 ) { return; }
        const beg = at + needle.length;
        let end = bucket.indexOf('\n', beg);
        if ( end === -1 ) { end = bucket.length; }
        const out = [];
        for ( const item of bucket.slice(beg, end).split('\t') ) {
            const sep = item.indexOf(EXC_SEP);
            if ( sep === -1 ) { out.push(item); continue; }
            if ( isExcepted(+item.slice(sep + 1)) ) { continue; }
            out.push(item.slice(0, sep));
        }
        return out;
    };

    const idFromNode = node => {
        const raw = node.id;
        if ( typeof raw !== 'string' || raw.length === 0 ) { return; }
        const hash = hashFromStr(0x23 /* '#' */, raw.trim());
        if ( seenHashes.has(hash) ) { return; }
        seenHashes.add(hash);
        pendingHashes.add(hash);
    };

    // Performance: avoid Element.classList (uBO issue discussions/2076).
    const classesFromNode = node => {
        const s = node.getAttribute('class');
        if ( typeof s !== 'string' ) { return; }
        const len = s.length;
        for ( let beg = 0, end = 0; beg < len; beg += 1 ) {
            end = s.indexOf(' ', beg);
            if ( end === beg ) { continue; }
            if ( end === -1 ) { end = len; }
            const token = s.slice(beg, end).trimEnd();
            beg = end;
            if ( token.length === 0 ) { continue; }
            const hash = hashFromStr(0x2E /* '.' */, token);
            if ( seenHashes.has(hash) ) { continue; }
            seenHashes.add(hash);
            pendingHashes.add(hash);
        }
    };

    /* --------------------------------------------------------------------- */
    /* Stylesheet output                                                      */

    // content.js owns the frame's stylesheet; fall back to a local one if it
    // is not present (it always is when both are injected).
    let ownStyle = null;
    const insertCSS = css => {
        if ( typeof self.__ubmv3_addCSS === 'function' ) {
            self.__ubmv3_addCSS(css);
            return;
        }
        if ( ownStyle === null ) {
            ownStyle = document.createElement('style');
            (document.head || document.documentElement).appendChild(ownStyle);
        }
        ownStyle.appendChild(document.createTextNode(css + '\n'));
    };

    /* --------------------------------------------------------------------- */
    /* Survey                                                                 */

    const maxSurveyTimeSlice = 4;
    const maxSurveyNodeSlice = 64;
    const stopAllRatio = 0.95;
    let surveyCount = 0;
    let surveyMissCount = 0;
    let styleSheetTimer;
    let processTimer;
    let domChangeTimer;
    let lastDomChange = Date.now();
    const pendingSelectors = new Set();

    const pendingNodes = {
        addedNodes: [],
        nodeSet: new Set(),
        add(node) { this.addedNodes.push(node); },
        next(out) {
            for ( const added of this.addedNodes ) {
                if ( this.nodeSet.has(added) ) { continue; }
                this.nodeSet.add(added);
                if ( added.firstElementChild === null ) { continue; }
                for ( const descendant of added.querySelectorAll('[id],[class]') ) {
                    this.nodeSet.add(descendant);
                }
            }
            this.addedNodes.length = 0;
            for ( const node of this.nodeSet ) {
                this.nodeSet.delete(node);
                out.push(node);
                if ( out.length === maxSurveyNodeSlice ) { break; }
            }
        },
        hasNodes() {
            return this.addedNodes.length !== 0 || this.nodeSet.size !== 0;
        },
    };

    const processNodes = ( ) => {
        const deadline = performance.now() + maxSurveyTimeSlice;
        const nodes = [];
        for (;;) {
            pendingNodes.next(nodes);
            if ( nodes.length === 0 ) { break; }
            for ( const node of nodes ) {
                idFromNode(node);
                classesFromNode(node);
            }
            nodes.length = 0;
            if ( performance.now() >= deadline ) { break; }
        }
        surveyCount += 1;
        let found = 0;
        for ( const hash of pendingHashes ) {
            const selectors = selectorsForHash(hash);
            if ( selectors === undefined ) { continue; }
            for ( const s of selectors ) { pendingSelectors.add(s); found += 1; }
        }
        pendingHashes.clear();
        // Work left over from the time slice is picked up on the next pass.
        if ( pendingNodes.hasNodes() ) { scheduleProcess(); }
        if ( found === 0 ) {
            surveyMissCount += 1;
            if ( surveyCount >= 64 && (surveyMissCount / surveyCount) >= stopAllRatio ) {
                stopAll();
            }
            return;
        }
        surveyMissCount = 0;
        if ( styleSheetTimer !== undefined ) { return; }
        styleSheetTimer = self.requestAnimationFrame(( ) => {
            styleSheetTimer = undefined;
            if ( pendingSelectors.size === 0 ) { return; }
            const css = `${Array.from(pendingSelectors).join(',\n')}\n{display:none!important;}`;
            pendingSelectors.clear();
            insertCSS(css);
        });
    };

    const scheduleProcess = ( ) => {
        if ( processTimer !== undefined ) { return; }
        processTimer = self.setTimeout(( ) => {
            processTimer = undefined;
            processNodes();
        }, 64);
    };

    const processChanges = mutations => {
        for ( const mutation of mutations ) {
            if ( mutation.type === 'childList' ) {
                for ( const added of mutation.addedNodes ) {
                    if ( added.nodeType !== 1 ) { continue; }
                    if ( added.parentElement === null ) { continue; }
                    pendingNodes.add(added);
                }
            } else if ( mutation.attributeName === 'class' ) {
                classesFromNode(mutation.target);
            } else {
                idFromNode(mutation.target);
            }
        }
        if ( pendingNodes.hasNodes() === false && pendingHashes.size === 0 ) { return; }
        lastDomChange = Date.now();
        scheduleProcess();
    };

    let observer = new MutationObserver(processChanges);

    const stopAll = ( ) => {
        if ( domChangeTimer !== undefined ) {
            self.clearTimeout(domChangeTimer);
            domChangeTimer = undefined;
        }
        if ( observer !== undefined ) {
            observer.disconnect();
            observer.takeRecords();
            observer = undefined;
        }
    };

    // Stop once the page has been static for 30 s, as uBO Lite does.
    const checkDomChanges = ( ) => {
        domChangeTimer = undefined;
        if ( observer === undefined ) { return; }
        if ( (Date.now() - lastDomChange) > 30000 ) { return stopAll(); }
        domChangeTimer = self.setTimeout(checkDomChanges, 30000);
    };

    // Highly generic filters apply to every page: inject now, at document_start.
    if ( typeof H === 'string' && H !== '' ) { insertCSS(H); }

    // Survey once the document is parsed (uBO Lite runs its surveyor at
    // document_idle): observing from document_start would turn every parsed
    // node into a mutation record. Later changes are caught by the observer.
    const start = ( ) => {
        pendingNodes.add(document.documentElement);
        processNodes();
        observer.observe(document, {
            attributeFilter: [ 'class', 'id' ],
            attributes: true,
            childList: true,
            subtree: true,
        });
        checkDomChanges();
    };
    if ( document.readyState === 'loading' ) {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }
})();
