// The apply driver: navigate -> detect -> fill (deterministic then model, across
// multi-step forms) -> attach resume -> submit gate. Ports jobfill/content/fill.js's
// two-pass loop to run in Node, with the DOM work delegated to the in-page engine.
import type { BrowserContext, Page, Locator } from 'playwright';
import { install, scan, fill, attachResume, dismissOverlay, harvestOptions } from '../fill/engine.js';
import { adapterFor, bestOption, CONFIRM_DATA_CONSENT, DELIBERATELY_BLANK, isChoiceLike, MARKETING_CONSENT, match, REQUIRED_CONSENT } from '../fill/core.js';
import { check, checkSources } from '../llm/validate.js';
import {
  COMPOSE_SYSTEM,
  JUDGE_SCHEMA,
  JUDGE_SYSTEM,
  MAPPING_SCHEMA,
  MAPPING_SYSTEM,
  composeInput,
  judgeInput,
  mappingInput,
} from '../llm/prompts.js';
import type { LlmClient } from '../llm/client.js';
import {
  KEY_DESCRIPTIONS,
  factsBlock,
  loadProfile,
  pickArchetype,
  resumePath,
  resolve,
} from '../profile/index.js';
import type { FieldDescriptor, FillRow, JobPosting, Posting, ScanResult } from '../types.js';
import type { ScoreResult } from '../match/score.js';
import type { Mailer } from '../mail/index.js';
import type { CodeCandidate, MailError } from '../mail/types.js';
import { evaluateGate } from './submit-gate.js';
import { extractRequirements, extractStack } from './posting.js';
import { technologyExperienceAnswer } from '../fill/tech.js';
import { dumpPage } from './debug.js';
import * as store from '../store/index.js';

const MAX_FIELDS_TO_MODEL = 60;
const MAX_COMPOSE_CALLS = 6;
const MAX_STEPS = 8;
const MAX_SUBMIT_ADVANCES = 12;

const NEXT_TEXT = /continuar|pr[oó]ximo|avan[çc]ar|\bnext\b|continue|salvar\s*e\s*continuar|save\s*and\s*continue|responder\s*agora|responder\s*perguntas|come[çc]ar|iniciar|\bstart\b/i;
const SUBMIT_TEXT = /enviar|finalizar|concluir|\bsubmit\b|candidatar|aplicar|\bapply\b|\bsend\b/i;

// A phone country-code selector ("BR+55", "DDI", "country code") is pre-set to
// the candidate's country. Do not model-map it to `phone`; leave it alone.
const DIAL_CODE = /^[a-z]{2,3}\s*\+\d{1,3}$|\bddi\b|\bdial\s*code\b|\bcountry\s*code\b|c[oó]digo\s*(de\s*)?pa[ií]s/i;

export interface ApplyOptions {
  dryRun: boolean;
  submit: boolean;
  attachResume: boolean;
  /**
   * Start from the candidate's own application page (a saved Gupy draft) instead of
   * the public job page. This skips "Candidatar-se" — the draft already exists, and
   * clicking apply again on some boards creates a second application.
   */
  applicationUrl?: string;
  /**
   * Boards like Greenhouse finish a submit with a one-time code mailed to the
   * candidate. With this set, the driver keeps the filled page open (a headed browser)
   * and waits for the candidate to paste that code and press submit, then reports the
   * outcome it observes. Without it, the gate is reported as a manual step and the
   * filled page is discarded.
   */
  holdForVerificationMs?: number;
  /**
   * Reads the applicant's inboxes so an e-mailed code can be used without a human.
   * Tried before `holdForVerificationMs`; a run with neither behaves exactly as before.
   */
  mailer?: Mailer;
}

export interface FillReport {
  adapterId: string;
  lang: 'pt' | 'en';
  rows: FillRow[];
  errors: string[];
  resume: { ok: boolean; reason?: string };
  llm: { state: string; mapped?: number };
  hasAssessment: boolean;
  blocked: boolean;
  loginWall: boolean;
  alreadyApplied?: boolean;
  /** The posting no longer accepts applications ("Candidaturas encerradas"). There is
   * nothing to fill and nothing for the candidate to do — report it as closed rather
   * than as a failure the manual list would have to explain. */
  postingClosed?: boolean;
}

export type ApplyResult =
  | 'submitted'
  | 'deferred'
  | 'failed'
  | 'needs_manual'
  | 'already_applied'
  | 'posting_closed';

export interface ApplyOutcome {
  result: ApplyResult;
  reason: string | null;
  report: FillReport | null;
}

function detectLanguage(text: string): 'pt' | 'en' {
  const t = text.toLowerCase();
  const pt = (t.match(/\b(nome|sobrenome|vaga|sal[áa]rio|voc[eê]|cargo|empresa|candidat|experi[êe]ncia|requisitos|benef[ií]cios|atividades|responsabilidades)\b/g) || []).length;
  const en = (t.match(/\b(experience|requirements|responsibilities|benefits|apply|company|salary|years|engineering|software)\b/g) || []).length;
  return pt >= en ? 'pt' : 'en';
}

async function bodyText(page: Page): Promise<string> {
  try {
    return await page.locator('body').innerText({ timeout: 3000 });
  } catch {
    return '';
  }
}

// Dismiss Gupy's cookie-consent and newsletter popups so they don't intercept the
// next click. Best-effort; a missed popup is retried on the next step.
async function dismissPopups(page: Page): Promise<void> {
  // The "Atualize seus dados" reminder (confirm e-mail + mobile) opens over the
  // application and its two fields scan exactly like an application form. Left
  // open, the scanner fills them, finds "Atualizar" instead of a wizard button and
  // reports "the form blocked advancing" — every new application deferred on a
  // dialog that is not part of the application at all. Dismiss it the way a human
  // does: "Me lembrar depois".
  const remindLater = page.locator('button').filter({ hasText: /me\s+lembrar\s+depois/i }).first();
  if ((await remindLater.count()) && (await remindLater.isVisible().catch(() => false))) {
    await remindLater.click().catch(() => {});
    await page.waitForTimeout(600);
  }

  for (const re of [/n[aã]o,?\s*obrigado/i, /rejeitar/i, /aceitar\s*(todos\s*os\s*)?cookies/i]) {
    const buttons = page.locator('button').filter({ hasText: re });
    for (let i = 0; i < (await buttons.count()); i++) {
      const el = buttons.nth(i);
      if (await el.isVisible()) {
        await el.click().catch(() => {});
        break;
      }
    }
  }
}

// The curriculum step's own action ("Começar") or the welcome screen's "Continuar"
// are the only way into the wizard — and the only buttons here the bot may click.
//
// Gupy's application page also puts a "Começar" on the company test step. That
// button starts a one-shot, time-boxed assessment: the previous version of this
// function matched the first "Começar" on the page and clicked it, which walked a
// real candidate's 17-minute B4A test into "Tempo esgotado" without a single
// answer. A step whose own text says it is a teste/prova/avaliação is therefore
// never clicked, whatever it is labelled.
const ASSESSMENT_STEP_TEXT = /teste\b|prova\s*(online|t[ée]cnica)|assessment|avalia[çc][ãa]o|din[âa]mica|desafio\s*t[ée]cnico|gravar\s*v[íi]deo|dura[çc][ãa]o\s*m[áa]xima/i;

