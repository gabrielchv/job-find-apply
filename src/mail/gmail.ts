// Gmail REST backend (OAuth), for accounts where an app password is not wanted.
//
// Setup is a one-time browser consent per account:
//   1. Google Cloud project -> enable Gmail API -> create an OAuth client of type
//      "Desktop app" -> download the JSON to config/gmail-oauth-client.json
//   2. npm run mail -- auth <account>
//
// Only gmail.readonly is requested. This module reads; it never sends, labels,
// archives or deletes anything.
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.js';
import { mailSettings } from './accounts.js';
import type { MailAccount, MailMessage, MailResult } from './types.js';

const AUTH_BASE = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

interface OAuthClient {
  client_id: string;
  client_secret: string;
}

export interface Token {
  access_token: string;
  refresh_token?: string;
  /** Epoch milliseconds. */
  expires_at: number;
  scope?: string;
  token_type?: string;
}

function clientFile(): string {
  return path.isAbsolute(mailSettings().oauth.clientFile)
    ? mailSettings().oauth.clientFile
    : path.join(ROOT, mailSettings().oauth.clientFile);
}

export function hasOAuthClient(): boolean {
  return existsSync(clientFile());
}

function readClient(): OAuthClient {
  const file = clientFile();
  if (!existsSync(file)) {
    throw new Error(
      `No OAuth client at ${path.relative(ROOT, file)}. Create a Desktop OAuth client in Google Cloud ` +
        '(Gmail API enabled) and save its JSON there, or set the account backend to "imap".',
    );
  }
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>;
  // Google ships either {"installed": {...}} or {"web": {...}} depending on client type.
  const box = raw.installed || raw.web || raw;
  if (!box.client_id || !box.client_secret) {
    throw new Error(`OAuth client file ${path.relative(ROOT, file)} has no client_id/client_secret.`);
  }
  return { client_id: box.client_id, client_secret: box.client_secret };
}

export function tokenPath(account: MailAccount): string {
  const dir = path.isAbsolute(mailSettings().oauth.tokenDir)
    ? mailSettings().oauth.tokenDir
    : path.join(ROOT, mailSettings().oauth.tokenDir);
  return path.join(dir, `${account.name}.json`);
}

function readToken(account: MailAccount): Token | null {
  const file = tokenPath(account);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Token;
  } catch {
    return null;
  }
}

function writeToken(account: MailAccount, token: Token): void {
  const file = tokenPath(account);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(token, null, 2));
  // A refresh token is a standing grant on the mailbox; keep it owner-readable only.
  chmodSync(file, 0o600);
}

function form(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

async function exchange(params: Record<string, string>): Promise<Token> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form(params),
  });
  const json = (await res.json()) as Record<string, any>;
  if (!res.ok) throw new Error(`token exchange failed (${res.status}): ${json.error_description || json.error || ''}`);
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: Date.now() + (Number(json.expires_in) || 3600) * 1000,
    scope: json.scope,
    token_type: json.token_type,
  };
}

/**
 * Interactive consent. Opens the system browser on Google's consent screen, catches the
 * loopback redirect, and stores the refresh token.
 *
 * `login_hint` pre-selects the account so two mailboxes do not get crossed — the most
 * likely failure with a multi-account setup is authorizing the wrong Google account.
 */
export async function authorize(account: MailAccount, opts: { openBrowser?: boolean } = {}): Promise<Token> {
  const client = readClient();
  const scopes = mailSettings().oauth.scopes;
  const state = randomBytes(16).toString('hex');
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  const { server, port } = await new Promise<{ server: import('node:http').Server; port: number }>((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      resolve({ server: s, port: typeof addr === 'object' && addr ? addr.port : 0 });
    });
  });

  const redirectUri = `http://127.0.0.1:${port}`;
  const authUrl = `${AUTH_BASE}?${form({
    client_id: client.client_id,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    login_hint: account.address,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })}`;

  const codePromise = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for the browser redirect (5 min)')), 5 * 60_000);
    server.on('request', (req, res) => {
      const url = new URL(req.url || '/', redirectUri);
      const got = url.searchParams.get('code');
      const err = url.searchParams.get('error');
      const gotState = url.searchParams.get('state');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      if (err) {
        res.end(`<p>Authorization denied: ${err}</p><p>You can close this tab.</p>`);
        clearTimeout(timer);
        reject(new Error(`authorization denied: ${err}`));
        return;
      }
      if (gotState !== state) {
        res.end('<p>State mismatch — try again.</p>');
        clearTimeout(timer);
        reject(new Error('OAuth state mismatch (possible cross-site request)'));
        return;
      }
      res.end('<p>Authorized. You can close this tab and return to the terminal.</p>');
      clearTimeout(timer);
      resolve(got || '');
    });
  });

  const open = opts.openBrowser !== false;
  if (open) {
    // xdg-open on this platform; the URL is also printed so a headless/remote session
    // can paste it elsewhere.
    const { spawn } = await import('node:child_process');
    spawn('xdg-open', [authUrl], { stdio: 'ignore', detached: true }).unref();
  }
  console.log(`\nOpen this URL if the browser did not open:\n\n${authUrl}\n`);

  try {
    const code = await codePromise;
    const token = await exchange({
      client_id: client.client_id,
      client_secret: client.client_secret,
      code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    });
    writeToken(account, token);
    return token;
  } finally {
    server.close();
  }
}

