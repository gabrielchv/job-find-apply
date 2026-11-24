// Model client (ported from jobfill/lib/llm.js, Node-shaped).
// OpenAI chat-completions dialect — DeepSeek, OpenAI, Groq etc. all speak it.
import { validate, describe } from './schema.js';

export interface LlmEndpoint {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface LlmOptions extends LlmEndpoint {
  pricing: { input: number; output: number };
  onSpend?: (usd: number) => void;
  /**
   * The other provider, used once when the primary rejects the key or has no
   * credit. Gemini's prepaid balance runs dry silently (402 for every call), and
   * without this the whole bot stops on a provider that merely happens to be the
   * one whose key is present.
   */
  fallback?: LlmEndpoint;
}

export interface LlmRecord {
  task: string;
  model: string;
  promptChars: number;
  attempts: number;
  ok: boolean;
  ms?: number;
  costUsd?: number;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  error?: string;
}

export interface CallArgs {
  task: string;
  system: string;
  input: string;
  schema?: object;
  temperature?: number;
  maxTokens?: number;
}

function explain(status: number, detail: string): string {
  const d = String(detail || '').slice(0, 200);
  if (status === 401) return `API key rejected (401). Check GEMINI_API_KEY. ${d}`;
  if (status === 402) return `Account has no balance (402). Top up the provider account. ${d}`;
  if (status === 403) return `Key lacks permission for this model (403). ${d}`;
  if (status === 404) return `Model or endpoint not found (404) — check the model id and base URL. ${d}`;
  if (status === 422 || status === 400) return `Provider rejected the request (${status}). ${d}`;
  if (status === 429) return `Rate limited or out of quota (429). ${d}`;
  if (status >= 500) return `Provider is failing (${status}). ${d}`;
  return `HTTP ${status}. ${d}`;
}

const backoff = (attempt: number) => new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));

// Tolerant JSON extraction: strip code fences, then take the first balanced
// object. Gemini occasionally wraps or prefixes JSON even with a json_object
// response_format, and a truncated reply must not crash the caller.
function extractJson(text: string): unknown {
  let s = String(text || '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  try {
    return JSON.parse(s);
  } catch {
    /* fall through to balanced-brace scan */
  }
  const start = s.indexOf('{');
  if (start < 0) throw new Error('Model returned no JSON at all');
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return JSON.parse(s.slice(start, i + 1));
  }
  throw new Error('Model returned no JSON at all');
}

export class LlmClient {
  constructor(private opts: LlmOptions) {}

  cost(usage: LlmRecord['usage']): number {
    if (!usage) return 0;
    return ((usage.prompt_tokens || 0) * this.opts.pricing.input + (usage.completion_tokens || 0) * this.opts.pricing.output) / 1e6;
  }

  /** The endpoint currently answering calls (primary until a credit/auth failure). */
  private active: LlmEndpoint | null = null;

  private endpoint(): LlmEndpoint {
    this.active ??= { apiKey: this.opts.apiKey, baseUrl: this.opts.baseUrl, model: this.opts.model };
    return this.active;
  }

  /** Returns the parsed JSON when `schema` is set, otherwise the raw text. */
  async call(args: CallArgs): Promise<unknown> {
    try {
      return await this.invoke(this.endpoint(), args);
    } catch (e) {
      const msg = String((e as Error).message || '');
      const unusable = /^(API key rejected \(401\)|Account has no balance \(402\)|Key lacks permission for this model \(403\))/.test(msg.trim());
      const fb = this.opts.fallback;
      if (!unusable || !fb || fb.apiKey === this.endpoint().apiKey) throw e;
      // Swap for the remaining providers and retry the call once. Recorded on the
      // client so later calls go straight to the working provider.
      console.warn(`[llm] ${this.endpoint().model} unusable (${msg.slice(0, 60)}…) — switching to ${fb.model}`);
      this.active = fb;
      return await this.invoke(fb, args);
    }
  }

  private async invoke(ep: LlmEndpoint, args: CallArgs): Promise<unknown> {
    const { task, system, input, schema, temperature = 0, maxTokens = 2000 } = args;
    if (!ep.apiKey) throw new Error('No API key set — add GEMINI_API_KEY (or DEEPSEEK_API_KEY) to config/.env.');

    const systemFull = schema ? `${system}\n\n${describe(schema as never)}` : system;
    const started = Date.now();
    const record: LlmRecord = { task, model: ep.model, promptChars: systemFull.length + input.length, attempts: 0, ok: false };

    let repairNote = '';
    let lastSchemaErrors: string[] = [];

    try {
      for (let repair = 0; repair <= 1; repair++) {
        const messages = [
          { role: 'system', content: systemFull },
          { role: 'user', content: repair ? `${input}\n\n${repairNote}` : input },
        ];
        const body: Record<string, unknown> = {
          model: ep.model,
          messages,
          temperature,
          max_tokens: maxTokens,
          stream: false,
        };
        // Gemini's default "thinking" mode spends the output-token budget and can
        // truncate structured replies. Disable it on the Gemini endpoint.
        if (ep.baseUrl.includes('generativelanguage.googleapis.com')) {
          body.reasoning_effort = 'none';
        }
        if (schema) body.response_format = { type: 'json_object' };

        const text = await this.post(ep, body, record);
        if (!schema) {
          record.ok = true;
          return text;
        }

        let parsed: unknown;
        try {
          parsed = extractJson(text);
        } catch (e) {
          lastSchemaErrors = [String((e as Error).message || e)];
          repairNote = 'Your previous reply was not valid JSON. Return the corrected JSON object only, matching the schema exactly.';
          continue;
        }

        const errors = validate(parsed, schema as never);
        if (!errors.length) {
          record.ok = true;
          return parsed;
        }

        lastSchemaErrors = errors;
        repairNote =
          `Your previous reply did not match the required schema:\n` +
          errors.slice(0, 10).map((e) => `- ${e}`).join('\n') +
          `\nReturn the corrected JSON object only.`;
      }
      throw new Error(`Model output did not match the schema after a repair attempt: ${lastSchemaErrors.slice(0, 3).join('; ')}`);
    } catch (e) {
      record.error = String((e as Error).message || e);
      throw e;
    } finally {
      record.ms = Date.now() - started;
      record.costUsd = this.cost(record.usage);
      if (record.costUsd) this.opts.onSpend?.(record.costUsd);
    }
  }

  private async post(ep: LlmEndpoint, body: Record<string, unknown>, record: LlmRecord): Promise<string> {
    const MAX_TRANSPORT_RETRIES = 2;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_TRANSPORT_RETRIES; attempt++) {
      record.attempts++;
      let res: Response;
      try {
        res = await fetch(`${ep.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ep.apiKey}` },
          body: JSON.stringify(body),
        });
      } catch (e) {
        lastError = new Error(`Could not reach ${ep.baseUrl} — ${(e as Error).message}`);
        await backoff(attempt);
        continue;
      }

      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(explain(res.status, await res.text().catch(() => '')));
        await backoff(attempt);
        continue;
      }
      if (!res.ok) throw new Error(explain(res.status, await res.text().catch(() => '')));

      const json = (await res.json()) as { usage?: LlmRecord['usage']; choices?: { message?: { content?: string } }[] };
      record.usage = json.usage || null;
      const text = json?.choices?.[0]?.message?.content;
      if (!text) throw new Error('Provider returned a response with no message content');
      return text;
    }
    throw lastError || new Error('model call failed');
  }
}
