// The runner: discover -> score -> shortlist -> apply, one job at a time, with a
// hard daily budget stop. Idempotent enough to resume after a crash.
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { discover } from '../discovery/index.js';
import { scoreJob, passes, type ScoreResult } from '../match/score.js';
import { loadProfile } from '../profile/index.js';
import { getConfig, llmOptions, ROOT } from '../config.js';
import { isConfigured as mailConfigured } from '../mail/index.js';

/**
 * Can an e-mailed verification code actually be read right now?
 *
 * Used to decide whether re-driving a mail-gated application is worth attempting.
 * Deliberately a configuration check, not a live inbox probe: the queue is built
 * before any browser work starts, and a network probe there would cost a cycle for
 * no benefit.
 */
function mailReadable(): boolean {
  return mailConfigured();
}
import { LlmClient } from '../llm/client.js';
import { openPersistentContext, isBrowserClosedError } from '../browser.js';
import { applyToJob } from '../apply/driver.js';
import { notify } from '../notify/desktop.js';
import { ensureGupyLogin } from '../auth/gupy.js';
import { isOffTarget } from '../gupy/portal.js';
import * as store from '../store/index.js';
import type { JobPosting } from '../types.js';
import { pace, sleep } from './pacing.js';

export interface RunOptions {
  headless?: boolean;
  dryRun?: boolean;
}

export interface RunCounts {
  discovered: number;
  scored: number;
  shortlisted: number;
  submitted: number;
  deferred: number;
  failed: number;
}

function logLine(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  try {
    appendFileSync(path.join(ROOT, 'state', 'daemon.log'), line);
  } catch {
    /* logging is best-effort */
  }
}

function msUntilNextDay(): number {
  const now = new Date();
  const next = new Date(now);
  next.setDate(now.getDate() + 1);
  next.setHours(0, 0, 0, 0);
  return next.getTime() - now.getTime() + 5000;
}

