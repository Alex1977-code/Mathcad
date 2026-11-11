import { useRef } from 'react';
import type { SliderRegion } from '../../engine/model';
import type { RegionResult } from '../../engine/worksheet';
import { nameLatex } from '../../engine/latex';
import { renderLatex } from '../katex';
import { store } from '../store';

interface Props { region: SliderRegion; result?: RegionResult; selected: boolean }

/** Decimals needed to show values of this step exactly (0.25 → 2). */
const decimalsOf = (step: number) => { const s = String(step); const e = /e-(\d+)$/.exec(s); return e ? +e[1] : (s.split('.')[1]?.length ?? 0); };

/** Slider: name := ────●──── value unit. Dragging recalculates the sheet; one undo step per drag. */
export function SliderRegionView({ region, result, selected }: Props) {
  /** A drag (or a series of key presses) is one undo step. */
  const dirty = useRef(false);
  const update = (patch: Partial<SliderRegion>) => {
    if (!dirty.current) { store.checkpoint(); dirty.current = true; }
    store.updateRegion(region.id, patch, false);
  };
  const begin = () => { dirty.current = false; };
  const dec = Math.min(10, decimalsOf(region.step));
  const clamp = (v: number) => Math.min(region.max, Math.max(region.min, v));
  const setValue = (v: number) => { if (Number.isFinite(v)) update({ value: +clamp(v).toFixed(Math.min(10, Math.max(dec, 6))) }); };
  const numField = (label: string, key: 'min' | 'max' | 'step', title: string) => (
    <label title={title}>{label}
      <input type="number" value={region[key]} step="any" onMouseDown={(e) => e.stopPropagation()} onFocus={begin} onKeyDown={(e) => e.stopPropagation()}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          if (!Number.isFinite(v)) return;
          if (key === 'step') { if (v > 0) update({ step: v }); return; }
          const min = key === 'min' ? v : region.min, max = key === 'max' ? v : region.max;
          if (min < max) update({ [key]: v, value: Math.min(max, Math.max(min, region.value)) });
        }} />
    </label>
  );
  const err = result?.error;
  return (
    <div className="sl-box" onKeyDown={(e) => { if (!(e.ctrlKey || e.metaKey)) e.stopPropagation(); }}>
      <div className="sl-main">
        <span className="sl-name" dangerouslySetInnerHTML={{ __html: renderLatex(`${nameLatex(region.name)} \\coloneqq`) }} />
        <input className="sl-range" type="range" aria-label={`Regler ${region.name}`} min={region.min} max={region.max} step={region.step} value={region.value}
          onMouseDown={(e) => { e.stopPropagation(); begin(); store.set({ selection: [region.id] }); }} onTouchStart={begin} onFocus={begin}
          onChange={(e) => setValue(parseFloat(e.target.value))} />
        <input className="sl-val" type="number" style={{ width: `${Math.max(3, String(region.value).length + 1.5)}ch` }} aria-label={`Wert von ${region.name}`} value={region.value} min={region.min} max={region.max} step={region.step}
          onMouseDown={(e) => e.stopPropagation()} onFocus={begin} onChange={(e) => setValue(parseFloat(e.target.value))} />
        {region.unit && <span className="sl-unit" dangerouslySetInnerHTML={{ __html: renderLatex(`\\mathrm{${region.unit.replace(/\*/g, '\\cdot ').replace(/[{}\\]/g, '')}}`) }} />}
      </div>
      {selected && (
        <div className="sl-settings" onMouseDown={(e) => e.stopPropagation()}>
          <label title="Name der Variablen">Name
            <input value={region.name} spellCheck={false} onFocus={begin} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => update({ name: e.target.value.replace(/\s+/g, '') })} />
          </label>
          {numField('von', 'min', 'Kleinster Wert')}
          {numField('bis', 'max', 'Größter Wert')}
          {numField('Schritt', 'step', 'Schrittweite')}
          <label title="Einheit, z. B. kN oder m/s">Einheit
            <input value={region.unit ?? ''} spellCheck={false} placeholder="–" onFocus={begin} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => update({ unit: e.target.value.trim() || undefined })} />
          </label>
        </div>
      )}
      {err && <div className="error-chip">{err.message}</div>}
    </div>
  );
}
