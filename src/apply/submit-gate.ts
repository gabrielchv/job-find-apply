// The submit gate: auto-submit only when every safety condition holds, else
// defer and (where relevant) flag a manual action.
import type { FillReport } from './driver.js';

export interface GateOptions {
  dryRun: boolean;
  submit: boolean;
}

export interface GateDecision {
  submit: boolean;
  reason: string | null;
  requiresManual: boolean;
}

export function evaluateGate(report: FillReport, opts: GateOptions): GateDecision {
  if (opts.dryRun) return { submit: false, reason: 'dry-run', requiresManual: false };
  if (!opts.submit) return { submit: false, reason: 'submission disabled in config', requiresManual: false };

  if (report.blocked) {
    return { submit: false, reason: 'the form blocked submission — a required field is unfilled', requiresManual: true };
  }

  const rows = report.rows;

  const failed = rows.filter((r) => r.status === 'failed' && r.required);
  if (failed.length) {
    return {
      submit: false,
      reason: `unverified/failed fields: ${failed.map((r) => r.label).slice(0, 3).join('; ')}`,
      requiresManual: true,
    };
  }

  // An affirmative claim about the candidate's own experience must be grounded.
  //
  // "Tem vivência com Sustentação?" was answered "Sim" from the model with detail
  // "derived from KB" and no citation, while the very next question ("já atuou com
  // fila de chamados?") was answered "Não" — and the application went out. A yes/no
  // claim about experience is a statement of fact about the candidate's history, not a
  // preference: it cannot be inferred from adjacent work, and the model was reaching.
  //
  // Anything affirmative, model-sourced, on an experience question, and carrying no
  // citation is treated as needing the candidate's confirmation. A grounded answer
  // ("KB states …") or a label/adapter match passes straight through.
  const EXPERIENCE_CLAIM =
    /viv[êe]ncia|experi[êe]ncia|j[áa]\s*(atuou|trabalhou|utilizou|usou)|atuou\s+com|conhece|domina|conhecimento\s+(com|em|de)|familiaridade|profici[êe]ncia/i;
  const AFFIRMATIVE = /^(sim|yes|true|verdadeiro|concordo|tenho)$/i;
  const ungroundedClaim = rows.filter((r) => {
    if (r.source !== 'model') return false;
    if (!AFFIRMATIVE.test(String(r.value || '').trim())) return false;
    if (!EXPERIENCE_CLAIM.test(r.label || '')) return false;
    // `detail` carries the model's own justification. A real citation quotes the KB or
    // the posting; "derived from KB" with nothing behind it is an assertion, not a source.
    const cited = Boolean(r.detail && /["“'«]|(KB|FACTS).*\b(states|says|mentions|lists)\b/i.test(r.detail)) && !/^derived from KB$/i.test(String(r.detail).trim());
    return !cited;
  });
  if (ungroundedClaim.length) {
    return {
      submit: false,
      reason: `experience claim needs your confirmation: ${ungroundedClaim.map((r) => r.label).slice(0, 3).join('; ')}`,
      requiresManual: true,
    };
  }

  const requiredConsent = rows.filter((r) => r.required && r.consent && r.status === 'blank');
  if (requiredConsent.length) {
    return { submit: false, reason: 'required consent/decision boxes left for you', requiresManual: true };
  }

  const requiredBlank = rows.filter((r) => r.required && !r.preset && (r.status === 'blank' || r.status === 'skipped'));
  if (requiredBlank.length) {
    return {
      submit: false,
      reason: `required fields unfilled: ${requiredBlank.map((r) => r.label).slice(0, 3).join('; ')}`,
      requiresManual: true,
    };
  }

  if (report.hasAssessment) {
    return { submit: false, reason: 'assessment/test step present — needs you', requiresManual: true };
  }

  return { submit: true, reason: null, requiresManual: false };
}
