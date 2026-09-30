// JSON for data embedded in scripts that run in every frame.
//
// V8 stores and scans a script's source as one-byte only when every character
// is <= U+00FF; a single character above that makes the whole script two-byte.
// Filter data carries a few hundred non-Latin characters (Cyrillic, CJK, ...),
// which made each multi-megabyte lookup two-byte in every frame. Escaping every
// non-ASCII code unit as \uXXXX yields the identical value when parsed -- in
// JSON, non-ASCII can only occur inside string literals -- and keeps the
// generated script pure ASCII. tools/verify.mjs fails any page script that is
// not one-byte.
export function asciiJSON(value) {
    return JSON.stringify(value).replace(/[\u0080-￿]/g,
        c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
