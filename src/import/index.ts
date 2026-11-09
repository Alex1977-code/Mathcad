import type { Worksheet } from '../engine/model';
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
  const head = new TextDecoder('utf-8').decode(bytes.subarray(0, 400)).replace(/^﻿/, '').trimStart();

  if (lower.endsWith('.mcdx') || (isZip && !lower.endsWith('.fwk'))) return importMcdx(bytes, name, parseXml);
  if (lower.endsWith('.xmcd') || (head.startsWith('<?xml') && head.includes('worksheet'))) {
    return importXmcd(new TextDecoder('utf-8').decode(bytes).replace(/^﻿/, ''), name, parseXml);
  }
  if (lower.endsWith('.mcd')) {
    throw new ImportError(
      'Das alte binäre Mathcad-Format (.mcd, Mathcad 2001–11) ist nicht offengelegt und kann nicht direkt gelesen werden. ' +
      'Bitte die Datei in Mathcad 11–15 öffnen und als „XML-Arbeitsblatt (*.xmcd)“ speichern – diese Datei lässt sich dann importieren.',
    );
  }
  if (head.startsWith('{')) {
    let ws: Worksheet;
    try { ws = JSON.parse(new TextDecoder('utf-8').decode(bytes)); } catch { throw new ImportError('Die Datei ist beschädigt (kein gültiges JSON).'); }
    if (ws.format !== 'formelwerk' || !Array.isArray(ws.regions)) throw new ImportError('Keine FormelWerk-Datei.');
    return ws;
  }
  throw new ImportError(`Unbekanntes Dateiformat: ${name}`);
}

export { importXmcd, importMcdx };
