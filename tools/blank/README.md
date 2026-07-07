# New File

Create a named, empty file in any of eight formats — TXT, Markdown, CSV,
JSON, RTF, DOCX, XLSX, PPTX — generated entirely in the browser. This is
the core logic of the [New File tool on subnsub.com](https://subnsub.com).

## Files

- [`blank-files.js`](blank-files.js) — the module: `FORMATS`, `fileName()`,
  `makeDocx()`, `makeXlsx()`, `makePptx()`
- [`demo.html`](demo.html) — minimal standalone page

## Usage

```js
import { FORMATS, fileName } from './blank-files.js';

const f = FORMATS.docx;
const blob = new Blob([f.make()], { type: f.mime });
const name = fileName(userInput, 'docx');   // sanitised, extension-safe
```

## Design notes

- txt/md/csv are genuinely 0 bytes; json is `{}`; rtf is a minimal header.
- The OOXML trio (docx/xlsx/pptx) are minimal ECMA-376 packages written as
  **store-mode (uncompressed) zips** by a ~40-line hand-rolled writer with
  a fixed timestamp — deterministic output, zero dependencies. The recipes
  are validated against python-docx / openpyxl / python-pptx and
  LibreOffice headless import.
- PowerPoint is the picky one: it refuses packages without a full theme
  part (12-colour `clrScheme`, `fontScheme`, and a `fmtScheme` with three
  entries per style list) — the embedded theme is the minimum it accepts.
- The DOCX carries no `sectPr` on purpose: Word fills in the viewer's
  regional page defaults (A4 vs Letter).
- `fileName()` strips filesystem-reserved characters, C0/C1 controls and
  bidi/invisible direction marks (spoofable in download UIs), avoids
  doubled extensions, and dodges Windows reserved device basenames.
