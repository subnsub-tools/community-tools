/* Image Convert — canvas re-encode to JPEG / PNG / WebP with a quality
   dial. Core logic of the Image Convert tool on subnsub.com, kept in
   lockstep with the in-page version.

   Decode is native-first — the browser bakes EXIF orientation into the
   bitmap by itself, and Safari decodes HEIC natively so it never needs a
   wasm decoder. Only when native decode FAILS and the bytes sniff as HEIF
   does the optional decodeHeic callback run (the site injects its vendored
   libheif build there). JPEG output is composited onto white (canvas alpha
   would otherwise turn black), and an encode whose result MIME differs
   from the request (Safari has no WebP encoder and silently hands back
   PNG) fails honestly instead of shipping a mislabelled file.

   Browser-only module (Image / canvas / object URLs).
   Error codes: 'decode', 'pixels' (err.mp), 'encode', 'big' (over MAX_BYTES). */

export const MAX_BYTES = 128 * 1024 * 1024;
export const MAX_PIXELS = 64e6;

function codeErr(code, mp) {
  const e = new Error(code);
  e.code = code;
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

function loadImg(url) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(codeErr('decode'));
    im.src = url;
  });
}

/* Decode a picked file into a drawable image. Native decode first; on
   failure, HEIF bytes route through decodeHeic (async blob → PNG blob)
   behind the ispe guard. Resolves to { img, url, w, h } — the caller owns
   revoking url. Rejects with 'decode' or 'pixels'. */
export async function decodeImage(file, { decodeHeic = null } = {}) {
  if (file.size > MAX_BYTES) throw codeErr('big');   /* the cap is the module's, not the caller's */
  const url = URL.createObjectURL(file);
  let r;
  try {
    r = { img: await loadImg(url), url };
  } catch (_) {
    URL.revokeObjectURL(url);
    /* 1 MB is plenty for the brand sniff (ftyp sits at the front) … */
    const hb = new Uint8Array(await file.slice(0, 1048576).arrayBuffer());
    if (!isHeifBytes(hb)) throw codeErr('decode');
    /* … but the ispe scan must cover the WHOLE file: a 1 MB window could
       hold a small decoy ispe while the real, oversized one sits past it —
       the HEIC decoder reads the full blob anyway. */
    const declared = heifDeclaredPixels(new Uint8Array(await file.arrayBuffer()));
    /* fail CLOSED when no usable ispe was found: every valid HEIF carries
       one per image item, so "not found" means malformed, hostile, or
       meta-after-mdat — none of which get to reach the wasm allocator
       unchecked */
    if (!declared) throw codeErr('decode');
    if (declared > MAX_PIXELS) throw codeErr('pixels', Math.round(declared / 1e6));
    if (!decodeHeic) throw codeErr('decode');
    const pngBlob = await decodeHeic(file).catch(() => { throw codeErr('decode'); });
    const u2 = URL.createObjectURL(pngBlob);
    try {
      r = { img: await loadImg(u2), url: u2 };
    } catch (e) {
      URL.revokeObjectURL(u2);
      throw e;
    }
  }
  const w = r.img.naturalWidth, h = r.img.naturalHeight;
  if (!w || !h) { URL.revokeObjectURL(r.url); throw codeErr('decode'); }
  if (w * h > MAX_PIXELS) { URL.revokeObjectURL(r.url); throw codeErr('pixels', Math.round(w * h / 1e6)); }
  return { img: r.img, url: r.url, w, h };
}

/* Re-encode a decoded image. fmt: 'jpeg' | 'png' | 'webp'; quality 0-1
   (ignored for png). Resolves to a Blob whose type is VERIFIED to match
   the request — a browser that cannot encode the format rejects with
   'encode' instead of mislabelling. */
export async function convert(decoded, fmt, quality) {
  const type = 'image/' + fmt;
  const blob = await new Promise((res, rej) => {
    try {
      const cv = document.createElement('canvas');
      cv.width = decoded.w;
      cv.height = decoded.h;
      const cx = cv.getContext('2d');
      if (!cx) { rej(codeErr('encode')); return; }
      if (fmt === 'jpeg') { cx.fillStyle = '#fff'; cx.fillRect(0, 0, cv.width, cv.height); }
      cx.drawImage(decoded.img, 0, 0);
      cv.toBlob((b) => { if (b) res(b); else rej(codeErr('encode')); }, type, fmt === 'png' ? undefined : quality);
    } catch (_) { rej(codeErr('encode')); }
  });
  if (blob.type !== type) throw codeErr('encode');
  return blob;
}
