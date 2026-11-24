// One answer to "what should I do next?" — across Gupy, the other boards, and the inbox.
//
// The previous summary only knew about Gupy applications, so a test waiting on a sent
// application, a board form blocked on an e-mailed code, and an interview invite sitting
// in the inbox were three separate facts nobody had put in one place. This puts them in
// one ordered list and writes it to docs/NEXT-STEPS.md.
//
//   npm run next              refresh the summary (reads mail if configured)
//   npm run next -- --no-mail skip the inbox
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.js';
import { isConfigured as mailConfigured, mailSettings, Mailer, KIND_LABEL } from '../mail/index.js';
import * as store from '../store/index.js';

interface GupyResult {
  appId: string;
  company: string;
  role: string;
  location: string;
  appUrl: string;
  jobUrl: string | null;
  outcome: 'submitted' | 'already' | 'next_step' | 'expired' | 'needs_manual' | 'off_target' | 'failed' | 'skipped';
  reason: string;
  pending: { label: string; detail: string }[];
  hasAssessment: boolean;
}

interface Todo {
  /** 1 = needs you now, 2 = this week, 3 = optional cleanup. */
  priority: 1 | 2 | 3;
  kind: string;
  title: string;
  detail: string;
  url?: string;
  where?: string;
}

const RESULTS = path.join(ROOT, 'state', 'finish-results.json');
// The snapshot of the last complete portal walk. Preferred over RESULTS because that
// file is a merged history: it kept counting applications that had already left the
// portal, which inflated "already submitted" and the off-target list on every pass.
const LAST_FULL_PASS = path.join(ROOT, 'state', 'finish-last-full.json');
const OUT = path.join(ROOT, 'docs', 'NEXT-STEPS.md');

interface GupySnapshot {
  results: GupyResult[];
  /** Which file these came from, and how old it is — the counts are only as good as that. */
  source: 'snapshot' | 'history' | 'none';
  takenAt: Date | null;
}

function readGupy(): GupySnapshot {
  const file = existsSync(LAST_FULL_PASS) ? LAST_FULL_PASS : RESULTS;
  if (!existsSync(file)) return { results: [], source: 'none', takenAt: null };
  try {
    const results = JSON.parse(readFileSync(file, 'utf8')) as GupyResult[];
    return {
      results,
      source: file === LAST_FULL_PASS ? 'snapshot' : 'history',
      takenAt: statSync(file).mtime,
    };
  } catch {
    return { results: [], source: 'none', takenAt: null };
  }
}

function gupyTodos(results: GupyResult[]): Todo[] {
  const todos: Todo[] = [];
  for (const r of results) {
    if (r.outcome === 'next_step') {
      const step = r.pending[0];
      todos.push({
        priority: 1,
        kind: 'test',
        title: `${r.role} — ${r.company}`,
        detail: step ? `${step.label}: ${step.detail}` : 'a timed company test is waiting',
        url: r.appUrl,
        where: r.location,
      });
    } else if (r.outcome === 'needs_manual' || r.outcome === 'failed') {
      const why = r.pending.length ? r.pending.map((p) => `${p.label} (${p.detail})`).join('; ') : r.reason;
      todos.push({
        priority: 2,
        kind: 'unfinished',
        title: `${r.role} — ${r.company}`,
        detail: why,
        url: r.appUrl,
        where: r.location,
      });
    }
  }
  return todos;
}

/** Identity used to avoid listing one application twice across sources. */
function coverKey(company: string, role: string): string {
  const norm = (v: string) => String(v || '').replace(/\s+/g, ' ').trim().toLowerCase();
  return `${norm(company)}|${norm(role)}`;
}

function boardTodos(covered: Set<string>): Todo[] {
  // Applications the filler could not finish. A shortlisting that was never attempted
  // belongs here too — it sits in the store looking decided while nothing was sent.
  //
  // Gupy rows belong here as well. The portal snapshot only covers what `finish` walked;
  // an application that `run` deferred five minutes ago is in the store and nowhere
  // else, so excluding source==='gupy' made brand-new blocked applications invisible
  // until the next full portal pass. Anything the snapshot already describes is skipped
  // by the `covered` key, so nothing is listed twice.
  const stuck = store.getJobsByStatuses(['needs_manual', 'failed', 'applying', 'shortlisted']);
  return stuck
    .filter((j) => !covered.has(coverKey(j.company, j.title)))
    .map((j) => {
      // The status alone says "unfinished"; the attempt log says why, which is the
      // difference between a to-do entry and an instruction ("a code was mailed" vs
      // "the filler gave up").
      const last = store.latestApplication(j.id);
      const why = last?.reason ? last.reason : '';
      const detail =
        j.status === 'shortlisted' && !last
          ? 'scored well enough to apply, never actually submitted'
          : `${why || `filler stopped here (${j.status})`}${j.score ? ` · score ${j.score}` : ''}`;
      // A code waiting in an inbox is priority 1: it expires and the form starts over.
      const needsCode = /e-mailed a one-time code|verification code/i.test(why);
      return {
        priority: (needsCode ? 1 : 2) as 1 | 2,
        kind: needsCode ? 'code to enter' : j.status === 'shortlisted' ? 'not sent' : 'unfinished',
        title: `${j.title} — ${j.company}`,
        detail,
        url: j.apply_url,
        where: j.location,
      };
    });
}

