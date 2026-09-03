// Excel files, written and read in the browser with no library.
//
// A .xlsx is a ZIP of XML parts, so this module is two halves: a tiny ZIP
// writer (stored, uncompressed — a grade sheet is a few hundred KB at most and
// Excel is perfectly happy with stored entries) and a reader that unzips with
// the browser's own DecompressionStream.
//
// The point of doing it by hand: the whole site is static files with nothing
// fetched from a CDN, and a spreadsheet library would be the single biggest
// download on the page for something used once per exam.

// ------------------------------------------------------------------ zip out
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const utf8 = (s) => new TextEncoder().encode(s);

/** DOS date/time, which is what a ZIP central directory stores. */
function dosTime(d = new Date()) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** Builds a ZIP from `[{name, data:Uint8Array}]`, stored (no compression). */
function zip(entries) {
  const { time, date } = dosTime();
  const chunks = [], central = [];
  let offset = 0;

  for (const e of entries) {
    const name = utf8(e.name), crc = crc32(e.data), size = e.data.length;
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);   // local file header
    lv.setUint16(4, 20, true);           // version needed
    lv.setUint16(6, 0x0800, true);       // UTF-8 names
    lv.setUint16(8, 0, true);            // stored
    lv.setUint16(10, time, true); lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true); lv.setUint32(22, size, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    chunks.push(local, e.data);

    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);   // central directory header
    cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true); cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true); cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true); cv.setUint32(24, size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    cd.set(name, 46);
    central.push(cd);

    offset += local.length + size;
  }

  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);

  return new Blob([...chunks, ...central, end], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

// ----------------------------------------------------------------- sheet xml
const xmlEsc = (s) => String(s)
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")  // Excel rejects control chars
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

/** A1, B1 … Z1, AA1 … */
function cellRef(col, row) {
  let s = "";
  for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s + (row + 1);
}

/** Excel counts days from 1899-12-30 (its leap-year bug included). */
function excelSerial(d) {
  const ms = d.getTime() - d.getTimezoneOffset() * 60000;
  return ms / 86400000 + 25569;
}

// Style indices, matching the cellXfs order in STYLES below.
export const S = {
  DEFAULT: 0, HEADER: 1, WRAP: 2, DATE: 3, NUM2: 4, PERCENT: 5,
  DANGER: 6, WARN: 7, OK: 8, MUTED: 9, TITLE: 10, BOLD: 11,
};

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2">
  <numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd\\ hh:mm"/>
  <numFmt numFmtId="165" formatCode="0.0&quot;%&quot;"/>
</numFmts>
<fonts count="8">
  <font><sz val="11"/><name val="Calibri"/></font>
  <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
  <font><sz val="11"/><color rgb="FFC62828"/><b/><name val="Calibri"/></font>
  <font><sz val="11"/><color rgb="FFB26A00"/><name val="Calibri"/></font>
  <font><sz val="11"/><color rgb="FF17864A"/><name val="Calibri"/></font>
  <font><sz val="11"/><color rgb="FF6B7280"/><name val="Calibri"/></font>
  <font><b/><sz val="14"/><color rgb="FF7A0D1F"/><name val="Calibri"/></font>
  <font><b/><sz val="11"/><name val="Calibri"/></font>
</fonts>
<fills count="4">
  <fill><patternFill patternType="none"/></fill>
  <fill><patternFill patternType="gray125"/></fill>
  <fill><patternFill patternType="solid"><fgColor rgb="FF7A0D1F"/><bgColor indexed="64"/></patternFill></fill>
  <fill><patternFill patternType="solid"><fgColor rgb="FFF7F8FB"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
  <border><left/><right/><top/><bottom/><diagonal/></border>
  <border><left/><right/><top/><bottom style="thin"><color rgb="FFDFE3EA"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="12">
  <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
  <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
  <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
  <xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
  <xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
  <xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
  <xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
  <xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
  <xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1"/>
  <xf numFmtId="0" fontId="5" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
  <xf numFmtId="0" fontId="6" fillId="0" borderId="0" xfId="0" applyFont="1"/>
  <xf numFmtId="0" fontId="7" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
<dxfs count="0"/>
<tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>
</styleSheet>`;

/**
 * One cell. Accepts a bare value or `{v, s}` to pick a style.
 * Dates become real Excel dates, numbers real numbers — so a professor can
 * sort, filter and average without cleaning the file first.
 */
function cellXml(value, col, row, style) {
  const ref = cellRef(col, row);
  let v = value, s = style;
  if (v && typeof v === "object" && !(v instanceof Date)) { s = v.s ?? s; v = v.v; }
  const sa = s ? ` s="${s}"` : "";

  if (v == null || v === "") return `<c r="${ref}"${sa}/>`;
  if (v instanceof Date) return `<c r="${ref}" s="${s || S.DATE}"><v>${excelSerial(v)}</v></c>`;
  if (typeof v === "number" && Number.isFinite(v)) return `<c r="${ref}"${sa}><v>${v}</v></c>`;
  if (typeof v === "boolean") return `<c r="${ref}"${sa} t="b"><v>${v ? 1 : 0}</v></c>`;
  return `<c r="${ref}"${sa} t="inlineStr"><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
}

