// Knowledge-base loader + resolver (ported from jobfill/lib/kb.js + the
// factsBlock from prompts.js). The KB in /Documents/jobsearch/kb stays the single
// source of truth; this module only reads it, it never duplicates it.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { getConfig } from '../config.js';
import type { ResolvedValues } from '../types.js';

export interface Profile {
  kb: Record<string, any>;
  archetypes: { archetypes: Archetype[] };
}

export interface Archetype {
  id: string;
  match_en?: string[];
  match_pt?: string[];
  en?: string;
  pt?: string;
  numeric_brl?: number;
  numeric_usd?: number;
}

let cached: Profile | null = null;

export function loadProfile(): Profile {
  if (cached) return cached;
  const cfg = getConfig();
  const kb = parseYaml(readFileSync(path.join(cfg.kbDir, 'kb.yaml'), 'utf8')) as Record<string, any>;

  const secretsPath = path.join(cfg.kbDir, 'secrets.yaml');
  if (existsSync(secretsPath)) {
    const secrets = parseYaml(readFileSync(secretsPath, 'utf8')) as { sensitive?: Record<string, string> };
    kb.sensitive = secrets.sensitive || {};
  }

  const archetypes = parseYaml(readFileSync(path.join(cfg.kbDir, 'archetypes.yaml'), 'utf8')) as {
    archetypes: Archetype[];
  };

  cached = { kb, archetypes };
  return cached;
}

