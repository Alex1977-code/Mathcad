/** Whitelist-based HTML sanitizer for text regions (documents may come from anywhere). */
const TAGS = new Set(['P', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'SUB', 'SUP', 'SPAN', 'H1', 'H2', 'H3', 'H4', 'UL', 'OL', 'LI', 'A', 'TABLE', 'TBODY', 'THEAD', 'TR', 'TD', 'TH', 'DIV', 'CODE', 'PRE', 'MARK', 'S', 'BLOCKQUOTE', 'FONT']);
const STYLE_PROPS = ['color', 'font-size', 'font-weight', 'font-style', 'text-align', 'text-decoration', 'background-color'];

export function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const root = doc.body.firstElementChild as HTMLElement;
  const clean = (el: Element) => {
    for (const child of Array.from(el.children)) {
      if (!TAGS.has(child.tagName)) {
        if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META'].includes(child.tagName)) { child.remove(); continue; }
        // unwrap unknown elements
        clean(child);
        child.replaceWith(...Array.from(child.childNodes));
        continue;
      }
      for (const attr of Array.from(child.attributes)) {
        const n = attr.name.toLowerCase();
        if (n === 'style') {
          const kept = STYLE_PROPS.map(p => {
            const v = (child as HTMLElement).style.getPropertyValue(p);
            return v && !/url\(|expression/i.test(v) ? `${p}:${v}` : '';
          }).filter(Boolean).join(';');
          if (kept) child.setAttribute('style', kept); else child.removeAttribute('style');
        } else if (n === 'href' && child.tagName === 'A') {
          if (!/^https?:\/\//i.test(attr.value)) child.removeAttribute('href');
          else { child.setAttribute('target', '_blank'); child.setAttribute('rel', 'noopener noreferrer'); }
        } else if (!(child.tagName === 'FONT' && n === 'color') && !['colspan', 'rowspan', 'target', 'rel'].includes(n)) {
          child.removeAttribute(attr.name);
        }
      }
      clean(child);
    }
  };
  clean(root);
  return root.innerHTML;
}

export function htmlToPlain(html: string): string {
  const d = new DOMParser().parseFromString(html, 'text/html');
  return d.body.textContent ?? '';
}
