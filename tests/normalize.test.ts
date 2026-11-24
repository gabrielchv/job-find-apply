import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText, seniorityHint, isRemote, locationIsForeign } from '../src/discovery/normalize.js';

test('htmlToText strips tags and decodes entities', () => {
  const out = htmlToText('<p>Hello &amp; welcome</p><ul><li>one</li><li>two</li></ul>');
  assert.ok(out.includes('Hello & welcome'));
  assert.ok(out.includes('one'));
  assert.ok(!out.includes('<li>'));
});

test('seniorityHint', () => {
  assert.equal(seniorityHint('Senior AI Engineer'), 'senior');
  assert.equal(seniorityHint('Analista de IA Jr.'), 'junior');
  assert.equal(seniorityHint('Engenheiro de Software Pleno'), 'mid');
  assert.equal(seniorityHint('Software Engineer'), null);
});

test('isRemote', () => {
  assert.equal(isRemote('remote'), true);
  assert.equal(isRemote('on-site'), false);
  assert.equal(isRemote(null), false);
});

test('locationIsForeign', () => {
  assert.equal(locationIsForeign('New York, US'), true);
  assert.equal(locationIsForeign('São Paulo, SP'), false);
});
