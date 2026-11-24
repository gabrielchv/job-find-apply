// Where credentials actually come from.
//
// The mail app passwords live in config/mail.env, which is parsed into the config — NOT
// into process.env. Reading them with `process.env[name]` therefore returned '' for every
// value the user pasted, and the mail check reported "no app password" with the password
// sitting right there. These tests pin the merge order so that cannot come back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Read a variable the way the app does, in a child process so each case gets a clean
 * module cache and its own env file pair.
 */
function lookup(name: string, files: { dotenv?: string; mailenv?: string; env?: Record<string, string> }): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'jfa-env-'));
  const probe = path.join(dir, 'probe.ts');
  writeFileSync(
    probe,
    `import { envVar } from ${JSON.stringify(path.join(ROOT, 'src', 'config.ts'))};\n` +
      `process.stdout.write(envVar(${JSON.stringify(name)}));\n`,
  );
  const env: Record<string, string> = { ...process.env, ...(files.env || {}) } as Record<string, string>;
  if (files.dotenv !== undefined) env.JFA_ENV_FILE = files.dotenv;
  if (files.mailenv !== undefined) env.JFA_MAIL_ENV_FILE = files.mailenv;

  const res = spawnSync(path.join(ROOT, 'node_modules', '.bin', 'tsx'), [probe], { encoding: 'utf8', env });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout;
}

function write(dir: string, name: string, body: string): string {
  const file = path.join(dir, name);
  writeFileSync(file, body);
  return file;
}

test('a value pasted into mail.env is visible to the app', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jfa-envf-'));
  const dotenv = write(dir, '.env', 'DEEPSEEK_API_KEY=k\n');
  const mailenv = write(dir, 'mail.env', 'MAIL_TECH_APP_PASSWORD=abcdefghijklmnop\n');
  assert.equal(lookup('MAIL_TECH_APP_PASSWORD', { dotenv, mailenv }), 'abcdefghijklmnop');
});

test('mail.env wins over .env for the same key', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jfa-envf-'));
  const dotenv = write(dir, '.env', 'MAIL_TECH_APP_PASSWORD=fromdotenv\n');
  const mailenv = write(dir, 'mail.env', 'MAIL_TECH_APP_PASSWORD=frommailenv\n');
  assert.equal(lookup('MAIL_TECH_APP_PASSWORD', { dotenv, mailenv }), 'frommailenv');
});

test('the real environment still beats both files', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jfa-envf-'));
  const dotenv = write(dir, '.env', 'MAIL_TECH_APP_PASSWORD=fromdotenv\n');
  const mailenv = write(dir, 'mail.env', 'MAIL_TECH_APP_PASSWORD=frommailenv\n');
  assert.equal(
    lookup('MAIL_TECH_APP_PASSWORD', { dotenv, mailenv, env: { MAIL_TECH_APP_PASSWORD: 'fromshell' } }),
    'fromshell',
  );
});

test('an empty slot reads as empty, not as an error', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jfa-envf-'));
  const dotenv = write(dir, '.env', 'X=1\n');
  const mailenv = write(dir, 'mail.env', 'MAIL_PERSONAL_APP_PASSWORD=\n');
  assert.equal(lookup('MAIL_PERSONAL_APP_PASSWORD', { dotenv, mailenv }), '');
});

test('quotes around a pasted password are stripped', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jfa-envf-'));
  const dotenv = write(dir, '.env', 'X=1\n');
  const mailenv = write(dir, 'mail.env', 'MAIL_TECH_APP_PASSWORD="abcdefghijklmnop"\n');
  assert.equal(lookup('MAIL_TECH_APP_PASSWORD', { dotenv, mailenv }), 'abcdefghijklmnop');
});

test('the groups Google displays are stripped, so a straight paste authenticates', () => {
  // Google shows app passwords as four groups of four but accepts only the 16
  // characters. The reader must do that normalisation, not the user.
  const dir = mkdtempSync(path.join(tmpdir(), 'jfa-envf-'));
  const dotenv = write(dir, '.env', 'X=1\n');
  const mailenv = write(dir, 'mail.env', 'MAIL_TECH_APP_PASSWORD=abcd efgh ijkl mnop\n');
  const probe = path.join(dir, 'probe-app-password.ts');
  writeFileSync(
    probe,
    `import { appPassword } from ${JSON.stringify(path.join(ROOT, 'src', 'mail', 'accounts.ts'))};\n` +
      `process.stdout.write(appPassword({ name: 'tech', address: 'a@b.c', backend: 'imap', secretEnv: 'MAIL_TECH_APP_PASSWORD' }));\n`,
  );
  const res = spawnSync(path.join(ROOT, 'node_modules', '.bin', 'tsx'), [probe], {
    encoding: 'utf8',
    env: { ...process.env, JFA_ENV_FILE: dotenv, JFA_MAIL_ENV_FILE: mailenv },
  });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, 'abcdefghijklmnop');
});

