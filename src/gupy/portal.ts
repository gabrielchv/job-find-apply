/// <reference lib="dom" />
// Gupy candidate portal: the truth about what is actually in progress.
//
// The portal lists every application with its progress ("Seu Progresso 1/5") and a
// link to the application page. That page renders the whole pipeline as a timeline,
// one .timeline__item per step, and each step's button is what separates an
// application the company already has from one that was never finished:
//
//   step 1 "Currículo" action "Começar"  -> a saved draft, never submitted
//   step 1 "Currículo" action "Ver"      -> the curriculum step is done
//   a later step action "Começar"        -> unfinished (and if that step is a
//                                           company test, it needs the candidate)
//
// The old rule "progress 2+ means submitted" was wrong exactly here: B4A sits at
// 2/6 with its curriculum done and a 17-minute Teste unstarted, and was reported as
// submitted while it was still an open draft. Classification is now read off the
// step buttons, never off the progress counter.
//
// Only the drafts are ours to complete, and only the steps that are not a company
// assessment: a timed test measures the candidate and cannot be undone. Everything
// here reads pages; it never submits or starts anything.
import type { Page } from 'playwright';

export interface PortalCard {
  appId: string;
  appUrl: string;
  company: string;
  role: string;
  location: string;
  workType: string;
  progress: string;
}

/** One row of the application page's pipeline timeline. */
export interface StepView {
  index: number;
  title: string;
  /** The step's button label: "Começar", "Ver", "Continuar", or '' when it has none. */
  action: string;
  checked: boolean;
  /** The card's description (deadline, "Duração máxima: 17 min", pipeline counts…). */
  detail: string;
}

/** A step the candidate still has to act on. */
export interface PendingAction {
  /** curriculum = the wizard itself; assessment = a company test we must not touch. */
  kind: 'curriculum' | 'assessment' | 'other';
  step: number;
  title: string;
  label: string;
}

export interface ApplicationInfo extends PortalCard {
  /**
   * 'draft'      the wizard was never finished — ours to complete
   * 'submitted'  the company already has the application
   * 'expired'    the curriculum step's window closed; no action button remains
   */
  state: 'draft' | 'submitted' | 'expired' | 'unknown';
  /** The step the candidate (or the bot) must act on, when there is one. */
  pendingAction: PendingAction | null;
  steps: StepView[];
  stepsDone: number;
  stepsTotal: number;
  jobUrl: string | null;
  /** Populated from the public job page: location, work model, description. */
  jobLocation: string;
  workModel: string;
  description: string;
  language: 'pt' | 'en';
  /** Extras Gupy shows on the application page that change what we may do. */
  closed: boolean;
  withdrawn: boolean;
}

const LIST_URL = 'https://portal.gupy.io/my/applications';

// The only labels a step offers when the candidate still has work to do there.
// "Ver" is deliberately absent: it means that step is done.
const STEP_START = /^(come[çc]ar(\s+(o\s+)?teste)?|continuar|responder agora|responder perguntas|iniciar(\s+(o\s+)?teste)?|realizar|acessar|fazer teste)$/i;

// A company assessment: it measures the candidate, is time-boxed, and starting it
// burns the attempt. The bot must never click it, so it is classified separately
// from the curriculum wizard it otherwise fills.
const ASSESSMENT = /teste\b|prova\s*(online|t[ée]cnica)|assessment|avalia[çc][ãa]o|din[âa]mica|desafio\s*t[ée]cnico|gravar\s*v[íi]deo|dura[çc][ãa]o\s*m[áa]xima/i;

export function isActionableStep(action: string): boolean {
  return STEP_START.test((action || '').trim());
}

export function isAssessmentStep(step: { title: string; detail: string }): boolean {
  return ASSESSMENT.test(`${step.title || ''} ${step.detail || ''}`);
}

export interface StepClassification {
  state: 'draft' | 'submitted' | 'expired' | 'unknown';
  pendingAction: PendingAction | null;
}

/**
 * Decide an application's state from its pipeline steps.
 *
 * State answers one question — does the company have this application? — and the
 * curriculum step answers it: "Começar" means the wizard was never finished,
 * "Ver" means it was. `pendingAction` answers a second, independent one: is there
 * anything left for a human (or the bot) to click? Keeping them apart matters
 * because the two honest outcomes differ:
 *
 *   curriculum undone                    -> a draft the bot may finish
 *   curriculum done, a test waiting      -> submitted, but only the candidate can
 *                                           take the test
 *   curriculum done, nothing waiting     -> submitted, nothing to do
 *
 * Reading the progress counter instead produced the opposite answer for all three.
 *
 * Pure and exported: these rules are the whole point of the module and they are
 * worth a test, so they do not live inside a page.evaluate body.
 */
