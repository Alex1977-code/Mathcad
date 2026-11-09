/**
 * Word export (.docx, Office Open XML). Formulas become real Word equations (OMML), text keeps its
 * formatting (bold, italic, underline, colour, size, headings, lists), images and plots are embedded as
 * pictures; regions next to each other share a line (tab stops at their x position). The footer carries
 * the title and "Seite n von N".
 */
import JSZip from 'jszip';
import { sortRegions, safeImageSrc, type Region, type Worksheet } from '../engine/model';
import type { ComputeResult } from '../engine/worksheet';
import { latexToOmml } from './omml';

export interface DocxOptions {
  /** LaTeX of a math region as displayed (formula with result). */
  mathLatex: (r: Region & { type: 'math' }) => string;
  /** PNG of a plot region (browser only), width/height in px. */
  plotPng?: (r: Region & { type: 'plot' }) => Promise<{ data: Uint8Array; w: number; h: number } | null>;
  result?: ComputeResult | null;
}

const PAGE_MARGIN_PX = 48;            // left margin of the sheet
const TW = 15;                        // twips per px (96 dpi)
const EMU = 9525;                     // EMU per px
const MAX_W_PX = 794 - 2 * PAGE_MARGIN_PX;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

interface Media { name: string; data: Uint8Array; rid: string }

/* ------------------------------ text regions ------------------------------- */

interface RunStyle { b?: boolean; i?: boolean; u?: boolean; strike?: boolean; color?: string; sizePt?: number; vert?: 'superscript' | 'subscript'; link?: string }

function cssColor(v: string): string | undefined {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v.trim());
  if (m) return (m[1].length === 3 ? m[1].split('').map(c => c + c).join('') : m[1]).toUpperCase();
  const r = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/i.exec(v.trim());
  if (r) return [r[1], r[2], r[3]].map(x => (+x).toString(16).padStart(2, '0')).join('').toUpperCase();
  return undefined;
}

