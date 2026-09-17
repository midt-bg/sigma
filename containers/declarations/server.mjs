import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, statfsSync } from 'node:fs';
import { createInterface } from 'node:readline';

/** Memory and free disk in MiB. An out-of-memory restart leaves no other trace in the logs. */
export function resources(meminfo = readFileSync('/proc/meminfo', 'utf8'), dir = '.') {
  const mib = (key) =>
    Math.floor(Number(meminfo.match(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm'))?.[1]) / 1024);
  const disk = statfsSync(dir);
  return {
    memoryTotalMb: mib('MemTotal'),
    memoryAvailableMb: mib('MemAvailable'),
    diskFreeMb: Math.floor((disk.bavail * disk.bsize) / 1048576),
  };
}

export function supervise(
  child,
  runId,
  attempt,
  outputs = [process.stdout, process.stderr],
  stage = 'fetch',
) {
  const status = {
    runId,
    attempt,
    state: 'running',
    stage,
    completed: 0,
    reason: null,
  };
  for (const [stream, output] of [
    [child.stdout, outputs[0]],
    [child.stderr, outputs[1]],
  ]) {
    createInterface({ input: stream }).on('line', (line) => {
      output.write(line + '\n');
      if (/^(?:\s*Error:|✖|REFUSE)/.test(line) && !status.reason)
        status.reason = line.slice(0, 600);
      try {
        const event = JSON.parse(line);
        if (event.event === 'declarations_progress') {
          status.stage = event.stage;
          status.completed = event.completed;
          status.total = event.total;
        } else if (event.event === 'declarations_error') {
          status.reason ??= `${event.stage}: ${event.script} exited with ${event.signal ?? `code ${event.exitCode}`}`;
          status.signal = event.signal;
        } else if (event.event === 'declarations_job_complete' && event.runId === status.runId) {
          status.audit = event.audit;
          status.published = event.published;
        }
      } catch {
        /* Ordinary child logs are forwarded without becoming control messages. */
      }
    });
  }
  child.on('error', (error) => {
    status.state = 'failed';
    status.reason = error.message;
  });
  child.on('close', (code, signal) => {
    outputs[0].write(
      JSON.stringify({ event: 'declarations_child_exit', stage: status.stage, code, signal }) +
        '\n',
    );
    status.exitCode = code;
    status.signal = signal ?? status.signal;
    status.state =
      code === 0 && status.audit && status.published
        ? 'complete'
        : code === 75
          ? 'yielded'
          : 'failed';
    if (status.state !== 'complete')
      status.reason ??= `${status.stage} exited with ${signal ?? `code ${code}`}`;
  });
  return status;
}

if (import.meta.main) {
  // A slot rebuild (ADR-0048) or the weekly declarations run.
  const rebuild = process.env.SIGMA_REBUILD === '1';
  const child = spawn(
    process.execPath,
    [
      '--import',
      './scripts/cacbg/register-ts.mjs',
      ...(rebuild
        ? ['scripts/rebuild-slot.mjs']
        : ['scripts/related-persons-job.mjs', '--remote', '--yes', '--r2']),
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const status = supervise(
    child,
    process.env.SIGMA_RUN_ID,
    Number(process.env.SIGMA_ATTEMPT),
    undefined,
    rebuild ? 'import' : 'fetch',
  );
  createServer((req, res) => {
    if (req.url !== '/status') {
      res.writeHead(404).end();
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(status));
  }).listen(8080, '0.0.0.0');
  const report = (event, extra = {}) =>
    console.log(JSON.stringify({ event, stage: status.stage, ...extra, ...resources() }));
  setInterval(() => report('container_resources'), 60_000).unref();
  for (const signal of ['SIGTERM', 'SIGINT'])
    process.on(signal, () => {
      // A platform stop is otherwise silent too.
      report('container_signal', { signal });
      child.kill(signal);
    });
}