/** Flatten the KB into the flat key -> value map everything else reasons about. */
export function resolve(kb: Record<string, any>, lang: 'pt' | 'en'): ResolvedValues {
  const id = kb.identity;
  const a = kb.address;
  const f = kb.form_answers;
  const s = kb.sensitive || {};
  const [first, ...rest] = id.full_name.split(' ');
  const comp = kb.compensation;
  // Brazilian yes/no as the form spells it, sourced from the KB when the fact is
  // recorded there and falling back to the caller's default when it is not.
  const yesNo = (v: unknown, fallback: 'Sim' | 'Não'): string => {
    const value = v == null ? fallback === 'Sim' : Boolean(v);
    if (lang === 'pt') return value ? 'Sim' : 'Não';
    return value ? 'Yes' : 'No';
  };

  return {
    first_name: first,
    last_name: rest.join(' '),
    full_name: id.full_name,
    preferred_name: first,
    // Family names come from the KB now (provided by the candidate).
    mother_name: id.mother_name ?? null,
    father_name: id.father_name ?? null,
    email: id.email,
    phone: id.phone,
    phone_e164: id.phone_e164,
    date_of_birth: id.date_of_birth,
    birth_city: id.birth_city,
    birth_state: id.birth_state,
    birth_place: `${id.birth_city}, ${id.birth_state}`,

    linkedin: id.links.linkedin,
    github: id.links.github,
    portfolio: id.links.portfolio,
    website: id.links.portfolio,

    city: a.city,
    state: a.state,
    state_full: a.state_full,
    country: lang === 'pt' ? 'Brasil' : a.country,
    cep: a.cep,
    postal_code: a.cep,
    street: a.street,
    neighborhood: a.neighborhood,
    location_line: `${a.city}, ${a.state}`,
    full_address: `${a.street}, ${a.neighborhood}, ${a.city} - ${a.state}, ${a.cep}`,

    // Never sent to a model. Filled only through a deterministic key match.
    cpf: s.cpf ?? null,
    rg: s.rg ?? null,
    rg_issuer: 'SSP/SP',

    pcd: lang === 'pt' ? kb.br_declarations.pcd_label_pt : kb.br_declarations.pcd ? 'Yes' : 'No',
    high_abilities: yesNo(f.high_abilities, 'Não'),
    racial_declaration: kb.br_declarations.racial_self_declaration_pt,
    pronouns: lang === 'pt' ? f.pronouns_pt : f.pronouns_en,
    gender: lang === 'pt' ? kb.br_declarations.gender_pt : kb.br_declarations.gender,
    gender_identity: lang === 'pt' ? kb.br_declarations.gender_identity_pt : kb.br_declarations.gender_identity_en,
    military_service: lang === 'pt' ? kb.br_declarations.military_service_pt : kb.br_declarations.military_service_en,

    current_company: lang === 'pt' ? f.current_company_pt : f.current_company_en,
    current_title: lang === 'pt' ? f.current_title_pt : f.current_title_en,
    years_of_experience: String(f.years_of_experience),
    years_clt: String(f.years_of_experience_clt),
    years_clt_text: f.years_of_experience_clt_text,
    highest_education: f.highest_education_completed,
    english_level: lang === 'pt' ? 'Fluente' : 'Fluent',
    university: kb.education[0].institution_short,
    degree: lang === 'pt' ? kb.education[0].degree_true_pt : kb.education[0].degree_true_en,
    graduation_year: String(kb.education[0].end_expected).slice(0, 4),

    salary_expectation: lang === 'pt' ? String(comp.brl.target) : String(comp.usd.target),
    // The stated band, for forms that offer ranges instead of a free number. The model
    // may only pick a band that contains `salary_expectation`; these two bound it.
    salary_range_min: lang === 'pt' && comp.brl.target ? String(comp.brl.target) : null,
    salary_range_max: lang === 'pt' && (comp.brl.max || comp.brl.target) ? String(comp.brl.max || comp.brl.target) : null,
    salary_expectation_text: lang === 'pt' ? comp.phrasing_pt : comp.phrasing_en,
    current_salary: comp.brl.current ? String(comp.brl.current) : null,

    availability: lang === 'pt' ? kb.work_eligibility.availability_pt : 'Immediate',
    // Standing decision, not a per-role one: for roles in São Paulo city/state he
    // accepts remote, hybrid and on-site (see the facts block). Non-SP roles are
    // remote-only, which the scorer handles before we ever reach a form.
    accepts_hybrid: kb.work_eligibility.accepts_hybrid ? (lang === 'pt' ? 'Sim' : 'Yes') : lang === 'pt' ? 'Não' : 'No',
    // Same standing decision as hybrid (see accepts_hybrid). The driver clears
    // both when the posting is outside São Paulo, where he only accepts remote.
    accepts_onsite: kb.work_eligibility.accepts_hybrid ? (lang === 'pt' ? 'Sim' : 'Yes') : lang === 'pt' ? 'Não' : 'No',
    easy_access: kb.work_eligibility.accepts_hybrid ? (lang === 'pt' ? 'Sim' : 'Yes') : lang === 'pt' ? 'Não' : 'No',
    relatives_in_public_office: lang === 'pt' ? 'Não' : 'No',
    // Governance / compliance screening. Every one of these is a standing fact in
    // kb.yaml (form_answers) — read from there instead of hard-coding the answer in
    // the resolver, so changing the KB changes every application.
    publicly_exposed_person: yesNo(f.publicly_exposed_person, 'Não'),
    public_agent_last_5y: yesNo(f.public_agent_last_5y, 'Não'),
    willing_to_travel: yesNo(f.willing_to_travel, 'Sim'),
    accepts_first_week_onsite: yesNo(f.accepts_first_week_onsite, 'Sim'),
    // No relatives at any target company, so the "who is it?" follow-up is blank.
    relative_details: null,
    notice_period: '0',
    willing_to_relocate: lang === 'pt' ? (kb.work_eligibility.relocation ? 'Sim' : 'Não') : (kb.work_eligibility.relocation ? 'Yes' : 'No'),
    requires_sponsorship: lang === 'pt' ? (f.requires_visa_sponsorship ? 'Sim' : 'Não') : (f.requires_visa_sponsorship ? 'Yes' : 'No'),
    authorized_to_work: lang === 'pt' ? (f.authorized_br ? 'Sim' : 'Não') : (f.authorized_br ? 'Yes' : 'No'),
    drivers_license: f.has_drivers_license == null ? null : lang === 'pt' ? 'Sim' : 'Yes',
    // Filled by the driver from the application log (store.hasAppliedToCompany) —
    // never guessed, never defaulted here.
    previously_applied_here: null,
    previously_worked_here: lang === 'pt' ? (f.previously_worked_here ? 'Sim' : 'Não') : (f.previously_worked_here ? 'Yes' : 'No'),
    relatives_at_company: lang === 'pt' ? (f.has_relatives_at_company ? 'Sim' : 'Não') : (f.has_relatives_at_company ? 'Yes' : 'No'),
    // Screening questions with a single honest answer: nobody referred him, no
    // conflict of interest, no personal ties to any employee.
    referred_by_employee: yesNo(f.referred_by_employee, 'Não'),
    conflict_of_interest: yesNo(f.conflict_of_interest, 'Não'),
    relationship_with_employee: yesNo(f.relationship_with_employee, 'Não'),
    how_did_you_hear: f.how_did_you_hear,

    yes: lang === 'pt' ? 'Sim' : 'Yes',
    no: lang === 'pt' ? 'Não' : 'No',
  };
}

