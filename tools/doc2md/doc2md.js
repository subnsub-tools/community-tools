/* Doc to Markdown — markitdown-style document→Markdown conversion, entirely
   client-side. Core logic of the Doc to Markdown tool on subnsub.com, kept in
   lockstep with the in-page version.

   Per-format pipelines: DOCX rides mammoth (semantic HTML out, then the
   serializer below); XLSX/XLS/XLSM/ODS ride SheetJS (formatted cell text →
   GFM tables); PPTX and EPUB are unpacked by the built-in zip reader
   (central-directory walk + DecompressionStream — zip64, encrypted entries
   and size-lying members all fail closed) and their XML parsed directly;
   PDF text comes from pdf.js (positional line rebuild); HTML runs through
   the same HTML→Markdown serializer; CSV/TSV are a hand-rolled RFC-4180
   state machine; JSON/XML embed as fenced blocks; ZIP converts each
   supported member (depth 1).

   Libraries are NOT bundled — pass their namespaces in via `libs`
   ({ mammoth, XLSX, pdfjs }); each format needing a missing library fails
   with code 'lib'. This is a browser module: it needs DOMParser,
   DecompressionStream, Blob and TextDecoder (no network, no storage).

   Inputs are bounded (CAPS below) so a hostile document degrades to a
   truncation note, not a hung tab. Errors carry a `.code`:
   unsupported | parse | badfile | encrypted | empty | browser | lib |
   zipnone. */

export const CAPS = {
  MAX_FILE: 50 * 1024 * 1024,
  MAX_PART: 32 * 1024 * 1024,   /* one member inside pptx/epub/zip */
  MAX_PDF_PAGES: 300,
  MAX_PPTX_SLIDES: 300,
  MAX_EPUB_CH: 300,
  MAX_TABLE_ROWS: 2000,
  MAX_COLS: 64,
  MAX_ZIP_ENTRIES: 40,
  MAX_OUT_CHARS: 20 * 1024 * 1024,
  FENCE_CAP: 2 * 1024 * 1024,
};

const SLIDE_LABEL = 'Slide';
const NOTES_LABEL = 'Notes';
const TRUNC_WARN = 'Large input — part of the output was truncated.';

function mkErr(code) {
  const e = new Error(code);
  e.code = code;
  return e;
}

export function decodeText(u8) {
  if (u8.length >= 2) {
    if (u8[0] === 0xFF && u8[1] === 0xFE) return new TextDecoder('utf-16le').decode(u8);
    if (u8[0] === 0xFE && u8[1] === 0xFF) return new TextDecoder('utf-16be').decode(u8);
  }
  return new TextDecoder().decode(u8);
}

function needDS() {
  if (typeof DecompressionStream === 'undefined') throw mkErr('browser');
}

function toAB(u8) {
  return (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength) ? u8.buffer : u8.slice().buffer;
}

/* ── zip reader ─────────────────────────────────────────────────────
   Central-directory walk over a Uint8Array. Sizes come from the CD (so
   bit-3 data descriptors don't matter), zip64 sentinels and encrypted
   entries throw, and inflate streams through DecompressionStream with a
   byte cap — a member whose real size exceeds its declared size (zip
   bomb) is cut off mid-stream instead of exhausting memory. */
