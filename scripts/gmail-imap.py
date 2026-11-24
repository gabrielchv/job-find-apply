#!/usr/bin/env python3
"""Read recent mail from Gmail over IMAP, for the job_find_apply project.

Why a Python bridge: the Node side needs message bodies (for one-time codes) and
Python's stdlib already has IMAP and MIME parsing. This keeps the project free of an
extra npm dependency and of any credential handling beyond one env var.

Protocol: a JSON request on stdin, a JSON response on stdout. The password travels in
that stdin payload — never as a command-line argument — so it cannot be read out of
the process list or a shell history.

  request  {"user": "...", "password": "...", "since_minutes": 15, "limit": 25}
  response {"messages": [...], "errors": [...]}

Read-only by construction: the mailbox is opened EXAMINE, so nothing on the server
can be marked seen, moved or deleted by this script.

Mail content is untrusted input. It is returned as data and never interpreted here.
"""
import email
import email.header
import email.utils
import imaplib
import json
import re
import ssl
import sys
import time
from datetime import datetime, timedelta, timezone

IMAP_HOST = "imap.gmail.com"
IMAP_PORT = 993
# Gmail's IMAP search needs a date, not a time; one extra day of margin keeps the
# server-side filter harmless while the exact cut-off is applied locally below.
SEARCH_MARGIN_DAYS = 1
MAX_BODY_CHARS = 4000
# First slice of each body, in octets. Enough for the opening paragraphs, which is
# all a code or a subject line lives in.
BODY_SLICE = 24000
# Wall-clock ceiling for the body phase; the loop returns what it has when reached.
BODY_TIME_BUDGET = 35.0
# UIDs per IMAP command. Larger batches mean fewer round trips, which is the whole cost.
BATCH_SIZE = 60
BODY_BATCH = 12
# How many recent headers to inspect when locating messages inside the time window.
HEADER_WINDOW = 400


def decode_header_value(raw):
    if not raw:
        return ""
    try:
        parts = email.header.decode_header(raw)
    except Exception:
        return str(raw)
    out = []
    for chunk, charset in parts:
        if isinstance(chunk, bytes):
            for enc in (charset, "utf-8", "latin-1"):
                if not enc:
                    continue
                try:
                    out.append(chunk.decode(enc, "replace"))
                    break
                except (LookupError, UnicodeDecodeError):
                    continue
            else:
                out.append(chunk.decode("utf-8", "replace"))
        else:
            out.append(chunk)
    return re.sub(r"\s+", " ", "".join(out)).strip()


def html_to_text(html):
    """Flatten HTML to readable text. Style/script bodies are dropped, not shown."""
    html = re.sub(r"(?is)<(script|style|head).*?</\1>", " ", html)
    html = re.sub(r"(?s)<[^>]+>", " ", html)
    return re.sub(r"\s+", " ", html).strip()


def body_text(msg):
    """Plain-text body, preferring text/plain and never executing or unpacking files."""
    if msg.is_multipart():
        # Prefer a text/plain part anywhere in the tree.
        for part in msg.walk():
            ctype = part.get_content_type()
            disp = str(part.get("Content-Disposition") or "")
            if ctype == "text/plain" and "attachment" not in disp:
                payload = part.get_payload(decode=True) or b""
                return payload.decode(part.get_content_charset() or "utf-8", "replace")
        for part in msg.walk():
            ctype = part.get_content_type()
            disp = str(part.get("Content-Disposition") or "")
            if ctype == "text/html" and "attachment" not in disp:
                payload = part.get_payload(decode=True) or b""
                return html_to_text(payload.decode(part.get_content_charset() or "utf-8", "replace"))
        return ""
    payload = msg.get_payload(decode=True) or b""
    text = payload.decode(msg.get_content_charset() or "utf-8", "replace")
    # A single-part HTML mail is common for board notifications; returning it verbatim
    # would hand the code extractor a page of markup instead of a message.
    if msg.get_content_type() == "text/html":
        return html_to_text(text)
    return text


def iso(when):
    if when is None:
        return ""
    return when.astimezone(timezone.utc).isoformat()


