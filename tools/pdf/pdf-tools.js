/* PDF Tools — merge, page-extract and images→PDF on top of pdf-lib.
   Core logic of the PDF Tools tool on subnsub.com, kept in lockstep with
   the in-page version.

   Everything runs in browser memory: files are never uploaded. pdf-lib is
   NOT bundled — pass its namespace (window.PDFLib from the official UMD
   build, or the ES module import) as the first argument. Encrypted inputs
   fail closed with a per-file error (pdf-lib refuses them); output size is
   bounded by the caps below.

   Error taxonomy (err.code): 'encrypted' | 'parse' (both carry
   err.fileName), 'range', 'over' (err.page, err.count), 'pages',
   'img' (err.fileName), 'pixels' (err.fileName, err.mp),
   'many' (too many inputs), 'big' (err.fileName — input over MAX_FILE). */

export const MAX_FILE = 100 * 1024 * 1024;
export const MAX_FILES = 20;
export const MAX_OUT_PAGES = 2000;
export const MAX_PIXELS = 64e6;     /* canvas re-encode guard */
export const MAX_PAGE_PT = 14400;   /* PDF spec limit — 200 in; page scales down past it */

function codeErr(code, fileName, extra) {
  const e = new Error(code);
  e.code = code;
  if (fileName) e.fileName = fileName;
  if (extra != null) e.mp = extra;
  return e;
}
function u32be(u8, p) { return ((u8[p] << 24) | (u8[p + 1] << 16) | (u8[p + 2] << 8) | u8[p + 3]) >>> 0; }

/* ── byte sniffing — MIME lies, the bytes are the judge ────────────── */

export function sniffKind(u8) {
  if (u8.length >= 3 && u8[0] === 0xFF && u8[1] === 0xD8 && u8[2] === 0xFF) return 'jpeg';
  if (u8.length >= 8 && u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4E && u8[3] === 0x47) return 'png';
  if (u8.length >= 12 && u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46
      && u8[8] === 0x57 && u8[9] === 0x45 && u8[10] === 0x42 && u8[11] === 0x50) return 'webp';
  if (u8.length >= 6 && u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x38) return 'gif';
  if (isHeifBytes(u8)) return 'heif';
  return null;
}

export function isHeifBytes(u8) {
  if (u8.length < 16) return false;
  if (!(u8[4] === 0x66 && u8[5] === 0x74 && u8[6] === 0x79 && u8[7] === 0x70)) return false;   /* ftyp */
  const brands = [String.fromCharCode(u8[8], u8[9], u8[10], u8[11])];
  for (let p = 16; p + 4 <= Math.min(u8.length, 64); p += 4) brands.push(String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]));
  return brands.some((b) => /^(heic|heix|hevc|hevx|heim|heis|hevm|hevs|mif1|msf1)$/.test(b));
}

/* Worst-case DECLARED pixel count from the HEIF ispe boxes, 0 = none
   found. Run BEFORE handing bytes to a wasm decoder — the declared size
   is what its allocator will try to grab. */
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

/* Worst-case DECLARED pixel count of a PNG, 0 = malformed. pdf-lib's
   decoder scans chunks and would honour an IHDR that isn't first, so
   reading offsets 16/20 blind is bypassable: demand the full signature
   and IHDR-as-first-chunk, then walk the chunks and fold any APNG fcTL
   frame sizes into the maximum. */
