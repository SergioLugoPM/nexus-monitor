// One-off generator for the tray/window icon — a minimal hand-built PNG
// (no canvas/sharp dependency) so the repo doesn't need a binary asset
// pipeline for a single 32x32 glyph. Run once with `node electron/gen-icon.js`;
// the output is committed, this script doesn't need to run again unless the
// icon design changes.
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const SIZE = 32;
const BG = [10, 20, 16, 255];      // #0a1410 — matches dashboard deep bg
const FG = [93, 202, 165, 255];    // #5DCAA5 — matches dashboard hi accent

// Simple radar-blip glyph: filled circle + crosshair, readable at 16px.
function pixel(x, y) {
  const cx = SIZE / 2, cy = SIZE / 2;
  const dx = x - cx + 0.5, dy = y - cy + 0.5;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < SIZE * 0.28) return FG;
  if (dist < SIZE * 0.38 && dist > SIZE * 0.30) return FG; // ring
  if (Math.abs(dx) < 1 && dist < SIZE * 0.48) return FG;   // vertical crosshair
  if (Math.abs(dy) < 1 && dist < SIZE * 0.48) return FG;   // horizontal crosshair
  return BG;
}

function crc32(buf) {
  let c, table = crc32.table || (crc32.table = (() => {
    const t = [];
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

const rows = [];
for (let y = 0; y < SIZE; y++) {
  const row = [0]; // filter type: none
  for (let x = 0; x < SIZE; x++) row.push(...pixel(x, y));
  rows.push(Buffer.from(row));
}
const raw = Buffer.concat(rows);
const idat = zlib.deflateSync(raw);

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr.writeUInt8(8, 8);   // bit depth
ihdr.writeUInt8(6, 9);   // color type RGBA
ihdr.writeUInt8(0, 10);
ihdr.writeUInt8(0, 11);
ihdr.writeUInt8(0, 12);

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0)),
]);

const outPath = path.join(__dirname, 'assets', 'icon.png');
fs.writeFileSync(outPath, png);
console.log('Icon written to', outPath, '(' + png.length + ' bytes)');
