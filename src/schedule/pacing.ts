// Human-like pacing.
import { getConfig } from '../config.js';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function jitter(): number {
  const cfg = getConfig();
  const { minDelayMs, maxDelayMs } = cfg.schedule;
  return minDelayMs + Math.random() * (maxDelayMs - minDelayMs);
}

export async function pace(): Promise<void> {
  await sleep(jitter());
}