export function pngDeclaredPixels(u8) {
  if (u8.length < 33) return 0;
  if (!(u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4E && u8[3] === 0x47
     && u8[4] === 0x0D && u8[5] === 0x0A && u8[6] === 0x1A && u8[7] === 0x0A)) return 0;
  if (u32be(u8, 8) !== 13) return 0;
  if (!(u8[12] === 0x49 && u8[13] === 0x48 && u8[14] === 0x44 && u8[15] === 0x52)) return 0;   /* IHDR first */
  let worst = u32be(u8, 16) * u32be(u8, 20);
  if (!worst) return 0;
  let p = 8;
  while (p + 8 <= u8.length) {
    const len = u32be(u8, p);
    if (len > 0x7FFFFFFF) return 0;
    /* fail closed on a chunk that runs past the file — a malformed length
       would otherwise skip the walker straight over later fcTL frames */
    if (p + 12 + len > u8.length) return 0;
    const t4 = String.fromCharCode(u8[p + 4], u8[p + 5], u8[p + 6], u8[p + 7]);
    if (t4 === 'fcTL' && len >= 12) {
      /* fcTL data: seq(4) width(4) height(4) … — reads stay inside THIS chunk */
      const fw = u32be(u8, p + 12), fh = u32be(u8, p + 16);
      if (fw && fh) worst = Math.max(worst, fw * fh);
    }
    if (t4 === 'IEND') break;
    p += 12 + len;
  }
  return worst;
}

/* APP1/Exif → IFD0 tag 0x0112; any malformed structure reads as 1
   ("upright"), which degrades to a verbatim embed — never a crash */
export function jpegOrientation(u8) {
  const n = u8.length;
  let p = 2;
  while (p + 4 <= n) {
    if (u8[p] !== 0xFF) return 1;
    const m = u8[p + 1];
    if (m === 0xFF) { p++; continue; }                 /* fill byte */
    if (m === 0xDA || m === 0xD9) return 1;            /* image data: no Exif seen */
    const len = (u8[p + 2] << 8) | u8[p + 3];
    if (len < 2 || p + 2 + len > n) return 1;
    if (m === 0xE1 && len >= 16
        && u8[p + 4] === 0x45 && u8[p + 5] === 0x78 && u8[p + 6] === 0x69 && u8[p + 7] === 0x66
        && u8[p + 8] === 0 && u8[p + 9] === 0) {
      const t = p + 10, end = p + 2 + len;
      if (t + 8 > end) return 1;
      let le;
      if (u8[t] === 0x49 && u8[t + 1] === 0x49) le = true;
      else if (u8[t] === 0x4D && u8[t + 1] === 0x4D) le = false;
      else return 1;
      const rd16 = (q) => le ? (u8[q] | (u8[q + 1] << 8)) : ((u8[q] << 8) | u8[q + 1]);
      const rd32 = (q) => le
        ? (u8[q] + u8[q + 1] * 256 + u8[q + 2] * 65536 + u8[q + 3] * 16777216)
        : (u8[q] * 16777216 + u8[q + 1] * 65536 + u8[q + 2] * 256 + u8[q + 3]);
      if (rd16(t + 2) !== 42) return 1;
      const ifd = t + rd32(t + 4);
      if (ifd < t || ifd + 2 > end) return 1;
      const cnt = rd16(ifd);
      for (let i = 0; i < cnt; i++) {
        const e = ifd + 2 + i * 12;
        if (e + 12 > end) return 1;
        if (rd16(e) === 0x0112) {
          const v = rd16(e + 8);
          return (v >= 1 && v <= 8) ? v : 1;
        }
      }
      return 1;
    }
    p += 2 + len;
  }
  return 1;
}

/* ── page-range parsing ─────────────────────────────────────────────
   "1-3, 7, 12-" → zero-based indices; { over: p } = page out of range,
   { many: true } = past MAX_OUT_PAGES, null = unparseable. */
