// Tiny JSON Schema validator (ported from jobfill/lib/schema.js).
// DeepSeek guarantees valid JSON via response_format, not the right shape; the
// schema travels twice — once as prompt documentation, once as a real check here.

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number' && Number.isInteger(v)) return 'integer';
  return typeof v;
}

function typeMatches(actual: string, expected: string): boolean {
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  if (expected === 'integer') return actual === 'integer';
  return actual === expected;
}

interface SchemaNode {
  type?: string | string[];
  properties?: Record<string, SchemaNode>;
  required?: string[];
  items?: SchemaNode;
  enum?: unknown[];
  [k: string]: unknown;
}

export function validate(value: unknown, schema: SchemaNode, path = 'root'): string[] {
  const errors: string[] = [];
  if (!schema || typeof schema !== 'object') return errors;

  if (schema.type) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = typeOf(value);
    if (!allowed.some((t) => typeMatches(actual, t))) {
      errors.push(`${path}: expected ${allowed.join(' or ')}, got ${actual}`);
      return errors;
    }
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  }

  if (typeOf(value) === 'object' && schema.properties) {
    for (const key of schema.required || []) {
      if (!(key in (value as Record<string, unknown>))) errors.push(`${path}.${key}: required property is missing`);
    }
    for (const [key, sub] of Object.entries(schema.properties)) {
      if (key in (value as Record<string, unknown>)) {
        errors.push(...validate((value as Record<string, unknown>)[key], sub, `${path}.${key}`));
      }
    }
  }

  if (typeOf(value) === 'array' && schema.items) {
    (value as unknown[]).forEach((item, i) => errors.push(...validate(item, schema.items!, `${path}[${i}]`)));
  }

  return errors;
}

export function describe(schema: SchemaNode): string {
  return `Return a single JSON object matching this JSON Schema exactly. No markdown, no code fences, no commentary.

${JSON.stringify(schema, null, 2)}`;
}
