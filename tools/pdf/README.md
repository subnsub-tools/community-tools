# PDF Tools

Merge PDFs, extract a page range, turn photos into a PDF, or annotate a
document with text, highlights and freehand pen — right in the browser, files
never leave the device. This is the core logic of the
[PDF Tools tool on subnsub.com](https://subnsub.com).

## Files

- [`pdf-tools.js`](pdf-tools.js) — the module
- [`demo.html`](demo.html) — minimal standalone page (loads pdf-lib from a CDN)

## Dependency

[pdf-lib](https://pdf-lib.js.org/) is **not** bundled — pass its namespace
in (the site vendors `pdf-lib.min.js` and lazy-loads it on first use; the
demo pulls the same official build from a CDN):

```js
import { mergePdfs, extractPages, imagesToPdf, annotatePdf, parseRanges } from './pdf-tools.js';

const merged = await mergePdfs(window.PDFLib, [{ bytes, name }, ...]);
const picked = await extractPages(window.PDFLib, bytes, name, '1-3, 7, 12-');
const album  = await imagesToPdf(window.PDFLib, images, { pageSize: 'orig' });
// each → { bytes: Uint8Array, pages: number }

// Annotate — burn text / highlight / pen marks into a copy. Marks are in
// render pixels; pass pdf.js `viewport.convertToPdfPoint` per page so rotated
// pages map correctly (the site renders with pdf.js; here the caller supplies
// the render geometry). → { bytes: Uint8Array, skipped: number }
const marked = await annotatePdf(window.PDFLib, bytes, [
  { scale, toPdfPoint: (x, y) => viewport.convertToPdfPoint(x, y), annos: [
    { type: 'text', x: 70, y: 90, text: 'REVIEWED', color: '#e5484d', size: 16 },
    { type: 'highlight', x: 40, y: 52, w: 210, h: 26, color: '#ffd21e' },
    { type: 'pen', width: 3, color: '#3b82f6', pts: [{ x: 60, y: 150 }, { x: 120, y: 170 }] },
  ] },
]);
```

Error codes on thrown errors: `encrypted`, `parse` (carry `fileName`),
`range`, `over` (`page`, `count`), `pages`, `img` (`fileName`),
`pixels` (`fileName`, `mp`), `many` (over 20 inputs), `big` (`fileName`,
input over 100 MB) — the caps are enforced by the module itself.

## Hardening notes (the auditable part)

- **Byte sniffing decides the image pipeline** — MIME types lie. JPEG with
  EXIF orientation 1 embeds verbatim (zero re-encode); rotated JPEGs go
  through canvas because PDF viewers ignore EXIF. PNG embeds verbatim;
  WebP/GIF/HEIC re-encode.
- **Declared-size guards run before decoders.** A HEIF's `ispe` boxes and a
  PNG's IHDR + APNG `fcTL` frames are walked and their worst-case pixel
  count checked against a 64 MP cap *before* any wasm or inflate allocator
  sees the bytes — a crafted small file cannot declare a huge canvas.
- **Caps everywhere**: 100 MB per file, 20 files, 2 000 output pages
  (enforced during range expansion, so `"-"` on a huge document cannot
  build millions of indices first), PDF-spec page-size limit.
- Encrypted and unparseable PDFs fail closed with per-file errors.

HEIC input needs a decoder callback (`decodeHeic: (blob) → Promise<blob>`);
the site injects its vendored [heic-to](https://github.com/hoppergee/heic-to)
build. Without it HEIC inputs simply fail per-file.
