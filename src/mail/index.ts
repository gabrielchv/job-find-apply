// One mail client over both inboxes and both backends.
//
// Every method answers with what it found AND what failed, so a dead app password on
// one account never looks like "no code arrived" on the other — the distinction decides
// whether the run should wait, retry, or ask the applicant.
import { accountForAddress, isConfigured, isUsable, mailSettings, readImap } from './accounts.js';
import { readGmail } from './gmail.js';
import { bestCode, extractCodes } from './codes.js';
import { classify, isJobMail, type Classified } from './classify.js';
import type { CodeCandidate, MailAccount, MailError, MailMessage, MailQuery, MailResult } from './types.js';

export { mailSettings, isConfigured, isUsable, accountForAddress } from './accounts.js';
export { extractCodes, bestCode, declaredLength, looksLikeVerification } from './codes.js';
export { classify, isJobMail, KIND_LABEL } from './classify.js';
export type { MailKind, Classified } from './classify.js';
export type { CodeCandidate, MailAccount, MailError, MailMessage, MailResult } from './types.js';

export class Mailer {
  private readonly mailboxes: MailAccount[];

  constructor(accounts: MailAccount[] = mailSettings().accounts) {
    this.mailboxes = accounts;
  }

  /** The mailboxes this client will read. */
  get accounts(): MailAccount[] {
    return this.mailboxes;
  }

  get configured(): boolean {
    return this.mailboxes.length > 0;
  }

  /** Read one account with whichever backend it configures. */
  private async readAccount(account: MailAccount, sinceMinutes: number, limit: number): Promise<MailResult<MailMessage>> {
    return account.backend === 'oauth'
      ? readGmail(account, { sinceMinutes, limit })
      : readImap(account, { sinceMinutes, limit });
  }

  /**
   * Recent messages across every account, newest first.
   *
   * Both inboxes are read concurrently: they are independent, and a slow mailbox should
   * not delay the one that actually has the code.
   */
  async recent(query: MailQuery = {}): Promise<MailResult<MailMessage>> {
    const since = query.since ?? new Date(Date.now() - 60 * 60_000);
    const sinceMinutes = Math.max(1, Math.ceil((Date.now() - since.getTime()) / 60_000));
    const targets = query.account
      ? this.mailboxes.filter((a) => a.name === query.account)
      : query.accounts
        ? this.mailboxes.filter((a) => query.accounts!.includes(a.name))
        : this.mailboxes;
    if (!targets.length) {
      return { items: [], errors: [{ account: query.account || '*', error: 'no mail account configured' }] };
    }

    const results = await Promise.all(targets.map((a) => this.readAccount(a, sinceMinutes, query.limit ?? 25)));
    const errors: MailError[] = results.flatMap((r) => r.errors);
    let items = results.flatMap((r) => r.items);

    if (query.text) {
      const needle = query.text.toLowerCase();
      items = items.filter((m) =>
        `${m.from} ${m.to} ${m.subject} ${m.snippet}`.toLowerCase().includes(needle),
      );
    }
    items.sort((a, b) => (a.date < b.date ? 1 : -1));
    return { items: items.slice(0, query.limit ?? 25), errors };
  }

  /**
   * Wait for a one-time code addressed to `to` that arrived after `since`.
   *
   * Only the account whose address matches the recipient is polled — a code mailed to
   * the tech inbox has no reason to make us read the personal one, and narrowing here
   * keeps the wait short. When the recipient is not a configured account, every
   * configured inbox is polled instead of giving up.
   */
  async waitForCode(opts: {
    to: string;
    since: Date;
    timeoutMs?: number;
    pollMs?: number;
    onPoll?: (attempt: number, found: number) => void;
  }): Promise<{ code: CodeCandidate | null; errors: MailError[]; polls: number }> {
    const settings = mailSettings();
    const timeoutMs = opts.timeoutMs ?? settings.code.waitSeconds * 1000;
    const pollMs = opts.pollMs ?? settings.code.pollSeconds * 1000;
    const deadline = Date.now() + timeoutMs;
    const errors: MailError[] = [];
    let polls = 0;

    // Which mailboxes to read.
    //
    // The obvious answer is "the one the code was addressed to", but that inbox can be
    // unreachable while another is readable — a Google account with app passwords
    // unavailable, or a forward that delivers the code elsewhere. Polling only the
    // addressed account reports "no code" for a code that is sitting in a readable
    // inbox, so an unusable account hands the whole set of readable ones to the search.
    // Resolve against THIS client's accounts, not the global config: a Mailer built with
    // an explicit list must honour that list, and the two are only coincidentally the
    // same in production.
    const want = (opts.to || '').trim().toLowerCase();
    const addressed = want ? (this.mailboxes.find((a) => a.address.toLowerCase() === want) ?? null) : null;
    const readable = this.mailboxes.filter(isUsable);
    const targets = addressed && isUsable(addressed) ? [addressed] : readable;

    if (!targets.length) {
      const why = this.mailboxes.length
        ? this.mailboxes.map((a) => `${a.name}: credential unusable`).join('; ')
        : 'no mail account configured';
      return { code: null, errors: [{ account: opts.to || '*', error: why }], polls };
    }

    while (Date.now() < deadline) {
      polls++;
      const { items, errors: errs } = await this.recent({
        since: opts.since,
        limit: 20,
        accounts: targets.map((a) => a.name),
      });
      for (const e of errs) if (!errors.some((x) => x.error === e.error)) errors.push(e);
      const code = bestCode(items, { since: opts.since });
      if (code) return { code, errors, polls };
      opts.onPoll?.(polls, items.length);
      if (Date.now() + pollMs >= deadline) break;
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return { code: null, errors, polls };
  }

  /** Recent job-related mail, classified, with the actionable items first. */
  async triage(opts: { days?: number; account?: string; limit?: number } = {}): Promise<
    MailResult<MailMessage & Classified>
  > {
    const settings = mailSettings();
    const days = opts.days ?? settings.triage.lookbackDays;
    const { items, errors } = await this.recent({
      since: new Date(Date.now() - days * 24 * 3600_000),
      limit: opts.limit ?? 100,
      account: opts.account,
    });
    const scored = items
      .filter((m) => isJobMail(m, settings.triage.senders))
      .map((m) => ({ ...m, ...classify(m) }))
      .sort((a, b) => b.urgency - a.urgency || (a.date < b.date ? 1 : -1));
    return { items: scored, errors };
  }
}
