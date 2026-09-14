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
