# Format

Convert images and audio without uploading them anywhere — JPEG, PNG,
WebP, AVIF on one side, MP3, WAV, OGG Vorbis, FLAC and AAC on the other.
This is the logic of the [Format tool on subnsub.com](https://subnsub.com),
kept in lockstep with the in-page version.

## Files

- [`format-image.js`](format-image.js) — `decodeImage()`, `encodeImage()`,
  `convertImage()`, `outputName()`, `dedupeNames()`, `makeZip()`
- [`format-audio.js`](format-audio.js) — `decodeAudio()`,
  `downmixToStereo()`, `buildEncodeJob()`, `encodeWav()`,
  `interleaveInt16()`, `clamp16()`, `outputName()`
- [`demo.html`](demo.html) — minimal standalone page for both halves

## Usage

```js
import { convertImage, dedupeNames, makeZip } from './format-image.js';

const out = await convertImage(file, { format: 'webp', quality: 0.85 });
// → { name, bytes, type, inSize, outSize }

const many = dedupeNames(await Promise.all(files.map((f) =>
  convertImage(f, { format: 'jpeg', quality: 0.9 }))));
const zip = makeZip(many);          // store-only ZIP, no dependency
```

```js
import { decodeAudio, buildEncodeJob, encodeWav, outputName } from './format-audio.js';

const buffer = await decodeAudio(file);           // AudioBuffer
const job = buildEncodeJob(buffer, { format: 'wav' });
const bytes = encodeWav(job);                      // 16-bit PCM WAV
const name = outputName(file.name, 'wav');
```

Errors carry `err.code`: `big`, `decode`, `pixels` (`err.mp`), `encode`,
`avif`, `avifbig`, `zipbig` on the image side; `big`, `empty`, `decode`,
`toolong`, `channels` on the audio side.

## What is here, and what isn't

The **image** half is complete: decoding, the guards, the canvas
re-encode, the ZIP writer.

The **audio** half publishes everything of ours that touches your
samples — the ceilings, the multichannel down-mix, the 16-bit quantiser,
the WAV writer, the output naming. The MP3, Vorbis, FLAC and AAC encoders
themselves are third-party code the site vendors rather than ships here:
[wasm-media-encoders](https://github.com/tmew/wasm-media-encoders) for MP3
and Vorbis, [libflacjs](https://github.com/mmig/libflac.js) for FLAC, and
the browser's own WebCodecs `AudioEncoder` muxed with
[mp4-muxer](https://github.com/Vanilagy/mp4-muxer) for AAC. WAV needs no
encoder at all, so it is written out in full and doubles as a runnable
reference for the quantiser every other path shares. The site runs those
encoders inside a worker so a long encode never blocks the page.

Turning **Office documents into PDF** is a real LibreOffice engine on a
server we operate — the site's one deliberate exception to "your files
never leave your device", spelled out on its privacy page and priced as a
paid feature. It is server code, so it is not in this repository, on the
same grounds as the rest of the service backend.

## Design notes

**Image**

- **Native decode first.** The browser bakes EXIF orientation into the
  bitmap itself, and Safari decodes HEIC natively — the wasm decoder is a
  fallback, not the default path. Pass yours as
  `decodeHeic: (blob) → Promise<pngBlob>`.
- **The HEIC fallback is guarded before it runs.** The HEIF box tree is
  walked for `ispe` (declared dimensions) and checked against a 64 MP
  ceiling, so a crafted tiny file cannot make the allocator grab
  gigabytes. Each `ispe` is read within its own box, never its parent's
  bytes, and no usable `ispe` at all fails closed. The sniff reads the
  first megabyte; the scan reads the whole file, because a small decoy
  `ispe` can sit in front of the real one.
- **Encode is verified.** Safari has no WebP encoder and silently hands
  back PNG from `toBlob` — the result MIME is compared against the request
  and a mismatch fails honestly instead of shipping a mislabelled file.
- **AVIF has two paths.** Chromium encodes it from the canvas; elsewhere
  you inject `encodeAvif(rgba, w, h, options)`. That path is synchronous
  on the calling thread and copies the RGBA plane first, so it stops at
  16 MP where the native one goes to 64 — a 64 MP `ImageData` alone is a
  quarter of a gigabyte.
- JPEG output is composited onto white first: canvas alpha would
  otherwise turn black.
- **Batch names are settled before the ZIP is built.** Sanitising can
  collapse two names into one, so `dedupeNames()` checks each candidate as
  well — a rename cannot collide with a later entry. Entries are stored,
  not deflated (these are already-compressed images), and a batch that
  would pass the 4 GiB offset ceiling of classic ZIP32 is refused rather
  than written with wrapped headers.

**Audio**

- **The ceilings are deliberately low.** `decodeAudioData` inflates a file
  to raw PCM — roughly tenfold for a 128 kbps MP3 — and every encoder then
  allocates another copy, so 30 MB of input is already hundreds of
  megabytes of samples. Bytes are checked before decode; duration is
  checked after, as a second guard.
- **Down-mix follows the Web Audio matrices**, by channel order: quad
  `Lo = ½(L + SL)`, 5.1 `Lo = L + .7071(C + SL)` with LFE dropped, clamped
  on output. Any other layout above stereo (3.0, 6.1, 7.1, …) has no
  reliable stereo matrix and is refused rather than mis-routed — sending a
  surround channel to the wrong speaker is worse than saying no.
- **The sample rate travels with the samples.** `decodeAudioData` may
  resample to the context's rate, so the job carries the decoded buffer's
  own `sampleRate` rather than assuming the source's.
- **Quantisation is asymmetric on purpose.** Full scale is
  -32768…+32767, so the negative and positive halves scale by different
  factors; `clamp16()` is the single place that happens.
