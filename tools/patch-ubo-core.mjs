// Backport uBO 1.76.4's selector guard to the published ubo-core package.
// https://github.com/gorhill/uBlock/compare/1.76.2...1.76.4
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
const source = readFileSync(path, 'utf-8');
const oldCount = source.split(oldBlock).length - 1;
const newCount = source.split(newBlock).length - 1;
if ( oldCount === 1 && newCount === 0 ) {
    writeFileSync(path, source.replace(oldBlock, newBlock));
    console.log('ubo-core: applied uBO 1.76.4 non-leading type-selector guard');
} else if ( oldCount === 0 && newCount === 1 ) {
    console.log('ubo-core: uBO 1.76.4 type-selector guard already present');
} else {
    throw new Error(`ubo-core parser patch shape changed (old=${oldCount}, fixed=${newCount}); review the dependency`);
}
