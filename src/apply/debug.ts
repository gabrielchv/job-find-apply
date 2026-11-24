// Debug capture: snapshot a page's state (URL, body text, HTML, inputs, screenshot)
// to state/dumps/ so a failed application can be diagnosed after the fact. Used by
// the apply driver on every failed/blocked outcome, so "submit did not confirm" is
// never a black box.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';
import { ROOT } from '../config.js';

const DUMP_ROOT = path.join(ROOT, 'state', 'dumps');

function sanitize(s: string): string {
  return String(s).replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/_+/g, '_').slice(0, 90);
}

function dirFor(jobId: string, tag: string): string {
  const dir = path.join(DUMP_ROOT, sanitize(jobId), `${Date.now()}-${sanitize(tag)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Snapshot the current page. Returns the dump directory path (or '' on a hard
// failure). Never throws — the caller must not crash because logging failed.
export async function dumpPage(page: Page, jobId: string, tag: string): Promise<string> {
  const dir = dirFor(jobId, tag);
  try {
    writeFileSync(path.join(dir, 'url.txt'), page.url());
    const body = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
    writeFileSync(path.join(dir, 'body.txt'), body);
    const html = await page.content().catch(() => '');
    writeFileSync(path.join(dir, 'page.html'), html);
    const inputs = await page
      .evaluate(() => {
        const g = globalThis as unknown as { document: { querySelectorAll(s: string): unknown[] } };
        const els = Array.from(g.document.querySelectorAll('input, select, textarea, [role="combobox"], [role="radiogroup"], [role="radio"], [role="listbox"], button')) as any[];
        return els.map((e) => {
          const rect = e.getBoundingClientRect ? e.getBoundingClientRect() : { height: 0, width: 0 };
          return {
            tag: e.tagName || '',
            type: e.type || '',
            role: e.getAttribute ? e.getAttribute('role') || '' : '',
            name: e.name || '',
            placeholder: e.placeholder || '',
            value: String(e.value ?? '').slice(0, 100),
            text: String(e.innerText ?? '').trim().slice(0, 100),
            visible: rect.height > 0 && rect.width > 0,
            ariaChecked: e.getAttribute ? e.getAttribute('aria-checked') || '' : '',
          };
        });
      })
      .catch(() => []);
    writeFileSync(path.join(dir, 'inputs.json'), JSON.stringify(inputs, null, 2));
    await page.screenshot({ path: path.join(dir, 'shot.png') }).catch(() => {});
  } catch (e) {
    try {
      writeFileSync(path.join(dir, 'error.txt'), String((e as Error).message || e));
    } catch {
      /* ignore */
    }
  }
  return dir;
}

// Append a one-line login attempt to state/logs/login.log. Successful logins are
// noise — only failures are kept, so the log is always a short list of the
// attempts that need attention.
export function logLogin(ok: boolean, reason: string | undefined): void {
  if (ok) return;
  try {
    const dir = path.join(ROOT, 'state', 'logs');
    mkdirSync(dir, { recursive: true });
    appendFileSync(path.join(dir, 'login.log'), `${new Date().toISOString()} FAIL ${reason || ''}\n`);
  } catch {
    /* ignore */
  }
}
