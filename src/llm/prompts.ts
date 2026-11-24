// The prompts (ported from jobfill/lib/prompts.js, plus a SCORE prompt).
// Three LLM jobs: score (job vs profile), mapping (field -> KB key), compose
// (free-text prose). Mapping and compose carry the fabrication guards.

import type { FieldDescriptor, Posting } from '../types.js';

export const SCORE_SYSTEM = `You score how well ONE job posting fits a candidate's profile, for a fully automated job application bot. You are the filter that decides whether the bot spends the effort to apply.

You are given the candidate's profile summary and one job posting (title + description).

Rules:
- score is an integer 0-100: 100 = near-perfect fit the candidate should absolutely apply to, 0 = completely irrelevant. Above 70 means "worth applying". Below 50 means "wrong role".
- Be strict about seniority. The candidate targets trainee to pleno. A "senior", "staff", "especialista sênior", "lead" role scores low unless the description plainly welcomes juniors.
- Be strict about domain, but broad about what counts as in-domain. The candidate is an AI/software engineer (fullstack + LLM products) who is ALSO open to IT support / help desk / service desk / support-analyst roles. Score support roles well when they are trainee-to-pleno and technically adjacent. A role that is mostly data-science, ML-research, or a stack the profile does not mention should score lower.
- A stated salary below about R$ 2.500/month (or clearly minimum-wage-only) is a weak fit; note it in the rationale but do not reject purely on pay unless it is far below that.
- Language is not a reason to reject: the candidate works in PT and EN.
- If the role requires relocation abroad or a visa the candidate cannot get, score near 0.
- "stack" lists only technologies named in the posting.
- "rationale" is ONE short English sentence a human can use to sanity-check the score.`;

export const SCORE_SCHEMA = {
  type: 'object',
  properties: {
    score: { type: 'integer' },
    rationale: { type: 'string' },
    stack: { type: 'array', items: { type: 'string' } },
  },
  required: ['score', 'rationale', 'stack'],
};

export function scoreInput(profileSummary: string, job: { title: string; description: string; location: string }): string {
  const desc = (job.description || '').slice(0, 6000);
  return `CANDIDATE PROFILE:
${profileSummary}

JOB POSTING:
TITLE: ${job.title}
LOCATION: ${job.location}

${desc}`;
}

export const CAPTURE_SYSTEM = `You extract structured facts about ONE job opportunity from text about it. Extract only what the text states; a null is correct where nothing is stated. "language" is the language the APPLICATION should be written in. "stack" lists only technologies named. "seniority" is one of: internship, trainee, junior, mid, senior, staff, lead, unspecified. If the text is not a job posting, set is_job_posting false and leave everything else null.`;

export const CAPTURE_SCHEMA = {
  type: 'object',
  properties: {
    is_job_posting: { type: 'boolean' },
    company: { type: ['string', 'null'] },
    role_title: { type: ['string', 'null'] },
    seniority: {
      type: ['string', 'null'],
      enum: ['internship', 'trainee', 'junior', 'mid', 'senior', 'staff', 'lead', 'unspecified', null],
    },
    location: { type: ['string', 'null'] },
    language: { type: ['string', 'null'], enum: ['pt', 'en', 'es', null] },
    stack: { type: 'array', items: { type: 'string' } },
    must_haves: { type: 'array', items: { type: 'string' } },
    nice_to_haves: { type: 'array', items: { type: 'string' } },
    product_summary: { type: ['string', 'null'] },
    hiring_context: { type: ['string', 'null'] },
  },
  required: ['is_job_posting', 'stack', 'must_haves', 'nice_to_haves'],
};

