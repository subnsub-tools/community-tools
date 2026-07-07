# Image Convert

Convert photos to JPEG, PNG or WebP with a quality dial — HEIC input
included, fully offline. This is the core logic of the
[Image Convert tool on subnsub.com](https://subnsub.com).

## Files

- [`imgconv.js`](imgconv.js) — the module: `decodeImage()`, `convert()`
- [`demo.html`](demo.html) — minimal standalone page

## Usage

```js
import { decodeImage, convert } from './imgconv.js';

const decoded = await decodeImage(file);            // { img, url, w, h }
const blob = await convert(decoded, 'webp', 0.85);  // type-verified Blob
URL.revokeObjectURL(decoded.url);                   // caller owns the URL
```

Error codes: `decode`, `pixels` (`err.mp`), `encode`.

## Design notes

- **Native decode first.** The browser bakes EXIF orientation into the
  bitmap itself, and Safari decodes HEIC natively — the wasm decoder is a
  fallback, not the default path.
- **HEIC fallback is guarded.** Before any wasm decoder sees the bytes, the
  HEIF box tree is walked for `ispe` (declared dimensions) and checked
  against a 64 MP cap — a crafted tiny file cannot make the allocator grab
  gigabytes. No usable `ispe` → fail closed. Pass your decoder as
  `decodeHeic: (blob) → Promise<pngBlob>` (the site injects its vendored
  [heic-to](https://github.com/hoppergee/heic-to) build; the demo omits it).
- **Encode is verified.** Safari has no WebP encoder and silently hands
  back PNG from `toBlob` — the module compares the result MIME against the
  request and fails honestly instead of shipping a mislabelled file.
- JPEG output is composited onto white first: canvas alpha would otherwise
  turn black.