export async function clickStartDraft(page: Page): Promise<'clicked' | 'assessment' | 'none'> {
  const handle = await page
    .evaluateHandle(() => {
      const items = Array.from(document.querySelectorAll('.timeline__item'));
      for (const it of items) {
        const btn = it.querySelector('.expandable-card__button-wrapper button, .expandable-card__button-wrapper a') as HTMLElement | null;
        if (!btn) continue;
        if (/^(come[çc]ar|continuar)$/i.test((btn.innerText || '').replace(/\s+/g, ' ').trim())) return btn;
      }
      return null;
    })
    .catch(() => null);

  const el = handle ? handle.asElement() : null;
  if (el) {
    const text = await el
      .evaluate((node) => {
        const item = (node as HTMLElement).closest('.timeline__item') as HTMLElement | null;
        const title = item?.querySelector('.expandable-card__header-text')?.textContent || '';
        const detail = (item?.querySelector('.card-body') as HTMLElement | null)?.innerText || '';
        return `${title} ${detail}`;
      })
      .catch(() => '');
    if (ASSESSMENT_STEP_TEXT.test(text)) return 'assessment';
    await clickDirect(el as unknown as Locator);
    return 'clicked';
  }

  // No timeline rows (the wizard's welcome screen, or a board that does not use
  // Gupy's timeline markup): the generic button is the only way in and is safe.
  // A timeline that offered no start button may still hide one inside an
  // assessment step, so it is not probed page-wide.
  const hasTimeline = await page.evaluate(() => document.querySelectorAll('.timeline__item').length > 0).catch(() => false);
  if (hasTimeline) return 'none';
  const start = page.locator('button, a').filter({ hasText: /^(come[çc]ar|continuar)$/i }).first();
  if ((await start.count()) && (await start.isVisible().catch(() => false))) {
    await clickDirect(start);
    return 'clicked';
  }
  return 'none';
}

// A company assessment page (Gupy renders it at /applications/<id>/test). Nothing
// on it is ours: answering it would put words in the candidate's mouth on a test
// that measures them, and every click there spends their one attempt.
async function isAssessmentPage(page: Page): Promise<boolean> {
  if (/\/(test|assessment|prova)(\/|$)/i.test(new URL(page.url()).pathname)) return true;
  const text = await bodyText(page);
  return /tempo\s+restante|pergunta\s+\d+\s+de\s+\d+|finalizar\s+teste|enviar\s+teste/i.test(text);
}

// Work-model answers are a standing decision keyed to WHERE the role is: within
// São Paulo he accepts remote, hybrid and on-site; anywhere else, remote only. The
// KB resolves them to the SP answer, so clear them here for postings that are not
// in São Paulo — a blank field is deferred to the manual list, a wrong "Sim" is a
// false statement on a real application.
async function applyPostingValues(values: Record<string, string | null>, job: JobPosting): Promise<void> {
  const inSaoPaulo = /(^|[\s,/\-])(sp|s[ãa]o\s*paulo)([\s,/\-]|$)/i.test(job.location || '');
  if (inSaoPaulo) return;
  values.accepts_onsite = null;
  values.easy_access = null;
  values.accepts_hybrid = null;
}

async function clickApply(page: Page): Promise<boolean> {
  const candidates = page.locator('button, a').filter({ hasText: /candidat|quero\s*me\s*candidatar|inscrever|apply\s*now|\bapply\b/i });
  const count = await candidates.count();
  for (let i = 0; i < count && i < 5; i++) {
    try {
      const el = candidates.nth(i);
      if (await el.isVisible()) {
        await el.click();
        await page.waitForTimeout(2500);
        return true;
      }
    } catch {
      /* keep looking */
    }
  }
  return false;
}
// Judge whether the free-text answers the bot just wrote are grounded in THIS
// posting or generic boilerplate. Returns null when there is nothing to judge
// or the judge call itself fails (never block submission on a judge outage).
async function judgeQuality(
  client: LlmClient,
  job: JobPosting,
  score: ScoreResult,
  report: FillReport,
): Promise<{ specific: boolean; reason: string } | null> {
  // Only substantive prose is judged for specificity.
  //
  // The judge asks "does this answer reference the company, the role, the stack?" —
  // which is the right question for "why do you want to work here" and the wrong one
  // for "what times can you interview?". A scheduling answer cannot name the stack
  // without sounding absurd, so including it made the judge reject an otherwise
  // complete application ("the answer only provides interview availability"). Logistics
  // answers are excluded rather than judged on a criterion that does not apply.
  const LOGISTICS_ANSWER =
    /hor[áa]rio|agenda|disponibilidade|quando\s+(pode|poderia|tem)|interview|entrevista|contato|telefone|whats|e-?mail|in[ií]cio|start\s+date/i;
  const prose = report.rows
    .filter((r) => r.key === 'free_text' && r.value && !LOGISTICS_ANSWER.test(r.label || ''))
    .map((r) => `${r.label}:\n${String(r.value)}`)
    .join('\n\n');
  if (!prose.trim()) return null;
  const profile = loadProfile();
  const posting = postingFrom(job, score);
  try {
    const res = (await client.call({
      task: 'judge',
      system: JUDGE_SYSTEM,
      input: judgeInput({ posting, answers: prose }),
      schema: JUDGE_SCHEMA,
      temperature: 0,
      maxTokens: 120,
    })) as { specific: boolean; reason: string };
    return { specific: !!res.specific, reason: res.reason || '' };
  } catch {
    return null;
  }
}

function postingFrom(job: JobPosting, score: ScoreResult): Posting {
  const description = String(job.description || '').replace(/\s+/g, ' ').trim();
  return {
    company: job.company,
    role_title: job.title,
    seniority: job.seniority_hint,
    location: job.location,
    language: detectLanguage(`${job.title}\n${job.description}`),
    stack: score.stack?.length ? score.stack : extractStack(description),
    must_haves: extractRequirements(description),
    nice_to_haves: [],
    // The posting text itself, quoted. This is what lets the composer tie an answer
    // to a real requirement and what lets the judge check that it did.
    product_summary: description ? description.slice(0, 1800) : null,
    hiring_context: description.length > 1800 ? description.slice(1800, 3000) : null,
  };
}

// What a mapping citation may point at: the candidate's FACTS plus the posting
// context that was handed to the model (location/company/role). Both are given,
// not invented, so citing either is legitimate.
function sourcePool(ctx: ModelCtx): string {
  const p = ctx.posting;
  return [
    ctx.facts,
    `Job being applied to — location: ${p.location || 'unknown'}; company: ${p.company || 'unknown'}; role: ${p.role_title || 'unknown'}.`,
  ].join('\n');
}

// Pick the affirmative value for a required consent field. Choices are usually
// "Sim"/"Não"; some Gupy screens instead list two long options ("Tenho ciência e
// aceito…" / "Tenho ciência e não aceito…"). A lone checkbox takes its own label.
function consentValue(field: FieldDescriptor): string | null {
  const opts = field.options || [];
  const yes = opts.find((o) => /^(sim|yes)$/i.test(o.trim()));
  if (yes) return yes;
  const aff = opts.find(
    (o) => /aceit[oa]|concord[oa]|autoriz|consinto|cient(e|e)|agree|accept|authori/i.test(o) && !/n[ãa]o\s*(aceito|concordo)|discord|not\s*accept/i.test(o),
  );
  if (aff) return aff;
  if (opts.length === 1) return opts[0];
  return null;
}

/**
 * Type a one-time code into the box the board just revealed.
 *
 * The field appears only after the first submit click, so it is located by its label
 * rather than by position: Greenhouse renders "Código de segurança" beside a
 * `maxlength=8` input. The value is verified by reading it back — an unverified write
 * would spend a verification attempt on an empty field.
 */
export async function enterVerificationCode(page: Page, code: string): Promise<boolean> {
  const CODE_LABEL = /c[oó]digo|code|verifica|seguran|passcode/i;

  // Preferred: the engine's own filler, so the same React-aware write path is used as
  // everywhere else in the pipeline.
  try {
    const scanned = await scan(page);
    const field = scanned.fields.find((f) => CODE_LABEL.test(f.label) && f.kind !== 'file');
    if (field) {
      const r = await fill(page, field.index, code);
      if (r.ok && r.verified) return true;
    }
  } catch {
    /* fall through to the direct locator */
  }

  // Fallback: a short text input next to the word "code", which covers pages the
  // scanner groups differently.
  const inputs = page.locator('input[type="text"], input[type="tel"], input:not([type])');
  const count = await inputs.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const el = inputs.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    const maxLength = await el.getAttribute('maxlength').catch(() => null);
    const labelled = await el
      .evaluate((node, re) => {
        const input = node as HTMLInputElement;
        const id = input.id;
        const label = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
        const text = `${input.placeholder || ''} ${input.getAttribute('aria-label') || ''} ${label?.textContent || ''} ${
          input.parentElement?.textContent || ''
        }`;
        return new RegExp(re.source, re.flags).test(text);
      }, CODE_LABEL)
      .catch(() => false);
    const short = maxLength !== null && Number(maxLength) <= 12;
    if (!labelled && !short) continue;
    await el.fill(code).catch(() => {});
    const got = await el.inputValue().catch(() => '');
    if (got.replace(/\s/g, '') === code.replace(/\s/g, '')) return true;
  }
  return false;
}

