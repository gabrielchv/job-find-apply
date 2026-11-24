import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateGate } from '../src/apply/submit-gate.js';
import type { FillReport } from '../src/apply/driver.js';

function report(rows: FillReport['rows'], extra: Partial<FillReport> = {}): FillReport {
  return { adapterId: 'generic', lang: 'pt', rows, errors: [], resume: { ok: false }, llm: { state: 'idle' }, hasAssessment: false, blocked: false, loginWall: false, ...extra };
}

const row = (over: Partial<FillReport['rows'][number]>): FillReport['rows'][number] => ({
  index: 0, uid: 'f', label: 'field', kind: 'text', required: false, status: 'filled', ...over,
});

test('dry-run never submits', () => {
  const d = evaluateGate(report([row({})]), { dryRun: true, submit: true });
  assert.equal(d.submit, false);
  assert.equal(d.reason, 'dry-run');
});

test('submit disabled never submits', () => {
  const d = evaluateGate(report([row({})]), { dryRun: false, submit: false });
  assert.equal(d.submit, false);
});

test('a failed (unverified) required field blocks submit', () => {
  const d = evaluateGate(report([row({ status: 'failed', label: 'CPF', required: true })]), { dryRun: false, submit: true });
  assert.equal(d.submit, false);
  assert.ok(d.reason!.includes('failed'));
});

test('a failed optional field does not block submit', () => {
  const d = evaluateGate(report([row({ status: 'failed', label: 'Como nos conheceu', required: false })]), { dryRun: false, submit: true });
  assert.equal(d.submit, true);
});

test('a required blank field blocks submit', () => {
  const d = evaluateGate(report([row({ status: 'blank', required: true, label: 'Nome' })]), { dryRun: false, submit: true });
  assert.equal(d.submit, false);
  assert.ok(d.requiresManual);
});

test('a required consent box blocks submit', () => {
  const d = evaluateGate(report([row({ status: 'blank', required: true, consent: true, label: 'Termos' })]), { dryRun: false, submit: true });
  assert.equal(d.submit, false);
  assert.ok(d.reason!.includes('consent'));
});

test('a required field already set by the page (dial code) does not block submit', () => {
  const d = evaluateGate(
    report([row({ status: 'skipped', required: true, preset: true, label: 'BR +55' })]),
    { dryRun: false, submit: true },
  );
  assert.equal(d.submit, true);
  assert.equal(d.reason, null);
});

test('a preset field stays out of the unfilled list next to a real gap', () => {
  const d = evaluateGate(
    report([
      row({ status: 'skipped', required: true, preset: true, label: 'BR +55' }),
      row({ status: 'blank', required: true, label: 'Nome' }),
    ]),
    { dryRun: false, submit: true },
  );
  assert.equal(d.submit, false);
  assert.ok(d.reason!.includes('Nome'));
  assert.ok(!d.reason!.includes('BR +55'));
});

test('an assessment step blocks submit', () => {
  const d = evaluateGate(report([row({})], { hasAssessment: true }), { dryRun: false, submit: true });
  assert.equal(d.submit, false);
  assert.ok(d.reason!.includes('assessment'));
});

test('a clean form submits', () => {
  const d = evaluateGate(report([row({ status: 'filled' })]), { dryRun: false, submit: true });
  assert.equal(d.submit, true);
  assert.equal(d.reason, null);
});

// A yes/no claim about the candidate's own experience is a statement of fact, not a
// preference. "Tem vivência com Sustentação?" was answered "Sim" from the model with no
// citation — while the next question answered "Não" for fila de chamados — and the
// application went out. That is exactly the invention the gate exists to stop.
const claimRow = (over: Partial<import('../src/types.js').FillRow> = {}) => ({
  index: 0,
  uid: 'q1',
  label: '1. Tem vivência com Sustentação?',
  kind: 'choice' as const,
  required: false,
  status: 'review' as const,
  value: 'Sim',
  detail: 'derived from KB',
  source: 'model' as const,
  ...over,
});

test('an ungrounded affirmative experience claim blocks submission', () => {
  const decision = evaluateGate(report([claimRow()]), { dryRun: false, submit: true });
  assert.equal(decision.submit, false);
  assert.match(decision.reason || '', /experience claim needs your confirmation/);
  assert.equal(decision.requiresManual, true);
});

test('a grounded affirmative experience claim passes', () => {
  const grounded = claimRow({
    label: 'Você tem experiência com Java?',
    detail: 'KB states "three years of production experience" building Java services',
  });
  const decision = evaluateGate(report([grounded]), { dryRun: false, submit: true });
  assert.equal(decision.submit, true, decision.reason || '');
});

test('a negative answer to an experience question is not a claim and passes', () => {
  const negative = claimRow({ value: 'Não', label: '2. Já atuou com fila de chamados?' });
  const decision = evaluateGate(report([negative]), { dryRun: false, submit: true });
  assert.equal(decision.submit, true, decision.reason || '');
});

test('a label-matched affirmative answer passes — it is not model inference', () => {
  const fromLabel = claimRow({ source: 'label', detail: 'label match' });
  const decision = evaluateGate(report([fromLabel]), { dryRun: false, submit: true });
  assert.equal(decision.submit, true, decision.reason || '');
});

test('a salary preference is not an experience claim', () => {
  const salary = claimRow({ label: 'Qual sua pretensão salarial?', value: 'Sim', detail: 'derived from KB' });
  const decision = evaluateGate(report([salary]), { dryRun: false, submit: true });
  assert.equal(decision.submit, true, decision.reason || '');
});
