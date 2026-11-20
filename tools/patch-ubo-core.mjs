// Keep the published ubo-core parser compatible with uBO 1.76.6.
// The selector guard is from 1.76.4; the path flag adapts the older parser's
// mode bits to accept hostname/path targets for scriptlets only.
// npm has no newer core release. Applying this after install keeps build-time
// compilation and the bundled runtime parser identical. Review and retire it
// when ubo-core ships the fix; a changed source shape must fail loudly.
import { readFileSync, writeFileSync } from 'node:fs';

const path = new URL('../node_modules/@gorhill/ubo-core/js/static-filtering-parser.js', import.meta.url);
const oldBlock = `            case 'TypeSelector': {
                const s = this.astSerializePart(part);
                if ( s === undefined ) { return; }
                if ( s === '*' && out.length !== 0 ) {
                    const before = out[out.length-1];
                    if ( before.endsWith(' ') === false ) { return; }
                }
                out.push(s);
                break;
            }`;
const newBlock = oldBlock.replace("s === '*' && ", '');
const domainBefore = `    normalizeDomainValue(s, modeBits) {
        if ( (modeBits & 0b10000) === 0 ||`;
const domainAfter = `    normalizeDomainValue(s, modeBits) {
        const pathPos = s.indexOf('/');
        if ( (modeBits & 0b100000) !== 0 && pathPos > 0 && s.charCodeAt(0) !== 0x2F ) {
            const rawHost = s.slice(0, pathPos);
            const host = this.normalizeHostnameValue(rawHost, modeBits);
            if ( host === '' ) { return ''; }
            return (host ?? rawHost) + s.slice(pathPos);
        }
        if ( (modeBits & 0b10000) === 0 ||`;
const flagBefore = "            this.linkDown(next, this.parseDomainList(next, ',', 0b11110));";
const flagAfter = `            const patternBeg = anchorBeg + anchorLen;
            const isScriptlet = this.raw.startsWith('+js(', patternBeg) ||
                this.raw.startsWith('//scriptlet(', patternBeg);
            this.linkDown(next, this.parseDomainList(next, ',', isScriptlet ? 0b111110 : 0b11110));`;
const patches = [
    { name: 'uBO 1.76.4 non-leading type-selector guard', before: oldBlock, after: newBlock },
    { name: 'scriptlet hostname/path normalization', before: domainBefore, after: domainAfter },
    { name: 'scriptlet-only path flag', before: flagBefore, after: flagAfter },
];
const original = readFileSync(path, 'utf-8');
let source = original;
const messages = [];
for ( const patch of patches ) {
    const oldCount = source.split(patch.before).length - 1;
    const newCount = source.split(patch.after).length - 1;
    if ( oldCount === 1 && newCount === 0 ) {
        source = source.replace(patch.before, patch.after);
        messages.push(`ubo-core: applied ${patch.name}`);
    } else if ( oldCount === 0 && newCount === 1 ) {
        messages.push(`ubo-core: ${patch.name} already present`);
    } else {
        throw new Error(`ubo-core ${patch.name} shape changed (old=${oldCount}, fixed=${newCount}); review the dependency`);
    }
}
if ( source !== original ) { writeFileSync(path, source); }
for ( const message of messages ) { console.log(message); }
