# EXIF Cleaner

Strip GPS position, camera details and hidden metadata from photos before
sharing — byte-level, no re-encoding, fully offline. This is the core logic
of the [EXIF Cleaner tool on subnsub.com](https://subnsub.com), published so
the "your photo never leaves your device, and its pixels are untouched"
claim is auditable.

## Files

- [`exif-clean.js`](exif-clean.js) — the module: `analyze(bytes)`
- [`demo.html`](demo.html) — minimal standalone page exercising the module

## Usage

```js
import { analyze } from './exif-clean.js';

const report = analyze(new Uint8Array(await file.arrayBuffer()));
// undefined → not JPEG/PNG/WebP;  null → recognised but corrupted
report.strips;      // [{ label, id?, size }] — every block that will be dropped
report.tiff;        // privacy preview: { make, model, software, dt, dto, gps, orientation }
const cleaned = new Blob(report.rebuild(), { type: report.mime });
```

## What it does (and does not) do

- **Never re-encodes.** The entropy-coded image data is copied verbatim;
  output pixels are bit-identical to the input.
- JPEG: drops EXIF, XMP, IPTC/Photoshop, comments, MPF gain-map indexes,
  vendor APPn segments and anything appended after the image end. Keeps
  JFIF, ICC profiles and the Adobe APP14 colour-transform tag. A non-1
  EXIF Orientation survives via a minimal 36-byte replacement segment so
  portrait shots stay upright.
- PNG: drops text/time/eXIf and unknown ancillary chunks; keeps critical
  chunks and the technical whitelist (ICC, gamma, APNG animation).
- WebP: drops EXIF/XMP chunks and clears the matching VP8X header flags.
- Truncated PNG/WebP files are rejected (fail closed) rather than
  "cleaned" into a file that silently lost data.
