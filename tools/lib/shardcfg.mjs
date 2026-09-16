// Single source of truth for hostname sharding.
//
// src/lib/shard.js must stay behaviourally identical to this; tools/verify.mjs
// asserts that across a large sample. If they ever diverge, cosmetic lookups
// miss and filtering silently stops working on the affected hostnames.
export const SHARD_COUNT = 64;

export function shardOf(hostname) {
    let h = 0x811c9dc5;
    for ( let i = 0; i < hostname.length; i++ ) {
        h ^= hostname.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h % SHARD_COUNT;
}
