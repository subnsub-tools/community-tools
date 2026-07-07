/* LSB Stego Detector — fully client-side image steganalysis. Core logic
   of the Stego Detector tool on subnsub.com, kept in lockstep with the
   in-page version.

   A Westfeld–Pfitzmann chi-square attack, a sequential payload map, a
   bit-plane extractor and an LSB byte extractor. No network, no upload.
   All functions take raw RGBA pixels (the Uint8ClampedArray out of
   canvas getImageData) — nothing here touches the DOM. */

export const MAX_PIXELS = 20e6;          /* 20 MP analysis cap (ImageData ≈ 80 MB) */
export const MAX_DIM = 16384;            /* per-side cap — conservative cross-browser canvas limit */
export const MAX_EXTRACT_BYTES = 4096;   /* extractor preview depth — enough to detect a payload */

const CHAN = { r: 0, g: 1, b: 2, a: 3 };

/* ── chi-square machinery (regularised lower incomplete gamma) ── */
function gammaln(x) {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x, tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) { y++; ser += c[j] / y; }
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}

function gammaP(s, x) {
  if (x <= 0 || s <= 0) return 0;
  if (x < s + 1) {
    let ap = s, sum = 1 / s, del = sum;
    for (let n = 0; n < 300; n++) { ap++; del *= x / ap; sum += del; if (Math.abs(del) < Math.abs(sum) * 1e-13) break; }
    return sum * Math.exp(-x + s * Math.log(x) - gammaln(s));
  }
  let b = x + 1 - s, c = 1e300, d = 1 / b, h = d;
  for (let i = 1; i <= 300; i++) {
    const an = -i * (i - s); b += 2;
    d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d; const dl = d * c; h *= dl;
    if (Math.abs(dl - 1) < 1e-13) break;
  }
  return 1 - Math.exp(-x + s * Math.log(x) - gammaln(s)) * h;
}

/* Probability that random data was LSB-embedded, from a value histogram.
   Pairs-of-Values (2i, 2i+1) equalise under embedding; small χ² → high p. */
export function chiEmbed(hist) {
  let chi = 0, k = 0;
  for (let i = 0; i < 128; i++) {
    const a = hist[2 * i], b = hist[2 * i + 1], e = (a + b) / 2;
    if (e >= 1) { const dd = a - e; chi += dd * dd / e; k++; }
  }
  const df = k - 1;
  if (df <= 0) return 0;
  return 1 - gammaP(df / 2, chi / 2);
}

function isConstant(hist) {
  let seen = 0;
  for (let i = 0; i < 256; i++) { if (hist[i]) { seen++; if (seen > 1) return false; } }
  return true;
}

export function detectAlpha(d) {
  for (let i = 3; i < d.length; i += 4) { if (d[i] !== 255) return true; }
  return false;
}

/* Per-channel chi-square analysis of RGBA pixels.
   Returns { channels, hasAlpha, maxP }; each channel is
   { key, p, ratio, constant } — p is P(LSB-embedded), ratio the share of
   set LSBs, and constant channels carry p = 0 (a chi-square over one
   value is meaningless — flat fills otherwise false-positive). */
export function analyzeChannels(d, w, h) {
  const n = w * h;
  const hR = new Int32Array(256), hG = new Int32Array(256), hB = new Int32Array(256), hA = new Int32Array(256);
  let setR = 0, setG = 0, setB = 0, setA = 0;
  for (let p = 0, i = 0; i < n; i++, p += 4) {
    const r = d[p], g = d[p + 1], b = d[p + 2], a = d[p + 3];
    hR[r]++; hG[g]++; hB[b]++; hA[a]++;
    setR += r & 1; setG += g & 1; setB += b & 1; setA += a & 1;
  }
  const hasAlpha = detectAlpha(d);
  const channels = [
    { key: 'R', hist: hR, set: setR },
    { key: 'G', hist: hG, set: setG },
    { key: 'B', hist: hB, set: setB },
  ];
  if (hasAlpha) channels.push({ key: 'A', hist: hA, set: setA });
  let maxP = 0;
  channels.forEach((c) => {
    c.constant = isConstant(c.hist);
    c.p = c.constant ? 0 : chiEmbed(c.hist);
    c.ratio = c.set / n;
    if (!c.constant && c.p > maxP) maxP = c.p;
    delete c.hist;
    delete c.set;
  });
  return { channels, hasAlpha, maxP };
}

