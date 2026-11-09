import { deflateRawSync } from "node:zlib";
import { MARKER } from "./format.js";

/**
 * Render a pack as a Word document (.docx), with no dependencies: a minimal OOXML
 * package zipped by hand. Copilot may only skim an uploaded .txt (it works from a
 * summary of it), while a .docx goes through its document reader, which keeps the
 * text. The text is the pack verbatim, one paragraph per line, so a copy out of Word
 * still decodes; `@@@ FILE` lines become headings so the document has an outline Copilot
 * (and Word's navigation pane) can follow, and code is set in a monospace style.
 */

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

/**
 * Characters XML 1.0 forbids (controls other than tab/LF, lone surrogates, U+FFFE/F),
 * plus a lone CR: Word would break the paragraph there, adding a line the pack's
 * `[<n> lines]` count does not have.
 */
const INVALID_XML = /[\x00-\x08\x0B-\x1F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function escapeXml(text: string): string {
  return text
    .replace(INVALID_XML, "�")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

type Style = "Title" | "Heading1" | "Heading2" | "Code" | "Normal";

function paragraph(text: string, style: Style): string {
  const pPr = style === "Normal" ? "" : `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>`;
  if (text === "") return `<w:p>${pPr}</w:p>`;
  // Tabs are their own run element; everything else keeps its spaces verbatim.
  const runs = text
    .split("\t")
    .map((chunk, i) => `${i > 0 ? "<w:tab/>" : ""}${chunk ? `<w:t xml:space="preserve">${escapeXml(chunk)}</w:t>` : ""}`)
    .join("");
  return `<w:p>${pPr}<w:r>${runs}</w:r></w:p>`;
}

const DIRECTIVE = new RegExp(`^${MARKER} (\\S+)`);

/** Map each pack line to a paragraph style. */
export function documentXml(packText: string): string {
  // Only CRLF is a line break here; a lone CR inside a line is replaced by escapeXml.
  const lines = packText.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  let inCode = false; // after "@@@ TREE": the tree and the files are code
  const body = lines.map((line, index) => {
    const directive = DIRECTIVE.exec(line)?.[1];
    let style: Style;
    if (index === 0 && directive === "COCCOPILOT") style = "Title";
    else if (directive === "TREE" || directive === "FILES" || directive === "EOF") {
      style = "Heading1";
      inCode = directive !== "EOF";
    } else if (directive === "FILE" && inCode) style = "Heading2"; // not the examples in the instructions
    else style = inCode ? "Code" : "Normal";
    return paragraph(line, style);
  });
  return [
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`,
    `<w:document xmlns:w="${W_NS}"><w:body>`,
    ...body,
    // A4, narrow margins: fewer wrapped code lines.
    `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720" w:header="360" w:footer="360" w:gutter="0"/></w:sectPr>`,
    `</w:body></w:document>`,
  ].join("");
}

const STYLES_XML = [
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`,
  `<w:styles xmlns:w="${W_NS}">`,
  `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault>`,
  `<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>`,
  `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>`,
  `<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>`,
  `<w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>`,
  `<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Code"/><w:qFormat/>`,
  `<w:pPr><w:keepNext/><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:b/><w:sz w:val="28"/></w:rPr></w:style>`,
  `<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Code"/><w:qFormat/>`,
  `<w:pPr><w:keepNext/><w:spacing w:before="240" w:after="60"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:b/><w:sz w:val="20"/></w:rPr></w:style>`,
  `<w:style w:type="paragraph" w:customStyle="1" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:qFormat/>`,
  `<w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Consolas" w:cs="Consolas"/><w:noProof/><w:sz w:val="18"/></w:rPr></w:style>`,
  `</w:styles>`,
].join("");

const CONTENT_TYPES_XML = [
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`,
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`,
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`,
  `<Default Extension="xml" ContentType="application/xml"/>`,
  `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>`,
  `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>`,
  `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>`,
  `</Types>`,
].join("");

const ROOT_RELS_XML = [
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`,
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`,
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>`,
  `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>`,
  `</Relationships>`,
].join("");

const DOCUMENT_RELS_XML = [
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`,
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`,
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`,
  `</Relationships>`,
].join("");

function coreXml(title: string, date: Date): string {
  const iso = date.toISOString().replace(/\.\d{3}Z$/, "Z");
  return [
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`,
    `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" `,
    `xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" `,
    `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`,
    `<dc:title>${escapeXml(title)}</dc:title><dc:creator>coccopilot</dc:creator>`,
    `<dcterms:created xsi:type="dcterms:W3CDTF">${iso}</dcterms:created>`,
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${iso}</dcterms:modified>`,
    `</cp:coreProperties>`,
  ].join("");
}

/** Build the .docx bytes for one pack part. */
export function packToDocx(packText: string, title: string, date = new Date()): Buffer {
  return zip(
    [
      ["[Content_Types].xml", CONTENT_TYPES_XML],
      ["_rels/.rels", ROOT_RELS_XML],
      ["docProps/core.xml", coreXml(title, date)],
      ["word/_rels/document.xml.rels", DOCUMENT_RELS_XML],
      ["word/styles.xml", STYLES_XML],
      ["word/document.xml", documentXml(packText)],
    ],
    date,
  );
}

// --- minimal zip writer (deflate, no zip64: a pack is far below 4 GB) ---

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buf: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date: Date): { time: number; day: number } {
  const year = Math.max(date.getFullYear(), 1980);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    day: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

export function zip(files: [name: string, content: string | Buffer][], date = new Date()): Buffer {
  const { time, day } = dosDateTime(date);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of files) {
    const nameBuf = Buffer.from(name, "utf8");
    const data = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    const packed = deflateRawSync(data);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + packed.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}