export function zipEntries(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const n = u8.byteLength;
  if (n < 22) throw mkErr('parse');
  let eocd = -1;
  for (let i = n - 22, stop = Math.max(0, n - 65558); i >= stop; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw mkErr('parse');
  const count = dv.getUint16(eocd + 10, true);
  const cdSize = dv.getUint32(eocd + 12, true);
  const cdOfs = dv.getUint32(eocd + 16, true);
  if (count === 0xFFFF || cdOfs === 0xFFFFFFFF || cdSize === 0xFFFFFFFF) throw mkErr('parse'); /* zip64 */
  if (cdOfs + cdSize > n) throw mkErr('parse');
  const out = [];
  const dec = new TextDecoder();
  let p = cdOfs;
  for (let k = 0; k < count; k++) {
    if (p + 46 > n || dv.getUint32(p, true) !== 0x02014b50) throw mkErr('parse');
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const cmtLen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    if (csize === 0xFFFFFFFF || usize === 0xFFFFFFFF || lho === 0xFFFFFFFF) throw mkErr('parse'); /* zip64 */
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));
    out.push({ name, dir: name.charAt(name.length - 1) === '/', enc: !!(flags & 0x1), method, csize, usize, lho });
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

export function zipRead(u8, ent, cap) {
  if (ent.enc) return Promise.reject(mkErr('encrypted'));
  if (ent.method !== 0 && ent.method !== 8) return Promise.reject(mkErr('parse'));
  if (ent.usize > cap) return Promise.reject(mkErr('parse'));
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const p = ent.lho;
  if (p + 30 > u8.byteLength || dv.getUint32(p, true) !== 0x04034b50) return Promise.reject(mkErr('parse'));
  const nameLen = dv.getUint16(p + 26, true), extraLen = dv.getUint16(p + 28, true);
  const start = p + 30 + nameLen + extraLen;
  if (start + ent.csize > u8.byteLength) return Promise.reject(mkErr('parse'));
  const slice = u8.subarray(start, start + ent.csize);
  if (ent.method === 0) {
    if (ent.csize !== ent.usize) return Promise.reject(mkErr('parse'));
    return Promise.resolve(slice);
  }
  let reader;
  try {
    needDS();
    reader = new Blob([slice]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  } catch (e) { return Promise.reject(e && e.code ? e : mkErr('parse')); }
  const chunks = [];
  let got = 0;
  function pump() {
    return reader.read().then((r) => {
      if (r.done) return null;
      got += r.value.byteLength;
      if (got > ent.usize) { try { reader.cancel(); } catch (_) {} throw mkErr('parse'); }
      chunks.push(r.value);
      return pump();
    });
  }
  return pump().then(() => {
    if (got !== ent.usize) throw mkErr('parse');
    const out = new Uint8Array(got);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.byteLength; }
    return out;
  });
}

function joinPath(base, rel) {
  const segs = (base ? base.split('/') : []).concat(rel.split('/'));
  const out = [];
  for (const s of segs) {
    if (!s || s === '.') continue;
    if (s === '..') out.pop(); else out.push(s);
  }
  return out.join('/');
}

/* ── HTML → Markdown serializer ─────────────────────────────────────
   Walks an HTML DOM (always parsed as text/html — mammoth output, .html
   files and EPUB XHTML all come through here) and emits GFM. Unknown
   containers fall through to their children; script/style/form chrome is
   dropped; images collapse to their alt text. */
const SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, IFRAME: 1, OBJECT: 1, EMBED: 1, SVG: 1, CANVAS: 1, VIDEO: 1, AUDIO: 1, MAP: 1, BUTTON: 1, SELECT: 1, OPTION: 1, TEXTAREA: 1, INPUT: 1, LABEL: 1, FORM: 1, HEAD: 1, TITLE: 1, META: 1, LINK: 1, BASE: 1, DIALOG: 1 };
const BLOCK_TAGS = { P: 1, DIV: 1, SECTION: 1, ARTICLE: 1, MAIN: 1, ASIDE: 1, HEADER: 1, FOOTER: 1, NAV: 1, FIGURE: 1, FIGCAPTION: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, UL: 1, OL: 1, TABLE: 1, PRE: 1, BLOCKQUOTE: 1, HR: 1, DL: 1, DT: 1, DD: 1, ADDRESS: 1, DETAILS: 1, SUMMARY: 1, CAPTION: 1, LI: 1 };

