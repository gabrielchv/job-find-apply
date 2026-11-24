// The application page's timeline is the only thing that tells a draft from a
// submission, and it lies in a specific way if you read the progress counter
// instead of the step buttons: B4A sits at 2/6 with its curriculum done and its
// 17-minute Teste unstarted, and every run until now called that "already
// submitted". These tests pin the classification to the buttons.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser } from 'playwright';
import {
  classifyApplication,
  inspectApplication,
  isActionableStep,
  isAssessmentStep,
  type StepView,
} from '../src/gupy/portal.js';
import { clickStartDraft } from '../src/apply/driver.js';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let browser: Browser;

test.before(async () => {
  browser = await chromium.launch();
});

test.after(async () => {
  await browser?.close();
});

const step = (index: number, title: string, action: string, detail = ''): StepView => ({
  index,
  title,
  action,
  checked: action === 'Ver',
  detail,
});

// A submitted application: the curriculum step says "Ver" and no later step
// offers an action, because the company owns everything from there.
test('a timeline whose only actions are "Ver" is submitted', () => {
  const v = classifyApplication({
    steps: [step(1, 'Currículo', 'Ver'), step(2, 'Triagem', ''), step(3, 'Final', '')],
    expired: false,
  });
  assert.equal(v.state, 'submitted');
  assert.equal(v.pendingAction, null);
});

// The shape that used to be reported as "already submitted, nothing to do". Both
// halves of the answer are wrong there: the application IS with the company, but
// an assessment is waiting, and only the candidate can take it.
test('a curriculum step done plus a test step waiting is submitted with a pending test', () => {
  const v = classifyApplication({
    steps: [
      step(1, 'Currículo', 'Ver'),
      step(2, 'Teste B4A', 'Começar', 'Duração máxima: 17 min'),
      step(3, 'Entrevista com People', ''),
    ],
    expired: false,
  });
  assert.equal(v.state, 'submitted');
  assert.equal(v.pendingAction?.kind, 'assessment');
  assert.equal(v.pendingAction?.step, 2);
});

test('a curriculum step left undone is a draft the bot fills', () => {
  const v = classifyApplication({
    steps: [step(1, 'Currículo', 'Começar'), step(2, 'Final', '')],
    expired: false,
  });
  assert.equal(v.state, 'draft');
  assert.equal(v.pendingAction?.kind, 'curriculum');
});

test('step labels: "Ver" is not actionable, "Começar"/"Continuar" are', () => {
  assert.equal(isActionableStep('Ver'), false);
  assert.equal(isActionableStep('Começar'), true);
  assert.equal(isActionableStep('Começar teste'), true);
  assert.equal(isActionableStep('Continuar'), true);
  assert.equal(isActionableStep(''), false);
});

test('assessment steps are recognised by title or by the timer line', () => {
  assert.equal(isAssessmentStep({ title: 'Teste B4A', detail: '' }), true);
  assert.equal(isAssessmentStep({ title: 'Etapa 2', detail: 'Duração máxima: 17 min' }), true);
  assert.equal(isAssessmentStep({ title: 'Currículo', detail: 'Termina em: 31/12/2026' }), false);
  assert.equal(isAssessmentStep({ title: 'Entrevista com People', detail: '' }), false);
});

test('an empty page is unknown, not submitted', () => {
  assert.equal(classifyApplication({ steps: [], expired: false }).state, 'unknown');
  assert.equal(classifyApplication({ steps: [], expired: true }).state, 'expired');
});

// The parser is only worth anything if it matches Gupy's real markup, so drive it
// against a saved copy of the application page's timeline structure.
const TIMELINE = (steps: { num: string; title: string; action: string; checked: boolean; detail: string }[]) => `
<!doctype html><html><body>
<h1>Engenheiro(a) de IA Agentic</h1>
<p>Seu progresso</p><p>2/6</p>
<div class="timeline">
  ${steps
    .map(
      (s) => `
  <div class="timeline__item">
    <div class="timeline__card-number">${s.num}</div>
    <div class="timeline__card-content"><div class="expandable-card">
      <div class="expandable-card__header-text">${s.title}</div>
      ${s.checked ? '<svg data-testid="CheckCircleIcon"></svg>' : ''}
      <div class="card-body"><div class="card-body__description">${s.detail}</div></div>
      <div class="expandable-card__button-wrapper">
        ${s.action ? `<button type="button" onclick="window.__clicked='${s.action}'">${s.action}</button>` : ''}
      </div>
    </div></div>
  </div>`,
    )
    .join('')}
</div>
</body></html>`;

