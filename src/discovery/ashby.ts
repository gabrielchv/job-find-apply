// Ashby discovery via the public job-board API (free JSON, no auth):
//   GET https://api.ashbyhq.com/posting-api/job-board/{org}?includeCompensation=true
// Returns { jobs: [...] } with full description HTML and an apply URL.
import type { JobPosting } from '../types.js';
import { buildId, htmlToText, normalizeCommon } from './normalize.js';

interface AshbyJob {
  id: string;
  title: string;
  location?: string | null;
  isRemote?: boolean;
  workplaceType?: string | null;
  publishedAt?: string | null;
  jobUrl?: string | null;
  applyUrl?: string | null;
  descriptionHtml?: string | null;
  descriptionPlain?: string | null;
  employmentType?: string | null;
}

function toPosting(j: AshbyJob, org: string): JobPosting {
  const desc = j.descriptionPlain || (j.descriptionHtml ? htmlToText(j.descriptionHtml) : '');
  const workplaceType = j.isRemote ? 'remote' : j.workplaceType || null;
  return normalizeCommon({
    id: buildId('ashby', j.id),
    title: j.title,
    company: org,
    location: j.location || 'Brasil',
    description: desc,
    apply_url: j.applyUrl || j.jobUrl || '',
    source: 'ashby',
    posted_at: j.publishedAt || null,
    deadline: null,
    workplaceType,
  });
}

export async function searchAshby(org: string): Promise<JobPosting[]> {
  const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(org)}?includeCompensation=true`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { 'User-Agent': 'job_find_apply/0.1' } });
  } catch (e) {
    console.error(`ashby fetch failed (${org}): ${(e as Error).message}`);
    return [];
  }
  if (!res.ok) {
    console.error(`ashby board ${org} returned ${res.status}`);
    return [];
  }
  const json = (await res.json()) as { jobs?: AshbyJob[] };
  return (json.jobs || []).map((j) => toPosting(j, org));
}
