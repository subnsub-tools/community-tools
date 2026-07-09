/* EXIF Cleaner — byte-level metadata strip for JPEG / PNG / WebP. Core
   logic of the EXIF Cleaner tool on subnsub.com, kept in lockstep with
   the in-page version.

   Never a re-encode: the image bitstream (JPEG entropy data, PNG IDAT,
   WebP payload) is copied verbatim, so the output pixels are
   bit-identical to the input.

     JPEG — drops APP1 (EXIF + XMP), APP13 (IPTC), COM, MPF and vendor
            APPn segments plus anything after EOI (gain maps, appended
            blobs); keeps APP0 (JFIF), ICC APP2 and APP14 (the Adobe
            colour-transform tag decoders need). A non-1 EXIF Orientation
            survives via a minimal single-tag replacement segment so
            portrait shots stay upright after the strip.
     PNG  — drops tEXt, zTXt, iTXt, eXIf, tIME and unknown ancillary
            chunks; critical chunks and the technical whitelist (ICC,
            gamma, APNG animation) stay.
     WebP — drops EXIF and XMP chunks and clears the two VP8X header
            flag bits. (A WebP with an EXIF Orientation is a unicorn —
            cameras don't write WebP — so no orientation shim here.) */

export const MAX_BYTES = 256 * 1024 * 1024;

function ascii(u8, a, b) {
  let s = '';
  for (let i = a; i < b && i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return s;
}
function hasAscii(u8, off, str) {
  if (off + str.length > u8.length) return false;
  for (let i = 0; i < str.length; i++) if (u8[off + i] !== str.charCodeAt(i)) return false;
  return true;
}
function u32be(u8, p) { return ((u8[p] << 24) | (u8[p + 1] << 16) | (u8[p + 2] << 8) | u8[p + 3]) >>> 0; }
function u32le(u8, p) { return (u8[p] | (u8[p + 1] << 8) | (u8[p + 2] << 16) | (u8[p + 3] << 24)) >>> 0; }

/* ---- TIFF/EXIF reader — feeds the privacy preview only; the strip itself
   never depends on parsing (a hostile TIFF just previews less). Reads IFD0
   plus the Exif and GPS sub-IFDs, nothing else, so there is no next-IFD
   chain to loop on. All offsets are bounds-checked against the segment
   end. ---- */
function parseTiff(u8, off, end) {
  try {
    let le;
    if (u8[off] === 0x49 && u8[off + 1] === 0x49) le = true;
    else if (u8[off] === 0x4D && u8[off + 1] === 0x4D) le = false;
    else return null;
    const rd16 = (p) => le ? (u8[p] | (u8[p + 1] << 8)) : ((u8[p] << 8) | u8[p + 1]);
    const rd32 = (p) => le ? u32le(u8, p) : u32be(u8, p);
    if (rd16(off + 2) !== 42) return null;
    const SZ = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
    function readIfd(p) {
      const out = { __count: 0 };
      if (p <= off || p + 2 > end) return out;
      const cnt = Math.min(rd16(p), 512);
      out.__count = cnt;
      for (let i = 0; i < cnt; i++) {
        const e = p + 2 + i * 12;
        if (e + 12 > end) { out.__count = i; break; }
        out[rd16(e)] = { type: rd16(e + 2), count: rd32(e + 4), entry: e };
      }
      return out;
    }
    function valOff(ent) {
      const total = (SZ[ent.type] || 1) * ent.count;
      return total <= 4 ? ent.entry + 8 : off + rd32(ent.entry + 8);
    }
    function str(ent) {
      if (!ent || ent.type !== 2 || !ent.count) return null;
      const p = valOff(ent), e2 = Math.min(p + ent.count, end);
      let s = '';
      for (let i = p; i < e2; i++) {
        if (!u8[i]) break;
        s += (u8[i] >= 32 && u8[i] < 127) ? String.fromCharCode(u8[i]) : ' ';
      }
      s = s.replace(/\s+/g, ' ').trim();
      return s || null;
    }
    function short(ent) {
      if (!ent || !ent.count) return null;
      const p = valOff(ent);
      if (p + 4 > end) return null;
      return ent.type === 3 ? rd16(p) : ent.type === 4 ? rd32(p) : null;
    }
    function rat(ent, i) {
      const p = valOff(ent) + i * 8;
      if (p + 8 > end) return null;
      const den = rd32(p + 4);
      return den ? rd32(p) / den : null;
    }
    const ifd0 = readIfd(off + rd32(off + 4));
    let fields = ifd0.__count;
    const make = str(ifd0[0x010F]), model = str(ifd0[0x0110]);
    const software = str(ifd0[0x0131]), dt = str(ifd0[0x0132]);
    const orientation = short(ifd0[0x0112]) || 1;
    let dto = null, gps = null;
    const exifPtr = ifd0[0x8769] && ifd0[0x8769].count ? rd32(ifd0[0x8769].entry + 8) : 0;
    if (exifPtr) {
      const ex = readIfd(off + exifPtr);
      fields += ex.__count;
      dto = str(ex[0x9003]);
    }
    const gpsPtr = ifd0[0x8825] && ifd0[0x8825].count ? rd32(ifd0[0x8825].entry + 8) : 0;
    if (gpsPtr) {
      const g = readIfd(off + gpsPtr);
      fields += g.__count;
      const la = g[0x0002], lo = g[0x0004];
      if (la && lo && la.type === 5 && lo.type === 5 && la.count >= 3 && lo.count >= 3) {
        let lat = (rat(la, 0) || 0) + (rat(la, 1) || 0) / 60 + (rat(la, 2) || 0) / 3600;
        let lon = (rat(lo, 0) || 0) + (rat(lo, 1) || 0) / 60 + (rat(lo, 2) || 0) / 3600;
        if (str(g[0x0001]) === 'S') lat = -lat;
        if (str(g[0x0003]) === 'W') lon = -lon;
        if (isFinite(lat) && isFinite(lon) && (lat !== 0 || lon !== 0)) gps = { lat, lon };
      }
    }
    return { make, model, software, dt, dto, orientation, gps, fields };
  } catch (_) { return null; }
}

/* ---- JPEG ---- */
function scanJpeg(u8) {
  const segs = [];
  let pos = 2, sawEOI = false, eoiEnd = u8.length;
  const n = u8.length;
  while (pos < n) {
    if (u8[pos] !== 0xFF) return null;
    const start = pos;
    while (pos < n && u8[pos] === 0xFF) pos++;
    if (pos >= n) break;
    const marker = u8[pos]; pos++;
    if (marker === 0xD9) { segs.push({ start, end: pos, marker }); sawEOI = true; eoiEnd = pos; break; }
    if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) {
      segs.push({ start, end: pos, marker });
      continue;
    }
    if (pos + 2 > n) return null;
    const len = (u8[pos] << 8) | u8[pos + 1];
    if (len < 2 || pos + len > n) return null;
    let end = pos + len;
    const dataStart = pos + 2;
    if (marker === 0xDA) {
      /* entropy-coded scan data runs to the next real marker (FF followed
         by neither a stuffed 00 nor RST0-7); progressive files simply loop
         back here for the next scan */
      let p = end;
      while (p + 1 < n && !(u8[p] === 0xFF && u8[p + 1] !== 0x00 && (u8[p + 1] < 0xD0 || u8[p + 1] > 0xD7))) p++;
      end = (p + 1 < n) ? p : n;
    }
    segs.push({ start, end, marker, dataStart });
    pos = end;
  }
  if (!segs.length) return null;
  return { segs, trailing: sawEOI ? n - eoiEnd : 0 };
}

