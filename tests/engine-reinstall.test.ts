// The in-page engine lives on window.__jfa. Gupy's wizard does a REAL page load
// when a draft's step is entered, which silently discarded it — every later call
// then failed with "Cannot read properties of undefined (reading 'dismissOverlay')"
// and the application was reported as failed for a reason that was our own bug.
// The wrappers now re-install on demand; this test walks that exact sequence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser } from 'playwright';
import { install, scan, dismissOverlay } from '../src/fill/engine.js';

let browser: Browser;

test.before(async () => {
  browser = await chromium.launch();
});

test.after(async () => {
  await browser?.close();
});

function fixture(name: string, html: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'jfa-engine-'));
  const file = path.join(dir, `${name}.html`);
  writeFileSync(file, html);
  return `file://${file}`;
}

const FORM = `<!doctype html><html><body><form>
  <label for="name">Nome completo *</label><input id="name" name="name">
  <button type="button">Salvar e continuar</button>
</form></body></html>`;

test('scan and dismissOverlay still work after a real navigation wipes the engine', async () => {
  const page = await browser.newPage();
  const first = fixture('first', '<!doctype html><html><body><p>application page</p></body></html>');
  const second = fixture('second', FORM);

  await page.goto(first);
  await install(page);
  assert.equal(await page.evaluate(() => Boolean((globalThis as unknown as { __jfa?: unknown }).__jfa)), true);

  // The wizard step; window.__jfa is gone the moment this commits.
  await page.goto(second);
  assert.equal(await page.evaluate(() => Boolean((globalThis as unknown as { __jfa?: unknown }).__jfa)), false);

  const scanned = await scan(page);
  assert.ok(scanned.fields.length >= 1, 'the engine should have re-installed itself and scanned the form');
  assert.match(scanned.fields[0].label, /^Nome completo/);

  await dismissOverlay(page); // must not throw
  await page.close();
});
