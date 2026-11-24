# job_find_apply

Autonomous job search and application agent for Gupy, Greenhouse, Lever and Ashby.
It discovers postings, scores them against your KB, fills the forms from
`Documents/jobsearch/kb`, and submits behind a safety gate.

Most of the work is already done. This file tells you what is left, which is short.

## What the bot did (last full run: 2026-11-10)

- **All 85 in-progress Gupy applications walked.** **0 unfinished drafts left** — every
  one is either already with the company or a support/help-desk draft you ruled out
  (37 of those, left alone on purpose).
- **4 applications already sent**, now waiting on a **company test** — the clock starts
  when you click, so those are yours to take. Listed below.
- **2 board applications filled but not sent** (iFood, Stone): they end on an e-mailed
  one-time code. Once the inboxes below are readable, `npm run resume:all` finishes them
  with no input from you.

`npm run next` is the summary that matters: it merges the Gupy state, the stuck board
applications and your inbox into one prioritised list, and writes
`docs/NEXT-STEPS.md`.

## What you need to do

### 0. Log in to Gupy once, if asked

The bot reuses a saved browser session in `.browser-profile`. That session expired
while this run was being done, and LinkedIn now answers the automatic login with a
security check, so the next `npm run finish` will stop with:

```
Gupy login failed: LinkedIn login blocked by a security check — log in manually
```

Fix it once:

```bash
npm run login
```

A browser window opens. Sign in with Google or LinkedIn, then close the window. The
session persists, so you do this once, not per run.

### 1. Take the four company tests

These are the only things no automation can do for you: each is timed, measures you,
and cannot be paused. Open the link, go to the step, click **Começar**, finish, submit.

- **B4A — Engenheiro(a) de IA Agentic** · step 2 · Teste B4A · 17 min
  https://b4a.gupy.io/candidates/applications/769916098
- **Lefosse — AI Engineer** · step 2 · Teste de Inglês
  https://lefosse.gupy.io/candidates/applications/773896869
- **Cresol — Desenvolvedor Sênior Frontend** · step 2 · Fit Cultural
  https://cresolcarreiras.gupy.io/candidates/applications/773903430
- **Stefanini — Engenheiro de Prompt** · step 3 · Mapeamento Comportamental
  https://stefanini.gupy.io/candidates/applications/756832958

Answer from work you actually did. Leave out anything you cannot defend in an
interview.

### 2. Give the bot your two inboxes (one-time, ~5 minutes)

This is what lets it finish the iFood and Stone applications on its own: both stop on an
8-character code the board e-mails you, and with mail access the bot reads the code,
types it, and submits.

Two accounts are configured, because the boards do not agree on where the code lands:

- `gabriel.chaves.tech@gmail.com` — the address on every application (`tech`)
- `gabriel.chaves.3720@gmail.com` — your other Gmail (`personal`)

Pick one of the two setups. **App passwords are simpler and need no Google Cloud.**

**Option A — app passwords (recommended).** Open **`config/mail.env`** — it has the two
slots and the three clicks that produce a password. For each account: Google Account →
Security → 2-Step Verification → App passwords → create one for "Mail", then paste it
straight in:

```
MAIL_TECH_APP_PASSWORD=abcd efgh ijkl mnop
MAIL_PERSONAL_APP_PASSWORD=abcd efgh ijkl mnop
```

Paste it exactly as Google shows it, spaces and all — the reader strips the spaces.
No quotes needed. Then confirm both are readable:

```bash
npm run mail -- check
```

**Option B — OAuth (Gmail API).** Create a project in Google Cloud, enable the Gmail
API, create an OAuth client of type "Desktop app", save its JSON to
`config/gmail-oauth-client.json`, set that account's `backend: oauth` in
`config/settings.yaml`, then run the consent once per account:

```bash
npm run mail -- auth tech
npm run mail -- auth personal
```

Both options request **read-only** access. Nothing here sends, labels, archives or
deletes anything. Credentials live in `config/mail.env` (app passwords) and `state/mail/`
(OAuth tokens), both git-ignored. `config/mail.env` is read automatically after
`config/.env`, and a real environment variable still overrides both.

### If Google says app passwords are unavailable for an account

> *A configuração que você está procurando não está disponível para sua conta.*

That account cannot issue app passwords. Either 2-Step Verification is off — turn it on
at https://myaccount.google.com/security and retry — or the account is enrolled in
**Advanced Protection**, which forbids app passwords permanently. In that case:

**(a) Forward only verification mail to a readable inbox.** In the blocked account:
Settings → Forwarding and POP/IMAP → add the readable address and confirm it, then
filter `from:(greenhouse-mail.io OR gupy.io)` → *Forward to*. Nothing else to configure:
when the addressed mailbox is unusable, the code lookup polls whichever mailboxes *are*
readable, and the code is found in the forwarded copy.

**(b) Use OAuth for that account** (Option B above). Works, but while the OAuth app is
unverified/"Testing", Google expires the refresh token after **7 days**, so you would
re-run `npm run mail -- auth <account>` weekly.

Until either is in place, `npm run resume:hold` still finishes a Greenhouse application
by hand: it opens the filled form and waits for you to paste the code.

### 3. Finish the two board applications

With mail working, this needs no input from you:

```bash
npm run resume:all
```

The bot fills the form, waits for the code, reads it from the right inbox, types it,
and reports what it actually observed. No code arriving is reported as such; an inbox it
cannot read is reported separately, because those are different problems.

If you would rather do it by hand, `npm run resume:hold` opens the filled form in a
browser window and waits for you to paste the code.

- iFood — Programa de Estágio GenAI · https://job-boards.greenhouse.io/ifoodcarreiras/jobs/8901054002
- Stone — Software Engineer Pleno · https://job-boards.greenhouse.io/stone/jobs/8045173003

### 4. Nothing else

The 37 support/help-desk drafts are intentionally untouched. To clear them off your
Gupy dashboard, open each and click **Desistir**; to finish them instead:
`npm run finish -- --include-off-target`.

## Commands

```bash
npm run next          # ONE summary, in priority order, across Gupy + boards + inbox
                      # (also written to docs/NEXT-STEPS.md)
npm run mail -- check         # are both inboxes readable? says exactly what is missing
npm run mail -- inbox         # job mail, most actionable first (tests, interviews, offers)
npm run mail -- codes         # one-time codes seen in the last 30 min
npm run mail -- search "entrevista" [--days 30]
npm run mail -- auth <account>  # one-time OAuth consent (only for backend: oauth)

npm run finish        # walk every Gupy application, finish what can be finished,
                      # rewrite docs/gupy-manual-todo.md with whatever is left for you
npm run inventory     # same walk, read-only: reports state, changes nothing
npm run resume        # retry stuck applications (Gupy by default)
npm run resume:all    # retry stuck applications on every board (reads mail for codes)
npm run resume:hold   # same, but park on an e-mailed-code gate so you can paste it
npm run status        # stored counts and today's model spend
npm run run           # one discover → score → apply cycle for NEW postings
npm run daemon        # keep doing that forever
npm run test          # test suite (84 tests)
```

`npm run next` is the one to remember: it answers "what do I do now" instead of making
you read three reports.

Useful flags: `--headless` (no window), `--dry-run` (fill, never submit),
`--limit N`, `--only <id>`, `--verbose` (print every field).

## Setup

- `config/.env` holds the model key and the LinkedIn login. It is git-ignored.
- `config/settings.yaml` holds the search terms, match threshold, pacing, the two mail
  accounts (`mail.accounts`) and the `apply.submit` switch (set it to `false` to fill
  without ever submitting).
- Provider: Gemini's prepaid balance is depleted (every call returns 402), so the
  project is pinned to **DeepSeek** via `JFA_PROVIDER=deepseek`. If a provider fails
  on credit or a bad key, the client swaps to the other one automatically.
- `apply.dry_run: true` in `settings.yaml` is the hard stop — nothing is ever sent.

## Safety rules the tool enforces

- **Never starts a company test.** A timed assessment measures you, so the bot
  reports the step and stops. (This used to be a real bug: it clicked the first
  "Começar" on the page, which is the test's own button.)
- **Never submits a form with an unanswered required field**, an unanswered consent
  box, or prose that isn't grounded in the posting. Those come to you as a manual
  list instead.
- **Never invents facts.** Every answer is traceable to `jobsearch/kb` or the posting
  itself; a field with no grounded answer is left blank and reported.
- **Never touches support/help-desk roles** — your KB rules them out.
- **Never guesses a verification code.** A code has to be read from a real message that
  looks like verification mail, match the length the mail itself declares, and survive a
  confidence floor. Phone numbers, CPFs, salaries, dates and URLs are scrubbed first, and
  a wrong code is reported rather than retried into a lockout.
- **Never reads mail for anything but job context.** Both backends open the mailbox
  read-only (IMAP `EXAMINE`, Gmail `gmail.readonly`), and message text is treated as
  data — links are not followed and instructions in email are not executed.
