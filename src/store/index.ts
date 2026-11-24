// SQLite store via node:sqlite (built-in, zero native deps).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { getConfig, ROOT } from '../config.js';
import type { JobPosting, JobRecord, JobStatus } from '../types.js';

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;
  const file = process.env.JFA_DB || path.join(ROOT, 'state', 'job_find_apply.sqlite');
  mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      source TEXT, title TEXT, company TEXT, location TEXT,
      apply_url TEXT, posted_at TEXT, description TEXT,
      status TEXT, score REAL, rationale TEXT,
      first_seen TEXT, last_updated TEXT
    );
    CREATE TABLE IF NOT EXISTS applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT, url TEXT, company TEXT, role TEXT,
      at TEXT, result TEXT, reason TEXT, report TEXT
    );
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT, finished_at TEXT,
      discovered INTEGER, scored INTEGER, shortlisted INTEGER,
      submitted INTEGER, deferred INTEGER, failed INTEGER
    );
    CREATE TABLE IF NOT EXISTS spend (
      day TEXT PRIMARY KEY, usd REAL
    );
  `);
  return db;
}

export function upsertJob(job: JobPosting): void {
  const d = getDb();
  const now = new Date().toISOString();
  d.prepare(
    `INSERT INTO jobs (id, source, title, company, location, apply_url, posted_at, description, status, first_seen, last_updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'discovered', ?, ?)
     ON CONFLICT(id) DO UPDATE SET last_updated = excluded.last_updated`,
  ).run(job.id, job.source, job.title, job.company, job.location, job.apply_url, job.posted_at, job.description, now, now);
}

export function setScore(id: string, score: number, rationale: string, status: JobStatus): void {
  getDb().prepare(`UPDATE jobs SET score = ?, rationale = ?, status = ?, last_updated = ? WHERE id = ?`).run(
    score, rationale, status, new Date().toISOString(), id,
  );
}

export function setStatus(id: string, status: JobStatus): void {
  getDb().prepare(`UPDATE jobs SET status = ?, last_updated = ? WHERE id = ?`).run(status, new Date().toISOString(), id);
}

export function getJob(id: string): JobRecord | undefined {
  return getDb().prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as unknown as JobRecord | undefined;
}

export function getShortlisted(): JobRecord[] {
  return getDb().prepare(`SELECT * FROM jobs WHERE status = 'shortlisted' ORDER BY score DESC`).all() as unknown as JobRecord[];
}

export function getJobsByStatuses(statuses: JobStatus[]): JobRecord[] {
  const placeholders = statuses.map(() => '?').join(',');
  return getDb().prepare(`SELECT * FROM jobs WHERE status IN (${placeholders}) ORDER BY score DESC`).all(...statuses) as unknown as JobRecord[];
}

export function countByStatus(status: JobStatus): number {
  const row = getDb().prepare(`SELECT COUNT(*) AS n FROM jobs WHERE status = ?`).get(status) as { n: number };
  return row?.n ?? 0;
}

export function logApplication(entry: {
  job_id: string;
  url: string;
  company: string;
  role: string;
  result: 'submitted' | 'deferred' | 'failed';
  reason?: string;
  report?: string;
}): void {
  getDb()
    .prepare(`INSERT INTO applications (job_id, url, company, role, at, result, reason, report) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(entry.job_id, entry.url, entry.company, entry.role, new Date().toISOString(), entry.result, entry.reason || null, entry.report || null);
}

export interface ApplicationRecord {
  job_id: string;
  url: string;
  company: string;
  role: string;
  at: string;
  result: string;
  reason: string | null;
}

/**
 * The most recent attempt for a job.
 *
 * A job's status says "needs_manual"; only the attempt log says why — an e-mailed code,
 * a missing field, a dead posting. That difference is what turns a to-do list entry into
 * an instruction, so the summary reads it here rather than repeating the status.
 */
