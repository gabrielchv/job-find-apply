// Regression tests for the Gupy multi-step submit path.
//
// Context: 144 of 147 failed applications all read "submit did not confirm".
// Root cause was that Gupy's wizard advances with "Salvar e continuar", which
// matches NEXT_TEXT but not SUBMIT_TEXT, so doSubmit found no submit button and
// gave up while the application was still mid-wizard. These tests drive a real
// Chromium page through a wizard that only ever offers "Salvar e continuar".

import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser } from 'playwright';
import { doSubmit } from '../src/apply/driver.js';
import { install } from '../src/fill/engine.js';

let browser: Browser;

test.before(async () => {
  browser = await chromium.launch();
});

test.after(async () => {
  await browser?.close();
});

const pageWith = async (html: string) => {
  const page = await browser.newPage();
  await page.setContent(html);
  // The drivers call through to the in-page engine (dismissOverlay, etc.), which
  // the real fill path installs before touching a form. Do the same here.
  await install(page);
  return page;
};

test('walks a wizard that only offers "Salvar e continuar"', async () => {
  const page = await pageWith(`
    <body>
      <form>
        <textarea id="q1"></textarea>
        <button type="button" id="s1">Salvar e continuar</button>
      </form>
      <script>
        document.getElementById('s1').addEventListener('click', () => {
          document.body.innerHTML =
            '<form><input id="q2"><button type="button" id="s2">Salvar e continuar</button></form>';
          document.getElementById('s2').addEventListener('click', () => {
            document.body.innerHTML = '<h1>Candidatura finalizada!</h1>';
          });
        });
      </script>
    </body>`);

  const outcome = await doSubmit(page);
  assert.equal(outcome.ok, true, `expected confirmation, got: ${outcome.reason}`);
  await page.close();
});

test('clicks a real terminal submit button', async () => {
  const page = await pageWith(`
    <body>
      <form>
        <input id="q">
        <button type="button" id="go">Enviar candidatura</button>
      </form>
      <script>
        document.getElementById('go').addEventListener('click', () => {
          document.body.innerHTML = '<p>Candidatura enviada com sucesso</p>';
        });
      </script>
    </body>`);

  const outcome = await doSubmit(page);
  assert.equal(outcome.ok, true, `expected confirmation, got: ${outcome.reason}`);
  await page.close();
});

test('stops instead of clicking forever when the page does not advance', async () => {
  // A required answer that did not stick: the click does nothing. The old code
  // reported a bare failure; the new one must stop and say why.
  const page = await pageWith(`
    <body>
      <form>
        <input id="q" placeholder="obrigatório">
        <button type="button">Salvar e continuar</button>
      </form>
    </body>`);

  const outcome = await doSubmit(page);
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason, /did not advance/);
  await page.close();
});

test('reports no button rather than pretending to submit', async () => {
  const page = await pageWith('<body><form><input id="q"></form></body>');

  const outcome = await doSubmit(page);
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason, /no submit or advance button/);
  await page.close();
});