function escMdCore(s) { return s.replace(/([\\`*_[\]|~])/g, '\\$1'); }
function escText(s) { return escMdCore(s.replace(/\s+/g, ' ')); }
function fixLineStart(t) {
  return t.replace(/^(\d+)([.)])(\s)/, '$1\\$2$3').replace(/^([#>+\-])/, '\\$1');
}
function cleanInline(s) {
  return s.replace(/[ \t]{2,}/g, ' ').replace(/^[ \t]+|[ \t]+$/g, '');
}
function codeSpan(s) {
  s = s.replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
  if (!s) return '';
  const m = s.match(/`+/g);
  let n = 1;
  if (m) for (const t of m) if (t.length >= n) n = t.length + 1;
  const t = '`'.repeat(n);
  return t + (s.charAt(0) === '`' ? ' ' : '') + s + (s.charAt(s.length - 1) === '`' ? ' ' : '') + t;
}
function fenceBlock(code, lang) {
  code = code.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  let t = '```';
  const m = code.match(/`{3,}/g);
  if (m) {
    let longest = 3;
    for (const x of m) if (x.length > longest) longest = x.length;
    t = '`'.repeat(longest + 1);
  }
  return t + (lang || '') + '\n' + code + '\n' + t;
}
function inlineChildren(el) {
  let s = '';
  for (let i = 0; i < el.childNodes.length; i++) s += inlineOf(el.childNodes[i]);
  return s;
}
function wrapInline(el, mark) {
  const t = cleanInline(inlineChildren(el));
  return t ? mark + t + mark : '';
}
function inlineOf(n) {
  if (n.nodeType === 3) return escText(n.nodeValue || '');
  if (n.nodeType !== 1) return '';
  const tag = n.tagName;
  if (SKIP_TAGS[tag]) return '';
  if (tag === 'BR') return '\\\n';
  if (tag === 'IMG') {
    const alt = (n.getAttribute('alt') || '').replace(/\s+/g, ' ').trim();
    return alt ? '*' + escMdCore(alt) + '*' : '';
  }
  if (tag === 'STRONG' || tag === 'B') return wrapInline(n, '**');
  if (tag === 'EM' || tag === 'I') return wrapInline(n, '*');
  if (tag === 'DEL' || tag === 'S' || tag === 'STRIKE') return wrapInline(n, '~~');
  if (tag === 'CODE' || tag === 'KBD' || tag === 'SAMP' || tag === 'TT') return codeSpan(n.textContent || '');
  if (tag === 'A') {
    const inner = cleanInline(inlineChildren(n));
    const href = n.getAttribute('href') || '';
    if (!inner) return '';
    if (/^(https?:|mailto:)/i.test(href)) return '[' + inner + '](' + href.replace(/\(/g, '%28').replace(/\)/g, '%29') + ')';
    return inner;
  }
  return inlineChildren(n);
}
function blocksOf(el) {
  const parts = [];
  let buf = '';
  function flush() {
    const t = cleanInline(buf);
    if (t) parts.push(fixLineStart(t));
    buf = '';
  }
  for (let i = 0; i < el.childNodes.length; i++) {
    const n = el.childNodes[i];
    if (n.nodeType === 3) { buf += escText(n.nodeValue || ''); continue; }
    if (n.nodeType !== 1) continue;
    if (SKIP_TAGS[n.tagName]) continue;
    if (BLOCK_TAGS[n.tagName]) {
      flush();
      const b = blockOf(n);
      if (b) parts.push(b);
    } else {
      buf += inlineOf(n);
    }
  }
  flush();
  return parts.join('\n\n');
}
function blockOf(el) {
  const tag = el.tagName;
  let t;
  if (/^H[1-6]$/.test(tag)) {
    t = cleanInline(inlineChildren(el));
    return t ? '#'.repeat(+tag.charAt(1)) + ' ' + t : '';
  }
  if (tag === 'P' || tag === 'FIGCAPTION' || tag === 'ADDRESS' || tag === 'SUMMARY' || tag === 'CAPTION' || tag === 'DD' || tag === 'LI') {
    t = cleanInline(inlineChildren(el));
    return t ? fixLineStart(t) : '';
  }
  if (tag === 'DT') {
    t = cleanInline(inlineChildren(el));
    return t ? '**' + t + '**' : '';
  }
  if (tag === 'UL' || tag === 'OL') return listBlock(el, '');
  if (tag === 'TABLE') return tableBlock(el);
  if (tag === 'PRE') return fenceBlock(el.textContent || '', '');
  if (tag === 'BLOCKQUOTE') {
    const inner = blocksOf(el);
    if (!inner) return '';
    return inner.split('\n').map((l) => (l ? '> ' + l : '>')).join('\n');
  }
  if (tag === 'HR') return '---';
  return blocksOf(el);
}
function listBlock(el, prefix) {
  const ordered = el.tagName === 'OL';
  let idx = parseInt(el.getAttribute('start') || '1', 10);
  if (isNaN(idx)) idx = 1;
  const lines = [];
  for (let i = 0; i < el.children.length; i++) {
    const li = el.children[i];
    if (li.tagName !== 'LI') continue;
    const marker = ordered ? (idx++) + '. ' : '- ';
    const pad = prefix + ' '.repeat(marker.length);
    let head = '';
    const subs = [];
    for (let j = 0; j < li.childNodes.length; j++) {
      const n = li.childNodes[j];
      if (n.nodeType === 1 && (n.tagName === 'UL' || n.tagName === 'OL')) {
        const lb = listBlock(n, pad);
        if (lb) subs.push(lb);
      } else if (n.nodeType === 1 && BLOCK_TAGS[n.tagName] && !SKIP_TAGS[n.tagName]) {
        if (!head && !subs.length && n.tagName === 'P') {
          head = cleanInline(inlineChildren(n));
          continue;
        }
        const b = blockOf(n);
        if (b) subs.push(b.split('\n').map((l) => (l ? pad + l : l)).join('\n'));
      } else {
        head += inlineOf(n);
      }
    }
    lines.push(prefix + marker + cleanInline(head));
    for (const s of subs) lines.push(s);
  }
  return lines.join('\n');
}
function cellDom(s) {
  return s.replace(/\\\n/g, '<br>').replace(/\n/g, '<br>');
}
function cellRaw(s) {
  return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>').trim();
}
function mdTable(rows) {
  let cols = 0;
  for (const r of rows) if (r.length > cols) cols = r.length;
  if (!cols) return '';
  const out = rows.map((r) => {
    const cells = [];
    for (let j = 0; j < cols; j++) {
      const c = r[j];
      cells.push(c != null && c !== '' ? c : ' ');
    }
    return '| ' + cells.join(' | ') + ' |';
  });
  out.splice(1, 0, '|' + ' --- |'.repeat(cols));
  return out.join('\n');
}
function tableBlock(el) {
  const all = el.getElementsByTagName('tr');
  const rows = [];
  for (let i = 0; i < all.length; i++) {
    const tr = all[i];
    if (tr.closest && tr.closest('table') !== el) continue;
    const cells = [];
    for (let j = 0; j < tr.children.length; j++) {
      const c = tr.children[j];
      if (c.tagName === 'TH' || c.tagName === 'TD') cells.push(cellDom(cleanInline(inlineChildren(c))));
    }
    if (cells.length) rows.push(cells);
  }
  return rows.length ? mdTable(rows) : '';
}
export function htmlToMarkdown(root) {
  if (!root) return '';
  return blocksOf(root).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/* ── per-format converters ──────────────────────────────────────────
   Each takes a Uint8Array and resolves { md, warns[] }. */
export function convertDocx(u8, mammoth) {
  if (!mammoth) return Promise.reject(mkErr('lib'));
  return Promise.resolve().then(() => {
    const opts = {};
    if (mammoth.images && typeof mammoth.images.imgElement === 'function') {
      /* drop embedded images — a base64 data URI is dead weight in .md */
      opts.convertImage = mammoth.images.imgElement(() => Promise.resolve({ src: '' }));
    }
    return mammoth.convertToHtml({ arrayBuffer: toAB(u8) }, opts);
  }).then((res) => {
    const doc = new DOMParser().parseFromString(res.value || '', 'text/html');
    const md = htmlToMarkdown(doc.body);
    if (!md) throw mkErr('empty');
    return { md, warns: [] };
  });
}

export function convertSheet(u8, XLSX) {
  if (!XLSX) return Promise.reject(mkErr('lib'));
  return Promise.resolve().then(() => {
    const wb = XLSX.read(u8, { type: 'array' });
    const parts = [];
    const warns = [];
    let truncated = false;
    for (const name of wb.SheetNames) {
      const ws = wb.Sheets[name];
      if (!ws || !ws['!ref']) continue;
      let rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
      if (rows.length > CAPS.MAX_TABLE_ROWS) { rows.length = CAPS.MAX_TABLE_ROWS; truncated = true; }
      let any = false;
      for (let i = 0; i < rows.length; i++) {
        if (rows[i].length > CAPS.MAX_COLS) { rows[i] = rows[i].slice(0, CAPS.MAX_COLS); truncated = true; }
        rows[i] = rows[i].map(cellRaw);
        if (!any) for (const c of rows[i]) if (c) { any = true; break; }
      }
      while (rows.length && !rows[rows.length - 1].some((c) => c !== '')) rows.pop();
      if (!rows.length || !any) continue;
      parts.push('## ' + escMdCore(name) + '\n\n' + mdTable(rows));
    }
    if (truncated) warns.push(TRUNC_WARN);
    if (!parts.length) throw mkErr('empty');
    return { md: parts.join('\n\n'), warns };
  });
}

function sniffDelim(text) {
  let line = '';
  for (let i = 0; i < text.length && text.charAt(i) !== '\n' && i < 65536; i++) line += text.charAt(i);
  let best = ',', bestN = -1;
  for (const d of [',', ';', '\t']) {
    const n = line.split(d).length - 1;
    if (n > bestN) { bestN = n; best = d; }
  }
  return best;
}

export function parseCsv(text, d) {
  const rows = [];
  let row = [], cell = '', q = false, truncated = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i);
    if (q) {
      if (c === '"') {
        if (text.charAt(i + 1) === '"') { cell += '"'; i++; }
        else q = false;
      } else cell += c;
    } else if (c === '"' && cell === '') {
      q = true;
    } else if (c === d) {
      if (row.length < CAPS.MAX_COLS) row.push(cell); else truncated = true;
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text.charAt(i + 1) === '\n') i++;
      if (row.length < CAPS.MAX_COLS) row.push(cell); else truncated = true;
      cell = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
      if (rows.length >= CAPS.MAX_TABLE_ROWS) { truncated = true; break; }
    } else cell += c;
  }
  if (cell !== '' || row.length) {
    if (row.length < CAPS.MAX_COLS) row.push(cell);
    if (row.length > 1 || row[0] !== '') rows.push(row);
  }
  return { rows, truncated };
}

