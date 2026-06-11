'use strict';
// Generates the PWA icons as PNGs with zero dependencies (manual PNG encoding
// via zlib). Run: node tools/make-icons.js

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// ---------------- PNG encoder ----------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = ~0;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4);
    raw[rowStart] = 0; // filter: none
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ---------------- icon drawing ----------------
// Glossy Aero-blue rounded square with the app's four-pointed star (astroid).
function drawIcon(size, { cornerFrac, starFrac, fullBleed }) {
  const px = Buffer.alloc(size * size * 4);
  const radius = size * cornerFrac;
  const cx = size / 2;
  const starR = (size * starFrac) / 2;
  const top = [0x79, 0xae, 0xf0];
  const bottom = [0x1c, 0x3f, 0x7d];

  const insideRect = (x, y) => {
    if (fullBleed) return x >= 0 && x < size && y >= 0 && y < size;
    const nx = Math.max(radius - x, x - (size - radius), 0);
    const ny = Math.max(radius - y, y - (size - radius), 0);
    return nx * nx + ny * ny <= radius * radius;
  };

  const insideStar = (x, y) => {
    const dx = Math.abs(x - cx) / starR;
    const dy = Math.abs(y - cx) / starR;
    return Math.pow(dx, 2 / 3) + Math.pow(dy, 2 / 3) <= 1;
  };

  const S = 3; // supersampling grid
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let aSum = 0;
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const fx = x + (sx + 0.5) / S;
          const fy = y + (sy + 0.5) / S;
          if (!insideRect(fx, fy)) continue;
          aSum++;
          let cr, cg, cb;
          if (insideStar(fx, fy)) {
            cr = cg = cb = 255;
          } else {
            const v = fy / size;
            cr = top[0] + (bottom[0] - top[0]) * v;
            cg = top[1] + (bottom[1] - top[1]) * v;
            cb = top[2] + (bottom[2] - top[2]) * v;
            // glossy highlight on the upper half
            const gloss = Math.max(0, (0.48 - v) / 0.48) * 0.22;
            cr += (255 - cr) * gloss;
            cg += (255 - cg) * gloss;
            cb += (255 - cb) * gloss;
          }
          r += cr; g += cg; b += cb;
        }
      }
      const i = (y * size + x) * 4;
      if (aSum > 0) {
        px[i] = Math.round(r / aSum);
        px[i + 1] = Math.round(g / aSum);
        px[i + 2] = Math.round(b / aSum);
        px[i + 3] = Math.round((aSum / (S * S)) * 255);
      }
    }
  }
  return encodePng(size, size, px);
}

const outDir = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });

fs.writeFileSync(path.join(outDir, 'icon-192.png'), drawIcon(192, { cornerFrac: 0.21, starFrac: 0.6, fullBleed: false }));
fs.writeFileSync(path.join(outDir, 'icon-512.png'), drawIcon(512, { cornerFrac: 0.21, starFrac: 0.6, fullBleed: false }));
// maskable: full-bleed with the star inside the 80% safe zone
fs.writeFileSync(path.join(outDir, 'icon-maskable-512.png'), drawIcon(512, { cornerFrac: 0, starFrac: 0.46, fullBleed: true }));

console.log('icons written to', outDir);
