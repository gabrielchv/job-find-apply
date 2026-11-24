// Finish every Gupy application that is still a draft.
//
// The portal is the source of truth, not the local DB: an application whose
// curriculum step still says "Começar" was never submitted, whatever the DB last
// recorded. This command walks the portal, resumes each draft headlessly, fills it
// from the KB and the posting, and submits behind the normal gate. Whatever it
// cannot finish is collected into a short markdown file with the exact step and
// link, so the manual work is a few clicks instead of an investigation.
//
// Usage:
//   tsx src/cli/finish.ts [--dry-run] [--limit N] [--only appId,appId]
//                          [--include-off-target] [--rescan] [--headless]
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { getConfig, llmOptions, ROOT } from '../config.js';
import { openPersistentContext } from '../browser.js';
import { ensureGupyLogin } from '../auth/gupy.js';
import { applyToJob } from '../apply/driver.js';
import { LlmClient } from '../llm/client.js';
import * as store from '../store/index.js';
import {
  inspectApplication,
  isOffTarget,
  listApplications,
  readJobPosting,
  type ApplicationInfo,
  type PortalCard,
} from '../gupy/portal.js';
import type { JobPosting } from '../types.js';
import type { FillReport } from '../apply/driver.js';

interface Result {
  appId: string;
  company: string;
  role: string;
  location: string;
  workModel: string;
  appUrl: string;
  jobUrl: string | null;
  outcome: 'submitted' | 'already' | 'next_step' | 'expired' | 'needs_manual' | 'off_target' | 'failed' | 'skipped';
  reason: string;
  /** Required fields the bot could not answer, and why — this IS the manual task. */
  pending: { label: string; detail: string }[];
  hasAssessment: boolean;
}

const RESULTS_FILE = path.join(ROOT, 'state', 'finish-results.json');
// Every pass merges into RESULTS_FILE so a --only run never loses what other passes
// learned. That makes RESULTS_FILE a history, not a snapshot — so a full pass also
// writes its own snapshot here, and anything that wants to describe the dashboard
// ("53 submitted, 4 awaiting a test") reads this instead of the accumulated history.
export const LAST_FULL_PASS_FILE = path.join(ROOT, 'state', 'finish-last-full.json');

function parseArgs(argv: string[]) {
  const has = (f: string) => argv.includes(f);
  const val = (f: string) => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    dryRun: has('--dry-run'),
    includeOffTarget: has('--include-off-target'),
    rescan: has('--rescan'),
    inventory: has('--inventory'),
    limit: Number(val('--limit') || 0),
    only: (val('--only') || '').split(',').map((s) => s.trim()).filter(Boolean),
  };
}

// The posting text a draft must be grounded in. Prefer the live job page; fall
// back to whatever the DB stored when the application was first attempted.
function postingFromDb(company: string, role: string): JobPosting | null {
  const rows = store.getJobsByStatuses(['submitted', 'needs_manual', 'failed', 'discovered', 'shortlisted', 'skipped', 'applying']);
  const norm = (s: string) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const hit = rows.find((r) => norm(r.company) === norm(company) && norm(r.title) === norm(role));
  if (!hit) return null;
  return {
    id: hit.id,
    source: 'gupy',
    title: hit.title,
    company: hit.company,
    location: hit.location || '',
    remote: false,
    workplace_type: null,
    description: hit.description || '',
    apply_url: hit.apply_url,
    posted_at: hit.posted_at,
    deadline: null,
    seniority_hint: null,
  };
}

function pendingFrom(report: FillReport | null): { label: string; detail: string }[] {
  if (!report) return [];
  const out: { label: string; detail: string }[] = [];
  for (const r of report.rows) {
    if (r.preset) continue;
    if (r.required && (r.status === 'blank' || r.status === 'failed' || r.status === 'skipped')) {
      out.push({ label: r.label || `(field ${r.uid})`, detail: r.detail || r.status });
    }
  }
  if (report.hasAssessment) out.push({ label: 'assessment / test step', detail: 'a company test must be completed by you' });
  if (report.loginWall) out.push({ label: 'login wall', detail: 'Gupy asked to sign in again mid-application' });
  return out;
}

