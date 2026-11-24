// Shared types. The contract every module imports.

export interface JobPosting {
  id: string; // stable unique id per source
  title: string;
  company: string;
  location: string; // human-readable: "Cubatão, SP" | "Brasil" | "Remote"
  city?: string;
  state?: string;
  remote: boolean; // best-effort
  workplace_type: string | null; // on-site | remote | hybrid | null
  description: string;
  apply_url: string;
  source: 'gupy' | 'greenhouse' | 'lever' | 'ashby' | 'scrape';
  posted_at: string | null; // ISO
  deadline: string | null;
  seniority_hint: string | null;
}

export type FieldKind =
  | 'text'
  | 'textarea'
  | 'select'
  | 'choice'
  | 'boolean'
  | 'choice-aria'
  | 'combobox'
  | 'file';

// Plain-JSON field descriptor returned by the in-page scan. No DOM references
// cross the page boundary; `index` is the position in the page-side registry
// used to re-locate the element when filling.
export interface FieldDescriptor {
  index: number;
  uid: string;
  kind: FieldKind;
  label: string;
  options: string[];
  required: boolean;
  name: string;
  inputType?: string;
  maxLength?: number | null;
}

export interface FillResult {
  ok: boolean;
  verified: boolean;
  chosen?: string;
  exact?: boolean;
  note?: string;
}

export type RowStatus = 'filled' | 'review' | 'failed' | 'blank' | 'skipped';

export interface FillRow {
  index: number;
  uid: string;
  label: string;
  kind: FieldKind;
  required: boolean;
  status: RowStatus;
  key?: string | null;
  value?: string | null;
  detail?: string;
  source?: 'adapter' | 'label' | 'model' | null;
  consent?: boolean;
  /** True when the control already held the right value on load (Gupy pre-sets the
   * phone country dial code to the candidate's country). Satisfied, not unfilled. */
  preset?: boolean;
}

export interface ScanResult {
  adapterId: string;
  fields: FieldDescriptor[];
  stats: { seen: number; hidden: number; unlabeled: number; shadowRoots: number; disabled: number };
}

export interface MatchResult {
  score: number;
  rationale: string;
  stack: string[];
}

export type JobStatus =
  | 'discovered'
  | 'shortlisted'
  | 'applying'
  | 'submitted'
  | 'failed'
  | 'needs_manual'
  | 'skipped';

export interface JobRecord {
  id: string;
  source: string;
  title: string;
  company: string;
  location: string;
  apply_url: string;
  posted_at: string | null;
  description: string;
  status: JobStatus;
  score: number | null;
  rationale: string | null;
  first_seen: string;
  last_updated: string;
}

// Flat key -> value map the deterministic matcher and the LLM both speak in.
export type ResolvedValues = Record<string, string | null>;

// Captured posting facts (subset of the job that tailoring needs).
export interface Posting {
  company: string;
  role_title: string;
  seniority: string | null;
  location: string | null;
  language: 'pt' | 'en' | 'es' | null;
  stack: string[];
  must_haves: string[];
  nice_to_haves: string[];
  product_summary: string | null;
  hiring_context: string | null;
}