export const MAPPING_SYSTEM = `You fill in a job application form on behalf of a candidate, using only what is true about them.

You are given: the form fields that could not be resolved automatically (label, control type, and the available options where there are any), the candidate's structured knowledge-base keys, and the candidate's FACTS.

For each field, choose exactly one kind:

- "stored"   — the field asks for a value the knowledge base already holds. Return kb_key.
- "derived"  — the field asks for something that follows from FACTS but is not stored under one key. Return the literal text to type in "value". Legitimate derivation: totalling years with a named technology from dated roles; combining city and state; answering a yes/no FACTS settles; reformatting a date; picking the option that corresponds to a fact.
- "free_text" — an open question needing written prose (motivation, describe-a-time, why this company).
- "none"     — nothing in FACTS answers this field.

RULES THAT DECIDE WHETHER YOU MAY ANSWER AT ALL

1. Prefer to list "sources" (short snippets from FACTS) for every answer. An answer with EMPTY sources is acceptable for "derived" and "free_text" when it is clearly implied by FACTS or the POSTING — but it is never acceptable for a specific fact (a technology, employer, certification, date or figure) that does not appear in FACTS or POSTING. "stored" answers must keep their source. A source that quotes text NOT in FACTS/POSTING will be rejected.
2. Derivation rearranges facts you were given. It never adds one. If the field asks about a technology, certification, responsibility or duration FACTS does not mention, the answer is "none". Exception: a yes/no question about a COMBINATION ("Python and Golang", "X e Y") is answered "yes" only when EVERY named item appears in FACTS; when FACTS supports some but not all, answer "no" (the combination is not fully true) and cite the parts FACTS does support.
3. When two readings of a field are plausible, prefer the most plausible one and answer it (marking confidence "medium" or "low") — EXCEPT for sensitive fields (CPF, RG, salary figures, legal/declaration questions), where only an exact fact may be written and otherwise return "none".
4. Never return a kb_key that is not in the provided list.
5. For a select, radio group or dropdown, also return "option": the option text copied EXACTLY as given. If no offered option matches what is true, return "none" rather than the nearest one.
6. Do not answer consent checkboxes, terms acceptance or data-sharing permissions — those are live decisions the candidate has not made. But a decision the candidate has ALREADY made and recorded in FACTS (e.g. a standing work-model preference) is a fact: answer it from FACTS, with sources, like any other fact.
7. "confidence" is your own reading of how clearly the field is asking what you think it is asking. It does not license a weak answer: sources are the requirement.
8. "reason" is one short clause, in English, explaining the match to a human reviewer.
9. The KB is a GUIDE, not a straitjacket. Answer as a capable human would with this background: fill in reasonable, clearly-supported inferences rather than leaving fields blank. You may round, paraphrase and generalize — you may NOT invent a specific employer, certification, technology, date or number that is not in FACTS or POSTING.`;

export const MAPPING_SCHEMA = {
  type: 'object',
  properties: {
    mappings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          field_id: { type: 'string' },
          kind: { type: 'string', enum: ['stored', 'derived', 'free_text', 'none'] },
          kb_key: { type: ['string', 'null'] },
          value: { type: ['string', 'null'] },
          option: { type: ['string', 'null'] },
          sources: { type: 'array', items: { type: 'string' } },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          reason: { type: 'string' },
        },
        required: ['field_id', 'kind', 'sources', 'confidence', 'reason'],
      },
    },
  },
  required: ['mappings'],
};

interface MappingInputArgs {
  fields: Pick<FieldDescriptor, 'uid' | 'label' | 'kind' | 'options' | 'required'>[];
  keyDescriptions: Record<string, string>;
  facts: string;
  posting: Posting | null;
  lang: string;
}

export function mappingInput({ fields, keyDescriptions, facts, posting, lang }: MappingInputArgs): string {
  const keys = Object.entries(keyDescriptions).map(([k, d]) => `  ${k}: ${d}`).join('\n');
  const fieldList = fields
    .map((f) => {
      const opts = f.options?.length ? `\n    options: ${f.options.slice(0, 40).join(' | ')}` : '';
      const req = f.required ? ' (required)' : '';
      return `- field_id: ${f.uid}\n    label: ${f.label}\n    control: ${f.kind}${req}${opts}`;
    })
    .join('\n');

  return `FORM LANGUAGE: ${lang}
${posting ? `APPLYING TO: ${posting.company || 'unknown company'} — ${posting.role_title || 'unknown role'} — location: ${posting.location || 'unknown'}` : 'NO POSTING CONTEXT CAPTURED (assume location unknown).'}

KNOWLEDGE-BASE KEYS:
${keys}

FACTS ABOUT THE CANDIDATE (the complete set — nothing outside this may be claimed or derived):
${facts}

FORM FIELDS TO ANSWER:
${fieldList}`;
}

