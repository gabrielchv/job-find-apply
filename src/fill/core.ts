// Pure, deterministic matchers + adapter metadata (ported from jobfill/lib/matchers.js
// and jobfill/lib/adapters.js). This copy runs in Node; the page-side engine
// (browser-engine.js) carries an identical inline copy because page.evaluate
// cannot import module scope.

export const norm = (s: unknown): string =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export const clean = (s: unknown): string => String(s ?? '').replace(/\s+/g, ' ').trim();

// Ordered — first match wins, so specific goes before general. The third element
// is an EXCLUSION: a label matching it is never this key.
export const RULES: [string, RegExp, RegExp?][] = [
  // Names of OTHER people. These must never fall through to the candidate's own
  // name rules below (which would write "Gabriel Chaves" as his mother's name).
  //
  // This rule must ask for a NAME. A bare "Possui grau de parentesco ou relação
  // afetiva com algum funcionário?" is a yes/no (answered "Não" from the KB), and
  // letting this rule claim it left a REQUIRED question blank — which is exactly how
  // applications stalled on the company-questions step. The yes/no case is handled
  // by `relatives_at_company` further down.
  [
    'relative_details',
    /(parente|parentesco|familiar|refer[eê]ncia).*(nome|quem\s*(é|e)\b)|(nome|quem).*(parente|parentesco|familiar)|nome\s*e\s*grau\s*de\s*parentesco|name\s*and\s*relationship/i,
  ],
  ['mother_name', /nome\s*(completo\s*)?da\s*(sua\s*)?m[ãa]e|m[ãa]e.*\bnome\b|mother'?s?\s*(full\s*)?name|nome\s*materno/i],
  ['father_name', /nome\s*(completo\s*)?do\s*(seu\s*)?pai|\bpai\b.*\bnome\b|father'?s?\s*(full\s*)?name|nome\s*paterno/i],

  ['last_name', /sobrenome|last\s*name|surname|família/i],
  ['preferred_name', /nome\s*(social|de\s*prefer)|preferred\s*name|nickname/i],
  ['full_name', /nome\s*completo|full\s*name|seu\s*nome/i, /m[ãa]e|\bpai\b|matern(o|a)|patern(o|a)|respons[áa]vel|genitor|padrasto|madrasta|parentesco|corretor|corretora/i],
  ['first_name', /primeiro\s*nome|first\s*name|given\s*name|^nome\b|\bnome\s*\*?$/i],

  ['email', /e-?mail/i],
  ['phone', /telefone|celular|phone|mobile|whatsapp|contato\s*com\s*ddd/i],

  ['linkedin', /linked\s*-?in/i],
  ['github', /git\s*hub/i],
  ['portfolio', /portf[oó]lio|website|site\s*pessoal|personal\s*site/i],

  ['cpf', /\bcpf\b/i],
  ['rg_issuer', /[óo]rg[ãa]o\s*(emissor|expedidor)|[óo]rg[ãa]o\s*e\s*estado.*(rg|emiss[ãa]o)|emissor\s*do\s*rg|rg.*[óo]rg[ãa]o|org[ãa]o.*emissor/i],
  // `\b` is not safe with accented Portuguese: JS treats "ó" as a non-word character,
  // so "\brg\b" matched inside "órgãos" and the RG rule claimed (then rejected) the
  // anti-corruption question "já exerceu atividade em órgãos públicos?". Anchor on
  // Unicode letters instead.
  ['rg', /(?<![\p{L}])rg(?![\p{L}])|registro\s*geral|identidade/iu, /emiss[ãa]o|emissor|[óo]rg[ãa]o/i],
  ['birth_place', /nascido\s*(em|na)|naturalidade|birth\s*(city|place|town)|(cidade|estado|local|lugar|munic[ií]pio).*nascimento/i],
  ['date_of_birth', /data\s*de\s*nascimento|nascimento|birth\s*date|date\s*of\s*birth/i, /cidade|estado|local|naturalidade|city|state|place|pa[íi]s|country|nascido\s*(em|na)/i],

  ['cep', /\bcep\b|postal\s*code|\bzip\b/i],
  ['street', /endere[çc]o|logradouro|\brua\b|street\s*address|address\s*line/i],
  ['neighborhood', /\bbairro\b|neighbo(u)?rhood/i],
  ['city', /\bcidade\b|\bcity\b|\blocalidade\b|munic[íi]pio/i, /nascimento|birth|naturalidade|natal/i],
  ['state', /\bestado\b|\buf\b|\bprovince\b|^state\b/i, /nascimento|birth|naturalidade|natal/i],
  ['country', /\bpa[ií]s\b|\bcountry\b|nacionalidade/i],

  ['pcd', /pessoa\s*com\s*defici|\bpcd\b|disabilit/i],
  ['high_abilities', /altas\s*habilidades|superdota|gifted|high\s*abilit/i],
  ['racial_declaration', /autodeclara|ra[çc]a|cor\/ra[çc]a|ethnicit|racial/i],
  ['pronouns', /pronome|pronoun/i],
  ['gender', /g[êe]nero|\bsexo\b|gender/i],
  ['military_service', /servi[çc]o\s*militar|situa[çc][ãa]o\s*militar|reservista|alistamento|military\s*service/i],
  ['drivers_license', /\bcnh\b|carteira\s*de\s*habilita|driver'?s?\s*licen[sc]e/i],

  ['current_company', /empresa\s*(atual|\/|ou)|current\s*(employer|company)|última\s*empresa/i],
  ['current_title', /cargo\s*(atual|\/|ou)|current\s*(title|role|position)|último\s*cargo/i],
  ['years_clt', /experi[êe]ncia.*\bclt\b|\bclt\b.*experi[êe]ncia|tempo\s*de\s*clt|anos?\s*de\s*clt/i],
  [
    'years_of_experience',
    /anos\s*de\s*experi|years\s*of\s*experience/i,
    /experi[êe]ncia\s+(\S+\s+){0,4}?(com|em|na|no)\s+\S|experience\s+(\S+\s+){0,4}?(with|in|using)\s+\S/i,
  ],

  ['salary_expectation', /pretens[ãa]o\s*(salarial|de\s*remunera)|expectativa\s*(salarial|de\s*remunera)|salary\s*(as\s*employee|expectation)|desired\s*salary|compensation\s*expectation|sal[áa]rio\s*(desejado|pretendido)/i],
  // Brazilian ATS ask salary history in many shapes: "remuneração atual", but also
  // "última remuneração", "salário bruto atual ou último", "qual sua última
  // remuneração". Anchor on the bare stem and exclude expectation phrasings,
  // which are a DIFFERENT number (target, not current) and match earlier above.
  [
    'current_salary',
    /remunera[çc]|sal[áa]rio\s*(bruto|atual|hoje|anterior|[úu]ltimo)|current\s*(salary|compensation|remuneration)|renda\s*atual|quanto\s*voc[êe]\s*(ganha|recebia)/i,
    /pretens[ãa]o|expectativa|desejad|esperad|pretendid|a\s*partir\s*de/i,
  ],
  // "Disponibilidade para atuar no modelo híbrido" is a standing decision (he is in
  // São Paulo state and accepts hybrid/on-site there), NOT a start date. It must be
  // its own key: `availability` excludes `híbrido` on purpose so that start-date
  // fields never get answered "Sim".
  [
    'accepts_hybrid',
    /(modelo|esquema|regime|formato)\s*h[íi]brido|h[íi]brido.*(disponibilidade|aceita|disposto)|disponibilidade.*h[íi]brido|aceita\s*(o\s*)?(modelo\s*)?h[íi]brido|hybrid\s*(model|work)/i,
  ],
  // On-site availability is the SAME standing decision as hybrid (accepted for
  // São Paulo roles, declined elsewhere), but it is asked as its own required
  // question and blocked whole applications when it went unanswered.
  [
    'accepts_onsite',
    /(disponibilidade|aceita|disposto|disposta).*(presencial|on-?site)|(modelo|formato|regime|esquema)\s*(de\s*trabalho\s*)?presencial|presencial.*(disponibilidade|aceita|disposto)|on-?site\s*(work|model)/i,
  ],
  // "Você tem fácil acesso para a região X?" — a commute question, answered from
  // the posting's city under the same standing decision as above.
  [
    'easy_access',
    /f[aá]cil\s*acesso|acesso\s*(f[aá]cil|ao?\s*(local|escrit[oó]rio|regi[ãa]o|endere[çc]o|bairro))|facilidade\s*de\s*(acesso|deslocamento)|commut/i,
  ],
  // "Disponibilidade para viagens" is about occasional travel, not relocation — it
  // must be claimed before the generic availability rule below.
  ['willing_to_travel', /disponibilidade\s*(para|de)?\s*viage|viagens\s*(a\s*trabalho|frequentes|eventuais)|dispost[oa]\s*a\s*viajar|travel\s*(availability|required|occasionally)/i],
  // "Você está ciente que a primeira semana é presencial mesmo sendo remota?"
  ['accepts_first_week_onsite', /primeira\s*semana.*(presencial|on-?site)|(presencial|on-?site).*primeira\s*semana|onboarding.*(presencial|on-?site)|(presencial|on-?site).*onboarding/i],
  [
    'availability',
    /disponibilidade\s*(para|de)?\s*(in[ií]cio)?|when\s*can\s*you\s*start|start\s*date|availability/i,
    /h[íi]brido|hybrid|presencial|on-?site|viajar|travel|mudan[çc]a|relocat|hor[áa]rio|turno|jornada|manh[ãa]|tarde|noite|integral|per[ií]odo/i,
  ],
  // "Disponibilidade para viagens" is about occasional travel, not relocation —
  // it must be claimed before the relocation rule below sees "viagem/mudança".
  ['willing_to_travel', /disponibilidade\s*(para|de)?\s*viage|viagens\s*(a\s*trabalho|frequentes|eventuais)|dispost[oa]\s*a\s*viajar|travel\s*(availability|required|occasionally)/i],
  // "Você está ciente que a primeira semana é presencial mesmo sendo remota?"
  ['accepts_first_week_onsite', /primeira\s*semana.*(presencial|on-?site)|(presencial|on-?site).*primeira\s*semana|onboarding.*(presencial|on-?site)|(presencial|on-?site).*onboarding/i],
  ['notice_period', /aviso\s*pr[eé]vio|notice\s*period/i],

  ['willing_to_relocate', /mudan[çc]a|relocat/i],
  ['requires_sponsorship', /visto|sponsorship|work\s*permit|autoriza[çc][ãa]o\s*de\s*trabalho/i],
  ['authorized_to_work', /autorizado\s*a\s*trabalhar|legally\s*authorized|eligible\s*to\s*work/i],
  ['referred_by_employee', /indicou\s*voc[êe]|indica[çc][ãa]o\s*de\s*(funcion[áa]rio|colaborador)|quem\s*(te|o|voc[êe])\s*indicou|referral|referred\s*by|indicad[oa]\s*(por|para\s*esta\s*vaga)|quem\s*indicou/i],
  // Compliance questions about relatives in public office must be answered before
  // the general relatives rule below claims them (they share the wording
  // "familiar … trabalha/exerce").
  [
    'relatives_in_public_office',
    /(familiar|parente|relative).*(fun[çc][õo]es|exerc|ocupa|cargo).*(p[uú]blic|pol[ií]tic)|exerc(e|eu|er)\s*(ou\s*exerceu\s*)?fun[çc][õo]es\s*p[uú]blicas|cargo\s*p[uú]blico/i,
  ],
  [
    'conflict_of_interest',
    /conflito\s*de\s*interesse|(rela[çc][ãa]o|v[íi]nculo|contato)\s*com\s*(algum\s*)?(fornecedor|prestador)|fornecedor\s*(ou|e)\s*prestador|atividade\s*externa|s[óo]cio\s*,?\s*controlador|participa[çc][ãa]o\s*societ|rela[çc][ãa]o\s*(profissional|comercial|societ)|v[íi]nculo\s*societ/i,
  ],
  ['relatives_at_company', /(familiar|parente|parentesco|relative|family\s*member|membro\s*da\s*fam[ií]lia).*(trabalha|trabalhou|atuou|atua|presta|prestou|exerce|works?|worked|employed)|(trabalha|atua|works?).*(familiar|parente|relative)|(possu[íi]|tem|t[êe]m|h[áa])\s+(algum\s+|alguma\s+)?(grau\s+de\s+)?(parente|parentesco|familiar)|rela[çc][ãa]o\s*(afetiva|amorosa|[íi]ntima)|v[íi]nculo\s*(familiar|de\s*parentesco)|parentes?\s+(no|na|em)\s+\S/i],
  [
    'publicly_exposed_person',
    /pessoa\s*politicamente\s*exposta|\bpep\b|politically\s*exposed/i,
  ],
  [
    'public_agent_last_5y',
    /[óo]rg[ãa]os?\s*p[uú]blicos?|agente\s*p[uú]blico|cargo\s*(p[uú]blico|em\s*comiss[ãa]o)|fun[çc][ãa]o\s*p[uú]blica|servidor\s*p[uú]blico|mandato\s*eletiv|emprego\s*p[uú]blico/i,
  ],
  ['relationship_with_employee', /relacionamento\s*afetivo|amizade\s*[íi]ntima|rela[çc][ãa]o\s*(afetiva|íntima|amorosa)/i],
  // Exclusion matters here: "Com quais dos ambientes e recursos abaixo você já
  // trabalhou" is a multi-select inventory question, and answering it "Não" was a
  // wrong answer actually written to the page. Only a yes/no about prior employment
  // at THIS company is that key.
  [
    'previously_worked_here',
    /j[aá]\s*(trabalhou|foi\s*(nosso|nossa)?\s*(colaborador|funcion[áa]rio|empregado)|fez\s*parte|atuou)|trabalha\s*(atualmente\s*)?(na|nesta)\s*(empresa|organiza[çc][ãa]o)|ex-?\s*colaborador|ex-?\s*funcion[áa]rio|ex-?\s*empregado|previously\s*worked|former\s*employee|voc[êe]\s*[ée]\s*(colaborador|funcion[áa]rio|empregado)|(nosso|nossa)\s*(colaborador|funcion[áa]rio|empregado)/i,
    /\bquais\b|com\s+quais|ambientes|recursos|tecnologias|ferramentas|conhecimentos|quais\s*dos/i,
  ],
  // "Você já participou de outro processo seletivo aqui?" — answered from the
  // application log (see store.hasAppliedToCompany), not guessed.
  ['previously_applied_here', /(outro|algum)\s*processo\s*seletivo|j[aá]\s*(se\s*)?candidat|j[aá]\s*aplicou|participou\s*(de|do)\s*(outro|algum)\s*processo|previous(ly)?\s*applied/i],
  ['how_did_you_hear', /como\s*(voc[êe]\s*)?(soube|descobriu|conheceu)|onde\s*voc[êe]\s*descobriu|how\s*did\s*you\s*hear|source/i],

  ['university', /institui[çc][ãa]o|universidade|faculdade|\bschool\b|universit|\bcollege\b/i],
  ['english_level', /n[ií]vel\s*(de\s*)?ingl[êe]s|ingl[êe]s\s*[—:\-]?\s*n[ií]vel|english\s*(level|proficiency)|profici[êe]ncia\s*em\s*ingl[êe]s/i],
  ['degree', /forma[çc][ãa]o|\bcurso\b|\bdegree\b|\bmajor\b|qualification/i],
  ['graduation_year', /ano\s*de\s*conclus|graduation\s*(year|date)/i],
  ['highest_education', /escolaridade|n[ií]vel\s*de\s*ensino|highest\s*(level\s*of\s*)?education/i],
];

export function match(label: string): { key: string; label: string } | null {
  const text = clean(label);
  if (!text) return null;
  for (const [key, pattern, exclusion] of RULES) {
    if (!pattern.test(text)) continue;
    // An exclusion means "this rule is not the right one for this label" — skip it and
    // keep looking. Returning null here aborted the whole scan, so "Você tem
    // disponibilidade pra mudança?" matched `availability` (excluded by the word
    // mudança) and then fell out of the table entirely instead of reaching
    // `willing_to_relocate` two rules below: a required question left blank.
    if (exclusion && exclusion.test(text)) continue;
    return { key, label: text };
  }
  return null;
}

export function scoreOption(optionText: string, wanted: string): number {
  const label = norm(optionText);
  const want = norm(wanted);
  if (!label || !want) return 0;
  if (label === want) return 3;
  if (label.startsWith(want) || want.startsWith(label)) return 2;
  if (label.includes(want) || want.includes(label)) return 1;
  let i = 0;
  while (i < label.length && i < want.length && label[i] === want[i]) i++;
  if (i >= 4 && i / Math.min(label.length, want.length) >= 0.7) return 1;
  return 0;
}

export function bestOption(options: string[], wanted: string): { index: number; text: string; score: number } | null {
  let best: { index: number; text: string; score: number } | null = null;
  options.forEach((text, index) => {
    const score = scoreOption(text, wanted);
    if (score && (!best || score > best.score)) best = { index, text, score };
  });
  return best;
}

export interface Adapter {
  id: string;
  direct: Record<string, string>;
  multiStep: boolean;
  isOpaqueId: (uid: string) => boolean;
}

const GENERIC: Adapter = {
  id: 'generic',
  direct: {},
  multiStep: false,
  isOpaqueId: () => false,
};

export const ADAPTERS: Record<string, Adapter> = {
  greenhouse: {
    ...GENERIC,
    id: 'greenhouse',
    direct: {
      first_name: 'first_name',
      last_name: 'last_name',
      preferred_name: 'preferred_name',
      email: 'email',
      phone: 'phone',
      'candidate-location': 'location_line',
      country: 'country',
    },
    isOpaqueId: (uid) => /^question_\d+/.test(uid || ''),
  },
  gupy: {
    ...GENERIC,
    id: 'gupy',
    direct: { cpf: 'cpf', email: 'email', name: 'full_name' },
    multiStep: true,
  },
  inhire: { ...GENERIC, id: 'inhire', multiStep: true },
  lever: { ...GENERIC, id: 'lever' },
  ashby: { ...GENERIC, id: 'ashby' },
  generic: GENERIC,
};

export const adapterFor = (id: string): Adapter => ADAPTERS[id] || GENERIC;

// Decisions, not facts. The model is told to refuse these; filtering before the
// call is the cheaper half of the same rule.
//
// Split into two buckets: a *required* consent (LGPD data processing, terms,
// background-check authorisation, "tenho ciência e aceito") blocks submission
// when left blank, so the bot must ACCEPT it to proceed; an *optional* marketing
// consent (newsletter, promo e-mails) is genuinely the candidate's choice and is
// left blank on purpose.
export const MARKETING_CONSENT =
  /newsletter|marketing|promo[çc]|ofertas|receber\s*(e-?mails|comunica|novidades|promo|contato|vagas)|mala\s*direta|envio\s*de\s*(comunica|promo)/i;

export const REQUIRED_CONSENT =
  /consent|consinto|autoriz|concordo|aceito|termos|privacidade|privacy|terms|lgpd|gdpr|compartilhamento\s*de\s*dados|tratamento\s*(de|dos)\s*dados|data\s*shar|ci[êe]ncia\s*e\s*(aceito|de\s*acordo)|declaro\s*estar\s*ciente|verifica[çc][õo]es|dilig[êe]ncia/i;

// Assertions about the truthfulness of answers the bot itself wrote.
//
// Two shapes on Brazilian ATS, and they are one class:
//   "Confirmo que as informações estão corretas"           Gupy's data-confirmation step
//   "Declaro que as informações fornecidas são verídicas
//    e responsabilizo-me por elas"                         company questionnaire, last step
//
// Both state that the answers already on the page are accurate. Every answer this bot
// writes is grounded in the KB or the posting and read back off the page (the submit
// gate refuses anything else), so accepting is the truthful click — and leaving it
// unset is what disabled "Salvar e continuar" on the final step, stalling the
// application. This is NOT the same as the consents that stay blank: marketing opt-ins
// remain untouched, and data-sharing / background-check authorisations are handled
// through REQUIRED_CONSENT because submitting at all requires them.
export const CONFIRM_DATA_CONSENT =
  /confirm(o|ar|ando)?\s*(que\s*)?(as\s*)?informa|verificar\s*se\s*(est[ãa]o|est[aá])\s*atualiz|dados\s*(est[ãa]o|est[aá])\s*(corret|atualiz)|revis(e|ar)\s*(seus|os)\s*dados|informa[çc][õo]es\s+(fornecidas|prestadas|informadas)\s+(s[ãa]o\s+)?(ver[íi]dicas|verdadeiras|corretas|exatas)|(declaro|afirmo)\s+que\s+(as\s+)?informa[çc][õo]es.*(ver[íi]dic|verdadeir|corret)|responsabilizo-me\s+por\s+(elas|estas|essas|tais)/i;

export const isChoiceLike = (kind: string): boolean => kind === 'boolean' || kind === 'choice' || kind === 'choice-aria';

// Keys whose correct answer is "leave it empty". A follow-up question that only
// applies when another answer is YES ("qual o nome e grau de parentesco?" after
// "possui parentes na empresa?" = Não) must be left blank on purpose — deferring it
// to the model is what made it write the candidate's own name.
export const DELIBERATELY_BLANK = new Set(['relative_details']);
