// Hostname sharding, shared by the service worker and the build.
//
// MUST stay byte-identical in behaviour to shardOf() in tools/emit-cosmetic.mjs.
// If these two disagree, lookups silently miss and cosmetic filtering quietly
// stops working on affected sites -- with no error anywhere.
export const SHARD_COUNT = 64;

export function shardOf(hostname) {
    let h = 0x811c9dc5;
    for ( let i = 0; i < hostname.length; i++ ) {
        h ^= hostname.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h % SHARD_COUNT;
}

// uBO matches a filter against the hostname and every parent domain, so
// "ads.example.co.uk" must also pick up rules targeting "example.co.uk".
// Returning the full ladder lets the caller check each candidate.
export function hostnameLadder(hostname) {
    const out = [];
    if ( typeof hostname !== 'string' || hostname === '' ) { return out; }
    let h = hostname;
    for (;;) {
        out.push(h);
        const i = h.indexOf('.');
        if ( i === -1 ) { break; }
        h = h.slice(i + 1);
        if ( h.indexOf('.') === -1 ) { break; } // stop before the bare TLD
    }
    return out;
}
