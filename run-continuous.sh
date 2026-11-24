#!/bin/bash
# Continuous self-healing apply loop.
#
# Every ~30s it re-runs the resume pass, which fills every unfinished Gupy
# application (failed / needs_manual / applying) and dumps the page on any
# failure. Each pass reloads the latest code, so a fix landed between passes
# takes effect on the next one — that is what lets the loop self-heal.
#
# Once an hour it also runs one discover + score + apply cycle to pick up NEW
# job postings.
#
# Only failed logins are kept in state/logs/login.log; successful ones are never
# written. Page dumps land in state/dumps/<job_id>/.

set -u
cd "$(dirname "$0")"

unlock() {
  rm -f .browser-profile/SingletonLock .browser-profile/SingletonCookie .browser-profile/SingletonSocket 2>/dev/null
}

last_discovery=0
while true; do
  ts="$(date -Iseconds)"

  unlock
  echo "=== [$ts] resume pass (fill unfinished) ==="
  npx tsx src/cli/resume.ts 2>&1 | tee -a state/resume.log

  now="$(date +%s)"
  if [ $((now - last_discovery)) -ge 3600 ]; then
    unlock
    echo "=== [$ts] discover + apply new jobs ==="
    npx tsx src/cli/index.ts run 2>&1 | tee -a state/daemon.log
    last_discovery="$now"
  fi

  sleep 30
done
