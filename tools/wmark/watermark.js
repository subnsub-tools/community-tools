/* Watermark — batch tiled text watermarks. Core logic of the Watermark
   tool on subnsub.com, kept in lockstep with the in-page version.

   The "ID photo protection" use case: a short warning tiled diagonally so
   a shared document can't be cropped clean and reused. All canvas work
   happens in the page. Text size is RELATIVE to each image's short edge,
   so one dial fits a mixed batch. Output: PNG stays PNG (alpha
   preserved), everything else re-encodes as JPEG on white. Several
   results pack into a store-only ZIP built by hand below (JPEG/PNG are
   already compressed, so store beats deflate at zero dependency cost).

   Browser-only module (Image / canvas / object URLs).
   Error codes: 'img', 'pixels' (fileName, mp), 'big' (over MAX_BYTES),
   'zipbig'. MAX_FILES is the batch cap the site applies — export only,
   since this module's entry point is per-file. */

export const MAX_BYTES = 128 * 1024 * 1024;
export const MAX_FILES = 20;
export const MAX_PIXELS = 64e6;

function codeErr(code, fileName, extra) {
  const e = new Error(code);
  e.code = code;
  if (fileName) e.fileName = fileName;
  if (extra != null) e.mp = extra;
  return e;
}
function u32be(u8, p) { return ((u8[p] << 24) | (u8[p + 1] << 16) | (u8[p + 2] << 8) | u8[p + 3]) >>> 0; }

function sniffKind(u8) {
  if (u8.length >= 3 && u8[0] === 0xFF && u8[1] === 0xD8 && u8[2] === 0xFF) return 'jpeg';
  if (u8.length >= 8 && u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4E && u8[3] === 0x47) return 'png';
  if (u8.length >= 12 && u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46
      && u8[8] === 0x57 && u8[9] === 0x45 && u8[10] === 0x42 && u8[11] === 0x50) return 'webp';
  if (u8.length >= 6 && u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x38) return 'gif';
  if (isHeifBytes(u8)) return 'heif';
  return null;
}

function isHeifBytes(u8) {
  if (u8.length < 16) return false;
  if (!(u8[4] === 0x66 && u8[5] === 0x74 && u8[6] === 0x79 && u8[7] === 0x70)) return false;   /* ftyp */
  const brands = [String.fromCharCode(u8[8], u8[9], u8[10], u8[11])];
  for (let p = 16; p + 4 <= Math.min(u8.length, 64); p += 4) brands.push(String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]));
  return brands.some((b) => /^(heic|heix|hevc|hevx|heim|heis|hevm|hevs|mif1|msf1)$/.test(b));
}

function heifDeclaredPixels(u8) {
  let worst = 0;
  function walk(start, end, depth) {
    if (depth > 6) return;
    let p = start;
    while (p + 8 <= end) {
      let size = u32be(u8, p);
      const type = String.fromCharCode(u8[p + 4], u8[p + 5], u8[p + 6], u8[p + 7]);
      let hdr = 8;
      if (size === 1) {
        if (p + 16 > end || u32be(u8, p + 8) !== 0) return;
        size = u32be(u8, p + 12); hdr = 16;
      } else if (size === 0) { size = end - p; }
      if (size < hdr || p + size > end) return;
      if (type === 'ispe') {
        if (size >= hdr + 12) {
          const w = u32be(u8, p + hdr + 4), h = u32be(u8, p + hdr + 8);
          if (w && h) worst = Math.max(worst, w * h);
        }
      } else if (type === 'meta') {
        walk(p + hdr + 4, p + size, depth + 1);
      } else if (type === 'iprp' || type === 'ipco') {
        walk(p + hdr, p + size, depth + 1);
      }
      p += size;
    }
  }
  walk(0, u8.length, 0);
  return worst;
}

function loadImg(url) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(codeErr('imgdecode'));
    im.src = url;
  });
}

/* native-first decode (browser bakes EXIF orientation), wasm HEIC via the
   decodeHeic callback on native failure only — kind carried along so the
   output format can follow the input (png keeps alpha) */
async function decodeOne(file, decodeHeic) {
  const head = new Uint8Array(await file.slice(0, 1048576).arrayBuffer());
  const kind = sniffKind(head) || 'jpeg';
  const url = URL.createObjectURL(file);
  try {
    return { img: await loadImg(url), url, kind };
  } catch (_) {
    try { URL.revokeObjectURL(url); } catch (_) {}
    if (kind !== 'heif') throw codeErr('img', file.name);
    /* scan the WHOLE file for ispe: a 1 MB window could hold a small
       decoy ispe while the real, oversized one sits past it — the HEIC
       decoder reads the full blob anyway */
    const declared = heifDeclaredPixels(new Uint8Array(await file.arrayBuffer()));
    if (!declared) throw codeErr('img', file.name);
    if (declared > MAX_PIXELS) throw codeErr('pixels', file.name, Math.round(declared / 1e6));
    if (!decodeHeic) throw codeErr('img', file.name);
    const pngBlob = await decodeHeic(file).catch(() => { throw codeErr('img', file.name); });
    const u2 = URL.createObjectURL(pngBlob);
    try {
      return { img: await loadImg(u2), url: u2, kind: 'heif' };
    } catch (_) {
      try { URL.revokeObjectURL(u2); } catch (_) {}
      throw codeErr('img', file.name);
    }
  }
}

/* Tile the watermark text across a 2d context.
     opts.text     the watermark line (empty → no-op)
     opts.color    CSS colour
     opts.sizePct  font size as % of the image's short edge
     opts.alpha    0-1
     opts.gapK     spacing multiplier (gap = gapK × font size)
     opts.font     optional CSS font-family list (defaults to system-ui) */