/* Sequential payload map: chi-square per row-major segment (RGB values
   pooled). Returns a Float64Array of P(embedded), one per segment —
   sequential embedding lights up leading segments and drops off where
   the payload ends. Returns null when the image is too small to map. */
export function segmentScan(d, w, h, segments = 64) {
  const n = w * h;
  if (n < segments) return null;
  const hists = [];
  for (let s = 0; s < segments; s++) hists.push(new Int32Array(256));
  const per = n / segments;
  for (let p = 0, i = 0; i < n; i++, p += 4) {
    let seg = (i / per) | 0;
    if (seg >= segments) seg = segments - 1;
    const hh = hists[seg];
    hh[d[p]]++; hh[d[p + 1]]++; hh[d[p + 2]]++;
  }
  const out = new Float64Array(segments);
  for (let g = 0; g < segments; g++) out[g] = chiEmbed(hists[g]);
  return out;
}

/* Render one bit plane as an RGBA buffer (feed to a canvas ImageData).
   chan: 'r' | 'g' | 'b' | 'a' | 'rgb'; bit: 0 (LSB) … 7 (MSB). */
export function bitPlane(d, w, h, chan, bit) {
  const mask = 1 << bit, len = w * h * 4;
  const o = new Uint8ClampedArray(len);
  if (chan === 'rgb') {
    for (let p = 0; p < len; p += 4) {
      o[p] = (d[p] & mask) ? 255 : 0;
      o[p + 1] = (d[p + 1] & mask) ? 255 : 0;
      o[p + 2] = (d[p + 2] & mask) ? 255 : 0;
      o[p + 3] = 255;
    }
  } else {
    const ci = CHAN[chan] != null ? CHAN[chan] : 0;
    for (let q = 0; q < len; q += 4) {
      const v = (d[q + ci] & mask) ? 255 : 0;
      o[q] = v; o[q + 1] = v; o[q + 2] = v; o[q + 3] = 255;
    }
  }
  return o;
}

/* Extract embedded bytes from a bit plane.
     channels  array like ['r','g','b'] — read order within a pixel
     bit       0 (LSB) … 7 (MSB)
     order     'msb' | 'lsb' — bit packing order within each output byte
     scan      'xy' (row-major) | 'yx' (column-major)
     maxBytes  preview depth cap
   Returns { bytes, total } — total is how many bytes the whole image
   could yield at these settings. */
export function extractBits(d, w, h, { channels = ['r', 'g', 'b'], bit = 0, order = 'msb', scan = 'xy', maxBytes = MAX_EXTRACT_BYTES } = {}) {
  const sel = channels.map((k) => CHAN[k]).filter((v) => v != null);
  const nc = sel.length;
  const total = nc ? Math.floor(w * h * nc / 8) : 0;
  const out = new Uint8Array(Math.min(maxBytes, total));
  let oi = 0;
  if (!nc || !out.length) return { bytes: out.subarray(0, 0), total: 0 };
  const mask = 1 << bit, msb = (order === 'msb');
  let cur = 0, nb = 0, x, y, p, c, bt;
  if (scan === 'yx') {
    for (x = 0; x < w && oi < out.length; x++) {
      for (y = 0; y < h; y++) {
        p = (y * w + x) * 4;
        for (c = 0; c < nc; c++) {
          bt = (d[p + sel[c]] & mask) ? 1 : 0;
          if (msb) cur = (cur << 1) | bt; else cur |= bt << nb;
          if (++nb === 8) { out[oi++] = cur & 255; cur = 0; nb = 0; if (oi >= out.length) break; }
        }
        if (oi >= out.length) break;
      }
    }
  } else {
    const len = w * h;
    for (let i = 0; i < len && oi < out.length; i++) {
      p = i * 4;
      for (c = 0; c < nc; c++) {
        bt = (d[p + sel[c]] & mask) ? 1 : 0;
        if (msb) cur = (cur << 1) | bt; else cur |= bt << nb;
        if (++nb === 8) { out[oi++] = cur & 255; cur = 0; nb = 0; if (oi >= out.length) break; }
      }
    }
  }
  return { bytes: out.subarray(0, oi), total };
}

