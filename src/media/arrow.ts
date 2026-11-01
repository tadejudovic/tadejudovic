import fs from "node:fs";
import zlib from "node:zlib";

/**
 * A curved red arrow, as a transparent full-frame PNG to lay over the video: from a point next to
 * the text to the thing the text names (like the arrows creators draw in CapCut).
 */

type Pt = { x: number; y: number };

const RED = [232, 20, 27];

function crc32(buf: Buffer): number {
  if (typeof (zlib as { crc32?: (b: Buffer) => number }).crc32 === "function") return (zlib as unknown as { crc32: (b: Buffer) => number }).crc32(buf);
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

function png(width: number, height: number, rgba: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Write the arrow PNG; `from` and `to` in pixels. Returns false if the arrow would be too short to read. */
export function writeArrow(file: string, width: number, height: number, from: Pt, to: Pt, thickness = 20): boolean {
  const len = Math.hypot(to.x - from.x, to.y - from.y);
  if (len < 60) return false;
  const rgba = Buffer.alloc(width * height * 4);
  const paint = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 4;
    rgba[i] = RED[0];
    rgba[i + 1] = RED[1];
    rgba[i + 2] = RED[2];
    rgba[i + 3] = 255;
  };
  const dot = (cx: number, cy: number, r: number) => {
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++)
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) paint(x, y);
  };
  // A gentle curve: the control point sits off to the side of the straight line.
  const ux = (to.x - from.x) / len;
  const uy = (to.y - from.y) / len;
  const side = to.x >= from.x ? 1 : -1;
  const ctrl = { x: (from.x + to.x) / 2 - uy * len * 0.3 * side, y: (from.y + to.y) / 2 + ux * len * 0.3 * side };
  const head = Math.max(34, thickness * 2.6);
  const at = (t: number) => ({
    x: (1 - t) ** 2 * from.x + 2 * (1 - t) * t * ctrl.x + t * t * to.x,
    y: (1 - t) ** 2 * from.y + 2 * (1 - t) * t * ctrl.y + t * t * to.y,
  });
  // The shaft stops where the head begins.
  const steps = Math.ceil(len / 2);
  let stopT = 1;
  for (let i = steps; i >= 0; i--) {
    const p = at(i / steps);
    if (Math.hypot(to.x - p.x, to.y - p.y) >= head * 0.8) {
      stopT = i / steps;
      break;
    }
  }
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * stopT;
    const p = at(t);
    dot(p.x, p.y, thickness / 2);
  }
  // Head: a triangle pointing along the curve's last direction.
  const base = at(stopT);
  const dx = to.x - base.x;
  const dy = to.y - base.y;
  const dl = Math.hypot(dx, dy) || 1;
  const nx = -dy / dl;
  const ny = dx / dl;
  const half = head * 0.62;
  const a = { x: base.x + nx * half, y: base.y + ny * half };
  const b = { x: base.x - nx * half, y: base.y - ny * half };
  const c = to;
  const area = (p: Pt, q: Pt, r: Pt) => (q.x - p.x) * (r.y - p.y) - (r.x - p.x) * (q.y - p.y);
  const minX = Math.floor(Math.min(a.x, b.x, c.x));
  const maxX = Math.ceil(Math.max(a.x, b.x, c.x));
  const minY = Math.floor(Math.min(a.y, b.y, c.y));
  const maxY = Math.ceil(Math.max(a.y, b.y, c.y));
  const total = area(a, b, c);
  for (let y = minY; y <= maxY; y++)
    for (let x = minX; x <= maxX; x++) {
      const p = { x, y };
      const w0 = area(b, c, p) / total;
      const w1 = area(c, a, p) / total;
      const w2 = area(a, b, p) / total;
      if (w0 >= 0 && w1 >= 0 && w2 >= 0) paint(x, y);
    }
  fs.writeFileSync(file, png(width, height, rgba));
  return true;
}
