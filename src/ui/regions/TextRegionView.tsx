import { useEffect, useMemo, useRef } from 'react';
import type { TextRegion } from '../../engine/model';
import { store } from '../store';
import { sanitizeHtml, htmlToPlain } from '../sanitize';

interface Props { region: TextRegion; editing: boolean; onCommit: (id: string, height: number) => void }

export function TextRegionView({ region, editing, onCommit }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const html = useRef(region.html);
  /** Text at edit start: Esc restores it (as Esc does for formulas). */
  const original = useRef(region.html);
  // sanitizing is expensive for large texts: only when the text changes
  const view = useMemo(() => (!htmlToPlain(region.html).trim() ? '<span class="math-placeholder">Text</span>' : sanitizeHtml(region.html)), [region.html]);

  useEffect(() => {
    const el = ref.current!;
    if (editing) {
      original.current = region.html;
      el.innerHTML = sanitizeHtml(region.html);
      html.current = el.innerHTML;
      el.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  }, [editing]);

  const finish = () => {
    if (store.get().editing !== region.id) return;
    const el = ref.current!;
    const clean = sanitizeHtml(el.innerHTML);
    if (clean !== region.html) store.updateRegion(region.id, { html: clean }, false);
    onCommit(region.id, el.getBoundingClientRect().height / store.get().zoom);
  };

  const cmd = (c: string, v?: string) => { document.execCommand(c, false, v); ref.current?.focus(); };

  if (!editing) {
    return <div className="text-view" style={{ width: region.w }} dangerouslySetInnerHTML={{ __html: view }} />;
  }
  return (
    <>
      <div className="text-toolbar" onMouseDown={(e) => e.preventDefault()}>
        <button title="Fett (Strg+B)" onClick={() => cmd('bold')}><b>B</b></button>
        <button title="Kursiv (Strg+I)" onClick={() => cmd('italic')}><i>I</i></button>
        <button title="Unterstrichen (Strg+U)" onClick={() => cmd('underline')}><u>U</u></button>
        <button title="Überschrift" onClick={() => cmd('formatBlock', 'h2')}>H</button>
        <button title="Absatz" onClick={() => cmd('formatBlock', 'p')}>¶</button>
        <button title="Tiefgestellt" onClick={() => cmd('subscript')}>x₂</button>
        <button title="Hochgestellt" onClick={() => cmd('superscript')}>x²</button>
        <button title="Aufzählung" onClick={() => cmd('insertUnorderedList')}>•</button>
        <button title="Hervorheben" onClick={() => cmd('foreColor', '#3b5bdb')}><span style={{ color: '#3b5bdb', fontWeight: 700 }}>A</span></button>
      </div>
      <div
        ref={ref}
        className="text-view"
        contentEditable
        suppressContentEditableWarning
        style={{ width: region.w, minHeight: 22 }}
        onMouseDown={(e) => e.stopPropagation()}
        onInput={(e) => { html.current = (e.target as HTMLDivElement).innerHTML; store.updateRegion(region.id, { html: html.current }, false); }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            ref.current!.innerHTML = sanitizeHtml(original.current);
            store.updateRegion(region.id, { html: original.current }, false);
            finish();
          }
          e.stopPropagation();
        }}
        onBlur={() => setTimeout(() => { if (!ref.current?.contains(document.activeElement)) finish(); }, 120)}
      />
    </>
  );
}
