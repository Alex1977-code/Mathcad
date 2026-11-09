import { create, all, type MathJsInstance, type Unit } from 'mathjs';

/** Shared mathjs instance with additional engineering units. */
export const math: MathJsInstance = create(all, { number: 'number', precision: 64 });

const extra: [string, string][] = [
  ['yr', '365.2422 day'],
  ['gm', '1 g'],
  ['ksi', '1000 psi'],
  ['psf', '1 lbf/ft^2'],
  ['pcf', '1 lbf/ft^3'],
  ['tonf', '2000 lbf'],
  ['kipf', '1000 lbf'],
  ['kcal', '4186.8 J'],
  ['slug', '14.593903 kg'],
  ['knot', '1852 m/hour'],
  ['mph', '1 mi/hour'],
  ['kph', '1 km/hour'],
  ['kmh', '1 km/hour'],
  ['ppm', '1e-6'],
  ['lm', '1 cd'],
  ['lx', '1 cd/m^2'],
  ['poise', '0.1 Pa s'],
  ['cP', '0.001 Pa s'],
  ['stokes', '1 cm^2/s'],
  ['ha', '10000 m^2'],
  ['gauss', '1e-4 T'],
  ['pascal', '1 Pa'],
  ['cal', '4.1868 J'],
  ['Bq', '1 s^-1'],
  ['Gy', '1 J/kg'],
  ['Sv', '1 J/kg'],
  ['nmi', '1852 m'],
  ['inHg', '3386.389 Pa'],
  ['mmHg_', '133.322387415 Pa'],
  ['deltaDegC', '1 K'],
  ['deltaDegF', '0.5555555555555556 K'],
];
for (const [name, def] of extra) {
  try { math.createUnit(name, def, { override: true }); } catch { /* ignore */ }
}
try { math.createUnit('cal_th', '4.184 J'); } catch { /* ignore */ }
// Mathcad: rpm = 2π rad/min (angles are dimensionless)
try { math.createUnit('rpm', { definition: `${(2 * Math.PI) / 60} Hz`, override: true } as never); } catch { /* ignore */ }

/** Angles are dimensionless in Mathcad: they evaluate to plain numbers (radians). */
export const ANGLE_UNITS: Record<string, number> = {
  rad: 1, radian: 1, deg: Math.PI / 180, '°': Math.PI / 180, degree: Math.PI / 180,
  grad: Math.PI / 200, gon: Math.PI / 200, rev: 2 * Math.PI, sr: 1, mrad: 1e-3,
  arcmin: Math.PI / 10800, arcsec: Math.PI / 648000,
  pct: 0.01, percent: 0.01, '%': 0.01, '‰': 0.001, permille: 0.001,
};
/** Dimensionless or angular units with a non-trivial factor that should still be offered for display. */
export const SCALAR_UNITS: Record<string, number> = {
  ...ANGLE_UNITS,
};

/** Mathcad names → mathjs names. */
const ALIASES: Record<string, string> = {
  'Ω': 'ohm', 'kΩ': 'kohm', 'MΩ': 'Mohm', 'mΩ': 'mohm',
  '°C': 'degC', '°F': 'degF', '°R': 'degR', 'Rankine': 'degR', '°K': 'K', 'R_': 'degR',
  'μm': 'um', 'µm': 'um', 'μs': 'us', 'µs': 'us', 'μF': 'uF', 'µF': 'uF', 'μA': 'uA', 'μV': 'uV',
  'μg': 'ug', 'μH': 'uH', 'μL': 'uL', 'μmol': 'umol', 'μN': 'uN', 'μW': 'uW', 'μΩ': 'uohm',
  'hr': 'hour', 'wk': 'week', 'liter': 'L', 'tonne_': 'tonne', 'mt': 'tonne',
  'gal': 'gallon', 'kgf': 'kgf', 'lbm': 'lbm', 'BTU': 'BTU',
  // Mathcad full-name units used in stored results
  'meter': 'm', 'kilogram': 'kg', 'second': 's', 'ampere': 'A', 'kelvin': 'K', 'mole': 'mol',
  'candela': 'cd', 'watt': 'W', 'joule': 'J', 'newton': 'N', 'volt': 'V', 'ohm': 'ohm',
  'coulomb': 'C', 'farad': 'F', 'henry': 'H', 'tesla': 'T', 'weber': 'Wb', 'siemens': 'S', 'hertz': 'Hz',
  'gram': 'g', 'liter_': 'L',
  'Δ°C': 'deltaDegC', 'Δ°F': 'deltaDegF', 'ΔK': 'K',
};