/**
 * Finish an application that stopped on an e-mailed one-time code.
 *
 * Kept out of `applyToJob` as its own step so the whole recovery — wait, read, type,
 * resubmit — can be exercised against a synthetic page and a scripted inbox, which is
 * the only way to test it without sending a real application.
 *
 * Returns `ok:false` with a `reason` whenever it stopped short, and never claims success
 * it did not observe.
 */
export async function completeWithMailedCode(
  page: Page,
  mailer: Mailer,
  opts: { to: string; since: Date; timeoutMs?: number; pollMs?: number },
): Promise<{
  ok: boolean;
  reason?: string;
  code?: CodeCandidate;
  mailbox?: string;
  errors: MailError[];
}> {
  const where = opts.to ? ` to ${opts.to}` : '';
  const started = Date.now();
  console.log(`  … waiting for the e-mailed code${where}`);

  const { code, errors, polls } = await mailer.waitForCode({
    to: opts.to,
    since: opts.since,
    timeoutMs: opts.timeoutMs,
    pollMs: opts.pollMs,
    onPoll: (n) => console.log(`  … poll ${n}, nothing yet (${Math.round((Date.now() - started) / 1000)}s)`),
  });

  if (!code) return { ok: false, errors };

  console.log(
    `  ✓ code ${code.code} from ${code.message.from || code.message.mailbox} ` +
      `(confidence ${code.confidence}, ${polls} poll(s))`,
  );

  if (!(await enterVerificationCode(page, code.code))) {
    return { ok: false, reason: 'found a code but could not find the field to type it into', code, errors };
  }

  const after = await doSubmit(page);
  if (after.ok) {
    return { ok: true, code, mailbox: code.message.mailbox, errors };
  }
  return {
    ok: false,
    reason: `code ${code.code} was entered but the submit did not confirm (${after.reason})`,
    code,
    mailbox: code.message.mailbox,
    errors,
  };
}

/**
 * Wait for a human to satisfy an e-mailed verification gate on a page the bot has
 * already filled.
 *
 * The browser is headed here and parked on the right page, so the only thing left is
 * typing eight characters. Polling (rather than a fixed sleep) means the run ends the
 * moment the application goes through, and a closed window ends it too instead of
 * hanging for the full timeout.
 */
export async function waitForHumanVerification(page: Page, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  console.log('\n→ The board e-mailed a one-time code. The filled form is open in the browser window:');
  console.log('  paste the code, press submit, and this will continue on its own.\n');
  while (Date.now() < deadline) {
    // A closed window is how the candidate says "not now". waitForTimeout THROWS on a
    // closed page, so this has to be guarded rather than ordered after the check.
    const stillOpen = await page.waitForTimeout(3000).then(() => true).catch(() => false);
    if (!stillOpen || page.isClosed()) return false;
    if (await confirmSuccess(page)) return true;
  }
  return false;
}