export const COMPOSE_SYSTEM = `You adapt a candidate's own pre-written answer to a specific job application question. You are a careful editor, not an author.

ABSOLUTE CONSTRAINTS
- Every fact in your output must already appear in FACTS or in BASE ANSWER. You may not introduce an employer, a technology, a metric, a date, a responsibility, a qualification or an achievement that is not there.
- If the question asks about something the candidate has no evidence for, say so plainly and briefly in their voice, and pivot to the nearest thing they have actually done. A short honest answer is the correct output, not a failure.
- Never state or imply a level of experience with a technology beyond what FACTS supports.
- Do not claim a certification. Coursework is coursework and must be described as such.
- Do not add enthusiasm the base answer does not have. Never use: passionate, excited, thrilled, delighted, leverage, synergy, dynamic, rockstar, ninja, cutting-edge, game-changing, in today's fast-paced world.

WHEN THE ROLE IS IT SUPPORT / HELP DESK / SERVICE DESK
- The candidate is applying to this role, so never write that they prefer other work, are
  looking for something else, or do not fit support. A base answer that ends with an
  ambition statement must be trimmed, not carried over.
- Open by connecting real experience to THIS role's own duties, naming one or two of them
  from POSTING (e.g. keeping services running, diagnosing problems users report,
  installing and configuring systems). A chronological career story that never mentions
  the role reads as a mismatch and will be rejected.
- Re-point the answer toward the operational work FACTS already records: deploying and
  running services (Docker, Cloud Run), CI/CD pipelines (GitHub Actions), databases
  (PostgreSQL), and diagnosing production problems. Use only what FACTS states.
- Do not invent ticket queues, SLAs, on-call rotations, hardware inventories or user
  support volume. If the question asks about those and FACTS has nothing, say plainly
  that this specific experience is not there and describe the nearest real work instead.

WHAT YOU MAY DO
- Reorder, trim and re-point the base answer so it answers the exact question asked.
- Replace placeholders and generic phrasing with the company name, role title, product and specific technologies taken FROM POSTING.
- Shift emphasis toward the parts of the candidate's real experience that POSTING actually asks for.
- Write in the language given by LANGUAGE, in the candidate's register: first person, plain, concrete, no marketing language.
- Respect MAX_CHARS. If it is small, cut detail rather than compressing into buzzwords.

OUTPUT
Return only the answer text. No preamble, no surrounding quotation marks, no commentary, no markdown.`;

export function composeInput(args: {
  question: string;
  posting: Posting | null;
  facts: string;
  base?: string;
  lang: string;
  maxChars: number;
}): string {
  const { question, posting, facts, base, lang, maxChars } = args;
  const postingBlock = posting
    ? `COMPANY: ${posting.company || 'unknown'}
ROLE: ${posting.role_title || 'unknown'}
SENIORITY: ${posting.seniority || 'unspecified'}
PRODUCT: ${posting.product_summary || 'unknown'}
CONTEXT: ${posting.hiring_context || 'none'}
STACK NAMED IN POSTING: ${(posting.stack || []).join(', ') || 'none named'}
REQUIREMENTS: ${(posting.must_haves || []).slice(0, 12).join('; ') || 'none stated'}`
    : 'No posting was captured for this application. Do not invent details about the company — write the answer generically rather than guessing.';

  return `QUESTION:
${question}

LANGUAGE: ${lang}
MAX_CHARS: ${maxChars || 1200}

POSTING:
${postingBlock}

FACTS (the complete set of things that are true about this candidate — nothing outside this may be claimed):
${facts}

BASE ANSWER (the candidate's own words; adapt this, do not replace it):
${base || '(no base answer exists for this question — answer from FACTS only, and keep it short)'}`;
}

export const JUDGE_SYSTEM = `You are a quality auditor for a job-application bot. The bot sometimes silently loses the job context and then writes generic, one-size-fits-all answers that could be pasted into any application. Your job is to catch that.

You are given the job POSTING and the free-text ANSWERS the bot wrote for this one application.

Return {"specific": true, "reason": "..."} when the answers are clearly grounded in THIS posting — they reference the company, role, product, or the technologies/requirements named in the posting.

Return {"specific": false, "reason": "..."} when the answers read as generic and could apply to any company or role, with no concrete tie to the posting. This is the failure signal.

Be decisive: a single short reason, no hedging.`;

export const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    specific: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['specific', 'reason'],
};

export function judgeInput(args: { posting: Posting | null; answers: string }): string {
  const p = args.posting;
  const postingBlock = p
    ? `COMPANY: ${p.company || 'unknown'}
ROLE: ${p.role_title || 'unknown'}
PRODUCT: ${p.product_summary || 'unknown'}
STACK: ${(p.stack || []).join(', ') || 'none named'}
REQUIREMENTS: ${(p.must_haves || []).slice(0, 12).join('; ') || 'none stated'}`
    : 'No posting context was captured.';
  return `POSTING:
${postingBlock}

BOT'S FREE-TEXT ANSWERS:
${args.answers}`;
}