test('inspectApplication reads the real timeline markup', async () => {
  const page = await browser.newPage();
  // inspectApplication navigates to the card's URL, so the fixture has to be a real
  // page it can load — a file URL keeps the test offline and deterministic.
  const dir = mkdtempSync(path.join(tmpdir(), 'jfa-portal-'));
  const file = path.join(dir, 'app.html');
  writeFileSync(
    file,
    TIMELINE([
      { num: '1', title: 'Currículo', action: 'Ver', checked: true, detail: 'Termina em: 31/12/2026' },
      { num: '2', title: 'Teste B4A', action: 'Começar', checked: false, detail: 'Duração máxima: 17 min' },
      { num: '3', title: 'Entrevista com People', action: '', checked: false, detail: '' },
    ]),
  );
  const info = await inspectApplication(page, {
    appId: '1',
    appUrl: `file://${file}`,
    company: 'B4A',
    role: 'Engenheiro(a) de IA Agentic',
    location: '',
    workType: '',
    progress: '2/6',
  });
  assert.equal(info.state, 'submitted', 'the curriculum step is done, so the company has it');
  assert.equal(info.pendingAction?.kind, 'assessment');
  assert.equal(info.steps.length, 3);
  assert.equal(info.steps[1].title, 'Teste B4A');
  await page.close();
});

// The safety guarantee, tested at the click: the bot must never start a company
// test. The old code clicked the first "Começar" on the page, which is exactly the
// test step's button, and burned a real 17-minute attempt.
test('clickStartDraft never clicks "Começar" on an assessment step', async () => {
  const page = await browser.newPage();
  await page.setContent(
    TIMELINE([
      { num: '1', title: 'Currículo', action: 'Ver', checked: true, detail: 'Termina em: 31/12/2026' },
      { num: '2', title: 'Teste B4A', action: 'Começar', checked: false, detail: 'Duração máxima: 17 min' },
    ]),
  );
  const result = await clickStartDraft(page);
  assert.equal(result, 'assessment');
  assert.equal(await page.evaluate(() => (window as unknown as { __clicked?: string }).__clicked), undefined);
  await page.close();
});

test('clickStartDraft still enters an ordinary curriculum draft', async () => {
  const page = await browser.newPage();
  await page.setContent(
    TIMELINE([
      { num: '1', title: 'Currículo', action: 'Começar', checked: false, detail: 'Termina em: 31/12/2026' },
      { num: '2', title: 'Final', action: '', checked: false, detail: '' },
    ]),
  );
  const result = await clickStartDraft(page);
  assert.equal(result, 'clicked');
  assert.equal(await page.evaluate(() => (window as unknown as { __clicked?: string }).__clicked), 'Começar');
  await page.close();
});

// A test step with no portal button is still a test the candidate owes.
//
// Attus runs its assessment from a link in the notification email and puts no button on
// the timeline card, while the progress counter sits on that step (2/5) and the stage
// holds 100+ candidates. Treating "no button" as "finished" hid a live 24-hour
// assessment, and the summary told the candidate there was nothing to do.
test('an open assessment step with no button is still pending', () => {
  const v = classifyApplication({
    steps: [
      step(1, 'Currículo', 'Ver'),
      step(2, 'Teste Técnico Lógica & SQL', '', 'Mais de 100 pessoas candidatas nesta etapa. Duração máxima: 1440 min'),
      step(3, 'Bate papo Cultural', ''),
      step(4, 'Entrevista técnica', ''),
    ],
    expired: false,
    stepsDone: 2,
  });
  assert.equal(v.state, 'submitted');
  assert.equal(v.pendingAction?.kind, 'assessment');
  assert.equal(v.pendingAction?.step, 2);
  assert.equal(v.pendingAction?.label, '', 'there is no button to name');
});

