// Generates cover.png (800x534) for gladys-egauge: plain Node, no dependency.
// An electrical panel whose circuits pass through current clamps, an energy
// meter showing a power curve, the sun and a home, on a gradient (no brand
// logo).
// Usage: node scripts/cover.mjs cover.png
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const W = 800;
const H = 534;
const px = Buffer.alloc(W * H * 3);
const set = (x, y, [r, g, b], a = 1) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  px[i] = px[i] * (1 - a) + r * a;
  px[i + 1] = px[i + 1] * (1 - a) + g * a;
  px[i + 2] = px[i + 2] * (1 - a) + b * a;
};
const skyAt = (x, y) => {
  const t = (x / W) * 0.7 + (y / H) * 0.3;
  return [60 + 40 * t, 150 - 90 * t, 220 - 110 * t];
};
for (let y = 0; y < H; y += 1) {
  for (let x = 0; x < W; x += 1) {
    set(x, y, skyAt(x, y));
  }
}
const white = [255, 255, 255];
const dark = [28, 38, 64];
const sun = [255, 200, 50];
const green = [90, 210, 130];
const disc = (cx, cy, r, color, alpha = 1) => {
  for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y += 1) {
    for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x += 1) {
      const a = Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy) + 0.5));
      if (a > 0) set(x, y, color, a * alpha);
    }
  }
};
const box = (x0, y0, x1, y1, r, color, alpha = 1) => {
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const cx = Math.min(Math.max(x, x0 + r), x1 - r);
      const cy = Math.min(Math.max(y, y0 + r), y1 - r);
      const a = Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy) + 0.5));
      if (a > 0) set(x, y, color, a * alpha);
    }
  }
};
const line = (x0, y0, x1, y1, width, color) => {
  const minX = Math.floor(Math.min(x0, x1) - width);
  const maxX = Math.ceil(Math.max(x0, x1) + width);
  const minY = Math.floor(Math.min(y0, y1) - width);
  const maxY = Math.ceil(Math.max(y0, y1) + width);
  const len2 = (x1 - x0) ** 2 + (y1 - y0) ** 2 || 1;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const t = Math.max(0, Math.min(1, ((x - x0) * (x1 - x0) + (y - y0) * (y1 - y0)) / len2));
      const d = Math.hypot(x - (x0 + t * (x1 - x0)), y - (y0 + t * (y1 - y0)));
      const a = Math.max(0, Math.min(1, width / 2 - d + 0.5));
      if (a > 0) set(x, y, color, a);
    }
  }
};

disc(400, 270, 260, white, 0.05);
const orange = [255, 150, 60];
const grey = [200, 210, 225];

// The sun, top right.
disc(700, 90, 40, sun);
for (let k = 0; k < 8; k += 1) {
  const a = (k * Math.PI) / 4;
  line(
    700 + 54 * Math.cos(a),
    90 + 54 * Math.sin(a),
    700 + 72 * Math.cos(a),
    90 + 72 * Math.sin(a),
    7,
    sun,
  );
}

// The electrical panel, left: breakers in two columns, each circuit through a clamp.
box(60, 110, 300, 470, 18, white);
box(80, 130, 280, 450, 10, dark);
for (let i = 0; i < 6; i += 1) {
  const y = 150 + i * 50;
  box(100, y, 160, y + 30, 5, grey);
  box(200, y, 260, y + 30, 5, grey);
  disc(180, y + 15, 9, orange);
}

// The meter, middle: a screen with a power curve, wired to the panel.
line(300, 290, 360, 290, 8, white);
box(360, 180, 600, 400, 20, white);
box(380, 200, 580, 330, 10, dark);
let prev;
for (let x = 390; x <= 570; x += 6) {
  const y = 300 - 45 * Math.abs(Math.sin((x - 390) / 30)) - ((x - 390) / 180) * 30;
  if (prev) line(prev[0], prev[1], x, y, 4, green);
  prev = [x, y];
}
disc(410, 365, 10, green);
disc(445, 365, 10, sun);
disc(480, 365, 10, orange);

// The home, right, fed by the meter.
line(600, 290, 640, 290, 8, white);
box(640, 300, 760, 450, 10, white);
line(630, 305, 700, 240, 12, white);
line(700, 240, 770, 305, 12, white);
box(685, 390, 715, 450, 4, dark);
// PNG encoding.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;
ihdr[9] = 2;
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y += 1) {
  raw[y * (W * 3 + 1)] = 0;
  px.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(process.argv[2] ?? 'cover.png', png);
console.log('cover', png.length, 'bytes');
