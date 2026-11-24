#!/usr/bin/env node
// CLI entry point.
import { Command } from 'commander';
import { getConfig, llmOptions } from '../config.js';
import { discover } from '../discovery/index.js';
import { loadProfile } from '../profile/index.js';
import { LlmClient } from '../llm/client.js';
import { scoreJob, passes } from '../match/score.js';
import { runOnce, runDaemon } from '../schedule/runner.js';
import { openPersistentContext } from '../browser.js';
import { applyToJob } from '../apply/driver.js';
import { ensureGupyLogin } from '../auth/gupy.js';
import * as store from '../store/index.js';
import type { JobPosting } from '../types.js';

const program = new Command();
program.name('job_find_apply').description('Autonomous job search + apply agent').version('0.1.0');

program
  .command('discover')
  .description('fetch jobs from Gupy + greenhouse and print them')
  .action(async () => {
    const cfg = getConfig();
    const client = new LlmClient(llmOptions());
    const jobs = await discover(cfg.env.apiKey ? client : undefined);
    for (const j of jobs) console.log(`${j.id}\t${j.title} @ ${j.company} — ${j.location}\t${j.apply_url}`);
    console.log(`\n${jobs.length} jobs`);
  });

program
  .command('match')
  .description('discover + score, print the shortlist')
  .action(async () => {
    const cfg = getConfig();
    const profile = loadProfile();
    const client = new LlmClient(llmOptions());
    if (!cfg.env.apiKey) {
      console.error('No GEMINI_API_KEY (or DEEPSEEK_API_KEY). Add one to config/.env.');
      process.exit(1);
    }
    const jobs = await discover(client);
    console.log(`Scoring ${jobs.length} jobs…`);
    let n = 0;
    for (const job of jobs) {
      if (n >= cfg.match.maxJobsPerRun) break;
      const r = await scoreJob(client, job, profile.kb);
      n++;
      const mark = r.skipped ? 'skip' : passes(r.score) ? `HIT ` : 'miss';
      console.log(`${mark} ${String(r.score).padStart(3)}  ${job.title} @ ${job.company} — ${job.location}`);
      console.log(`      ${r.rationale}`);
    }
  });

program
  .command('apply')
  .description('apply to a single URL (dry-run by default; --submit actually submits, respecting the gate)')
  .argument('<url>')
  .option('--headless', 'run headless', false)
  .option('--submit', 'actually submit the application', false)
  .action(async (url: string, opts: { headless: boolean; submit: boolean }) => {
    const cfg = getConfig();
    const profile = loadProfile();
    const client = new LlmClient(llmOptions());
    const source = /gupy/i.test(url) ? 'gupy' : /lever\.co/i.test(url) ? 'lever' : /ashbyhq/i.test(url) ? 'ashby' : 'greenhouse';
    const job: JobPosting = {
      id: `manual:${url}`,
      title: '',
      company: '',
      location: '',
      description: '',
      apply_url: url,
      source,
      posted_at: null,
      deadline: null,
      remote: false,
      workplace_type: null,
      seniority_hint: null,
    };
    const score = { skipped: false, skipReason: null, score: 0, rationale: '', stack: [] };
    const context = await openPersistentContext({ headless: opts.headless });
    try {
      if (source === 'gupy') {
        const login = await ensureGupyLogin(context);
        console.log(login.ok ? 'Gupy login OK (LinkedIn).' : `Gupy auto-login unavailable: ${login.reason}`);
      }
      const outcome = await applyToJob(context, job, score, client, {
        dryRun: !opts.submit,
        submit: opts.submit,
        attachResume: cfg.apply.attach_resume,
      });
      console.log(`result: ${outcome.result} — ${outcome.reason}`);
      if (outcome.report) {
        console.log(`\nATS: ${outcome.report.adapterId}  lang: ${outcome.report.lang}  assessment: ${outcome.report.hasAssessment}`);
        console.log(`resume: ${outcome.report.resume.ok ? 'attached' : outcome.report.resume.reason || 'not attached'}`);
        console.log(`errors: ${outcome.report.errors.join(' | ') || 'none'}`);
        console.log('\nFields:');
        for (const r of outcome.report.rows) {
          const flag = r.status === 'filled' ? '✓' : r.status === 'review' ? '~' : r.status === 'failed' ? '✗' : ' ';
          console.log(` ${flag} [${r.status}] ${r.label}${r.required ? ' *' : ''}${r.value ? ` => "${String(r.value).slice(0, 40)}"` : ''}${r.detail ? ` — ${r.detail}` : ''}`);
        }
      }
    } finally {
      await context.close().catch(() => {});
    }
  });

program
  .command('run')
  .description('one full discovery + score + apply cycle')
  .option('--headless', 'run headless', false)
  .option('--dry-run', 'never submit', false)
  .action(async (opts: { headless: boolean; dryRun: boolean }) => {
    await runOnce({ headless: opts.headless, dryRun: opts.dryRun });
  });

program
  .command('daemon')
  .description('run discovery + score + apply non-stop, cycling forever (ctrl-c to stop)')
  .option('--headless', 'run headless', false)
  .option('--dry-run', 'never submit', false)
  .action(async (opts: { headless: boolean; dryRun: boolean }) => {
    await runDaemon({ headless: opts.headless, dryRun: opts.dryRun });
  });

program
  .command('status')
  .description('show stored job counts and today\'s spend')
  .action(() => {
    const cfg = getConfig();
    for (const s of ['discovered', 'shortlisted', 'applying', 'submitted', 'needs_manual', 'failed', 'skipped'] as const) {
      console.log(`${s.padEnd(14)} ${store.countByStatus(s)}`);
    }
    console.log(`\nspend today: $${store.spendToday().toFixed(4)} / cap $${cfg.budget.capUsdPerDay}`);
  });

program
  .command('login')
  .description('log in to Gupy via LinkedIn automatically; falls back to a headed window if a security check blocks it')
  .option('--timeout-min <n>', 'minutes to keep the manual window open', '30')
  .action(async (opts: { timeoutMin: string }) => {
    const context = await openPersistentContext({ headless: true });
    const auto = await ensureGupyLogin(context);
    await context.close().catch(() => {});

    if (auto.ok) {
      console.log('\nGupy login OK via LinkedIn. Session is live for this run.');
      return;
    }

    console.log(`\nAuto-login unavailable: ${auto.reason}`);
    console.log('Opening a headed Chromium so you can log in manually (LinkedIn -> Google). Close the window when done.\n');
    const ctx = await openPersistentContext({ headless: false });
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto('https://login.gupy.io/candidates/signin', { waitUntil: 'domcontentloaded' });
    const deadline = Date.now() + Number(opts.timeoutMin) * 60000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      if (ctx.pages().length === 0) break;
    }
    await ctx.close().catch(() => {});
    console.log('\nDone.\n');
  });

program.parse();