async function mailTodos(): Promise<{ todos: Todo[]; errors: string[]; note: string }> {
  // Mail enabled but not credentialed is not "nothing to report" — it is a setup step
  // the applicant has not done yet, and the summary should say so rather than look
  // like it checked.
  if (!mailConfigured()) {
    const wanted = mailEnabledButUnconfigured();
    return {
      todos: [],
      errors: [],
      note: wanted
        ? `Mail is enabled but not readable yet (${wanted}). Run \`npm run mail -- check\`; until then an e-mailed code is left for you.`
        : 'Mail is off. An e-mailed code is left for you.',
    };
  }
  const mailer = new Mailer();
  const { items, errors } = await mailer.triage({ days: 14, limit: 60 });
  const todos: Todo[] = [];
  const seen = new Set<string>();

  for (const m of items) {
    // Only mail that implies an action belongs in a to-do list.
    if (!m.action) continue;
    // Job alerts are pure noise here; the discovery pass already handles them.
    if (m.kind === 'job_alert') continue;
    // A verification code is only actionable while it is still valid. Greenhouse codes
    // are single-use and short-lived, so one from hours ago is not a task — it is the
    // residue of a submission that already went through (the Brex code stayed on the
    // list for three hours after the application was confirmed).
    if (m.kind === 'verification_code') {
      const sent = Date.parse(m.date);
      const age = Date.now() - sent;
      if (Number.isFinite(age) && age > 30 * 60_000) continue;
      // A code is spent once the application it belongs to has been submitted. The
      // subject names the company ("Security code for your application to Brex"), so a
      // submission for that company landing after the mail proves the code was used —
      // which is how a three-hour-old Brex code kept appearing as "needs you now"
      // hours after the application was confirmed.
      const named = /application to (.+)$/i.exec(m.subject)?.[1]?.trim();
      if (named) {
        const submittedAt = store.lastSubmissionAt(named);
        if (submittedAt && Number.isFinite(sent) && submittedAt.getTime() > sent) continue;
      }
    }
    // One entry per company+kind: a thread of five reminders is still one task.
    const key = `${m.kind}|${m.from}`;
    if (seen.has(key)) continue;
    seen.add(key);
    todos.push({
      priority: m.kind === 'verification_code' || m.kind === 'assessment' || m.kind === 'offer' ? 1 : 2,
      kind: KIND_LABEL[m.kind],
      title: m.subject || '(no subject)',
      detail: `${m.action} · ${new Date(m.date).toLocaleString('pt-BR')} · ${m.mailbox}`,
      where: m.from,
    });
  }
  return { todos, errors: errors.map((e) => `${e.account}: ${e.error}`), note: '' };
}

/** Which accounts are configured but missing their credential. */
function mailEnabledButUnconfigured(): string {
  const settings = mailSettings();
  if (!settings.enabled || !settings.accounts.length) return '';
  const missing = settings.accounts.filter((a) => a.backend === 'imap' && !process.env[a.secretEnv || '']);
  if (!missing.length) return '';
  return missing.map((a) => `${a.name} needs ${a.secretEnv}`).join(', ');
}

