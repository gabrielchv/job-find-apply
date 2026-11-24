// Answer \"você possui experiência profissional com X?\" style questions.
//
// Brazilian boards ask these one per technology, as required yes/no radios. The model
// refused them (\"Angular is not mentioned anywhere in the facts\") and a single refusal
// disabled \"Salvar e continuar\", blocking the whole application. The answer is not
// judgement — it is a membership test against the skills and work history already in
// the KB, so it is decided here deterministically.
//
// Truth rules: \"Sim\" only when the technology is demonstrably in the KB; \"Não\" only
// when the question names a real technology that is absent. Anything ambiguous returns
// null and stays with the model.

const KNOWN_TECH = [
  'Java', 'JavaScript', 'TypeScript', 'Python', 'Kotlin', 'PHP', 'C#', '.NET', 'Go', 'Rust',
  'Ruby', 'React', 'React Native', 'Next.js', 'Angular', 'Vue', 'Svelte', 'SvelteKit',
  'Node.js', 'Node', 'Express', 'NestJS', 'Spring', 'Spring Boot', 'Django', 'Flask',
  'FastAPI', 'Laravel', 'AWS', 'Azure', 'GCP', 'Google Cloud', 'Docker', 'Kubernetes',
  'Terraform', 'Kafka', 'RabbitMQ', 'Redis', 'PostgreSQL', 'MySQL', 'MongoDB', 'Oracle',
  'SQL Server', 'DynamoDB', 'Elasticsearch', 'GraphQL', 'REST', 'gRPC', 'HTML', 'CSS',
  'Tailwind', 'SASS', 'Scrum', 'Kanban', 'Git', 'Linux', 'PyTorch', 'TensorFlow', 'Spark',
  'Airflow', 'Databricks', 'Snowflake', 'LLM', 'RAG', 'LangChain', 'Playwright', 'Vitest',
  'Jest', 'Cypress', 'Selenium', 'Figma', 'Storybook', 'Expo', 'Prisma', 'Drizzle',
];

export type Answer = 'yes' | 'no' | null;

function norm(s: string): string {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/** Everything the KB says about skills and work, as one searchable string. */
export function skillHaystack(kb: Record<string, unknown>): string {
  return norm(
    JSON.stringify({
      skills: kb.skills,
      experience: kb.experience,
      projects: kb.projects,
      courses: kb.courses,
    }),
  );
}

/** The technology a yes/no question names, if it names one we recognise. */
export function namedTechnology(label: string): string | null {
  const text = norm(label);
  // \"experiência (profissional) com X\", \"conhecimento em X\", \"já trabalhou com X\"
  const m = text.match(
    /(?:experiencia|conhecimento|conhece|trabalh\w*|atu\w*|desenvolv\w*|hands-?on|experience|worked)\s*(?:profissional\s*)?(?:com|em|using|with|in)\s+([a-z0-9.#+/-]{2,20}(?:[ .][a-z0-9.#+/-]{2,20})?)/,
  );
  if (!m) return null;
  const candidate = m[1].trim().replace(/[.,;:?]+$/, '');
  return KNOWN_TECH.find((t) => norm(t) === candidate) ?? null;
}

/** Does the KB show this technology? Word-boundary match on the normalised haystack. */
export function hasTechnology(kb: Record<string, unknown>, tech: string): boolean {
  const hay = skillHaystack(kb);
  const needle = norm(tech);
  if (!needle) return false;
  // \"Go\" and \"R\".free — guard the short ones that appear inside other words.
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9+#.])${escaped}([^a-z0-9+#.]|$)`, 'i').test(hay);
}

/**
 * The answer to a technology-experience yes/no, or null when the question is not one.
 * `options` must look like a Sim/Não pair; anything else is not ours to answer.
 */
export function technologyExperienceAnswer(
  label: string,
  options: string[],
  kb: Record<string, unknown>,
): Answer {
  const opts = (options || []).map((o) => norm(o).trim());
  const isYesNo = opts.some((o) => o === 'sim' || o === 'yes') && opts.some((o) => o === 'nao' || o === 'no');
  if (!isYesNo) return null;
  const tech = namedTechnology(label);
  if (!tech) return null;
  return hasTechnology(kb, tech) ? 'yes' : 'no';
}
