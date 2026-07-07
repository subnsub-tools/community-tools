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

/* Analyse an image buffer.
     undefined → not a format this tool does
     null      → recognised but unparseable (corrupted / truncated)
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
  return undefined;
}