export function parseRanges(str, count) {
  const toks = String(str || '').split(/[,，;；]+/).map((s) => s.trim()).filter(Boolean);
  if (!toks.length) return null;
  const out = [];
  for (let i = 0; i < toks.length; i++) {
    const m = toks[i].match(/^(\d+)?\s*[-–—]\s*(\d+)?$/) || toks[i].match(/^(\d+)$/);
    if (!m) return null;
    let a, b;
    if (m.length === 2) { a = b = parseInt(m[1], 10); }                       /* bare "7" */
    else { a = m[1] ? parseInt(m[1], 10) : 1; b = m[2] ? parseInt(m[2], 10) : count; }
    if (!isFinite(a) || !isFinite(b) || a < 1 || b < 1) return null;
    if (a > count) return { over: a };
    if (b > count) return { over: b };
    /* enforce the cap as we push — a bare "-" on a huge document must
       not build millions of indices before the check */
    if (a <= b) { for (let p = a; p <= b; p++) { out.push(p - 1); if (out.length > MAX_OUT_PAGES) return { many: true }; } }
    else { for (let q = a; q >= b; q--) { out.push(q - 1); if (out.length > MAX_OUT_PAGES) return { many: true }; } }
  }
  return out.length ? out : null;
}

/* ── pdf-lib orchestration ────────────────────────────────────────── */

function byteLen(b) { return b instanceof Uint8Array || b instanceof ArrayBuffer ? (b.byteLength ?? b.length) : 0; }

/* The caps are enforced HERE, not left to the caller — the README's
   "caps everywhere" claim has to be true of the module itself. */
function checkInputs(inputs) {
  if (inputs.length > MAX_FILES) throw codeErr('many');
  for (const inp of inputs) if (byteLen(inp.bytes) > MAX_FILE) throw codeErr('big', inp.name);
}

async function loadDoc(PDFLib, bytes, name) {
  try {
    return await PDFLib.PDFDocument.load(bytes);
  } catch (err) {
    const enc = err && /encrypt/i.test(String((err && err.message) || err));
    throw codeErr(enc ? 'encrypted' : 'parse', name);
  }
}

/* Merge whole documents in order. inputs: [{ bytes, name }].
   Resolves to { bytes, pages }. */
export async function mergePdfs(PDFLib, inputs) {
  checkInputs(inputs);
  const outDoc = await PDFLib.PDFDocument.create();
  let total = 0;
  for (const inp of inputs) {
    const src = await loadDoc(PDFLib, inp.bytes, inp.name);
    /* the pages cap guards merge too — twenty small FILES can still be
       thousands of pages */
    if (total + src.getPageCount() > MAX_OUT_PAGES) throw codeErr('pages');
    const pages = await outDoc.copyPages(src, src.getPageIndices());
    pages.forEach((p) => outDoc.addPage(p));
    total += pages.length;
  }
  return { bytes: await outDoc.save(), pages: total };
}

/* Extract a page range ("1-3, 7, 12-") into a new document.
   Resolves to { bytes, pages }. */
export async function extractPages(PDFLib, bytes, name, rangeStr) {
  checkInputs([{ bytes, name }]);
  const doc = await loadDoc(PDFLib, bytes, name);
  const count = doc.getPageCount();
  const idxs = parseRanges(rangeStr, count);
  if (!idxs) throw codeErr('range');
  if (idxs.many) throw codeErr('pages');
  if (idxs.over) { const e = codeErr('over'); e.page = idxs.over; e.count = count; throw e; }
  const outDoc = await PDFLib.PDFDocument.create();
  const pages = await outDoc.copyPages(doc, idxs);
  pages.forEach((p) => outDoc.addPage(p));
  return { bytes: await outDoc.save(), pages: idxs.length };
}

/* ── images → PDF (browser only: uses canvas + Image) ──────────────── */

function loadImg(url) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(codeErr('imgdecode'));
    im.src = url;
  });
}

/* decode via the browser (EXIF orientation gets baked in) and re-encode.
   JPEG output is composited onto white — canvas alpha turns black there. */