test('an application merely waiting on the company stays clear', () => {
  // The ordinary shape: step 1 done, progress 1/5, later stages empty.
  const v = classifyApplication({
    steps: [
      step(1, 'Currículo', 'Ver'),
      step(2, 'Etapa Técnica', '', 'Nenhuma pessoa candidata nesta etapa.'),
      step(3, 'Final', ''),
    ],
    expired: false,
    stepsDone: 1,
  });
  assert.equal(v.state, 'submitted');
  assert.equal(v.pendingAction, null);
});

test('a completed assessment step does not linger as pending', () => {
  const v = classifyApplication({
    steps: [step(1, 'Currículo', 'Ver'), step(2, 'Teste Técnico', 'Ver'), step(3, 'Entrevista', '')],
    expired: false,
    stepsDone: 2,
  });
  assert.equal(v.pendingAction, null);
});

// The progress counter must come from its heading, not from the first x/y on the page.
// Attus's step 1 says "Termina em: 04/12/2026", so the naive parse read the DATE as
// progress 4/12 and placed the candidate at step 4 — past a test they still owed.
test('a deadline date is not mistaken for the progress counter', async () => {
  const page = await browser.newPage();
  const html = `
<!doctype html><html><body>
  <h1>Analista de Suporte Técnico</h1>
  <p>Seu progresso</p><p>2/5</p>
  <div class="timeline">
    <div class="timeline__item"><div class="timeline__card-number">1</div>
      <div class="expandable-card__header-text">Currículo</div>
      <svg data-testid="CheckCircleIcon"></svg>
      <div class="card-body">Termina em: 04/12/2026</div>
      <div class="expandable-card__button-wrapper"><button type="button">Ver</button></div>
    </div>
    <div class="timeline__item"><div class="timeline__card-number">2</div>
      <div class="expandable-card__header-text">Teste Técnico Lógica &amp; SQL</div>
      <div class="card-body">Mais de 100 pessoas candidatas nesta etapa. Duração máxima: 1440 min</div>
      <div class="expandable-card__button-wrapper"></div>
    </div>
    <div class="timeline__item"><div class="timeline__card-number">3</div>
      <div class="expandable-card__header-text">Bate papo Cultural</div>
      <div class="card-body">Nenhuma pessoa candidata nesta etapa.</div>
    </div>
  </div>
</body></html>`;
  const dir = mkdtempSync(path.join(tmpdir(), 'jfa-prog-'));
  const file = path.join(dir, 'attus.html');
  writeFileSync(file, html);
  const info = await inspectApplication(page, {
    appId: '769922686',
    appUrl: `file://${file}`,
    company: 'Attus',
    role: 'Analista de Suporte Técnico',
    location: '',
    workType: '',
    progress: '',
  });
  assert.equal(info.stepsDone, 2, 'progress must come from "Seu progresso", not the date');
  assert.equal(info.stepsTotal, 5);
  assert.equal(info.pendingAction?.kind, 'assessment');
  assert.equal(info.pendingAction?.step, 2);
  await page.close();
});

// Gupy draws the check icon on the step the candidate is standing in, not only on
// completed ones. Attus's open test step carries it, so treating the icon as "done"
// hid a live assessment.
test('a check icon on the current step does not mean it is finished', () => {
  const openTest = {
    index: 2,
    title: 'Teste Técnico Lógica & SQL',
    action: '',
    checked: true, // present on the active step
    detail: 'Mais de 100 pessoas candidatas nesta etapa. Duração máxima: 1440 min',
  };
  const v = classifyApplication({
    steps: [step(1, 'Currículo', 'Ver'), openTest, step(3, 'Bate papo', '')],
    expired: false,
    stepsDone: 2,
  });
  assert.equal(v.pendingAction?.kind, 'assessment', 'an open test must not be hidden');
});