export function classifyApplication(input: {
  steps: StepView[];
  expired: boolean;
  /**
   * The progress counter ("Seu progresso 2/5"), when the caller could read it. Used to
   * find the step the candidate is standing in — see the open-but-buttonless case below.
   */
  stepsDone?: number;
  /** Fallbacks for pages where the timeline markup is not the one we parse. */
  hasStart?: boolean;
  hasView?: boolean;
}): StepClassification {
  const steps = input.steps || [];

  const pending = (step: StepView): PendingAction => ({
    kind: isAssessmentStep(step) ? 'assessment' : /curr[íi]culo|curr[ií]culum|dados/i.test(step.title) || step.index <= 1 ? 'curriculum' : 'other',
    step: step.index,
    title: step.title || `etapa ${step.index}`,
    label: step.action,
  });

  const actionable = steps.filter((s) => isActionableStep(s.action));

  if (actionable.length) {
    const step = actionable[0];
    const action = pending(step);
    // The wizard is only unfinished while the curriculum step itself is open. A
    // later step offering "Começar" (a test, an interview scheduling) means the
    // application already reached the company — the outstanding item is an extra
    // step for the candidate, not a draft to submit.
    const curriculumOpen = action.kind === 'curriculum';
    return { state: curriculumOpen ? 'draft' : 'submitted', pendingAction: action };
  }

  if (steps.length) {
    // No step offers a button — but that does not always mean "nothing to do".
    //
    // Attus runs its test through a link in the notification email and puts no button on
    // the portal step. The card still says it is a test ("Duração máxima: 1440 min") and
    // the stage holds 100+ candidates, while the progress counter sits on that step
    // (2/5). Reading "no button" as "finished" hid a live 24-hour assessment from the
    // candidate entirely.
    //
    // The distinguishing signal is where the candidate stands: a step is in progress
    // when the progress counter has reached it and it offers no "Ver".
    // Applications merely waiting on the company sit at step 1 with everyone else's
    // stages empty, which is exactly what stepsDone=1 gives.
    const done = Number(input.stepsDone) || 0;
    if (done >= 1) {
      const current = steps.find((s) => s.index === done);
      // "Done" is a step that offers "Ver"/"Continuar" — an explicit way back into a
      // finished step. The check icon is NOT that signal: Gupy also draws it on the step
      // the candidate is currently standing in (Attus's open test step has it), so
      // trusting it reported a live 24-hour assessment as finished.
      const markedDone = Boolean(current && /^(ver|continuar)$/i.test(current.action));
      if (current && !markedDone && isAssessmentStep(current)) {
        return {
          state: 'submitted',
          pendingAction: {
            kind: 'assessment',
            step: current.index,
            title: current.title || `etapa ${current.index}`,
            // No button to name: the way in is the email link.
            label: '',
          },
        };
      }
    }
    // Otherwise the company owns whatever happens next.
    return { state: input.expired ? 'expired' : 'submitted', pendingAction: null };
  }

  // No timeline could be read (older markup, a closed posting, a redirect). Fall
  // back to the page-wide button probe rather than inventing a verdict.
  if (input.hasStart) return { state: 'draft', pendingAction: { kind: 'curriculum', step: 0, title: '', label: 'Começar' } };
  if (input.hasView) return { state: 'submitted', pendingAction: null };
  return { state: input.expired ? 'expired' : 'unknown', pendingAction: null };
}

function parseProgress(text: string): { done: number; total: number } {
  const m = /(\d+)\s*\/\s*(\d+)/.exec(text || '');
  return m ? { done: Number(m[1]), total: Number(m[2]) } : { done: 0, total: 0 };
}

// Read every card on the current page of the applications list. The card is the
// nearest MuiCard ancestor of the "Ver andamento" link; its innerText is
// company / role / location / work type / contract, plus the progress line.
async function readCards(page: Page): Promise<PortalCard[]> {
  return page.evaluate(() => {
    const out: any[] = [];
    const seen = new Set<string>();
    const links = Array.from(document.querySelectorAll('a[href*="/candidates/applications/"]')) as HTMLAnchorElement[];
    for (const a of links) {
      const card = a.closest('[class*="MuiCard"]') as HTMLElement | null;
      if (!card) continue;
      const appId = (a.href.match(/applications\/(\d+)/) || [])[1] || '';
      if (!appId || seen.has(appId)) continue;
      seen.add(appId);
      const lines: string[] = (card.innerText || '')
        .split('\n')
        .map((s: string) => s.trim())
        .filter(Boolean);
      const progressLine = lines.find((l: string) => /^\d+\s*\/\s*\d+$/.test(l)) || '';
      const meta = lines.filter((l: string) => !/^\d+\s*\/\s*\d+$/.test(l) && !/^seu progresso$/i.test(l) && !/^ver andamento/i.test(l) && !/^desistir$/i.test(l) && !/^também p\/ pc[dt]$/i.test(l));
      out.push({
        appId,
        appUrl: a.href.split('?')[0],
        company: meta[0] || '',
        role: meta[1] || '',
        location: meta[2] || '',
        workType: meta[3] || '',
        progress: progressLine,
      });
    }
    return out;
  });
}

