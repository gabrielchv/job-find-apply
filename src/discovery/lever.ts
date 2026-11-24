// Lever discovery via the public postings API (free JSON, no auth):
//   GET https://api.lever.co/v0/postings/{org}?mode=json
// Returns an array of postings with full text and an apply URL.
import type { JobPosting } from '../types.js';
import { buildId, htmlToText, normalizeCommon } from './normalize.js';

interface LeverJob {
  id: string;
  text: string; // title
  categories?: { location?: string | null; allLocations?: string[]; commitment?: string | null; department?: string | null; team?: string | null };
  workplaceType?: string | null;
  country?: string | null;
  descriptionPlain?: string | null;
  description?: string | null;
  hostedUrl?: string | null;
  applyUrl?: string | null;
  createdAt?: number | null;
}

function toPosting(j: LeverJob, org: string): JobPosting {
  const location = j.categories?.location || j.categories?.allLocations?.[0] || j.country || 'Brasil';
  const desc = j.descriptionPlain || (j.description ? htmlToText(j.description) : '');
  return normalizeCommon({
    id: buildId('lever', j.id),
    title: j.text,
    company: org,
    location,
    description: desc,
    apply_url: j.applyUrl || j.hostedUrl || '',
    source: 'lever',
    posted_at: j.createdAt ? new Date(j.createdAt).toISOString() : null,
    deadline: null,
    workplaceType: j.workplaceType,
  });
}

export async function searchLever(org: string): Promise<JobPosting[]> {
  const url = `https://api.lever.co/v0/postings/${encodeURIComponent(org)}?mode=json`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { 'User-Agent': 'job_find_apply/0.1' } });
  } catch (e) {
    console.error(`lever fetch failed (${org}): ${(e as Error).message}`);
    return [];
  }
  if (!res.ok) {
    console.error(`lever board ${org} returned ${res.status}`);
    return [];
  }
  const json = (await res.json()) as LeverJob[];
  if (!Array.isArray(json)) return [];
  return json.map((j) => toPosting(j, org));
}