export function convertCsv(u8, name) {
  const text = decodeText(u8);
  const d = /\.tsv$/i.test(name) ? '\t' : sniffDelim(text);
  const r = parseCsv(text, d);
  if (!r.rows.length) return Promise.reject(mkErr('empty'));
  const rows = r.rows.map((row) => row.map(cellRaw));
  return Promise.resolve({ md: mdTable(rows), warns: r.truncated ? [TRUNC_WARN] : [] });
}

function pageText(items) {
  const lines = [];
  let line = '', lastX = null, lastY = null;
  for (const it of items) {
    const x = it.transform ? it.transform[4] : 0;
    const y = it.transform ? it.transform[5] : 0;
    if (line && lastY !== null && Math.abs(y - lastY) > 2) {
      lines.push(line); line = ''; lastX = null;
    }
    if (it.str) {
      if (line && lastX !== null && x - lastX > 1 && !/\s$/.test(line) && !/^\s/.test(it.str)) line += ' ';
      line += it.str;
      lastX = x + (it.width || 0);
      lastY = y;
    }
    if (it.hasEOL) { if (line) lines.push(line); line = ''; lastX = null; lastY = null; }
  }
  if (line) lines.push(line);
  const out = [];
  for (const l of lines) {
    const t = l.replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
    if (t) out.push(fixLineStart(t));
  }
  return out.join('\n');
}