function runXml(text: string, st: RunStyle): string {
  if (!text) return '';
  const pr = [
    st.b ? '<w:b/>' : '', st.i ? '<w:i/>' : '', st.u ? '<w:u w:val="single"/>' : '', st.strike ? '<w:strike/>' : '',
    st.color ? `<w:color w:val="${st.color}"/>` : '', st.sizePt ? `<w:sz w:val="${Math.round(st.sizePt * 2)}"/>` : '',
    st.vert ? `<w:vertAlign w:val="${st.vert}"/>` : '',
  ].join('');
  return `<w:r>${pr ? `<w:rPr>${pr}</w:rPr>` : ''}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
}

/** HTML of a text region → paragraphs (each: properties + runs). */
function htmlToParagraphs(html: string): { style?: string; align?: string; runs: string; list?: 'ul' | 'ol'; num?: number }[] {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const out: { style?: string; align?: string; runs: string; list?: 'ul' | 'ol'; num?: number }[] = [];
  let cur = { runs: '' } as { style?: string; align?: string; runs: string; list?: 'ul' | 'ol'; num?: number };
  const flush = () => { if (cur.runs || cur.style) out.push(cur); cur = { runs: '' }; };
  const walk = (node: Node, st: RunStyle, list?: { kind: 'ul' | 'ol'; n: number }) => {
    if (node.nodeType === 3) { cur.runs += runXml((node.textContent ?? '').replace(/\s+/g, ' '), st); return; }
    if (node.nodeType !== 1) return;
    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();
    const s: RunStyle = { ...st };
    if (tag === 'b' || tag === 'strong') s.b = true;
    if (tag === 'i' || tag === 'em') s.i = true;
    if (tag === 'u') s.u = true;
    if (tag === 's' || tag === 'strike' || tag === 'del') s.strike = true;
    if (tag === 'sup') s.vert = 'superscript';
    if (tag === 'sub') s.vert = 'subscript';
    const style = el.getAttribute('style') ?? '';
    const color = /(?:^|;)\s*color:\s*([^;]+)/i.exec(style)?.[1];
    if (color) s.color = cssColor(color) ?? s.color;
    const fs = /font-size:\s*([\d.]+)(px|pt|em)/i.exec(style);
    if (fs) s.sizePt = fs[2] === 'pt' ? +fs[1] : fs[2] === 'px' ? +fs[1] * 0.75 : +fs[1] * 11;
    if (/font-weight:\s*(bold|[6-9]00)/i.test(style)) s.b = true;
    if (/font-style:\s*italic/i.test(style)) s.i = true;
    if (/text-decoration:[^;]*underline/i.test(style)) s.u = true;
    if (tag === 'br') { flush(); return; }
    const block = ['p', 'div', 'h1', 'h2', 'h3', 'h4', 'li', 'blockquote', 'pre'].includes(tag);
    if (tag === 'ul' || tag === 'ol') {
      flush();
      const l = { kind: tag as 'ul' | 'ol', n: 0 };
      el.childNodes.forEach(c => walk(c, s, l));
      flush();
      return;
    }
    if (block) {
      flush();
      if (/^h[1-4]$/.test(tag)) cur.style = `Heading${Math.min(3, +tag[1])}`;
      const al = /text-align:\s*(left|center|right|justify)/i.exec(style)?.[1];
      if (al) cur.align = al === 'justify' ? 'both' : al;
      if (tag === 'li' && list) { list.n++; cur.list = list.kind; cur.num = list.n; cur.runs += runXml(list.kind === 'ul' ? '•\t' : `${list.n}.\t`, {}); }
    }
    el.childNodes.forEach(c => walk(c, s, list));
    if (block) flush();
  };
  walk(doc.body.firstChild!, {});
  flush();
  return out;
}

/* --------------------------------- images ---------------------------------- */

function drawingXml(rid: string, id: number, wPx: number, hPx: number, name: string): string {
  const scale = Math.min(1, MAX_W_PX / Math.max(1, wPx));
  const cx = Math.round(wPx * scale * EMU), cy = Math.round(hPx * scale * EMU);
  return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="${esc(name)}"/>`
    + `<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>`
    + `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">`
    + `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${id}" name="${esc(name)}"/><pic:cNvPicPr/></pic:nvPicPr>`
    + `<pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
    + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>`
    + `</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
}

function dataUrlBytes(url: string): { data: Uint8Array; ext: string } | null {
  const m = /^data:image\/(png|jpe?g|gif);base64,(.*)$/i.exec(url);
  if (!m) return null;
  const bin = atob(m[2]);
  const data = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
  return { data, ext: m[1].toLowerCase().replace('jpeg', 'jpg') };
}

/** Pixel size of a PNG/JPEG/GIF (header only). */
function imageSize(d: Uint8Array): { w: number; h: number } | null {
  if (d[0] === 0x89 && d[1] === 0x50) return { w: (d[16] << 24) | (d[17] << 16) | (d[18] << 8) | d[19], h: (d[20] << 24) | (d[21] << 16) | (d[22] << 8) | d[23] };
  if (d[0] === 0x47 && d[1] === 0x49) return { w: d[6] | (d[7] << 8), h: d[8] | (d[9] << 8) };
  if (d[0] === 0xff && d[1] === 0xd8) {
    for (let i = 2; i < d.length - 9;) {
      if (d[i] !== 0xff) { i++; continue; }
      const mk = d[i + 1], len = (d[i + 2] << 8) | d[i + 3];
      if (mk >= 0xc0 && mk <= 0xc3) return { h: (d[i + 5] << 8) | d[i + 6], w: (d[i + 7] << 8) | d[i + 8] };
      i += 2 + len;
    }
  }
  return null;
}

/* -------------------------------- document --------------------------------- */

export async function buildDocx(ws: Worksheet, opts: DocxOptions): Promise<Blob> {
  const media: Media[] = [];
  let picId = 1;
  const addMedia = (data: Uint8Array, ext: string) => {
    const m = { name: `image${media.length + 1}.${ext}`, data, rid: `rIdImg${media.length + 1}` };
    media.push(m);
    return m;
  };

  // reading order; regions whose tops are close form one line
  const regions = sortRegions(ws.regions);
  const rows: Region[][] = [];
  for (const r of regions) {
    const last = rows[rows.length - 1];
    if (last && r.type !== 'pagebreak' && last[0].type !== 'pagebreak' && Math.abs(r.y - last[0].y) < 14 && r.type !== 'text' && last.every(q => q.type !== 'text')) last.push(r);
    else rows.push([r]);
  }

  const body: string[] = [];
  let prevBottom = 0;
  for (const row of rows) {
    const r0 = row[0];
    // vertical gap to the previous line as paragraph spacing (twips, capped)
    const gap = Math.max(0, Math.min(600, Math.round((r0.y - prevBottom) * TW * 0.6)));
    prevBottom = Math.max(...row.map(r => r.y + (r.h ?? 28)));
    const spacing = `<w:spacing w:before="${gap}" w:after="0"/>`;
    if (r0.type === 'pagebreak') { body.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>'); continue; }
    if (r0.type === 'text') {
      const paras = htmlToParagraphs(r0.html);
      const indent = Math.max(0, (r0.x - PAGE_MARGIN_PX) * TW);
      paras.forEach((p, k) => {
        const ppr = [p.style ? `<w:pStyle w:val="${p.style}"/>` : '', k === 0 ? spacing : '<w:spacing w:before="0" w:after="60"/>',
          p.list ? `<w:ind w:left="${indent + 360}" w:hanging="360"/>` : indent ? `<w:ind w:left="${indent}"/>` : '', p.align ? `<w:jc w:val="${p.align}"/>` : ''].join('');
        body.push(`<w:p><w:pPr>${ppr}</w:pPr>${p.runs}</w:p>`);
      });
      continue;
    }
    // one paragraph with tab stops at the x positions of the regions
    const tabs = row.map(r => Math.max(0, (r.x - PAGE_MARGIN_PX) * TW)).filter(t => t > 0);
    const tabXml = tabs.length ? `<w:tabs>${tabs.map(t => `<w:tab w:val="left" w:pos="${t}"/>`).join('')}</w:tabs>` : '';
    const parts: string[] = [];
    for (const r of row) {
      if (r.x - PAGE_MARGIN_PX > 0) parts.push('<w:r><w:tab/></w:r>');
      if (r.type === 'math') {
        const latex = opts.mathLatex(r);
        if (!latex) continue;
        parts.push(latexToOmml(latex));
        const err = opts.result?.results[r.id]?.error;
        if (err) parts.push(runXml(`  ⚠ ${err.message}`, { color: 'C0392B', sizePt: 9 }));
      } else if (r.type === 'image') {
        const src = safeImageSrc(r.src);
        const img = src ? dataUrlBytes(src) : null;
        if (!img) continue;
        const size = imageSize(img.data) ?? { w: r.w ?? 300, h: 200 };
        const w = r.w ?? size.w, h = Math.round(w * size.h / Math.max(1, size.w));
        const m = addMedia(img.data, img.ext);
        parts.push(drawingXml(m.rid, picId++, w, h, r.alt ?? 'Bild'));
      } else if (r.type === 'plot') {
        const png = await opts.plotPng?.(r);
        if (!png) { parts.push(runXml('[Diagramm]', { i: true, color: '888888' })); continue; }
        const m = addMedia(png.data, 'png');
        parts.push(drawingXml(m.rid, picId++, png.w, png.h, r.title ?? 'Diagramm'));
      }
    }
    if (!parts.length) continue;
    body.push(`<w:p><w:pPr>${tabXml}${spacing}</w:pPr>${parts.join('')}</w:p>`);
  }

  const title = String(ws.title ?? '');
  const ns = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"';
  const sect = `<w:sectPr><w:footerReference w:type="default" r:id="rIdFooter"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="${PAGE_MARGIN_PX * TW}" w:bottom="1134" w:left="${PAGE_MARGIN_PX * TW}" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr>`;
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${ns}><w:body>${body.join('')}${sect}</w:body></w:document>`;

  const fld = (instr: string) => `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> ${instr} </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>`;
  const footerXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:ftr ${ns}><w:p><w:pPr><w:pStyle w:val="Footer"/><w:tabs><w:tab w:val="right" w:pos="${(794 - 2 * PAGE_MARGIN_PX) * TW}"/></w:tabs></w:pPr>`
    + `${runXml(title, {})}<w:r><w:tab/></w:r>${runXml('Seite ', {})}${fld('PAGE')}${runXml(' von ', {})}${fld('NUMPAGES')}</w:p></w:ftr>`;

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:lang w:val="de-DE"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:color w:val="1F3864"/><w:sz w:val="32"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="60"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:color w:val="1F3864"/><w:sz w:val="26"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="160" w:after="40"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="23"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Footer"><w:name w:val="footer"/><w:basedOn w:val="Normal"/><w:rPr><w:color w:val="7F7F7F"/><w:sz w:val="18"/></w:rPr></w:style>
</w:styles>`;

  const exts = [...new Set(media.map(m => m.name.split('.').pop()!))];
  const ctype: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif' };
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${exts.map(e => `<Default Extension="${e}" ContentType="${ctype[e]}"/>`).join('')}
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;
  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>${media.map(m => `<Relationship Id="${m.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${m.name}"/>`).join('')}</Relationships>`;
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(title)}</dc:title><dc:creator>FormelWerk</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`;

  const zip = new JSZip();
  zip.file('[Content_Types].xml', contentTypes);
  zip.file('_rels/.rels', rels);
  zip.file('word/document.xml', documentXml);
  zip.file('word/styles.xml', stylesXml);
  zip.file('word/footer1.xml', footerXml);
  zip.file('word/_rels/document.xml.rels', docRels);
  zip.file('docProps/core.xml', core);
  for (const m of media) zip.file(`word/media/${m.name}`, m.data);
  return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}
