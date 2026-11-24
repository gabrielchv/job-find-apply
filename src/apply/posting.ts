// Build the Posting context the composer and the quality judge both read.
//
// The description was previously dropped entirely: `postingFrom` filled in company,
// role and location and left product_summary/must_haves/stack empty. The composer
// then had nothing concrete to tie an answer to, so it wrote career narrative, and
// the judge — reading the same empty fields — refused that narrative as "the posting
// names no product, stack, or requirements". Applications were deferred on a posting
// the tool knew perfectly well. Everything here is copied from the posting text; none
// of it is a claim about the candidate.

const STACK_TOKENS = [
  'Java', 'Kotlin', 'Python', 'Node.js', 'Node', 'TypeScript', 'JavaScript', 'React', 'Next.js',
  'Angular', 'Vue', 'Svelte', 'SvelteKit', 'React Native', 'Spring', 'Spring Boot', 'NestJS',
  'Express', 'Django', 'Flask', 'FastAPI', 'PHP', 'Laravel', '.NET', 'C#', 'Go', 'Rust', 'Ruby',
  'Rails', 'AWS', 'Azure', 'GCP', 'Google Cloud', 'Docker', 'Kubernetes', 'Terraform', 'Kafka',
  'RabbitMQ', 'Redis', 'PostgreSQL', 'MySQL', 'MongoDB', 'Oracle', 'SQL Server', 'DynamoDB',
  'Elasticsearch', 'GraphQL', 'REST', 'gRPC', 'HTML', 'CSS', 'Tailwind', 'SASS', 'Scrum',
  'Kanban', 'CI/CD', 'Jenkins', 'GitHub Actions', 'GitLab', 'Git', 'Linux', 'Microsserviços',
  'Microservices', 'EDA', 'LLM', 'RAG', 'LangChain', 'OpenAI', 'Gemini', 'Bedrock', 'PyTorch',
  'TensorFlow', 'Spark', 'Databricks', 'Airflow', 'Snowflake', 'dbt',
];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Tech names the POSTING itself mentions. Never used to claim the candidate has them. */
export function extractStack(text: string): string[] {
  const found: string[] = [];
  for (const token of STACK_TOKENS) {
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(token)}([^\\p{L}\\p{N}]|$)`, 'iu');
    if (re.test(text) && !found.some((f) => f.toLowerCase() === token.toLowerCase())) found.push(token);
  }
  return found.slice(0, 14);
}

/** Sentences stating what the role asks for, quoted verbatim from the posting. */
export function extractRequirements(text: string): string[] {
  const sentences = text
    .split(/(?<=[.!?;])\s+|\s*[•\u2022\-–—]\s+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 25 && s.length < 400);
  const wanted =
    /experi[êe]ncia|conhecimento|requisit|necess[áa]rio|desej[áa]vel|imprescind|respons[áa]vel|atribui[çc]|you\s*(will|have|bring)|requirements|responsibilities|proficien|familiarity|dom[íi]nio|ingl[êe]s|degree|forma[çc][ãa]o/i;
  return sentences.filter((s) => wanted.test(s)).slice(0, 10);
}
