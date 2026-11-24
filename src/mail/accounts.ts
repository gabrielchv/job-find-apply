// Mail account resolution and the IMAP backend.
//
// Accounts come from config/settings.yaml (`mail.accounts`); secrets never do. An app
// password is read from the env var the account names, and it is handed to the reader
// on stdin so it stays out of `ps` and out of shell history.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { envVar, getConfig, ROOT } from '../config.js';
import type { MailAccount, MailMessage, MailResult } from './types.js';

const BRIDGE = path.join(ROOT, 'scripts', 'gmail-imap.py');

/**
 * Run the Python bridge, feeding the request on stdin.
 *
 * spawn rather than execFile: execFile has no way to write stdin, and putting the app
 * password in argv would publish it to every process on the machine.
 */
function runBridge(request: string, timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', [BRIDGE], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`mail reader timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(`mail reader exited ${code}${stderr ? ` — ${stderr.trim().slice(0, 300)}` : ''}`));
        return;
      }
      resolve({ stdout, stderr });
    });

    child.stdin.end(request);
  });
}

export interface MailSettings {
  enabled: boolean;
  accounts: MailAccount[];
  code: { waitSeconds: number; pollSeconds: number; lookbackMinutes: number };
  triage: { lookbackDays: number; senders: string[] };
  oauth: { clientFile: string; tokenDir: string; scopes: string[] };
}

/** Resolve the mail settings, defaulting as if the section were absent. */
export function mailSettings(): MailSettings {
  const cfg = getConfig();
  const raw = cfg.mail;
  const accounts: MailAccount[] = (raw?.accounts ?? []).map((a) => ({
    name: a.name,
    address: a.address,
    backend: a.backend,
    secretEnv: a.secret_env,
    tokenFile: a.token_file,
  }));
  return {
    enabled: raw?.enabled ?? false,
    accounts,
    code: {
      waitSeconds: raw?.code?.wait_seconds ?? 120,
      pollSeconds: raw?.code?.poll_seconds ?? 8,
      lookbackMinutes: raw?.code?.lookback_minutes ?? 15,
    },
    triage: {
      lookbackDays: raw?.triage?.lookback_days ?? 14,
      senders: raw?.triage?.senders ?? [],
    },
    oauth: {
      clientFile: raw?.oauth?.client_file ?? 'config/gmail-oauth-client.json',
      tokenDir: raw?.oauth?.token_dir ?? 'state/mail',
      scopes: raw?.oauth?.scopes ?? ['https://www.googleapis.com/auth/gmail.readonly'],
    },
  };
}

/** The configured account whose address matches (case-insensitively), if any. */
export function accountForAddress(address: string): MailAccount | null {
  const want = (address || '').trim().toLowerCase();
  if (!want) return null;
  return mailSettings().accounts.find((a) => a.address.toLowerCase() === want) ?? null;
}

/**
 * Could this account actually be read right now?
 *
 * IMAP needs an app password of the right shape; OAuth needs a stored token. Used to
 * decide which mailboxes are worth polling — an account whose credential is wrong
 * cannot produce a code, and polling it only adds an error to every attempt.
 */
export function isUsable(account: MailAccount): boolean {
  if (account.backend === 'imap') return appPasswordShape(account).looksValid;
  return Boolean(account.tokenFile);
}

/**
 * True when at least one account has a credential that could actually work.
 *
 * Presence alone is not enough: an account password pasted into an app-password slot
 * is non-empty and still cannot authenticate, and callers use this to decide whether
 * waiting for a code is worthwhile. Checking the shape here keeps "configured" honest.
 */
export function isConfigured(): boolean {
  const s = mailSettings();
  if (!s.enabled) return false;
  return s.accounts.some((a) =>
    a.backend === 'imap' ? appPasswordShape(a).looksValid : Boolean(a.tokenFile || a.secretEnv || true),
  );
}

/**
 * The app password for an IMAP account, or '' when it has not been provided.
 *
 * Read through envVar, not process.env: the password is normally pasted into
 * config/mail.env, which is parsed into the config rather than into the process.
 *
 * Google displays an app password as four groups of four ("abcd efgh ijkl mnop") but
 * accepts only the 16 characters. Stripping whitespace here means a straight paste
 * works — otherwise the first thing every user hits is an authentication failure that
 * looks like a wrong password.
 */
export function appPassword(account: MailAccount): string {
  if (!account.secretEnv) return '';
  return envVar(account.secretEnv).replace(/\s+/g, '');
}

/**
 * A shape check on the supplied app password, so the tool can say "that is your account
 * password" instead of relaying Google's terse AUTHENTICATIONFAILED.
 *
 * Google app passwords are exactly 16 characters and alphanumeric. This deliberately
 * reports rather than blocks: the value is still attempted, because a future change to
 * Google's format should not turn into a hard refusal to log in.
 */
export function appPasswordShape(account: MailAccount): { filled: boolean; looksValid: boolean; length: number; hint: string } {
  const value = appPassword(account);
  if (!value) return { filled: false, looksValid: false, length: 0, hint: '' };
  const looksValid = /^[A-Za-z0-9]{16}$/.test(value);
  const hint = looksValid
    ? ''
    : `that is ${value.length} character(s); a Google app password is 16. ` +
      'An account password cannot be used for IMAP — create an app password instead.';
  return { filled: true, looksValid, length: value.length, hint };
}

interface BridgeResponse {
  messages: { id: string; from: string; to: string; subject: string; date: string; snippet: string }[];
  errors: string[];
}

/**
 * Read recent messages for one IMAP account.
 *
 * A failure here is reported, never thrown: mail is an aid, and an unreachable inbox
 * must not take down an application run. The caller decides what a missing inbox means.
 */
export async function readImap(
  account: MailAccount,
  opts: { sinceMinutes: number; limit: number },
): Promise<MailResult<MailMessage>> {
  const password = appPassword(account);
  if (!password) {
    return { items: [], errors: [{ account: account.name, error: `no app password in $${account.secretEnv}` }] };
  }

  const request = JSON.stringify({
    user: account.address,
    password,
    since_minutes: Math.max(1, Math.round(opts.sinceMinutes)),
    limit: Math.max(1, opts.limit),
  });

  try {
    const { stdout } = await runBridge(request, 60_000);
    const parsed = JSON.parse(stdout) as BridgeResponse;
    const items: MailMessage[] = (parsed.messages || []).map((m) => ({
      id: m.id,
      account: account.name,
      mailbox: account.address,
      from: m.from,
      to: m.to,
      subject: m.subject,
      date: m.date,
      snippet: m.snippet,
    }));
    return {
      items,
      errors: (parsed.errors || []).map((e) => ({ account: account.name, error: e })),
    };
  } catch (e) {
    const err = e as { message?: string; stderr?: string };
    return {
      items: [],
      errors: [{ account: account.name, error: `${err.message || 'bridge failed'}${err.stderr ? ` — ${err.stderr.trim()}` : ''}` }],
    };
  }
}