function renderReport(results: Result[], dryRun: boolean, opts: { partial: boolean; scanned: number } = { partial: false, scanned: 0 }): string {
  const manual = results.filter((r) => r.outcome === 'needs_manual' || r.outcome === 'failed');
  const submitted = results.filter((r) => r.outcome === 'submitted');
  const already = results.filter((r) => r.outcome === 'already');
  const nextStep = results.filter((r) => r.outcome === 'next_step');
  const offTarget = results.filter((r) => r.outcome === 'off_target');
  const expired = results.filter((r) => r.outcome === 'expired');

  const L: string[] = [];
  L.push('# Gupy — what is left to finish');
  L.push('');
  L.push(`Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} by \`npm run finish\`.`);
  if (dryRun) L.push('\n> **Dry run** — nothing was submitted. The list below is what a real run would have to leave for you.');
  if (opts.partial) {
    L.push(
      `\n> **Partial pass** — only ${opts.scanned} application(s) were walked (--only/--limit), so the counts below ` +
        'describe what was scanned, not your whole dashboard. Entries from earlier passes are kept in state/finish-results.json.',
    );
  }
  L.push('');
  L.push(`- Applications in this pass: **${results.length}**`);
  L.push(`- Finished automatically: **${submitted.length}**`);
  L.push(`- Needs you (unfinished application): **${manual.length}**`);
  L.push(`- Needs you (company test on a sent application): **${nextStep.length}**`);
  L.push(`- Already submitted (nothing to do): **${already.length}**`);
  L.push(`- Off-target drafts left alone: **${offTarget.length}**`);
  L.push(`- Windows that closed (nothing to do): **${expired.length}**`);
  L.push('');

  if (manual.length) {
    L.push('## Needs you — unfinished applications');
    L.push('');
    L.push('Open the link, answer the listed field(s), click **Salvar e continuar** until **Finalizar candidatura**.');
    L.push('');
    manual.forEach((r, i) => {
      L.push(`### ${i + 1}. ${r.role} — ${r.company}`);
      L.push('');
      if (r.location || r.workModel) L.push(`- Where: ${[r.location, r.workModel].filter(Boolean).join(' · ')}`);
      L.push(`- Resume here: ${r.appUrl}`);
      if (r.jobUrl) L.push(`- Job posting: ${r.jobUrl}`);
      const why = r.pending.length ? r.pending : [{ label: r.reason || 'see the page', detail: '' }];
      L.push(`- What to do: ${why.map((p) => `${p.label}${p.detail ? ` (${p.detail})` : ''}`).join('; ')}`);
      L.push('');
    });
  }

  // Already sent, but the company is now asking for a test. Distinct from the
  // section above: there is nothing to fill, and the test only runs once the
  // candidate starts it — so it has to be their sitting, not a background click.
  if (nextStep.length) {
    L.push('## Your move — company tests on sent applications');
    L.push('');
    L.push('These applications are already with the company. The open step is a timed test; the clock starts when you click **Começar**, so it has to be your sitting.');
    L.push('');
    nextStep.forEach((r, i) => {
      L.push(`### ${i + 1}. ${r.role} — ${r.company}`);
      L.push('');
      if (r.location) L.push(`- Where: ${r.location}`);
      L.push(`- Open: ${r.appUrl}`);
      const why = r.pending.length ? r.pending : [{ label: r.reason, detail: '' }];
      L.push(`- Step: ${why.map((p) => `${p.label}${p.detail ? ` (${p.detail})` : ''}`).join('; ')}`);
      L.push('');
    });
  }

  if (offTarget.length) {
    L.push('## Off-target drafts (left alone on purpose)');
    L.push('');
    L.push('These were started before the support/help-desk terms were removed from discovery, and your KB says you do not want that work. If you disagree, run `npm run finish -- --include-off-target` or open the link and finish it yourself. To clear them out, open the link and click **Desistir**.');
    L.push('');
    for (const r of offTarget) L.push(`- ${r.role} — ${r.company} · ${r.appUrl}`);
    L.push('');
  }

  if (expired.length) {
    L.push('## Window closed — nothing to do');
    L.push('');
    L.push('Gupy expired the curriculum step before it was finished, so these can no longer be completed. The only moves left are to open the posting and apply again if it is still live, or contact the recruiter on LinkedIn.');
    L.push('');
    for (const r of expired) L.push(`- ${r.role} — ${r.company}${r.jobUrl ? ` · ${r.jobUrl}` : ` · ${r.appUrl}`}`);
    L.push('');
  }

  if (submitted.length) {
    L.push('## Submitted by the bot just now');
    L.push('');
    for (const r of submitted) L.push(`- ${r.role} — ${r.company}`);
    L.push('');
  }
  return L.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = getConfig();
  if (!cfg.env.apiKey) {
    console.error('No GEMINI_API_KEY / DEEPSEEK_API_KEY in config/.env — the filler cannot write answers without one.');
    process.exit(1);
  }

  const client = new LlmClient({ ...llmOptions(), onSpend: (usd) => store.addSpend(usd) });

  const ctx: BrowserContext = await openPersistentContext({ headless: true });
  const results: Result[] = [];
  try {
    const login = await ensureGupyLogin(ctx);
    if (!login.ok) {
      console.error(`Gupy login failed: ${login.reason}`);
      process.exit(1);
    }
    console.log('Gupy login OK (headless).');

    const list: Page = ctx.pages()[0] || (await ctx.newPage());
    let cards: PortalCard[] = await listApplications(list);
    console.log(`Portal reports ${cards.length} applications in progress.`);
    if (args.only.length) cards = cards.filter((c) => args.only.includes(c.appId));
    if (args.limit) cards = cards.slice(0, args.limit);

    // `list` stays parked on the portal; the driver opens and closes its own page
    // per application, so an in-flight wizard is never clobbered by the next
    // inspection.
    let n = 0;
    for (const card of cards) {
      n++;
      const info: ApplicationInfo = await inspectApplication(list, card);
      const base: Result = {
        appId: info.appId,
        company: info.company,
        role: info.role || card.role,
        location: card.location,
        workModel: '',
        appUrl: info.appUrl,
        jobUrl: info.jobUrl,
        outcome: 'skipped',
        reason: '',
        pending: [],
        hasAssessment: false,
      };

      // Off-target first: a support/help-desk draft whose wizard state cannot be read
      // used to land in the manual list as "could not tell whether the wizard is
      // finished" — sending the candidate to answer a job the KB rules out. Nothing
      // about these is worth a human's attention, whatever their state.
      if (isOffTarget(base.role) && !args.includeOffTarget && !cfg.apply.include_off_target) {
        console.log(`[${n}/${cards.length}] ${base.company} — ${base.role}: off-target (support/help-desk), left alone`);
        results.push({ ...base, outcome: 'off_target', reason: 'role is IT support / help desk — your KB says no' });
        continue;
      }

      // The company already has the application, and its next step is something only
      // the candidate can do — a timed test above all. This is a different message
      // from "already submitted, nothing to do": there IS something left, it just is
      // not filling a form, and clicking it on their behalf would burn the attempt.
      if (info.state === 'submitted') {
        const step = info.pendingAction;
        if (step?.kind === 'assessment') {
          console.log(`[${n}/${cards.length}] ${base.company} — ${base.role}: submitted; company test at step ${step.step} (${step.title}) — needs you`);
          results.push({
            ...base,
            outcome: 'next_step',
            reason: 'application submitted — the company\'s next step is a timed test',
            hasAssessment: true,
            pending: [
              {
                label: `step ${step.step} · ${step.title}`,
                detail: step.label
                  ? 'timed company test — start it yourself, in one sitting'
                  : 'timed company test with no button on this page — open it from the notification email',
              },
            ],
          });
          continue;
        }
        console.log(`[${n}/${cards.length}] ${base.company} — ${base.role}: already submitted`);
        results.push({ ...base, outcome: 'already', reason: 'company already received this application' });
        continue;
      }
      if (info.state === 'expired') {
        console.log(`[${n}/${cards.length}] ${base.company} — ${base.role}: window closed (curriculum step expired)`);
        results.push({ ...base, outcome: 'expired', reason: 'the curriculum step expired — Gupy no longer offers a way in' });
        continue;
      }
      if (info.state === 'unknown' || info.closed || info.withdrawn) {
        console.log(`[${n}/${cards.length}] ${base.company} — ${base.role}: ${info.closed ? 'posting closed' : info.withdrawn ? 'withdrawn' : 'state unknown'}`);
        results.push({ ...base, outcome: 'needs_manual', reason: info.closed ? 'posting is closed' : info.withdrawn ? 'application was withdrawn' : 'could not tell whether the wizard is finished' });
        continue;
      }

      // A draft whose open step is a test: the wizard has nothing for the bot to fill,
      // and clicking "Começar" starts a timed assessment that cannot be paused or
      // undone — so this is a human step, reported as one even in inventory mode.
      if (info.pendingAction?.kind === 'assessment') {
        const step = info.pendingAction;
        console.log(`[${n}/${cards.length}] ${base.company} — ${base.role}: company test at step ${step.step} (${step.title || 'teste'}) — needs you`);
        results.push({
          ...base,
          outcome: 'needs_manual',
          reason: 'the remaining step is a timed company test',
          hasAssessment: true,
          pending: [
            {
              label: `step ${step.step} · ${step.title || 'teste'}`,
              detail: step.label
                ? 'company test — start it yourself, in one sitting'
                : 'company test with no button on this page — open it from the notification email',
            },
          ],
        });
        continue;
      }
      if (args.inventory) {
        // Read-only pass: report what the portal says without touching the wizard.
        console.log(`[${n}/${cards.length}] ${base.company} — ${base.role}: draft`);
        results.push({ ...base, outcome: 'skipped', reason: 'inventory only' });
        continue;
      }

      // Ground the answers in the live posting; fall back to the stored copy.
      if (info.jobUrl) {
        const posting = await readJobPosting(list, info.jobUrl);
        base.workModel = posting.workModel;
        if (posting.location) base.location = posting.location;
        if (posting.description.trim().length >= 80) info.description = posting.description;
      }
      const stored = postingFromDb(base.company, base.role);
      let job: JobPosting = {
        id: `gupyapp:${info.appId}`,
        source: 'gupy',
        title: base.role,
        company: base.company,
        location: base.location,
        remote: /remoto/i.test(`${base.location} ${base.workModel}`),
        workplace_type: base.workModel ? base.workModel.toLowerCase() : null,
        description: info.description,
        apply_url: info.jobUrl || info.appUrl,
        posted_at: null,
        deadline: null,
        seniority_hint: null,
      };
      if (job.description.trim().length < 80 && stored) {
        job = { ...stored, id: job.id, apply_url: job.apply_url, location: job.location || stored.location };
      }

      console.log(`\n[${n}/${cards.length}] ${base.company} — ${base.role} (${base.location}${base.workModel ? ' · ' + base.workModel : ''})`);
      let outcome;
      try {
        outcome = await applyToJob(ctx, job, { skipped: false, skipReason: null, score: 0, rationale: '', stack: [] }, client, {
          dryRun: args.dryRun,
          submit: true,
          attachResume: cfg.apply.attach_resume,
          applicationUrl: info.appUrl,
        });
      } catch (e) {
        outcome = { result: 'failed' as const, reason: (e as Error).message, report: null };
      }

      const pending = pendingFrom(outcome.report);
      const mapped =
        outcome.result === 'submitted'
          ? 'submitted'
          : outcome.result === 'posting_closed'
            ? 'expired'
            : outcome.result === 'already_applied'
              ? 'already'
              : outcome.result === 'failed'
                ? 'failed'
                : 'needs_manual';
      console.log(`  -> ${outcome.result}${outcome.reason ? ': ' + outcome.reason : ''}${pending.length ? ` [${pending.length} field(s) left]` : ''}`);

      results.push({
        ...base,
        outcome: mapped,
        reason: outcome.reason || '',
        pending,
        hasAssessment: !!outcome.report?.hasAssessment,
      });

      // Keep the local job status in step with what the portal just told us. Without
      // this, `npm run status` kept reporting needs_manual/failed for applications
      // that were long since submitted, and the next `run` would re-queue them.
      if (mapped === 'submitted') store.setStatusByCompanyRole(base.company, base.role, 'submitted');
      else if (mapped === 'already' || mapped === 'expired') store.setStatusByCompanyRole(base.company, base.role, 'skipped');

      store.logApplication({
        job_id: job.id,
        url: info.appUrl,
        company: base.company,
        role: base.role,
        result: outcome.result === 'submitted' ? 'submitted' : outcome.result === 'failed' ? 'failed' : 'deferred',
        reason: outcome.reason || undefined,
        report: outcome.report ? JSON.stringify({ rows: outcome.report.rows }) : undefined,
      });

      // Human pacing between real submissions.
      const pause = cfg.schedule.minDelayMs + Math.random() * (cfg.schedule.maxDelayMs - cfg.schedule.minDelayMs);
      await new Promise((r) => setTimeout(r, args.dryRun ? 500 : pause));
    }
  } finally {
    await ctx.close().catch(() => {});
  }

  mkdirSync(path.dirname(RESULTS_FILE), { recursive: true });
  const previous: Result[] = !args.rescan && existsSync(RESULTS_FILE) ? JSON.parse(readFileSync(RESULTS_FILE, 'utf8')) : [];
  const merged = new Map<string, Result>();
  for (const r of previous) merged.set(r.appId, r);
  for (const r of results) merged.set(r.appId, r);

  // The report describes THIS pass, not the merged history. Merging is right for the
  // JSON (an application skipped by a --only run keeps its last outcome) but wrong for
  // the summary: it made "already submitted" count applications that are no longer in
  // progress at all, and every number moved without the portal changing.
  const seen = new Set(results.map((r) => r.appId));
  const current = [...merged.values()].filter((r) => seen.has(r.appId));
  writeFileSync(RESULTS_FILE, JSON.stringify([...merged.values()], null, 2));

  const partial = Boolean(args.only.length || args.limit || args.inventory);
  if (!partial) {
    writeFileSync(LAST_FULL_PASS_FILE, JSON.stringify(current, null, 2));
  } else if (existsSync(LAST_FULL_PASS_FILE)) {
    // A targeted re-check must be able to correct the dashboard.
    //
    // The snapshot is written only by a full pass, because a partial pass sees a subset
    // of applications and replacing the file with it would erase the rest. But a stale
    // entry for an application we JUST re-inspected is simply wrong: after a transient
    // page failure left PagBank as "could not tell whether the wizard is finished",
    // `--only 769915530` could not fix the report it appears in. Patch the entries the
    // pass actually touched; leave every other entry untouched.
    const snapshot = JSON.parse(readFileSync(LAST_FULL_PASS_FILE, 'utf8')) as Result[];
    const byId = new Map(snapshot.map((r) => [r.appId, r]));
    for (const r of results) if (!args.inventory) byId.set(r.appId, r);
    writeFileSync(LAST_FULL_PASS_FILE, JSON.stringify([...byId.values()], null, 2));
  }

  const md = renderReport(current, args.dryRun, { partial, scanned: results.length });
  const outFile = path.join(ROOT, 'docs', 'gupy-manual-todo.md');
  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, md);
  console.log(`\n${md.split('\n').slice(4, 10).join('\n')}`);
  console.log(`\nManual list written to ${path.relative(ROOT, outFile)}`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