// Shape check, so the tool can name the actual mistake ("that is your account
// password") instead of relaying Google's terse AUTHENTICATIONFAILED.
function shapeOf(pasted: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'jfa-shape-'));
  const dotenv = write(dir, '.env', 'X=1\n');
  const mailenv = write(dir, 'mail.env', `MAIL_TECH_APP_PASSWORD=${pasted}\n`);
  const probe = path.join(dir, 'probe-shape.ts');
  writeFileSync(
    probe,
    `import { appPasswordShape } from ${JSON.stringify(path.join(ROOT, 'src', 'mail', 'accounts.ts'))};\n` +
      `process.stdout.write(JSON.stringify(appPasswordShape({ name: 'tech', address: 'a@b.c', backend: 'imap', secretEnv: 'MAIL_TECH_APP_PASSWORD' })));\n`,
  );
  const res = spawnSync(path.join(ROOT, 'node_modules', '.bin', 'tsx'), [probe], {
    encoding: 'utf8',
    env: { ...process.env, JFA_ENV_FILE: dotenv, JFA_MAIL_ENV_FILE: mailenv },
  });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout;
}

test('a real 16-character app password passes the shape check', () => {
  const out = JSON.parse(shapeOf('abcdefghijklmnop')) as { looksValid: boolean; length: number };
  assert.equal(out.looksValid, true);
  assert.equal(out.length, 16);
});

test('spaces from Google\'s four-group display still pass', () => {
  const out = JSON.parse(shapeOf('abcd efgh ijkl mnop')) as { looksValid: boolean };
  assert.equal(out.looksValid, true);
});

test('an account password is named as such, with its length', () => {
  const out = JSON.parse(shapeOf('shortpwd')) as { looksValid: boolean; length: number; hint: string };
  assert.equal(out.looksValid, false);
  assert.equal(out.length, 8);
  assert.match(out.hint, /app password is 16/);
  assert.match(out.hint, /account password cannot be used/i);
});

test('an empty slot is reported as not filled rather than as invalid', () => {
  const out = JSON.parse(shapeOf('')) as { filled: boolean };
  assert.equal(out.filled, false);
});

// `isConfigured` gates whether the runner bothers re-driving a mail-gated application.
// It must mean "could authenticate", not "some text is present" — otherwise a pasted
// account password makes the runner resubmit the same form every cycle, mailing a code
// nobody can read.
function configuredWith(mailLine: string): boolean {
  const dir = mkdtempSync(path.join(tmpdir(), 'jfa-cfg-'));
  const dotenv = write(dir, '.env', 'X=1\n');
  const mailenv = write(dir, 'mail.env', mailLine + '\n');
  const probe = path.join(dir, 'probe-cfg.ts');
  writeFileSync(
    probe,
    `import { isConfigured } from ${JSON.stringify(path.join(ROOT, 'src', 'mail', 'index.ts'))};\n` +
      `process.stdout.write(String(isConfigured()));\n`,
  );
  const res = spawnSync(path.join(ROOT, 'node_modules', '.bin', 'tsx'), [probe], {
    encoding: 'utf8',
    env: { ...process.env, JFA_ENV_FILE: dotenv, JFA_MAIL_ENV_FILE: mailenv },
  });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout.trim() === 'true';
}

test('a valid app password makes mail configured', () => {
  assert.equal(configuredWith('MAIL_TECH_APP_PASSWORD=abcdefghijklmnop'), true);
  assert.equal(configuredWith('MAIL_PERSONAL_APP_PASSWORD=ponmlkjihgfedcba'), true);
});

test('an account password in the app-password slot does not count as configured', () => {
  assert.equal(configuredWith('MAIL_TECH_APP_PASSWORD=shortpwd'), false);
  assert.equal(configuredWith('MAIL_PERSONAL_APP_PASSWORD=shortpwd'), false);
});

test('an empty slot does not count as configured', () => {
  assert.equal(configuredWith('MAIL_TECH_APP_PASSWORD='), false);
});
