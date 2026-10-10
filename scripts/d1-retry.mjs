// A wrangler call against D1 that may be repeated without harm — an SQL file that converges, an export, a
// read — tried up to three times before the run is given up.
//
// `wrangler d1 execute --file` goes through D1's import route, and its status polling sometimes reports
// „Not currently importing anything" for an import that has already finished. On 26.09.2026 that ended the
// weekly declarations run in its third minute, while it applied a schema file every run re-applies; the
// same message failed a deploy on 30.09. D1 also has short faults of its own. For a call that converges a
// repeat is the safe answer to both, and the error of the last attempt is still the one the run reports.
//
// Only for repeatable calls: a `--command` that alters a table, or any write that is not idempotent, must
// stay a single attempt — a repeat after a lost answer would act twice. A FILE that is not idempotent has
// `sendWithReceipt` instead: the file proves on the target whether it landed, and only then is it repeated.
import { randomUUID } from 'node:crypto';

/** Block the synchronous caller without burning CPU. */
export const sleepSync = (ms) => {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** A file to D1 as sent: its SQL, then its receipt — the last statement of the same transaction, so the
 *  receipt exists exactly when everything before it ran. */
export function withReceipt(sql, label, token) {
  const literal = (s) => `'${String(s).replaceAll("'", "''")}'`;
  return (
    `${sql.replace(/\s*$/, '\n')}` +
    'CREATE TABLE IF NOT EXISTS rp_receipt (label TEXT PRIMARY KEY, token TEXT NOT NULL);\n' +
    `INSERT OR REPLACE INTO rp_receipt VALUES(${literal(label)}, ${literal(token)});\n`
  );
}

/**
 * Send a file that is NOT repeatable — rows inserted, tables renamed — and still survive a false error.
 *
 * The status polling of `wrangler d1 execute --file` reports „Not currently importing anything" for imports
 * that have finished (above). Repeating a repeatable file is harmless; repeating this kind is not: on Stage
 * on 04.10.2026 the publication swap had landed, was sent again, and the second one died on „no such table:
 * rp_next_persons" — a published generation recorded as a failed run, its search index never rebuilt.
 *
 * So each file carries a receipt with a token of this sending (`withReceipt`), and after an error the
 * receipt is read FIRST: holding the token, the file landed and nothing is sent again; without it, nothing
 * landed and the file is sent again, up to `attempts` times. A receipt that cannot be read is no answer:
 * the run stops rather than guess, because a guess either way can be wrong twice.
 *
 * @param {string} sql the file's statements
 * @param {(body: string) => void} send executes the file as given
 * @param {{ label: string, readReceipt: (label: string) => string | null, attempts?: number,
 *           waitMs?: (n: number) => number, sleep?: (ms: number) => void, log?: (line: string) => void,
 *           token?: string }} options `readReceipt` answers the token the target holds for the label, null
 *           when it holds none, and throws when it cannot tell
 */
export function sendWithReceipt(
  sql,
  send,
  {
    label,
    readReceipt,
    attempts = 3,
    waitMs = (n) => 30_000 * n,
    sleep,
    log,
    token = randomUUID(),
  },
) {
  const pause = sleep ?? sleepSync;
  const say = log ?? ((line) => console.error(line));
  const body = withReceipt(sql, label, token);
  for (let attempt = 1; ; attempt++) {
    try {
      send(body);
      return;
    } catch (error) {
      // The wait comes before the read, so an import that is still landing has landed when it is asked.
      pause(waitMs(attempt));
      let landed;
      for (let read = 1; landed === undefined; read++) {
        try {
          landed = readReceipt(label) === token;
        } catch (readError) {
          if (read >= attempts)
            throw new Error(
              `cannot tell whether ${label} was applied: its receipt could not be read ` +
                `(${String(readError?.message ?? readError).slice(0, 300)}); the send failed with ` +
                `${String(error?.message ?? error).slice(0, 300)}`,
            );
          pause(waitMs(read));
        }
      }
      const event = {
        label,
        attempt,
        of: attempts,
        error: String(error?.message ?? error).slice(0, 300),
      };
      if (landed) {
        say(JSON.stringify({ event: 'd1_file_landed_despite_error', ...event }));
        return;
      }
      if (attempt >= attempts) throw error;
      say(JSON.stringify({ event: 'd1_call_retried', receipt: 'absent', ...event }));
    }
  }
}

/**
 * Run `call` up to `attempts` times, waiting `waitMs(n)` after the n-th failure.
 * @template T
 * @param {() => T} call a synchronous, repeatable wrangler call
 * @param {{ label: string, attempts?: number, waitMs?: (n: number) => number,
 *           sleep?: (ms: number) => void, log?: (line: string) => void }} options
 * @returns {T}
 */
export function retryD1(
  call,
  { label, attempts = 3, waitMs = (n) => 15_000 * n, sleep, log } = {},
) {
  const pause = sleep ?? sleepSync;
  const say = log ?? ((line) => console.error(line));
  for (let attempt = 1; ; attempt++) {
    try {
      return call();
    } catch (error) {
      if (attempt >= attempts) throw error;
      const wait = waitMs(attempt);
      say(
        JSON.stringify({
          event: 'd1_call_retried',
          label,
          attempt,
          of: attempts,
          waitMs: wait,
          error: String(error?.message ?? error).slice(0, 300),
        }),
      );
      pause(wait);
    }
  }
}