function analyzeJpeg(u8) {
  const scan = scanJpeg(u8);
  if (!scan) return null;
  const strips = [];
  let tiff = null, orientation = 1;
  scan.segs.forEach((s) => {
    const m = s.marker;
    if ((m >= 0xE1 && m <= 0xEF && m !== 0xEE) || m === 0xFE) {
      const size = s.end - s.start, dataLen = s.end - s.dataStart;
      let row = null, keep = false;
      if (m === 0xFE) {
        row = { label: 'Comment', size };
      } else if (m === 0xE1 && dataLen >= 6 && hasAscii(u8, s.dataStart, 'Exif') && u8[s.dataStart + 4] === 0 && u8[s.dataStart + 5] === 0) {
        const t = parseTiff(u8, s.dataStart + 6, s.end);
        if (t) { if (!tiff) tiff = t; orientation = t.orientation || orientation; }
        row = { label: 'EXIF metadata', size };
      } else if (m === 0xE1 && (hasAscii(u8, s.dataStart, 'http://ns.adobe.com/xap/1.0/') || hasAscii(u8, s.dataStart, 'http://ns.adobe.com/xmp/extension/'))) {
        row = { label: 'XMP metadata', size };
      } else if (m === 0xE2 && hasAscii(u8, s.dataStart, 'ICC_PROFILE')) {
        keep = true;                    /* colour profile — rendering needs it */
      } else if (m === 0xE2 && hasAscii(u8, s.dataStart, 'MPF')) {
        row = { label: 'Multi-picture data (gain map)', size };
      } else if (m === 0xED && hasAscii(u8, s.dataStart, 'Photoshop 3.0')) {
        row = { label: 'IPTC / Photoshop', size };
      } else {
        row = { label: 'Vendor segment', id: 'APP' + (m - 0xE0), size };
      }
      s.keep = keep;
      if (!keep && row) strips.push(row);
      return;
    }
    s.keep = true;                      /* SOF, DQT, DHT, SOS, APP0, APP14, … */
  });
  if (scan.trailing > 0) strips.push({ label: 'Data after image end', size: scan.trailing });
  const injectOrient = orientation > 1 && orientation <= 8;
  return {
    kind: 'jpeg', ext: 'jpg', mime: 'image/jpeg', strips, tiff,
    orientNote: injectOrient,
    rebuild() {
      const parts = [u8.subarray(0, 2)];
      let injected = !injectOrient;
      scan.segs.forEach((s) => {
        if (!s.keep) return;
        if (!injected && s.marker !== 0xE0) {
          /* minimal EXIF: one little-endian IFD0 holding only the
             Orientation SHORT — 36 bytes, zero identifying content */
          parts.push(new Uint8Array([0xFF, 0xE1, 0x00, 0x22,
            0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
            0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00,
            0x01, 0x00,
            0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00,
            orientation & 0xFF, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00]));
          injected = true;
        }
        parts.push(u8.subarray(s.start, s.end));
      });
      return parts;
    },
  };
}

/* ---- PNG ---- */
const PNG_SIG = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
const PNG_KEEP = { tRNS: 1, gAMA: 1, cHRM: 1, sRGB: 1, iCCP: 1, sBIT: 1, bKGD: 1, pHYs: 1, hIST: 1, sPLT: 1, acTL: 1, fcTL: 1, fdAT: 1 };

