// Playwright browser lifecycle: a persistent Chromium context whose profile holds
// the one-time manual logins (Google/LinkedIn/Gupy). Never committed to git.
import { chromium, type BrowserContext } from 'playwright';
import path from 'node:path';
import { ROOT } from './config.js';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export function profileDir(): string {
  return process.env.JFA_PROFILE_DIR || path.join(ROOT, '.browser-profile');
}

export async function openPersistentContext(opts?: { headless?: boolean }): Promise<BrowserContext> {
  return chromium.launchPersistentContext(profileDir(), {
    headless: opts?.headless ?? true,
    viewport: { width: 1280, height: 900 },
    userAgent: UA,
    locale: 'pt-BR',
  });
}

// True when an apply call failed because the browser/context/page went away
// (crash, manual close, OOM). Callers use this to re-open the context and retry
// instead of silently marking every remaining job as failed.
export function isBrowserClosedError(msg: string | null | undefined): boolean {
  if (!msg) return false;
  return /closed|has been closed|target (page|context|browser)|browser (was|has) been closed/i.test(msg);
}
