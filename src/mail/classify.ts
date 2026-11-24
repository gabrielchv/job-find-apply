// Sorting job mail into the handful of categories that change what the applicant should
// do next. Pure keyword rules, Portuguese and English, because that is what Brazilian
// boards and international ones actually send.
//
// The categories exist to drive a to-do list, not to be clever: "this needs you today"
// (a test, a code, an interview to schedule) is worth surfacing; "this is a rejection"
// is worth knowing; "this is a job alert" is noise.
import type { MailMessage } from './types.js';

export type MailKind =
  | 'test_reuse'
  | 'verification_code'
  | 'assessment'
  | 'interview'
  | 'offer'
  | 'rejection'
  | 'application_received'
  | 'recruiter_reply'
  | 'job_alert'
  | 'other';

export interface Classified {
  kind: MailKind;
  /** What the applicant should do, or '' when nothing is required. */
  action: string;
  /** Higher means more urgent: 0-100. */
  urgency: number;
}

const RULES: {
  kind: MailKind;
  test: RegExp;
  action: string;
  urgency: number;
  /** When set, the message only asks for action if it also matches this. */
  informationalUnless?: RegExp;
}[] = [
  {
    // Third-party assessment platforms (Mindsight among them) mail their own codes to
    // confirm that previous test scores are reused in a new selection process. These
    // look like ATS verification codes but are answered on the platform's site, not on
    // an application form — sending the candidate to "finish the application" is wrong.
    kind: 'test_reuse',
    test: /reaproveit\w*|c[oó]digo\s+de\s+confirma[çc][ãa]o\s+mindsight|reutiliza\w*\s+(das\s+)?(suas\s+)?(notas|testes|resultados)/i,
    action: 'confirm on the test platform that your previous results are reused',
    urgency: 80,
    // "we confirm your results WERE reused" is a receipt, not a request. Only ask for
    // action when the mail wants a code or a confirmation from the candidate.
    informationalUnless: /c[oó]digo|digite|insira/i,
  },
  {
    kind: 'verification_code',
    test: /c[oó]digo\s+(de\s+)?(verifica|seguran|acesso|confirma)|verification\s+code|security\s+code|one[- ]time\s+(code|passcode)/i,
    action: 'enter the code to finish the application',
    urgency: 95,
  },
  {
    // Checked before every other category because a rejection is terminal: whatever else
    // the message mentions (a process, a stage, an "análise"), the outcome is decided.
    // "Obrigado pelo interesse … optamos por seguir com outras candidaturas" was being
    // read as a company test and told the candidate to sit one that does not exist.
    //
    // The bare "thank you for your interest" is deliberately NOT here — boards use it in
    // plain acknowledgments; the phrasing below only appears when the answer is no.
    kind: 'rejection',
    test: /n[ãa]o\s+(seguiremos|continuaremos|avan[çc]aremos)|optamos\s+por\s+(seguir|dar\s+continuidade)\s+com\s+\w+|decidimos\s+(n[ãa]o|por\s+n[ãa]o)\s+seguir|seguiremos\s+com\s+(outr|demais)|processo\s+(foi\s+)?encerrad|unsuccessful|not\s+moving\s+forward|we\s+(have\s+)?decided\s+to\s+(move\s+forward\s+with|proceed\s+with)\s+(other|another)/i,
    action: '',
    urgency: 10,
  },
  {
    kind: 'assessment',
    test: /\bteste\b|avalia[çc][ãa]o|assessment|desafio\s*t[ée]cnico|technical\s+(challenge|test)|fit\s+cultural|prova\s+online|mapeamento\s+comportamental|mapeamento\s+de\s+habilidades/i,
    action: 'take the company test (timed, one sitting)',
    urgency: 90,
  },
  {
    // Checked before `interview` on purpose: acknowledgments often mention a future
    // interview, and this is the honest reading of "thank you for applying".
    kind: 'application_received',
    test: /recebemos\s+sua\s+candidatura|candidatura\s+(confirmada|enviada|recebida|registrada)|application\s+(received|confirmed|submitted)|thank\s+you\s+for\s+applying|congratulations\s+on\s+(applying|your\s+application)/i,
    action: '',
    urgency: 20,
  },
  {
    // The bare word "interview" is not an invitation. A "thank you for applying" mail
    // routinely says "if selected we will invite you to an interview", and matching that
    // put an acknowledgment above real work in the to-do list. An invite has a
    // scheduling signal: an invitation, a request for availability, or a booked slot.
    kind: 'interview',
    test: /convite\s+para\s+entrevista|entrevista\s+(agendada|marcada)|agende\s+(sua\s+)?entrevista|agendamento\s+(de|da)\s+entrevista|disponibilidade\s+para\s+(a\s+)?entrevista|schedule\s+(an?\s+)?(interview|call)|interview\s+(invitation|scheduled)|invite\s+you\s+(to|for)\s+(an?\s+)?interview|pick\s+a\s+time|book\s+a\s+(time|slot|call)/i,
    action: 'reply or pick an interview slot',
    urgency: 85,
  },
  {
    // A marketing mail saying "this offer ends soon" is not a job offer. Bare
    // "offer" matched Microsoft Advertising and Surfshark and put them at the top of
    // the to-do list, above real company tests, because this kind carries the highest
    // urgency. The pattern now needs job-shaped wording.
    kind: 'offer',
    test: /\bproposta\s+(de\s+)?(trabalho|emprego|contrata[çc][ãa]o|salarial|formal)|proposta\s+(em\s+anexo|anexa)|\boffer\s+letter\b|job\s+offer|extend\s+(you\s+)?an?\s+offer|contrata[çc][ãa]o\s+aprovada|you(?:'ve|\s+have)\s+been\s+(selected|chosen)/i,
    action: 'respond to the offer',
    urgency: 99,
  },

  {
    // "oportunidade" was matching LinkedIn push notifications ("Ver Cristiano A. —
    // Embaixador…"), which are noise. A recruiter actually writing to you says so in
    // one of these ways.
    kind: 'recruiter_reply',
    test: /recrutad|talent\s+acquisition|gostar[íi]amos\s+de\s+(saber|conversar)|gostaria\s+de\s+conversar|reaching\s+out\s+about|sobre\s+sua\s+candidatura|retorno\s+do\s+processo\s+seletivo|about\s+your\s+application/i,
    action: 'read and reply',
    urgency: 70,
  },
  {
    kind: 'job_alert',
    test: /novas?\s+vagas?|job\s+alert|alertas?\s+de\s+vagas?|vagas?\s+para\s+voc[êe]|recomenda[çc][õo]es\s+de\s+vagas|est[áa]\s+contratando/i,
    action: '',
    urgency: 5,
  },
];

// Domains that only send job mail. A message from one of these is job mail even when
// its wording is generic.
const JOB_SENDER = /(^|[.@])(gupy|gupy\.io|gupy\.com\.br|greenhouse|greenhouse-mail|greenhouse\.io|lever\.co|ashbyhq|workday|linkedin|indeed|kenoby|solides|abler|inhire|recrutei|mindsight)[.@]/i;

// Wording that only appears in hiring mail. Used to decide whether a message is job
// mail at all before any category can apply.
const JOB_VOCAB = /candidatura|candidat[oa]|processo\s+seletivo|\bvaga\b|\bvagas\b|entrevista|recrutad|contrata[çc][ãa]o|\bproposta\b|proposta\s+(de\s+)?(trabalho|emprego|formal)|proposta\s+salarial|oferta\s+de\s+(emprego|trabalho)|contrato\s+de\s+trabalho|curr[íi]culo|application|applicant|interview|recruiter|hiring|job\s+offer|position|role\b/i;

/**
 * Is this message job mail at all?
 *
 * Without this gate, a marketing body containing "offer" or "opportunity" lands in a
 * job category. `kind: other` is the honest answer for anything that is not hiring
 * mail, and it is what keeps the to-do list trustworthy.
 */
export function hasJobContext(message: MailMessage): boolean {
  if (JOB_SENDER.test(message.from)) return true;
  return JOB_VOCAB.test(`${message.subject} ${message.snippet}`);
}

// Social-network boilerplate that mentions recruiters without carrying a message from
// one. LinkedIn's notification digest says "…mensagens de recrutadores e mensagens
// promocionais" in its settings blurb, which matched the recruiter rule and put a
// no-op notification in the to-do list.
const NOTIFICATION_NOISE =
  /d[êe]\s+estes\s+pr[óo]ximos\s+passos|enviaremos\s+atualiza[cç][õo]es\s+do\s+linkedin|atualiza[cç][õo]es\s+da\s+sua\s+rede|mensagens\s+promocionais/i;

export function classify(message: MailMessage): Classified {
  const text = `${message.subject}\n${message.from}\n${message.snippet}`;
  if (!hasJobContext(message)) return { kind: 'other', action: '', urgency: 0 };
  if (NOTIFICATION_NOISE.test(`${message.subject} ${message.snippet}`)) {
    return { kind: 'other', action: '', urgency: 0 };
  }
  for (const rule of RULES) {
    if (!rule.test.test(text)) continue;
    const wantsAction = !rule.informationalUnless || rule.informationalUnless.test(text);
    return { kind: rule.kind, action: wantsAction ? rule.action : '', urgency: rule.urgency };
  }
  return { kind: 'other', action: '', urgency: 0 };
}

/**
 * Match a configured sender against a message.
 *
 * A plain substring test is not enough, because the domains the config naturally names
 * are not the domains mail actually arrives from: Gupy writes from `gupy.io` but boards
 * like Greenhouse write from `us.greenhouse-mail.io`, and `greenhouse.io` is not a
 * substring of that. Falling back to the sender's root label ("greenhouse") covers the
 * real sender without turning the filter into a loose keyword match.
 */
function senderMatches(hay: string, sender: string): boolean {
  const s = sender.trim().toLowerCase();
  if (!s) return false;
  if (hay.includes(s)) return true;
  const root = s.split('.')[0].replace(/-mail$/, '');
  return root.length >= 4 && hay.includes(root);
}

/** True when the message is job-related at all, given the configured sender list. */
export function isJobMail(message: MailMessage, senders: string[]): boolean {
  const hay = `${message.from} ${message.subject} ${message.snippet}`.toLowerCase();
  if (senders.some((s) => senderMatches(hay, s))) return true;
  return classify(message).kind !== 'other';
}

export const KIND_LABEL: Record<MailKind, string> = {
  test_reuse: 'test results reuse',
  verification_code: 'code to enter',
  assessment: 'company test',
  interview: 'interview',
  offer: 'offer',
  rejection: 'rejection',
  application_received: 'application received',
  recruiter_reply: 'recruiter message',
  job_alert: 'job alert',
  other: 'other',
};