/**
 * @param {{name:string, rows:any[][], cols?:number[], headerRows?:number,
 *          freeze?:boolean, filter?:boolean}} sheet
 */
function sheetXml(sheet) {
  const rows = sheet.rows || [];
  const headerRows = sheet.headerRows ?? 1;
  const width = rows.reduce((m, r) => Math.max(m, r.length), 1);

  const cols = (sheet.cols || []).length
    ? `<cols>${sheet.cols.map((w, i) =>
        `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>`
    : "";
  const freeze = sheet.freeze !== false && headerRows
    ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${headerRows}" topLeftCell="A${headerRows + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
    : "";
  const filter = sheet.filter && rows.length > headerRows
    ? `<autoFilter ref="A${headerRows}:${cellRef(width - 1, rows.length - 1)}"/>` : "";

  const body = rows.map((cells, r) => {
    const isHeader = r < headerRows && sheet.headerRows !== 0;
    const ht = isHeader ? ' ht="22" customHeight="1"' : "";
    return `<row r="${r + 1}"${ht}>${cells
      .map((c, i) => cellXml(c, i, r, isHeader ? S.HEADER : undefined)).join("")}</row>`;
  }).join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${freeze}${cols}<sheetData>${body}</sheetData>${filter}</worksheet>`;
}

/** Excel forbids : \\ / ? * [ ] in a sheet name, and caps it at 31 characters. */
const safeSheetName = (n, i) =>
  (String(n || `Sheet${i + 1}`).replace(/[:\\/?*[\]]/g, " ").trim().slice(0, 31)) || `Sheet${i + 1}`;

