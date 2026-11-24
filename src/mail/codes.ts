// Pulling a one-time code out of a real email.
//
// This is the part that must not guess. A wrong code does not merely fail: it spends
// one of a small number of verification attempts, and on some boards it locks the
// application. So extraction is deliberately conservative, and every candidate carries
// a confidence and the reason it was chosen, so the caller can refuse a weak read.
//
// What real board mail looks like (from the dumps in state/dumps/):
//
//   Greenhouse  "Um código de verificação foi enviado para … digite o código de
//                8 caracteres para confirmar que você é uma pessoa."
//   Gupy        passwordless sign-in codes, 6 digits.
//
// The message body is untrusted data. Nothing here follows links, executes parts or
// interprets instructions found in the text — it only reads a short token.
import type { CodeCandidate, MailMessage } from './types.js';

export interface ExtractOptions {
  /** Only accept a candidate at least this confident (0-100). Default 45. */
  minConfidence?: number;
  /** Ignore messages older than this. */
  since?: Date;
}

interface Shape {
  name: string;
  re: RegExp;
  /** Base confidence for a clean, isolated hit. */
  base: number;
}

// Ordered by how specific the shape is. The 8-character alphanumeric token is what
// Greenhouse sends; 6 digits is what passwordless sign-in sends.
const SHAPES: Shape[] = [
  { name: 'alnum-8', re: /\b(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9]*\d)[A-Z0-9]{8}\b/g, base: 62 },
  { name: 'digits-8', re: /\b\d{8}\b/g, base: 58 },
  { name: 'alnum-6', re: /\b(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9]*\d)[A-Z0-9]{6}\b/g, base: 52 },
  { name: 'digits-6', re: /\b\d{6}\b/g, base: 50 },
];

// Text that must never be mistaken for a code. Removing it first is what stops a phone
// number, a CNPJ, a salary or a URL path from being read as a verification token.
function scrub(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w.-]+\.\w+/g, ' ') // addresses
    .replace(/https?:\/\/\S+/gi, ' ') // links
    .replace(/\+?\d[\d\s().-]{8,}\d/g, ' ') // phone-like runs
    .replace(/\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/g, ' ') // dates
    .replace(/\b\d{2}\/\d{2}\/\d{4}\b/g, ' ') // dates, explicit
    .replace(/R\$\s?[\d.,]+/gi, ' ') // money
    .replace(/\b\d{1,3}(\.\d{3})+\b/g, ' '); // grouped numbers: 1.234.567
}

/** True when the message reads like a verification mail at all. */
export function looksLikeVerification(text: string): boolean {
  return /c[oó]digo\s+(de\s+)?(verifica|seguran|acesso|confirma)|verification\s+code|security\s+code|one[- ]time\s+(code|passcode)|\botp\b|passcode/i.test(
    text,
  );
}

/**
 * The length the mail itself says to expect ("código de 8 caracteres", "8-digit code").
 * When present this is the strongest single signal available, so it is used to promote
 * the right candidate and to reject the others.
 */
export function declaredLength(text: string): number | null {
  const m =
    text.match(/c[oó]digo\s+de\s+(\d{1,2})\s*(?:caracteres|d[íi]gitos|n[úu]meros)/i) ||
    text.match(/(\d{1,2})[- ]?(?:character|digit)\s+(?:verification\s+)?code/i);
  const n = m ? Number(m[1]) : 0;
  return n >= 4 && n <= 12 ? n : null;
}

function lineOf(text: string, index: number): string {
  const start = text.lastIndexOf('\n', index) + 1;
  const end = text.indexOf('\n', index);
  return text.slice(start, end === -1 ? text.length : end).trim();
}

function distanceToKeyword(text: string, index: number): number {
  const near = text.slice(Math.max(0, index - 120), index + 120);
  const m = /c[oó]digo|code|passcode|verifica/i.exec(near);
  if (!m) return 999;
  const kwIndex = Math.max(0, index - 120) + m.index;
  return Math.abs(kwIndex - index);
}

/**
 * All code-shaped tokens in one message, best first.
 *
 * Confidence starts from the shape, then moves for evidence: the declared length, the
 * token sitting alone on its line, its proximity to the word "code", and whether the
 * mail looks like a verification message at all. A candidate in a message that does not
 * read like verification mail is heavily penalised rather than trusted.
 */
export function extractCodes(message: MailMessage, opts: ExtractOptions = {}): CodeCandidate[] {
  const raw = `${message.subject}\n${message.snippet}`;
  const text = scrub(raw);
  const declared = declaredLength(raw);
  const verificationMail = looksLikeVerification(raw);
  const found = new Map<string, CodeCandidate & { score: number }>();

  for (const shape of SHAPES) {
    shape.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = shape.re.exec(text))) {
      const code = m[0];
      // A code is never a bare year, and a 4-digit group inside a longer number is
      // already gone (scrub). Guard the classic false positive anyway.
      if (/^(19|20)\d{2}$/.test(code)) continue;

      let score = shape.base;
      if (declared !== null) score += declared === code.length ? 30 : -25;
      if (lineOf(text, m.index) === code) score += 12;
      const dist = distanceToKeyword(text, m.index);
      if (dist <= 120) score += 10;
      else if (dist === 999) score -= 15;
      if (!verificationMail) score -= 40;
      // The applicant's own phone ending, CPF fragments and similar repeats are the
      // most common contamination; a repeated token is less likely to be a fresh code.
      if (found.has(code)) {
        const prev = found.get(code)!;
        if (score > prev.score) found.set(code, { ...prev, score, confidence: 0 });
        continue;
      }
      found.set(code, {
        code,
        message: {
          id: message.id,
          account: message.account,
          mailbox: message.mailbox,
          from: message.from,
          subject: message.subject,
          date: message.date,
        },
        shape: shape.name,
        confidence: 0,
        score,
      });
    }
  }

  const out = [...found.values()]
    .map(({ score, ...rest }) => ({ ...rest, confidence: Math.max(0, Math.min(100, Math.round(score))) }))
    .filter((c) => c.confidence >= (opts.minConfidence ?? 45))
    .sort((a, b) => b.confidence - a.confidence || (a.message.date < b.message.date ? 1 : -1));
  return out;
}

/**
 * The single best code across several mailboxes, or null when nothing is convincing.
 *
 * Newest message first on ties: a second code arriving mid-run is usually a resend, and
 * the newer one is the live one.
 */
export function bestCode(messages: MailMessage[], opts: ExtractOptions = {}): CodeCandidate | null {
  const since = opts.since?.getTime() ?? 0;
  const pool = messages.filter((m) => {
    const t = Date.parse(m.date);
    return Number.isNaN(t) || t >= since;
  });
  const all: CodeCandidate[] = [];
  for (const m of pool) all.push(...extractCodes(m, opts));
  all.sort((a, b) => b.confidence - a.confidence || (a.message.date < b.message.date ? 1 : -1));
  return all[0] ?? null;
}