/** Names that are units in mathjs but are commonly used as variables; still units unless defined. */
const NOT_UNITS = new Set(['b', 'c', 'd', 'h', 'l', 't', 'u', 'P', 'G', 'R', 'E', 'Q', 'Y', 'Z', 'gr', 'dr', 'li', 'ch', 'rd', 'ly', 'au', 'pc', 'at', 'lt', 'cup', 'mil', 'link', 'rod', 'chain', 'e', 'i', 'j', 'k', 'x', 'y', 'z', 'n', 'p', 'q', 'r', 'v', 'w', 'a', 'f', 'B', 'D', 'I', 'M', 'tsp', 'tbsp', 'Ah']);

const cache = new Map<string, Unit | number | null>();

/**
 * Resolve a unit name to a mathjs Unit (value 1) or a plain number for
 * dimensionless angle units. Returns null if not a unit.
 */
export function lookupUnit(name: string, force = false): Unit | number | null {
  const key = force ? '\u0000' + name : name;
  if (cache.has(key)) return cache.get(key)!;
  let res: Unit | number | null = null;
  if (name in SCALAR_UNITS) res = SCALAR_UNITS[name];
  // force: explicitly marked as unit ('mil), also names usually taken as variables
  else if (force || !NOT_UNITS.has(name)) {
    const mj = ALIASES[name] ?? name.replace(/^[μµ]/, 'u');
    if (/^[A-Za-z_]+[0-9]*$/.test(mj)) {
      try {
        if (math.Unit.isValuelessUnit(mj)) res = math.unit(1, mj) as Unit;
      } catch { res = null; }
    }
  }
  cache.set(key, res);
  return res;
}

export function isUnitName(name: string): boolean {
  return lookupUnit(name) !== null;
}

/** Commonly used units for the unit picker. */
export const COMMON_UNITS: { group: string; units: string[] }[] = [
  { group: 'Länge', units: ['mm', 'cm', 'm', 'km', 'in', 'ft'] },
  { group: 'Fläche/Volumen', units: ['mm^2', 'cm^2', 'm^2', 'm^3', 'L'] },
  { group: 'Masse', units: ['g', 'kg', 't', 'lb'] },
  { group: 'Zeit', units: ['ms', 's', 'min', 'hr', 'day', 'yr'] },
  { group: 'Kraft', units: ['N', 'kN', 'MN', 'lbf', 'kip'] },
  { group: 'Druck/Spannung', units: ['Pa', 'kPa', 'MPa', 'GPa', 'bar', 'psi', 'ksi'] },
  { group: 'Energie/Leistung', units: ['J', 'kJ', 'kWh', 'W', 'kW', 'MW'] },
  { group: 'Elektrik', units: ['A', 'mA', 'V', 'kV', 'Ω', 'kΩ', 'F', 'μF', 'H', 'Hz'] },
  { group: 'Temperatur', units: ['K', '°C', '°F'] },
  { group: 'Winkel', units: ['rad', 'deg', 'rpm'] },
];

for (const t of [ANGLE_UNITS, SCALAR_UNITS, ALIASES]) Object.setPrototypeOf(t, null);

/** SI dimension vector of a unit expression such as "kN*m" or "mm^2" (undefined if unknown or dimensionless). */
export function unitDimensions(expr: string): number[] | undefined {
  const simple = lookupUnit(expr);
  if (simple !== null) return typeof simple === 'number' ? undefined : (simple as Unit).dimensions.slice();
  try {
    const s = expr.replace(/·/g, '*').replace(/[A-Za-zΩμµ°]+/g, n => ALIASES[n] ?? n.replace(/^[μµ]/, 'u'));
    const u = math.unit(s) as Unit;
    return u.dimensions.some(d => d !== 0) ? u.dimensions.slice() : undefined;
  } catch { return undefined; }
}

/** Composite units offered in the result unit picker in addition to COMMON_UNITS. */
export const EXTRA_DISPLAY_UNITS = [
  'N*m', 'kN*m', 'N*mm', 'kN/m', 'N/m', 'N/mm', 'N/mm^2', 'kN/m^2', 'kN/m^3', 'kg/m^3', 't/m^3', 'kg/m',
  'm/s', 'km/hr', 'mm/s', 'm/s^2', 'm^3/s', 'L/s', 'm^3/hr', 'cm^3', 'mm^3', 'cm^4', 'mm^4', 'm^4', 'dm^3',
  'W/(m*K)', 'W/(m^2*K)', 'J/(kg*K)', 'kJ/kg', 'Pa*s', 'mPa*s', 'N*s', 'kg*m^2', 'mm^2/s', 'm^2/s', 'C', 'Wh', 'MWh', 'kVA',
];
