// A small stdout protocol shared by the job's child processes and its Container supervisor.
let lastStage,
  lastAt = 0;
export function progress(stage, completed = 0, total, force = false) {
  if (!process.env.SIGMA_RUN_ID) return;
  const now = Date.now();
  if (!force && stage === lastStage && now - lastAt < 5000) return;
  lastStage = stage;
  lastAt = now;
  console.log(JSON.stringify({ event: 'declarations_progress', stage, completed, total }));
}

// The exit code the job leaves with when a child stage stops. 75 is a yield: the supervisor retries it at
// once and never counts it against the stage. A stage exits 75 itself when it stops on purpose; a stage
// killed by the stop signal the container sends its whole process group (SIGTERM, or SIGINT by hand) is the
// same stop — the platform ending the container, not the stage failing — and yields too. Anything else,
// a SIGKILL from running out of memory among them, is a failure.
export const STOP_SIGNALS = ['SIGTERM', 'SIGINT'];
export function stageExitCode(error) {
  return error?.status === 75 || STOP_SIGNALS.includes(error?.signal) ? 75 : 1;
}