// The list is paginated ("Candidatura 1 de 12" per page). Click "Próxima" until
// it is disabled or the page stops producing new ids.
export async function listApplications(page: Page, maxPages = 40): Promise<PortalCard[]> {
  await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);

  const all = new Map<string, PortalCard>();
  let stalls = 0;
  for (let p = 0; p < maxPages; p++) {
    const before = all.size;
    for (const c of await readCards(page)) all.set(c.appId, c);
    if (all.size === before) stalls++;
    if (stalls >= 2) break;

    const next = page.locator('button[aria-label*="róxima" i], button:has-text("Próxima"), button[aria-label*="next" i]').first();
    if ((await next.count()) === 0) break;
    if (await next.isDisabled().catch(() => true)) break;
    await next.scrollIntoViewIfNeeded().catch(() => {});
    await next.click().catch(() => {});
    await page.waitForTimeout(2500);
  }
  return [...all.values()];
}

// Inspect one application page: is the wizard finished, and where does the job
// posting live?
/**
 * Inspect one application, retrying once when the page did not render in time.
 *
 * `state: 'unknown'` reaches the candidate as "could not tell whether the wizard is
 * finished", which reads like something is wrong and needs them. In practice it is
 * almost always Gupy being slow: the same page classified cleanly on a second visit
 * (PagBank's, during a full 81-application pass). One retry after a pause removes that
 * whole class of false alarm; a page that is genuinely odd still comes back unknown.
 */
export async function inspectApplication(page: Page, card: PortalCard): Promise<ApplicationInfo> {
  const first = await inspectApplicationOnce(page, card);
  if (first.state !== 'unknown' || first.closed || first.withdrawn) return first;
  await page.waitForTimeout(2500);
  return inspectApplicationOnce(page, card);
}

async function inspectApplicationOnce(page: Page, card: PortalCard): Promise<ApplicationInfo> {
  const info: ApplicationInfo = {
    ...card,
    state: 'unknown',
    pendingAction: null,
    steps: [],
    stepsDone: parseProgress(card.progress).done,
    stepsTotal: parseProgress(card.progress).total,
    jobUrl: null,
    jobLocation: '',
    workModel: '',
    description: '',
    language: 'pt',
    closed: false,
    withdrawn: false,
  };
  try {
    await page.goto(card.appUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // The timeline is client-rendered and lags. Poll until the step list itself is
    // on the page (not merely the progress line — the step buttons and the progress
    // counter render at different times, and sampling between the two is what made
    // four submitted applications read "state unknown").
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(1000);
      const ready = await page
        .evaluate(() => {
          if (document.querySelectorAll('.timeline__item').length) return true;
          const text = document.body.innerText || '';
          return /\d+\s*\/\s*\d+/.test(text) && /(come[çc]ar|^ver$)/im.test(text);
        })
        .catch(() => false);
      if (ready) break;
    }
    await page.waitForTimeout(1200);

    const snap = await page.evaluate(() => {
      // No local helper functions here: esbuild's keepNames rewrites them to
      // __name(...) calls, which do not exist inside the page context.
      const body = document.body.innerText || '';
      // The counter has to be read from the "Seu progresso" heading. Taking the first
      // x/y anywhere in the page grabs a DATE instead: Attus's step 1 says "Termina em:
      // 04/12/2026", so the progress parsed as 4/12 and the candidate was placed at step
      // 4, past the test they still owed.
      let progress = '';
      const label = /seu\s+progresso/i.exec(body);
      if (label) {
        const after = body.slice(label.index, label.index + 80);
        const m = /(\d+)\s*\/\s*(\d+)/.exec(after);
        if (m) progress = m[0];
      }
      if (!progress) {
        // No heading (older markup): accept an x/y that cannot be a date — both sides
        // must be plausible step counts and the pair must not look like dd/mm.
        const cands = Array.from(body.matchAll(/(\d{1,2})\s*\/\s*(\d{1,2})(?!\d)/g));
        const ok = cands.find((c) => {
          const a = Number(c[1]);
          const b = Number(c[2]);
          return a >= 1 && b >= 1 && a <= b && b <= 15;
        });
        if (ok) progress = ok[0];
      }
      const jobLink = Array.from(document.querySelectorAll('a')).find((a) => /consultar a descri|clique aqui/i.test(a.textContent || ''));
      const heading = document.querySelector('h1, h2, [class*="MuiTypography-h"]');
      const steps = Array.from(document.querySelectorAll('.timeline__item')).map((it) => {
        const titleEl = it.querySelector('.expandable-card__header-text');
        const btnEl = it.querySelector('.expandable-card__button-wrapper button, .expandable-card__button-wrapper a') as HTMLElement | null;
        const bodyEl = it.querySelector('.card-body') as HTMLElement | null;
        return {
          index: Number((it.querySelector('.timeline__card-number')?.textContent || '').trim()) || 0,
          title: (titleEl?.textContent || '').replace(/\s+/g, ' ').trim(),
          action: (btnEl?.innerText || '').replace(/\s+/g, ' ').trim(),
          checked: !!it.querySelector('[data-testid="CheckCircleIcon"]'),
          detail: (bodyEl?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300),
        };
      });
      // Page-wide probe kept for pages whose timeline markup differs from the one
      // above; the classifier only uses it when no step could be parsed.
      const labels = Array.from(document.querySelectorAll('button, a')).map((b) => ((b as HTMLElement).innerText || '').replace(/\s+/g, ' ').trim());
      return {
        progress,
        jobUrl: jobLink ? (jobLink as HTMLAnchorElement).href : null,
        role: (heading?.textContent || '').replace(/\s+/g, ' ').trim(),
        steps,
        hasStart: labels.some((t) => /^come[çc]ar$/i.test(t)),
        hasView: labels.some((t) => /^(ver|continuar)$/i.test(t)),
        expired: /expirou\s*em/i.test(body),
        closed: /encerrad|expirad|n[ãa]o est[áa] mais/i.test(body),
        withdrawn: /desistiu|candidatura cancelada/i.test(body),
      };
    });

    const pr = parseProgress(snap.progress);
    if (pr.total) { info.stepsDone = pr.done; info.stepsTotal = pr.total; }
    if (snap.role) info.role = snap.role;
    if (snap.jobUrl) info.jobUrl = snap.jobUrl;
    info.closed = snap.closed;
    info.withdrawn = snap.withdrawn;
    info.steps = snap.steps;

    const verdict = classifyApplication({
      steps: snap.steps,
      expired: snap.expired,
      stepsDone: info.stepsDone,
      hasStart: snap.hasStart,
      hasView: snap.hasView,
    });
    info.state = verdict.state;
    info.pendingAction = verdict.pendingAction;
  } catch {
    info.state = 'unknown';
  }
  return info;
}

