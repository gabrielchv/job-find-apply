// Read the applicant's inboxes from the command line.
//
//   npm run mail -- check                     which accounts are readable, and why not
//   npm run mail -- inbox [--days 14]         recent job mail, most actionable first
//   npm run mail -- codes [--minutes 30]      codes found in recent mail
//   npm run mail -- search "entrevista"       free-text search across both inboxes
//   npm run mail -- auth personal             one-time OAuth consent for an account
//
// Read-only throughout. Nothing here sends, labels, archives or deletes.
import { Mailer, KIND_LABEL, accountForAddress, mailSettings } from '../mail/index.js';
import { extractCodes } from '../mail/codes.js';
import { authorize, hasOAuthClient, tokenPath } from '../mail/gmail.js';
import { appPasswordShape } from '../mail/accounts.js';
import type { MailAccount } from '../mail/types.js';

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function flag(name: string): boolean {
  return process.argv.includes(name);
}

function short(iso: string): string {
  if (!iso) return '?';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function trim(s: string, n: number): string {
  const t = (s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** Explain, per account, whether this machine can actually read it. */
async function check(): Promise<void> {
  const settings = mailSettings();
  console.log(`Mail enabled: ${settings.enabled ? 'yes' : 'no'} (config/settings.yaml -> mail.enabled)\n`);
  if (!settings.accounts.length) {
    console.log('No accounts configured.');
    return;
  }

  for (const account of settings.accounts) {
    console.log(`${account.name} — ${account.address} [${account.backend}]`);
    if (account.backend === 'imap') {
      const shape = appPasswordShape(account);
      if (!shape.filled) {
        console.log(`  ✗ no app password. Add ${account.secretEnv}=… to config/mail.env`);
        console.log('    Google Account -> Security -> 2-Step Verification -> App passwords.');
        console.log('    If Google says that setting is unavailable for this account, see the');
        console.log('    "app passwords are unavailable" note in config/mail.env.');
        continue;
      }
      // Say what is wrong before spending a network round trip on a login that cannot
      // succeed: Google's own reply ("invalid credentials") does not distinguish a
      // wrong password from a password of the wrong kind.
      if (!shape.looksValid) {
        console.log(`  ✗ ${shape.hint}`);
        console.log('     Generate one at https://myaccount.google.com/apppasswords (needs 2FA on).');
        console.log('     If that page says the setting is not available for this account, app');
        console.log('     passwords are blocked there (2FA off, or Advanced Protection enrolled).');
        console.log('     Either turn 2FA on, or switch this account to the oauth backend.');
      }
      const { items, errors } = await new Mailer([account]).recent({ since: new Date(Date.now() - 3600_000), limit: 3 });
      if (errors.length) {
        console.log(`  ✗ ${errors[0].error}`);
        // The two ways an app password fails look identical in the server's reply.
        if (/AUTHENTICATIONFAILED|Invalid credentials/i.test(errors[0].error)) {
          console.log('     That password was rejected. Common causes: it was revoked, it is an');
          console.log('     account password instead of an app password, or 2-Step Verification is off.');
        }
      } else {
        console.log(`  ✓ readable — ${items.length} message(s) in the last hour`);
      }
    } else {
      if (!hasOAuthClient()) {
        console.log('  ✗ no OAuth client at config/gmail-oauth-client.json');
        console.log('    Create a Desktop OAuth client (Gmail API enabled) and save its JSON there.');
        continue;
      }
      const file = tokenPath(account);
      const { items, errors } = await new Mailer([account]).recent({ since: new Date(Date.now() - 3600_000), limit: 3 });
      if (errors.length) {
        console.log(`  ✗ ${errors[0].error}`);
        console.log(`    If no token exists yet: npm run mail -- auth ${account.name}`);
        continue;
      }
      console.log(`  ✓ readable via ${file} — ${items.length} message(s) in the last hour`);
    }
    console.log('');
  }
}

async function auth(): Promise<void> {
  const name = process.argv[3];
  const settings = mailSettings();
  const account = settings.accounts.find((a) => a.name === name);
  if (!account) {
    console.error(`Unknown account "${name || ''}". Configured: ${settings.accounts.map((a) => a.name).join(', ') || 'none'}`);
    process.exit(1);
  }
  if (account.backend !== 'oauth') {
    console.error(`Account "${account.name}" uses the imap backend — it needs an app password, not OAuth consent.`);
    console.error(`Add ${account.secretEnv}=… to config/mail.env instead.`);
    process.exit(1);
  }
  console.log(`Authorizing ${account.address} (${settings.oauth.scopes.join(' ')})`);
  try {
    await authorize(account, { openBrowser: !flag('--no-browser') });
  } catch (e) {
    // A missing or malformed client file is a setup mistake, not a crash: print the
    // instruction, not a stack trace.
    console.error(`\n${(e as Error).message}`);
    process.exit(1);
  }
  console.log(`\nSaved ${tokenPath(account)}. Verify with: npm run mail -- check`);
}

async function inbox(): Promise<void> {
  const days = Number(arg('--days') || mailSettings().triage.lookbackDays);
  const accountArg = arg('--account');
  const mailer = new Mailer();
  const { items, errors } = await mailer.triage({ days, account: accountArg, limit: Number(arg('--limit') || 60) });

  if (errors.length) {
    for (const e of errors) console.error(`mail ${e.account}: ${e.error}`);
    if (!items.length) {
      console.error('\nNothing could be read. Run `npm run mail -- check` for the setup step.');
      process.exit(1);
    }
  }
  if (!items.length) {
    console.log(`No job mail in the last ${days} day(s).`);
    return;
  }

  console.log(`Job mail, last ${days} day(s) — most actionable first\n`);
  for (const m of items) {
    const tag = KIND_LABEL[m.kind].padEnd(20);
    console.log(`${tag} ${short(m.date)}  ${trim(m.from, 34)}`);
    console.log(`${' '.repeat(21)}${trim(m.subject, 90)}`);
    if (m.action) console.log(`${' '.repeat(21)}→ ${m.action}`);
  }
  console.log(`\n${items.length} message(s).`);
}

async function codes(): Promise<void> {
  const minutes = Number(arg('--minutes') || mailSettings().code.lookbackMinutes);
  const mailer = new Mailer();
  const { items, errors } = await mailer.recent({ since: new Date(Date.now() - minutes * 60_000), limit: 30 });
  for (const e of errors) console.error(`mail ${e.account}: ${e.error}`);

  const found = items.flatMap((m) => extractCodes(m, { minConfidence: 0 }));
  if (!found.length) {
    console.log(`No code-shaped token in the last ${minutes} minute(s).`);
    return;
  }
  console.log(`Codes in the last ${minutes} minute(s):\n`);
  for (const c of found.sort((a, b) => b.confidence - a.confidence)) {
    console.log(`${c.code.padEnd(10)} ${String(c.confidence).padStart(3)}%  ${c.shape.padEnd(9)} ${short(c.message.date)}  ${trim(c.message.mailbox, 28)}`);
    console.log(`${' '.repeat(15)}${trim(c.message.subject, 90)}`);
  }
}

async function search(): Promise<void> {
  const text = arg('--text') || process.argv[3];
  if (!text) {
    console.error('usage: npm run mail -- search "some words"');
    process.exit(2);
  }
  const mailer = new Mailer();
  const { items, errors } = await mailer.recent({
    since: new Date(Date.now() - Number(arg('--days') || 30) * 86_400_000),
    text,
    limit: Number(arg('--limit') || 30),
  });
  for (const e of errors) console.error(`mail ${e.account}: ${e.error}`);
  if (!items.length) {
    console.log(`Nothing matching "${text}".`);
    return;
  }
  for (const m of items) {
    console.log(`${short(m.date)} [${m.account}] ${trim(m.from, 40)}`);
    console.log(`    ${trim(m.subject, 100)}`);
    console.log(`    ${trim(m.snippet, 160)}\n`);
  }
}

async function main(): Promise<void> {
  const command = process.argv[2] || 'check';
  switch (command) {
    case 'check':
      return check();
    case 'auth':
      return auth();
    case 'inbox':
      return inbox();
    case 'codes':
      return codes();
    case 'search':
      return search();
    case 'accounts': {
      const settings = mailSettings();
      for (const a of settings.accounts) console.log(`${a.name}\t${a.address}\t${a.backend}`);
      return;
    }
    default:
      console.error(`Unknown command "${command}". Try: check | inbox | codes | search | auth | accounts`);
      process.exit(2);
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});

// Referenced so the account type stays exported for callers of this module.
export type { MailAccount };
export { accountForAddress };
