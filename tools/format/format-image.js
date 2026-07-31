/* Format — Image. Canvas re-encode to JPEG / PNG / WebP / AVIF with a
   quality dial, one file or a batch. Logic of the Image section of the
   Format tool on subnsub.com, kept in lockstep with the in-page version.
   (It succeeds the older `tools/imgconv` module — that tool became this
   section, and this file carries its guards forward plus AVIF and the
   batch path.)

   Decode is native-first: the browser bakes EXIF orientation into the
   bitmap by itself, and Safari decodes HEIC natively so it never needs a
   wasm decoder. Only when native decode FAILS and the bytes sniff as HEIF
   does the optional decodeHeic callback run, behind a declared-size guard.
   JPEG output is composited onto white (canvas alpha would otherwise turn
   black), and an encode whose result MIME differs from the request (Safari
   has no WebP encoder and silently hands back PNG) fails honestly instead
   of shipping a mislabelled file.

   Browser-only module (Image / canvas / object URLs). No network, no
   worker, no dependency: the two optional wasm paths are callbacks you
   inject — nothing is fetched on your behalf.

   Error codes on err.code: 'big', 'decode', 'pixels' (err.mp), 'encode',
   'avif', 'avifbig', 'zipbig'. Every error also carries err.fileName. */

export const MAX_BYTES = 128 * 1024 * 1024;
export const MAX_PIXELS = 64e6;
export const MAX_FILES = 20;
/* The wasm AVIF path runs on the calling thread: getImageData plus a
   synchronous encode plus a heap copy. At 64 MP the ImageData alone is
   ~256 MB, so that path stops far earlier than the native one. */
export const AVIF_WASM_MAX_PIXELS = 16e6;

export const FORMATS = ['jpeg', 'png', 'webp', 'avif'];

function codeErr(code, fileName, mp) {
  const e = new Error(code);
  e.code = code;
  if (fileName != null) e.fileName = fileName;
  if (mp != null) e.mp = mp;
  return e;
}
function u32be(u8, p) { return ((u8[p] << 24) | (u8[p + 1] << 16) | (u8[p + 2] << 8) | u8[p + 3]) >>> 0; }

export function isHeifBytes(u8) {
  if (u8.length < 16) return false;
  if (!(u8[4] === 0x66 && u8[5] === 0x74 && u8[6] === 0x79 && u8[7] === 0x70)) return false;   /* ftyp */
  const brands = [String.fromCharCode(u8[8], u8[9], u8[10], u8[11])];
  for (let p = 16; p + 4 <= Math.min(u8.length, 64); p += 4) brands.push(String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]));
  return brands.some((b) => /^(heic|heix|hevc|hevx|heim|heis|hevm|hevs|mif1|msf1)$/.test(b));
}

/* Pre-decode pixel guard for the wasm path: a tiny HEIF can DECLARE
   monster dimensions, and a post-decode guard only runs after the
   expensive allocation already happened. Walk the box tree for ispe
   (image spatial extents) and take the largest declared plane.
   Depth-capped and bounds-checked; returns 0 when no ispe is found —
   callers fail closed on that. */
export function heifDeclaredPixels(u8) {
  let worst = 0;
  function walk(start, end, depth) {
    if (depth > 6) return;
    let p = start;
    while (p + 8 <= end) {
      let size = u32be(u8, p);
      const type = String.fromCharCode(u8[p + 4], u8[p + 5], u8[p + 6], u8[p + 7]);
      let hdr = 8;
      if (size === 1) {
        if (p + 16 > end || u32be(u8, p + 8) !== 0) return;   /* silly 64-bit box */
        size = u32be(u8, p + 12); hdr = 16;
      } else if (size === 0) { size = end - p; }
      if (size < hdr || p + size > end) return;
      if (type === 'ispe') {
        /* bound the read to THIS box, not the parent — a short ispe must
           not read width/height out of its sibling's bytes; malformed
           ispe simply doesn't count */
        if (size >= hdr + 12) {
          const w = u32be(u8, p + hdr + 4), h = u32be(u8, p + hdr + 8);
          if (w && h) worst = Math.max(worst, w * h);
        }
      } else if (type === 'meta') {
        walk(p + hdr + 4, p + size, depth + 1);   /* full box: 4 version/flag bytes */
      } else if (type === 'iprp' || type === 'ipco') {
        walk(p + hdr, p + size, depth + 1);
      }
      p += size;
    }
  }
  walk(0, u8.length, 0);
  return worst;
}

function loadImg(url, name) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(codeErr('decode', name));
    im.src = url;
  });
}