function render(todos: Todo[], mailErrors: string[], gupy: GupyResult[], mailNote = '', snapshot?: GupySnapshot): string {
  const L: string[] = [];
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  L.push('# Next steps');
  L.push('');
  L.push(`Generated ${stamp} by \`npm run next\`.`);
  L.push('');

  const byPriority: Record<number, Todo[]> = { 1: [], 2: [], 3: [] };
  for (const t of todos) byPriority[t.priority].push(t);

  const heading: Record<number, string> = {
    1: '## Needs you now',
    2: '## This week',
    3: '## Optional cleanup',
  };

  if (!todos.length) {
    L.push('Nothing is waiting on you. `npm run run` will look for new postings.');
    L.push('');
  }

  for (const p of [1, 2, 3] as const) {
    const group = byPriority[p];
    if (!group.length) continue;
    L.push(heading[p]);
    L.push('');
    group.forEach((t, i) => {
      L.push(`${i + 1}. **${t.title}** — *${t.kind}*`);
      if (t.where) L.push(`   - ${t.where}`);
      L.push(`   - ${t.detail}`);
      if (t.url) L.push(`   - ${t.url}`);
      L.push('');
    });
  }

  const tests = gupy.filter((g) => g.outcome === 'next_step').length;
  const drafts = gupy.filter((g) => g.outcome === 'needs_manual' || g.outcome === 'failed').length;
  const sent = gupy.filter((g) => g.outcome === 'already').length;
  const offTarget = gupy.filter((g) => g.outcome === 'off_target').length;

  if (gupy.length) {
    L.push('## Gupy dashboard');
    L.push('');
    L.push(`- ${sent} application(s) already with the company`);
    L.push(`- ${tests} waiting on a timed company test`);
    L.push(`- ${drafts} unfinished`);
    L.push(`- ${offTarget} support/help-desk draft(s) left alone on purpose`);
    L.push('');
    if (snapshot?.source === 'history') {
      // Be explicit rather than quietly wrong: the history file is a merge of every
      // pass, so it still counts applications that have since left the portal.
      const when = snapshot.takenAt ? snapshot.takenAt.toISOString().slice(0, 16).replace('T', ' ') : 'unknown';
      L.push(
        `> These counts come from the merged history (last written ${when}), not a fresh portal ` +
          'walk, so they may include applications that are no longer in progress. ' +
          'Run `npm run finish` for an exact snapshot.',
      );
      L.push('');
    }
  }

  if (mailErrors.length) {
    L.push('## Mail could not be read');
    L.push('');
    for (const e of mailErrors) L.push(`- ${e}`);
    L.push('');
    L.push('Fix with `npm run mail -- check`, then rerun this summary.');
    L.push('');
  }

  if (mailNote) {
    L.push('## Mail');
    L.push('');
    L.push(mailNote);
    L.push('');
  }

  return L.join('\n');
}

async function main(): Promise<void> {
  const useMail = !process.argv.includes('--no-mail');
  const gupy = readGupy();
  const mail = useMail ? await mailTodos() : { todos: [], errors: [], note: 'Skipped (--no-mail).' };

  const covered = new Set(gupy.results.map((r) => coverKey(r.company, r.role)));
  // A board also mails about a step the portal already shows ("Teste Técnico Lógica &
  // SQL desbloqueada para a vaga Analista de Suporte Técnico" next to the Attus
  // application). The mail entry adds nothing when its subject names a company that
  // already has a to-do on the portal.
  const coveredNames = new Set(
    [
      ...gupy.results.map((r) => String(r.company || '')),
      // Boards name the ROLE in a step notification ("…desbloqueada para a vaga Analista
      // de Suporte Técnico"), not the company, so role titles have to count too.
      ...gupy.results.map((r) => String(r.role || '')),
    ]
      .map((v) => v.toLowerCase().trim())
      .filter((v) => v.length >= 6),
  );
  const mailOnly = mail.todos.filter((t) => {
    const text = `${t.title} ${t.where || ''}`.toLowerCase();
    return ![...coveredNames].some((name) => text.includes(name));
  });
  const todos = [...gupyTodos(gupy.results), ...boardTodos(covered), ...mailOnly].sort(
    (a, b) => a.priority - b.priority,
  );
  const md = render(todos, mail.errors, gupy.results, mail.note, gupy);

  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, md);

  // Console: just the actionable part, so it reads like an answer, not a document.
  const now = todos.filter((t) => t.priority === 1);
  const week = todos.filter((t) => t.priority === 2);
  console.log(`\n${now.length + week.length} thing(s) need you.\n`);
  if (now.length) {
    console.log('Needs you now:');
    for (const t of now) {
      console.log(`  • [${t.kind}] ${t.title}`);
      console.log(`    ${t.detail}`);
      if (t.url) console.log(`    ${t.url}`);
    }
    console.log('');
  }
  if (week.length) {
    console.log('This week:');
    for (const t of week) {
      console.log(`  • [${t.kind}] ${t.title}`);
      console.log(`    ${t.detail}`);
      if (t.url) console.log(`    ${t.url}`);
    }
    console.log('');
  }
  for (const e of mail.errors) console.error(`mail ${e}`);
  if (mail.note) console.log(mail.note);
  console.log(`Written to ${path.relative(ROOT, OUT)}`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
