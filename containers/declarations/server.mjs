import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
let state = 'running';
const child = spawn(
  process.execPath,
  [
    '--import',
    './scripts/cacbg/register-ts.mjs',
    'scripts/related-persons-job.mjs',
    '--remote',
    '--yes',
    '--r2',
  ],
  { stdio: 'inherit' },
);
child.on('error', () => {
  state = 'failed';
});
child.on('exit', (code) => {
  state = code === 0 ? 'complete' : 'failed';
});
createServer((req, res) => {
  if (req.url !== '/status') {
    res.writeHead(404).end();
    return;
  }
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ runId: process.env.SIGMA_RUN_ID, state }));
}).listen(8080, '0.0.0.0');
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
