# Watermark

Tile a protective text watermark across photos — ID cards, contracts,
screenshots — batch-friendly and entirely in the browser. This is the core
logic of the [Watermark tool on subnsub.com](https://subnsub.com).

## Files

- [`watermark.js`](watermark.js) — the module
- [`demo.html`](demo.html) — minimal standalone page

## Usage

```js
import { watermarkImage, paintWatermark, makeZip, dedupeNames } from './watermark.js';

const out = await watermarkImage(file, {
  text: 'FOR RENTAL VERIFICATION ONLY',
  color: '#ffffff',
  sizePct: 4,     // font size as % of the short edge
  alpha: 0.35,
  gapK: 1.5,      // gap = gapK × font size
});
// → { name: 'photo-wm.jpg', u8: Uint8Array }

// several results → one ZIP
const blob = makeZip(dedupeNames(results));
```

Error codes: `img` (`fileName`), `pixels` (`fileName`, `mp`), `zipbig`.

## Design notes

- Text size is **relative to each image's short edge**, so one dial fits a
  mixed batch; tiles run at −30° with half-tile row stagger so a crop
  can't dodge them.
- PNG/GIF input stays PNG (alpha preserved); everything else re-encodes as
  JPEG composited onto white.
- The multi-file ZIP is a hand-built, store-only ZIP (JPEG/PNG are already
  compressed — store beats deflate at zero dependency cost), UTF-8 names,
  entry names de-duplicated, and it refuses past the ZIP32 4 GiB offset
  limit instead of writing wrapped headers.
- HEIC input goes through the same guarded decode pipeline as our other
  image tools (declared-size `ispe` check before any wasm allocator runs);
  pass `decodeHeic: (blob) → Promise<pngBlob>` to enable it.