function analyzePng(u8) {
  for (let i = 0; i < 8; i++) if (u8[i] !== PNG_SIG[i]) return null;
  const chunks = [];
  let pos = 8, sawEnd = false, endPos = u8.length;
  const n = u8.length;
  while (pos + 12 <= n) {
    const len = u32be(u8, pos);
    const type = ascii(u8, pos + 4, pos + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) return null;
    const end = pos + 12 + len;
    if (end > n) return null;
    chunks.push({ start: pos, end, type, len });
    pos = end;
    if (type === 'IEND') { sawEnd = true; endPos = pos; break; }
  }
  if (!chunks.length) return null;
  /* no IEND = truncated file, and any partial chunk bytes past the loop
     would be silently dropped by the rebuild — fail closed instead of
     shipping a "cleaned" file that lost data. JPEG stays tolerant of a
     missing EOI on purpose: its scanner keeps every byte. */
  if (!sawEnd) return null;
  const strips = [];
  let tiff = null;
  chunks.forEach((c) => {
    const critical = c.type.charCodeAt(0) >= 65 && c.type.charCodeAt(0) <= 90;
    c.keep = critical || PNG_KEEP[c.type] === 1;
    if (c.keep) return;
    const size = c.end - c.start;
    if (c.type === 'eXIf') {
      const t = parseTiff(u8, c.start + 8, c.start + 8 + c.len);
      if (t && !tiff) tiff = t;
      strips.push({ label: 'EXIF metadata', size });
    } else if (c.type === 'tEXt' || c.type === 'zTXt' || c.type === 'iTXt') {
      let kw = '';
      for (let p = c.start + 8; p < Math.min(c.start + 8 + 40, c.end - 4); p++) {
        if (!u8[p]) break;
        kw += (u8[p] >= 32 && u8[p] < 127) ? String.fromCharCode(u8[p]) : '?';
      }
      strips.push({ label: 'Text chunk', id: kw || c.type, size });
    } else if (c.type === 'tIME') {
      strips.push({ label: 'Timestamp chunk', size });
    } else {
      strips.push({ label: 'Extra chunk', id: c.type, size });
    }
  });
  const trailing = sawEnd ? n - endPos : 0;
  if (trailing > 0) strips.push({ label: 'Data after image end', size: trailing });
  return {
    kind: 'png', ext: 'png', mime: 'image/png', strips, tiff, orientNote: false,
    rebuild() {
      const parts = [u8.subarray(0, 8)];
      chunks.forEach((c) => { if (c.keep) parts.push(u8.subarray(c.start, c.end)); });
      return parts;
    },
  };
}

/* ---- WebP ---- */
function analyzeWebp(u8) {
  if (!hasAscii(u8, 0, 'RIFF') || !hasAscii(u8, 8, 'WEBP')) return null;
  /* a declared size past the file end = truncated file — fail closed like
     PNG does, instead of clamping and "cleaning" a broken file. Declared
     size SHORTER than the file is the legitimate trailing-garbage case and
     stays: that tail is strippable. */
  const riffEnd = 8 + u32le(u8, 4);
  if (riffEnd > u8.length || riffEnd < 12) return null;
  const chunks = [];
  let pos = 12;
  while (pos + 8 <= riffEnd) {
    const type = ascii(u8, pos, pos + 4);
    const len = u32le(u8, pos + 4);
    if (pos + 8 + len > riffEnd) return null;
    /* a VP8X shorter than its fixed 10-byte payload is malformed, and the
       rebuild's flag-clearing write (data byte 0) would land in the NEXT
       chunk's bytes — fail closed instead */
    if (type === 'VP8X' && len < 10) return null;
    const end = Math.min(pos + 8 + len + (len & 1), riffEnd);
    chunks.push({ start: pos, end, type, len });
    pos = end;
  }
  /* leftover bytes inside the declared RIFF that don't form a chunk header
     would be silently dropped by the rebuild — fail closed */
  if (pos !== riffEnd) return null;
  if (!chunks.length) return null;
  const strips = [];
  let tiff = null;
  chunks.forEach((c) => {
    c.keep = !(c.type === 'EXIF' || c.type === 'XMP ');
    if (c.keep) return;
    const size = c.end - c.start;
    if (c.type === 'EXIF') {
      let off = c.start + 8;
      /* tolerate the non-standard "Exif\0\0" prefix some writers add */
      if (hasAscii(u8, off, 'Exif') && u8[off + 4] === 0 && u8[off + 5] === 0) off += 6;
      const t = parseTiff(u8, off, c.start + 8 + c.len);
      if (t && !tiff) tiff = t;
      strips.push({ label: 'EXIF metadata', size });
    } else {
      strips.push({ label: 'XMP metadata', size });
    }
  });
  const trailing = u8.length - riffEnd;
  if (trailing > 0) strips.push({ label: 'Data after image end', size: trailing });
  return {
    kind: 'webp', ext: 'webp', mime: 'image/webp', strips, tiff, orientNote: false,
    rebuild() {
      let total = 12;
      chunks.forEach((c) => { if (c.keep) total += c.end - c.start; });
      const out = new Uint8Array(total);
      let w = 12;
      out.set(u8.subarray(0, 12), 0);
      chunks.forEach((c) => {
        if (!c.keep) return;
        out.set(u8.subarray(c.start, c.end), w);
        if (c.type === 'VP8X') out[w + 8] = out[w + 8] & 0xF3;   /* clear EXIF(0x08) + XMP(0x04) flags */
        w += c.end - c.start;
      });
      const sz = total - 8;
      out[4] = sz & 0xFF; out[5] = (sz >>> 8) & 0xFF; out[6] = (sz >>> 16) & 0xFF; out[7] = (sz >>> 24) & 0xFF;
      return [out];
    },
  };
}

