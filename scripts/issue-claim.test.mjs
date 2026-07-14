import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  canUnassign,
  computeIdleDays,
  hasOpenLinkedPr,
  IN_PROGRESS,
  NUDGE_DAYS,
  NUDGE_MARKER,
  parseClaimMarker,
  parseCommand,
  RELEASE_DAYS,
  RELEASE_MARKER,
  shouldNudge,
  stripClaim,
  writeClaim,
} from './issue-claim.mjs';

// Fixed reference instant — no live Date.now() (repo convention + harness constraint).
const NOW = Date.parse('2026-07-14T12:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 86_400_000).toISOString();

// ── parseCommand ───────────────────────────────────────────────────────────────

describe('parseCommand', () => {
  it('returns /assign for bare /assign', () => {
    assert.equal(parseCommand('/assign'), '/assign');
  });

  it('returns /assign when followed by trailing text', () => {
    assert.equal(parseCommand('/assign  please'), '/assign');
  });

  it('returns /assign when preceded by leading whitespace', () => {
    assert.equal(parseCommand('  /assign'), '/assign');
  });

  it('returns /unassign for bare /unassign', () => {
    assert.equal(parseCommand('/unassign'), '/unassign');
  });

  it('returns /unassign when followed by trailing text', () => {
    assert.equal(parseCommand('/unassign  thanks'), '/unassign');
  });

  it('returns /unassign when preceded by leading whitespace', () => {
    assert.equal(parseCommand('  /unassign'), '/unassign');
  });

  it('rejects /assignee (extra suffix — not an exact match)', () => {
    assert.equal(parseCommand('/assignee'), null);
  });

  it('rejects /assign-me (extra suffix — not an exact match)', () => {
    assert.equal(parseCommand('/assign-me'), null);
  });

  it('rejects /assigned (extra suffix — not an exact match)', () => {
    assert.equal(parseCommand('/assigned'), null);
  });

  it('returns null for unrelated comment body', () => {
    assert.equal(parseCommand('This looks great!'), null);
  });

  it('returns null for empty string', () => {
    assert.equal(parseCommand(''), null);
  });

  it('returns null for null', () => {
    assert.equal(parseCommand(null), null);
  });

  it('is case-sensitive — /Assign is not /assign', () => {
    assert.equal(parseCommand('/Assign'), null);
  });

  it('returns null for undefined', () => {
    assert.equal(parseCommand(undefined), null);
  });
});

// ── parseClaimMarker ───────────────────────────────────────────────────────────

describe('parseClaimMarker', () => {
  it('parses a valid claim marker mid-body', () => {
    const body = 'Some text\n<!-- sigma-claim: {"user":"alice"} -->\nMore text';
    assert.deepEqual(parseClaimMarker(body), { user: 'alice' });
  });

  it('returns null when no marker is present', () => {
    assert.equal(parseClaimMarker('No claim here'), null);
  });

  it('returns null (never throws) for malformed JSON — S2', () => {
    const body = '<!-- sigma-claim: not-json -->';
    assert.doesNotThrow(() => parseClaimMarker(body));
    assert.equal(parseClaimMarker(body), null);
  });

  it('returns null when user field is missing — S5', () => {
    const body = '<!-- sigma-claim: {"role":"admin"} -->';
    assert.equal(parseClaimMarker(body), null);
  });

  it('returns null when user is not a string — S5', () => {
    const body = '<!-- sigma-claim: {"user":42} -->';
    assert.equal(parseClaimMarker(body), null);
  });

  it('returns null when user contains invalid characters — S5', () => {
    const body = '<!-- sigma-claim: {"user":"bad user!"} -->';
    assert.equal(parseClaimMarker(body), null);
  });

  it('returns null when user is too long (>39 chars) — S5', () => {
    const long = 'a'.repeat(40);
    const body = `<!-- sigma-claim: {"user":"${long}"} -->`;
    assert.equal(parseClaimMarker(body), null);
  });

  it('uses first marker when duplicates are present', () => {
    const body = '<!-- sigma-claim: {"user":"alice"} -->\n<!-- sigma-claim: {"user":"bob"} -->';
    assert.deepEqual(parseClaimMarker(body), { user: 'alice' });
  });
});

// ── stripClaim / writeClaim ────────────────────────────────────────────────────

describe('stripClaim', () => {
  it('removes banner and marker leaving surrounding text', () => {
    const body = writeClaim('Original body', 'alice');
    const stripped = stripClaim(body);
    assert.ok(!stripped.includes('sigma-claim'), 'marker not removed');
    assert.ok(!stripped.includes('🔧'), 'banner not removed');
    assert.ok(stripped.includes('Original body'));
  });

  it('removes DUPLICATE banners and markers — S3 anti-spoof', () => {
    // Attacker seeds two markers; strip must remove both.
    const seeded =
      '**🔧 Claimed by:** @attacker\n\n<!-- sigma-claim: {"user":"attacker"} -->\n' +
      '**🔧 Claimed by:** @attacker\n\n<!-- sigma-claim: {"user":"attacker"} -->\n' +
      'Real content';
    const stripped = stripClaim(seeded);
    assert.equal((stripped.match(/sigma-claim/g) ?? []).length, 0);
    assert.equal((stripped.match(/🔧/g) ?? []).length, 0);
    assert.ok(stripped.includes('Real content'));
  });

  it('is null-safe — returns empty string for null input', () => {
    assert.equal(stripClaim(null), '');
  });

  it('is null-safe — returns empty string for undefined input', () => {
    assert.equal(stripClaim(undefined), '');
  });

  it('returns body unchanged when no claim present', () => {
    assert.equal(stripClaim('Plain text'), 'Plain text');
  });
});

describe('writeClaim', () => {
  it('prepends banner and marker to the body', () => {
    const result = writeClaim('Issue description', 'bob');
    assert.ok(result.startsWith('**🔧 Claimed by:** @bob'));
    assert.ok(result.includes('<!-- sigma-claim: {"user":"bob"} -->'));
    assert.ok(result.includes('Issue description'));
  });

  it('is idempotent — re-claiming with the same user produces one marker', () => {
    const once = writeClaim('Body', 'alice');
    const twice = writeClaim(once, 'alice');
    assert.equal((twice.match(/sigma-claim/g) ?? []).length, 1);
    assert.equal((twice.match(/🔧/g) ?? []).length, 1);
  });

  it('re-claim by different user drops old marker and banner — S3', () => {
    const first = writeClaim('Body', 'alice');
    const second = writeClaim(first, 'bob');
    assert.ok(!second.includes('"user":"alice"'), 'old claim not removed');
    assert.ok(second.includes('"user":"bob"'), 'new claim not present');
    assert.equal((second.match(/sigma-claim/g) ?? []).length, 1);
    assert.equal((second.match(/🔧/g) ?? []).length, 1);
  });

  it('preserves surrounding body text after stripping', () => {
    const result = writeClaim('Description\n\nDetails', 'carol');
    assert.ok(result.includes('Description'));
    assert.ok(result.includes('Details'));
  });

  it('round-trips: writeClaim → stripClaim → writeClaim is stable', () => {
    const a = writeClaim('Body', 'dave');
    const b = writeClaim(stripClaim(a), 'dave');
    assert.equal(a, b);
  });
});

// ── canUnassign ────────────────────────────────────────────────────────────────

describe('canUnassign', () => {
  it('allows the original claimer to unassign themselves — O6 self case', () => {
    assert.equal(canUnassign({ actor: 'alice', claimedUser: 'alice', privileged: false }), true);
  });

  it('allows when privileged is true — O6 admin/write override', () => {
    assert.equal(
      canUnassign({ actor: 'maintainer', claimedUser: 'alice', privileged: true }),
      true,
    );
  });

  it('allows privileged=true even when actor and claimedUser differ', () => {
    assert.equal(canUnassign({ actor: 'admin', claimedUser: 'bob', privileged: true }), true);
  });

  it('denies a different user when not privileged', () => {
    assert.equal(canUnassign({ actor: 'charlie', claimedUser: 'alice', privileged: false }), false);
  });

  it('denies when privileged is undefined', () => {
    assert.equal(
      canUnassign({ actor: 'charlie', claimedUser: 'alice', privileged: undefined }),
      false,
    );
  });

  it('denies when privileged is null', () => {
    assert.equal(canUnassign({ actor: 'charlie', claimedUser: 'alice', privileged: null }), false);
  });

  it('denies when claimedUser is absent and actor is not privileged', () => {
    assert.equal(canUnassign({ actor: 'alice', claimedUser: null, privileged: false }), false);
  });
});

// ── computeIdleDays ────────────────────────────────────────────────────────────

describe('computeIdleDays', () => {
  it('measures days since the single human event', () => {
    const timeline = [{ event: 'commented', created_at: daysAgo(10), actor: { type: 'User' } }];
    const idle = computeIdleDays({ timeline, createdAt: daysAgo(20), nowMs: NOW });
    assert.ok(Math.abs(idle - 10) < 0.01, `expected ~10, got ${idle}`);
  });

  it('bot nudge must NOT reset the clock — O1-adjacent', () => {
    const timeline = [
      { event: 'commented', created_at: daysAgo(15), actor: { type: 'User' } },
      { event: 'commented', created_at: daysAgo(5), actor: { type: 'Bot' } },
    ];
    const idle = computeIdleDays({ timeline, createdAt: daysAgo(30), nowMs: NOW });
    assert.ok(Math.abs(idle - 15) < 0.01, `bot must not reset clock; expected ~15, got ${idle}`);
  });

  it('second bot event also does not reset the clock', () => {
    const timeline = [
      { event: 'commented', created_at: daysAgo(20), actor: { type: 'User' } },
      { event: 'commented', created_at: daysAgo(7), actor: { type: 'Bot' } },
      { event: 'commented', created_at: daysAgo(2), actor: { type: 'Bot' } },
    ];
    const idle = computeIdleDays({ timeline, createdAt: daysAgo(30), nowMs: NOW });
    assert.ok(Math.abs(idle - 20) < 0.01, `expected ~20, got ${idle}`);
  });

  it('uses the latest human event when multiple humans commented', () => {
    const timeline = [
      { event: 'commented', created_at: daysAgo(20), actor: { type: 'User' } },
      { event: 'commented', created_at: daysAgo(8), actor: { type: 'User' } },
    ];
    const idle = computeIdleDays({ timeline, createdAt: daysAgo(30), nowMs: NOW });
    assert.ok(Math.abs(idle - 8) < 0.01, `expected ~8, got ${idle}`);
  });

  it('falls back to createdAt when no human event exists', () => {
    const timeline = [{ event: 'commented', created_at: daysAgo(5), actor: { type: 'Bot' } }];
    const idle = computeIdleDays({ timeline, createdAt: daysAgo(20), nowMs: NOW });
    assert.ok(Math.abs(idle - 20) < 0.01, `expected ~20, got ${idle}`);
  });

  it('falls back to createdAt when timeline is empty', () => {
    const idle = computeIdleDays({ timeline: [], createdAt: daysAgo(14), nowMs: NOW });
    assert.ok(Math.abs(idle - 14) < 0.01, `expected ~14, got ${idle}`);
  });

  it('boundary: exactly 14 days idle', () => {
    const timeline = [{ event: 'commented', created_at: daysAgo(14), actor: { type: 'User' } }];
    const idle = computeIdleDays({ timeline, createdAt: daysAgo(30), nowMs: NOW });
    assert.ok(Math.abs(idle - 14) < 0.01, `expected ~14, got ${idle}`);
  });

  it('boundary: exactly 21 days idle', () => {
    const timeline = [{ event: 'commented', created_at: daysAgo(21), actor: { type: 'User' } }];
    const idle = computeIdleDays({ timeline, createdAt: daysAgo(30), nowMs: NOW });
    assert.ok(Math.abs(idle - 21) < 0.01, `expected ~21, got ${idle}`);
  });

  it('ignores events with unparseable timestamps — no throw', () => {
    const timeline = [
      { event: 'commented', created_at: 'not-a-date', actor: { type: 'User' } },
      { event: 'commented', created_at: daysAgo(10), actor: { type: 'User' } },
    ];
    assert.doesNotThrow(() => {
      const idle = computeIdleDays({ timeline, createdAt: daysAgo(30), nowMs: NOW });
      assert.ok(Math.abs(idle - 10) < 0.01, `expected ~10, got ${idle}`);
    });
  });

  it('uses submitted_at when created_at is absent', () => {
    const timeline = [{ event: 'reviewed', submitted_at: daysAgo(12), actor: { type: 'User' } }];
    const idle = computeIdleDays({ timeline, createdAt: daysAgo(30), nowMs: NOW });
    assert.ok(Math.abs(idle - 12) < 0.01, `expected ~12, got ${idle}`);
  });

  it('handles null timeline gracefully', () => {
    const idle = computeIdleDays({ timeline: null, createdAt: daysAgo(5), nowMs: NOW });
    assert.ok(Math.abs(idle - 5) < 0.01, `expected ~5, got ${idle}`);
  });
});

// ── hasOpenLinkedPr ────────────────────────────────────────────────────────────

describe('hasOpenLinkedPr', () => {
  it('returns true for a cross-reference to an open PR on the same repo', () => {
    const timeline = [
      {
        event: 'cross-referenced',
        source: { issue: { pull_request: {}, state: 'open' } },
      },
    ];
    assert.equal(hasOpenLinkedPr(timeline), true);
  });

  it('returns false for a cross-reference to a closed PR', () => {
    const timeline = [
      {
        event: 'cross-referenced',
        source: { issue: { pull_request: {}, state: 'closed' } },
      },
    ];
    assert.equal(hasOpenLinkedPr(timeline), false);
  });

  it('returns false for a cross-reference to a merged PR (state=closed)', () => {
    const timeline = [
      {
        event: 'cross-referenced',
        source: { issue: { pull_request: { merged_at: '2026-01-01T00:00:00Z' }, state: 'closed' } },
      },
    ];
    assert.equal(hasOpenLinkedPr(timeline), false);
  });

  it('returns false for a cross-reference to a plain issue (no pull_request field)', () => {
    const timeline = [
      {
        event: 'cross-referenced',
        source: { issue: { state: 'open' } },
      },
    ];
    assert.equal(hasOpenLinkedPr(timeline), false);
  });

  it('returns true for a fork-source PR that is still open — O3', () => {
    // Fork-source: source.issue.repository differs from the base repo — state is read off the
    // event directly, so fork-source PRs are handled correctly without re-fetching.
    const timeline = [
      {
        event: 'cross-referenced',
        source: {
          issue: {
            pull_request: {},
            state: 'open',
            repository: { full_name: 'fork-user/sigma' },
          },
        },
      },
    ];
    assert.equal(hasOpenLinkedPr(timeline), true);
  });

  it('returns false when source is null — null-safe', () => {
    const timeline = [{ event: 'cross-referenced', source: null }];
    assert.equal(hasOpenLinkedPr(timeline), false);
  });

  it('returns false when source.issue is null — null-safe', () => {
    const timeline = [{ event: 'cross-referenced', source: { issue: null } }];
    assert.equal(hasOpenLinkedPr(timeline), false);
  });

  it('returns false for an empty timeline', () => {
    assert.equal(hasOpenLinkedPr([]), false);
  });

  it('returns false for a null timeline', () => {
    assert.equal(hasOpenLinkedPr(null), false);
  });
});

// ── shouldNudge ────────────────────────────────────────────────────────────────

describe('shouldNudge', () => {
  it('returns true when idle ≥ NUDGE_DAYS and not yet nudged', () => {
    assert.equal(
      shouldNudge({ idleDays: 14, nudgeDays: NUDGE_DAYS, timeline: [], nudgeMarker: NUDGE_MARKER }),
      true,
    );
  });

  it('returns false when idle < NUDGE_DAYS', () => {
    assert.equal(
      shouldNudge({ idleDays: 13, nudgeDays: NUDGE_DAYS, timeline: [], nudgeMarker: NUDGE_MARKER }),
      false,
    );
  });

  it('returns false when idle > NUDGE_DAYS but already nudged via marker — O1', () => {
    const timeline = [
      {
        event: 'commented',
        body: `Heads up! ${NUDGE_MARKER}`,
        actor: { type: 'Bot' },
        created_at: daysAgo(5),
      },
    ];
    assert.equal(
      shouldNudge({ idleDays: 20, nudgeDays: NUDGE_DAYS, timeline, nudgeMarker: NUDGE_MARKER }),
      false,
    );
  });

  it('human comment containing the words "auto-release" does NOT suppress nudge — O1', () => {
    // Only the invisible marker suppresses; free-text "auto-release" in a human comment does not.
    const timeline = [
      {
        event: 'commented',
        body: 'This issue will auto-release if idle',
        actor: { type: 'User' },
        created_at: daysAgo(2),
      },
    ];
    assert.equal(
      shouldNudge({ idleDays: 16, nudgeDays: NUDGE_DAYS, timeline, nudgeMarker: NUDGE_MARKER }),
      true,
    );
  });

  it('a release-marked comment does NOT count as a nudge', () => {
    // A sigma-release comment must not satisfy the nudge-already-sent guard.
    const timeline = [
      {
        event: 'commented',
        body: `Claim released. ${RELEASE_MARKER}`,
        actor: { type: 'Bot' },
        created_at: daysAgo(3),
      },
    ];
    assert.equal(
      shouldNudge({ idleDays: 16, nudgeDays: NUDGE_DAYS, timeline, nudgeMarker: NUDGE_MARKER }),
      true,
    );
  });

  it('returns true for idle ≥ NUDGE_DAYS with an empty timeline', () => {
    assert.equal(
      shouldNudge({ idleDays: 15, nudgeDays: NUDGE_DAYS, timeline: [], nudgeMarker: NUDGE_MARKER }),
      true,
    );
  });

  it('returns false when idle is exactly 0 (just commented)', () => {
    assert.equal(
      shouldNudge({ idleDays: 0, nudgeDays: NUDGE_DAYS, timeline: [], nudgeMarker: NUDGE_MARKER }),
      false,
    );
  });

  it('returns true when idle equals RELEASE_DAYS and not yet nudged', () => {
    // RELEASE_DAYS ≥ NUDGE_DAYS — workflow decides release vs nudge, but shouldNudge itself
    // still returns true at 21 days if no marker is present.
    assert.equal(
      shouldNudge({
        idleDays: RELEASE_DAYS,
        nudgeDays: NUDGE_DAYS,
        timeline: [],
        nudgeMarker: NUDGE_MARKER,
      }),
      true,
    );
  });

  it('returns true for null timeline when idle >= nudgeDays (null coerces to empty — no prior nudge)', () => {
    assert.equal(
      shouldNudge({
        idleDays: 20,
        nudgeDays: NUDGE_DAYS,
        timeline: null,
        nudgeMarker: NUDGE_MARKER,
      }),
      true,
    );
  });
});

// ── exported constants ─────────────────────────────────────────────────────────

describe('exported constants', () => {
  it('IN_PROGRESS is the correct label string', () => {
    assert.equal(IN_PROGRESS, 'status: in-progress');
  });

  it('NUDGE_DAYS is 14', () => {
    assert.equal(NUDGE_DAYS, 14);
  });

  it('RELEASE_DAYS is 21', () => {
    assert.equal(RELEASE_DAYS, 21);
  });

  it('NUDGE_MARKER is the invisible HTML comment', () => {
    assert.equal(NUDGE_MARKER, '<!-- sigma-nudge -->');
  });

  it('RELEASE_MARKER is the invisible HTML comment', () => {
    assert.equal(RELEASE_MARKER, '<!-- sigma-release -->');
  });
});

// ── composed decision cases ────────────────────────────────────────────────────

describe('composed decision cases', () => {
  it('/assign flow: writeClaim produces parseable marker', () => {
    const body = writeClaim('Fix the bug', 'alice');
    const parsed = parseClaimMarker(body);
    assert.deepEqual(parsed, { user: 'alice' });
  });

  it('/unassign flow: stripClaim leaves no parseable marker', () => {
    const claimed = writeClaim('Fix the bug', 'alice');
    const stripped = stripClaim(claimed);
    assert.equal(parseClaimMarker(stripped), null);
  });

  it('stale sweep: idle issue with no nudge gets nudged', () => {
    const timeline = [{ event: 'commented', created_at: daysAgo(16), actor: { type: 'User' } }];
    const idle = computeIdleDays({ timeline, createdAt: daysAgo(30), nowMs: NOW });
    const nudge = shouldNudge({
      idleDays: idle,
      nudgeDays: NUDGE_DAYS,
      timeline,
      nudgeMarker: NUDGE_MARKER,
    });
    assert.equal(nudge, true);
  });

  it('stale sweep: issue with open PR is skipped', () => {
    const timeline = [
      {
        event: 'cross-referenced',
        source: { issue: { pull_request: {}, state: 'open' } },
      },
      { event: 'commented', created_at: daysAgo(20), actor: { type: 'User' } },
    ];
    assert.equal(hasOpenLinkedPr(timeline), true);
  });

  it('stale sweep: already-nudged issue does not get a second nudge', () => {
    const timeline = [
      { event: 'commented', created_at: daysAgo(20), actor: { type: 'User' } },
      {
        event: 'commented',
        body: `Please update us. ${NUDGE_MARKER}`,
        actor: { type: 'Bot' },
        created_at: daysAgo(6),
      },
    ];
    const idle = computeIdleDays({ timeline, createdAt: daysAgo(30), nowMs: NOW });
    const nudge = shouldNudge({
      idleDays: idle,
      nudgeDays: NUDGE_DAYS,
      timeline,
      nudgeMarker: NUDGE_MARKER,
    });
    // idle is ~20d (bot doesn't reset), but already nudged
    assert.equal(nudge, false);
  });

  it('stale sweep: canUnassign allows privileged release of another user', () => {
    const body = writeClaim('Refactor login', 'alice');
    const claim = parseClaimMarker(body);
    assert.ok(claim !== null);
    const allowed = canUnassign({ actor: 'maintainer', claimedUser: claim.user, privileged: true });
    assert.equal(allowed, true);
  });

  it('stale sweep: malformed marker body is skipped without throw — S2', () => {
    const poisonBody = '<!-- sigma-claim: {bad json} -->';
    assert.doesNotThrow(() => {
      const claim = parseClaimMarker(poisonBody);
      assert.equal(claim, null);
    });
  });

  it('re-assign: second writeClaim over existing strips old, embeds new — S3', () => {
    const first = writeClaim('Issue body', 'alice');
    const second = writeClaim(first, 'bob');
    assert.equal(parseClaimMarker(second)?.user, 'bob');
    assert.ok(!second.includes('"user":"alice"'));
  });

  it('bot comment in timeline does not reset idle clock — full scenario', () => {
    const timeline = [
      { event: 'commented', created_at: daysAgo(22), actor: { type: 'User' } },
      {
        event: 'commented',
        body: `Reminding you. ${NUDGE_MARKER}`,
        actor: { type: 'Bot' },
        created_at: daysAgo(8),
      },
    ];
    const idle = computeIdleDays({ timeline, createdAt: daysAgo(30), nowMs: NOW });
    // idle must be based on the human event 22 days ago, not the bot at 8 days ago
    assert.ok(idle >= 21, `expected idle >= 21, got ${idle}`);
    // already nudged, so shouldNudge must be false
    const nudge = shouldNudge({
      idleDays: idle,
      nudgeDays: NUDGE_DAYS,
      timeline,
      nudgeMarker: NUDGE_MARKER,
    });
    assert.equal(nudge, false);
  });

  it('parseCommand + canUnassign: non-privileged third party cannot unassign', () => {
    const cmd = parseCommand('/unassign');
    assert.equal(cmd, '/unassign');
    const allowed = canUnassign({ actor: 'random-user', claimedUser: 'alice', privileged: false });
    assert.equal(allowed, false);
  });

  it('full assign-then-release cycle is clean', () => {
    const original = 'Report a bug in the dashboard';
    const claimed = writeClaim(original, 'dave');
    assert.ok(parseClaimMarker(claimed) !== null);
    const released = stripClaim(claimed);
    assert.equal(parseClaimMarker(released), null);
    assert.ok(released.includes(original));
  });
});
