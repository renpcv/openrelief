// Builds openrelief-source.zip for the page's "Download source code" link:
//   openrelief-source/README.txt   how to use it (from source-readme.txt)
//   openrelief-source/source/      the full project: edit it and run it with Node.js
//   openrelief-source/web/         the built page, ready to upload to any static host
// Runs as the last step of `npm run build` (it needs dist/ for the web copy).
// The zip is written to public/ (served by `npm run dev`) and copied into dist/.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const OUT = 'openrelief-source.zip';
const TOP = 'openrelief-source/';

/** All files under a folder, as forward-slash paths relative to the project root. */
function walk(dir) {
  const abs = path.join(root, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`;
    return e.isDirectory() ? walk(rel) : [rel];
  });
}

const source = [
  'README.md', 'LICENSE', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts',
  '.gitignore', 'index.html', 'build-zip.mjs', 'deploy.mjs', 'source-readme.txt',
  ...walk('src'), ...walk('tests'),
].filter((f) => fs.existsSync(path.join(root, f)));
const web = walk('dist').filter((f) => f !== `dist/${OUT}`);
if (!web.length) console.warn('dist/ is empty: run `npm run build` to include the web copy.');

const entries = [
  [TOP + 'README.txt', 'source-readme.txt'],
  ...source.sort().map((f) => [TOP + 'source/' + f, f]),
  ...web.sort().map((f) => [TOP + 'web/' + f.slice('dist/'.length), f]),
];

// Windows-friendly line endings for the plain-text readme
function contents(src) {
  const data = fs.readFileSync(path.join(root, src));
  return src.endsWith('.txt') ? Buffer.from(data.toString('utf8').replace(/\r?\n/g, '\r\n')) : data;
}

// ---------- minimal zip writer (deflate) ----------

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

const now = new Date();
const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

const local = [], central = [];
let offset = 0;
for (const [name, src] of entries) {
  const data = contents(src);
  const packed = zlib.deflateRawSync(data, { level: 9 });
  const store = packed.length >= data.length;
  const body = store ? data : packed;
  const nameBuf = Buffer.from(name, 'utf8');
  const crc = crc32(data);

  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);   // UTF-8 names
  lh.writeUInt16LE(store ? 0 : 8, 8); lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12);
  lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22);
  lh.writeUInt16LE(nameBuf.length, 26);
  local.push(lh, nameBuf, body);

  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
  ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(store ? 0 : 8, 10); ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14);
  ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(data.length, 24);
  ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
  central.push(ch, nameBuf);

  offset += lh.length + nameBuf.length + body.length;
}
const cd = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
const zip = Buffer.concat([...local, cd, end]);

fs.mkdirSync(path.join(root, 'public'), { recursive: true });
fs.writeFileSync(path.join(root, 'public', OUT), zip);
if (fs.existsSync(path.join(root, 'dist'))) fs.writeFileSync(path.join(root, 'dist', OUT), zip);
console.log(`Wrote ${OUT} (${entries.length} files, ${(zip.length / 1024).toFixed(0)} KB)`);
