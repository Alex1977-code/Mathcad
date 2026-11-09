/** Document model (serializable). */

export interface ExpScalar { re: number; im?: number; dims: number[] }
export type Expected =
  | { kind: 'scalar'; v: ExpScalar }
  | { kind: 'matrix'; rows: number; cols: number; v: (ExpScalar | null)[] }
  | { kind: 'string'; v: string };

export interface RegionBase {
  id: string;
  x: number;
  y: number;
  /** Optional fixed width (text/plot). */
  w?: number;
  h?: number;
  /** Offset of the evaluation anchor below y (Mathcad 15 orders regions by their baseline). */
  oy?: number;
}

export interface MathRegion extends RegionBase {
  type: 'math';
  src: string;
  /** Do not evaluate (Mathcad "disable evaluation"). */
  disabled?: boolean;
  /** Data from an imported Mathcad file. */
  imported?: {
    /** Result Mathcad stored in the file (used to verify our calculation). */
    expected?: Expected;
    /** Symbolic result shown by Mathcad (FormelWerk calculates numerically only). */
    symbolic?: string;
    /** Reason why the region could not be converted. */
    original?: string;
  };
}

export interface TextRegion extends RegionBase {
  type: 'text';
  /** Sanitized HTML (b, i, u, sub, sup, br, p, span with styles). */
  html: string;
}

export interface PlotTrace { x: string; y: string; color?: string; style?: 'line' | 'points' | 'both'; label?: string }

export interface PlotRegion extends RegionBase {
  type: 'plot';
  traces: PlotTrace[];
  xmin?: string; xmax?: string; ymin?: string; ymax?: string;
  xUnit?: string; yUnit?: string;
  logX?: boolean; logY?: boolean;
  title?: string;
}

export interface ImageRegion extends RegionBase {
  type: 'image';
  src: string;
  alt?: string;
}

export interface PageBreakRegion extends RegionBase { type: 'pagebreak' }

export type Region = MathRegion | TextRegion | PlotRegion | ImageRegion | PageBreakRegion;

export interface WorksheetSettings {
  decimals: number;
  expThreshold: number;
  origin: number;
  /** Base font size of formulas in px. */
  fontSize?: number;
}

export interface Worksheet {
  format: 'formelwerk';
  version: 1;
  title: string;
  regions: Region[];
  settings: WorksheetSettings;
  /** Information about the imported source file. */
  source?: { kind: 'xmcd' | 'mcdx'; name: string; warnings: string[] };
}

export const DEFAULT_SETTINGS: WorksheetSettings = { decimals: 3, expThreshold: 7, origin: 0, fontSize: 15 };

let counter = 0;
export function newId(prefix = 'r'): string {
  counter++;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

export function emptyWorksheet(title = 'Unbenannt'): Worksheet {
  return { format: 'formelwerk', version: 1, title, regions: [], settings: { ...DEFAULT_SETTINGS } };
}

/** Mathcad evaluation order: top to bottom, then left to right. */
export function sortRegions<T extends RegionBase>(regions: T[]): T[] {
  const key = (r: RegionBase) => r.y + (r.oy ?? 0);
  return regions.slice().sort((a, b) => (Math.abs(key(a) - key(b)) < 0.5 ? a.x - b.x : key(a) - key(b)));
}
