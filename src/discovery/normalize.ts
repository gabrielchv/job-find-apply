// Normalization helpers shared by the discovery sources.
import type { JobPosting } from '../types.js';

export function htmlToText(html: string): string {
  return html
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

const SENIOR_TITLES = /\b(senior|s[eê]nior|sr\.?|staff|lead|principal|head|especialista|spec)\b/i;
const JUNIOR_TITLES = /\b(junior|j[uú]nior|jr\.?|pleno|trainee|est[aá]gio|estagi[aá]rio|internship|entry[- ]level)\b/i;

export function seniorityHint(title: string): string | null {
  const t = title || '';
  if (JUNIOR_TITLES.test(t)) {
    if (/pleno/i.test(t)) return 'mid';
    return 'junior';
  }
  if (SENIOR_TITLES.test(t)) return 'senior';
  return null;
}

export function isRemote(workplaceType: string | null | undefined): boolean {
  return /remote|remoto/i.test(workplaceType || '');
}

// Best-effort foreign-country detection for on-site roles we cannot take.
const FOREIGN_HINTS = /\b(us|usa|united states|new york|california|texas|florida|london|uk|united kingdom|berlin|germany|amsterdam|netherlands|lisbon|portugal|dublin|ireland|paris|france|madrid|spain|canada|australia|singapore|dubai)\b/i;

export function locationIsForeign(location: string): boolean {
  return FOREIGN_HINTS.test(location || '');
}

export function buildId(source: string, id: string | number): string {
  return `${source}:${id}`;
}

export function joinLocation(city: string | null | undefined, state: string | null | undefined, fallback = 'Brasil'): string {
  const parts = [city, state].filter(Boolean) as string[];
  return parts.length ? parts.join(', ') : fallback;
}

export function normalizeCommon(input: Omit<JobPosting, 'remote' | 'workplace_type' | 'seniority_hint'> & { workplaceType?: string | null }): JobPosting {
  const { workplaceType, ...rest } = input;
  return {
    ...rest,
    remote: isRemote(workplaceType),
    workplace_type: workplaceType ?? null,
    seniority_hint: seniorityHint(rest.title),
  };
}
