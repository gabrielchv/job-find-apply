// Greenhouse answers the submit click with an e-mailed one-time code instead of
// accepting the application. Nothing here can read the candidate's inbox, and the
// form underneath stops advancing — so the run used to end on "submit button
// disabled", which reads like the tool broke, while a code was waiting in their mail.
// The gate is now detected and reported as the human step it is.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser } from 'playwright';
import { completeWithMailedCode, doSubmit, enterVerificationCode, waitForHumanVerification } from '../src/apply/driver.js';
import { Mailer } from '../src/mail/index.js';
import { install } from '../src/fill/engine.js';

let browser: Browser;

test.before(async () => {
  browser = await chromium.launch();
});

test.after(async () => {
  await browser?.close();
});

test('an e-mailed verification gate is reported, not retried into oblivion', async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <body>
      <form>
        <input id="q" value="filled">
        <button type="button" id="go">Enviar inscrição</button>
      </form>
      <script>
        document.getElementById('go').addEventListener('click', () => {
          const form = document.querySelector('form');
          form.innerHTML =
            '<p>Um código de verificação foi enviado para gabriel@example.com. ' +
            'Para enviar sua inscrição, digite o código de 8 caracteres para confirmar que você é uma pessoa.</p>' +
            '<label>Código de segurança</label><input maxlength="8">' +
            '<button type="button" id="go2">Enviar inscrição</button>';
        });
      </script>
    </body>`);
  await install(page);

  const outcome = await doSubmit(page);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.verificationEmail, 'gabriel@example.com');
  assert.match(outcome.reason, /verification code/i);
  await page.close();
});

test('a plain dead submit button is still reported as such', async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <body><form><input id="q"><button type="button" disabled>Enviar inscrição</button></form></body>`);
  await install(page);
  const outcome = await doSubmit(page);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.verificationEmail, undefined);
  assert.match(outcome.reason, /disabled/);
  await page.close();
});

// The `--hold` path: the filled page is parked in front of the candidate, who types
// the mailed code. The wait must end as soon as the application goes through, not
// after the whole timeout.
test('holding for the code ends the moment the page confirms', async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <body>
      <p>Um código de verificação foi enviado para gabriel@example.com.</p>
      <input id="code">
      <button type="button" id="send">Enviar inscrição</button>
    </body>`);
  // Stand in for the candidate: enter the code a moment later.
  setTimeout(async () => {
    await page.evaluate(() => {
      document.body.innerHTML = '<h1>Candidatura enviada com sucesso!</h1>';
    });
  }, 4000);

  const started = Date.now();
  const confirmed = await waitForHumanVerification(page, 120_000);
  const elapsed = Date.now() - started;
  assert.equal(confirmed, true, 'should observe the confirmation');
  assert.ok(elapsed < 30_000, `should not wait out the full timeout (waited ${elapsed}ms)`);
  await page.close();
});

test('holding stops when the candidate closes the window', async () => {
  const page = await browser.newPage();
  await page.setContent('<body><p>Um código de verificação foi enviado.</p></body>');
  setTimeout(() => page.close().catch(() => {}), 4000);
  const confirmed = await waitForHumanVerification(page, 120_000);
  assert.equal(confirmed, false);
});

// Typing the mailed code into the field the board just revealed. The field only exists
// after the first submit click, so it must be found by its label, and the write must be
// read back — an unverified write spends a verification attempt on an empty box.
test('types the code into the revealed security-code field', async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <body>
      <p>Um código de verificação foi enviado para gabriel@example.com.</p>
      <div class="field">
        <label for="sec">Código de segurança</label>
        <input id="sec" type="text" maxlength="8">
      </div>
      <button type="button">Enviar inscrição</button>
    </body>`);
  await install(page);

  const ok = await enterVerificationCode(page, 'K7M2QP4X');
  assert.equal(ok, true);
  assert.equal(await page.locator('#sec').inputValue(), 'K7M2QP4X');
  await page.close();
});

test('reports failure rather than pretending when there is no code field', async () => {
  const page = await browser.newPage();
  await page.setContent('<body><h1>Candidatura enviada</h1><a href="#">voltar</a></body>');
  await install(page);
  const ok = await enterVerificationCode(page, 'K7M2QP4X');
  assert.equal(ok, false);
  await page.close();
});