/* Decode a picked file into a drawable image. Native decode first; on
   failure, HEIF bytes route through decodeHeic (async blob → PNG blob)
   behind the ispe guard. Resolves to { img, url, w, h } — the caller owns
   revoking url. */
export async function decodeImage(file, { decodeHeic = null } = {}) {
  if (file.size > MAX_BYTES) throw codeErr('big', file.name);
  const url = URL.createObjectURL(file);
  let r;
  try {
    r = { img: await loadImg(url, file.name), url };
  } catch (_) {
    URL.revokeObjectURL(url);
    /* 1 MB is plenty for the brand sniff (ftyp sits at the front) … */
    const hb = new Uint8Array(await file.slice(0, 1048576).arrayBuffer());
    if (!isHeifBytes(hb)) throw codeErr('decode', file.name);
    /* … but the ispe scan must cover the WHOLE file: a 1 MB window could
       hold a small decoy ispe while the real, oversized one sits past it —
       the HEIC decoder reads the full blob anyway. */
    const declared = heifDeclaredPixels(new Uint8Array(await file.arrayBuffer()));
    /* fail CLOSED when no usable ispe was found: every valid HEIF carries
       one per image item, so "not found" means malformed, hostile, or
       meta-after-mdat — none of which get to reach the wasm allocator
       unchecked */
    if (!declared) throw codeErr('decode', file.name);
    if (declared > MAX_PIXELS) throw codeErr('pixels', file.name, Math.round(declared / 1e6));
    if (!decodeHeic) throw codeErr('decode', file.name);
    const pngBlob = await decodeHeic(file).catch(() => { throw codeErr('decode', file.name); });
    const u2 = URL.createObjectURL(pngBlob);
    try {
      r = { img: await loadImg(u2, file.name), url: u2 };
    } catch (e) {
      URL.revokeObjectURL(u2);
      throw e;
    }
  }
  const w = r.img.naturalWidth, h = r.img.naturalHeight;
  if (!w || !h) { URL.revokeObjectURL(r.url); throw codeErr('decode', file.name); }
  if (w * h > MAX_PIXELS) { URL.revokeObjectURL(r.url); throw codeErr('pixels', file.name, Math.round(w * h / 1e6)); }
  return { img: r.img, url: r.url, w, h };
}

/* Does this browser encode `mime` from a canvas at all? Chromium answers
   yes for AVIF; Firefox and Safari do not, which is what the injected
   wasm encoder is for. */
export function nativeCanEncode(mime) {
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    return c.toDataURL(mime).indexOf('data:' + mime) === 0;
  } catch (_) { return false; }
}

/* Option block the wasm AVIF encoder expects; quality is 1-100. */
export function avifOptions(quality) {
  return {
    quality: Math.max(1, Math.min(100, Math.round(quality))),
    qualityAlpha: -1, denoiseLevel: 0, tileColsLog2: 0, tileRowsLog2: 0,
    speed: 7, subsample: 1, chromaDeltaQ: false, sharpness: 0, tune: 0,
    enableSharpYUV: false, bitDepth: 8, lossless: false,
  };
}

/* Output name for one converted file: the source's base name, sanitised,
   with the new extension. Re-encoding to the SAME extension gets a -min
   suffix so the download never looks like the original file. Path
   separators and control/bidi characters go — a batch writes these names
   into a ZIP, where a name must never smuggle a directory. */
export function outputName(sourceName, fmt) {
  const ext = fmt === 'jpeg' ? 'jpg' : fmt;
  const base = (String(sourceName || '').replace(/\.[^.]*$/, '')
    .replace(/[/\\\x00-\x1F\x7F\u202A-\u202E\u2066-\u2069]/g, '') || 'image').slice(0, 120);
  const oldExt = (String(sourceName || '').match(/\.([^.]+)$/) || ['', ''])[1].toLowerCase();
  const sameExt = oldExt === ext || (ext === 'jpg' && oldExt === 'jpeg');
  return (base + (sameExt ? '-min.' : '.') + ext).slice(0, 200);
}

/* Two files can sanitise down to one name. Rename in place, checking each
   CANDIDATE as well, so a rename cannot collide with a later entry. */
export function dedupeNames(results) {
  const seen = Object.create(null);
  results.forEach((r) => {
    const n = r.name;
    let c = 2;
    while (seen[r.name]) r.name = n.replace(/(\.[^.]*)$/, '(' + (c++) + ')$1');
    seen[r.name] = 1;
  });
  return results;
}

/* Re-encode a decoded image. Resolves to { bytes, type }. AVIF uses the
   canvas where the browser can (Chromium), else the injected
   encodeAvif(rgbaU8, w, h, options) → Uint8Array. */
