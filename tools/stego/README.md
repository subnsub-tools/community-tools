# LSB Stego Detector

Inspect an image's least-significant bits for hidden data — chi-square
attack, bit-plane viewer and LSB extractor, fully offline. This is the
core logic of the [Stego Detector tool on subnsub.com](https://subnsub.com).

## Files

- [`stego-analyze.js`](stego-analyze.js) — the module
- [`demo.html`](demo.html) — minimal standalone page

## Usage

All functions take raw RGBA pixels (`getImageData(...).data`) — nothing
touches the DOM:

```js
import { analyzeChannels, segmentScan, bitPlane, extractBits, detectMagic,
         toPrintable, toHexDump } from './stego-analyze.js';

const { channels, hasAlpha, maxP } = analyzeChannels(data, w, h);
// channels: [{ key:'R', p, ratio, constant }, …]  p = P(LSB-embedded)

const map = segmentScan(data, w, h, 64);      // sequential payload map
const plane = bitPlane(data, w, h, 'rgb', 0); // RGBA buffer for a canvas
const { bytes, total } = extractBits(data, w, h,
  { channels: ['r','g','b'], bit: 0, order: 'msb', scan: 'xy' });
const sig = detectMagic(bytes);               // { key, label } | { key:'text', chars } | null
```

## How detection works

- **Westfeld–Pfitzmann chi-square attack** (Pairs of Values): LSB
  embedding of random-looking data equalises the histogram pairs
  (2i, 2i+1). The statistic feeds a regularised incomplete-gamma to yield
  P(embedded) per channel. The site's verdict thresholds: ≥ 0.9 detected,
  ≥ 0.3 suspicious.
- **Sequential payload map**: the same statistic over 64 row-major
  segments — sequential embedding lights up leading segments and drops
  off where the payload ends.
- **Constant channels report p = 0**, not 100%: a chi-square over one
  value is meaningless, and flat fills (screenshots, solid backgrounds)
  would otherwise false-positive. Linear gradients can still legitimately
  trip the statistic — the verdict is evidence, not proof.
- The extractor is a straight bit-plane reader (channel set / bit index /
  packing order / scan direction) with a file-signature sniffer over the
  first bytes — enough to recognise a ZIP, PNG or text payload instantly.

## Caveat: canvas premultiplied alpha

Browsers premultiply alpha in canvas. For images with semi-transparent
pixels, `getImageData` RGB values may not round-trip exactly — RGB-LSB
analysis of such images is unreliable by nature (the site surfaces the
same caveat). Fully opaque images are unaffected.