/* ---- HEIC / HEIF — lossless in-place EXIF/XMP strip via ISOBMFF box surgery.
   The Exif and XMP items (declaration + payload) are removed and every
   surviving iloc offset re-based, so the coded image (hvc1/grid/tile
   bitstreams) is copied byte-for-byte and the output is a valid HEIC that
   decodes to identical pixels. Fails closed (→ { heicUnsupported:true }) on
   layouts we can't re-base without a re-encode: construction_method ≠ 0, iloc
   v2 / extent index, size nibbles outside {0,4,8}, or a metadata payload that
   isn't inside an mdat. ---- */
function u16be(u8, p) { return (u8[p] << 8) | u8[p + 1]; }
function readN(u8, p, n) { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + u8[p + i]; return v; }
function str4(u8, p) { return String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]); }
function writeN(arr, p, n, v) { for (let i = n - 1; i >= 0; i--) { arr[p + i] = v & 0xFF; v = Math.floor(v / 256); } }
function concat(parts) {
  let total = 0;
  for (let i = 0; i < parts.length; i++) total += parts[i].length;
  const out = new Uint8Array(total);
  let w = 0;
  for (let i = 0; i < parts.length; i++) { out.set(parts[i], w); w += parts[i].length; }
  return out;
}
function box(type, payload) {
  const out = new Uint8Array(8 + payload.length);
  writeN(out, 0, 4, 8 + payload.length);
  out[4] = type.charCodeAt(0); out[5] = type.charCodeAt(1); out[6] = type.charCodeAt(2); out[7] = type.charCodeAt(3);
  out.set(payload, 8);
  return out;
}
function topBoxes(u8) {
  const boxes = [];
  let p = 0;
  const n = u8.length;
  while (p + 8 <= n) {
    let size = u32be(u8, p), hdr = 8;
    if (size === 1) { if (p + 16 > n) return null; size = u32be(u8, p + 8) * 4294967296 + u32be(u8, p + 12); hdr = 16; }
    else if (size === 0) { size = n - p; }
    if (size < hdr || p + size > n) return null;
    boxes.push({ type: str4(u8, p + 4), start: p, end: p + size, hdr });
    p += size;
  }
  return (p === n) ? boxes : null;   /* trailing garbage / truncation → fail closed */
}
function childBoxes(u8, start, end) {
  const boxes = [];
  let p = start;
  while (p + 8 <= end) {
    let size = u32be(u8, p), hdr = 8;
    if (size === 1) { if (p + 16 > end) return null; size = u32be(u8, p + 8) * 4294967296 + u32be(u8, p + 12); hdr = 16; }
    else if (size === 0) { size = end - p; }
    if (size < hdr || p + size > end) return null;
    boxes.push({ type: str4(u8, p + 4), start: p, end: p + size, hdr });
    p += size;
  }
  return (p === end) ? boxes : null;
}
function parseIloc(u8, b) {
  let q = b.start + b.hdr;
  const ver = u8[q]; q += 4;                       /* version + flags */
  if (ver > 1) return null;                         /* v2 = idat/item index → unsupported */
  const b0 = u8[q], b1 = u8[q + 1]; q += 2;
  const offSize = b0 >> 4, lenSize = b0 & 0xF, baseSize = b1 >> 4, idxSize = b1 & 0xF;
  if (idxSize !== 0) return null;
  /* offset & length must be real widths — a 0-width extent lets a hostile iloc
     declare 65535 zero-byte extents per item and spin the parser (DoS). A
     base_offset of 0 (absent) is fine and common. */
  if ((offSize !== 4 && offSize !== 8) || (lenSize !== 4 && lenSize !== 8)) return null;
  if (baseSize !== 0 && baseSize !== 4 && baseSize !== 8) return null;
  const cnt = u16be(u8, q); q += 2;
  if (cnt > b.end - q) return null;                 /* each item ≥ 6 bytes */
  const items = [];
  for (let i = 0; i < cnt; i++) {
    if (q + 2 + (ver === 1 ? 2 : 0) + 2 + baseSize + 2 > b.end) return null;
    const id = u16be(u8, q); q += 2;
    let cm = 0;
    if (ver === 1) { cm = u16be(u8, q) & 0xF; q += 2; }
    const dataRef = u16be(u8, q); q += 2;
    const base = readN(u8, q, baseSize); q += baseSize;
    const extCnt = u16be(u8, q); q += 2;
    if (q + extCnt * (offSize + lenSize) > b.end) return null;   /* extents must fit the box */
    const exts = [];
    for (let e = 0; e < extCnt; e++) {
      const off = readN(u8, q, offSize); q += offSize;
      const len = readN(u8, q, lenSize); q += lenSize;
      exts.push({ off, len });
    }
    items.push({ id, cm, dataRef, base, exts });
  }
  if (q !== b.end) return null;
  return { ver, offSize, lenSize, baseSize, items };
}
function buildIloc(il) {
  const parts = [];
  const head = new Uint8Array(8);
  head[0] = il.ver;
  head[4] = (il.offSize << 4) | il.lenSize;
  head[5] = (il.baseSize << 4);
  writeN(head, 6, 2, il.items.length);
  parts.push(head);
  il.items.forEach((it) => {
    const per = 2 + (il.ver === 1 ? 2 : 0) + 2 + il.baseSize + 2 + it.exts.length * (il.offSize + il.lenSize);
    const a = new Uint8Array(per);
    let w = 0;
    writeN(a, w, 2, it.id); w += 2;
    if (il.ver === 1) { writeN(a, w, 2, it.cm & 0xF); w += 2; }
    writeN(a, w, 2, it.dataRef); w += 2;
    writeN(a, w, il.baseSize, it.base); w += il.baseSize;
    writeN(a, w, 2, it.exts.length); w += 2;
    it.exts.forEach((x) => { writeN(a, w, il.offSize, x.off); w += il.offSize; writeN(a, w, il.lenSize, x.len); w += il.lenSize; });
    parts.push(a);
  });
  return box('iloc', concat(parts));
}
function parseIinf(u8, b) {
  const ver = u8[b.start + b.hdr];
  let q = b.start + b.hdr + 4, cnt;
  if (ver === 0) { cnt = u16be(u8, q); q += 2; } else { cnt = u32be(u8, q); q += 4; }
  const infes = childBoxes(u8, q, b.end);
  if (!infes) return null;
  const map = {};
  infes.forEach((ib) => {
    if (ib.type !== 'infe') return;
    const v = u8[ib.start + ib.hdr];
    let p = ib.start + ib.hdr + 4, id, type4 = '', content = '';
    if (v >= 2) {
      if (v === 2) { id = u16be(u8, p); p += 2; } else { id = u32be(u8, p); p += 4; }
      p += 2;                                        /* protection index */
      type4 = str4(u8, p); p += 4;
      while (p < ib.end && u8[p]) p++;                /* item_name */
      p++;
      if (type4 === 'mime') { let s = ''; while (p < ib.end && u8[p]) { s += String.fromCharCode(u8[p]); p++; } content = s; }
      map[id] = { type: type4, content };
    }
  });
  return { ver, cnt, infes, map };
}
function parseIref(u8, b) {
  const v = u8[b.start + b.hdr];
  const refs = childBoxes(u8, b.start + b.hdr + 4, b.end);
  if (!refs) return null;
  const idW = v === 0 ? 2 : 4;
  const out = [];
  let bad = false;
  refs.forEach((rb) => {
    if (bad) return;
    let p = rb.start + rb.hdr;
    if (p + idW + 2 > rb.end) { bad = true; return; }
    const from = readN(u8, p, idW); p += idW;
    const rc = u16be(u8, p); p += 2;
    if (p + rc * idW > rb.end) { bad = true; return; }   /* to-list must fit the ref box */
    const tos = [];
    for (let i = 0; i < rc; i++) { tos.push(readN(u8, p, idW)); p += idW; }
    out.push({ type: rb.type, from, tos });
  });
  if (bad) return null;
  return { ver: v, idW, refs: out };
}
function buildIref(ir) {
  if (!ir.refs.length) return null;
  const parts = [new Uint8Array([ir.ver, 0, 0, 0])];
  ir.refs.forEach((r) => {
    const a = new Uint8Array(ir.idW + 2 + r.tos.length * ir.idW);
    let w = 0;
    writeN(a, w, ir.idW, r.from); w += ir.idW;
    writeN(a, w, 2, r.tos.length); w += 2;
    r.tos.forEach((t) => { writeN(a, w, ir.idW, t); w += ir.idW; });
    parts.push(box(r.type, a));
  });
  return box('iref', concat(parts));
}
function parseIpma(u8, b) {
  const ver = u8[b.start + b.hdr];
  const flags = (u8[b.start + b.hdr + 1] << 16) | (u8[b.start + b.hdr + 2] << 8) | u8[b.start + b.hdr + 3];
  let q = b.start + b.hdr + 4;
  const cnt = u32be(u8, q); q += 4;
  if (cnt > b.end - q) return null;                 /* each entry ≥ idW+1 ≥ 3 bytes */
  const idW = ver < 1 ? 2 : 4, assocW = (flags & 1) ? 2 : 1;
  const entries = [];
  for (let i = 0; i < cnt; i++) {
    if (q + idW + 1 > b.end) return null;
    const id = readN(u8, q, idW); q += idW;
    const ac = u8[q]; q += 1;
    if (q + ac * assocW > b.end) return null;
    const assoc = [];
    for (let a = 0; a < ac; a++) { assoc.push(readN(u8, q, assocW)); q += assocW; }
    entries.push({ id, assoc });
  }
  if (q !== b.end) return null;
  return { ver, flags, idW, assocW, entries };
}
function buildIpma(ip) {
  const parts = [];
  const head = new Uint8Array(8);
  head[0] = ip.ver; head[1] = (ip.flags >> 16) & 0xFF; head[2] = (ip.flags >> 8) & 0xFF; head[3] = ip.flags & 0xFF;
  writeN(head, 4, 4, ip.entries.length);
  parts.push(head);
  ip.entries.forEach((en) => {
    const a = new Uint8Array(ip.idW + 1 + en.assoc.length * ip.assocW);
    let w = 0;
    writeN(a, w, ip.idW, en.id); w += ip.idW;
    a[w] = en.assoc.length; w += 1;
    en.assoc.forEach((v) => { writeN(a, w, ip.assocW, v); w += ip.assocW; });
    parts.push(a);
  });
  return box('ipma', concat(parts));
}
/* ipma normally lives INSIDE iprp (iprp = { ipco, ipma }), not as a direct
   meta child — drop associations for removed items wherever it appears. */
