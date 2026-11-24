// Resume and complete applications that are stuck in the local store: a saved Gupy
// draft, or a board (greenhouse / lever / ashby) application the filler could not
// finish. Reuses the apply driver, so the same submit gate decides what is sent.
//
// A Gupy draft is entered from the job page ("Candidatar-se"); Gupy then resumes
// the existing draft ("vamos continuar sua candidatura"). Other boards are entered
// from the stored apply_url directly.
//
// Usage:
//   tsx src/cli/resume.ts                       # stuck Gupy applications
//   tsx src/cli/resume.ts --source all          # every board
//   tsx src/cli/resume.ts --only gh:8045173003  # one job id
//   tsx src/cli/resume.ts --headless --dry-run
//   tsx src/cli/resume.ts --source all --hold   # park on an e-mailed-code gate
//   tsx src/cli/resume.ts --source all --no-mail # never read the inboxes
import { openPersistentContext, isBrowserClosedError } from '../browser.js';
import { ensureGupyLogin } from '../auth/gupy.js';
import { applyToJob } from '../apply/driver.js';
import { Mailer, isConfigured as mailConfigured } from '../mail/index.js';
import { getConfig, llmOptions } from '../config.js';
import { LlmClient } from '../llm/client.js';
import * as store from '../store/index.js';
import type { JobPosting } from '../types.js';
import type { ScoreResult } from '../match/score.js';

const HEADLESS = false;

// Statuses that mean "this application is not finished". `shortlisted` belongs here
// because a job can be shortlisted and then never actually attempted — it sat in the
// store looking decided while nothing had been sent.
const STUCK = ['failed', 'needs_manual', 'applying', 'shortlisted'] as const;

function parseArgs(argv: string[]) {
  const val = (f: string) => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    source: (val('--source') || 'gupy').toLowerCase(),
    only: (val('--only') || '').split(',').map((s) => s.trim()).filter(Boolean),
    headless: argv.includes('--headless'),
    dryRun: argv.includes('--dry-run'),
    verbose: argv.includes('--verbose'),
    // Keep the filled page in front of the candidate when a board asks for an e-mailed
    // one-time code. Implies a headed browser — a window you cannot see is no help.
    hold: argv.includes('--hold'),
    holdMinutes: Number(val('--hold-minutes') || 15),
    // Mail is on by default when an account is configured: it is the whole point of
    // having it. --no-mail keeps a run from touching any inbox.
    mail: !argv.includes('--no-mail'),
    limit: Number(val('--limit') || 0),
  };
}

function toPosting(r: any): JobPosting {
  return {
    id: r.id,
    source: r.source as JobPosting['source'],
    title: r.title,
    company: r.company,
    location: r.location,
    remote: false,
    workplace_type: null,
    description: r.description,
    apply_url: r.apply_url,
    posted_at: r.posted_at,
    deadline: null,
    seniority_hint: null,
  };
}

