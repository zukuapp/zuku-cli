import { inflateSync } from 'node:zlib';

// Small bounded PNG decoder for screenshots (8-bit RGB/RGBA, non-interlaced) so playtest
// verdicts are computed from real pixels rather than from a runner's own claims.
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_PIXELS = 4096 * 4096;

export function decodePng(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input ?? []);
  if (buf.length < 33 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('png');
  let offset = 8, width, height, channels;
  const idat = [];
  while (offset + 12 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (data.length !== length) throw new Error('png');
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      const depth = data[8], color = data[9], interlace = data[12];
      if (depth !== 8 || interlace !== 0 || ![2, 6].includes(color) || !width || !height || width * height > MAX_PIXELS) throw new Error('png');
      channels = color === 6 ? 4 : 3;
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  if (!channels || !idat.length) throw new Error('png');
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat), { maxOutputLength: (stride + 1) * height });
  if (raw.length !== (stride + 1) * height) throw new Error('png');
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      else if (filter !== 0) throw new Error('png');
      out[x] = value & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

const samples = (image, step) => {
  const out = [];
  for (let y = 0; y < image.height; y += step) for (let x = 0; x < image.width; x += step) {
    const i = (y * image.width + x) * image.channels;
    out.push((image.pixels[i] << 16) | (image.pixels[i + 1] << 8) | image.pixels[i + 2]);
  }
  return out;
};

/** Distinct sampled colors (capped) and luminance spread of a screenshot. */
export function imageStats(png, step = 6) {
  const image = decodePng(png);
  const colors = new Set();
  let sum = 0, square = 0;
  const values = samples(image, step);
  for (const rgb of values) {
    if (colors.size < 4096) colors.add(rgb);
    const lum = 0.2126 * (rgb >> 16) + 0.7152 * ((rgb >> 8) & 0xff) + 0.0722 * (rgb & 0xff);
    sum += lum; square += lum * lum;
  }
  const mean = sum / values.length;
  return { width: image.width, height: image.height, distinct_colors: colors.size, luminance_stddev: Math.sqrt(Math.max(0, square / values.length - mean * mean)) };
}

/** Fraction of sampled pixels that differ noticeably between two same-sized screenshots. */
export function frameDifference(pngA, pngB, step = 4) {
  const a = decodePng(pngA), b = decodePng(pngB);
  if (a.width !== b.width || a.height !== b.height) return 1;
  const sa = samples(a, step), sb = samples(b, step);
  let changed = 0;
  for (let i = 0; i < sa.length; i++) {
    const x = sa[i], y = sb[i];
    if (Math.abs((x >> 16) - (y >> 16)) + Math.abs(((x >> 8) & 0xff) - ((y >> 8) & 0xff)) + Math.abs((x & 0xff) - (y & 0xff)) > 24) changed++;
  }
  return changed / sa.length;
}