export function latestApplication(jobId: string): ApplicationRecord | undefined {
  const row = getDb()
    .prepare(
      `SELECT job_id, url, company, role, at, result, reason FROM applications WHERE job_id = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(jobId) as ApplicationRecord | undefined;
  return row;
}

/**
 * True when any attempt for this job failed for a reason matching `pattern`.
 *
 * Deliberately scans every attempt, not just the last one: a later dry-run (or any
 * retry that fails earlier, for a different reason) overwrites the newest reason, and
 * looking only there made a mail-gated job look like a fresh, retryable failure.
 */
export function applicationReasonMatches(jobId: string, pattern: RegExp): boolean {
  const rows = getDb()
    .prepare(`SELECT reason FROM applications WHERE job_id = ? ORDER BY id DESC LIMIT 25`)
    .all(jobId) as { reason: string | null }[];
  return rows.some((r) => r.reason && pattern.test(r.reason));
}

/**
 * Has this role already been submitted at a company matching `company`?
 *
 * A last line of defence against duplicate applications. Status bookkeeping can drift
 * (the portal and the feed name companies differently, and the draft pass logs under
 * its own job id), but the attempt log records every submission — so the runner checks
 * the log itself before spending a real application.
 */
export function alreadySubmitted(company: string, role: string): boolean {
  const norm = (v: string) => String(v || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const c = norm(company);
  const t = norm(role);
  if (!t) return false;
  const rows = getDb()
    .prepare(
      `SELECT company, role FROM applications
       WHERE result = 'submitted' AND lower(replace(replace(trim(role), '  ', ' '), '  ', ' ')) = ?`,
    )
    .all(t) as { company: string; role: string }[];
  return rows.some((r) => {
    const rc = norm(r.company);
    return rc === c || (c.length >= 4 && rc.length >= 4 && (rc.startsWith(c) || c.startsWith(rc)));
  });
}

// Has the candidate already applied to this company before?
//
// Gupy asks "você já participou de outro processo seletivo aqui?" on a lot of the
// larger boards. The answer is not a guess and not a KB preference — it is a fact the
// application log already holds, so it is derived from the log instead of invented.
// The portal is the source of truth, and it identifies an application by company +
// role, not by our internal job id. Reconciling on that pair is what keeps
// `npm run status` from reporting needs_manual for applications long since submitted.
export function setStatusByCompanyRole(company: string, role: string, status: JobStatus): number {
  const norm = (v: string) => String(v || '').replace(/\s+/g, ' ').trim();
  const c = norm(company);
  const t = norm(role);
  if (!c || !t) return 0;
  // Internal double spaces differ between the portal card and the discovery feed
  // ("Desenvolvedor Java PL  " vs "Desenvolvedor Java PL"), so compare normalised.
  const db = getDb();
  const exact = db
    .prepare(
      `UPDATE jobs SET status = ?, last_updated = ?
       WHERE lower(replace(replace(trim(company), '  ', ' '), '  ', ' ')) = lower(?)
         AND lower(replace(replace(trim(title), '  ', ' '), '  ', ' ')) = lower(?)`,
    )
    .run(status, new Date().toISOString(), c, t);
  if (Number(exact.changes || 0) > 0) return Number(exact.changes);

  // The portal and the discovery feed name the same company differently: the
  // application page says "GIRO.TECH" while the posting says "GIRO.TECH - Tecnologia
  // para originação e distribuição de crédito.". Exact matching left the discovered row
  // on needs_manual, so the next cycle applied to the same job a second time — a real
  // duplicate application. Fall back to one name starting the other, which is the shape
  // this mismatch takes, and keep the role exact so a different opening is unaffected.
  const rows = db
    .prepare(
      `SELECT id, company, title FROM jobs
       WHERE lower(replace(replace(trim(title), '  ', ' '), '  ', ' ')) = lower(?)`,
    )
    .all(t) as { id: string; company: string; title: string }[];
  const target = c.toLowerCase();
  const loose = rows.filter((row) => {
    const rc = norm(row.company).toLowerCase();
    if (!rc || rc === target) return rc === target;
    // Only trust a prefix relation when the shorter name is substantial, otherwise
    // "Stone" would sweep up "Stonehill" and every other company sharing a stem.
    const [short, long] = rc.length <= target.length ? [rc, target] : [target, rc];
    return short.length >= 4 && long.startsWith(short);
  });
  const now = new Date().toISOString();
  for (const row of loose) db.prepare(`UPDATE jobs SET status = ?, last_updated = ? WHERE id = ?`).run(status, now, row.id);
  return loose.length;
}

/**
 * When was this role last submitted to a company matching `company`, if ever?
 *
 * Used to tell a live verification code from a spent one: Greenhouse mails a code at
 * submit time, and if a submission for that company landed *after* the mail, the code
 * has already done its job. Prefix matching handles the portal/feed naming mismatch
 * ("GIRO.TECH" vs "GIRO.TECH - Tecnologia para …").
 */
export function lastSubmissionAt(company: string): Date | null {
  const norm = (v: string) => String(v || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const target = norm(company);
  if (!target) return null;
  const rows = getDb()
    .prepare(`SELECT company, at FROM applications WHERE result = 'submitted' ORDER BY at DESC LIMIT 200`)
    .all() as { company: string; at: string }[];
  for (const row of rows) {
    const rc = norm(row.company);
    if (!rc) continue;
    const [short, long] = rc.length <= target.length ? [rc, target] : [target, rc];
    if (rc === target || (short.length >= 4 && long.startsWith(short))) {
      const at = Date.parse(row.at);
      if (Number.isFinite(at)) return new Date(at);
    }
  }
  return null;
}

export function hasAppliedToCompany(company: string): boolean {
  const name = String(company || '').trim();
  if (!name) return false;
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM applications WHERE result = 'submitted' AND company = ?`)
    .get(name) as { n: number } | undefined;
  return (row?.n ?? 0) > 0;
}

export function startRun(): number {
  const r = getDb().prepare(`INSERT INTO runs (started_at) VALUES (?)`).run(new Date().toISOString());
  return Number(r.lastInsertRowid);
}

export function finishRun(id: number, counts: Record<string, number>): void {
  getDb()
    .prepare(
      `UPDATE runs SET finished_at = ?, discovered = ?, scored = ?, shortlisted = ?, submitted = ?, deferred = ?, failed = ? WHERE id = ?`,
    )
    .run(new Date().toISOString(), counts.discovered || 0, counts.scored || 0, counts.shortlisted || 0, counts.submitted || 0, counts.deferred || 0, counts.failed || 0, id);
}

export function spendToday(): number {
  const day = new Date().toISOString().slice(0, 10);
  const row = getDb().prepare(`SELECT usd FROM spend WHERE day = ?`).get(day) as { usd: number } | undefined;
  return row?.usd ?? 0;
}

export function addSpend(usd: number): void {
  const day = new Date().toISOString().slice(0, 10);
  getDb().prepare(`INSERT INTO spend (day, usd) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET usd = usd + excluded.usd`).run(day, usd);
}
