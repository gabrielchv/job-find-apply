// Post-model checks (ported from jobfill/lib/validate.js).
// checkSources: a mapping's citations must actually appear in the fact block.
// check: generated prose must not introduce technologies/credentials/figures
// that appear nowhere in the KB or the posting.

const CLAIMABLE = [
  'PyTorch', 'Keras', 'Scikit-Learn', 'scikit-learn', 'Hugging Face', 'HuggingFace',
  'Kubernetes', 'Kafka', 'Spark', 'Airflow', 'Terraform', 'AWS', 'Azure', 'Databricks',
  'Snowflake', 'MongoDB', 'Redis', 'GraphQL', 'Angular', 'Vue', 'Django',
  'Rails', 'Java', 'C#', 'Go', 'Rust', 'Kotlin', 'Swift', 'PHP', 'Laravel', '.NET',
  'LangChain', 'LlamaIndex', 'Pinecone', 'Weaviate', 'Milvus', 'vLLM', 'Ollama',
  'fine-tuning', 'fine-tuned', 'LoRA', 'QLoRA', 'RLHF',
  'PhD', 'Master', 'Mestrado', 'Doutorado', 'certified', 'certification', 'certificado',
  'AWS Certified',
];

function norm(s: string): string {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// Word-level support. Long words are compared on a 6-character stem so that
// "company" matches "companies" and "structured" matches "structu" — the model
// cites what it read, and a paraphrase of the same fact is still that fact.
export function supported(snippet: string, factsNorm: string): boolean {
  const s = norm(snippet);
  if (s.length < 4) return false;
  if (factsNorm.includes(s)) return true;
  const words = s.split(' ').filter((w) => w.length > 3);
  if (words.length < 2) return false;
  const hits = words.filter((w) => {
    const stem = w.slice(0, 6);
    return factsNorm.includes(w) || factsNorm.includes(stem);
  }).length;
  return hits / words.length >= 0.8;
}

// A citation may name a KB field it used ("relatives_at_company") as legitimately as
// it may quote a fact — the key is how the filler itself speaks. Such names are
// accepted when they are keys we handed the model.
//
// The model habitually cites a key with its reading attached —
// "willing_to_relocate: whether the candidate is willing to relocate (no)". Only the
// key half is a field name, so compare on the part before the first separator;
// otherwise a correct refusal-free answer is thrown away as "cited something not in
// the KB" and the required field blocks an otherwise complete application.
export function checkSources(sources: string[] | undefined, facts: string, knownKeys: string[] = []): string[] {
  const factsNorm = norm(facts);
  const keys = new Set(knownKeys.map((k) => norm(k.replace(/_/g, ' '))));
  const keyOf = (s: string): string => {
    const head = s.split(/[:=—–]|\s-\s/)[0].replace(/[.,;()\[\]]/g, ' ');
    // Underscores are part of the key spelling (`willing_to_relocate`), while the
    // accepted-keys set stores keys with spaces — normalise both the same way or
    // every snake_case citation is rejected as unsupported.
    return norm(head).replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  };
  return (sources || []).filter((s) => {
    const n = norm(s);
    if (keys.has(n) || keys.has(n.replace(/_/g, ' '))) return false;
    if (keys.has(keyOf(s))) return false;
    return !supported(s, factsNorm);
  });
}

function haystack(kb: unknown, posting: unknown, base: string | undefined): string {
  return [JSON.stringify(kb), JSON.stringify(posting || {}), base || ''].join(' ').toLowerCase();
}

export interface Flag {
  term: string;
  why: string;
}

export function check(output: string, { kb, posting, base }: { kb: unknown; posting: unknown; base?: string }): Flag[] {
  const hay = haystack(kb, posting, base);
  const out = (output || '').toLowerCase();
  const flags: Flag[] = [];

  for (const term of CLAIMABLE) {
    const t = term.toLowerCase();
    if (out.includes(t) && !hay.includes(t)) {
      flags.push({ term, why: 'appears in the answer but nowhere in your knowledge base or the posting' });
    }
  }

  const known = new Set(hay.match(/\b\d+(?:[.,]\d+)?\b/g) || []);
  for (const m of out.matchAll(/(\d+(?:[.,]\d+)?)\s*(%|percent|anos|years|meses|months|x\b)/g)) {
    if (!known.has(m[1])) flags.push({ term: m[0].trim(), why: 'a figure that does not appear in your knowledge base' });
  }

  const seen = new Set<string>();
  return flags.filter((f) => (seen.has(f.term) ? false : seen.add(f.term)));
}
