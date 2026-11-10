import { useEffect, useState } from 'react';
import { clearRecent, listRecent, onRecentChange, relativeTime, removeRecent, type RecentInfo } from './recent';
import { app } from './actions';

export function useRecent(): RecentInfo[] {
  const [list, setList] = useState<RecentInfo[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => { listRecent().then(l => { if (alive) setList(l); }).catch(() => undefined); };
    load();
    const off = onRecentChange(load);
    return () => { alive = false; off(); };
  }, []);
  return list;
}

const KIND: Record<RecentInfo['kind'], string> = { fwk: 'FormelWerk', xmcd: 'Mathcad 15', mcdx: 'Mathcad Prime', other: 'Datei' };

/** Recently used documents (Datei menu, start page). */
export function RecentList({ onPick, max = 8, compact = false }: { onPick?: () => void; max?: number; compact?: boolean }) {
  const list = useRecent();
  if (!list.length) return compact ? <div className="recent-empty">Noch keine zuletzt verwendeten Dateien</div> : null;
  return (
    <div className={`recent${compact ? ' compact' : ''}`}>
      {!compact && <h3>Zuletzt verwendet</h3>}
      {list.slice(0, max).map(e => (
        <div key={e.key} className="recent-item">
          <button className="recent-open" title={e.hasFile ? 'Datei erneut öffnen' : 'Gespeicherten Stand öffnen'} onClick={() => { onPick?.(); app.openRecent(e.key); }}>
            <span className="recent-name">{e.name}</span>
            <span className="recent-meta">{KIND[e.kind]} · {relativeTime(e.when)}</span>
          </button>
          <button className="recent-del" title="Aus der Liste entfernen" aria-label={`${e.name} aus der Liste entfernen`} onClick={(ev) => { ev.stopPropagation(); void removeRecent(e.key); }}>×</button>
        </div>
      ))}
      {compact && <button className="recent-clear" onClick={() => { void clearRecent(); }}>Liste leeren</button>}
    </div>
  );
}
