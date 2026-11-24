// Polling the inboxes for a code. The interesting behaviour is not "find a code" — it is
// what happens when the code is not there yet, and what the caller is told about *why*.
// "No mail yet" and "your app password is wrong" must not look the same: the first means
// wait, the second means stop and ask the applicant.
import test from 'node:test';
import assert from 'node:assert/strict';

// Usability is judged from the credential's shape, so the fake accounts need credentials
// that pass it. Set before the config is first read, since it is cached after that.
process.env.MAIL_TEST_TECH = 'abcdefghijklmnop';
process.env.MAIL_TEST_PERSONAL = 'ponmlkjihgfedcba';

const { Mailer } = await import('../src/mail/index.js');
type MailMessage = import('../src/mail/types.js').MailMessage;

const body =
  'Um código de verificação foi enviado para gabriel.chaves.tech@gmail.com. ' +
  'digite o código de 8 caracteres para confirmar que você é uma pessoa.';

const mail = (code: string, over: Partial<MailMessage> = {}): MailMessage => ({
  id: code,
  account: 'tech',
  mailbox: 'gabriel.chaves.tech@gmail.com',
  from: 'iFood <no-reply@us.greenhouse-mail.io>',
  to: 'gabriel.chaves.tech@gmail.com',
  subject: 'Seu código de verificação',
  date: new Date().toISOString(),
  snippet: `${body} ${code}`,
  ...over,
});

const TECH = {
  name: 'tech',
  address: 'gabriel.chaves.tech@gmail.com',
  backend: 'imap' as const,
  secretEnv: 'MAIL_TEST_TECH',
};
const PERSONAL = {
  name: 'personal',
  address: 'gabriel.chaves.3720@gmail.com',
  backend: 'imap' as const,
  secretEnv: 'MAIL_TEST_PERSONAL',
};

/** A Mailer with its mailbox reads replaced by a scripted sequence. */
function scripted(polls: { items: MailMessage[]; error?: string }[], accounts = [TECH]) {
  const mailer = new Mailer(accounts);
  const state = { calls: 0, seen: [] as (string[] | undefined)[] };
  (mailer as unknown as { recent: unknown }).recent = async (q: { accounts?: string[] }) => {
    const step = polls[Math.min(state.calls, polls.length - 1)];
    state.calls++;
    state.seen.push(q.accounts);
    return {
      items: step.items,
      errors: step.error ? [{ account: 'tech', error: step.error }] : [],
    };
  };
  return { mailer, state };
}

test('returns the code as soon as the mail lands, without waiting out the timeout', async () => {
  const s = scripted([{ items: [] }, { items: [] }, { items: [mail('K7M2QP4X')] }]);
  const started = Date.now();
  const { code, polls } = await s.mailer.waitForCode({
    to: 'gabriel.chaves.tech@gmail.com',
    since: new Date(Date.now() - 60_000),
    timeoutMs: 20_000,
    pollMs: 50,
  });
  assert.equal(code?.code, 'K7M2QP4X');
  assert.equal(polls, 3);
  assert.ok(Date.now() - started < 5_000, 'should stop once the code is found');
});

test('an empty inbox is reported as no code, with no error attached', async () => {
  const s = scripted([{ items: [] }]);
  const { code, errors } = await s.mailer.waitForCode({
    to: 'gabriel.chaves.tech@gmail.com',
    since: new Date(),
    timeoutMs: 300,
    pollMs: 100,
  });
  assert.equal(code, null);
  assert.deepEqual(errors, []);
});

test('an unreadable inbox surfaces its error, so it is not mistaken for an empty one', async () => {
  const s = scripted([{ items: [], error: 'no app password in $MAIL_TEST_TECH' }]);
  const { code, errors } = await s.mailer.waitForCode({
    to: 'gabriel.chaves.tech@gmail.com',
    since: new Date(),
    timeoutMs: 300,
    pollMs: 100,
  });
  assert.equal(code, null);
  assert.equal(errors.length, 1);
  assert.match(errors[0].error, /app password/);
});

test('a code older than the cutoff is ignored even if it is the only one', async () => {
  const stale = mail('K7M2QP4X', { date: '2026-11-10T10:00:00.000Z' });
  const s = scripted([{ items: [stale] }]);
  const { code } = await s.mailer.waitForCode({
    to: 'gabriel.chaves.tech@gmail.com',
    since: new Date('2026-11-10T19:00:00.000Z'),
    timeoutMs: 300,
    pollMs: 100,
  });
  assert.equal(code, null);
});

test('the recipient address narrows the read to that mailbox', async () => {
  const s = scripted([{ items: [mail('K7M2QP4X')] }], [TECH, PERSONAL]);
  await s.mailer.waitForCode({ to: 'gabriel.chaves.tech@gmail.com', since: new Date(), timeoutMs: 500, pollMs: 50 });
  assert.deepEqual(s.state.seen[0], ['tech']);
});

// The case that matters in practice: Greenhouse mails the tech address, and app
// passwords are unavailable on that Google account, so the tech inbox cannot be read at
// all. Polling only the addressed mailbox would report "no code" for a code that a
// forward delivered somewhere readable.
test('an unusable addressed mailbox falls back to the readable ones', async () => {
  const broken = { ...TECH, secretEnv: 'MAIL_TEST_MISSING' }; // no such env var
  const s = scripted(
    [{ items: [mail('K7M2QP4X', { account: 'personal', mailbox: PERSONAL.address })] }],
    [broken, PERSONAL],
  );
  const { code } = await s.mailer.waitForCode({
    to: 'gabriel.chaves.tech@gmail.com',
    since: new Date(),
    timeoutMs: 1_000,
    pollMs: 50,
  });
  assert.equal(code?.code, 'K7M2QP4X');
  assert.deepEqual(s.state.seen[0], ['personal'], 'should read the account that works, not the one addressed');
});

test('with no readable account at all, the reason names the credentials', async () => {
  const broken = { ...TECH, secretEnv: 'MAIL_TEST_MISSING' };
  const mailer = new Mailer([broken]);
  const { code, errors } = await mailer.waitForCode({
    to: 'gabriel.chaves.tech@gmail.com',
    since: new Date(),
    timeoutMs: 500,
    pollMs: 50,
  });
  assert.equal(code, null);
  assert.match(errors[0].error, /credential unusable/);
});

test('an unknown recipient falls back to reading every readable inbox', async () => {
  const s = scripted([{ items: [mail('K7M2QP4X')] }], [TECH, PERSONAL]);
  await s.mailer.waitForCode({ to: 'someone-else@example.com', since: new Date(), timeoutMs: 500, pollMs: 50 });
  assert.deepEqual(s.state.seen[0], ['tech', 'personal']);
});
