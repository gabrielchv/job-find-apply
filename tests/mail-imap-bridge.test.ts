// The Python bridge parses MIME for the Node side, so its parsing is the part that can
// silently corrupt a code ("K7M2QP4X" arriving as mojibake would be useless). These
// tests drive the real script's functions rather than a copy of them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'gmail-imap.py');

/** Import the bridge module and call a function on a raw message, printing JSON. */
function py(fn: string, raw: string): unknown {
  const code = `
import email, importlib.util, json, sys
spec = importlib.util.spec_from_file_location("bridge", ${JSON.stringify(SCRIPT)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
raw = json.loads(sys.stdin.read())
print(${fn})
`;
  const res = spawnSync('python3', ['-c', code], { input: JSON.stringify(raw), encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`python failed: ${res.stderr || res.error}`);
  return JSON.parse(res.stdout);
}

const RAW_PT = [
  'From: =?UTF-8?B?vGF09Do=?= <no-reply@us.greenhouse-mail.io>',
  'To: gabriel.chaves.tech@gmail.com',
  'Subject: =?UTF-8?Q?Seu_c=C3=B3digo_de_verifica=C3=A7=C3=A3o?=',
  'MIME-Version: 1.0',
  'Content-Type: multipart/alternative; boundary="B"',
  '',
  '--B',
  'Content-Type: text/plain; charset="utf-8"',
  '',
  'Um código de verificação foi enviado. K7M2QP4X',
  '--B',
  'Content-Type: text/html; charset="utf-8"',
  '',
  '<html><body><p>Um c&oacute;digo</p></body></html>',
  '--B--',
  '',
].join('\n');

test('decodes MIME-encoded headers instead of returning raw =?…?= words', () => {
  const out = py(
    `json.dumps({
        "subject": m.decode_header_value(email.message_from_bytes(raw.encode("utf-8")).get("Subject")),
     })`,
    RAW_PT,
  ) as { subject: string };
  assert.equal(out.subject, 'Seu código de verificação');
});

test('extracts the plain-text body, not the HTML alternative', () => {
  const out = py(
    `json.dumps({"body": m.body_text(email.message_from_bytes(raw.encode("utf-8")))})`,
    RAW_PT,
  ) as { body: string };
  assert.match(out.body, /K7M2QP4X/);
  assert.doesNotMatch(out.body, /<p>/, 'html must not be returned when text/plain exists');
});

test('an HTML-only message is flattened to readable text', () => {
  const htmlOnly = [
    'From: a@b.c',
    'Subject: code',
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset="utf-8"',
    '',
    '<html><head><style>p{color:red}</style></head><body><p>Seu código: <b>Q4W7Z2L9</b></p></body></html>',
  ].join('\n');
  const out = py(`json.dumps({"body": m.body_text(email.message_from_bytes(raw.encode("utf-8")))})`, htmlOnly) as {
    body: string;
  };
  assert.match(out.body, /Q4W7Z2L9/);
  assert.doesNotMatch(out.body, /color:red/, 'style blocks must be dropped');
});

test('the bridge refuses a request with no credentials instead of attempting a login', () => {
  const res = spawnSync('python3', [SCRIPT], {
    input: JSON.stringify({ user: '', password: '', since_minutes: 5, limit: 5 }),
    encoding: 'utf8',
  });
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout) as { messages: unknown[]; errors: string[] };
  assert.deepEqual(out.messages, []);
  assert.match(out.errors[0], /missing user or password/);
});

test('the bridge survives a malformed request', () => {
  const res = spawnSync('python3', [SCRIPT], { input: 'not json', encoding: 'utf8' });
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout) as { errors: string[] };
  assert.match(out.errors[0], /bad request/);
});
