/**
 * End-to-end test in a real browser (Playwright + Chromium).
 *   npm run build && npm run e2e
 * Screenshots are written to e2e/out/.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'e2e', 'out');
mkdirSync(out, { recursive: true });
const PORT = 4179;
const URL_ = `http://localhost:${PORT}/`;

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✓' : '✗'} ${msg}`); if (!cond) failures++; };

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: root, stdio: 'pipe' });
await new Promise((res) => {
  const t = setInterval(async () => { try { const r = await fetch(URL_); if (r.ok) { clearInterval(t); res(); } } catch { /* wait */ } }, 200);
});

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.addInitScript(() => { delete window.showSaveFilePicker; });
page.on('dialog', (d) => d.accept().catch(() => undefined));

const shot = (name) => page.screenshot({ path: join(out, name) });
const idle = async () => { await page.waitForSelector('.dot.ok, .dot.err, .dot.warn', { timeout: 60000 }); await page.waitForTimeout(150); };
const lastRegionText = () => page.locator('.region.math-region').last().innerText();

try {
  /* 1 · start with the example */
  await page.goto(URL_);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector('.region.math-region');
  await idle();
  ok((await page.locator('.region.math-region').count()) > 20, 'Beispiel-Arbeitsblatt wird geladen');
  ok(await page.locator('.pill.ok', { hasText: 'Keine Fehler' }).isVisible(), 'Beispiel rechnet ohne Fehler');
  const body = await page.locator('.page').innerText();
  ok(/97\.703/.test(body) && /18\.319/.test(body), 'Ergebnisse M_Ed = 97.703 kN·m und σ = 18.319 MPa angezeigt');
  ok((await page.locator('.plot-svg path').count()) > 0, 'Diagramm des Momentenverlaufs gezeichnet');
  await shot('01-beispiel.png');

  /* 2 · new worksheet, click & type */
  await page.click('text=Datei');
  await page.click('.menu >> text=Neu');
  await page.waitForSelector('.welcome');
  await page.mouse.click(420, 230);
  await page.keyboard.type('a:5 m');
  await page.keyboard.press('Enter');
  await page.keyboard.type('b:300 mm');
  await page.keyboard.press('Enter');
  await page.keyboard.type('a*b=');
  await page.keyboard.press('Enter');
  await idle();
  ok(/1\.5\s*m\s*2/.test((await lastRegionText()).replace(/\n/g, ' ')), 'Doppelpunkt wird zu := und a·b = 1.5 m² wird berechnet');
  await page.waitForTimeout(900);
  const srcs = await page.evaluate(() => JSON.parse(localStorage.getItem('formelwerk.autosave.v1') ?? '{"regions":[]}').regions.map((r) => r.src));
  ok(srcs.includes('a := 5 m') && srcs.includes('a*b='), `Autosave speichert das Dokument im Browser (${JSON.stringify(srcs)})`);

  /* 3 · display unit, function, error */
  await page.keyboard.type('a*b=cm^2');
  await page.keyboard.press('Enter');
  await idle();
  ok((await lastRegionText()).includes('15000'), 'Umrechnung in Wunscheinheit (15000 cm²)');
  await page.keyboard.type('f(x):x^2+1');
  await page.keyboard.press('Enter');
  await page.keyboard.type('f(3)=');
  await page.keyboard.press('Enter');
  await idle();
  ok((await lastRegionText()).includes('10'), 'Funktion f(3) = 10');
  await page.keyboard.type('c+1=');
  await page.keyboard.press('Enter');
  await idle();
  ok((await page.locator('.region.error').count()) === 1, 'Undefinierte Variable wird als Fehler markiert');
  await page.locator('.region.error').hover();
  ok(((await page.locator('.error-chip').textContent()) ?? '').includes('„c“ ist nicht definiert'), 'Fehlermeldung „c ist nicht definiert“');
  await shot('02-eingabe-fehler.png');

  /* 4 · undo / redo */
  const before = await page.locator('.region').count();
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(150);
  ok((await page.locator('.region').count()) === before - 1, 'Rückgängig entfernt den letzten Bereich');
  await page.keyboard.press('Control+y');
  await page.waitForTimeout(150);
  ok((await page.locator('.region').count()) === before, 'Wiederholen stellt ihn wieder her');

  /* 5 · autocomplete and Greek letters */
  await page.mouse.click(420, 560);
  await page.keyboard.type('\\alpha ');
  await page.keyboard.type(':2');
  ok((await page.locator('textarea').inputValue()).startsWith('α := 2'), '\\alpha + Leertaste wird zu α');
  await page.keyboard.press('Enter');
  await page.keyboard.type('sq');
  await page.waitForTimeout(150);
  ok(await page.locator('.ac', { hasText: 'sqrt' }).isVisible(), 'Autovervollständigung schlägt sqrt vor');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  /* 6 · program (multi-line) */
  await page.mouse.click(420, 640);
  await page.keyboard.type('g(x):');
  await page.keyboard.press('Enter');
  await page.keyboard.type('if x < 0');
  await page.keyboard.press('Enter');
  await page.keyboard.type('-x');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('else');
  await page.keyboard.press('Enter');
  await page.keyboard.type('x');
  await page.keyboard.press('Control+Enter');
  await page.keyboard.type('g(-4)+g(2)=');
  await page.keyboard.press('Enter');
  await idle();
  ok((await lastRegionText()).includes('6'), 'Mehrzeiliges Programm (if/else) liefert g(−4)+g(2) = 6');
  await shot('03-programm.png');

  /* 7 · plot */
  await page.mouse.click(420, 760);
  await page.click('.rbody .rbig:has-text("Diagramm")');
  await page.waitForSelector('.side >> text=Diagramm bearbeiten');
  await page.fill('.trace-card input[placeholder="z. B. sin(x)"]', 'sin(x)*a/m');
  await page.fill('input[placeholder="auto"] >> nth=0', '0');
  await page.fill('input[placeholder="auto"] >> nth=1', '2*π');
  await idle();
  await page.waitForTimeout(300);
  ok((await page.locator('.plot-svg path').count()) > 0, 'Diagramm aus Ausdruck sin(x)·a/m gezeichnet');
  await shot('04-diagramm.png');
  await page.click('.side button[title="Schließen"]');

  /* 8 · save as .fwk and reopen */
  const dl = page.waitForEvent('download');
  await page.keyboard.press('Control+s');
  const download = await dl;
  const saved = join(out, 'gespeichert.fwk');
  await download.saveAs(saved);
  const savedWs = JSON.parse(readFileSync(saved, 'utf8'));
  ok(savedWs.format === 'formelwerk' && savedWs.regions.length >= 8, `Speichern als .fwk (${savedWs.regions.length} Bereiche)`);
  const fc1 = page.waitForEvent('filechooser');
  await page.keyboard.press('Control+o');
  await (await fc1).setFiles(saved);
  await idle();
  ok((await page.locator('.region').count()) === savedWs.regions.length, 'Gespeicherte Datei wird wieder geöffnet');

  /* 9 · import Mathcad 15 (.xmcd) */
  const fc2 = page.waitForEvent('filechooser');
  await page.click('.topbar >> text=Importieren');
  await (await fc2).setFiles(join(root, 'tests/fixtures/mathcad/beispiel_mathcad15.xmcd'));
  await page.waitForSelector('.dialog');
  await idle();
  await page.waitForTimeout(300);
  ok((await page.locator('.dialog .stat').nth(2).innerText()).includes('7/7'), 'xmcd-Import: 7/7 Ergebnisse wie in Mathcad');
  await shot('05-import-xmcd-bericht.png');
  await page.click('.dialog >> text=Weiter');
  await shot('06-import-xmcd.png');

  /* 10 · import Mathcad Prime (.mcdx) */
  for (const [file, expect] of [['RC_torsion.mcdx', '16/16'], ['trig.mcdx', '19/19']]) {
      const fc = page.waitForEvent('filechooser');
    await page.click('.topbar >> text=Importieren');
    await (await fc).setFiles(join(root, 'tests/fixtures/mathcad/prime', file));
    await page.waitForSelector('.dialog');
    await idle();
    await page.waitForTimeout(400);
    const stat = await page.locator('.dialog .stat').nth(2).innerText();
    ok(stat.includes(expect), `mcdx-Import ${file}: ${expect} Ergebnisse wie in Mathcad (angezeigt: ${stat.split('\n')[0]})`);
    if (file === 'RC_torsion.mcdx') await shot('07-import-mcdx-bericht.png');
    await page.click('.dialog >> text=Weiter');
    await page.waitForTimeout(400);
    if (file === 'RC_torsion.mcdx') await shot('08-import-mcdx.png');
  }
  ok((await page.locator('.check-badge.ok').count()) > 5, 'Bereiche tragen ✓-Markierungen des Mathcad-Abgleichs');

  /* 11 · dark mode */
  await page.click('button[title="Dunkles Design"]');
  await page.waitForTimeout(200);
  ok((await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark', 'Dunkles Design aktivierbar');
  await shot('09-dunkel.png');

  /* 12 · professional GUI: palette, context menu, manual calculation, panels */
  await page.click('button[title="Helles Design"]');
  page.on('dialog', (d) => d.accept().catch(() => undefined));
  await page.click('.rtab.file');
  await page.click('.menu >> text=Beispiel öffnen');
  await idle();
  ok((await page.locator('.rtab').count()) >= 5, 'Menüband mit Registerkarten');
  await page.keyboard.press('Control+k');
  await page.keyboard.type('dezimalkomma');
  await page.keyboard.press('Enter');
  await idle();
  ok((await page.locator('.page').innerText()).includes('97,703'), 'Befehlspalette (Strg+K) schaltet auf Dezimalkomma: 97,703 kN·m');
  const n0 = await page.locator('.region').count();
  await page.locator('.region.math-region').nth(2).click({ button: 'right' });
  await page.click('.ctxmenu >> text=Duplizieren');
  ok((await page.locator('.region').count()) === n0 + 1, 'Kontextmenü (Rechtsklick) → Duplizieren');
  await page.keyboard.press('Control+z');
  await page.click('.status-item.calc-mode');
  ok((await page.locator('.calc-mode').innerText()).includes('Manuell'), 'Manuelle Berechnung einschaltbar');
  await page.locator('.region.math-region', { hasText: 'L' }).first().click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('L:7 m');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  ok((await page.locator('.calc-status').innerText()).includes('Nicht aktuell'), 'Im manuellen Modus wird „Nicht aktuell“ angezeigt');
  await page.keyboard.press('F9');
  await idle();
  ok((await page.locator('.page').innerText()).includes('113,313'), 'F9 berechnet neu: M_Ed = 113,313 kN·m für L = 7 m');
  await page.click('.status-item.calc-mode');
  await page.click('.side-tabs button:has-text("Gliederung")');
  ok((await page.locator('.outline button').count()) >= 5, 'Gliederung listet die Überschriften');
  await page.mouse.click(420, 700);
  await page.keyboard.type('nix + 1 =');
  await page.keyboard.press('Enter');
  await idle();
  await page.click('.side-tabs button:has-text("Probleme")');
  ok((await page.locator('.problem.err').count()) === 1, 'Probleme-Liste zeigt den Fehler');
  await shot('10-probleme.png');
  await page.click('.rtab:has-text("Mathematik")');
  await shot('11-menueband-mathematik.png');
  await page.click('.rtab:has-text("Start")');

  /* 12b · few clicks: unit picker on the result, smart context menu (plot a function, solve an equation) */
  await page.click('text=Datei');
  await page.click('.menu >> text=Neu');
  await page.waitForSelector('.welcome');
  await page.mouse.click(420, 230);
  for (const t of ['F:12 kN', 'a:2 m', 'F*a=', 'f(x):x^2-2', 'a*y+1==10']) { await page.keyboard.type(t); await page.keyboard.press('Enter'); }
  await idle();
  await page.locator('.fw-result').first().click();
  await page.waitForSelector('.unit-picker');
  await shot('12-einheit-waehlen.png');
  await page.locator('.unit-picker .up-units button', { hasText: /^kN·m$/ }).click();
  await idle();
  ok(/24\s*kN/.test(await page.locator('.fw-result').first().innerText()), 'Klick aufs Ergebnis: Einheit kN·m gewählt (24 kN·m)');
  await page.locator('.region.math-region', { hasText: 'x' }).last().click({ button: 'right' });
  await page.locator('.ctxmenu button', { hasText: 'Diagramm von f(x)' }).click();
  await idle();
  ok((await page.locator('.plot-region .plot-svg path').count()) > 0, 'Kontextmenü: Diagramm von f(x) mit einem Klick');
  await page.locator('.region.math-region').last().click({ button: 'right' });
  await page.locator('.ctxmenu button', { hasText: 'Gleichung nach y lösen' }).click();
  await idle();
  ok(/4\.5/.test(await lastRegionText()) && (await page.locator('.region.error').count()) === 0, 'Kontextmenü: Gleichung a·y + 1 = 10 gelöst, Startwert mit passender Einheit (y = 4.5 1/m)');
  await shot('13-diagramm-loesen.png');
  // symbolic evaluation: "->" becomes →, keywords after the arrow
  await page.mouse.click(700, 260);
  for (const t of ['x^2+2*x*x->', '(x+1)^2-> expand', 'p*z+q==0-> solve, z']) { await page.keyboard.type(t); await page.keyboard.press('Enter'); }
  await page.waitForTimeout(400); await idle(); await page.waitForFunction(() => !document.querySelector('.region.pending'));
  const symTexts = await page.locator('.region.math-region').evaluateAll(els => els.slice(-3).map(e => e.innerText.replace(/\s+/g, '')));
  ok(/3[·⋅]?x2$/.test(symTexts[0]) && /x2\+2[·⋅]?x\+1$/.test(symTexts[1]) && /−?−pq|−qp/.test(symTexts[2]) && (await page.locator('.region.error').count()) === 0,
    `Symbolisch: x²+2x·x → 3x², (x+1)² → expand, p·z+q=0 → solve (${JSON.stringify(symTexts)})`);
  for (const t of ['int(x*exp(x),x)->', '[x+y==10;x-y==2]-> solve, x, y', 'x^2-5*x+6-> factor', 'exp(x)-> series, x = 0, 4']) { await page.keyboard.type(t); await page.keyboard.press('Enter'); }
  await page.waitForTimeout(400); await idle(); await page.waitForFunction(() => !document.querySelector('.region.pending'));
  const sym2 = await page.locator('.region.math-region').evaluateAll(els => els.slice(-4).map(e => e.innerText.replace(/\s+/g, '')));
  ok(/→ex[·⋅]\(x−1\)$/.test(sym2[0]) && /solve,x,y.*6.*4/.test(sym2[1]) && /\(x−2\)[·⋅]?\(x−3\)/.test(sym2[2]) && /1\+x\+/.test(sym2[3]) && (await page.locator('.region.error').count()) === 0,
    `Symbolisch: Integral, Gleichungssystem, factor, series (${JSON.stringify(sym2)})`);
  for (const t of ['sum(i^2,i,1,n)->', 'lim(sin(x)/x,x,0)->', '(x^3+1)/(x^2-3*x+2)-> parfrac']) { await page.keyboard.type(t); await page.keyboard.press('Enter'); }
  await page.waitForTimeout(400); await idle(); await page.waitForFunction(() => !document.querySelector('.region.pending'));
  const sym3 = await page.locator('.region.math-region').evaluateAll(els => els.slice(-3).map(e => e.innerText.replace(/\s+/g, '')));
  ok(/n[·⋅]\(n\+1\)[·⋅]\(2[·⋅]n\+1\)/.test(sym3[0]) && /→1$/.test(sym3[1]) && /x\+3−/.test(sym3[2]) && (await page.locator('.region.error').count()) === 0,
    `Symbolisch: Summe, Grenzwert, Partialbrüche (${JSON.stringify(sym3)})`);
  await shot('14-symbolisch.png');

  /* 12c · Word export, "Speichern unter" with a file type, clipboard, print layout */
  {
    const JSZip = require('jszip');
    const dlw = page.waitForEvent('download');
    await page.keyboard.press('Control+k'); await page.waitForTimeout(150); await page.keyboard.type('Word-Dokument'); await page.keyboard.press('Enter');
    const zipW = await JSZip.loadAsync(readFileSync(await (await dlw).path()));
    const docXml = await zipW.file('word/document.xml').async('string');
    const eqs = (docXml.match(/<m:oMath>/g) ?? []).length;
    ok(eqs >= 10 && Object.keys(zipW.files).some(f => f.startsWith('word/media/')) && /NUMPAGES/.test(await zipW.file('word/footer1.xml').async('string')),
      `Word-Export: ${eqs} echte Formeln (OMML), Diagramm als Bild, Fußzeile mit Seitenzahl`);
    // "Speichern unter" without a file dialog: asks for the name, the extension picks the format
    page.removeAllListeners('dialog');
    page.once('dialog', (d) => d.accept('Bericht.docx').catch(() => undefined));
    const dls = page.waitForEvent('download');
    await page.keyboard.press('Control+Shift+s');
    const sZip = await JSZip.loadAsync(readFileSync(await (await dls).path()));
    page.on('dialog', (d) => d.accept().catch(() => undefined));
    ok(!!sZip.file('word/document.xml'), 'Speichern unter: Dateiname „Bericht.docx“ erzeugt ein Word-Dokument');
    // clipboard: text from another program becomes formulas and text
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.evaluate(() => navigator.clipboard.writeText('Nachweis der Durchbiegung\nw := 3 mm\nw*2 ='));
    const pgb = await page.locator('.page').boundingBox();
    await page.evaluate(() => { document.querySelector('.scroller').scrollTop = 0; });
    await page.mouse.click(pgb.x + 560, pgb.y + 700);
    const before = await page.locator('.region').count();
    await page.keyboard.press('Control+v');
    await idle();
    const after = await page.locator('.region').count(), lastTxt = await lastRegionText();
    ok(after === before + 3 && /0\.006\s*m/.test(lastTxt),
      `Einfügen aus anderen Programmen: Text- und Formelzeilen werden Text- und Formelbereiche (w·2 = 0.006 m; ${before}→${after}, ${JSON.stringify(lastTxt)})`);
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Control+c');
    const html = await page.evaluate(async () => { const it = await navigator.clipboard.read(); return (await (await it[0].getType('text/html')).text()); });
    ok(/msEquation/.test(html) && /<m:oMath>/.test(html), 'Kopieren: Formeln als Word-Gleichungen (OMML) in der Zwischenablage');
    await page.keyboard.press('Escape');
    // print: footers with page numbers, light colours
    await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
    const pr = await page.evaluate(() => ({ n: document.querySelectorAll('.print-footer').length, t: document.querySelector('.print-footer')?.textContent, theme: document.documentElement.dataset.theme }));
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
    ok(pr.n >= 1 && /Seite 1 von/.test(pr.t ?? '') && pr.theme === 'light' && (await page.locator('.print-footer').count()) === 0, `Drucken: Fußzeile „${pr.t}“, helles Farbschema, danach wiederhergestellt`);
  }

  /* 13 · responsiveness on a large imported sheet: an edit at the end is recalculated incrementally */
  {
    const fc = page.waitForEvent('filechooser');
    await page.click('.topbar >> text=Importieren');
    await (await fc).setFiles(join(root, 'tests/fixtures/mathcad/prime/RC_col.mcdx'));
    await page.waitForSelector('.dialog');
    await idle();
    await page.click('.dialog >> text=Weiter');
    await page.waitForTimeout(500);
    await idle();
    await page.evaluate(() => { const s = document.querySelector('.scroller'); s.scrollTop = s.scrollHeight; });
    await page.waitForTimeout(300);
    const last = page.locator('.region.math-region').last();
    await last.click();
    await page.keyboard.press('End');
    const t0 = Date.now();
    await page.keyboard.type(' ');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.dot.ok', { timeout: 30000 });
    const dt = Date.now() - t0;
    ok(dt < 1500, `Änderung am Ende eines großen Blatts (RC_col, 280 Bereiche) ist nach ${dt} ms berechnet`);
  }

  /* 14 · legacy .mcd gives a helpful message */
  const fc3 = page.waitForEvent('filechooser');
  await page.click('.topbar >> text=Importieren');
  await (await fc3).setFiles({ name: 'alt.mcd', mimeType: 'application/octet-stream', buffer: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3]) });
  await page.waitForSelector('.toast.err');
  ok((await page.locator('.toast.err').innerText()).includes('.xmcd'), 'Altes .mcd-Format: verständlicher Hinweis auf .xmcd');

  ok(errors.length === 0, `Keine JavaScript-Fehler im Browser${errors.length ? ': ' + errors.join(' | ') : ''}`);
} catch (e) {
  failures++;
  console.error('✗ Abbruch:', e);
  await shot('fehler.png').catch(() => undefined);
} finally {
  await browser.close();
  server.kill();
}
console.log(failures ? `\n${failures} Prüfung(en) fehlgeschlagen` : '\nAlle E2E-Prüfungen bestanden');
process.exit(failures ? 1 : 0);
