// Provider failover. The bot's config prefers Gemini whenever GEMINI_API_KEY is
// present, and a depleted prepaid balance answers every call with 402 — which used
// to halt the whole run while a funded DeepSeek key sat unused in the same file.
// These tests pin the swap: one try on the dead provider, then the funded one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LlmClient } from '../src/llm/client.js';

const realFetch = globalThis.fetch;

test.after(() => {
  globalThis.fetch = realFetch;
});

const SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };

function stubFetch(handler: (url: string, auth: string) => Response) {
  const calls: { url: string; auth: string }[] = [];
  globalThis.fetch = (async (url: unknown, init?: { headers?: Record<string, string> }) => {
    const u = String(url);
    const auth = init?.headers?.Authorization || '';
    calls.push({ url: u, auth });
    return handler(u, auth);
  }) as unknown as typeof fetch;
  return calls;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('402 from the primary provider fails over to the funded one', async () => {
  const calls = stubFetch((_url, auth) =>
    auth.includes('dead-key')
      ? json({ error: { code: 402, message: 'prepayment credits are depleted' } }, 402)
      : json({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
  );

  const client = new LlmClient({
    apiKey: 'dead-key',
    baseUrl: 'https://primary.example',
    model: 'gemini-3.8-flash',
    pricing: { input: 0, output: 0 },
    fallback: { apiKey: 'good-key', baseUrl: 'https://fallback.example', model: 'deepseek-chat' },
  });

  assert.deepEqual(await client.call({ task: 't', system: 's', input: 'i', schema: SCHEMA }), { ok: true });
  assert.equal(calls.filter((c) => c.url.startsWith('https://primary.example')).length, 1, 'one attempt on the dead provider');
  assert.equal(calls.filter((c) => c.url.startsWith('https://fallback.example')).length, 1, 'one attempt on the funded provider');

  // The swap sticks: the next call goes straight to the working provider.
  await client.call({ task: 't2', system: 's', input: 'i', schema: SCHEMA });
  assert.equal(calls.filter((c) => c.url.startsWith('https://primary.example')).length, 1);
  assert.equal(calls.filter((c) => c.url.startsWith('https://fallback.example')).length, 2);
});

test('401 (rejected key) also fails over', async () => {
  const calls = stubFetch((_url, auth) =>
    auth.includes('dead-key')
      ? json({ error: { message: 'invalid api key' } }, 401)
      : json({ choices: [{ message: { content: '{"ok":true}' } }] }),
  );
  const client = new LlmClient({
    apiKey: 'dead-key',
    baseUrl: 'https://primary.example',
    model: 'm1',
    pricing: { input: 0, output: 0 },
    fallback: { apiKey: 'good-key', baseUrl: 'https://fallback.example', model: 'm2' },
  });
  assert.deepEqual(await client.call({ task: 't', system: 's', input: 'i', schema: SCHEMA }), { ok: true });
  assert.equal(calls.length, 2);
});

test('without a fallback the error is reported, not swallowed', async () => {
  stubFetch(() => json({ error: { code: 402 } }, 402));
  const client = new LlmClient({
    apiKey: 'dead-key',
    baseUrl: 'https://primary.example',
    model: 'm1',
    pricing: { input: 0, output: 0 },
  });
  await assert.rejects(
    () => client.call({ task: 't', system: 's', input: 'i', schema: SCHEMA }),
    /no balance \(402\)/i,
  );
});

test('a rate limit is retried on the same provider, not failed over', async () => {
  let n = 0;
  const calls = stubFetch(() => {
    n++;
    return n === 1 ? json({ error: { message: 'slow down' } }, 429) : json({ choices: [{ message: { content: '{"ok":true}' } }] });
  });
  const client = new LlmClient({
    apiKey: 'k',
    baseUrl: 'https://primary.example',
    model: 'm1',
    pricing: { input: 0, output: 0 },
    fallback: { apiKey: 'other', baseUrl: 'https://fallback.example', model: 'm2' },
  });
  assert.deepEqual(await client.call({ task: 't', system: 's', input: 'i', schema: SCHEMA }), { ok: true });
  assert.equal(calls.filter((c) => c.url.startsWith('https://fallback.example')).length, 0);
});