export function convertPdf(u8, pdfjs) {
  if (!pdfjs) return Promise.reject(mkErr('lib'));
  /* pdf.js transfers the buffer it is handed to its worker — always pass a
     copy, or a zip-member view would detach the whole archive */
  return pdfjs.getDocument({ data: u8.slice() }).promise.then((doc) => {
    const pages = Math.min(doc.numPages, CAPS.MAX_PDF_PAGES);
    const warns = pages < doc.numPages ? [TRUNC_WARN] : [];
    const parts = [];
    let p = Promise.resolve();
    for (let i = 1; i <= pages; i++) {
      const n = i;
      p = p.then(() => doc.getPage(n))
        .then((pg) => pg.getTextContent())
        .then((tc) => { const t = pageText(tc.items); if (t) parts.push(t); });
    }
    const done = () => { try { doc.destroy(); } catch (_) {} };
    return p.then(() => {
      done();
      if (!parts.length) throw mkErr('empty');
      return { md: parts.join('\n\n'), warns };
    }, (e) => { done(); throw e; });
  }).catch((e) => {
    if (e && e.code) throw e;
    if (e && e.name === 'PasswordException') throw mkErr('encrypted');
    throw mkErr('parse');
  });
}

function localAnc(node, ln) {
  let p = node.parentNode;
  while (p && p.nodeType === 1) {
    if (p.localName === ln) return p;
    p = p.parentNode;
  }
  return null;
}
function xmlDoc(bytes) {
  const doc = new DOMParser().parseFromString(decodeText(bytes), 'application/xml');
  return doc.getElementsByTagName('parsererror').length ? null : doc;
}
function pptxParagraphs(txBody) {
  const texts = [];
  const paras = txBody.getElementsByTagNameNS('*', 'p');
  for (let j = 0; j < paras.length; j++) {
    const pr = paras[j];
    if (localAnc(pr, 'txBody') !== txBody) continue;
    const runs = pr.getElementsByTagNameNS('*', 't');
    let s = '';
    for (let k = 0; k < runs.length; k++) s += runs[k].textContent;
    s = s.replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
    if (!s) continue;
    let lvl = 0;
    const pprs = pr.getElementsByTagNameNS('*', 'pPr');
    if (pprs.length && pprs[0].parentNode === pr) lvl = parseInt(pprs[0].getAttribute('lvl') || '0', 10) || 0;
    texts.push({ s, lvl });
  }
  return texts;
}
function pptxChunks(texts) {
  const chunks = [];
  let run = [];
  for (const x of texts) {
    if (x.lvl > 0) run.push(' '.repeat((x.lvl - 1) * 2) + '- ' + escMdCore(x.s));
    else {
      if (run.length) { chunks.push(run.join('\n')); run = []; }
      chunks.push(fixLineStart(escMdCore(x.s)));
    }
  }
  if (run.length) chunks.push(run.join('\n'));
  return chunks;
}
function pptxShapeType(txBody) {
  const sp = localAnc(txBody, 'sp');
  if (!sp) return '';
  const phs = sp.getElementsByTagNameNS('*', 'ph');
  for (let i = 0; i < phs.length; i++) if (localAnc(phs[i], 'sp') === sp) return phs[i].getAttribute('type') || 'body';
  return '';
}
function pptxTable(tbl) {
  const rows = [];
  const trs = tbl.getElementsByTagNameNS('*', 'tr');
  for (let i = 0; i < trs.length; i++) {
    if (localAnc(trs[i], 'tbl') !== tbl) continue;
    const cells = [];
    const tcs = trs[i].getElementsByTagNameNS('*', 'tc');
    for (let j = 0; j < tcs.length; j++) {
      if (localAnc(tcs[j], 'tr') !== trs[i]) continue;
      const runs = tcs[j].getElementsByTagNameNS('*', 't');
      let s = '';
      for (let k = 0; k < runs.length; k++) s += (s && !/\s$/.test(s) ? ' ' : '') + runs[k].textContent;
      cells.push(cellRaw(s));
    }
    if (cells.length) rows.push(cells);
  }
  return rows.length ? mdTable(rows) : '';
}
function parseSlideXml(bytes, forNotes) {
  const doc = xmlDoc(bytes);
  if (!doc) return null;
  const nodes = [];
  const tb = doc.getElementsByTagNameNS('*', 'txBody');
  for (let i = 0; i < tb.length; i++) if (!localAnc(tb[i], 'tbl')) nodes.push(tb[i]);
  const tbls = doc.getElementsByTagNameNS('*', 'tbl');
  for (let i = 0; i < tbls.length; i++) nodes.push(tbls[i]);
  nodes.sort((a, b) => {
    const r = a.compareDocumentPosition(b);
    return (r & 4) ? -1 : ((r & 2) ? 1 : 0);
  });
  let title = '';
  let chunks = [];
  for (const nd of nodes) {
    if (nd.localName === 'tbl') {
      const mt = pptxTable(nd);
      if (mt) chunks.push(mt);
      continue;
    }
    const type = pptxShapeType(nd);
    if (forNotes && (type === 'sldNum' || type === 'sldImg' || type === 'hdr' || type === 'ftr' || type === 'dt')) continue;
    const texts = pptxParagraphs(nd);
    if (!texts.length) continue;
    if (!forNotes && (type === 'title' || type === 'ctrTitle') && !title) {
      title = texts.map((x) => x.s).join(' ');
      continue;
    }
    chunks = chunks.concat(pptxChunks(texts));
  }
  return { title, chunks };
}

