import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '../src/llm/schema.js';
import { check, checkSources } from '../src/llm/validate.js';

test('validate: passes a conforming object', () => {
  const schema = { type: 'object', properties: { a: { type: 'string' }, b: { type: 'integer' } }, required: ['a', 'b'] };
  assert.deepEqual(validate({ a: 'x', b: 1 }, schema), []);
});

test('validate: reports missing required, wrong type, bad enum', () => {
  const schema = {
    type: 'object',
    properties: { a: { type: 'string' }, kind: { type: 'string', enum: ['stored', 'none'] } },
    required: ['a'],
  };
  assert.ok(validate({}, schema).some((e) => e.includes('a: required property is missing')));
  assert.ok(validate({ a: 5 }, schema).some((e) => e.includes('expected string')));
  assert.ok(validate({ a: 'x', kind: 'bogus' }, schema).some((e) => e.includes('not one of')));
});

test('checkSources: a citation must actually appear in the facts', () => {
  const facts = 'Worked at Meet Oscar building an AI email assistant.';
  assert.deepEqual(checkSources(['Worked at Meet Oscar'], facts), []);
  assert.deepEqual(checkSources(['Worked at Google'], facts), ['Worked at Google']);
});

test('check: flags an invented technology', () => {
  const kb = { skills: { web: ['React'] } };
  const flags = check('I used PyTorch daily.', { kb, posting: null });
  assert.ok(flags.some((f) => f.term === 'PyTorch'));
});

test('check: does not flag a technology the KB actually mentions', () => {
  const kb = { skills: { web: ['React', 'Next.js'] } };
  const flags = check('I built it with React and Next.js.', { kb, posting: null });
  assert.deepEqual(flags, []);
});

test('check: standalone numbers, not substrings — "6" inside "2026" does not pass', () => {
  const kb = { education: [{ end_expected: '2026-12' }] };
  const flags = check('I have 6 anos de experiência.', { kb, posting: null });
  assert.ok(flags.some((f) => f.term === '6 anos'));
});
