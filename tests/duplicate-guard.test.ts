// Duplicate-submission guards.
//
// The portal and the discovery feed name the same company differently ("GIRO.TECH" vs
// "GIRO.TECH - Tecnologia para originação e distribuição de crédito."). Status
// reconciliation matched on the full name, missed, and the next cycle applied to a job
// that had already been submitted eleven minutes earlier. These tests pin both the
// loose reconciliation and the attempt-log check that backs it up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// The store opens its database on first use, so the path must be set before import.
process.env.JFA_DB = path.join(mkdtempSync(path.join(tmpdir(), 'jfa-dup-')), 'test.sqlite');

const store = await import('../src/store/index.js');

const job = (id: string, company: string, title: string) => ({
  id,
  source: 'gupy' as const,
  title,
  company,
  location: 'Remoto',
  remote: true,
  workplace_type: null,
  description: 'x'.repeat(120),
  apply_url: `https://example.test/${id}`,
  posted_at: null,
  deadline: null,
  seniority_hint: null,
});

test('a submitted role is detected even when the company name is only a prefix', () => {
  store.upsertJob(job('gupy:1', 'GIRO.TECH - Tecnologia para originação e distribuição de crédito.', 'Desenvolvedor Backend Pleno'));
  store.logApplication({
    job_id: 'gupyapp:9',
    url: 'https://example.test/a',
    company: 'GIRO.TECH',
    role: 'Desenvolvedor Backend Pleno',
    result: 'submitted',
  });

  // Both spellings must be recognised as already applied.
  assert.equal(store.alreadySubmitted('GIRO.TECH', 'Desenvolvedor Backend Pleno'), true);
  assert.equal(
    store.alreadySubmitted('GIRO.TECH - Tecnologia para originação e distribuição de crédito.', 'Desenvolvedor Backend Pleno'),
    true,
  );
  // A different role at the same company is a different application.
  assert.equal(store.alreadySubmitted('GIRO.TECH', 'Desenvolvedor Frontend Pleno'), false);
});

test('only a submitted attempt counts — a deferral does not block a retry', () => {
  store.upsertJob(job('gupy:2', 'Acme', 'Engenheiro de Software'));
  store.logApplication({
    job_id: 'gupyapp:10',
    url: 'https://example.test/b',
    company: 'Acme',
    role: 'Engenheiro de Software',
    result: 'deferred',
    reason: 'the form blocked submission — a required field is unfilled',
  });
  assert.equal(store.alreadySubmitted('Acme', 'Engenheiro de Software'), false);
});

test('status reconciliation follows the short company name back to the long row', () => {
  store.upsertJob(job('gupy:3', 'Cresol Confederação', 'Desenvolvedor Sênior'));
  const changed = store.setStatusByCompanyRole('Cresol', 'Desenvolvedor Sênior', 'submitted');
  assert.equal(changed, 1);
  assert.equal(store.getJob('gupy:3')?.status, 'submitted');
});

test('an exact company match still wins before the prefix fallback', () => {
  store.upsertJob(job('gupy:4', 'Stone', 'Software Engineer Pleno'));
  assert.equal(store.setStatusByCompanyRole('Stone', 'Software Engineer Pleno', 'submitted'), 1);
  assert.equal(store.getJob('gupy:4')?.status, 'submitted');
});

// A job with no posting text cannot be applied to: the driver refuses it rather than
// inventing answers, and the scorer should not spend a call on it either. Scraped
// listings (programathor, vagas) are the main source — they carry titles but no body.
test('a job with no posting text is filtered before scoring', async () => {
  const { stage1Filter } = await import('../src/match/score.js');
  const base = {
    id: 'x',
    source: 'scrape' as const,
    title: 'Desenvolvedor Full Stack Pleno',
    company: 'Acme',
    location: 'Remoto',
    remote: true,
    workplace_type: null,
    apply_url: 'https://example.test/x',
    posted_at: null,
    deadline: null,
    seniority_hint: null,
  };
  assert.match(stage1Filter({ ...base, description: '' }) || '', /no posting text/);
  assert.equal(stage1Filter({ ...base, description: 'x'.repeat(200) }), null);
});

// A closed posting must not be reported as a submit failure. Greenhouse redirects to
// the board root with ?error=true and "A vaga que você está procurando não está mais
// aberta." — the original closed-posting check missed both, so dead vacancies were
// retried every cycle.
test('a closed posting is recognised by redirect or by wording', async () => {
  const { isClosedPosting } = await import('../src/apply/driver.js');

  // Greenhouse: the redirect is the reliable signal.
  assert.equal(isClosedPosting('https://job-boards.greenhouse.io/ifoodcarreiras?error=true', ''), true);
  assert.equal(
    isClosedPosting(
      'https://job-boards.greenhouse.io/ifoodcarreiras/jobs/8901054002',
      'A vaga que você está procurando não está mais aberta.\nCurrent openings at iFood',
    ),
    true,
  );
  // Gupy: the in-place wording.
  assert.equal(isClosedPosting('https://x.gupy.io/jobs/1', 'Candidaturas encerradas'), true);
  assert.equal(isClosedPosting('https://x.test/job', 'This position is no longer accepting applications'), true);

  // An ordinary open posting must not match.
  assert.equal(isClosedPosting('https://job-boards.greenhouse.io/stone/jobs/8045173003', 'Enviar inscrição'), false);
  assert.equal(isClosedPosting('https://x.gupy.io/jobs/2', 'Vaga aberta há 8 meses'), false);
});