export function convertPptx(u8) {
  needDS();
  const ents = zipEntries(u8);
  const slides = [];
  const notesByN = {};
  let m;
  for (const e of ents) {
    if (e.dir) continue;
    if ((m = /^ppt\/slides\/slide(\d+)\.xml$/.exec(e.name))) slides.push({ n: +m[1], e });
    else if ((m = /^ppt\/notesSlides\/notesSlide(\d+)\.xml$/.exec(e.name))) notesByN[+m[1]] = e;
  }
  if (!slides.length) throw mkErr('parse');
  slides.sort((a, b) => a.n - b.n);
  const warns = [];
  if (slides.length > CAPS.MAX_PPTX_SLIDES) { slides.length = CAPS.MAX_PPTX_SLIDES; warns.push(TRUNC_WARN); }
  const parts = [];
  let p = Promise.resolve();
  slides.forEach((s) => {
    p = p.then(() => zipRead(u8, s.e, CAPS.MAX_PART).then((b) => {
      const slide = parseSlideXml(b, false);
      if (!slide) return;
      const head = '## ' + (slide.title ? escMdCore(slide.title) : SLIDE_LABEL + ' ' + s.n);
      const body = slide.chunks.join('\n\n');
      const note = notesByN[s.n];
      if (!note) { parts.push(head + (body ? '\n\n' + body : '')); return; }
      return zipRead(u8, note, CAPS.MAX_PART).then((nb) => {
        const ns = parseSlideXml(nb, true);
        const ntext = ns && ns.chunks.length ? ns.chunks.join('\n\n') : '';
        parts.push(head + (body ? '\n\n' + body : '') + (ntext ? '\n\n### ' + NOTES_LABEL + '\n\n' + ntext : ''));
      }, () => { parts.push(head + (body ? '\n\n' + body : '')); });
    }));
  });
  return p.then(() => {
    if (!parts.length) throw mkErr('empty');
    return { md: parts.join('\n\n'), warns };
  });
}

