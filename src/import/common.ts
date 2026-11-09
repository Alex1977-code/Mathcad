import type { MathStmt, Node } from '../engine/ast';
import { stmtToText, toText } from '../engine/serialize';
import { parseMathRegion } from '../engine/parser';
import { newId, type MathRegion } from '../engine/model';
import { convertMathElement, type ConvertCtx } from './mathml';
import { parseExpected, type Expected } from './results';

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export type XmlParser = (xml: string) => Document;

export function defaultXmlParser(xml: string): Document {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const err = doc.getElementsByTagName('parsererror')[0];
  if (err) throw new Error('Datei ist kein gültiges XML: ' + (err.textContent ?? '').slice(0, 200));
  return doc;
}

export interface ImportedMath extends MathRegion { imported: { expected?: Expected; symbolic?: string; original?: string } }

/** Build a math region from a Mathcad <math> element; never throws. */
export function mathRegionFrom(
  mathEl: Element, x: number, y: number, ctx: ConvertCtx, expectedEl?: Element | null,
): ImportedMath {
  let src: string;
  let symbolic: Node | undefined;
  let resultEl: Element | undefined;
  let stmt: MathStmt | undefined;
  try {
    const conv = convertMathElement(mathEl, ctx);
    stmt = conv.stmt;
    symbolic = conv.symbolic;
    resultEl = conv.resultEl;
    src = stmtToText(conv.stmt);
    // safety net: the generated text must parse again
    parseMathRegion(src);
  } catch (e) {
    ctx.warnings.push(`Bereich bei (${Math.round(x)}, ${Math.round(y)}): ${(e as Error).message}`);
    src = stmt ? stmtToText(stmt) : '';
    const region: ImportedMath = { id: newId(), type: 'math', x, y, src: src || '?', disabled: true, imported: { original: (e as Error).message } };
    return region;
  }
  const expected = parseExpected(expectedEl ?? resultEl ?? null) ?? undefined;
  const disabled = mathEl.getAttribute('disable-calc') === 'true' || undefined;
  return {
    id: newId(), type: 'math', x, y, src, disabled,
    imported: { expected, symbolic: symbolic ? toText(symbolic) : undefined },
  };
}

export async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('gzip');
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(s);
}

export function imageMime(bytes: Uint8Array): string | null {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif';
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';
  return null;
}