test('finds an unlabelled short code box by its maxlength', async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <body><form><input id="c" type="text" maxlength="6" placeholder="000000"></form></body>`);
  await install(page);
  const ok = await enterVerificationCode(page, '604821');
  assert.equal(ok, true);
  assert.equal(await page.locator('#c').inputValue(), '604821');
  await page.close();
});

// The whole recovery, against a page that behaves like Greenhouse's gate and an inbox
// that hands over the code on the second poll. This is the path that replaces the human
// step, so it is worth testing end to end rather than by inspection.
// The mailbox has to look usable (a 16-character app password) or the code wait gives
// up before polling — which is the correct behaviour, just not what these tests exercise.
process.env.MAIL_FAKE_APP_PASSWORD = 'abcdefghijklmnop';

function fakeMailer(script: { items: any[]; error?: string }[]): { mailer: Mailer; calls: () => number } {
  const mailer = new Mailer([
    { name: 'tech', address: 'gabriel.chaves.tech@gmail.com', backend: 'imap', secretEnv: 'MAIL_FAKE_APP_PASSWORD' },
  ]);
  let n = 0;
  (mailer as unknown as { recent: unknown }).recent = async () => {
    const step = script[Math.min(n, script.length - 1)];
    n++;
    return { items: step.items, errors: step.error ? [{ account: 'tech', error: step.error }] : [] };
  };
  return { mailer, calls: () => n };
}

const codeMail = (code: string) => ({
  id: '1',
  account: 'tech',
  mailbox: 'gabriel.chaves.tech@gmail.com',
  from: 'iFood <no-reply@us.greenhouse-mail.io>',
  to: 'gabriel.chaves.tech@gmail.com',
  subject: 'Seu código de verificação',
  date: new Date().toISOString(),
  snippet: 'digite o código de 8 caracteres para confirmar que você é uma pessoa. ' + code,
});

test('waits, reads the mailed code, types it, and confirms the submission', async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <body>
      <p>Um código de verificação foi enviado.</p>
      <label for="sec">Código de segurança</label>
      <input id="sec" type="text" maxlength="8">
      <button type="button" id="go">Enviar inscrição</button>
      <script>
        document.getElementById('go').addEventListener('click', () => {
          // Only the *right* code completes the application, like the real board.
          if (document.getElementById('sec').value === 'K7M2QP4X') {
            document.body.innerHTML = '<h1>Candidatura enviada com sucesso!</h1>';
          }
        });
      </script>
    </body>`);
  await install(page);

  const { mailer } = fakeMailer([{ items: [] }, { items: [codeMail('K7M2QP4X')] }]);
  const result = await completeWithMailedCode(page, mailer, {
    to: 'gabriel.chaves.tech@gmail.com',
    since: new Date(Date.now() - 60_000),
  });

  assert.equal(result.ok, true, `expected success, got: ${result.reason}`);
  assert.equal(result.code?.code, 'K7M2QP4X');
  assert.equal(result.mailbox, 'gabriel.chaves.tech@gmail.com');
  assert.equal(await page.locator('h1').textContent(), 'Candidatura enviada com sucesso!');
  await page.close();
});

test('a wrong code does not get reported as a submission', async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <body>
      <label for="sec">Código de segurança</label>
      <input id="sec" type="text" maxlength="8">
      <button type="button" id="go">Enviar inscrição</button>
      <script>
        // A rejected code: the board keeps the form and shows nothing new.
        document.getElementById('go').addEventListener('click', () => {});
      </script>
    </body>`);
  await install(page);

  const { mailer } = fakeMailer([{ items: [codeMail('WRONG999')] }]);
  const result = await completeWithMailedCode(page, mailer, {
    to: '',
    since: new Date(Date.now() - 60_000),
    timeoutMs: 300,
    pollMs: 100,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason || '', /did not confirm/);
  await page.close();
});

test('no mail at all is a failure with no error attached', async () => {
  const page = await browser.newPage();
  await page.setContent('<body><label for="s">Código</label><input id="s" maxlength="8"></body>');
  await install(page);
  const { mailer } = fakeMailer([{ items: [] }]);
  const result = await completeWithMailedCode(page, mailer, { to: '', since: new Date(), timeoutMs: 300, pollMs: 100 });
  assert.equal(result.ok, false);
  assert.equal(result.code, undefined);
  assert.deepEqual(result.errors, []);
  await page.close();
});