async function viaCanvas(blob, outType, name) {
  const url = URL.createObjectURL(blob);
  try {
    const im = await loadImg(url).catch(() => { throw codeErr('img', name); });
    const w = im.naturalWidth, h = im.naturalHeight;
    if (!w || !h) throw codeErr('img', name);
    if (w * h > MAX_PIXELS) throw codeErr('pixels', name, Math.round(w * h / 1e6));
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const cx = cv.getContext('2d');
    if (outType === 'image/jpeg') { cx.fillStyle = '#fff'; cx.fillRect(0, 0, w, h); }
    cx.drawImage(im, 0, 0);
    const b = await new Promise((res) => cv.toBlob(res, outType, 0.92));
    if (!b) throw codeErr('img', name);
    return { kind: outType === 'image/png' ? 'png' : 'jpg', bytes: new Uint8Array(await b.arrayBuffer()) };
  } finally {
    try { URL.revokeObjectURL(url); } catch (_) {}
  }
}

/* Byte sniffing decides the pipeline (MIME lies). JPEGs whose EXIF
   orientation is 1 embed VERBATIM — zero re-encode; a rotated JPEG goes
   through canvas because PDF viewers ignore EXIF while the browser's
   decoder bakes the rotation in. PNG embeds verbatim (pdf-lib splits the
   alpha into an SMask). WebP/GIF/HEIC always re-encode.
     decodeHeic: optional async (blob) → PNG/JPEG blob. Without it, HEIC
     inputs fail with code 'img'. */
async function prepImage(bytes, name, decodeHeic) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const kind = sniffKind(u8);
  if (!kind) throw codeErr('img', name);
  if (kind === 'jpeg') {
    if (jpegOrientation(u8) === 1) return { kind: 'jpg', bytes: u8 };
    return viaCanvas(new Blob([u8]), 'image/jpeg', name);
  }
  if (kind === 'png') {
    /* pre-embed pixel guard: pdf-lib inflates PNGs to raw pixels, so the
       DECLARED size — including APNG frames and a non-first IHDR — must
       be validated before embedPng() */
    const pdecl = pngDeclaredPixels(u8);
    if (!pdecl) throw codeErr('img', name);
    if (pdecl > MAX_PIXELS) throw codeErr('pixels', name, Math.round(pdecl / 1e6));
    return { kind: 'png', bytes: u8 };
  }
  if (kind === 'gif') return viaCanvas(new Blob([u8]), 'image/png', name);   /* first frame; GIF palettes/alpha keep better in PNG */
  if (kind === 'webp') return viaCanvas(new Blob([u8]), 'image/jpeg', name);
  /* heif: ispe pre-decode guard before the wasm allocator — fail closed
     when no usable ispe exists in the whole file we hold */
  const declared = heifDeclaredPixels(u8);
  if (!declared) throw codeErr('img', name);
  if (declared > MAX_PIXELS) throw codeErr('pixels', name, Math.round(declared / 1e6));
  if (!decodeHeic) throw codeErr('img', name);
  const pngBlob = await decodeHeic(new Blob([u8])).catch(() => { throw codeErr('img', name); });
  return viaCanvas(pngBlob, 'image/jpeg', name);   /* HEIC is photos — PNG would balloon the PDF */
}

/* Build a PDF with one page per image, in order. inputs: [{ bytes, name }].
     pageSize: 'orig' (1 px → 0.75 pt, capped at the PDF page limit) | 'a4'
     decodeHeic: see prepImage.
   Resolves to { bytes, pages }. */
export async function imagesToPdf(PDFLib, inputs, { pageSize = 'orig', decodeHeic = null } = {}) {
  checkInputs(inputs);   /* one page per image, so MAX_FILES also bounds the page count */
  const outDoc = await PDFLib.PDFDocument.create();
  for (const inp of inputs) {
    const prep = await prepImage(inp.bytes, inp.name, decodeHeic);
    let img;
    try {
      img = await (prep.kind === 'jpg' ? outDoc.embedJpg(prep.bytes) : outDoc.embedPng(prep.bytes));
    } catch (_) {
      /* pdf-lib refused bytes our sniff accepted (exotic PNG etc.) */
      throw codeErr('img', inp.name);
    }
    const w = img.width, h = img.height;
    if (pageSize === 'a4') {
      const PW = 595.28, PH = 841.89, M = 36;
      const s = Math.min((PW - 2 * M) / w, (PH - 2 * M) / h);
      const dw = w * s, dh = h * s;
      outDoc.addPage([PW, PH]).drawImage(img, { x: (PW - dw) / 2, y: (PH - dh) / 2, width: dw, height: dh });
    } else {
      let pw = w * 0.75, ph = h * 0.75;              /* px @96 dpi → pt @72 dpi */
      const k = Math.min(1, MAX_PAGE_PT / Math.max(pw, ph));
      pw *= k; ph *= k;
      outDoc.addPage([pw, ph]).drawImage(img, { x: 0, y: 0, width: pw, height: ph });
    }
  }
  return { bytes: await outDoc.save(), pages: inputs.length };
}

