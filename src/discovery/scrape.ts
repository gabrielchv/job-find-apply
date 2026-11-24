// Generic scraping discovery. Unlike gupy/lever/ashby/greenhouse, these boards
// have no public JSON API; instead we fetch the raw HTML, reduce it to the job
// links + their text, and hand that compact list to the LLM (Gemini) to parse
// into structured postings. The LLM does the fuzzy work — cleaning titles,
// splitting company from location, resolving relative URLs — so we never hand a
// 200 KB page of markup to the model.
import type { JobPosting } from '../types.js';
import type { LlmClient } from '../llm/client.js';
import { buildId, normalizeCommon } from './normalize.js';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

export interface ScrapeTarget {
  name: string;
  url: string;
}

const SCRAPE_SYSTEM = `You parse the text of links scraped from a job-board listing page into structured job postings.
Return a single JSON object: {"jobs":[{"title","company","location","url","description"}]}.

Rules:
- Only real job postings. Drop navigation/footer links (Entrar, Login, Home, Sobre, Cadastrar, Contato, vagas publicadas em…, pagination numbers, cookie/privacy links) and anything that is not an actual vacancy.
- title: the cleaned job title, no "Nova"/"Urgente" badges.
- company: the hiring company if the text names one, else "".
- location: "Remote"/"Remoto" or the city/state if present, else "".
- url: an absolute URL. Resolve relative hrefs against the page URL.
- description: "" unless the text carries a real 1-2 sentence summary.
- If a field is missing, use "".

Output JSON only.`;

const SCRAPE_SCHEMA = {
  type: 'object',
  required: ['jobs'],
  properties: {
    jobs: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'url'],
        properties: {
          title: { type: 'string' },
          company: { type: 'string' },
          location: { type: 'string' },
          url: { type: 'string' },
          description: { type: 'string' },
        },
      },
    },
  },
};

const NAV_TEXT = /^(entrar|entrar\/cadastrar|login|log\s*in|home|in[ií]cio|sobre|about|contato|contact|cadastr|sign\s*up|register|criar\s*conta|sair|logout|enviar\s*cv|anunciar|divulgar|privacidade|privacy|termos|terms|cookies?|pol[ií]tica)$/i;
const SKIP_HREF = /^(#|javascript:|mailto:|tel:|\/cdn-|\/static\/|\/assets\/|\/login|\/signup|\/register|\/sobre|\/about|\/contato|\/contact)/i;

function cleanText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6])>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveHref(href: string, base: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

// Reduce a raw listing page to a compact "text => url" list for the model.
function linkSnippets(html: string, baseUrl: string): string {
  const anchors: { text: string; url: string }[] = [];
  const seen = new Set<string>();
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1];
    const hrefM = attrs.match(/href\s*=\s*["']([^"']+)["']/i);
    if (!hrefM) continue;
    const href = hrefM[1].trim();
    if (SKIP_HREF.test(href)) continue;
    const text = cleanText(m[2]);
    if (!text || text.length < 4 || text.length > 500) continue;
    if (NAV_TEXT.test(text)) continue;
    const url = resolveHref(href, baseUrl);
    if (seen.has(url)) continue;
    seen.add(url);
    anchors.push({ text, url });
  }
  // Cap the payload — a listing page rarely has more than ~120 job cards.
  return anchors.slice(0, 150).map((a) => `"${a.text}" => ${a.url}`).join('\n');
}

export async function scrapeJobs(client: LlmClient, targets: ScrapeTarget[]): Promise<JobPosting[]> {
  const out: JobPosting[] = [];
  for (const t of targets) {
    let html: string;
    try {
      const res = await fetch(t.url, { headers: { 'User-Agent': UA } });
      if (!res.ok) {
        console.error(`scrape ${t.name} returned ${res.status}`);
        continue;
      }
      html = await res.text();
    } catch (e) {
      console.error(`scrape ${t.name} fetch failed: ${(e as Error).message}`);
      continue;
    }

    const snippet = linkSnippets(html, t.url);
    if (!snippet) {
      console.error(`scrape ${t.name}: no job links found`);
      continue;
    }

    let parsed: { jobs?: any[] };
    try {
      parsed = (await client.call({
        task: `scrape:${t.name}`,
        system: SCRAPE_SYSTEM,
        input: `Page URL: ${t.url}\n\nLinks:\n${snippet}`,
        schema: SCRAPE_SCHEMA,
        temperature: 0,
        maxTokens: 8000,
      })) as { jobs?: any[] };
    } catch (e) {
      console.error(`scrape ${t.name} LLM parse failed: ${(e as Error).message}`);
      continue;
    }

    for (const j of parsed.jobs || []) {
      if (!j?.url || !j?.title) continue;
      out.push(
        normalizeCommon({
          id: buildId('scrape', j.url),
          title: String(j.title),
          company: String(j.company || t.name),
          location: String(j.location || 'Brasil'),
          description: String(j.description || ''),
          apply_url: String(j.url),
          source: 'scrape',
          posted_at: null,
          deadline: null,
        }),
      );
    }
    console.log(`scrape ${t.name}: ${(parsed.jobs || []).length} jobs`);
  }
  return out;
}