export function paintWatermark(cx, w, h, opts) {
  if (!opts.text) return;
  const fs = Math.max(8, Math.round(Math.min(w, h) * opts.sizePct / 100));
  cx.save();
  cx.globalAlpha = opts.alpha;
  cx.fillStyle = opts.color;
  cx.font = '600 ' + fs + 'px ' + (opts.font || 'system-ui, -apple-system, "Segoe UI", sans-serif');
  cx.textBaseline = 'middle';
  cx.translate(w / 2, h / 2);
  cx.rotate(-Math.PI / 6);
  const tw = Math.max(1, cx.measureText(opts.text).width);
  const stepX = tw + fs * opts.gapK;
  const stepY = fs * (1 + opts.gapK);
  const R = Math.sqrt(w * w + h * h) / 2;
  let row = 0;
  for (let y = -R; y <= R; y += stepY, row++) {
    const off = (row % 2) ? stepX / 2 : 0;
    for (let x = -R - off; x <= R + stepX; x += stepX) cx.fillText(opts.text, x, y);
  }
  cx.restore();
}

function cleanBase(name) {
  const b = String(name || '').replace(/\.[^.]*$/, '').replace(/[\/\\\x00-\x1F\x7F\u202A-\u202E\u2066-\u2069]/g, '');
  return (b || 'image').slice(0, 120);
}

/* Watermark one file at full size. Resolves to { name, u8 } (name carries
   -wm and the format-true extension). */
export async function watermarkImage(file, opts, { decodeHeic = null } = {}) {
  if (file.size > MAX_BYTES) throw codeErr('big', file.name);
  const r = await decodeOne(file, decodeHeic);
  const im = r.img, w = im.naturalWidth, h = im.naturalHeight;
  const fin = () => { try { URL.revokeObjectURL(r.url); } catch (_) {} };
  if (!w || !h) { fin(); throw codeErr('img', file.name); }
  if (w * h > MAX_PIXELS) { fin(); throw codeErr('pixels', file.name, Math.round(w * h / 1e6)); }
  const png = r.kind === 'png' || r.kind === 'gif';   /* keep alpha for those */
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const cx = cv.getContext('2d');
  if (!png) { cx.fillStyle = '#fff'; cx.fillRect(0, 0, w, h); }
  cx.drawImage(im, 0, 0);
  paintWatermark(cx, w, h, opts);
  return new Promise((res, rej) => {
    cv.toBlob((b) => {
      fin();
      if (!b) return rej(codeErr('img', file.name));
      b.arrayBuffer().then(
        (buf) => res({ name: cleanBase(file.name) + '-wm.' + (png ? 'png' : 'jpg'), u8: new Uint8Array(buf) }),
        () => rej(codeErr('img', file.name)));
    }, png ? 'image/png' : 'image/jpeg', 0.92);
  });
}

/* ── store-only ZIP (PK\x03\x04 / \x01\x02 / \x05\x06), UTF-8 names ── */

const CRC_T = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(u8) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/* De-dupe entry names in place — check each CANDIDATE too, not just the
   original, so a rename can never collide with a later entry. */
export function dedupeNames(entries) {
  const seen = Object.create(null);
  entries.forEach((r) => {
    const n = r.name;
    let c = 2;
    while (seen[r.name]) {
      const suf = '(' + (c++) + ')';
      /* extension-less names must still mutate, or this loop never exits */
      r.name = /\.[^.]*$/.test(n) ? n.replace(/(\.[^.]*)$/, suf + '$1') : n + suf;
    }
    seen[r.name] = 1;
  });
  return entries;
}

/* Build a store-only ZIP from [{ name, u8 }]. Throws 'zipbig' past the
   classic ZIP32 4 GiB offset limit — refuse instead of writing wrapped
   headers; watermarked PNGs can outgrow their inputs, so this is
   reachable at the 20 × 128 MB ceiling. */
export function makeZip(entries) {
  /* exact size accounting (names included), not an estimate — a long-name
     batch must not slip past the u32 offset fields */
  const teSize = new TextEncoder();
  let exact = 22;
  entries.forEach((r) => {
    const nl = teSize.encode(r.name).length;
    if (nl > 0xFFFF) throw codeErr('zipbig');   /* name length is a u16 field */
    exact += 30 + 46 + 2 * nl + r.u8.length;
  });
  if (exact > 0xFFFF0000 || entries.length > 0xFFFF) throw codeErr('zipbig');
  const te = new TextEncoder();
  const d = new Date();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = (((d.getFullYear() - 1980) & 0x7F) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const parts = [], central = [];
  let offset = 0, cdSize = 0;
  entries.forEach((en) => {
    const nameU8 = te.encode(en.name);
    const crc = crc32(en.u8);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true);          /* bit 11: UTF-8 names */
    lh.setUint16(8, 0, true);               /* store */
    lh.setUint16(10, dosTime, true);
    lh.setUint16(12, dosDate, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, en.u8.length, true);
    lh.setUint32(22, en.u8.length, true);
    lh.setUint16(26, nameU8.length, true);
    lh.setUint16(28, 0, true);
    parts.push(new Uint8Array(lh.buffer), nameU8, en.u8);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true);
    ch.setUint16(12, dosTime, true);
    ch.setUint16(14, dosDate, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, en.u8.length, true);
    ch.setUint32(24, en.u8.length, true);
    ch.setUint16(28, nameU8.length, true);
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), nameU8);
    cdSize += 46 + nameU8.length;
    offset += 30 + nameU8.length + en.u8.length;
  });
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, offset, true);
  return new Blob(parts.concat(central, [new Uint8Array(eocd.buffer)]), { type: 'application/zip' });
}
