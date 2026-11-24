#!/bin/bash
# Autonomous supervisor for a bounded run.
#
# Every cycle, in order:
#   1. read the inboxes (job mail + any one-time code)
#   2. walk every Gupy application and finish the drafts
#   3. discover → score → apply to new postings across all boards
#   4. regenerate the merged next-steps report
#
# Sequential by design: one browser profile means two jobs must never overlap.
#
# Usage: ./scripts/supervise.sh [hours]     (default 2)
#
# Logs go to state/supervisor-<stamp>.log so a run can be inspected afterwards without
# watching it. Each stage is guarded so one failure cannot kill the loop.

set -u
cd "$(dirname "$0")/.."

HOURS="${1:-2}"
END=$(( $(date +%s) + HOURS * 3600 ))
STAMP=$(date +%Y%m%d-%H%M%S)
LOG="state/supervisor-${STAMP}.log"
mkdir -p state

echo "=== supervisor start $(date -Iseconds) — running ${HOURS}h, log ${LOG}" >> "$LOG"

unlock() {
  rm -f .browser-profile/SingletonLock .browser-profile/SingletonCookie .browser-profile/SingletonSocket 2>/dev/null
}

cycle=0
while [ "$(date +%s)" -lt "$END" ]; do
  cycle=$((cycle + 1))
  echo "" >> "$LOG"
  echo "########## cycle ${cycle} — $(date -Iseconds) ##########" >> "$LOG"

  # 1. Mail. A failure here is expected while the app passwords are missing; it is
  #    logged and stepped over rather than allowed to stop the cycle.
  echo "--- mail" >> "$LOG"
  timeout 300 npx tsx src/cli/mail.ts codes --minutes 90 >> "$LOG" 2>&1 || echo "(mail stage failed)" >> "$LOG"

  # 2. Gupy drafts. This is the stage that turns a half-finished wizard into a
  #    submitted application, so it runs before new discovery.
  unlock
  echo "--- finish (gupy drafts)" >> "$LOG"
  timeout 1800 npx tsx src/cli/finish.ts >> "$LOG" 2>&1 || echo "(finish stage failed)" >> "$LOG"

  # 3. New postings across every board, with real submissions.
  unlock
  echo "--- run (discover + score + apply)" >> "$LOG"
  timeout 2400 npx tsx src/cli/index.ts run --headless >> "$LOG" 2>&1 || echo "(run stage failed)" >> "$LOG"

  # 4. Report, so the file on disk is never stale by more than one cycle.
  echo "--- next (report)" >> "$LOG"
  timeout 300 npx tsx src/cli/next.ts >> "$LOG" 2>&1 || echo "(next stage failed)" >> "$LOG"

  # Budget and clock are the only things that end this early.
  LEFT=$(( END - $(date +%s) ))
  if [ "$LEFT" -le 0 ]; then break; fi

  # Pause between cycles: long enough not to hammer the boards, short enough to get
  # several cycles inside the window. Capped so the last cycle still fits.
  PAUSE=900
  if [ "$LEFT" -lt "$PAUSE" ]; then PAUSE=$LEFT; fi
  echo "--- sleeping ${PAUSE}s" >> "$LOG"
  sleep "$PAUSE"
done

echo "" >> "$LOG"
echo "=== supervisor done $(date -Iseconds) after ${cycle} cycle(s)" >> "$LOG"
