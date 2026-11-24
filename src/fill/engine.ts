// Node-side wrapper around the in-page engine (browser-engine.js).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';
import type { FillResult, ScanResult } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_SRC = readFileSync(path.join(__dirname, 'browser-engine.js'), 'utf8');
// Wrap so it serializes cleanly as a function into the page context.
const ENGINE_FN = new Function(ENGINE_SRC);

export async function install(page: Page): Promise<void> {
  await page.evaluate(ENGINE_FN as () => void);
}

/**
 * The engine lives on `window.__jfa`, so any full page load throws it away.
 * Gupy's wizard navigates for real when a step is entered ("Começar" on the
 * curriculum step), which left every later call failing with
 * "Cannot read properties of undefined (reading 'dismissOverlay')" — an error
 * about our own tooling, reported as if the application had failed.
 * Every helper therefore re-installs on demand instead of assuming the page it
 * was installed on is still the page in front of it.
 */
async function ensureInstalled(page: Page): Promise<void> {
  for (let i = 0; i < 5; i++) {
    const state = await page
      .evaluate(() => Boolean((globalThis as unknown as { __jfa?: unknown }).__jfa))
      .catch(() => null);
    if (state === true) return;
    if (state === null) {
      // Page is mid-navigation and cannot be evaluated; wait for it to settle.
      await page.waitForTimeout(500);
      continue;
    }
    await install(page).catch(() => {});
    await page.waitForTimeout(150);
  }
}

export async function scan(page: Page): Promise<ScanResult> {
  await ensureInstalled(page);
  return page.evaluate(() => (globalThis as unknown as { __jfa: { scan(): ScanResult } }).__jfa.scan());
}

export async function fill(page: Page, index: number, value: string): Promise<FillResult> {
  await ensureInstalled(page);
  return page.evaluate(
    ({ index, value }) => (globalThis as unknown as { __jfa: { fill(i: number, v: string): Promise<FillResult> } }).__jfa.fill(index, value),
    { index, value },
  );
}

export async function attachResume(page: Page, base64: string, filename: string): Promise<{ ok: boolean; reason?: string }> {
  await ensureInstalled(page);
  return page.evaluate(
    ({ base64, filename }) => (globalThis as unknown as { __jfa: { attachResume(b: string, f: string): Promise<{ ok: boolean; reason?: string }> } }).__jfa.attachResume(base64, filename),
    { base64, filename },
  );
}

export async function dismissOverlay(page: Page): Promise<void> {
  await ensureInstalled(page);
  await page.evaluate(() => (globalThis as unknown as { __jfa: { dismissOverlay(): void } }).__jfa.dismissOverlay());
}

/** Read the options a combobox renders once opened (they are often not in the DOM
 * until the control is clicked). */
export async function harvestOptions(
  page: Page,
  index: number,
): Promise<{ ok: boolean; note?: string; options: string[] }> {
  await ensureInstalled(page);
  return page.evaluate(
    (i) =>
      (globalThis as unknown as { __jfa: { harvestOptions(i: number): Promise<{ ok: boolean; note?: string; options: string[] }> } }).__jfa.harvestOptions(i),
    index,
  );
}
