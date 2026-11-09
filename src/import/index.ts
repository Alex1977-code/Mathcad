import { normalizeWorksheet, type Worksheet } from '../engine/model';
import { importXmcd } from './xmcd';
import { importMcdx } from './mcdx';
import { defaultXmlParser, type XmlParser } from './common';

export const ACCEPTED_EXTENSIONS = '.fwk,.json,.xmcd,.mcdx,.mcd';

export class ImportError extends Error {}

/** Load a worksheet from any supported file. */
export async function loadWorksheetFile(name: string, data: ArrayBuffer | Uint8Array, parseXml: XmlParser = defaultXmlParser): Promise<Worksheet> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const lower = name.toLowerCase();
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  const text = () => decodeText(bytes);
  const head = isZip ? '' : decodeText(bytes.subarray(0, 600)).trimStart();

  // the content decides, the extension only helps when the content is ambiguous
  if (isZip) return importMcdx(bytes, name, parseXml);
  if (head.startsWith('<')) {
    if (/<worksheet\b/.test(head) || lower.endsWith('.xmcd') || head.startsWith('<?xml')) return importXmcd(text(), name, parseXml);
  }
  if (lower.endsWith('.mcd') || (bytes[0] === 0xd0 && bytes[1] === 0xcf)) {
    throw new ImportError(
      'Das alte binäre Mathcad-Format (.mcd, Mathcad 2001–11) ist nicht offengelegt und kann nicht direkt gelesen werden. ' +
      'Bitte die Datei in Mathcad 11–15 öffnen und als „XML-Arbeitsblatt (*.xmcd)“ speichern – diese Datei lässt sich dann importieren.',
    );
  }
  if (head.startsWith('{')) {
    let raw: unknown;
    try { raw = JSON.parse(text()); } catch { throw new ImportError('Die Datei ist beschädigt (kein gültiges JSON).'); }
    try { return normalizeWorksheet(raw); } catch (e) { throw new ImportError((e as Error).message); }
  }
  if (lower.endsWith('.mcdx')) throw new ImportError('Die Datei ist kein gültiges Mathcad-Prime-Dokument (kein ZIP-Archiv).');
  throw new ImportError(`Unbekanntes Dateiformat: ${name}`);
}

/** Text with byte order mark or XML encoding declaration (UTF-8, UTF-16, ISO-8859-1/Windows-1252). */
function decodeText(bytes: Uint8Array): string {
  let label = 'utf-8', skip = 0;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) { label = 'utf-16le'; skip = 2; }
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) { label = 'utf-16be'; skip = 2; }
  else if (bytes[0] === 0x3c && bytes[1] === 0x00) label = 'utf-16le';
  else if (bytes[0] === 0x00 && bytes[1] === 0x3c) label = 'utf-16be';
  else {
    const ascii = new TextDecoder('latin1').decode(bytes.subarray(0, 200));
    const enc = /encoding=["']([\w-]+)["']/i.exec(ascii)?.[1]?.toLowerCase();
    if (enc && /^(iso-8859-1|iso-8859-15|latin1|windows-1252|cp1252)$/.test(enc)) label = 'windows-1252';
  }
  let s = new TextDecoder(label).decode(bytes.subarray(skip)).replace(/^\uFEFF/, '');
  // the text is decoded now: the XML parser must not re-interpret the declared encoding
  if (label !== 'utf-8') s = s.replace(/^(<\?xml[^>]*?)\sencoding=["'][^"']*["']/, '$1');
  return s;
}

export { importXmcd, importMcdx };