/** Flat, readable fact block: everything the model may draw on, nothing else.
 * CPF/RG never appear here. */
export function factsBlock(kb: Record<string, any>, lang: 'pt' | 'en'): string {
  const L = (en: string, pt: string) => (lang === 'pt' ? pt : en);
  const lines: string[] = [];

  lines.push(`Name: ${kb.identity.full_name}`);
  lines.push(`Contact: ${kb.identity.email}, ${kb.identity.phone}. Lives in ${kb.address.city}, ${kb.address.state}, ${kb.address.country}.`);
  lines.push(`Born in ${kb.identity.birth_city}, ${kb.identity.birth_state} (naturalidade / birth place).`);
  lines.push(`Links: LinkedIn ${kb.identity.links.linkedin}, GitHub ${kb.identity.links.github}, portfolio ${kb.identity.links.portfolio}.`);
  lines.push(`Target roles: Software Engineer / Full-stack web developer (frontend, backend or both), with AI Engineer as a specialisation. Target level trainee to pleno. Does NOT want IT support, help desk or service-desk roles — score those low even when they are easy to match.`);
  lines.push(`Education: ${L(kb.education[0].degree_true_en, kb.education[0].degree_true_pt)}, ${kb.education[0].institution_short}, started ${kb.education[0].start}, IN PROGRESS, expected ${kb.education[0].end_expected}. Highest level COMPLETED: ${kb.form_answers.highest_education_completed}.`);
  lines.push(`Languages: ${kb.languages.map((x: any) => `${L(x.name_en, x.name_pt)} (${L(x.level_en, x.level_pt)})`).join(', ')}.`);
  lines.push(`Work eligibility: Brazilian citizen, no visa needed, will NOT relocate or sponsor. Work model — a standing, already-made decision: for roles located in São Paulo (the city or the state of São Paulo), the candidate ACCEPTS remote, hybrid AND on-site. For any role located anywhere else (Brazil or abroad): remote only. Availability ${L('immediate', kb.work_eligibility.availability_pt)}, no notice period.`);

  lines.push('\nExperience (dates are what any duration must be computed from):');
  for (const job of kb.experience) {
    const end = job.end || (lang === 'pt' ? 'atual' : 'present');
    lines.push(`- ${L(job.title_en, job.title_pt)}, ${L(job.company_en, job.company_pt)} (${job.start} to ${end}${job.location ? `, ${job.location}` : ''})`);
    for (const b of L(job.bullets_en, job.bullets_pt) || []) lines.push(`    * ${b}`);
  }

  lines.push('\nProjects:');
  for (const p of kb.projects) {
    lines.push(`- ${p.name || L(p.name_en, p.name_pt)}${p.url ? ` (${p.url})` : ''}`);
    for (const b of L(p.bullets_en, p.bullets_pt) || []) lines.push(`    * ${b}`);
  }

  const s = kb.skills;
  lines.push('\nDemonstrable skills (backed by the work above):');
  lines.push(`- LLM engineering: ${s.llm_engineering.join(', ')}`);
  lines.push(`- Models and APIs: ${s.models_apis.join(', ')}`);
  lines.push(`- Web: ${s.web.join(', ')} | Mobile: ${s.mobile.join(', ')}`);
  lines.push(`- Programming languages: ${s.languages_prog.join(', ')} | Data: ${(s.data || []).join(', ')}`);
  lines.push(`- Java/JVM backing (shipped): ${(s.backend_jvm || []).join(', ')}`);
  lines.push(`- Realtime and messaging: ${(s.realtime_messaging || []).join(', ')}`);
  lines.push(`- Cloud/DevOps: ${s.cloud_devops.join(', ')} | Testing: ${s.testing.join(', ')}`);
  lines.push(`- Observability: ${(s.observability || []).join(', ')}`);
  lines.push(`- Security: ${(s.security || []).join(', ')}`);
  lines.push(`- Practices: ${s.practices.join(', ')}`);
  lines.push(`\nCOURSEWORK ONLY — studied, never shipped. Must not be presented as experience: ${s.ml_foundations.items.join(', ')} (${kb.courses.issuer}). Completed the ${kb.courses.path.render_en}; the certification exam has NOT been taken.`);
  lines.push(`Holds NO professional certifications.`);
  // Numbers come from the KB, never from here: a hardcoded range silently contradicted
  // `compensation` the moment the target changed, and the model reads this line.
  const brlTarget = Number(kb.compensation.brl.target) || 0;
  const brlMax = Number(kb.compensation.brl.max) || brlTarget;
  lines.push(
    `\nCompensation expectation: ${L(kb.compensation.phrasing_en, kb.compensation.phrasing_pt)} ` +
      `For a Brazilian CLT contract the stated range is R$ ${brlTarget} to R$ ${brlMax}/month. ` +
      `When a form offers salary bands, choose the single band that contains R$ ${brlTarget}; ` +
      `if no band contains it, choose none of them rather than a neighbouring band.`,
  );
  lines.push(`Demographics for Brazilian forms: PCD (person with a disability) ${kb.br_declarations.pcd ? 'yes' : 'no'}; high abilities / giftedness (altas habilidades / superdotação) ${kb.form_answers.high_abilities ? 'yes' : 'no'}; colour/race self-declaration ${kb.br_declarations.racial_self_declaration_pt}; gender ${L(kb.br_declarations.gender, kb.br_declarations.gender_pt)}; pronouns ${L(kb.form_answers.pronouns_en, kb.form_answers.pronouns_pt)}; military service ${L(kb.br_declarations.military_service_en, kb.br_declarations.military_service_pt)}; driving licence ${kb.form_answers.has_drivers_license ? 'yes' : 'no'}.`);
  lines.push(`CLT (carteira assinada / registered-employee) experience in technology: ${kb.form_answers.years_of_experience_clt_text} (${kb.form_answers.years_of_experience_clt} years). Freelance periods are not CLT.`);
  lines.push(`Relatives at target companies: none (${kb.form_answers.has_relatives_at_company ? 'yes' : 'no'}).`);
  lines.push(`Where he found the vacancy: ${kb.form_answers.how_did_you_hear}.`);
  // Screening questions Gupy's larger employers ask by rote — prior employment
  // ("já trabalhou aqui?"), relocation ("disponibilidade pra mudança?") and kinship.
  // The KB records these; without them in the block the model can only refuse, and one
  // refusal blocks the whole application at the gate. Only keys the KB actually holds
  // are emitted — an answer invented here would be a false statement on a real form.
  const screen: string[] = [];
  const yn = (v: unknown) => (v ? 'yes' : 'no');
  if (typeof kb.form_answers.previously_worked_here === 'boolean') {
    screen.push(`previously worked at this company: ${yn(kb.form_answers.previously_worked_here)}`);
  }
  if (typeof kb.form_answers.willing_to_relocate === 'boolean') {
    screen.push(`willing to relocate: ${yn(kb.form_answers.willing_to_relocate)}`);
  }
  if (typeof kb.form_answers.has_relatives_at_company === 'boolean') {
    screen.push(`relative or family member working at the hiring company: ${yn(kb.form_answers.has_relatives_at_company)}`);
  }
  // Governance / anti-corruption screening that Brazilian employers (banks and their
  // suppliers most of all) put on nearly every application. These are standing,
  // already-decided facts about the candidate — see the block in kb.yaml.
  const screening: [string, string][] = [
    ['publicly_exposed_person', 'is a politically exposed person (PEP), holds/has held public office, or is a public-company officer or shareholder'],
    ['public_agent_last_5y', 'was a public agent / held public office in the last 5 years'],
    ['conflict_of_interest', 'has a conflict of interest, or a stake/controlling interest, with the hiring company or its suppliers'],
    ['relationship_with_employee', 'has a personal/affective relationship or kinship with an employee of the company'],
    ['referred_by_employee', 'was referred by an employee of the company'],
    ['willing_to_travel', 'is available for occasional work travel (not relocation)'],
    ['accepts_first_week_onsite', 'accepts an on-site onboarding week when the role is otherwise remote'],
  ];
  for (const [key, phrase] of screening) {
    if (typeof kb.form_answers[key] === 'boolean') screen.push(`${phrase}: ${yn(kb.form_answers[key])}`);
  }
  if (screen.length) lines.push(`Screening answers — ${screen.join('; ')}.`);
  // Benefits package: no field in the KB stores one because there is none to store —
  // the current engagement is freelance/PJ (form_answers.employment_type), which carries
  // no CLT benefits. Without this line the model refuses the very common mandatory
  // "informe seu pacote de benefícios atual ou último" question and the whole
  // application stalls on a field the candidate can truthfully answer in one sentence.
  if (kb.form_answers.employment_type === 'freelance') {
    const lastClt = (kb.experience || []).filter((j: any) => !j.current && !j.clients).pop();
    lines.push(
      `Benefits package: NONE at present — the current engagement is ${L('freelance (PJ / self-employed)', 'freelance (PJ / autônomo)')}, which carries no CLT benefits (no health plan, meal voucher, transport voucher, life insurance or pension from an employer).` +
        (lastClt
          ? ` Last CLT role was ${L(lastClt.title_en, lastClt.title_pt)} at ${L(lastClt.company_en, lastClt.company_pt)} (${lastClt.start} to ${lastClt.end}); the KB records no benefits details for it, so do not claim any specific benefit there.`
          : ''),
    );
  }
  lines.push(`Mother's full name: ${kb.identity.mother_name || 'not provided'}. Father's full name: ${kb.identity.father_name || 'not provided'}. Current (freelance) salary: ${kb.compensation.brl.current ? `R$ ${kb.compensation.brl.current}/month` : 'not provided'}.`);

  return lines.join('\n');
}

