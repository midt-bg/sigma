// Run: node --test scripts/cacbg/audit-passes.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditUntilClean } from './audit-passes.mjs';

/** An audit that fails with the given verdicts in turn, then passes. */
const gate = (verdicts) => {
  const reloads = [];
  let n = 0;
  const run = () =>
    auditUntilClean({
      audit: () => {
        if (n < verdicts.length) {
          n++;
          throw Object.assign(new Error('audit findings'), { status: 1 });
        }
      },
      verdict: () => verdicts[n - 1],
      reload: (links, pass) => reloads.push({ pass, links }),
    });
  return { run, reloads };
};

test('a clean audit withholds nothing', () => {
  const g = gate([]);
  assert.deepEqual(g.run(), []);
  assert.deepEqual(g.reloads, []);
});

test('a finding a reload surfaces is withheld on the next pass, with the earlier ones', () => {
  const g = gate([
    { links: ['a'], structural: 0 },
    { links: ['b'], structural: 0 },
  ]);
  assert.deepEqual(g.run(), ['a', 'b']);
  assert.deepEqual(g.reloads, [
    { pass: 1, links: ['a'] },
    { pass: 2, links: ['a', 'b'] },
  ]);
});

test('a finding withholding did not remove stops the run', () => {
  const g = gate([
    { links: ['a'], structural: 0 },
    { links: ['a'], structural: 0 },
  ]);
  assert.throws(() => g.run(), /audit findings/);
  assert.equal(g.reloads.length, 1);
});

test('a defect that names no link stops the run at once', () => {
  assert.throws(() => gate([{ links: ['a'], structural: 1 }]).run(), /audit findings/);
  assert.throws(() => gate([null]).run(), /audit findings/);
});

test('the reloads are bounded', () => {
  const g = gate(['a', 'b', 'c', 'd', 'e'].map((k) => ({ links: [k], structural: 0 })));
  assert.throws(() => g.run(), /audit findings/);
  assert.equal(g.reloads.length, 3);
});

test('an audit killed by a signal is not a verdict', () => {
  assert.throws(
    () =>
      auditUntilClean({
        audit: () => {
          throw Object.assign(new Error('killed'), { signal: 'SIGKILL' });
        },
        verdict: () => ({ links: ['a'], structural: 0 }),
        reload: () => assert.fail('no reload'),
      }),
    /killed/,
  );
});
