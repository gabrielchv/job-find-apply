// Automated Gupy login via LinkedIn. The LinkedIn session persists in the
// persistent profile and auto-authorizes Gupy's OAuth, so a headless login
// completes in a few seconds with no credentials. When the LinkedIn session has
// expired, LINKEDIN_USERNAME / LINKEDIN_PASSWORD from .env are used as a
// fallback. A LinkedIn CAPTCHA/checkpoint cannot be automated and is reported.
import type { BrowserContext, Page } from 'playwright';
import { getConfig } from '../config.js';
import { logLogin } from '../apply/debug.js';

async function bodyText(page: Page): Promise<string> {
  return page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
}

// Gupy's candidate area is the truth for login state: an unauthenticated visit
// bounces to the signin page, a logged-in one stays on /my/applications.
async function isGupyLoggedIn(page: Page): Promise<boolean> {
  await page.goto('https://portal.gupy.io/my/applications', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1500);
  return /\/applications/i.test(page.url()) && !/signin/i.test(page.url());
}

// Fill LinkedIn's login form. Returns false when a security checkpoint blocks
// automated login (that needs a human).
async function linkedinLogin(page: Page, username: string, password: string): Promise<boolean> {
  await page.waitForTimeout(1000);
  const user = page.locator('#username, input[name="session_key"], input[autocomplete="username"]').first();
  const pass = page.locator('#password, input[name="session_password"], input[autocomplete="current-password"]').first();
  if ((await user.count()) === 0 || (await pass.count()) === 0) return false;
  await user.fill(username).catch(() => {});
  await pass.fill(password).catch(() => {});
  await page.locator('button[type="submit"]').first().click().catch(() => {});
  await page.waitForTimeout(3500);

  const b = await bodyText(page);
  if (/security check|checkpoint|puzzle|verify|confirme|verifica|captcha/i.test(b)) return false;

  // First-time authorization may still show a consent screen — accept it.
  const allow = page.locator('button').filter({ hasText: /^allow$|^aceitar$|authorize|allow access|^yes$/i }).first();
  if (await allow.count()) await allow.click().catch(() => {});
  return true;
}

export interface LoginResult {
  ok: boolean;
  reason?: string;
}

/**
 * Ensure a logged-in Gupy session, retrying a throttled attempt once.
 *
 * The LinkedIn round trip intermittently lands on its security checkpoint and then
 * succeeds seconds later on a fresh navigation — observed back to back inside one
 * supervisor run (the draft pass failed while the discovery pass immediately after
 * logged in). A single retry after a pause turns that transient into a non-event,
 * while a genuine logout still fails on both attempts and is reported.
 */
export async function ensureGupyLogin(context: BrowserContext): Promise<LoginResult> {
  let result = await ensureGupyLoginInner(context);
  if (!result.ok && /security check|blocked by a security/i.test(result.reason || '')) {
    console.log('Gupy login hit a security check — retrying once after a pause.');
    await new Promise((r) => setTimeout(r, 20_000));
    result = await ensureGupyLoginInner(context);
  }
  logLogin(result.ok, result.reason);
  return result;
}

async function ensureGupyLoginInner(context: BrowserContext): Promise<LoginResult> {
  const cfg = getConfig();
  const page = context.pages()[0] || (await context.newPage());
  try {
    if (await isGupyLoggedIn(page)) return { ok: true };

    await page.goto('https://login.gupy.io/candidates/signin', { waitUntil: 'domcontentloaded', timeout: 60000 });
    // The "LinkedIn" button is JS-rendered and can take a few seconds to appear
    // headless — poll for it instead of a single 2s check (a missed button is
    // what reported "no LinkedIn button" while the login otherwise worked).
    let ln: ReturnType<Page['locator']> | null = null;
    for (let i = 0; i < 8; i++) {
      await page.waitForTimeout(1000);
      const b = page.locator('button, a').filter({ hasText: /^linkedin$/i }).first();
      if (await b.count()) {
        ln = b;
        break;
      }
    }
    if (!ln) return { ok: false, reason: 'no LinkedIn button on the Gupy signin page' };
    await ln.click().catch(() => {});

    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(1500);
      const u = page.url();

      if (/linkedin\.com\/(login|uas\/login|checkpoint|challenge)/i.test(u)) {
        const { linkedinUsername, linkedinPassword } = cfg.env;
        if (!linkedinUsername || !linkedinPassword) {
          return { ok: false, reason: 'LinkedIn session expired and LINKEDIN_USERNAME/PASSWORD are not set in .env' };
        }
        if (!(await linkedinLogin(page, linkedinUsername, linkedinPassword))) {
          return { ok: false, reason: 'LinkedIn login blocked by a security check — log in manually' };
        }
        continue;
      }

      if (/checkpoint|challenge|security/i.test(u)) {
        return { ok: false, reason: 'LinkedIn security check — log in manually' };
      }

      // Success is landing on the candidate applications list. But the first URL
      // that matches is login.gupy.io/candidates/applications — an intermediate
      // hop. The session cookie only commits on the final portal.gupy.io redirect,
      // so keep waiting for that before declaring success (a premature return
      // left every later page bouncing to /signin).
      if (/portal\.gupy\.io\/my\/applications/i.test(u)) {
        await page.waitForTimeout(2500);
        await page.goto('https://portal.gupy.io/my/applications', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(1500);
        if (/\/applications/i.test(page.url()) && !/signin/i.test(page.url())) return { ok: true };
        return { ok: false, reason: 'session did not persist after login' };
      }
    }

    return { ok: false, reason: 'login did not complete in time' };
  } catch (e) {
    return { ok: false, reason: String((e as Error).message || e) };
  }
}