/** A short profile summary for the match-scoring prompt (cheaper than the full
 * fact block). */
export function profileSummary(kb: Record<string, any>, lang: 'pt' | 'en'): string {
  const L = (en: string, pt: string) => (lang === 'pt' ? pt : en);
  const roles = kb.experience.map((j: any) => L(j.title_en, j.title_pt)).join('; ');
  const skills = [
    ...kb.skills.llm_engineering,
    ...kb.skills.web,
    ...kb.skills.languages_prog,
    ...(kb.skills.backend_jvm || []),
    ...kb.skills.cloud_devops,
  ].join(', ');
  return [
    `Name: ${kb.identity.full_name}.`,
    `Target: Software Engineer / full-stack web developer (trainee to pleno), with AI Engineer as a specialisation. Not IT support or help desk.`,
    `Experience: ${roles}.`,
    `Education: ${L(kb.education[0].degree_true_en, kb.education[0].degree_true_pt)} (IFSP), expected Dec 2026.`,
    `Skills: ${skills}.`,
    `Eligibility: Brazilian citizen, remote-only abroad, no relocation, immediate availability.`,
    `Stack depth: TypeScript and Python; React/Next.js and Vue on the frontend; Node, FastAPI and Flask on the backend; PostgreSQL; plus Java 21 with Spring Boot, Spring Security, JPA and Flyway in shipped projects. Docker, Terraform and GitHub Actions CI on GCP Cloud Run.`,
  ].join(' ');
}