function rewriteIpmaBytes(u8, b, removeIds) {
  const ip = parseIpma(u8, b);
  if (!ip) throw new Error('heic-ipma');   /* fail closed: a verbatim copy keeps associations for removed items */
  ip.entries = ip.entries.filter((en) => !removeIds[en.id]);
  return buildIpma(ip);
}
function rewriteIprp(u8, b, removeIds) {
  const kids = childBoxes(u8, b.start + b.hdr, b.end);   /* iprp is a plain container, no version/flags */
  if (!kids) throw new Error('heic-iprp');
  const parts = [];
  kids.forEach((k) => {
    if (k.type === 'ipma') parts.push(rewriteIpmaBytes(u8, k, removeIds));
    else parts.push(u8.subarray(k.start, k.end));         /* ipco (image props) verbatim */
  });
  return box('iprp', concat(parts));
}
/* HEVC-coded HEIF brands ONLY, not generic mif1/miaf — AVIF and other
   non-HEVC HEIF-family files also carry those, and we must not relabel an
   AVIF as .heic (its bytes aren't HEVC). */
const HEIF_BRANDS = { heic: 1, heix: 1, heim: 1, heis: 1, hevc: 1, hevx: 1, hevm: 1, hevs: 1, msf1: 1 };
function isHeif(u8) {
  if (u8.length < 16 || !hasAscii(u8, 4, 'ftyp')) return false;
  const size = u32be(u8, 0);
  if (size < 16 || size > u8.length) return false;
  if (HEIF_BRANDS[str4(u8, 8)]) return true;             /* major brand */
  for (let p = 16; p + 4 <= size; p += 4) { if (HEIF_BRANDS[str4(u8, p)]) return true; }
  return false;
}
/* HEIC Exif item payload begins with a 4-byte big-endian tiff_header_offset;
   some writers prefix "Exif\0\0" or start at the TIFF header — tolerate all. */
