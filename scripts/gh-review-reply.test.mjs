// Adversarial coverage for the shell-safe review-reply helper (see gh-review-reply.sh header).
// Real incident: a headless run inlined a Bulgarian reply body — containing „typographic quotes" —
// into a double-quoted shell argument, and the raw ASCII " terminated the string early, leaving a
// bare `syntax error near unexpected token `)'` in the transcript. This helper makes that class of
// bug structurally impossible by always reading the body from a file and passing it by reference
// (`-F body=@file`), never interpolating it. These tests drive the real script as a subprocess with
// a stubbed `gh` on PATH, exactly like scripts/import-guard.test.mjs drives import.mjs with a
// stubbed wrangler/node — so the guard is proven against the actual argv, not a reimplementation.
//
// Run: node --test scripts/gh-review-reply.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SCRIPT = resolve(HERE, 'gh-review-reply.sh');

// `gh` is stubbed to record its argv rather than call the network. `-F body=@file` means the shell
// never sees the reply text at all — the string that broke the real run never touches this stub.
const FAKE_GH = `#!${process.execPath}
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.GH_FAKE_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
process.exit(0);
`;

function runHelper(args, { stdinBody } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gh-reply-'));
  try {
    const binDir = join(dir, 'bin');
    mkdirSync(binDir);
    const ghPath = join(binDir, 'gh');
    writeFileSync(ghPath, FAKE_GH);
    chmodSync(ghPath, 0o755);
    const log = join(dir, 'calls.log');
    writeFileSync(log, '');
    const res = spawnSync('bash', [SCRIPT, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 30_000,
      input: stdinBody,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        GH_FAKE_LOG: log,
      },
    });
    const calls = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '', calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('no arguments exits 2 with a usage line on stderr', () => {
  const { status, stderr } = runHelper([]);
  assert.equal(status, 2);
  assert.match(stderr, /usage:/);
});

test('--resolve with the wrong argument count exits 2', () => {
  const { status, stderr } = runHelper(['--resolve']);
  assert.equal(status, 2);
  assert.match(stderr, /usage:/);

  const extra = runHelper(['--resolve', 'THREAD_ID', 'extra']);
  assert.equal(extra.status, 2);
});

test('a body file that does not exist exits 1 with HALT: body file not readable', () => {
  const { status, stderr } = runHelper(['THREAD_ID', '/nonexistent/path/body.txt']);
  assert.equal(status, 1);
  assert.match(stderr, /HALT: body file not readable/);
});

test('an empty body file exits 1 with HALT: body file is empty', () => {
  const dir = mktempFile('');
  try {
    const { status, stderr } = runHelper(['THREAD_ID', dir.file]);
    assert.equal(status, 1);
    assert.match(stderr, /HALT: body file is empty/);
  } finally {
    dir.cleanup();
  }
});

// Helper local to this file: writes `content` to a fresh temp file, returns its path + a cleanup fn.
function mktempFile(content) {
  const dir = mkdtempSync(join(tmpdir(), 'gh-reply-body-'));
  const file = join(dir, 'body.txt');
  writeFileSync(file, content);
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('the exact body that broke run 790 posts successfully, passed by reference never interpolated', () => {
  // Verbatim shape from the incident: „typographic quotes", parens, an em dash.
  const body = 'Потвърждение (вече заведено в 26d6f7a): „пълна" година — не грешка.';
  const { file, cleanup } = mktempFile(body);
  try {
    const { status, stdout, calls } = runHelper(['THREAD_ID', file]);
    assert.equal(status, 0);
    assert.match(stdout, /REPLIED THREAD_ID/);
    assert.equal(calls.length, 1);
    const argv = calls[0];
    // The body must appear only as a by-reference `-F body=@<path>` argument — never as the raw
    // text — proving the shell never had to parse the Bulgarian string as part of a command.
    assert.ok(
      argv.some((a) => a === `body=@${file}`),
      `expected body=@${file} in argv: ${argv}`,
    );
    assert.ok(!argv.some((a) => a.includes('пълна')), 'body text must never be interpolated raw');
  } finally {
    cleanup();
  }
});

test('body on stdin via "-" is read into a temp file and posted the same way', () => {
  const body = 'stdin body with „quotes" and (parens).';
  const { status, stdout, calls } = runHelper(['THREAD_ID', '-'], { stdinBody: body });
  assert.equal(status, 0);
  assert.match(stdout, /REPLIED THREAD_ID/);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].some((a) => a.startsWith('body=@')));
});

test('--resolve posts the resolve mutation and prints RESOLVED', () => {
  const { status, stdout, calls } = runHelper(['--resolve', 'THREAD_ID']);
  assert.equal(status, 0);
  assert.match(stdout, /RESOLVED THREAD_ID/);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].some((a) => a === 'id=THREAD_ID'));
});
