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
// stay a single attempt — a repeat after a lost answer would act twice.

/** Block the synchronous caller without burning CPU. */
export const sleepSync = (ms) => {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

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
