// Match scoring: a free deterministic filter, then a DeepSeek score for survivors.
import { getConfig } from '../config.js';
import type { JobPosting, MatchResult } from '../types.js';
import { loadProfile, profileSummary } from '../profile/index.js';
import { SCORE_SCHEMA, SCORE_SYSTEM, scoreInput } from '../llm/prompts.js';
import type { LlmClient } from '../llm/client.js';
import { locationIsForeign } from '../discovery/normalize.js';

// Returns a skip reason, or null if the job passes the free filter.
export function stage1Filter(job: JobPosting): string | null {
  const t = job.title || '';

  // No usable posting text means no grounded answer is possible: applyToJob refuses
  // such a job outright ("no job description — cannot ground answers"). Skipping it
  // here rather than scoring it stops the cycle paying for a score it can never use,
  // and stops the manual list filling with rows that are not actionable.
  //
  // Scraped boards (programathor, vagas) are the main source of these: their listing
  // pages carry titles but not posting bodies, so every scraped job landed here.
  if ((job.description || '').trim().length < 80) return 'no posting text — cannot ground answers';

  // Seniority: reject clearly-senior roles that don't also welcome juniors.
  const senior = /\b(senior|s[eê]nior|sr\.?|staff|lead|principal|head|especialista|spec)\b/i;
  const junior = /\b(junior|j[uú]nior|jr\.?|pleno|trainee|est[aá]gio|estagi[aá]rio|internship|entry[- ]level)\b/i;
  if (senior.test(t) && !junior.test(t)) return 'senior-level role';

  // Relocation: on-site role abroad is out of scope (remote-only abroad).
  if (!job.remote && locationIsForeign(job.location)) return 'on-site role outside Brazil';

  return null;
}

export interface ScoreResult extends MatchResult {
  skipped: boolean;
  skipReason: string | null;
}

export async function scoreJob(client: LlmClient, job: JobPosting, kb: Record<string, any>): Promise<ScoreResult> {
  const cfg = getConfig();
  const skipReason = stage1Filter(job);
  if (skipReason) return { skipped: true, skipReason, score: 0, rationale: skipReason, stack: [] };

  const lang = job.source === 'gupy' ? 'pt' : 'pt';
  const summary = profileSummary(kb, lang);
  const input = scoreInput(summary, { title: job.title, description: job.description, location: job.location });

  const res = (await client.call({
    task: 'score',
    system: SCORE_SYSTEM,
    input,
    schema: SCORE_SCHEMA,
    temperature: 0,
    maxTokens: 400,
  })) as { score: number; rationale: string; stack: string[] };

  const score = Math.max(0, Math.min(100, Number(res.score) || 0));
  return {
    skipped: false,
    skipReason: null,
    score,
    rationale: res.rationale || '',
    stack: Array.isArray(res.stack) ? res.stack : [],
  };
}

export function passes(score: number): boolean {
  return score >= getConfig().match.threshold;
}