// Pull the posting text, location and work model off the public job page. The
// answers the bot writes must be grounded in THIS posting, so a draft whose
// description cannot be read is not safe to auto-submit.
export async function readJobPosting(page: Page, jobUrl: string): Promise<{ location: string; workModel: string; description: string; language: 'pt' | 'en' }> {
  const out = { location: '', workModel: '', description: '', language: 'pt' as 'pt' | 'en' };
  try {
    await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2500);
    const snap = await page.evaluate(() => {
      const main = document.querySelector('main') as HTMLElement | null;
      const text = (main?.innerText || document.body.innerText || '').trim();
      const loc = (text.match(/Local de trabalho:\s*([^\n]+)/) || [])[1] || '';
      const model = (text.match(/Modelo de trabalho:\s*([^\n]+)/) || [])[1] || '';
      return { text, loc: loc.trim(), model: model.trim() };
    });
    out.location = snap.loc;
    out.workModel = snap.model;
    out.description = snap.text.slice(0, 6000);
    const pt = (out.description.match(/\b(vaga|empresa|requisitos|atividades|benef[ií]cios|experi[êe]ncia|conhecimento)\b/gi) || []).length;
    const en = (out.description.match(/\b(requirements|responsibilities|benefits|experience|you will|we are|engineer)\b/gi) || []).length;
    out.language = pt >= en ? 'pt' : 'en';
  } catch {
    /* leave blank — the caller treats an empty description as unsafe */
  }
  return out;
}

// Roles the candidate has explicitly ruled out. The KB states plainly that he does
// not want IT support / help desk / service desk, and the discovery terms for them
// were removed on 2026-10-29 because they had produced 72% of all submissions.
// Completing one of those drafts would spend the same effort to produce an
// application he would decline, so they are reported, not submitted.
const OFF_TARGET = /\b(suporte|help\s*desk|service\s*desk|atendimento|telemarketing|sac|call\s*center|field\s*service|t[eé]cnico\s+(de|em)\s+(ti|inform[aá]tica|redes|manuten[cç][aã]o)|analista\s+de\s+infraestrutura|operador\s+de\s+micro)\b/i;

export function isOffTarget(title: string): boolean {
  return OFF_TARGET.test(title || '');
}
