/* New File — client-side empty-file factory. Core logic of the New File
   tool on subnsub.com, kept in lockstep with the in-page version.

   Builds every file in the browser: txt/md/csv are genuinely 0 bytes,
   json is "{}", rtf is a minimal header, and the OOXML trio
   (docx/xlsx/pptx) are minimal ECMA-376 packages written as store-mode
   (uncompressed) zips — recipes validated against python-docx / openpyxl
   / python-pptx AND LibreOffice headless import. */

const XMLH = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const RELNS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const ODREL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const ANS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const PNS = 'http://schemas.openxmlformats.org/presentationml/2006/main';

const CRC_T = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/* entries: [name, xmlString][] → Uint8Array of a stored (uncompressed) zip.
   A fixed DOS timestamp keeps output deterministic; entry names are ASCII. */
function storeZip(entries) {
  const enc = new TextEncoder();
  const parts = [], cdir = [];
  let off = 0, cdLen = 0;
  const DOSDATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
  for (const [name, text] of entries) {
    const nb = enc.encode(name), db = enc.encode(text), crc = crc32(db);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);          // version needed
    lh.setUint16(8, 0, true);           // method: store (flags/time stay 0)
    lh.setUint16(12, DOSDATE, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, db.length, true);  // csize = usize when stored
    lh.setUint32(22, db.length, true);
    lh.setUint16(26, nb.length, true);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);          // version made by
    ch.setUint16(6, 20, true);          // version needed
    ch.setUint16(14, DOSDATE, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, db.length, true);
    ch.setUint32(24, db.length, true);
    ch.setUint16(28, nb.length, true);  // remaining u16/u32 fields stay 0
    ch.setUint32(42, off, true);        // local header offset
    parts.push(new Uint8Array(lh.buffer), nb, db);
    cdir.push(new Uint8Array(ch.buffer), nb);
    off += 30 + nb.length + db.length;
    cdLen += 46 + nb.length;
  }
  const eo = new DataView(new ArrayBuffer(22));
  eo.setUint32(0, 0x06054b50, true);
  eo.setUint16(8, entries.length, true);
  eo.setUint16(10, entries.length, true);
  eo.setUint32(12, cdLen, true);
  eo.setUint32(16, off, true);
  const all = [...parts, ...cdir, new Uint8Array(eo.buffer)];
  const out = new Uint8Array(off + cdLen + 22);
  let p = 0;
  for (const a of all) { out.set(a, p); p += a.length; }
  return out;
}

function rels(pairs) {
  return XMLH + '<Relationships xmlns="' + RELNS + '">' +
    pairs.map(([id, type, target]) =>
      '<Relationship Id="' + id + '" Type="' + ODREL + '/' + type + '" Target="' + target + '"/>').join('') +
    '</Relationships>';
}
function ctypes(overrides) {
  return XMLH + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    overrides.map(([part, ct]) => '<Override PartName="' + part + '" ContentType="' + ct + '"/>').join('') +
    '</Types>';
}

