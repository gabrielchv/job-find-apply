// Discovery orchestrator: run every source, normalize, dedup.
import { getConfig } from '../config.js';
import type { JobPosting } from '../types.js';
import type { LlmClient } from '../llm/client.js';
import { searchGupy } from './gupy.js';
import { searchGreenhouse } from './greenhouse.js';
import { searchLever } from './lever.js';
import { searchAshby } from './ashby.js';
import { scrapeJobs } from './scrape.js';

export async function discover(client?: LlmClient): Promise<JobPosting[]> {
  const cfg = getConfig();
  const jobs: JobPosting[] = [];

  for (const term of cfg.discovery.search_terms) {
    try {
      const found = await searchGupy(term, cfg.discovery.max_pages_per_term);
      jobs.push(...found);
    } catch (e) {
      console.error(`gupy term "${term}" failed: ${(e as Error).message}`);
    }
  }

  for (const board of cfg.discovery.greenhouse_boards) {
    try {
      const found = await searchGreenhouse(board);
      jobs.push(...found);
    } catch (e) {
      console.error(`greenhouse board "${board}" failed: ${(e as Error).message}`);
    }
  }

  for (const org of cfg.discovery.lever_boards) {
    try {
      const found = await searchLever(org);
      jobs.push(...found);
    } catch (e) {
      console.error(`lever org "${org}" failed: ${(e as Error).message}`);
    }
  }

  for (const org of cfg.discovery.ashby_boards) {
    try {
      const found = await searchAshby(org);
      jobs.push(...found);
    } catch (e) {
      console.error(`ashby org "${org}" failed: ${(e as Error).message}`);
    }
  }

  if (client && cfg.discovery.scrape_targets?.length) {
    try {
      const found = await scrapeJobs(client, cfg.discovery.scrape_targets);
      jobs.push(...found);
    } catch (e) {
      console.error(`scrape failed: ${(e as Error).message}`);
    }
  }

  const seen = new Map<string, JobPosting>();
  for (const j of jobs) if (!seen.has(j.id)) seen.set(j.id, j);
  return [...seen.values()];
}
