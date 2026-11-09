import katex from 'katex';

const cache = new Map<string, string>();

export function renderLatex(latex: string, display = false): string {
  const key = (display ? 'D' : 'I') + latex;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let html: string;
  try {
    html = katex.renderToString(latex, {
      throwOnError: false,
      displayMode: display,
      strict: false,
      trust: (ctx) => ctx.command === '\\htmlClass',
      output: 'html',
    });
  } catch {
    html = `<span class="fw-latex-error">${latex.replace(/</g, '&lt;')}</span>`;
  }
  if (cache.size > 4000) cache.clear();
  cache.set(key, html);
  return html;
}
