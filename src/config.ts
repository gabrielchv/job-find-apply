// Configuration: settings.yaml (operational knobs) + .env (secrets).
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import type { LlmEndpoint, LlmOptions } from './llm/client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

function parseEnvFile(p: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(p)) return out;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

interface SettingsShape {
  kb_dir: string;
  resume_dir: string;
  resume_en: string;
  resume_pt: string;
  llm: { base_url: string; model: string; pricing_usd_per_1m: { input: number; output: number } };
  match: { threshold: number; max_jobs_per_run: number };
  schedule: { interval_hours: number; min_delay_ms: number; max_delay_ms: number };
  budget: { cap_usd_per_day: number };
  discovery: {
    search_terms: string[];
    greenhouse_boards: string[];
    lever_boards: string[];
    ashby_boards: string[];
    gupy: { base: string; page_size: number };
    max_pages_per_term: number;
    scrape_targets: { name: string; url: string }[];
  };
  apply: { dry_run: boolean; submit: boolean; attach_resume: boolean; resume_lang: 'auto' | 'en' | 'pt'; include_off_target?: boolean };
  notify: { command: string };
  mail?: {
    enabled: boolean;
    accounts: {
      name: string;
      address: string;
      backend: 'imap' | 'oauth';
      secret_env?: string;
      token_file?: string;
    }[];
    code: { wait_seconds: number; poll_seconds: number; lookback_minutes: number };
    triage: { lookback_days: number; senders: string[] };
    oauth: { client_file: string; token_dir: string; scopes: string[] };
  };
}

export interface Config {
  root: string;
  kbDir: string;
  resumeDir: string;
  resumeEn: string;
  resumePt: string;
  llm: {
    baseUrl: string;
    model: string;
    pricing: { input: number; output: number };
  };
  match: { threshold: number; maxJobsPerRun: number };
  schedule: { intervalHours: number; minDelayMs: number; maxDelayMs: number };
  budget: { capUsdPerDay: number };
  discovery: SettingsShape['discovery'];
  apply: SettingsShape['apply'];
  notify: { command: string };
  mail: SettingsShape['mail'];
  /**
   * Every key from config/.env, config/mail.env and the real environment, merged.
   * Callers that read a credential by name (mail app passwords) must use this rather
   * than `process.env`, or a value pasted into an env FILE is invisible to them.
   */
  rawEnv: Record<string, string | undefined>;
  env: {
    apiKey: string;
    model?: string;
    baseUrl?: string;
    budgetCap?: number;
    linkedinUsername: string;
    linkedinPassword: string;
    /** The provider that did not win selection, kept for failover. */
    fallback: LlmEndpoint | null;
  };
}

let cached: Config | null = null;

export function getConfig(): Config {
  if (cached) return cached;

  const envFile = process.env.JFA_ENV_FILE || path.join(ROOT, 'config', '.env');
  // A dedicated mail credential file, so app passwords can be pasted somewhere obvious
  // instead of buried among the model keys. Read after .env (it is the more specific
  // file) and before the real environment, which still wins.
  const mailEnvFile = process.env.JFA_MAIL_ENV_FILE || path.join(path.dirname(envFile), 'mail.env');
  const env = { ...parseEnvFile(envFile), ...parseEnvFile(mailEnvFile), ...process.env };

  // Provider selection. Both keys normally sit in .env, and the Gemini key used to
  // win unconditionally — so a depleted Gemini balance stopped the whole bot
  // ("Account has no balance (402)") even with a working DeepSeek key right there.
  // JFA_PROVIDER=deepseek|gemini picks explicitly; otherwise the first key present
  // wins, in that order.
  const provider = (env.JFA_PROVIDER || '').trim().toLowerCase();
  const useDeepSeek =
    provider === 'deepseek' || (provider !== 'gemini' && !env.GEMINI_API_KEY && !!env.DEEPSEEK_API_KEY);

  const settingsPath = process.env.JFA_SETTINGS || path.join(ROOT, 'config', 'settings.yaml');
  const settings = parseYaml(readFileSync(settingsPath, 'utf8')) as SettingsShape;

  // Both endpoints are built unconditionally, so the one that loses selection can
  // still act as a fallback. A depleted Gemini key used to stop every run ("402
  // Account has no balance") while a funded DeepSeek key sat unused in the same
  // file; the client now swaps providers on the first credit/auth failure.
  const strip = (u: string) => u.replace(/\/+$/, '');
  const deepseek: LlmEndpoint = {
    apiKey: env.DEEPSEEK_API_KEY || '',
    baseUrl: strip(env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'),
    model: env.DEEPSEEK_MODEL || 'deepseek-chat',
  };
  const gemini: LlmEndpoint = {
    apiKey: env.GEMINI_API_KEY || '',
    baseUrl: strip(env.GEMINI_BASE_URL || settings.llm.base_url),
    model: env.GEMINI_MODEL || settings.llm.model,
  };
  const primary = useDeepSeek ? deepseek : gemini;
  const spare = useDeepSeek ? gemini : deepseek;
  const fallback = spare.apiKey && spare.apiKey !== primary.apiKey ? spare : null;

  cached = {
    root: ROOT,
    kbDir: settings.kb_dir,
    resumeDir: settings.resume_dir,
    resumeEn: settings.resume_en,
    resumePt: settings.resume_pt,
    llm: {
      baseUrl: primary.baseUrl,
      model: primary.model,
      pricing: settings.llm.pricing_usd_per_1m,
    },
    match: {
      threshold: settings.match.threshold,
      maxJobsPerRun: settings.match.max_jobs_per_run,
    },
    schedule: {
      intervalHours: settings.schedule.interval_hours,
      minDelayMs: settings.schedule.min_delay_ms,
      maxDelayMs: settings.schedule.max_delay_ms,
    },
    budget: {
      capUsdPerDay: Number(env.BUDGET_CAP_USD_PER_DAY ?? settings.budget.cap_usd_per_day),
    },
    discovery: settings.discovery,
    apply: settings.apply,
    notify: settings.notify,
    mail: settings.mail,
    rawEnv: env,
    env: {
      apiKey: primary.apiKey || spare.apiKey,
      model: primary.model,
      baseUrl: primary.baseUrl,
      budgetCap: env.BUDGET_CAP_USD_PER_DAY ? Number(env.BUDGET_CAP_USD_PER_DAY) : undefined,
      linkedinUsername: env.LINKEDIN_USERNAME || '',
      linkedinPassword: env.LINKEDIN_PASSWORD || '',
      fallback,
    },
  };

  return cached;
}

/**
 * Look up a variable by name across the env files and the real environment.
 *
 * The same merge order getConfig() uses: config/.env, then config/mail.env, then the
 * process environment, so a shell export still overrides a file.
 */
export function envVar(name: string): string {
  return (getConfig().rawEnv[name] || '').trim();
}

/** LlmClient options for the configured provider, with failover already wired. */
export function llmOptions(): LlmOptions {
  const cfg = getConfig();
  return {
    apiKey: cfg.env.apiKey,
    baseUrl: cfg.llm.baseUrl,
    model: cfg.llm.model,
    pricing: cfg.llm.pricing,
    fallback: cfg.env.fallback ?? undefined,
  };
}