export async function applyToJob(
  context: BrowserContext,
  job: JobPosting,
  score: ScoreResult,
  client: LlmClient,
  opts: ApplyOptions,
): Promise<ApplyOutcome> {
  // A job with no usable description cannot ground answers — the model would write
  // generic prose (the silent context-loss bug). Defer rather than submit that.
  if ((job.description || '').trim().length < 80) {
    return { result: 'deferred', reason: 'no job description — cannot ground answers', report: null };
  }

  const page = await context.newPage();
  // Gupy's duplicate check is a 400 "already_applied_error" on the resume-upload
  // endpoint, not a page message. Catch it so we report the truth, not "failed".
  let alreadyApplied = false;
  const onResponse = (resp: { status: () => number; text: () => Promise<string> }) => {
    if (resp.status() >= 400) {
      resp.text().then((t) => { if (/already_applied/i.test(t)) alreadyApplied = true; }).catch(() => {});
    }
  };
  page.on('response', onResponse as never);
  try {
    const report = await fillPage(page, job, score, client, opts);
    if (report.loginWall) {
      return { result: 'needs_manual', reason: 'login wall — sign in to Gupy via LinkedIn/Google (run "login")', report };
    }
    if (report.postingClosed) {
      return { result: 'posting_closed', reason: 'posting no longer accepts applications ("Candidaturas encerradas")', report };
    }
    if (report.alreadyApplied) {
      return { result: 'already_applied', reason: 'already submitted — form is read-only', report };
    }

    // Quality gate: when the bot wrote free-text prose, verify it is grounded in
    // THIS posting and not generic boilerplate (the silent context-loss failure).
    const quality = await judgeQuality(client, job, score, report);
    if (quality && !quality.specific) {
      return { result: 'deferred', reason: `answers looked generic (job context likely lost): ${quality.reason}`, report };
    }

    const decision = evaluateGate(report, { dryRun: opts.dryRun, submit: opts.submit });

    if (!decision.submit) {
      await dumpPage(page, job.id, decision.requiresManual ? 'gate-needs-manual' : 'gate-deferred');
      return { result: decision.requiresManual ? 'needs_manual' : 'deferred', reason: decision.reason, report };
    }

    const outcome = await doSubmit(page);
    if (outcome.ok) return { result: 'submitted', reason: null, report };
    if (alreadyApplied) return { result: 'already_applied', reason: 'you already applied to this job', report };
    await dumpPage(page, job.id, 'submit-not-confirmed');
    if (outcome.verificationEmail !== undefined) {
      // The board mailed a one-time code. Three ways out, in order of preference:
      //   1. read it from a configured inbox and finish the application here
      //   2. park the filled page in front of a human (`--hold`) and let them type it
      //   3. report the gate, so a manual list can carry it
      const where = outcome.verificationEmail ? ` to ${outcome.verificationEmail}` : '';
      const startedAt = new Date();

      if (opts.mailer?.configured) {
        const recovery = await completeWithMailedCode(page, opts.mailer, {
          to: outcome.verificationEmail || '',
          since: new Date(startedAt.getTime() - 60_000),
        });
        if (recovery.ok) {
          return { result: 'submitted', reason: `confirmed after the code from ${recovery.mailbox}`, report };
        }
        if (recovery.reason) report.errors.push(recovery.reason);
        // Distinguish "no mail arrived" from "mail is unreachable". Reading the inbox
        // is a credential problem the applicant must fix; an empty inbox is not.
        for (const e of recovery.errors) report.errors.push(`mail ${e.account}: ${e.error}`);
        if (!recovery.code && recovery.errors.length) {
          return {
            result: 'needs_manual',
            reason: `form was filled; the code${where} could not be read (${recovery.errors[0].account}: ${recovery.errors[0].error})`,
            report,
          };
        }
      }

      if (opts.holdForVerificationMs && opts.holdForVerificationMs > 0) {
        const confirmed = await waitForHumanVerification(page, opts.holdForVerificationMs);
        if (confirmed) return { result: 'submitted', reason: 'confirmed after e-mailed code was entered', report };
      }
      report.errors.push('email verification code required');
      return {
        result: 'needs_manual',
        reason: `form was filled; the board e-mailed a one-time code${where} — enter it and press submit`,
        report,
      };
    }
    return { result: 'failed', reason: `submit did not confirm (${outcome.reason})`, report };
  } catch (e) {
    const msg = (e as Error).message || String(e);
    const loginWall = /login|sign ?in|entrar|criar conta|fazer login|conecte-se/i.test(msg);
    await dumpPage(page, job.id, 'error').catch(() => {});
    return {
      result: loginWall ? 'needs_manual' : 'failed',
      reason: loginWall ? 'login wall — manual login needed' : msg,
      report: null,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Is this page a posting that no longer accepts applications?
 *
 * Three boards, three ways of saying it:
 *   Gupy         "Candidaturas encerradas", apply button disabled, no form
 *   Greenhouse   redirect to the board root with ?error=true and
 *                "A vaga que você está procurando não está mais aberta."
 *   some others  "no longer open / accepting"
 *
 * The redirect is the reliable Greenhouse signal. Without this the driver walked an
 * empty page and recorded "submit did not confirm" — a failure entry, and a retry slot
 * every cycle, for a vacancy that simply no longer exists.
 */
export function isClosedPosting(url: string, text: string): boolean {
  if (/[?&]error=true/i.test(url || '')) return true;
  return /candidaturas?\s*encerrad|inscri[çc][õo]es\s*encerrad|vaga\s*(encerrad|fechad|expirad)|processo\s*(encerrad|finalizado)|vaga\s+que\s+voc[êe]\s+est[áa]\s+procurando\s+n[ãa]o\s+est[áa]\s+mais\s+aberta|no\s+longer\s+(open|accepting)/i.test(
    text || '',
  );
}

async function fillPage(page: Page, job: JobPosting, score: ScoreResult, client: LlmClient, opts: ApplyOptions): Promise<FillReport> {
  // A saved draft is entered from the application page ("Começar" on the curriculum
  // step); a fresh application is entered from the public job page. Both converge on
  // the same multi-step wizard below.
  let entry: 'clicked' | 'assessment' | 'none' = 'none';
  if (opts.applicationUrl) {
    await page.goto(opts.applicationUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2000);
    entry = await clickStartDraft(page);
    await page.waitForTimeout(3000);
  } else {
    await page.goto(job.apply_url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1500);

    // Gupy and scraped boards put an "Candidatar-se/Apply" button on the job page
    // that leads to the actual form; greenhouse/lever/ashby apply URLs usually ARE
    // the form already, where this click is a harmless no-op.
    await clickApply(page);
    await page.waitForTimeout(3000);
  }

  const report: FillReport = {
    adapterId: 'generic',
    lang: detectLanguage(`${job.title}\n${job.description}`),
    rows: [],
    errors: [],
    resume: { ok: false },
    llm: { state: 'idle' },
    hasAssessment: false,
    blocked: false,
    loginWall: false,
    alreadyApplied: false,
  };

  await install(page);
  await dismissPopups(page);

  // A company assessment is not ours to take: the only open step is a timed test,
  // nothing can be filled, and any click there spends the candidate's one attempt.
  // Report it and stop before a single element is touched.
  if (entry === 'assessment' || (await isAssessmentPage(page))) {
    report.hasAssessment = true;
    report.errors.push('company assessment step — the candidate must take it');
    return report;
  }

  // A posting Gupy has closed shows "Candidaturas encerradas" with the apply button
  // disabled and no form at all. Without this check the driver walked an empty page,
  // found the disabled button and recorded "submit did not confirm (submit button
  // disabled)" — a failure entry on a job that simply is not open any more.
  const pageText = await page.locator('body').innerText().catch(() => '');
  if (isClosedPosting(page.url(), pageText)) {
    report.postingClosed = true;
    return report;
  }

  const profile = loadProfile();
  const kb = profile.kb;
  const values = resolve(kb, report.lang);
  applyPostingValues(values, job);
  // "Já participou de outro processo seletivo aqui?" is answered from the application
  // log rather than guessed: it is a verifiable fact about this candidate.
  if (values.previously_applied_here !== undefined) {
    const yes = store.hasAppliedToCompany(job.company);
    values.previously_applied_here = report.lang === 'pt' ? (yes ? 'Sim' : 'Não') : (yes ? 'Yes' : 'No');
  }
  const facts = factsBlock(kb, report.lang);
  const posting = postingFrom(job, score);
  const ctx: ModelCtx = { client, profile, values, facts, posting, lang: report.lang };

  const headings = await page.locator('h1, h2, h3, h4, button, [role="heading"], strong, b').allInnerTexts().catch(() => []);
  report.hasAssessment = /teste\b|assessment|avalia[çc][ãa]o|desafio\s*t[ée]cnico|prova\s*(online|t[ée]cnica)|gravar\s*v[ií]deo|video\s*(introdu|apresenta)/i.test(headings.join(' '));

  const seenUids = new Set<string>();
  let resumeAttached = false;

  for (let step = 0; step < MAX_STEPS; step++) {
    const scanned = await scan(page);
    report.adapterId = scanned.adapterId || report.adapterId;
    const adapter = adapterFor(scanned.adapterId);

    // React-Select and Greenhouse's custom selects render no options until they are
    // opened, so a combobox scans with an empty option list and the model can only
    // refuse it — leaving required questions (diversity, allocation area) unfillable.
    // Harvest the real options for those few, before anything is written.
    for (const f of scanned.fields) {
      if (f.kind !== 'combobox' || (f.options && f.options.length)) continue;
      if (!f.required) continue;
      const harvested = await harvestOptions(page, f.index).catch(() => null);
      if (harvested?.ok && harvested.options.length) f.options = harvested.options;
    }

    // Re-visiting an already-submitted application: Gupy renders the form
    // read-only (every field `disabled`). scan() skips disabled fields, so the
    // page looks empty — but that means the application is already complete, not
    // that the form is blank. Stop and report the truth instead of looping.
    if (!scanned.fields.length && scanned.stats.disabled > 0) {
      report.alreadyApplied = true;
      break;
    }

    // A password field means Gupy is asking the candidate to sign in before the
    // application form itself appears. Stop — that is not ours to fill.
    if (scanned.fields.some((f) => f.inputType === 'password' || /^(senha|password|senha\s*de\s*acesso)\s*$/i.test(f.label))) {
      report.loginWall = true;
      report.errors.push('login wall — Gupy asks for email + password to sign in');
      break;
    }

    // Gupy's "Apresente-se!" personalization step (presentation + skills) comes
    // after the company questions. Its textarea is only labelled by its
    // placeholder, so fill it (and pick skills) here rather than via the normal
    // matcher/model pass, then let the loop's advance() find "Finalizar
    // candidatura" as the submit button.
    if (await isPersonalizationStep(page, scanned)) {
      await handlePersonalization(page, ctx, report);
      const action = await advance(page);
      if (action === 'next') await dismissPopups(page);
      if (action === 'blocked') report.blocked = true;
      break;
    }

    if (!scanned.fields.length) {
      // Gupy's "Apresente-se!" dialog IS the next step. Its two buttons are handled
      // explicitly here because the generic button search cannot tell them apart:
      // "Finalizar candidatura" matches SUBMIT_TEXT but only loops the wizard back to
      // the curriculum welcome, while entering the personalization form is what
      // actually moves the application forward.
      if (await enterPersonalizationDialog(page)) continue;

      // Gupy greets a signed-in candidate with a "vamos continuar sua candidatura?"
      // welcome screen: a Continuar button and no fields. The button can lag the
      // form render, so poll briefly before giving up (a missed click is what
      // left applications stuck at the curriculum step).
      let advanced = false;
      for (let i = 0; i < 6 && !advanced; i++) {
        const cont = await firstButton(page, NEXT_TEXT);
        if (cont && (await cont.isEnabled().catch(() => false))) {
          await clickDirect(cont);
          await page.waitForTimeout(1500);
          // A "Salvar e continuar" on a step with nothing to fill either advances or
          // raises a dialog (the personalization one, or "answers cannot be edited").
          await confirmModal(page);
          advanced = true;
        } else {
          await page.waitForTimeout(800);
        }
      }
      if (advanced) continue;
      break;
    }

    const newFields = scanned.fields.filter((f) => !seenUids.has(f.uid));
    if (step > 0 && newFields.length === 0) {
      // Same fields reappeared — the form refused to advance, which means a
      // required answer did not stick. Treat it as blocked so the submit gate
      // defers instead of firing a false "submitted".
      report.blocked = true;
      report.errors.push('form did not advance past this step');
      break;
    }
    scanned.fields.forEach((f) => seenUids.add(f.uid));

    if (opts.attachResume && !resumeAttached && scanned.fields.some((f) => f.kind === 'file')) {
      report.resume = await attachResumeFor(page, report.lang);
      resumeAttached = true;
    }

    const unresolved = await deterministicPass(page, scanned.fields, values, adapter, report, kb);
    if (unresolved.length) await modelPass(page, unresolved, ctx, report);

    const action = await advance(page);
    if (action === 'next') await dismissPopups(page);
    if (action === 'submit' || action === 'none') break;
    if (action === 'blocked') {
      report.blocked = true;
      report.errors.push('the form blocked advancing — a required field is unfilled');
      break;
    }
    await page.waitForTimeout(1200);
  }

  // Reflect the resume attachment on the file rows so the gate sees the truth.
  for (const r of report.rows) {
    if (r.kind !== 'file') continue;
    if (report.resume.ok) {
      r.status = 'filled';
      r.detail = 'resume attached';
    } else {
      r.status = 'failed';
      r.detail = report.resume.reason || 'resume not attached';
    }
  }

  return report;
}

async function deterministicPass(
  page: Page,
  fields: FieldDescriptor[],
  values: Record<string, string | null>,
  adapter: ReturnType<typeof adapterFor>,
  report: FillReport,
  kb: Record<string, unknown>,
): Promise<FieldDescriptor[]> {
  const unresolved: FieldDescriptor[] = [];

  for (const field of fields) {
    if (field.kind === 'file') {
      report.rows.push(row(field, 'skipped', 'file input — resume attached separately'));
      continue;
    }

    if (DIAL_CODE.test(field.label)) {
      report.rows.push(
        row(field, 'skipped', 'country dial code — already set to Brazil (+55)', { preset: true }),
      );
      continue;
    }

    // "Você possui experiência profissional com Java/Angular/...?" — one required
    // yes/no per technology. Answered from the KB's skills and work history so a
    // single unrecognised stack cannot stall the whole application.
    if (isChoiceLike(field.kind)) {
      const verdict = technologyExperienceAnswer(field.label, field.options || [], kb);
      if (verdict) {
        const lang = report.lang;
        const wanted = lang === 'pt' ? (verdict === 'yes' ? 'Sim' : 'Não') : verdict === 'yes' ? 'Yes' : 'No';
        const picked = (field.options || []).find((o) => o.trim().toLowerCase().startsWith(wanted.toLowerCase().slice(0, 3))) ?? wanted;
        const result = await fill(page, field.index, picked);
        const ok = result.ok && result.verified;
        report.rows.push(
          row(field, ok ? 'filled' : 'failed', ok ? `answered from KB skills: ${picked}` : result.note || 'could not select', {
            key: 'skills',
            value: picked,
            source: 'label',
          }),
        );
        if (!ok) unresolved.push(field);
        continue;
      }
    }

    const consent =
      (isChoiceLike(field.kind) || field.kind === 'combobox' || field.kind === 'select') &&
      (REQUIRED_CONSENT.test(field.label) || MARKETING_CONSENT.test(field.label) || CONFIRM_DATA_CONSENT.test(field.label));
    if (consent) {
      // "Confirmo que os dados estão corretos" / "Declaro que as informações são
      // verídicas" is not a consent decision — it is a statement about data the bot
      // itself filled and verified, and leaving it unchecked is what disabled
      // "Salvar e continuar" on the last step.
      //
      // Note the missing `field.required` check: Gupy renders "Campo obrigatório"
      // *outside* the question element, so a genuinely required declaration scans as
      // optional. Conditioning on that flag left the final step permanently stalled on
      // Pague Menos' questionnaire, which asks this question with no fieldset marker at
      // all. An assertion of truthfulness is accepted whenever it appears; marketing
      // opt-ins are still handled by the branch below and stay blank.
      if (CONFIRM_DATA_CONSENT.test(field.label)) {
        const value = consentValue(field);
        const result = value ? await fill(page, field.index, value) : { ok: false, verified: false, chosen: undefined, note: 'no confirm option recognised' };
        const ok = Boolean(result.ok && result.verified);
        report.rows.push(
          row(field, ok ? 'filled' : 'failed', ok ? `accepted: "${result.chosen ?? value}"` : result.note || 'could not confirm', {
            consent: true,
            value,
            source: 'label',
          }),
        );
        if (!ok) unresolved.push(field);
        continue;
      }
      // Marketing/newsletter opt-ins are the candidate's choice — leave blank.
      // A required consent (LGPD, terms, background-check authorisation) blocks
      // the submit gate when empty, so accept it to keep the application moving.
      if (MARKETING_CONSENT.test(field.label)) {
        report.rows.push(row(field, 'blank', 'optional marketing consent — not answered', { consent: true }));
        continue;
      }
      // Accept a compliance/authorisation consent whenever it is a consent, not only
      // when the required flag was detected. Gupy puts the "Campo obrigatório" marker
      // outside the question element, so the flag is unreliable — and an unanswered
      // required consent silently disables "Salvar e continuar", stalling the whole
      // application. Marketing opt-ins are still left alone by the branch above.
      if (field.required || REQUIRED_CONSENT.test(field.label)) {
        const value = consentValue(field);
        if (!value) {
          report.rows.push(row(field, 'blank', 'required consent — no accept option recognised', { consent: true }));
          continue;
        }
        const result = await fill(page, field.index, value);
        const ok = result.ok && result.verified;
        report.rows.push(row(field, ok ? 'filled' : 'failed', ok ? `accepted: "${result.chosen ?? value}"` : result.note || 'could not accept', { consent: true, value, source: 'label' }));
        if (!ok) unresolved.push(field);
        continue;
      }
      report.rows.push(row(field, 'blank', 'optional consent — not answered', { consent: true }));
      continue;
    }

    let key = adapter.direct[field.name] || adapter.direct[field.uid] || null;
    let source: FillRow['source'] = key ? 'adapter' : null;
    if (key && adapter.isOpaqueId(field.uid)) {
      key = null;
      source = null;
    }
    if (!key) {
      const m = match(field.label);
      if (m) {
        key = m.key;
        source = 'label';
      }
    }

    // A question that only applies when an earlier answer was YES is left blank on
    // purpose; it is answered, not unresolved.
    if (key && DELIBERATELY_BLANK.has(key)) {
      report.rows.push(row(field, 'blank', 'does not apply — no relatives at any target company', { key }));
      continue;
    }

    const value = key ? values[key] : null;
    if (!key || value == null || value === '') {
      report.rows.push(row(field, 'blank', key ? `nothing in the KB for "${key}"` : 'not recognised', { key }));
      unresolved.push(field);
      continue;
    }

    // Brazilian forms ask dates as dd/mm/aaaa with a mask that rejects ISO input, so a
    // correct date_of_birth was being typed and refused, leaving a required field
    // empty on the last step.
    const shown = formatForField(field, String(value));
    const result = await fill(page, field.index, shown);
    const status = !result.ok || !result.verified ? 'failed' : 'filled';
    report.rows.push(
      row(field, status, result.note || (source === 'adapter' ? 'known field id' : 'label match'), {
        key,
        value: shown,
        source,
      }),
    );
    if (!result.ok) unresolved.push(field);
  }

  return unresolved;
}

interface ModelCtx {
  client: LlmClient;
  profile: ReturnType<typeof loadProfile>;
  values: Record<string, string | null>;
  facts: string;
  posting: Posting;
  lang: 'pt' | 'en';
}

const mappingCache = new Map<string, { mappings: any[] }>();

async function modelPass(page: Page, unresolved: FieldDescriptor[], ctx: ModelCtx, report: FillReport): Promise<void> {
  report.llm = { state: 'running', mapped: 0 };

  try {
    const candidates = unresolved.slice(0, MAX_FIELDS_TO_MODEL);
    const mappings = await getMappings(page, candidates, ctx);

    const byUid = new Map(candidates.map((f) => [f.uid, f]));
    let composed = 0;

    for (const m of mappings) {
      const field = byUid.get(m.field_id);
      if (!field) continue;

      if (m.kind === 'none') {
        updateRow(report, field, { status: 'blank', detail: m.reason || 'nothing answers this' });
        continue;
      }

      // A citation may also be one of the field's own options: on a multi-select the
      // model picks labels the PAGE supplied ("Prompt engineering avançado"), and those
      // are given, not invented. Rejecting them left required tool/multi-select
      // questions unfillable.
      const pool = `${sourcePool(ctx)}\n${(field.options || []).join('\n')}`;
      const unsupported = checkSources(m.sources, pool, Object.keys(KEY_DESCRIPTIONS));
      if (unsupported.length) {
        updateRow(report, field, {
          status: 'blank',
          detail: `refused — cited something not in the KB: "${unsupported[0].slice(0, 60)}"`,
        });
        continue;
      }
      // Empty sources are allowed for derived/free_text (the KB is a guide), but a
      // stored answer must point at a real KB key whose value the bot can write.
      if (!m.sources?.length && m.kind === 'stored') {
        updateRow(report, field, { status: 'blank', detail: 'refused — stored answer cited no source' });
        continue;
      }

      if (m.kind === 'free_text') {
        // A choice field can only take one of its own options. When the model answers
        // one with prose ("Conta pra gente por que trabalhar aqui te parece
        // interessante?" — four fixed sentences), typing that prose into a radio
        // group fails and the required field then blocks the whole form. Compose the
        // grounded answer, then snap it to the closest option.
        if (isChoiceLike(field.kind)) {
          if (composed >= MAX_COMPOSE_CALLS) {
            updateRow(report, field, { status: 'blank', detail: 'fixed-choice question — write this one yourself (limit reached)' });
            continue;
          }
          composed++;
          const text = await composeText(field, ctx);
          const picked = snapToOption(field.options || [], text || String(m.value || ''));
          if (!picked) {
            updateRow(report, field, { status: 'blank', detail: 'fixed-choice question — none of the options matches the answer' });
            continue;
          }
          const res = await fill(page, field.index, picked);
          const ok = res.ok && res.verified;
          updateRow(report, field, {
            status: ok ? 'review' : 'failed',
            detail: ok ? 'composed answer snapped to the closest option' : res.note || 'could not select the option',
            key: m.kb_key,
            value: picked,
            source: 'model',
          });
          continue;
        }
        if (composed >= MAX_COMPOSE_CALLS) {
          updateRow(report, field, { status: 'blank', detail: 'open question — write this one yourself (limit reached)' });
          continue;
        }
        composed++;
        await composeInto(page, field, ctx, m, report);
        continue;
      }

      const value = m.option || (m.kind === 'stored' ? ctx.values[m.kb_key] : m.value);
      if (value == null || value === '') {
        updateRow(report, field, { status: 'blank', detail: `the model chose "${m.kb_key || 'a derived value'}" but there was nothing to write` });
        continue;
      }

      const flags = m.kind === 'derived' ? check(String(value), { kb: ctx.profile.kb, posting: ctx.posting, base: m.sources.join(' ') }) : [];
      if (flags.length) {
        updateRow(report, field, { status: 'blank', detail: `refused — derived value contained an unsupported claim: ${flags[0].term}` });
        continue;
      }

      const result = await fill(page, field.index, value);
      const status = !result.ok || !result.verified ? 'failed' : 'review';
      updateRow(report, field, { status, detail: result.note || (m.kind === 'stored' ? `model matched to ${m.kb_key}` : 'derived from KB'), key: m.kb_key, value, source: 'model' });
    }
    report.llm = { state: 'done', mapped: mappings.length };
  } catch (e) {
    report.llm = { state: 'error', mapped: 0 };
    report.errors.push(String((e as Error).message || e));
  }
}

async function getMappings(page: Page, fields: FieldDescriptor[], ctx: ModelCtx): Promise<any[]> {
  const cacheKey = formKey(page, fields, ctx.profile.kb.meta?.version);
  const cached = mappingCache.get(cacheKey);
  if (cached?.mappings) return cached.mappings;

  const res = (await ctx.client.call({
    task: 'mapping',
    system: MAPPING_SYSTEM,
    input: mappingInput({
      fields: fields.map(({ uid, label, kind, options, required }) => ({ uid, label, kind, options, required })),
      keyDescriptions: KEY_DESCRIPTIONS,
      facts: ctx.facts,
      posting: ctx.posting,
      lang: ctx.lang,
    }),
    schema: MAPPING_SCHEMA,
    temperature: 0,
    maxTokens: 4000,
  })) as { mappings?: any[] };

  const mappings = res.mappings || [];
  mappingCache.set(cacheKey, { mappings });
  return mappings;
}

function formKey(page: Page, fields: FieldDescriptor[], kbVersion: unknown): string {
  const host = new URL(page.url()).hostname;
  const names = fields.map((f) => f.uid).sort().join('|');
  let hash = 0;
  for (let i = 0; i < names.length; i++) hash = (hash * 31 + names.charCodeAt(i)) | 0;
  return `map:${host}:${kbVersion ?? '0'}:${hash}`;
}

// The composed answer for a question, without writing it anywhere. Used when the
// target is a fixed-choice question: the text is only a basis for picking an option.
async function composeText(field: FieldDescriptor, ctx: ModelCtx): Promise<string> {
  const arche = pickArchetype(field.label, ctx.lang, ctx.profile.archetypes);
  const maxChars = field.maxLength || 1200;
  const text = (await ctx.client.call({
    task: 'compose',
    system: COMPOSE_SYSTEM,
    input: composeInput({ question: field.label, posting: ctx.posting, facts: ctx.facts, base: arche?.text, lang: ctx.lang, maxChars }),
    temperature: 0.3,
    maxTokens: 800,
  })) as string;
  return String(text).trim().slice(0, maxChars);
}

// Pick the option a composed answer actually points at. Exact/substring scoring first
// (bestOption), then plain word overlap — the model paraphrases, and a fixed-choice
// question must still end up with one of ITS options selected rather than blank.
function snapToOption(options: string[], text: string): string | null {
  if (!options.length) return null;
  const exact = bestOption(options, text);
  if (exact && exact.score >= 2) return exact.text;

  const words = (s: string) =>
    String(s || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3);
  const want = new Set(words(text));
  let best: { text: string; overlap: number } | null = null;
  for (const o of options) {
    const overlap = words(o).filter((w) => want.has(w)).length;
    if (!best || overlap > best.overlap) best = { text: o, overlap };
  }
  if (best && best.overlap > 0) return best.text;
  // Nothing in the composed answer maps onto an option. Selecting at random would put
  // a claim on the application the candidate never made, so leave it for the gate.
  return null;
}

async function composeInto(page: Page, field: FieldDescriptor, ctx: ModelCtx, m: any, report: FillReport): Promise<void> {
  const arche = pickArchetype(field.label, ctx.lang, ctx.profile.archetypes);
  const maxChars = field.maxLength || 1200;
  const text = (await ctx.client.call({
    task: 'compose',
    system: COMPOSE_SYSTEM,
    input: composeInput({ question: field.label, posting: ctx.posting, facts: ctx.facts, base: arche?.text, lang: ctx.lang, maxChars }),
    temperature: 0.3,
    maxTokens: 1200,
  })) as string;

  const answer = String(text).trim().slice(0, maxChars);
  const flags = check(answer, { kb: ctx.profile.kb, posting: ctx.posting, base: arche?.text });
  const result = await fill(page, field.index, answer);
  const status = !result.ok || !result.verified ? 'failed' : 'review';
  updateRow(report, field, {
    status,
    detail: (arche ? `written from your "${arche.id}" answer` : 'written from KB') + (flags.length ? ` — ⚠ ${flags.map((f) => f.term).join(', ')}` : ''),
    key: 'free_text',
    value: answer,
    source: 'model',
  });
}

// Re-express a value in the format the field's own hint asks for. Only transformations
// that keep the meaning identical are made.
function formatForField(field: FieldDescriptor, value: string): string {
  const hint = `${field.label} ${(field as unknown as { placeholder?: string }).placeholder || ''}`;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (iso) {
    const [, y, m, d] = iso;
    if (/dd\/mm\/aaaa|dd\/mm\/yyyy|dia\/m[eê]s\/ano/i.test(hint)) return `${d}/${m}/${y}`;
    if (/mm\/dd\/yyyy/i.test(hint)) return `${m}/${d}/${y}`;
  }
  return value;
}

function row(field: FieldDescriptor, status: FillRow['status'], detail?: string, extra: Partial<FillRow> = {}): FillRow {
  return {
    index: field.index,
    uid: field.uid,
    label: field.label,
    kind: field.kind,
    required: field.required,
    status,
    detail,
    ...extra,
  };
}

// Patch the existing row for this field (the deterministic pass already pushed a
// 'blank' row for it) rather than adding a duplicate.
function updateRow(report: FillReport, field: FieldDescriptor, patch: Partial<FillRow>): void {
  for (let i = report.rows.length - 1; i >= 0; i--) {
    if (report.rows[i].uid === field.uid) {
      Object.assign(report.rows[i], patch);
      return;
    }
  }
  report.rows.push(row(field, patch.status ?? 'blank', patch.detail, patch));
}

// Find the primary forward action: a "next" button (click it) or a "submit"
// button (report it, don't click). Returns 'next' | 'submit' | 'blocked' | 'none'.
async function advance(page: Page): Promise<'next' | 'submit' | 'blocked' | 'none'> {
  const next = await firstButton(page, NEXT_TEXT);
  if (next) {
    if (!(await next.isEnabled().catch(() => false))) return 'blocked';
    await dismissOverlay(page);
    await clickDirect(next);
    await confirmModal(page);
    return 'next';
  }
  const submit = await firstButton(page, SUBMIT_TEXT);
  if (submit) {
    if (!(await submit.isEnabled().catch(() => false))) return 'blocked';
    return 'submit';
  }
  return 'none';
}

// Enter Gupy's optional "Apresente-se!" dialog when it is open. This is the step
// that follows the company questions on most postings, and the only forward move
// from it is "Personalizar candidatura" — the sibling "Finalizar candidatura"
// branch loops back to the curriculum welcome without submitting.
async function enterPersonalizationDialog(page: Page): Promise<boolean> {
  const btn = page.locator('#dialog-save-personalization-step');
  if (!(await btn.count())) return false;
  if (!(await btn.isVisible().catch(() => false))) return false;
  await clickDirect(btn);
  await page.waitForTimeout(2000);
  return true;
}

// After "Salvar e continuar" on Gupy's company-questions step, a confirm dialog
// ("as respostas não poderão ser editadas") overlays the form. Accept it. On the
// very last step the overlay is instead the "Apresente-se!" optional dialog. Its
// "Finalizar candidatura" branch historically looped back to the curriculum
// welcome without ever submitting, so DO NOT click it — enter the personalization
// form ("Personalizar candidatura") instead, fill it, and submit from there.
async function confirmModal(page: Page): Promise<void> {
  await page.waitForTimeout(800);
  // Check for the "Apresente-se!" dialog BEFORE dismissOverlay runs: dismissOverlay
  // strips div.sc-dPZUQH, which is exactly the dialog's footer that holds the two
  // action buttons, so the personalize button would already be gone by the time
  // the generic confirm-handler below looks for it.
  const personalize = page.locator('#dialog-save-personalization-step');
  if ((await personalize.count()) > 0 && (await personalize.isVisible().catch(() => false))) {
    await clickDirect(personalize);
    await page.waitForTimeout(1800);
    return;
  }
  await dismissOverlay(page);
  const modal = page.locator('[data-state="open"], [role="dialog"]');
  const confirm = modal.locator('button').filter({ hasText: /^sim$|confirmar|salvar|continuar|entendi|^ok$|aceitar|concluir|enviar/i });
  for (let i = 0; i < (await confirm.count()); i++) {
    const el = confirm.nth(i);
    if ((await el.isVisible()) && !(await el.isDisabled().catch(() => true))) {
      await clickDirect(el);
      break;
    }
  }
}

// Gupy's optional "Apresente-se!" personalization step: a presentation textarea
// plus up-to-3 skill chips, then "Finalizar candidatura" submits the application.
// Detect it by its placeholder/heading so it gets its own fill path — the
// textarea's only label is its placeholder ("Escreva aqui..."), which the normal
// matcher/model pass would compose against as a meaningless question.
async function isPersonalizationStep(page: Page, scanned: ScanResult): Promise<boolean> {
  if (scanned.fields.some((f) => f.kind === 'textarea' && /escreva\s*aqui/i.test(f.label))) return true;
  return /habilidades\s*mais\s*valiosas|a\s*empresa\s*deseja\s*saber\s*mais/i.test(await bodyText(page));
}

async function handlePersonalization(page: Page, ctx: ModelCtx, report: FillReport): Promise<void> {
  const scanned = await scan(page);
  const ta = scanned.fields.find((f) => f.kind === 'textarea');
  if (ta) {
    try {
      const presentation = await composePresentation(ctx);
      if (presentation) {
        const result = await fill(page, ta.index, presentation);
        report.rows.push({
          index: ta.index,
          uid: ta.uid,
          label: 'Apresentação pessoal',
          kind: ta.kind,
          required: ta.required,
          status: result.ok && result.verified ? 'review' : 'failed',
          key: 'free_text',
          value: presentation,
          detail: result.note || 'personalization pitch written from KB',
          source: 'model',
        });
      }
    } catch {
      report.errors.push('personalization presentation could not be written');
    }
  }
  await selectSkills(page, ctx);
}

async function composePresentation(ctx: ModelCtx): Promise<string> {
  const question = 'Fale sobre você e sua trajetória profissional, contando como pode ajudar a empresa no desafio descrito na vaga.';
  const text = (await ctx.client.call({
    task: 'compose',
    system: COMPOSE_SYSTEM,
    input: composeInput({ question, posting: ctx.posting, facts: ctx.facts, base: undefined, lang: ctx.lang, maxChars: 1500 }),
    temperature: 0.3,
    maxTokens: 1200,
  })) as string;
  return String(text).trim().slice(0, 1500);
}

// Select up to 3 skill chips from the candidate's resume, preferring chips whose
// label overlaps the posting's stack. Skill chips are styled-components buttons
// carrying the sc-fHjqPf class; the only other such button ("Opcional") lives in
// the now-closed dialog. Filter to visible, short-texted ones so hidden chrome
// (menus, accessibility, news) never gets clicked.
async function selectSkills(page: Page, ctx: ModelCtx): Promise<void> {
  const stack = (ctx.posting.stack || []).map((s) => s.toLowerCase());
  const chips = page.locator('button.sc-fHjqPf');
  const n = await chips.count();
  const entries: { i: number; t: string }[] = [];
  for (let i = 0; i < n; i++) {
    const el = chips.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    const t = (await el.innerText().catch(() => '')).trim();
    if (!t || t.length > 40) continue;
    entries.push({ i, t });
  }
  const ranked = entries.sort((a, b) => {
    const at = a.t.toLowerCase();
    const bt = b.t.toLowerCase();
    const am = stack.some((s) => s && (at.includes(s) || s.includes(at)));
    const bm = stack.some((s) => s && (bt.includes(s) || s.includes(bt)));
    return (bm ? 1 : 0) - (am ? 1 : 0);
  });
  for (const e of ranked.slice(0, 3)) {
    await chips.nth(e.i).click({ force: true, timeout: 3000 }).catch(() => {});
  }
}

// Click an element. Prefer a real Playwright pointer click (mousedown/mouseup/
// click at the element's coordinates) — that is what MUI/React controlled
// components actually listen for, and it is why the bot must run non-headless.
// Fall back to a DOM .click() only when an overlay intercepts the pointer.
async function clickDirect(loc: Locator): Promise<void> {
  try {
    await loc.click({ force: true, timeout: 4000 });
  } catch {
    await loc.evaluate((el) => (el as unknown as { click(): void }).click()).catch(() => {});
  }
}

async function firstButton(page: Page, re: RegExp): Promise<Locator | null> {
  for (const loc of scopedButtons(page)) {
    const n = await loc.count();
    for (let i = 0; i < n; i++) {
      const el = loc.nth(i);
      try {
        // The "Apresente-se!" dialog's buttons carry stable ids and must only ever be
        // clicked by enterPersonalizationDialog — never by a text scan.
        if (await el.evaluate((b) => /^dialog-(save|give-up)-personalization-step$/.test(b.id || '')).catch(() => false)) continue;
        if (re.test(await buttonText(el)) && (await el.isVisible())) return el;
      } catch {
        /* skip unreadable button */
      }
    }
  }
  return null;
}

// The application form's buttons live inside a <form>/dialog; the job page keeps
// its own "Apply" button outside it. Search scoped first, then the whole page.
const FORM_SCOPE = 'form, #quick-apply-form, [role="dialog"]';
function scopedButtons(page: Page): Locator[] {
  return [
    page.locator(FORM_SCOPE).locator('button, input[type="submit"]'),
    page.locator('button, input[type="submit"]'),
  ];
}
async function buttonText(el: Locator): Promise<string> {
  return (await el.innerText().catch(() => '')) || (await el.getAttribute('value').catch(() => '')) || '';
}

async function attachResumeFor(page: Page, lang: 'pt' | 'en'): Promise<{ ok: boolean; reason?: string }> {
  try {
    const { readFileSync } = await import('node:fs');
    const filePath = resumePath(lang);
    const bytes = readFileSync(filePath);
    const base64 = bytes.toString('base64');
    const filename = lang === 'pt' ? 'Gabriel Chaves - curriculo.pdf' : 'Gabriel Chaves - resume.pdf';
    return attachResume(page, base64, filename);
  } catch (e) {
    return { ok: false, reason: String((e as Error).message || e) };
  }
}

interface SubmitOutcome {
  ok: boolean;
  reason: string;
  /**
   * Set when the board answered the submit with an e-mailed one-time code instead of
   * accepting the application. The code lands in the candidate's inbox, so this is a
   * human step — and reporting it as "submit did not confirm" hid that from them.
   */
  verificationEmail?: string;
}

/**
 * Detect a one-time e-mail verification gate.
 *
 * Greenhouse shows this *after* the submit click: "Um código de verificação foi
 * enviado para <address>. Para enviar sua inscrição, digite o código de 8
 * caracteres…". Reading the mailbox is not something this tool does, and guessing
 * the code is not possible, so the honest report is "a code was mailed to you".
 *
 * The banner stays on the page after the code is typed, so the message text alone is
 * not the condition — a gate is only pending while its code box is EMPTY. Treating the
 * text as the whole condition made the run refuse to press submit after filling the
 * code correctly, and report the gate again forever.
 */
async function pendingVerification(page: Page): Promise<string | null> {
  const text = await bodyText(page);
  if (!/c[oó]digo de verifica|verification code|security code|c[oó]digo de seguran/i.test(text)) return null;
  if (await codeAlreadyEntered(page)) return null;
  const m = text.match(/(?:enviado para|sent to)\s*([^\s,;]+@[^\s,;]+)/i);
  return (m?.[1] || '').replace(/[.,;)]+$/, '');
}

/** True when a short code-like input on the page already holds a value. */
async function codeAlreadyEntered(page: Page): Promise<boolean> {
  return page
    .evaluate(() => {
      const inputs = Array.from(
        document.querySelectorAll('input[type="text"], input[type="tel"], input:not([type]), input[type="number"]'),
      ) as HTMLInputElement[];
      return inputs.some((i) => {
        const r = i.getBoundingClientRect();
        if (!r.height || !r.width) return false;
        const max = Number(i.getAttribute('maxlength') || 0);
        const short = max > 0 && max <= 12;
        return short && i.value.trim().length >= 4;
      });
    })
    .catch(() => false);
}

// Gupy's application is a multi-step wizard. Every intermediate step advances with
// "Salvar e continuar", which matches NEXT_TEXT but NOT SUBMIT_TEXT — so the old
// code found no submit button, returned false, and logged "submit did not confirm"
// on 144 of 147 failures. The application had simply not finished walking the
// wizard. Keep advancing (bounded) until the success screen appears or the page
// stops changing.
export async function doSubmit(page: Page): Promise<SubmitOutcome> {
  let lastSig = '';
  let clicked = 0;
  for (let i = 0; i < MAX_SUBMIT_ADVANCES; i++) {
    if (await confirmSuccess(page)) return { ok: true, reason: 'confirmed' };

    // Checked first: the verification prompt renders in place of the confirmation, and
    // the form underneath stops advancing, so every later loop iteration would look
    // like a dead button. Report the gate instead of clicking it again.
    const verifyEmail = await pendingVerification(page);
    if (verifyEmail !== null) {
      return { ok: false, reason: 'a verification code was e-mailed — only you can enter it', verificationEmail: verifyEmail };
    }

    // No-progress guard: same URL, same field count and same body length means the
    // click did nothing. Stop rather than fire a dozen identical clicks.
    const sig = await pageSignature(page);
    if (i > 0 && sig === lastSig) {
      const lateVerify = await pendingVerification(page);
      if (lateVerify !== null) {
        return { ok: false, reason: 'a verification code was e-mailed — only you can enter it', verificationEmail: lateVerify };
      }
      return { ok: false, reason: `page did not advance after ${clicked} step(s)` };
    }
    lastSig = sig;

    const submit = await firstButton(page, SUBMIT_TEXT);
    if (submit) {
      if (!(await submit.isEnabled().catch(() => false))) return { ok: false, reason: 'submit button disabled' };
      await dismissOverlay(page);
      await clickDirect(submit);
      clicked++;
    } else {
      const next = await firstButton(page, NEXT_TEXT);
      if (!next) return { ok: false, reason: 'no submit or advance button found' };
      if (!(await next.isEnabled().catch(() => false))) return { ok: false, reason: 'advance button disabled' };
      await dismissOverlay(page);
      await clickDirect(next);
      await confirmModal(page);
      clicked++;
    }
    await page.waitForTimeout(3500);
  }
  return {
    ok: await confirmSuccess(page),
    reason: `still not confirmed after ${MAX_SUBMIT_ADVANCES} step(s)`,
  };
}

// Cheap identity for "did this click change anything": URL + field count + body size.
async function pageSignature(page: Page): Promise<string> {
  const fields = await page
    .locator('input, textarea, select, [role="combobox"]')
    .count()
    .catch(() => 0);
  const text = (await bodyText(page)).length;
  return `${page.url()}|${fields}|${text}`;
}

async function confirmSuccess(page: Page): Promise<boolean> {
  const text = await bodyText(page);
  // Strict signals only. A bare "sucesso"/"success"/"obrigado" appears in nav and
  // cookie banners and used to turn an incomplete form into a false "submitted".
  // Gupy's post-submit screen reads "Candidatura finalizada!" — include it.
  return /candidatura\s*(enviada|recebida|realizada|conclu[ií]da|finalizada)|inscri[çc][ãa]o\s*(enviada|recebida|realizada|conclu[ií]da|finalizada)|enviada\s*com\s*sucesso|application\s*(submitted|received)|application\s*sent|thank\s*you\s*for\s*(applying|your\s*application)|recebemos\s*(sua|a\s*sua)/i.test(text);
}
