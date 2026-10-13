import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = process.argv[2];
if (!source) throw new Error('Usage: node scripts/bundle-pdf-cmaps.mjs <pdfjs-dist/cmaps>');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = readdirSync(source).filter(name => name.endsWith('.bcmap')).sort();
if (!files.includes('Adobe-GB1-UCS2.bcmap')) throw new Error('Adobe-GB1-UCS2 is required');
const resources = Object.fromEntries(files.map(name => [
  name.slice(0, -6), readFileSync(path.join(source, name)).toString('base64'),
]));
writeFileSync(path.join(root, 'assets/pdf-cmaps.json'), `${JSON.stringify(resources)}\n`);
writeFileSync(path.join(root, 'assets/pdf-cmaps.LICENSE'), readFileSync(path.join(source, 'LICENSE')));
console.log(`Bundled ${files.length} CMaps`);