async function freshToken(account: MailAccount): Promise<Token> {
  const token = readToken(account);
  if (!token) {
    throw new Error(`No token for account "${account.name}". Run: npm run mail -- auth ${account.name}`);
  }
  // 60s of slack so a token cannot expire between the check and the request.
  if (token.access_token && token.expires_at - 60_000 > Date.now()) return token;
  if (!token.refresh_token) {
    throw new Error(`Token for "${account.name}" expired and has no refresh_token. Run: npm run mail -- auth ${account.name}`);
  }
  const client = readClient();
  const refreshed = await exchange({
    client_id: client.client_id,
    client_secret: client.client_secret,
    refresh_token: token.refresh_token,
    grant_type: 'refresh_token',
  });
  // Google does not resend the refresh token on refresh; keep the one we have.
  const merged: Token = { ...token, ...refreshed, refresh_token: refreshed.refresh_token || token.refresh_token };
  writeToken(account, merged);
  return merged;
}

/** Decode a Gmail message payload into a plain-text snippet. */
function payloadText(payload: any): string {
  if (!payload) return '';
  const chunks: string[] = [];
  const walk = (part: any) => {
    if (!part) return;
    const mime = String(part.mimeType || '');
    const filename = part.filename || '';
    if (part.body?.data && (mime === 'text/plain' || mime === 'text/html') && !filename) {
      chunks.push(Buffer.from(part.body.data, 'base64url').toString('utf8'));
    }
    for (const child of part.parts || []) walk(child);
  };
  walk(payload);
  const joined = chunks.join('\n');
  const text = /<[a-z][\s\S]*>/i.test(joined)
    ? joined.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')
    : joined;
  return text.replace(/\s+/g, ' ').trim();
}

function header(headers: { name: string; value: string }[] | undefined, name: string): string {
  return (headers || []).find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';
}

/**
 * Read recent messages for one OAuth account.
 *
 * The Gmail query is built server-side (`newer_than:`), so the cut-off is applied by
 * Google rather than by trimming a page of results here.
 */
export async function readGmail(
  account: MailAccount,
  opts: { sinceMinutes: number; limit: number },
): Promise<MailResult<MailMessage>> {
  try {
    const token = await freshToken(account);
    const days = Math.max(1, Math.ceil(opts.sinceMinutes / (60 * 24)));
    const q = `newer_than:${days}d -in:spam -in:trash`;
    const listUrl = `${API}/messages?${form({ q, maxResults: String(Math.max(opts.limit * 4, 25)) })}`;
    const res = await fetch(listUrl, { headers: { Authorization: `Bearer ${token.access_token}` } });
    if (!res.ok) throw new Error(`messages.list failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const list = (await res.json()) as { messages?: { id: string }[] };

    const cutoff = Date.now() - opts.sinceMinutes * 60_000;
    const items: MailMessage[] = [];
    for (const ref of list.messages || []) {
      if (items.length >= opts.limit) break;
      const one = await fetch(`${API}/messages/${ref.id}?format=full`, {
        headers: { Authorization: `Bearer ${token.access_token}` },
      });
      if (!one.ok) continue;
      const m = (await one.json()) as any;
      const headers = m.payload?.headers;
      const ms = Number(m.internalDate) || 0;
      if (!ms || ms < cutoff) continue;
      items.push({
        id: m.id,
        account: account.name,
        mailbox: account.address,
        from: header(headers, 'From'),
        to: header(headers, 'To'),
        subject: header(headers, 'Subject'),
        date: new Date(ms).toISOString(),
        snippet: (m.snippet ? `${m.snippet} ` : '') + payloadText(m.payload),
      });
    }
    items.sort((a, b) => (a.date < b.date ? 1 : -1));
    return { items, errors: [] };
  } catch (e) {
    return { items: [], errors: [{ account: account.name, error: (e as Error).message }] };
  }
}