/* Burn Annotate-mode marks into a fresh PDF. Each `pages[i]` is
   { scale, annos, toPdfPoint? } where `scale` is the render scale used to
   rasterise that page (site build: pdf.js) and `annos` are marks in RENDER
   pixels, top-left origin:
     { type:'text',      x, y, text, color, size }   // size in render px
     { type:'highlight', x, y, w, h, color }
     { type:'pen',       width, color, pts:[{x,y}, …] }
   `color` is a #rrggbb string. Optional `toPdfPoint(x,y) -> [px,py]` maps a
   render pixel to a PDF point — pass pdf.js `viewport.convertToPdfPoint` so
   rotation and a non-zero MediaBox/CropBox origin are respected (the site
   does); without it, a plain scale + y-flip is used, correct for upright
   zero-origin pages. Returns `{ bytes, skipped }` — `skipped` counts text
   notes Helvetica couldn't encode (e.g. CJK), which are dropped rather than
   failing the batch. The page render itself is a UI concern left to the
   caller, so this stays pure pdf-lib and framework-free. */
export async function annotatePdf(PDFLib, bytes, pages) {
  const { rgb, StandardFonts } = PDFLib;
  const hexRgb = h => { const n = parseInt(h.slice(1), 16); return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255); };
  const out = await loadDoc(PDFLib, bytes, 'annotate');
  const font = await out.embedFont(StandardFonts.Helvetica);
  const outPages = out.getPages();
  let skipped = 0;
  (pages || []).forEach((pg, i) => {
    const page = outPages[i];
    if (!page || !pg) return;
    const S = pg.scale, hPt = page.getHeight();
    const toPt = pg.toPdfPoint
      ? (x, y) => { const q = pg.toPdfPoint(x, y); return { x: q[0], y: q[1] }; }
      : (x, y) => ({ x: x / S, y: hPt - y / S });
    (pg.annos || []).forEach(a => {
      const col = hexRgb(a.color);
      if (a.type === 'highlight') {
        const c1 = toPt(a.x, a.y), c2 = toPt(a.x + a.w, a.y + a.h);
        page.drawRectangle({ x: Math.min(c1.x, c2.x), y: Math.min(c1.y, c2.y), width: Math.abs(c2.x - c1.x), height: Math.abs(c2.y - c1.y), color: col, opacity: 0.32 });
      } else if (a.type === 'pen') {
        if (a.pts.length === 1) { const d = toPt(a.pts[0].x, a.pts[0].y); page.drawCircle({ x: d.x, y: d.y, size: Math.max(0.6, a.width / S / 2), color: col }); }
        else for (let k = 1; k < a.pts.length; k++) page.drawLine({ start: toPt(a.pts[k-1].x, a.pts[k-1].y), end: toPt(a.pts[k].x, a.pts[k].y), thickness: a.width / S, color: col });
      } else if (a.type === 'text') {
        const b = toPt(a.x, a.y + a.size * 0.8);   /* canvas top-baseline → pdf-lib baseline */
        try { page.drawText(String(a.text), { x: b.x, y: b.y, size: a.size / S, font, color: col }); }
        catch (_) { skipped++; }
      }
    });
  });
  return { bytes: await out.save(), skipped };
}