/** Builds a .xlsx Blob from `[{name, rows, cols?, filter?}]`. */
export function buildXlsx(sheets) {
  const list = sheets.map((s, i) => ({ ...s, name: safeSheetName(s.name, i) }));
  const files = [
    { name: "[Content_Types].xml", data: utf8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${list.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("\n")}
</Types>`) },
    { name: "_rels/.rels", data: utf8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`) },
    { name: "xl/workbook.xml", data: utf8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${list.map((s, i) => `<sheet name="${xmlEsc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets>
</workbook>`) },
    { name: "xl/_rels/workbook.xml.rels", data: utf8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${list.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("\n")}
<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`) },
    { name: "xl/styles.xml", data: utf8(STYLES) },
    ...list.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: utf8(sheetXml(s)) })),
  ];
  return zip(files);
}

/** Builds the workbook and hands it to the browser as a download. */
export function downloadXlsx(filename, sheets) {
  const blob = buildXlsx(sheets);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename.endsWith(".xlsx") ? filename : `${filename}.xlsx`;
  document.body.append(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

// ------------------------------------------------------------------- zip in
async function inflateRaw(bytes) {
  if (!globalThis.DecompressionStream) throw new Error("This browser cannot read .xlsx files. Save the sheet as CSV and import that instead.");
  const ds = new DecompressionStream("deflate-raw");
  const out = new Response(new Blob([bytes]).stream().pipeThrough(ds));
  return new Uint8Array(await out.arrayBuffer());
}

/** Reads a ZIP into `{ name: Uint8Array }`, via its central directory. */
async function unzip(buf) {
  const b = new Uint8Array(buf), dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= 0 && i > b.length - 66000; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("That file is not a valid .xlsx workbook.");

  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = {};
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true);
    const elen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nlen));

    // The local header repeats the name and extra field, at its own lengths.
    const lnlen = dv.getUint16(lho + 26, true), lelen = dv.getUint16(lho + 28, true);
    const start = lho + 30 + lnlen + lelen;
    const raw = b.subarray(start, start + csize);
    out[name] = method === 0 ? raw : await inflateRaw(raw);
    p += 46 + nlen + elen + clen;
  }
  return out;
}

const decode = (u8) => new TextDecoder().decode(u8);

/** Column letters back to a 0-based index. */
function colIndex(ref) {
  let n = 0;
  for (const ch of ref.replace(/\d+$/, "")) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * Reads the first worksheet of a .xlsx into an array of row arrays.
 * Dates come back as ISO strings, everything else as a string or number.
 */
export async function readXlsx(arrayBuffer) {
  const files = await unzip(arrayBuffer);

  const shared = [];
  if (files["xl/sharedStrings.xml"]) {
    const xml = decode(files["xl/sharedStrings.xml"]);
    for (const si of xml.match(/<si>[\s\S]*?<\/si>/g) || []) {
      // An <si> can be split across several <t> runs by formatting.
      shared.push((si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || [])
        .map((t) => unesc(t.replace(/<[^>]+>/g, ""))).join(""));
    }
  }

  const sheetName = Object.keys(files)
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))[0];
  if (!sheetName) throw new Error("That workbook has no worksheets.");

  const rows = [];
  for (const rowXml of decode(files[sheetName]).match(/<row[^>]*>[\s\S]*?<\/row>/g) || []) {
    const r = [];
    for (const c of rowXml.match(/<c[^>]*\/>|<c[^>]*>[\s\S]*?<\/c>/g) || []) {
      const ref = (c.match(/\br="([A-Z]+\d+)"/) || [])[1];
      const idx = ref ? colIndex(ref) : r.length;
      const type = (c.match(/\bt="(\w+)"/) || [])[1];
      let val;
      if (type === "inlineStr") {
        val = (c.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || [])
          .map((t) => unesc(t.replace(/<[^>]+>/g, ""))).join("");
      } else {
        const raw = (c.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        if (raw == null) val = "";
        else if (type === "s") val = shared[Number(raw)] ?? "";
        else if (type === "b") val = raw === "1";
        else if (type === "str" || type === "e") val = unesc(raw);
        else val = Number(raw);
      }
      r[idx] = val;
    }
    for (let i = 0; i < r.length; i++) if (r[i] === undefined) r[i] = "";
    rows.push(r);
  }
  return rows;
}
const unesc = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** RFC 4180 CSV/TSV, so a professor can also just save-as from Excel. */
export function readDelimited(text) {
  const sep = (text.split("\n")[0].match(/\t/g) || []).length > (text.split("\n")[0].match(/,/g) || []).length ? "\t" : ",";
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (ch !== "\r") cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ""));
}

/** Reads a File the user picked, whichever of the three formats it is. */
export async function readTable(file) {
  const name = (file.name || "").toLowerCase();
  if (name.endsWith(".xlsx") || name.endsWith(".xlsm")) return readXlsx(await file.arrayBuffer());
  if (name.endsWith(".xls")) {
    throw new Error("The old .xls format is not supported. In Excel choose File → Save As → Excel Workbook (.xlsx).");
  }
  return readDelimited(await file.text());
}
