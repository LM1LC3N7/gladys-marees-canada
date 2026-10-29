// -----------------------------------------------------------------------------
// Draws cover.png (800 × 534, the store card) with Node alone: a tiny
// antialiased rasterizer, a stroke font for the capitals it needs and a PNG
// encoder on node:zlib. No dependency, run by hand:
//
//   node .github/scripts/cover.mjs
// -----------------------------------------------------------------------------

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const W = 800;
const H = 534;
const px = new Float32Array(W * H * 3);

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const WHITE = hex('#eef5fb');
const BLUE = hex('#6cc4f5');
const SUN = hex('#ffd36b');

// --- Background: the same night-blue gradient as the sibling covers -----------
const TOP = hex('#0f4c7d');
const BOTTOM = hex('#0a1d3a');
for (let y = 0; y < H; y += 1) {
  for (let x = 0; x < W; x += 1) {
    const t = Math.min(1, Math.max(0, (y / H) * 0.8 + (1 - x / W) * 0.35));
    for (let c = 0; c < 3; c += 1) {
      px[(y * W + x) * 3 + c] = TOP[c] + (BOTTOM[c] - TOP[c]) * t;
    }
  }
}

// --- Shapes: a coverage map per shape, blended once (no double alpha at joints)
function paint(bounds, coverageAt, color, alpha = 1) {
  const x0 = Math.max(0, Math.floor(bounds[0]));
  const y0 = Math.max(0, Math.floor(bounds[1]));
  const x1 = Math.min(W - 1, Math.ceil(bounds[2]));
  const y1 = Math.min(H - 1, Math.ceil(bounds[3]));
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const a = coverageAt(x + 0.5, y + 0.5) * alpha;
      if (a > 0) {
        const i = (y * W + x) * 3;
        for (let c = 0; c < 3; c += 1) {
          px[i + c] += (color[c] - px[i + c]) * a;
        }
      }
    }
  }
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));

function segmentDistance(x, y, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : clamp01(((x - ax) * dx + (y - ay) * dy) / len);
  return Math.hypot(x - ax - t * dx, y - ay - t * dy);
}

/** Polylines (lists of points) stroked with round caps and joins. */
function stroke(polylines, width, color, alpha = 1) {
  const segments = polylines.flatMap((line) => line.slice(1).map((p, i) => [line[i], p]));
  const xs = polylines.flat().map((p) => p[0]);
  const ys = polylines.flat().map((p) => p[1]);
  const pad = width;
  paint(
    [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad],
    (x, y) => {
      let d = Infinity;
      for (const [a, b] of segments) {
        d = Math.min(d, segmentDistance(x, y, a, b));
      }
      return clamp01(width / 2 + 0.5 - d);
    },
    color,
    alpha,
  );
}

function disc(cx, cy, r, color, alpha = 1) {
  paint(
    [cx - r - 1, cy - r - 1, cx + r + 1, cy + r + 1],
    (x, y) => clamp01(r + 0.5 - Math.hypot(x - cx, y - cy)),
    color,
    alpha,
  );
}

