import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { install, scan, fill } from '../src/fill/engine.js';
import { adapterFor, isChoiceLike, MARKETING_CONSENT, match, REQUIRED_CONSENT } from '../src/fill/core.js';
import { loadProfile, resolve } from '../src/profile/index.js';

const FIXTURE = '/home/gazerah/Documents/jobsearch/tools/fixtures-greenhouse.html';

test('scan + deterministic fill on the saved Greenhouse form (zero unverified fills, zero API calls)', async () => {
  if (!existsSync(FIXTURE)) {
    test.skip?.(`fixture not found: ${FIXTURE}`);
    return;
  }

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`file://${FIXTURE}`);
    await install(page);

    const scanned = await scan(page);
    assert.ok(scanned.fields.length > 0, 'scan should find fields');
    assert.equal(scanned.adapterId, 'greenhouse', 'adapter should be detected by DOM fingerprint');

    const values = resolve(loadProfile().kb, 'pt');
    const adapter = adapterFor(scanned.adapterId);

    let attempted = 0;
    let failed = 0;
    let skipped = 0;
    const unanswerable: { label: string; note: string }[] = [];

    for (const f of scanned.fields) {
      if (f.kind === 'file') { skipped++; continue; }
      if (isChoiceLike(f.kind) && (REQUIRED_CONSENT.test(f.label) || MARKETING_CONSENT.test(f.label))) { skipped++; continue; }

      let key = adapter.direct[f.name] || adapter.direct[f.uid] || null;
      if (key && adapter.isOpaqueId(f.uid)) key = null;
      if (!key) {
        const m = match(f.label);
        if (m) key = m.key;
      }
      const value = key ? values[key] : null;
      if (value == null || value === '') { skipped++; continue; }

      attempted++;
      const r = await fill(page, f.index, value);
      // Two different failures, and the distinction is the point of this test:
      //
      //   claimed ok but did not read back  -> a silent wrong answer, always a bug
      //   reported "no option resembling"   -> the fixture offers nothing for this
      //                                        answer; being told so is correct
      //
      // The city question is the second kind: this fixture lists a slice of Brazil's
      // municipalities and the candidate's city is not among them.
      if (r.ok && !r.verified) failed++;
      else if (!r.ok) unanswerable.push({ label: f.label, note: r.note || 'no reason given' });
    }

    assert.ok(attempted > 0, 'the deterministic pass should fill something');
    assert.equal(failed, 0, 'no fill may claim success without verifying read-back');
    for (const u of unanswerable) {
      assert.match(u.note, /no option resembling/, `unanswered field must say why: ${u.label}`);
    }
  } finally {
    await browser.close();
  }
});

// Greenhouse names every checkbox of a question `question_<id>[]`. Stripping the
// long id collapsed all questions into one group, so the filler matched a label
// that belongs to a DIFFERENT question, ticked the wrong box and reported success.
// The two questions below share no option text, so a merge is visible immediately.
test('two Greenhouse checkbox questions are scanned as separate groups', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <body><form>
        <fieldset id="q1"><legend>Como você conheceu a empresa? *</legend>
          <div><input type="checkbox" id="a1" name="question_111[]" value="1"><label for="a1">Redes sociais</label></div>
          <div><input type="checkbox" id="a2" name="question_111[]" value="2"><label for="a2">Indicação</label></div>
        </fieldset>
        <fieldset id="q2"><legend>Qual motivo te fez querer entrar? *</legend>
          <div><input type="checkbox" id="b1" name="question_222[]" value="1"><label for="b1">Autonomia</label></div>
          <div><input type="checkbox" id="b2" name="question_222[]" value="2"><label for="b2">Impacto social</label></div>
        </fieldset>
      </form></body>`);
    await install(page);
    const scanned = await scan(page);
    const q1 = scanned.fields.find((f) => /conheceu/i.test(f.label));
    const q2 = scanned.fields.find((f) => /motivo/i.test(f.label));
    assert.ok(q1 && q2, 'both questions should be scanned');
    assert.deepEqual(q1.options, ['Redes sociais', 'Indicação']);
    assert.deepEqual(q2.options, ['Autonomia', 'Impacto social']);

    // Filling question 2 must not touch question 1's boxes.
    const r = await fill(page, q2.index, 'Impacto social');
    assert.equal(r.verified, true);
    const checked = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input[type="checkbox"]'))
        .filter((i) => (i as HTMLInputElement).checked)
        .map((i) => i.getAttribute('name')),
    );
    assert.deepEqual(checked, ['question_222[]']);
  } finally {
    await browser.close();
  }
});