export function convertEpub(u8) {
  needDS();
  const ents = zipEntries(u8);
  const byName = {};
  for (const e of ents) if (!e.dir) byName[e.name] = e;
  const cont = byName['META-INF/container.xml'];
  if (!cont) throw mkErr('parse');
  return zipRead(u8, cont, CAPS.MAX_PART).then((b) => {
    const doc = xmlDoc(b);
    const rf = doc && doc.getElementsByTagNameNS('*', 'rootfile')[0];
    const path = rf && rf.getAttribute('full-path');
    if (!path || !byName[path]) throw mkErr('parse');
    const base = path.indexOf('/') >= 0 ? path.slice(0, path.lastIndexOf('/')) : '';
    return zipRead(u8, byName[path], CAPS.MAX_PART).then((ob) => ({ opf: ob, base }));
  }).then((st) => {
    const doc = xmlDoc(st.opf);
    if (!doc) throw mkErr('parse');
    const hrefById = {};
    const its = doc.getElementsByTagNameNS('*', 'item');
    for (let i = 0; i < its.length; i++) {
      const id = its[i].getAttribute('id'), href = its[i].getAttribute('href');
      const mt = its[i].getAttribute('media-type') || '';
      if (id && href && /html/i.test(mt)) hrefById[id] = href;
    }
    const chain = [];
    const refs = doc.getElementsByTagNameNS('*', 'itemref');
    for (let i = 0; i < refs.length; i++) {
      const idref = refs[i].getAttribute('idref');
      if (idref && hrefById[idref]) chain.push(hrefById[idref]);
    }
    if (!chain.length) throw mkErr('empty');
    const warns = [];
    if (chain.length > CAPS.MAX_EPUB_CH) { chain.length = CAPS.MAX_EPUB_CH; warns.push(TRUNC_WARN); }
    const parts = [];
    const tEl = doc.getElementsByTagNameNS('*', 'title')[0];
    const title = tEl ? tEl.textContent.replace(/\s+/g, ' ').trim() : '';
    const cEl = doc.getElementsByTagNameNS('*', 'creator')[0];
    const creator = cEl ? cEl.textContent.replace(/\s+/g, ' ').trim() : '';
    if (title) parts.push('# ' + escMdCore(title));
    if (creator) parts.push('*' + escMdCore(creator) + '*');
    const metaCount = parts.length;
    let p = Promise.resolve();
    chain.forEach((href) => {
      p = p.then(() => {
        const full = joinPath(st.base, decodeURIComponent(href.split('#')[0]));
        const e = byName[full];
        if (!e) return;
        return zipRead(u8, e, CAPS.MAX_PART).then((b2) => {
          const hd = new DOMParser().parseFromString(decodeText(b2), 'text/html');
          const md = htmlToMarkdown(hd.body);
          if (md) parts.push(md);
        }, () => { /* skip an unreadable chapter, keep the book */ });
      });
    });
    return p.then(() => {
      if (parts.length <= metaCount) throw mkErr('empty');
      return { md: parts.join('\n\n'), warns };
    });
  });
}

export function convertHtml(u8) {
  const doc = new DOMParser().parseFromString(decodeText(u8), 'text/html');
  let md = htmlToMarkdown(doc.body);
  if (!md) return Promise.reject(mkErr('empty'));
  const title = (doc.title || '').replace(/\s+/g, ' ').trim();
  if (title && md.indexOf('# ') !== 0) md = '# ' + escMdCore(title) + '\n\n' + md;
  return Promise.resolve({ md, warns: [] });
}

export function convertJson(u8) {
  const text = decodeText(u8);
  const warns = [];
  let body;
  if (u8.byteLength > 3 * 1024 * 1024) body = text;
  else {
    try { body = JSON.stringify(JSON.parse(text), null, 2); }
    catch (_) { body = text; warns.push('Not valid JSON — embedded as-is.'); }
  }
  if (body.length > CAPS.FENCE_CAP) { body = body.slice(0, CAPS.FENCE_CAP); warns.push(TRUNC_WARN); }
  return Promise.resolve({ md: fenceBlock(body, 'json'), warns });
}

