# Community Tools

The core logic behind the tools in the **Community** tab on
[subnsub.com](https://subnsub.com) — published so that our central claim,
*"your files never leave your device"*, is auditable rather than something
you have to take on faith.

Every tool here runs entirely in the browser: no uploads, no telemetry —
your file bytes never leave the device. (The pdf demo fetches the pdf-lib
*library* from a CDN with an SRI pin; the site build vendors it. Library
code comes in — your files never go out.) This repository contains the
file-processing logic of
each tool as a standalone ES module, with a minimal demo page and notes on
the hardening decisions. The styled versions on subnsub.com wrap these same
algorithms; we keep the two in lockstep when tool logic changes.

## Tools

| Tool | Module | What it does |
|---|---|---|
| [File Encrypt](tools/encrypt/) | `encrypt.js` | AES-256-GCM password sealing (PBKDF2-SHA256 · 600k). The [`.snse` container format](tools/encrypt/FORMAT.md) is fully specified, with a Python reference decryptor — your files are never locked to our code. |
| [EXIF Cleaner](tools/exif/) | `exif-clean.js` | Byte-level metadata strip for JPEG/PNG/WebP — pixels copied verbatim, never re-encoded. |
| [PDF Tools](tools/pdf/) | `pdf-tools.js` | Merge, page-extract, images→PDF on top of pdf-lib, with declared-size guards before any decoder runs. |
| [Image Convert](tools/imgconv/) | `imgconv.js` | Canvas re-encode to JPEG/PNG/WebP; native-first decode, guarded HEIC fallback, verified output MIME. |
| [Watermark](tools/wmark/) | `watermark.js` | Tiled text watermarks, batch → hand-built store-only ZIP. |
| [Screen Recorder](tools/rec/) | `recorder.js` | getDisplayMedia + MediaRecorder with mic/system-audio mixing and an idempotent stop path. |
| [New File](tools/blank/) | `blank-files.js` | Empty files in 8 formats — the OOXML trio are hand-rolled minimal ECMA-376 packages. |
| [Stego Detector](tools/stego/) | `stego-analyze.js` | Westfeld–Pfitzmann chi-square LSB steganalysis, bit-plane viewer, payload extractor. |

Each directory is self-contained: one dependency-free module (pdf-lib being
the one declared exception), one plain demo page, one README. Open any
`demo.html` over HTTP (ES modules don't load from `file://`):

```
python3 -m http.server 8000
# → http://localhost:8000/tools/encrypt/demo.html
```

## What this repo is (and isn't)

- **It is the auditable core**: the code that touches your bytes —
  parsers, crypto, encoders, the guards around them.
- **It is not the site.** The UI shell, design system, i18n and account
  plumbing of subnsub.com are not part of this repository. The demo pages
  here are deliberately unstyled.
- Third-party tools listed in the Community tab (e.g. WLOC) live with
  their own authors and are credited on their cards; this repo covers the
  tools we built ourselves.

## License

[AGPL-3.0](LICENSE) © 2026 SUB&SUB LLC.

The AGPL is a deliberate choice: audit freely, fork freely — but a hosted
closed-source fork must publish its changes. "SUB&SUB", "subnsub" and the
site's visual identity are not licensed by this repository.