// --- A stroke font: capitals on a 4 × 6 grid ---------------------------------------
const O = [
  [1, 0],
  [3, 0],
  [4, 1],
  [4, 5],
  [3, 6],
  [1, 6],
  [0, 5],
  [0, 1],
  [1, 0],
];
const P = [
  [0, 6],
  [0, 0],
  [3, 0],
  [4, 1],
  [4, 2.2],
  [3, 3.2],
  [0, 3.2],
];
const GLYPHS = {
  A: [
    [
      [0, 6],
      [2, 0],
      [4, 6],
    ],
    [
      [0.7, 4],
      [3.3, 4],
    ],
  ],
  B: [
    [
      [0, 6],
      [0, 0],
      [3, 0],
      [4, 0.8],
      [4, 2.2],
      [3, 3],
      [0, 3],
    ],
    [
      [3, 3],
      [4, 3.8],
      [4, 5.2],
      [3, 6],
      [0, 6],
    ],
  ],
  C: [
    [
      [4, 1],
      [3, 0],
      [1, 0],
      [0, 1],
      [0, 5],
      [1, 6],
      [3, 6],
      [4, 5],
    ],
  ],
  D: [
    [
      [0, 0],
      [0, 6],
      [2.5, 6],
      [4, 4.5],
      [4, 1.5],
      [2.5, 0],
      [0, 0],
    ],
  ],
  E: [
    [
      [4, 0],
      [0, 0],
      [0, 6],
      [4, 6],
    ],
    [
      [0, 3],
      [3, 3],
    ],
  ],
  F: [
    [
      [4, 0],
      [0, 0],
      [0, 6],
    ],
    [
      [0, 3],
      [3, 3],
    ],
  ],
  G: [
    [
      [4, 1],
      [3, 0],
      [1, 0],
      [0, 1],
      [0, 5],
      [1, 6],
      [3, 6],
      [4, 5],
      [4, 3.2],
      [2.2, 3.2],
    ],
  ],
  H: [
    [
      [0, 0],
      [0, 6],
    ],
    [
      [4, 0],
      [4, 6],
    ],
    [
      [0, 3],
      [4, 3],
    ],
  ],
  I: [
    [
      [0.8, 0],
      [3.2, 0],
    ],
    [
      [2, 0],
      [2, 6],
    ],
    [
      [0.8, 6],
      [3.2, 6],
    ],
  ],
  K: [
    [
      [0, 0],
      [0, 6],
    ],
    [
      [4, 0],
      [0, 3.6],
    ],
    [
      [1.4, 2.4],
      [4, 6],
    ],
  ],
  L: [
    [
      [0, 0],
      [0, 6],
      [4, 6],
    ],
  ],
  M: [
    [
      [0, 6],
      [0, 0],
      [2, 3.5],
      [4, 0],
      [4, 6],
    ],
  ],
  N: [
    [
      [0, 6],
      [0, 0],
      [4, 6],
      [4, 0],
    ],
  ],
  O: [O],
  P: [P],
  R: [
    P,
    [
      [2.2, 3.2],
      [4, 6],
    ],
  ],
  S: [
    [
      [4, 1],
      [3, 0],
      [1, 0],
      [0, 1],
      [0, 2],
      [1, 3],
      [3, 3],
      [4, 4],
      [4, 5],
      [3, 6],
      [1, 6],
      [0, 5],
    ],
  ],
  T: [
    [
      [0, 0],
      [4, 0],
    ],
    [
      [2, 0],
      [2, 6],
    ],
  ],
  U: [
    [
      [0, 0],
      [0, 5],
      [1, 6],
      [3, 6],
      [4, 5],
      [4, 0],
    ],
  ],
  W: [
    [
      [0, 0],
      [1, 6],
      [2, 2.5],
      [3, 6],
      [4, 0],
    ],
  ],
  X: [
    [
      [0, 0],
      [4, 6],
    ],
    [
      [4, 0],
      [0, 6],
    ],
  ],
  Y: [
    [
      [0, 0],
      [2, 3],
      [4, 0],
    ],
    [
      [2, 3],
      [2, 6],
    ],
  ],
  '·': [
    [
      [1.75, 2.75],
      [2.25, 2.75],
      [2.25, 3.25],
      [1.75, 3.25],
      [1.75, 2.75],
    ],
  ],
  V: [
    [
      [0, 0],
      [2, 6],
      [4, 0],
    ],
  ],
  Q: [
    O,
    [
      [2.6, 4.4],
      [4.2, 6.2],
    ],
  ],
  0: [O],
  1: [
    [
      [1, 1],
      [2, 0],
      [2, 6],
    ],
    [
      [1, 6],
      [3, 6],
    ],
  ],
  2: [
    [
      [0, 1],
      [1, 0],
      [3, 0],
      [4, 1],
      [4, 2.4],
      [0, 6],
      [4, 6],
    ],
  ],
  5: [
    [
      [4, 0],
      [0.4, 0],
      [0, 3],
      [3, 2.8],
      [4, 3.8],
      [4, 5],
      [3, 6],
      [1, 6],
      [0, 5],
    ],
  ],
  '.': [
    [
      [1.75, 5.5],
      [2.25, 5.5],
      [2.25, 6],
      [1.75, 6],
      [1.75, 5.5],
    ],
  ],
  ' ': [],
};