export function makeDocx() {
  return storeZip([
    ['[Content_Types].xml', ctypes([
      ['/word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'],
    ])],
    ['_rels/.rels', rels([['rId1', 'officeDocument', 'word/document.xml']])],
    /* no sectPr: Word fills in the viewer's regional page defaults (A4/Letter) */
    ['word/document.xml', XMLH +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:body><w:p/></w:body></w:document>'],
  ]);
}

export function makeXlsx() {
  const SNS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  return storeZip([
    ['[Content_Types].xml', ctypes([
      ['/xl/workbook.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'],
      ['/xl/worksheets/sheet1.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'],
    ])],
    ['_rels/.rels', rels([['rId1', 'officeDocument', 'xl/workbook.xml']])],
    ['xl/workbook.xml', XMLH +
      '<workbook xmlns="' + SNS + '" xmlns:r="' + ODREL + '">' +
      '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels', rels([['rId1', 'worksheet', 'worksheets/sheet1.xml']])],
    ['xl/worksheets/sheet1.xml', XMLH + '<worksheet xmlns="' + SNS + '"><sheetData/></worksheet>'],
  ]);
}

export function makePptx() {
  const NSDECL = 'xmlns:a="' + ANS + '" xmlns:r="' + ODREL + '" xmlns:p="' + PNS + '"';
  const SPTREE = '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>';
  const solid = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  /* PowerPoint refuses packages without a full theme part: clrScheme (12
     colours), fontScheme, and a fmtScheme with 3 entries per style list. */
  const theme = XMLH + '<a:theme xmlns:a="' + ANS + '" name="Office"><a:themeElements>' +
    '<a:clrScheme name="Office">' +
    '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>' +
    '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
    '<a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>' +
    '<a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2>' +
    '<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4>' +
    '<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6>' +
    '<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink>' +
    '</a:clrScheme>' +
    '<a:fontScheme name="Office">' +
    '<a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>' +
    '<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>' +
    '</a:fontScheme>' +
    '<a:fmtScheme name="Office">' +
    '<a:fillStyleLst>' + solid + solid + solid + '</a:fillStyleLst>' +
    '<a:lnStyleLst><a:ln>' + solid + '</a:ln><a:ln>' + solid + '</a:ln><a:ln>' + solid + '</a:ln></a:lnStyleLst>' +
    '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>' +
    '<a:bgFillStyleLst>' + solid + solid + solid + '</a:bgFillStyleLst>' +
    '</a:fmtScheme></a:themeElements></a:theme>';
  const PPTCT = 'application/vnd.openxmlformats-officedocument.presentationml.';
  return storeZip([
    ['[Content_Types].xml', ctypes([
      ['/ppt/presentation.xml', PPTCT + 'presentation.main+xml'],
      ['/ppt/slideMasters/slideMaster1.xml', PPTCT + 'slideMaster+xml'],
      ['/ppt/slideLayouts/slideLayout1.xml', PPTCT + 'slideLayout+xml'],
      ['/ppt/slides/slide1.xml', PPTCT + 'slide+xml'],
      ['/ppt/theme/theme1.xml', 'application/vnd.openxmlformats-officedocument.theme+xml'],
    ])],
    ['_rels/.rels', rels([['rId1', 'officeDocument', 'ppt/presentation.xml']])],
    ['ppt/presentation.xml', XMLH + '<p:presentation ' + NSDECL + '>' +
      '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
      '<p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst>' +
      '<p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>'],
    ['ppt/_rels/presentation.xml.rels', rels([
      ['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'],
      ['rId2', 'slide', 'slides/slide1.xml'],
    ])],
    ['ppt/slideMasters/slideMaster1.xml', XMLH + '<p:sldMaster ' + NSDECL + '>' + SPTREE +
      '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
      '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>'],
    ['ppt/slideMasters/_rels/slideMaster1.xml.rels', rels([
      ['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'],
      ['rId2', 'theme', '../theme/theme1.xml'],
    ])],
    ['ppt/slideLayouts/slideLayout1.xml', XMLH + '<p:sldLayout ' + NSDECL + ' type="blank">' + SPTREE +
      '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>'],
    ['ppt/slideLayouts/_rels/slideLayout1.xml.rels', rels([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']])],
    ['ppt/slides/slide1.xml', XMLH + '<p:sld ' + NSDECL + '>' + SPTREE +
      '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>'],
    ['ppt/slides/_rels/slide1.xml.rels', rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml']])],
    ['ppt/theme/theme1.xml', theme],
  ]);
}

/* Format registry: ext → { mime, make() }. make() returns a string or a
   Uint8Array — both feed `new Blob([_], { type: mime })` directly. */
export const FORMATS = {
  txt:  { mime: 'text/plain',       make: () => '' },
  rtf:  { mime: 'application/rtf',  make: () => '{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0\\fswiss Helvetica;}}\\f0\\fs24\\par}' },
  md:   { mime: 'text/markdown',    make: () => '' },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',   make: makeDocx },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',         make: makeXlsx },
  pptx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', make: makePptx },
  csv:  { mime: 'text/csv',         make: () => '' },
  json: { mime: 'application/json', make: () => '{}\n' },
};

/* Build a safe download filename from user input.
   Strips filesystem-reserved chars, C0/C1 controls and bidi/invisible
   direction marks (spoofable in download UIs); keeps unicode names;
   avoids doubled extensions and Windows reserved device basenames. */
export function fileName(rawBase, ext) {
  let base = String(rawBase || '')
    .replace(/[\/\\:*?"<>|\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '')
    .trim();
  if (!base) base = 'Untitled';
  const suf = '.' + ext;
  if (base.length > suf.length && base.toLowerCase().endsWith(suf)) base = base.slice(0, -suf.length);
  /* Windows quirks: no trailing dots/spaces, no reserved device basenames.
     Reservation is judged on the segment BEFORE the first dot — "CON.note"
     is just as reserved as "CON". */
  base = base.replace(/[. ]+$/, '');
  if (!base || /^(CON|PRN|AUX|NUL|COM\d|LPT\d)(\.|$)/i.test(base)) base = 'Untitled';
  return base + suf;
}