/** Vocabulary handed to the mapping prompt. */
export const KEY_DESCRIPTIONS: Record<string, string> = {
  first_name: 'given name only',
  last_name: 'family name only',
  full_name: 'complete name',
  mother_name: "the candidate's mother's full name (Virginia Maria Silva Chaves)",
  father_name: "the candidate's father's full name (Jose Camilo de Resende Chaves)",
  preferred_name: 'nickname or preferred form of address',
  email: 'email address',
  phone: 'phone number with area code',
  linkedin: 'LinkedIn profile URL',
  github: 'GitHub profile URL',
  portfolio: 'personal website / portfolio URL',
  cpf: 'Brazilian taxpayer id (CPF)',
  rg: 'Brazilian identity document number (RG)',
  rg_issuer: 'issuing body and state of the RG (SSP/SP)',
  date_of_birth: 'date of birth',
  birth_city: 'city of birth (naturalidade)',
  birth_state: 'state (UF) of birth',
  birth_place: 'city and state of birth together, e.g. "São Paulo, SP"',
  cep: 'Brazilian postal code',
  street: 'street address',
  neighborhood: 'neighbourhood / bairro',
  city: 'city of residence',
  state: 'state or province (UF)',
  country: 'country of residence',
  location_line: 'city and state together, e.g. "Cubatão, SP"',
  pcd: 'whether the candidate is a person with a disability',
  high_abilities: 'whether the candidate has high abilities / giftedness (altas habilidades / superdotação) — no',
  racial_declaration: 'racial/colour self-declaration (Brazilian forms)',
  pronouns: 'preferred pronouns',
  gender: 'gender',
  military_service: 'Brazilian military service status',
  drivers_license: 'whether the candidate holds a driving licence (CNH)',
  current_company: 'current or most recent employer',
  current_title: 'current or most recent job title',
  years_of_experience: 'total years of professional experience',
  years_clt: 'years of CLT (registered-employee) experience as a bare number',
  years_clt_text: 'years of CLT experience as a sentence, e.g. "2 anos e 3 meses"',
  highest_education: 'highest education level COMPLETED (the degree is still in progress)',
  english_level: 'English proficiency level (Fluent)',
  university: 'name of the educational institution',
  degree: 'name of the degree/course being studied',
  graduation_year: 'year of graduation (expected)',
  salary_expectation: 'expected salary as a bare number',
  salary_range_min: 'lower bound of the stated salary range, as a bare number (R$ 6.000)',
  salary_range_max: 'upper bound of the stated salary range, as a bare number (R$ 8.500)',
  salary_expectation_text: 'expected salary as a sentence, when the field takes prose',
  current_salary: 'current monthly salary as a bare number (R$ 5.000)',
  availability: 'when the candidate can start',
  accepts_hybrid: 'whether the candidate accepts a hybrid work model (yes, for roles in São Paulo)',
  accepts_onsite: 'whether the candidate accepts an on-site work model (yes, for roles in São Paulo)',
  easy_access: 'whether the candidate can easily commute to the region/office named in the question (yes, for roles in São Paulo state)',
  relatives_in_public_office: 'whether a relative holds or held a relevant public office / political position (no)',
  relative_details: "the name/relationship of a relative, only when one works at the company — there are none, so this stays blank",
  notice_period: 'notice period in days',
  willing_to_relocate: 'willingness to relocate (no)',
  requires_sponsorship: 'whether visa sponsorship would be required',
  authorized_to_work: 'authorisation to work in the country of the role',
  previously_worked_here: 'whether the candidate previously worked at this company',
  previously_applied_here: 'whether the candidate has applied to this company before (from the application log)',
  relatives_at_company: 'whether a relative/family member currently works at the company (no)',
  referred_by_employee: 'whether an employee of the company referred the candidate to this vacancy (no)',
  conflict_of_interest: 'whether the candidate has a professional conflict of interest with the company (no)',
  relationship_with_employee: 'whether the candidate has a personal/affective relationship with an employee (no)',
  how_did_you_hear: 'where the candidate found the vacancy',
  yes: "a plain affirmative in the form's language",
  no: "a plain negative in the form's language",
};

/** Which pre-written answer is this question a variant of? */
export function pickArchetype(question: string, lang: string, bank: { archetypes: Archetype[] }): { id: string; text?: string; numeric?: number | null } | null {
  const q = (question || '').toLowerCase();
  if (!q) return null;
  for (const a of bank?.archetypes || []) {
    const triggers = [...(a.match_en || []), ...(a.match_pt || [])];
    if (triggers.some((t) => q.includes(t.toLowerCase().replace(/\{\{\w+\}\}/g, '').trim()))) {
      return { id: a.id, text: a[lang as 'pt' | 'en'] || a.en, numeric: a.numeric_brl ?? a.numeric_usd ?? null };
    }
  }
  return null;
}

export function resumePath(lang: 'pt' | 'en'): string {
  const cfg = getConfig();
  const file = lang === 'pt' ? cfg.resumePt : cfg.resumeEn;
  return path.join(cfg.resumeDir, file);
}
