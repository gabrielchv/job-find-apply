// Gupy discovery. The public portal (portal.gupy.io) server-renders its search
// results into a Next.js __NEXT_DATA__ script; no auth and no secret API needed.
// Pagination is via `page=N` in the path.
import { getConfig } from '../config.js';
import type { JobPosting } from '../types.js';
import { buildId, joinLocation, normalizeCommon } from './normalize.js';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

interface GupyJob {
  id: number;
  name: string;
  description: string;
  city: string | null;
  state: string | null;
  type: string;
  workplaceType: string | null;
  publishedDate: string | null;
  applicationDeadline: string | null;
  careerPageName: string;
  jobUrl: string;
}

interface NextData {
  props?: { pageProps?: { initialJobList?: { data?: GupyJob[]; pagination?: { total?: number; limit?: number; offset?: number } } } };
}

function extractNextData(html: string): NextData | null {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

function toPosting(j: GupyJob): JobPosting {
  return normalizeCommon({
    id: buildId('gupy', j.id),
    title: j.name,
    company: j.careerPageName || 'unknown',
    location: joinLocation(j.city, j.state, 'Brasil'),
    city: j.city ?? undefined,
    state: j.state ?? undefined,
    description: j.description || '',
    apply_url: j.jobUrl,
    source: 'gupy',
    posted_at: j.publishedDate,
    deadline: j.applicationDeadline,
    workplaceType: j.workplaceType,
  });
}

export async function searchGupy(term: string, maxPages: number): Promise<JobPosting[]> {
  const cfg = getConfig();
  const out: JobPosting[] = [];
  const encoded = encodeURIComponent(term).replace(/%20/g, '+');

  for (let page = 1; page <= maxPages; page++) {
    const url = `${cfg.discovery.gupy.base}/job-search/term=${encoded}&page=${page}`;
    let html: string;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!res.ok) break;
      html = await res.text();
    } catch (e) {
      console.error(`gupy fetch failed (${url}): ${(e as Error).message}`);
      break;
    }

    const data = extractNextData(html);
    const jl = data?.props?.pageProps?.initialJobList;
    const jobs = jl?.data || [];
    const total = jl?.pagination?.total || 0;
    const pageSize = jl?.pagination?.limit || cfg.discovery.gupy.page_size;

    for (const j of jobs) out.push(toPosting(j));

    if (!jobs.length || page * pageSize >= total) break;
    await new Promise((r) => setTimeout(r, 600)); // be polite
  }

  return out;
}