export async function encodeImage(decoded, fmt, quality, { encodeAvif = null, fileName = '' } = {}) {
  const type = 'image/' + fmt;
  const { img, w, h } = decoded;
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const cx = cv.getContext('2d');
  if (!cx) throw codeErr('encode', fileName);
  if (fmt === 'jpeg') { cx.fillStyle = '#fff'; cx.fillRect(0, 0, w, h); }
  cx.drawImage(img, 0, 0);

  if (fmt === 'avif' && !nativeCanEncode(type)) {
    if (!encodeAvif) throw codeErr('avif', fileName);
    if (w * h > AVIF_WASM_MAX_PIXELS) throw codeErr('avifbig', fileName);
    let id;
    try { id = cx.getImageData(0, 0, w, h); } catch (_) { throw codeErr('encode', fileName); }
    let out;
    try { out = await encodeAvif(new Uint8Array(id.data.buffer), w, h, avifOptions(quality * 100)); }
    catch (_) { throw codeErr('avif', fileName); }
    /* copy the exact view — `out` may be a subarray of the encoder's heap,
       and widening to out.buffer would ship that whole heap. */
    const bytes = (out instanceof Uint8Array) ? out.slice() : new Uint8Array(out || 0);
    if (!bytes.length) throw codeErr('encode', fileName);
    return { bytes, type };
  }

  const blob = await new Promise((res, rej) => {
    try {
      cv.toBlob((b) => { if (b) res(b); else rej(codeErr('encode', fileName)); },
        type, fmt === 'png' ? undefined : quality);
    } catch (_) { rej(codeErr('encode', fileName)); }
  });
  if (blob.type !== type) throw codeErr('encode', fileName);   /* never ship a mislabelled file */
  return { bytes: new Uint8Array(await blob.arrayBuffer()), type };
}

/* One file, end to end. Resolves to
   { name, bytes, type, inSize, outSize }. The source object URL is
   revoked here — nothing is left for the caller to clean up. */
export async function convertImage(file, { format = 'jpeg', quality = 0.9, decodeHeic = null, encodeAvif = null } = {}) {
  const decoded = await decodeImage(file, { decodeHeic });
  try {
    const { bytes, type } = await encodeImage(decoded, format, quality, { encodeAvif, fileName: file.name });
    return { name: outputName(file.name, format), bytes, type, inSize: file.size, outSize: bytes.length };
  } finally {
    try { URL.revokeObjectURL(decoded.url); } catch (_) { /* already gone */ }
  }
}

/* ── store-only ZIP for a batch ─────────────────────────────────────────
   Hand-built so a batch download needs no dependency. Entries are stored,
   not deflated: these are already-compressed images. */
const CRC_T = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(u8) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/* entries: [{ name, bytes }] → Blob. Classic ZIP32 offsets stop at 4 GiB;
   a batch that would pass it is refused ('zipbig') rather than written
   with wrapped headers. Re-encodes can outgrow their inputs, so this is
   reachable, not theoretical. */
export function makeZip(entries, now = new Date()) {
  let projected = 22;
  entries.forEach((en) => { projected += en.bytes.length + 2 * (30 + 46 + 200); });
  if (projected > 0xFFFF0000) throw codeErr('zipbig');

  const te = new TextEncoder();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = (((now.getFullYear() - 1980) & 0x7F) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const parts = [], central = [];
  let offset = 0, cdSize = 0;
  entries.forEach((en) => {
    const nameU8 = te.encode(en.name);
    const crc = crc32(en.bytes);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true);          /* bit 11: UTF-8 names */
    lh.setUint16(8, 0, true);               /* store */
    lh.setUint16(10, dosTime, true);
    lh.setUint16(12, dosDate, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, en.bytes.length, true);
    lh.setUint32(22, en.bytes.length, true);
    lh.setUint16(26, nameU8.length, true);
    lh.setUint16(28, 0, true);
    parts.push(new Uint8Array(lh.buffer), nameU8, en.bytes);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true);
    ch.setUint16(12, dosTime, true);
    ch.setUint16(14, dosDate, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, en.bytes.length, true);
    ch.setUint32(24, en.bytes.length, true);
    ch.setUint16(28, nameU8.length, true);
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), nameU8);
    cdSize += 46 + nameU8.length;
    offset += 30 + nameU8.length + en.bytes.length;
  });
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, offset, true);
  return new Blob(parts.concat(central, [new Uint8Array(eocd.buffer)]), { type: 'application/zip' });
}