export function convertXml(u8) {
  let text = decodeText(u8);
  const warns = [];
  if (text.length > CAPS.FENCE_CAP) { text = text.slice(0, CAPS.FENCE_CAP); warns.push(TRUNC_WARN); }
  return Promise.resolve({ md: fenceBlock(text, 'xml'), warns });
}

export function convertText(u8) {
  const text = decodeText(u8);
  if (!text.replace(/\s+/g, '')) return Promise.reject(mkErr('empty'));
  return Promise.resolve({ md: text, warns: [] });
}

function convertZip(u8, name, depth, libs) {
  needDS();
  if (depth > 0) throw mkErr('parse');
  const ents = zipEntries(u8);
  const list = [];
  for (const e of ents) {
    if (e.dir || /^__MACOSX\//.test(e.name)) continue;
    const bn = e.name.slice(e.name.lastIndexOf('/') + 1);
    if (!bn || bn.charAt(0) === '.') continue;
    const ext = extOf(e.name);
    if (HANDLERS[ext] && ext !== 'zip') list.push(e);
  }
  if (!list.length) throw mkErr('zipnone');
  const warns = [];
  if (list.length > CAPS.MAX_ZIP_ENTRIES) { list.length = CAPS.MAX_ZIP_ENTRIES; warns.push(TRUNC_WARN); }
  const parts = [];
  let p = Promise.resolve();
  list.forEach((e) => {
    p = p.then(() => zipRead(u8, e, CAPS.MAX_FILE)
      .then((b) => convertDocument(b, extOf(e.name), e.name, libs, depth + 1))
      .then((r) => {
        parts.push('## ' + escMdCore(e.name) + '\n\n' + r.md);
        for (const w of r.warns) warns.push(e.name + ': ' + w);
      }, (err) => {
        parts.push('## ' + escMdCore(e.name) + '\n\n*conversion failed: ' + ((err && err.code) || 'parse') + '*');
      }));
  });
  return p.then(() => ({ md: parts.join('\n\n---\n\n'), warns }));
}

export function extOf(name) {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

const HANDLERS = {
  docx: (u8, name, depth, libs) => convertDocx(u8, libs.mammoth),
  xlsx: (u8, name, depth, libs) => convertSheet(u8, libs.XLSX),
  xls: (u8, name, depth, libs) => convertSheet(u8, libs.XLSX),
  xlsm: (u8, name, depth, libs) => convertSheet(u8, libs.XLSX),
  ods: (u8, name, depth, libs) => convertSheet(u8, libs.XLSX),
  pptx: (u8) => convertPptx(u8),
  pdf: (u8, name, depth, libs) => convertPdf(u8, libs.pdfjs),
  epub: (u8) => convertEpub(u8),
  html: (u8) => convertHtml(u8),
  htm: (u8) => convertHtml(u8),
  csv: (u8, name) => convertCsv(u8, name),
  tsv: (u8, name) => convertCsv(u8, name),
  json: (u8) => convertJson(u8),
  xml: (u8) => convertXml(u8),
  txt: (u8) => convertText(u8),
  md: (u8) => convertText(u8),
  markdown: (u8) => convertText(u8),
  zip: (u8, name, depth, libs) => convertZip(u8, name, depth, libs),
};
const ZIPPED = { docx: 1, xlsx: 1, xlsm: 1, ods: 1, pptx: 1, epub: 1, zip: 1 };

export const SUPPORTED = Object.keys(HANDLERS);

/* Entry point. `libs` = { mammoth, XLSX, pdfjs } — pass whichever the
   formats you feed it require. Resolves { md, warns[] }; rejects with an
   Error carrying `.code` (see header). */
export function convertDocument(u8, ext, name, libs, depth) {
  libs = libs || {};
  depth = depth || 0;
  const h = HANDLERS[ext];
  if (!h) return Promise.reject(mkErr('unsupported'));
  if (u8.byteLength > CAPS.MAX_FILE) return Promise.reject(mkErr('parse'));
  if (ZIPPED[ext] && !(u8.length > 3 && u8[0] === 0x50 && u8[1] === 0x4B && (u8[2] === 3 || u8[2] === 5 || u8[2] === 7))) return Promise.reject(mkErr('badfile'));
  return Promise.resolve().then(() => h(u8, name, depth, libs)).then((r) => {
    if (r.md.length > CAPS.MAX_OUT_CHARS) { r.md = r.md.slice(0, CAPS.MAX_OUT_CHARS); r.warns.push(TRUNC_WARN); }
    return r;
  }, (e) => {
    if (e && e.code) throw e;
    if (e && e.name === 'PasswordException') throw mkErr('encrypted');
    throw mkErr('parse');
  });
}
