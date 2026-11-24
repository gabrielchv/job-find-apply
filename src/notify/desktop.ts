// Desktop notifications via notify-send. Best-effort: always logs, so a missing
// notify-send (headless box) degrades to a console line rather than a crash.
import { execFile } from 'node:child_process';
import { getConfig } from '../config.js';

export function notify(title: string, body: string): void {
  console.log(`\n[NOTIFY] ${title}: ${body}\n`);
  const cmd = getConfig().notify.command;
  if (!cmd) return;
  execFile(cmd, ['-a', 'job_find_apply', title, body], (err) => {
    if (err) console.warn(`notify-send failed (expected on a headless box): ${err.message}`);
  });
}
