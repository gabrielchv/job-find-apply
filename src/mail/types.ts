// Mail types. The applicant has two inboxes and the boards do not agree on which one
// a verification code lands in, so everything here is account-aware: a result always
// says which mailbox it came from.

/** One configured mailbox. */
export interface MailAccount {
  /** Short handle used on the command line and in reports ("tech", "personal"). */
  name: string;
  address: string;
  backend: 'imap' | 'oauth';
  /** Name of the env var holding the app password (imap only). Never the password. */
  secretEnv?: string;
  /** Where the OAuth token lives (oauth only). */
  tokenFile?: string;
}

/** A message reduced to the fields this project actually uses. */
export interface MailMessage {
  /** Backend-stable id (IMAP UID or Gmail message id). */
  id: string;
  account: string;
  /** The mailbox address this was read from. */
  mailbox: string;
  from: string;
  to: string;
  subject: string;
  /** ISO 8601 timestamp. */
  date: string;
  /** First few hundred characters of the plain-text body. */
  snippet: string;
}

/** A one-time code found in a message. */
export interface CodeCandidate {
  code: string;
  /** Where it came from, so a report can say "read from the iFood mail at 21:04". */
  message: Pick<MailMessage, 'id' | 'account' | 'mailbox' | 'from' | 'subject' | 'date'>;
  /** Why this pattern matched: `alnum-8`, `digits-6`, … */
  shape: string;
  /** 0-100; higher means a more confident read. */
  confidence: number;
}

export interface MailQuery {
  /** Only messages arrived after this instant. */
  since?: Date;
  limit?: number;
  /** Restrict to one account by name; all configured accounts otherwise. */
  account?: string;
  /** Restrict to a set of accounts (used when several mailboxes may hold a code). */
  accounts?: string[];
  /** Free-text filter applied to subject/from/snippet. */
  text?: string;
}

export interface MailError {
  account: string;
  error: string;
}

export interface MailResult<T> {
  items: T[];
  errors: MailError[];
}