function toScore(r: any): ScoreResult {
  return { skipped: false, skipReason: null, score: r.score ?? 0, rationale: r.rationale ?? '', stack: [] };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = getConfig();
  const client = new LlmClient({ ...llmOptions(), onSpend: (usd) => store.addSpend(usd) });

  const all = store.getJobsByStatuses([...STUCK]);
  const jobs = all
    .filter((r) => (args.source === 'all' ? true : r.source === args.source))
    .filter((r) => (args.only.length ? args.only.includes(r.id) : true))
    // A posting with little text cannot ground an answer, and the model would have to
    // invent one. Skip it here; it stays in the store for a later attempt.
    .filter((r) => (r.description || '').trim().length >= 80)
    .slice(0, args.limit || undefined);

  const filtered = all.length - jobs.length;
  console.log(`Resuming ${jobs.length} stuck ${args.source} application(s)${filtered ? ` (${filtered} filtered out)` : ''}.`);
  if (!jobs.length) return;

  const wantMail = args.mail;
  const mailer = wantMail && mailConfigured() ? new Mailer() : null;
  if (mailer) {
    const names = mailer.accounts.map((a) => `${a.name} <${a.address}>`).join(', ');
    console.log(`Mail: reading ${names} for one-time codes.`);
  } else if (wantMail) {
    // Enabled in config but missing a credential: say which, rather than silently
    // behaving like a run that was told not to read mail.
    console.log('Mail: not readable yet — run `npm run mail -- check` to see what is missing.');
    console.log('      Until then an e-mailed code is left for you (add --hold to type it here).');
  } else {
    console.log('Mail: off (--no-mail) — an e-mailed code will be left for you (use --hold to type it here).');
  }

  let ctx = await openPersistentContext({ headless: args.hold ? false : args.headless || HEADLESS });
  try {
    const needsGupy = jobs.some((j) => j.source === 'gupy');
    let login = needsGupy ? await ensureGupyLogin(ctx) : { ok: true, reason: undefined as string | undefined };
    if (!login.ok) {
      console.error(`Gupy login failed: ${login.reason}`);
      process.exit(1);
    }
    if (needsGupy) console.log('Gupy login OK.');

    let done = 0;
    for (const rec of jobs) {
      const job = toPosting(rec);
      const score = toScore(rec);
      store.setStatus(job.id, 'applying');
      console.log(`\n[${++done}/${jobs.length}] ${job.company} — ${job.title}`);

      const run = () =>
        applyToJob(ctx, job, score, client, {
          dryRun: args.dryRun,
          submit: !args.dryRun,
          attachResume: cfg.apply.attach_resume,
          holdForVerificationMs: args.hold ? args.holdMinutes * 60_000 : undefined,
          mailer: mailer ?? undefined,
        });

      let outcome;
      try {
        outcome = await run();
      } catch (e) {
        outcome = { result: 'failed' as const, reason: (e as Error).message, report: null };
      }

      // The browser crashed / was closed mid-run. Re-open the persistent context,
      // re-establish the login, and retry this job ONCE so one crash does not
      // silently skip every remaining application.
      if (outcome.reason && isBrowserClosedError(outcome.reason)) {
        console.log('  ⚠ browser closed — reopening and retrying this job');
        await ctx.close().catch(() => {});
        ctx = await openPersistentContext({ headless: args.hold ? false : args.headless || HEADLESS });
        if (needsGupy) {
          login = await ensureGupyLogin(ctx);
          if (!login.ok) {
            console.error(`Re-login failed after crash: ${login.reason}. Aborting.`);
            process.exit(1);
          }
        }
        try {
          outcome = await run();
        } catch (e) {
          outcome = { result: 'failed' as const, reason: (e as Error).message, report: null };
        }
      }

      // A closed posting is not a failure: there is nothing to retry and nothing for the
      // candidate to do. Marking it 'failed' kept it in the stuck queue forever, so every
      // run spent time re-visiting a vacancy that no longer exists.
      if (outcome.result === 'submitted') store.setStatus(job.id, 'submitted');
      else if (outcome.result === 'already_applied' || outcome.result === 'posting_closed') store.setStatus(job.id, 'skipped');
      else if (outcome.result === 'needs_manual' || outcome.result === 'deferred') store.setStatus(job.id, 'needs_manual');
      else store.setStatus(job.id, 'failed');

      store.logApplication({
        job_id: job.id,
        url: job.apply_url,
        company: job.company,
        role: job.title,
        result: outcome.result === 'submitted' ? 'submitted' : outcome.result === 'failed' ? 'failed' : 'deferred',
        reason: outcome.reason || undefined,
        report: outcome.report ? JSON.stringify({ rows: outcome.report.rows, adapterId: outcome.report.adapterId }) : undefined,
      });

      console.log(`  -> ${outcome.result}${outcome.reason ? ': ' + outcome.reason : ''}`);
      if (outcome.report) {
        const rows = args.verbose ? outcome.report.rows : outcome.report.rows.filter((r) => r.required);
        for (const r of rows) {
          if (r.preset) continue;
          const mark = r.status === 'filled' ? '✓' : r.status === 'review' ? '~' : r.status === 'failed' ? '✗' : ' ';
          const isGap = r.required && (r.status === 'blank' || r.status === 'failed' || r.status === 'skipped');
          if (!args.verbose && !isGap) continue;
          console.log(
            `     ${mark} [${r.status}] ${r.label}${r.required ? ' *' : ''}` +
              `${r.value ? ` => "${String(r.value).slice(0, 50)}"` : ''}${r.detail ? ` — ${r.detail}` : ''}`,
          );
        }
        if (outcome.report.errors.length) console.log(`     errors: ${outcome.report.errors.join(' | ')}`);
      }

      const pause = cfg.schedule.minDelayMs + Math.random() * (cfg.schedule.maxDelayMs - cfg.schedule.minDelayMs);
      if (!args.dryRun) await new Promise((r) => setTimeout(r, pause));
    }
  } finally {
    await ctx.close().catch(() => {});
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