def main():
    try:
        req = json.load(sys.stdin)
    except Exception as exc:
        print(json.dumps({"messages": [], "errors": ["bad request: %s" % exc]}))
        return 0

    user = req.get("user") or ""
    password = req.get("password") or ""
    since_minutes = int(req.get("since_minutes") or 60)
    limit = int(req.get("limit") or 25)

    if not user or not password:
        print(json.dumps({"messages": [], "errors": ["missing user or password"]}))
        return 0

    cutoff = datetime.now(timezone.utc) - timedelta(minutes=since_minutes)
    search_since = (cutoff - timedelta(days=SEARCH_MARGIN_DAYS)).strftime("%d-%b-%Y")

    messages = []
    errors = []
    conn = None
    try:
        conn = imaplib.IMAP4_SSL(IMAP_HOST, IMAP_PORT, ssl_context=ssl.create_default_context())
        conn.login(user, password)
        # EXAMINE: read-only. Nothing can be flagged as read by this script.
        conn.select("INBOX", readonly=True)
        typ, data = conn.search(None, "(SINCE %s)" % search_since)
        if typ != "OK":
            errors.append("IMAP search failed: %s" % (data,))
            data = [b""]

        uids = []
        for chunk in data:
            if chunk:
                uids.extend(chunk.split())
        # Newest first; UIDs ascend with arrival order.
        uids = list(reversed(uids))

        # Two-phase fetch.
        #
        # Phase 1 pulls only the headers of a bounded window and applies the exact
        # cut-off locally. Phase 2 downloads the full message for the few that are
        # actually wanted.
        #
        # Doing it in one pass (fetch RFC822 for max(limit*8, 40) messages, then discard
        # the old ones) meant 160 whole messages -- bodies and attachments -- travelled
        # for a request that needed 20. On a busy inbox that exceeded the 60s budget and
        # the whole mailbox reported "reader timed out", which read like broken
        # credentials. Headers for 200 messages cost a fraction of one body.
        # Batched header read.
        #
        # One FETCH per message costs one round trip each (~0.8s to Gmail from here), so a
        # 100-message request spent over a minute just on headers. IMAP accepts a
        # comma-separated UID set, so a batch of BATCH_SIZE headers arrives in a single
        # round trip. This is the change that makes a large request finish at all.
        window = uids[:HEADER_WINDOW]
        wanted = []
        dates = {}
        for start in range(0, len(window), BATCH_SIZE):
            if len(wanted) >= limit:
                break
            batch = window[start:start + BATCH_SIZE]
            uid_set = b",".join(batch)
            try:
                typ, fetched = conn.fetch(uid_set, "(BODY.PEEK[HEADER.FIELDS (DATE)])")
                if typ != "OK" or not fetched:
                    continue
                for item in fetched:
                    if not (isinstance(item, tuple) and len(item) > 1):
                        continue
                    # The response name carries the UID: b'1 (BODY[HEADER.FIELDS ...] {...}'
                    m = re.match(rb"(\d+)", item[0] if isinstance(item[0], bytes) else str(item[0]).encode())
                    if not m:
                        continue
                    hdr = email.message_from_bytes(item[1])
                    received = email.utils.parsedate_to_datetime(hdr.get("Date")) if hdr.get("Date") else None
                    if received is None:
                        continue
                    if received.tzinfo is None:
                        received = received.replace(tzinfo=timezone.utc)
                    dates[m.group(1)] = received
            except Exception as exc:
                errors.append("headers %s: %s" % (start, exc))

        # Walk newest-first so the cut-off can stop the scan early.
        for uid in window:
            if len(wanted) >= limit:
                break
            received = dates.get(uid if isinstance(uid, bytes) else uid.encode())
            if received is None:
                continue
            if received < cutoff:
                break
            wanted.append((uid, received))

        # Phase 3: bodies, bounded.
        #
        # Only the first BODY_SLICE octets of each body are fetched, because only
        # MAX_BODY_CHARS characters are ever kept. A full RFC822 download of a newsletter
        # is tens of kilobytes and took about a second per message here, so a 100-message
        # request could not finish inside the caller's 60s budget and the whole mailbox
        # reported "reader timed out" -- indistinguishable from broken credentials.
        #
        # BODY_TIME_BUDGET stops the loop early and returns what it has. A partial page of
        # real messages is far more useful than an error, and the caller treats a short
        # list as a short list.
        deadline = time.monotonic() + BODY_TIME_BUDGET
        truncated = False
        by_uid = {u if isinstance(u, bytes) else u.encode(): d for u, d in wanted}
        for start in range(0, len(wanted), BODY_BATCH):
            if time.monotonic() > deadline:
                truncated = True
                break
            batch = [u for u, _ in wanted[start:start + BODY_BATCH]]
            parts = {}
            try:
                # ONE section per message on purpose.
                #
                # Asking for HEADER and TEXT in the same command returns two tuples per
                # message, and the second tuple's response name is just b" BODY[HEADER]"
                # with no sequence number — the number appears only on the first. Every
                # message then attached to no uid and the whole request returned nothing.
                # BODY[]<0.N> returns headers + the first N octets as a single tuple whose
                # name does start with the sequence number, and that is all this needs.
                typ, fetched = conn.fetch(b",".join(batch), "(BODY.PEEK[]<0.%d>)" % BODY_SLICE)
                if typ != "OK" or not fetched:
                    continue
                for item in fetched:
                    if not (isinstance(item, tuple) and len(item) > 1):
                        continue
                    name = item[0] if isinstance(item[0], bytes) else str(item[0]).encode()
                    m = re.match(rb"(\d+)", name)
                    if not m:
                        continue
                    parts[m.group(1)] = item[1]
            except Exception as exc:
                errors.append("bodies %s: %s" % (start, exc))
                continue

            for uid, received in wanted[start:start + BODY_BATCH]:
                key = uid if isinstance(uid, bytes) else uid.encode()
                raw = parts.get(key)
                if not raw:
                    continue
                try:
                    msg = email.message_from_bytes(raw)
                    messages.append(
                        {
                            "id": uid.decode() if isinstance(uid, bytes) else str(uid),
                            "from": decode_header_value(msg.get("From")),
                            "to": decode_header_value(msg.get("To")),
                            "subject": decode_header_value(msg.get("Subject")),
                            "date": iso(received),
                            "snippet": re.sub(r"\s+", " ", body_text(msg)).strip()[:MAX_BODY_CHARS],
                        }
                    )
                except Exception as exc:  # one bad message must not lose the rest
                    errors.append("parse %s: %s" % (uid, exc))
    except imaplib.IMAP4.error as exc:
        errors.append("IMAP auth/select failed: %s" % exc)
    except Exception as exc:
        errors.append("%s: %s" % (type(exc).__name__, exc))
    finally:
        try:
            if conn is not None:
                conn.logout()
        except Exception:
            pass

    if truncated:
        errors.append("stopped early after %d message(s) to stay inside the time budget" % len(messages))
    print(json.dumps({"messages": messages, "errors": errors}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
