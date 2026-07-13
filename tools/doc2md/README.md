# Doc to Markdown

Turn Word, Excel, PowerPoint, PDF, EPUB, HTML and more into clean Markdown —
right in the browser, files never leave the device. This is the core logic of
the [Doc to Markdown tool on subnsub.com](https://subnsub.com), inspired by
the conversion scope of
[microsoft/markitdown](https://github.com/microsoft/markitdown) but written
from scratch for the browser (no code shared).

## Files

- [`doc2md.js`](doc2md.js) — the module
- [`demo.html`](demo.html) — minimal standalone page (loads mammoth + SheetJS
  from CDNs with SRI pins)

## Formats

| Input | Pipeline |
|---|---|
| DOCX | [mammoth](https://github.com/mwilliamson/mammoth.js) → semantic HTML → the HTML→Markdown serializer below |
| XLSX / XLS / XLSM / ODS | [SheetJS CE](https://sheetjs.com) → formatted cell text → GFM tables (one `##` section per sheet) |
| PPTX | built-in zip reader → slide XML (`a:t` runs, `a:tbl` tables, placeholder titles, speaker notes) |
| PDF | [pdf.js](https://mozilla.github.io/pdf.js/) `getTextContent` → positional line rebuild |
| EPUB | built-in zip reader → OPF spine order → XHTML chapters → serializer |
| HTML | DOMParser → serializer (headings, lists, tables, code, quotes, links) |
| CSV / TSV | hand-rolled RFC-4180 state machine, delimiter sniffing → GFM table |
| JSON / XML | fenced code block (JSON pretty-printed when parseable) |
| TXT / MD | passthrough |
| ZIP | each supported member converted, depth 1 |

Not supported (out of scope for a pure client build): OCR, audio
transcription, LLM image descriptions, YouTube URLs, legacy binary `.doc` /
`.ppt`.

## Dependencies

mammoth, SheetJS and pdf.js are **not** bundled — pass their namespaces in
(the site vendors pinned builds and lazy-loads each on first use; the demo
pulls mammoth + SheetJS from CDNs with SRI, and omits PDF because an ES-module
CDN import can't carry an SRI pin):

```js
import { convertDocument, extOf } from './doc2md.js';

const u8 = new Uint8Array(await file.arrayBuffer());
const { md, warns } = await convertDocument(u8, extOf(file.name), file.name, {
  mammoth: window.mammoth,   // for docx
  XLSX: window.XLSX,         // for xlsx/xls/xlsm/ods
  pdfjs,                     // for pdf (set GlobalWorkerOptions.workerSrc first)
});
```

PPTX, EPUB, HTML, CSV, JSON, XML, TXT and ZIP need no library at all — the
zip reader, XML walks and the HTML→Markdown serializer are self-contained.

## Hardening

- **Built-in zip reader, fail-closed**: central-directory walk (sizes come
  from the CD, so bit-3 data descriptors don't matter); zip64 sentinels,
  encrypted entries and unknown compression methods throw; inflate streams
  through `DecompressionStream` with a running byte count — a member whose
  real size exceeds its declared size (zip bomb) is cancelled mid-stream,
  and one whose real size falls short (truncation lie) is rejected after.
- **Everything is bounded** (`CAPS` export, enforced at the entry point):
  file size, member size, PDF pages, PPTX slides, EPUB chapters, table
  rows/columns, zip members, fenced-block length and total output length.
  Oversized inputs degrade to a truncation warning, never a hung tab.
- **Magic-number check**: the OOXML/EPUB/ZIP family must actually start
  with a zip signature, or conversion refuses (`badfile`) instead of
  feeding a mislabelled payload to a parser.
- **pdf.js gets a copy** of the bytes — it transfers its input buffer to a
  worker, which would otherwise detach a zip-member view and corrupt the
  archive for later members.
- **No network, no storage**: the module touches your bytes and returns a
  string; script/style/form chrome is dropped during HTML serialization,
  images collapse to their alt text (a data URI is dead weight in `.md`).
- Errors carry a `.code` (`unsupported`, `parse`, `badfile`, `encrypted`,
  `empty`, `browser`, `lib`, `zipnone`) so hosts can localize messages.

## Demo

```
python3 -m http.server 8000
# → http://localhost:8000/tools/doc2md/demo.html
```