export async function runOnce(opts: RunOptions = {}): Promise<RunCounts> {
  const cfg = getConfig();
  const profile = loadProfile();
  const dryRun = opts.dryRun ?? cfg.apply.dry_run;
  const submit = cfg.apply.submit && !dryRun;

  const client = new LlmClient({ ...llmOptions(), onSpend: (usd) => store.addSpend(usd) });

  const counts: RunCounts = { discovered: 0, scored: 0, shortlisted: 0, submitted: 0, deferred: 0, failed: 0 };

  if (!cfg.env.apiKey) {
    console.error('No GEMINI_API_KEY (or DEEPSEEK_API_KEY). Add one to config/.env (see config/.env.example).');
    return counts;
  }

  const overBudget = () => store.spendToday() >= cfg.budget.capUsdPerDay;
  if (overBudget()) {
    console.log(`Budget cap reached for today (${store.spendToday().toFixed(4)} USD). Stopping.`);
    return counts;
  }

  const runId = store.startRun();

  console.log('Discovering…');
  const jobs = await discover(client);
  for (const j of jobs) store.upsertJob(j);
  counts.discovered = jobs.length;
  console.log(`Discovered ${jobs.length} jobs.`);

  for (const job of jobs) {
    if (overBudget()) {
      console.log('Budget cap reached during scoring. Stopping.');
      break;
    }
    if (counts.scored >= cfg.match.maxJobsPerRun) break;

    // Idempotency: only score jobs we have not already processed in an earlier
    // cycle (upsertJob marks brand-new jobs 'discovered'; everything else keeps
    // its terminal status). This is what stops the daemon re-applying to jobs
    // it already submitted to or skipped.
    const existing = store.getJob(job.id);
    if (existing && existing.status !== 'discovered') continue;

    const r = await scoreJob(client, job, profile.kb);
    counts.scored++;
    if (r.skipped) {
      store.setStatus(job.id, 'skipped');
      continue;
    }
    store.setScore(job.id, r.score, r.rationale, passes(r.score) ? 'shortlisted' : 'skipped');
    if (passes(r.score)) counts.shortlisted++;
  }
  console.log(`Scored ${counts.scored}, shortlisted ${counts.shortlisted}.`);

  // Apply to every job still pending, not just the ones this cycle produced: a
  // crash (or a manual restart) mid-apply used to strand the rest as 'shortlisted'
  // forever, and failed/needs_manual jobs were never retried. Re-queue all of them
  // so the daemon self-heals — a failed application is retried every cycle until
  // it submits or is genuinely deferred.
  //
  // Off-target roles are the exception. They entered the backlog before the
  // support/help-desk discovery terms were removed from settings.yaml, and the KB
  // says plainly that this work is not wanted. Retrying them every cycle would keep
  // submitting applications the candidate would decline, so they are retired to
  // 'skipped' here instead of being re-queued.
  const pendingRows = store.getJobsByStatuses(['shortlisted', 'failed', 'needs_manual', 'applying']);
  // `apply.include_off_target` opts support/help-desk roles back in. They are excluded
  // by default because the KB rules that work out, but the candidate may ask for them
  // explicitly; retirement is then skipped and they queue like any other job.
  const includeOffTarget = Boolean(cfg.apply.include_off_target);
  const retired = includeOffTarget ? [] : pendingRows.filter((r) => isOffTarget(r.title));
  for (const r of retired) store.setStatus(r.id, 'skipped');
  if (retired.length) {
    console.log(`Retired ${retired.length} off-target (support/help-desk) rows — the KB rules that work out.`);
  }

  const backlog = pendingRows
    .filter((r) => !isOffTarget(r.title))
    // Do not re-drive a step that cannot possibly succeed this cycle.
    //
    // Greenhouse answers a submit with a one-time code mailed to the candidate. When
    // the inboxes are unreadable, every retry just re-submits the same form and mails
    // another code nobody can read — the board sees repeated submissions and nothing
    // moves. Skip those until mail works; the job stays in needs_manual and shows up
    // in the next-steps report either way.
    .filter((r) => {
      if (mailReadable()) return true;
      const MAIL_GATE = /e-mailed a one-time code|verification code required/i;
      if (store.applicationReasonMatches(r.id, MAIL_GATE)) {
        console.log(`Skipping ${r.company} — ${r.title}: waiting on an e-mailed code and mail is not readable.`);
        return false;
      }
      return true;
    })
    // A row shortlisted before this rule existed can still hold a posting with no text.
    // Retire it instead of deferring it once per cycle forever.
    .filter((r) => {
      if ((r.description || '').trim().length < 80) {
        console.log(`Retiring ${r.company} — ${r.title}: no posting text to ground answers in.`);
        store.setStatus(r.id, 'skipped');
        return false;
      }
      return true;
    })
    // Never spend a second application on a role already submitted. The draft pass
    // logs under its own job id, so a stale status can survive a successful
    // submission; the attempt log cannot.
    .filter((r) => {
      if (store.alreadySubmitted(r.company, r.title)) {
        console.log(`Skipping ${r.company} — ${r.title}: already submitted (kept the status in step).`);
        store.setStatus(r.id, 'submitted');
        return false;
      }
      return true;
    })
    .map((r) => ({
    job: {
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
    } satisfies JobPosting,
    score: { skipped: false, skipReason: null, score: r.score ?? 0, rationale: r.rationale ?? '', stack: [] } satisfies ScoreResult,
  }));

  if (!backlog.length) {
    store.finishRun(runId, counts as unknown as Record<string, number>);
    return counts;
  }

  let context = await openPersistentContext({ headless: opts.headless });
  try {
    const login = await ensureGupyLogin(context);
    if (login.ok) {
      console.log('Gupy login OK (LinkedIn).');
    } else {
      console.log(`Gupy auto-login unavailable: ${login.reason}. Jobs needing login will be deferred.`);
    }

    for (const { job, score } of backlog) {
      if (overBudget()) {
        console.log('Budget cap reached during apply. Stopping.');
        break;
      }
      await pace();
      store.setStatus(job.id, 'applying');
      console.log(`Applying to ${job.title} @ ${job.company} (${job.apply_url})`);

      let outcome;
      try {
        outcome = await applyToJob(context, job, score, client, {
          dryRun,
          submit,
          attachResume: cfg.apply.attach_resume,
        });
      } catch (e) {
        outcome = { result: 'failed', reason: (e as Error).message, report: null };
      }

      // Browser crashed / was closed mid-run: re-open the persistent context,
      // re-login, and retry this job once instead of failing the rest.
      if (outcome.reason && isBrowserClosedError(outcome.reason)) {
        console.log('  ⚠ browser closed — reopening and retrying');
        await context.close().catch(() => {});
        context = await openPersistentContext({ headless: opts.headless });
        await ensureGupyLogin(context);
        try {
          outcome = await applyToJob(context, job, score, client, {
            dryRun,
            submit,
            attachResume: cfg.apply.attach_resume,
          });
        } catch (e) {
          outcome = { result: 'failed', reason: (e as Error).message, report: null };
        }
      }

      if (outcome.result === 'submitted') {
        counts.submitted++;
        store.setStatus(job.id, 'submitted');
        console.log(`  ✓ submitted`);
      } else if (outcome.result === 'posting_closed') {
        // Terminal: the posting is gone. Retrying it every cycle would burn pacing
        // and budget on a page that can never submit.
        store.setStatus(job.id, 'skipped');
        console.log(`  · posting closed`);
      } else if (outcome.result === 'already_applied') {
        store.setStatus(job.id, 'skipped');
        console.log(`  ✓ already applied`);
      } else if (outcome.result === 'needs_manual') {
        counts.deferred++;
        store.setStatus(job.id, 'needs_manual');
        notify('job_find_apply — action needed', `${job.title} @ ${job.company}: ${outcome.reason}`);
        console.log(`  ⚠ needs you: ${outcome.reason}`);
      } else if (outcome.result === 'deferred') {
        counts.deferred++;
        store.setStatus(job.id, 'needs_manual');
        if (!dryRun) notify('job_find_apply — deferred', `${job.title}: ${outcome.reason}`);
        console.log(`  — deferred: ${outcome.reason}`);
      } else {
        counts.failed++;
        store.setStatus(job.id, 'failed');
        console.log(`  ✗ failed: ${outcome.reason}`);
      }

      store.logApplication({
        job_id: job.id,
        url: job.apply_url,
        company: job.company,
        role: job.title,
        result: outcome.result === 'submitted' ? 'submitted' : outcome.result === 'failed' ? 'failed' : 'deferred',
        reason: outcome.reason || undefined,
        report: outcome.report ? JSON.stringify({ rows: outcome.report.rows, adapterId: outcome.report.adapterId }) : undefined,
      });
    }
  } finally {
    await context.close().catch(() => {});
    store.finishRun(runId, counts as unknown as Record<string, number>);
  }

  console.log(`\nRun complete: ${JSON.stringify(counts)}`);
  return counts;
}

export async function runDaemon(opts: RunOptions = {}): Promise<void> {
  const cfg = getConfig();
  logLine('daemon started — running non-stop until stopped');
  let cycle = 0;
  for (;;) {
    cycle++;
    logLine(`cycle ${cycle} starting`);
    try {
      const counts = await runOnce(opts);
      logLine(`cycle ${cycle} done: ${JSON.stringify(counts)}`);
    } catch (e) {
      logLine(`cycle ${cycle} crashed: ${(e as Error).message || String(e)}`);
    }

    if (store.spendToday() >= cfg.budget.capUsdPerDay) {
      const waitMs = msUntilNextDay();
      logLine(`budget cap reached today (${store.spendToday().toFixed(4)} USD). Sleeping ${Math.round(waitMs / 60000)} min until tomorrow.`);
      await sleep(waitMs);
      continue;
    }

    const intervalMs = (cfg.schedule.intervalHours || 6) * 3600_000 + Math.random() * 600_000;
    logLine(`cycle ${cycle} complete. Sleeping ${Math.round(intervalMs / 60000)} min before the next cycle.`);
    await sleep(intervalMs);
  }
}
