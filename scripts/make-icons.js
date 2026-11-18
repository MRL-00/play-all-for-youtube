#!/usr/bin/env node
/**
 * Generates the extension icons (rounded red badge + white play triangle).
 * Pure Node, no dependencies: renders at 4x and box-downsamples for clean edges.
 *
 *   node scripts/make-icons.js
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZES = [16, 32, 48, 128];
const OUT_DIR = path.join(__dirname, '..', 'icons');
const SS = 4; // supersampling factor

const BG = [255, 0, 51];
const FG = [255, 255, 255];

/* ---------------- CRC32 ---------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------- drawing ---------------- */

function roundedRect(x, y, w, h, r) {
  const dx = Math.max(x - r < 0.5 ? 0 : 0, 0);
  void dx;
  const cx = Math.min(Math.max(x, r), w - r);
  const cy = Math.min(Math.max(y, r), h - r);
  const dist = Math.hypot(x - cx, y - cy);
  return dist <= r;
}

function inTriangle(x, y, ax, ay, bx, by, cx, cy) {
  const d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by);
  const d2 = (x - cx) * (by - cy) - (bx - cx) * (y - cy);
  const d3 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

function renderIcon(size) {
  const W = size * SS;
  const H = size * SS;
  const radius = W * 0.22;

  // play triangle, nudged right of centre so it looks optically centred
  const triLeft = W * 0.335;
  const triRight = W * 0.735;
  const triTop = H * 0.255;
  const triBottom = H * 0.745;

  const out = Buffer.alloc(size * size * 4);
  const samples = SS * SS;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const px = x * SS + sx + 0.5;
          const py = y * SS + sy + 0.5;

          if (!roundedRect(px, py, W, H, radius)) continue;

          const onTriangle = inTriangle(
            px, py,
            triLeft, triTop,
            triLeft, triBottom,
            triRight, H * 0.5,
          );

          const colour = onTriangle ? FG : BG;
          r += colour[0];
          g += colour[1];
          b += colour[2];
          a += 255;
        }
      }

      const idx = (y * size + x) * 4;
      if (a === 0) continue;
      const covered = a / 255;
      out[idx] = Math.round(r / covered);
      out[idx + 1] = Math.round(g / covered);
      out[idx + 2] = Math.round(b / covered);
      out[idx + 3] = Math.round(a / samples);
    }
  }

  return encodePng(size, size, out);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const file = path.join(OUT_DIR, `icon${size}.png`);
  fs.writeFileSync(file, renderIcon(size));
  console.log(`wrote ${path.relative(process.cwd(), file)}`);
}