/* ── payload identification ── */
const MAGIC = [
  { sig: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], key: 'png', label: 'PNG image' },
  { sig: [0xff, 0xd8, 0xff], key: 'jpeg', label: 'JPEG image' },
  { sig: [0x47, 0x49, 0x46, 0x38], key: 'gif', label: 'GIF image' },
  { sig: [0x42, 0x4d], key: 'bmp', label: 'BMP image' },
  { sig: [0x25, 0x50, 0x44, 0x46], key: 'pdf', label: 'PDF document' },
  { sig: [0x50, 0x4b, 0x03, 0x04], key: 'zip', label: 'ZIP / Office archive' },
  { sig: [0x52, 0x61, 0x72, 0x21], key: 'rar', label: 'RAR archive' },
  { sig: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], key: 'sevenz', label: '7-Zip archive' },
  { sig: [0x1f, 0x8b], key: 'gzip', label: 'gzip stream' },
  { sig: [0x42, 0x5a, 0x68], key: 'bzip2', label: 'bzip2 stream' },
  { sig: [0x7f, 0x45, 0x4c, 0x46], key: 'elf', label: 'ELF binary' },
  { sig: [0x4f, 0x67, 0x67, 0x53], key: 'ogg', label: 'OGG media' },
  { sig: [0x52, 0x49, 0x46, 0x46], key: 'riff', label: 'RIFF (WAV/AVI)' },
  { sig: [0x66, 0x4c, 0x61, 0x43], key: 'flac', label: 'FLAC audio' },
  { sig: [0x1a, 0x45, 0xdf, 0xa3], key: 'mkv', label: 'Matroska / WebM' },
  { sig: [0xef, 0xbb, 0xbf], key: 'bom', label: 'UTF-8 text (BOM)' },
];

/* Sniff extracted bytes: a known file signature → { key, label }; a run of
   ≥ 6 printable leading chars → { key: 'text', chars }; else null. */
export function detectMagic(b) {
  for (let m = 0; m < MAGIC.length; m++) {
    const s = MAGIC[m].sig;
    if (b.length < s.length) continue;
    let ok = true;
    for (let i = 0; i < s.length; i++) { if (b[i] !== s[i]) { ok = false; break; } }
    if (ok) return { key: MAGIC[m].key, label: MAGIC[m].label };
  }
  let run = 0;
  for (let j = 0; j < b.length; j++) { const c = b[j]; if (c === 9 || c === 10 || c === 13 || (c >= 32 && c <= 126)) run++; else break; }
  if (run >= 6) return { key: 'text', label: 'ASCII text', chars: run };
  return null;
}

/* Printable rendering of extracted bytes (non-printables → ·). */
export function toPrintable(b) {
  let s = '';
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    if (c === 10) s += '\n';
    else if (c === 13) s += '\r';   /* keep CRLF intact — detectMagic also counts \r as text */
    else if (c === 9) s += '\t';
    else if (c >= 32 && c <= 126) s += String.fromCharCode(c);
    else s += '·';
  }
  return s;
}

/* Classic hex dump: offset, 16 bytes, ASCII gutter. */
export function toHexDump(b) {
  const HEX = '0123456789abcdef', lines = [];
  for (let off = 0; off < b.length; off += 16) {
    let hex = '', asc = '';
    for (let i = 0; i < 16; i++) {
      if (off + i < b.length) {
        const c = b[off + i];
        hex += HEX[c >> 4] + HEX[c & 15] + ' ';
        asc += (c >= 32 && c <= 126) ? String.fromCharCode(c) : '.';
      } else hex += '   ';
      if (i === 7) hex += ' ';
    }
    lines.push(('00000000' + off.toString(16)).slice(-8) + '  ' + hex + ' ' + asc);
  }
  return lines.join('\n');
}