function text(string, x, y, size, color, alpha = 1, weight = 0.55) {
  let cursor = x;
  const lines = [];
  for (const char of string) {
    const glyph = GLYPHS[char];
    if (!glyph) {
      throw new Error(`No glyph for "${char}"`);
    }
    for (const line of glyph) {
      lines.push(line.map(([gx, gy]) => [cursor + gx * size, y + gy * size]));
    }
    cursor += 5.6 * size;
  }
  stroke(lines, weight * size, color, alpha);
  return cursor;
}

// --- The moon, the sea and two days of tide -------------------------------------
disc(690, 110, 34, SUN, 0.9);
disc(704, 100, 30, hex('#0f4c7d'), 1);
// Two days of predicted tide: semidiurnal, a little uneven, as Halifax draws it.
const tide = Array.from({ length: 121 }, (_, k) => {
  const t = k / 120;
  return [440 + t * 330, 300 - Math.sin(t * Math.PI * 7.8) * (52 + Math.sin(t * Math.PI * 2) * 10)];
});
stroke([tide], 5, BLUE);
// High and low tides marked.
for (let k = 1; k < 120; k += 1) {
  const [x, y] = tide[k];
  if ((y < tide[k - 1][1] && y <= tide[k + 1][1]) || (y > tide[k - 1][1] && y >= tide[k + 1][1])) {
    disc(x, y, 7, y < 300 ? WHITE : SUN);
  }
}
// The sea below, three waves wider towards the viewer.
for (const [i, y] of [392, 420, 452].entries()) {
  const wave = Array.from({ length: 41 }, (_, k) => {
    const t = k / 40;
    return [440 + t * 330, y + Math.sin(t * Math.PI * 5 + i) * (5 + i * 2)];
  });
  stroke([wave], 4 + i * 2, BLUE, 0.85 - i * 0.2);
}

// --- The texts ----------------------------------------------------------------------------
text('MAREES CANADA', 48, 92, 5.4, WHITE, 1, 0.62);
text('TIDES AND WATER LEVELS', 48, 182, 2.9, WHITE, 0.92);
text('IN GLADYS', 48, 218, 2.9, WHITE, 0.92);
text('NEXT HIGH · LOW TIDE', 48, 290, 2.5, SUN, 0.95);
text('OBSERVED LEVEL', 48, 322, 2.5, SUN, 0.95);
text('DATA OF THE CANADIAN', 48, 380, 2.3, WHITE, 0.85);
text('HYDROGRAPHIC SERVICE', 48, 408, 2.3, WHITE, 0.85);

text('NOT FOR NAVIGATION · UNOFFICIAL · GLADYS INTEGRATION', 48, 478, 2.2, WHITE, 0.8, 0.5);

// --- PNG encoding -----------------------------------------------------------------------------
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});
const crc32 = (buffer) => {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};

const raw = Buffer.alloc(H * (W * 3 + 1));
for (let y = 0; y < H; y += 1) {
  raw[y * (W * 3 + 1)] = 0;
  for (let x = 0; x < W * 3; x += 1) {
    raw[y * (W * 3 + 1) + 1 + x] = Math.round(Math.min(255, Math.max(0, px[y * W * 3 + x])));
  }
}
const header = Buffer.alloc(13);
header.writeUInt32BE(W, 0);
header.writeUInt32BE(H, 4);
header[8] = 8; // bit depth
header[9] = 2; // RGB
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(new URL('../../cover.png', import.meta.url), png);
console.log(`cover.png: ${W} × ${H}, ${png.length} bytes`);
