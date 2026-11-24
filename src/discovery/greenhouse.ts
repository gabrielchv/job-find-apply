// Greenhouse discovery via the public boards API (free JSON, no auth).
import type { JobPosting } from '../types.js';
import { buildId, htmlToText, normalizeCommon } from './normalize.js';

interface GreenhouseJob {
  id: number;
  title: string;
  company_name: string;
  location: { name: string | null };
  absolute_url: string;
  content: string;
  first_published: string | null;
  updated_at: string | null;
  metadata?: { name: string; value: string | null; value_type: string }[];
}

/**
 * The URL the filler should open.
 *
 * Greenhouse has two front doors. A board's own `absolute_url` points at
 * job-boards.greenhouse.io/jobs/<id> for most companies, but some (Brex among them)
 * host a careers page that embeds the application in an iframe, so the driver sees a
 * marketing page with no form and reports "no submit or advance button found" — forever.
 *
 * The embed endpoint serves the real form as a top-level page:
 *   https://job-boards.greenhouse.io/embed/job_app?for=<board>&token=<jobId>
 * So when the posting's own URL is not a Greenhouse host, use that instead. The job id
 * and board token are both known here, which is why this belongs in discovery.
 */
function applicationUrlFor(board: string, j: GreenhouseJob): string {
  const absolute = j.absolute_url || '';
  if (/^https?:\/\/(job-boards|boards)\.greenhouse\.io\//i.test(absolute)) return absolute;
  if (!board || !j.id) return absolute;
  return `https://job-boards.greenhouse.io/embed/job_app?for=${encodeURIComponent(board)}&token=${j.id}`;
}

function toPosting(j: GreenhouseJob, board = ''): JobPosting {
  const workplaceType = j.metadata?.find((m) => /tipo de (contratação|trabalho|vaga)|workplace|modelo/i.test(m.name))?.value ?? null;
  return normalizeCommon({
    id: buildId('gh', j.id),
    title: j.title,
    company: j.company_name || 'unknown',
    location: j.location?.name || 'Brasil',
    description: htmlToText(j.content || ''),
    apply_url: applicationUrlFor(board, j),
    source: 'greenhouse',
    posted_at: j.first_published || j.updated_at,
    deadline: null,
    workplaceType: workplaceType,
  });
}

export async function searchGreenhouse(board: string): Promise<JobPosting[]> {
  const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs?content=true`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { 'User-Agent': 'job_find_apply/0.1' } });
  } catch (e) {
    console.error(`greenhouse fetch failed (${board}): ${(e as Error).message}`);
    return [];
  }
  if (!res.ok) {
    console.error(`greenhouse board ${board} returned ${res.status}`);
    return [];
  }
  const json = (await res.json()) as { jobs?: GreenhouseJob[] };
  return (json.jobs || []).map((j) => toPosting(j, board));
}
