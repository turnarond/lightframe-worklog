// genicon —— 纯 Node 生成 256x256 应用图标（PNG，自带 CRC32 + zlib）
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZE = 256;

// ---------- CRC32 ----------
const CRC_TABLE = (function () {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------- PNG 编码 ----------
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crcBuf]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }

  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ---------- 绘图 ----------
const PAPER = [243, 236, 224];
const ACCENT = [194, 97, 63];
const WHITE = [255, 250, 243];

function insideRoundRect(px, py, x, y, w, h, r) {
  if (px < x || px > x + w || py < y || py > y + h) return false;
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

/** 返回该采样点的颜色（由上到下覆盖） */
function sample(px, py) {
  let color = PAPER;

  // 火漆色圆角面板
  if (insideRoundRect(px, py, 28, 28, 200, 200, 46)) {
    color = ACCENT;
  }

  // 三条任务线（宽度递减）
  const bars = [
    { y: 88, w: 104 },
    { y: 121, w: 84 },
    { y: 154, w: 62 }
  ];
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const x = 68;
    if (insideRoundRect(px, py, x, bar.y, bar.w, 16, 8)) color = WHITE;
  }

  return color;
}

function render() {
  const buf = Buffer.alloc(SIZE * SIZE * 4);
  const OFFSETS = [0.25, 0.75];

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < OFFSETS.length; sy++) {
        for (let sx = 0; sx < OFFSETS.length; sx++) {
          const c = sample(x + OFFSETS[sx], y + OFFSETS[sy]);
          r += c[0];
          g += c[1];
          b += c[2];
        }
      }
      const n = OFFSETS.length * OFFSETS.length;
      const i = (y * SIZE + x) * 4;
      buf[i] = Math.round(r / n);
      buf[i + 1] = Math.round(g / n);
      buf[i + 2] = Math.round(b / n);
      buf[i + 3] = 255;
    }
  }
  return buf;
}

// ---------- 输出 ----------
const outDir = path.join(__dirname, '..', 'assets');
const outFile = path.join(outDir, 'icon.png');

fs.mkdirSync(outDir, { recursive: true });
const png = encodePng(SIZE, SIZE, render());
fs.writeFileSync(outFile, png);

console.log('已生成 ' + outFile + '（' + SIZE + 'x' + SIZE + '，' + png.length + ' 字节）');