function exifTiffStart(u8, payStart, payEnd) {
  if (payStart + 4 > payEnd) return -1;
  if (u8[payStart] === 0x4D && u8[payStart + 1] === 0x4D) return payStart;             /* "MM" */
  if (u8[payStart] === 0x49 && u8[payStart + 1] === 0x49) return payStart;             /* "II" */
  if (hasAscii(u8, payStart, 'Exif') && u8[payStart + 4] === 0 && u8[payStart + 5] === 0) return payStart + 6;
  const hoff = u32be(u8, payStart);
  const t = payStart + 4 + hoff;
  return (t >= payStart && t + 4 <= payEnd) ? t : -1;
}
function analyzeHeic(u8) {
  if (!isHeif(u8)) return undefined;
  const tops = topBoxes(u8);
  if (!tops) return null;
  let metaBox = null;
  const mdats = [];
  tops.forEach((b) => { if (b.type === 'meta' && !metaBox) metaBox = b; else if (b.type === 'mdat') mdats.push(b); });
  if (!metaBox) return null;
  const metaChildren = childBoxes(u8, metaBox.start + metaBox.hdr + 4, metaBox.end);
  if (!metaChildren) return null;
  let ilocBox = null, iinfBox = null, irefBox = null;
  metaChildren.forEach((b) => { if (b.type === 'iloc') ilocBox = b; else if (b.type === 'iinf') iinfBox = b; else if (b.type === 'iref') irefBox = b; });
  if (!ilocBox || !iinfBox) return null;
  const iinf = parseIinf(u8, iinfBox);
  if (!iinf) return null;
  /* which items are metadata (Exif / XMP)? — knowable from iinf alone */
  const removeIds = {}, removeList = [];
  Object.keys(iinf.map).forEach((k) => {
    const it = iinf.map[k], id = parseInt(k, 10);
    const isExif = it.type === 'Exif' || it.type === 'exif';
    const isXmp = it.type === 'mime' && /application\/rdf\+xml/i.test(it.content || '');
    if (isExif || isXmp) { removeIds[id] = isExif ? 'exif' : 'xmp'; removeList.push(id); }
  });
  const ext = 'heic', mime = 'image/heic';
  if (!removeList.length) {
    return { kind: 'heic', ext, mime, strips: [], tiff: null, orientNote: false, rebuild() { return [u8.slice()]; } };
  }
  /* there IS metadata to strip — the iloc layout must be one we can losslessly
     re-base, else fail closed as unsupported (never as "corrupted"). */
  if (u8[ilocBox.start + ilocBox.hdr] > 1) return { heicUnsupported: true };
  const iloc = parseIloc(u8, ilocBox);
  if (!iloc) return { heicUnsupported: true };
  const ilById = {};
  for (let i = 0; i < iloc.items.length; i++) { const it = iloc.items[i]; if (it.cm !== 0) return { heicUnsupported: true }; ilById[it.id] = it; }
  /* every box we must REWRITE to drop the item's references has to parse cleanly
     — a verbatim copy would leave dangling refs to a removed item. Surface it up
     front as unsupported rather than fail on the rebuild. */
  if (irefBox && !parseIref(u8, irefBox)) return { heicUnsupported: true };
  let ipmaBad = false;
  metaChildren.forEach((mb) => {
    if (mb.type === 'ipma') { if (!parseIpma(u8, mb)) ipmaBad = true; }
    else if (mb.type === 'iprp') {
      const kids = childBoxes(u8, mb.start + mb.hdr, mb.end);
      if (!kids) { ipmaBad = true; }
      else kids.forEach((k) => { if (k.type === 'ipma' && !parseIpma(u8, k)) ipmaBad = true; });
    }
  });
  if (ipmaBad) return { heicUnsupported: true };
  const inMdat = (absStart, len) => {
    for (let m = 0; m < mdats.length; m++) { const d0 = mdats[m].start + mdats[m].hdr, d1 = mdats[m].end; if (absStart >= d0 && absStart + len <= d1) return true; }
    return false;
  };
  const removedRanges = [], strips = [];
  let tiff = null;
  for (let r = 0; r < removeList.length; r++) {
    const rid = removeList[r], rit = ilById[rid];
    if (!rit) return { heicUnsupported: true };
    let sizeSum = 0;
    for (let e = 0; e < rit.exts.length; e++) {
      const abs = rit.base + rit.exts[e].off, len = rit.exts[e].len;
      if (!inMdat(abs, len)) return { heicUnsupported: true };
      removedRanges.push({ start: abs, len });
      sizeSum += len;
      if (removeIds[rid] === 'exif' && !tiff && rit.exts.length === 1) {
        const ts = exifTiffStart(u8, abs, abs + len);
        if (ts >= 0) { const t = parseTiff(u8, ts, abs + len); if (t) tiff = t; }
      }
    }
    strips.push({ label: removeIds[rid] === 'exif' ? 'EXIF metadata' : 'XMP metadata', size: sizeSum });
  }
  /* surviving items must not overlap any removed range (interleaving = unsupported) */
  for (let si = 0; si < iloc.items.length; si++) {
    const s = iloc.items[si];
    if (removeIds[s.id]) continue;
    for (let se = 0; se < s.exts.length; se++) {
      const a0 = s.base + s.exts[se].off, a1 = a0 + s.exts[se].len;
      for (let rr = 0; rr < removedRanges.length; rr++) {
        const rs = removedRanges[rr].start, reEnd = rs + removedRanges[rr].len;
        if (a0 < reEnd && rs < a1) return { heicUnsupported: true };
      }
    }
  }
  if (!iloc.items.filter((it) => !removeIds[it.id]).length) return { heicUnsupported: true };
  return {
    kind: 'heic', ext, mime, strips, tiff, orientNote: false,
    rebuild() { return rebuildHeic(u8, tops, metaBox, metaChildren, mdats, iloc, iinf, irefBox, removeIds, removedRanges, ilById); },
  };
}
function rebuildHeic(u8, tops, metaBox, metaChildren, mdats, iloc, iinf, irefBox, removeIds, removedRanges, ilById) {
  const keptInfe = iinf.infes.filter((ib) => {
    if (ib.type !== 'infe') return true;
    const v = u8[ib.start + ib.hdr];
    if (v < 2) return true;
    const p = ib.start + ib.hdr + 4;
    const id = v === 2 ? u16be(u8, p) : u32be(u8, p);
    return !removeIds[id];
  });
  function buildIinf() {
    const head = new Uint8Array(iinf.ver === 0 ? 6 : 8);
    head[0] = iinf.ver;
    const infeCount = keptInfe.filter((b) => b.type === 'infe').length;
    if (iinf.ver === 0) writeN(head, 4, 2, infeCount); else writeN(head, 4, 4, infeCount);
    const parts = [head];
    keptInfe.forEach((b) => parts.push(u8.subarray(b.start, b.end)));
    return box('iinf', concat(parts));
  }
  let newIref = null;
  if (irefBox) {
    const ir = parseIref(u8, irefBox);
    if (ir) {
      ir.refs = ir.refs.filter((rf) => !removeIds[rf.from])
        .map((rf) => { rf.tos = rf.tos.filter((t) => !removeIds[t]); return rf; })
        .filter((rf) => rf.tos.length > 0);
      newIref = buildIref(ir);
    } else { throw new Error('heic-iref'); }   /* fail closed: a verbatim iref keeps refs to removed items */
  }
  const survItems = iloc.items.filter((it) => !removeIds[it.id])
    .map((it) => ({ id: it.id, cm: it.cm, dataRef: it.dataRef, base: it.base, exts: it.exts }));
  const ilStruct = { ver: iloc.ver, offSize: iloc.offSize, lenSize: iloc.lenSize, baseSize: iloc.baseSize, items: survItems };
  function assembleMeta() {
    const parts = [u8.subarray(metaBox.start + metaBox.hdr, metaBox.start + metaBox.hdr + 4)];
    metaChildren.forEach((b) => {
      if (b.type === 'iloc') parts.push(buildIloc(ilStruct));
      else if (b.type === 'iinf') parts.push(buildIinf());
      else if (b.type === 'iref') { if (newIref) parts.push(newIref); }
      else if (b.type === 'iprp') parts.push(rewriteIprp(u8, b, removeIds));   /* ipma lives in here */
      else if (b.type === 'ipma') parts.push(rewriteIpmaBytes(u8, b, removeIds));
      else parts.push(u8.subarray(b.start, b.end));
    });
    return box('meta', concat(parts));
  }
  const metaPass1 = assembleMeta();
  const metaDelta = metaPass1.length - (metaBox.end - metaBox.start);   /* ≤ 0 */
  removedRanges.sort((a, b) => a.start - b.start);
  /* merge overlapping / adjacent ranges into a union — the mdat writer excises
     the union, so removedBefore() must count the union too (double-counting an
     overlap would over-shift every later offset). */
  const mergedRanges = [];
  removedRanges.forEach((r) => {
    const last = mergedRanges[mergedRanges.length - 1];
    if (last && r.start <= last.start + last.len) { last.len = Math.max(last.start + last.len, r.start + r.len) - last.start; }
    else mergedRanges.push({ start: r.start, len: r.len });
  });
  removedRanges = mergedRanges;
  const removedBefore = (O) => { let s = 0; for (let i = 0; i < removedRanges.length; i++) { if (removedRanges[i].start < O) s += removedRanges[i].len; } return s; };
  /* Re-base BOTH base_offset and every extent offset so a removed range in the
     gap [base, base+off) is counted, not just ranges before base. new_abs(O) =
     O + metaDelta − removedBefore(O); only meta precedes mdat. When baseSize is
     0 the anchor is the extent offset itself (base stays 0). */
  const metaEnd = metaBox.end;
  let bad = false;
  survItems.forEach((it) => {
    const newBase = ilStruct.baseSize > 0 ? (it.base + metaDelta - removedBefore(it.base)) : 0;
    if (ilStruct.baseSize > 0 && it.base < metaEnd) bad = true;
    it.exts = it.exts.map((x) => {
      const oldAbs = it.base + x.off;
      if (oldAbs < metaEnd) bad = true;
      const newAbs = oldAbs + metaDelta - removedBefore(oldAbs);
      return { off: newAbs - newBase, len: x.len };
    });
    it.base = newBase;
  });
  if (bad) throw new Error('heic-layout');
  const metaFinal = assembleMeta();
  if (metaFinal.length !== metaPass1.length) throw new Error('heic-meta-size');
  const outParts = [];
  tops.forEach((b) => {
    if (b === metaBox) { outParts.push(metaFinal); return; }
    if (b.type === 'mdat') {
      const d0 = b.start + b.hdr, d1 = b.end;
      const inside = removedRanges.filter((x) => x.start >= d0 && x.start + x.len <= d1).sort((a, c) => a.start - c.start);
      if (!inside.length) { outParts.push(u8.subarray(b.start, b.end)); return; }
      const payloadParts = [];
      let cur = d0;
      inside.forEach((x) => { if (x.start > cur) payloadParts.push(u8.subarray(cur, x.start)); cur = x.start + x.len; });
      if (cur < d1) payloadParts.push(u8.subarray(cur, d1));
      const payload = concat(payloadParts);
      /* PRESERVE the original header width — downgrading a 16-byte largesize
         header to 8 bytes would move this mdat's payload 8 bytes earlier, a
         shift the offset re-basing (metaDelta only) doesn't account for.
         Payload only shrinks, so an 8-byte header never needs to grow. */
      let hdr;
      if (b.hdr === 16) {
        hdr = new Uint8Array(16); writeN(hdr, 0, 4, 1);
        hdr[4] = 0x6D; hdr[5] = 0x64; hdr[6] = 0x61; hdr[7] = 0x74;
        writeN(hdr, 8, 8, 16 + payload.length);
      } else {
        hdr = new Uint8Array(8); writeN(hdr, 0, 4, 8 + payload.length);
        hdr[4] = 0x6D; hdr[5] = 0x64; hdr[6] = 0x61; hdr[7] = 0x74;
      }
      outParts.push(hdr); outParts.push(payload);
      return;
    }
    outParts.push(u8.subarray(b.start, b.end));
  });
  const out = concat(outParts);
  /* self-check: re-parse the output and confirm every surviving item's bytes
     are byte-identical to the input. Any offset slip throws here, before the
     caller can ship a corrupt file. */
  verifyHeic(u8, out, removeIds, ilById);
  return [out];
}
function verifyHeic(orig, out, removeIds, origById) {
  const tops = topBoxes(out);
  if (!tops) throw new Error('heic-verify-parse');
  let metaBox = null;
  tops.forEach((b) => { if (b.type === 'meta' && !metaBox) metaBox = b; });
  if (!metaBox) throw new Error('heic-verify-meta');
  const mc = childBoxes(out, metaBox.start + metaBox.hdr + 4, metaBox.end);
  if (!mc) throw new Error('heic-verify-metac');
  let ilocBox = null;
  mc.forEach((b) => { if (b.type === 'iloc') ilocBox = b; });
  if (!ilocBox) throw new Error('heic-verify-iloc');
  const nIloc = parseIloc(out, ilocBox);
  if (!nIloc) throw new Error('heic-verify-ilocparse');
  nIloc.items.forEach((it) => {
    if (removeIds[it.id]) throw new Error('heic-verify-leftover');
    const oit = origById[it.id];
    if (!oit) return;
    if (it.exts.length !== oit.exts.length) throw new Error('heic-verify-extcount');
    for (let e = 0; e < it.exts.length; e++) {
      const nAbs = it.base + it.exts[e].off, oAbs = oit.base + oit.exts[e].off, len = it.exts[e].len;
      if (len !== oit.exts[e].len) throw new Error('heic-verify-len');
      if (nAbs + len > out.length || oAbs + len > orig.length) throw new Error('heic-verify-bounds');
      for (let k = 0; k < len; k++) { if (out[nAbs + k] !== orig[oAbs + k]) throw new Error('heic-verify-bytes'); }
    }
  });
}

/* Analyse an image buffer.
     undefined → not a format this tool does
     null      → recognised but unparseable (corrupted / truncated)
     { heicUnsupported:true } → valid HEIC whose layout can't be losslessly stripped
     report    → { kind, ext, mime, strips, tiff, orientNote, rebuild }
   strips lists every block the rebuild will drop ({ label, id?, size });
   tiff is the privacy preview (camera, dates, software, GPS in decimal
   degrees, orientation); rebuild() returns an array of Uint8Array parts —
   feed it to `new Blob(parts, { type: report.mime })`. */
export function analyze(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length >= 4 && u8[0] === 0xFF && u8[1] === 0xD8) return analyzeJpeg(u8);
  if (u8.length >= 20 && u8[0] === 0x89 && u8[1] === 0x50) return analyzePng(u8);
  if (u8.length >= 20 && hasAscii(u8, 0, 'RIFF')) return analyzeWebp(u8);
  if (u8.length >= 16 && hasAscii(u8, 4, 'ftyp')) { const h = analyzeHeic(u8); if (h !== undefined) return h; }
  return undefined;
}
