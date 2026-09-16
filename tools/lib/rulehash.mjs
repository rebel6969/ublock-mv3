// Stable identity for a DNR rule, used to diff a refetched filter list against
// the baseline compiled into a static ruleset.
//
// The `id` is deliberately excluded: ids are positional and get reassigned on
// every build, so two identical filters would otherwise look like a change. What
// identifies a rule is its action plus its condition.
//
// Keys are sorted recursively before hashing, because JSON key order is an
// artefact of how the object was built, not part of the rule's meaning; without
// this, an unchanged rule could hash differently between builds.
//
// MUST stay behaviourally identical to src/lib/rulehash.js. tools/assemble.mjs
// asserts that across the whole shipped corpus.
export function canonicalize(value) {
    if ( Array.isArray(value) ) {
        // Array order IS meaningful for DNR (e.g. resourceTypes matching is set-
        // like, but requestDomains order is not semantic). Sorting primitives
        // makes the hash stable against harmless reordering by the compiler.
        const items = value.map(canonicalize);
        const allPrimitive = items.every(v => typeof v !== 'object' || v === null);
        return allPrimitive ? items.slice().sort() : items;
    }
    if ( value !== null && typeof value === 'object' ) {
        const out = {};
        for ( const key of Object.keys(value).sort() ) {
            if ( key === 'id' ) { continue; }
            out[key] = canonicalize(value[key]);
        }
        return out;
    }
    return value;
}

// Two independent 32-bit hashes combined into one string. A single 32-bit hash
// over ~113,000 rules would collide with near-certainty (birthday bound); 64 bits
// makes a collision negligible, and a collision here would silently mark a
// changed rule as unchanged.
export function ruleHash(rule) {
    const text = JSON.stringify(canonicalize(rule));
    let h1 = 0x811c9dc5;   // FNV-1a
    let h2 = 0x01000193;   // second seed, different multiplier below
    for ( let i = 0; i < text.length; i++ ) {
        const c = text.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
        h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
    }
    return h1.toString(36) + '-' + h2.toString(36);
}
