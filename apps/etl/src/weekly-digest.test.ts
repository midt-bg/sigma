import { priorIsoWeek as priorIsoWeekOfWeek } from '@sigma/db';
import { priorIsoWeek as priorIsoWeekFromNow } from '@sigma/report';
import { date } from '@sigma/shared';
import { describe, expect, it, vi } from 'vitest';
import { digestEnabled, generateWeeklyDigest, type WeeklyDigestEnv } from './weekly-digest';

// Fixed clock: a Monday, so `priorIsoWeek(now)` resolves to the FULL Mon–Sun week immediately before
// the one containing `now` — the week this cron run targets.
const NOW = new Date('2024-01-15T07:00:00Z');
const TARGET = priorIsoWeekFromNow(NOW);
const PRIOR_WEEK = priorIsoWeekOfWeek(TARGET.iso);

interface LargestRawRow {
  id: string;
  source_id: string;
  authority_id: string;
  bidder_id: string;
  bidder_name: string;
  amount_eur: number;
  signed_at: string;
}

interface TopContractRawRow {
  id: string;
  source_id: string;
  title: string;
  authority_id: string;
  authority_name: string;
  bidder_id: string;
  bidder_name: string;
  amount_eur: number;
  signed_at: string;
}

interface SectorRawRow {
  division: string | null;
  contracts: number;
  value_eur: number;
}

interface AuthorityRawRow {
  authority_id: string;
  authority_name: string;
  contracts: number;
  value_eur: number;
}

interface FakeWeekData {
  asOf: string | null;
  homeTotalEur: number;
  totalsByWeek: Record<string, number>;
  /** Raw `getWeeklyCounts` row shape (snake_case): the fake DB hands this back for the query layer to map. */
  counts: { contracts: number; contracts_with_amount: number; tenders: number };
  largest: LargestRawRow | null;
  singleBid: { single_bid: number | null; sample: number };
  topContracts: TopContractRawRow[];
  sectors: SectorRawRow[];
  authorities: AuthorityRawRow[];
  /** Raw daily-spend rows (§3.4). The same set answers both the current and prior week query. */
  dailyRows?: { day: string; value_eur: number }[];
  existingDigestRow: boolean;
}

interface UpsertRow {
  isoWeek: string;
  asOf: string;
  refreshedAt: string;
  status: string;
  totalEur: number;
}

// A fully-populated "happy path" week: settled, non-zero, internally consistent (largest <= total,
// delta within a plausible range).
function happyPathData(): FakeWeekData {
  return {
    asOf: '2024-01-15',
    homeTotalEur: 500_000,
    totalsByWeek: {
      [TARGET.iso]: 100_000,
      [PRIOR_WEEK]: 80_000,
    },
    counts: { contracts: 12, contracts_with_amount: 10, tenders: 10 },
    largest: {
      id: 'c1',
      source_id: '00042-2024-0001',
      authority_id: 'auth:111',
      bidder_id: 'eik:222',
      bidder_name: 'Изпълнител ЕООД',
      amount_eur: 40_000,
      signed_at: '2024-01-10',
    },
    singleBid: { single_bid: 8, sample: 22 },
    topContracts: [
      {
        id: 'c1',
        source_id: '00042-2024-0001',
        title: 'Доставка на офис консумативи',
        authority_id: 'auth:111',
        authority_name: 'Община Пример',
        bidder_id: 'eik:222',
        bidder_name: 'Изпълнител ЕООД',
        amount_eur: 40_000,
        signed_at: '2024-01-10',
      },
    ],
    sectors: [{ division: '45', contracts: 6, value_eur: 60_000 }],
    authorities: [
      {
        authority_id: 'auth:111',
        authority_name: 'Община Пример',
        contracts: 4,
        value_eur: 45_000,
      },
    ],
    // Answers the daily-spend query for both weeks (the query dates are 2024 Mon..Sun; the exact date
    // key is irrelevant here — getWeeklyDailySpend zero-fills unmatched days, and one matched day is
    // enough to prove a non-zero bar binds through the weekbars block).
    dailyRows: [{ day: '2024-01-08', value_eur: 12_000 }],
    existingDigestRow: false,
  };
}

function fakeWeeklyDb(data: FakeWeekData, upserts: UpsertRow[]): D1Database {
  const db = {
    prepare(sql: string) {
      if (sql.includes('as_of AS as_of')) {
        return { first: async () => ({ value_eur: data.homeTotalEur, as_of: data.asOf }) };
      }
      if (sql.includes('FROM weekly_digests WHERE iso_week')) {
        return {
          bind: (isoWeek: string) => ({
            first: async () => (data.existingDigestRow ? { iso_week: isoWeek } : null),
          }),
        };
      }
      if (sql.includes('INSERT INTO weekly_digests')) {
        return {
          bind: (
            isoWeek: string,
            asOf: string,
            refreshedAt: string,
            status: string,
            totalEur: number,
          ) => ({
            run: async () => {
              upserts.push({ isoWeek, asOf, refreshedAt, status, totalEur });
              return { success: true };
            },
          }),
        };
      }
      if (sql.includes('FROM home_totals')) {
        // reconcileWeeklyTotal's plain value_eur lookup (no bind — direct .first()).
        return { first: async () => ({ value_eur: data.homeTotalEur }) };
      }
      if (sql.includes('GROUP BY day')) {
        // Daily-spend series (§3.4). Empty rows → getWeeklyDailySpend zero-fills all 7 Mon..Sun slots.
        return {
          bind: (_iso: string) => ({ all: async () => ({ results: data.dailyRows ?? [] }) }),
        };
      }
      if (sql.trim().endsWith('LIMIT 1')) {
        return { bind: (_iso: string) => ({ first: async () => data.largest }) };
      }
      if (sql.includes('t.title')) {
        return { bind: (_iso: string) => ({ all: async () => ({ results: data.topContracts }) }) };
      }
      if (sql.includes('GROUP BY t.authority_id')) {
        return { bind: (_iso: string) => ({ all: async () => ({ results: data.authorities }) }) };
      }
      if (sql.includes('GROUP BY division')) {
        return { bind: (_iso: string) => ({ all: async () => ({ results: data.sectors }) }) };
      }
      if (sql.includes('single_bid')) {
        return { bind: (_iso: string) => ({ first: async () => data.singleBid }) };
      }
      if (sql.includes('COUNT(DISTINCT c.tender_id)')) {
        return { bind: (_iso: string) => ({ first: async () => data.counts }) };
      }
      if (sql.includes('AS total_eur')) {
        return {
          bind: (isoWeek: string) => ({
            first: async () => ({ total_eur: data.totalsByWeek[isoWeek] ?? 0 }),
          }),
        };
      }
      throw new Error(`unexpected SQL: ${sql.slice(0, 80)}`);
    },
  };
  return db as unknown as D1Database;
}

interface PutCall {
  key: string;
  body: string;
  opts: unknown;
}

function fakeBucket(puts: PutCall[]): R2Bucket {
  return {
    put: async (key: string, body: string, opts?: unknown) => {
      puts.push({ key, body, opts });
      return null as unknown as R2Object;
    },
    // The re-issue path reads the prior artifact to preserve its original createdAt; serve the newest
    // put for the key (null when nothing has been written yet — a first publish).
    get: async (key: string) => {
      const prior = puts.filter((p) => p.key === key).at(-1);
      return prior ? ({ text: async () => prior.body } as unknown as R2Object) : null;
    },
  } as unknown as R2Bucket;
}

function baseEnv(db: D1Database, bucket: R2Bucket): WeeklyDigestEnv {
  return { DB: db, REPORTS: bucket };
}

// A `generate` mock that answers BOTH call shapes the pipeline can make with the same injected fn:
// the narrative call (plain prose) and, if `needsVerification` trips (a ranking chart + real prose),
// the role-④ verifier call (strict JSON verdicts). Extracts the claim ids the verifier envelope
// actually asks about from its own prompt, so it never "misses" a claim the way a hand-written fixed
// verdict list would as the report's block set evolves.
function mockGenerate(
  narrativeMd: string,
): (input: { system: string; prompt: string }) => Promise<string> {
  return async ({ system, prompt }) => {
    if (system.includes('verification critic')) {
      const ids = [...prompt.matchAll(/^(C\d+):/gm)].map((m) => m[1]);
      return JSON.stringify({ verdicts: ids.map((id) => ({ id, verdict: 'supported' })) });
    }
    return narrativeMd;
  };
}

describe('digestEnabled (kill-switch, dispatch-layer gate)', () => {
  it('is OFF (fail-dark) when unset', () => {
    expect(digestEnabled(undefined)).toBe(false);
  });

  it('is OFF for the committed "false"', () => {
    expect(digestEnabled('false')).toBe(false);
  });

  it('is OFF for garbage input', () => {
    expect(digestEnabled('yes-please')).toBe(false);
  });

  it('is ON for "true"/"1"/"on" (case/whitespace tolerant)', () => {
    expect(digestEnabled('true')).toBe(true);
    expect(digestEnabled(' TRUE ')).toBe(true);
    expect(digestEnabled('1')).toBe(true);
    expect(digestEnabled('on')).toBe(true);
  });
});

describe('generateWeeklyDigest — gate matrix', () => {
  it('unsettled week: skips without calling generate or writing to R2', async () => {
    const data = happyPathData();
    data.asOf = '2024-01-10'; // < target.sundayIso — the week is still accumulating
    const upserts: UpsertRow[] = [];
    const puts: PutCall[] = [];
    let generateCalls = 0;

    await generateWeeklyDigest(baseEnv(fakeWeeklyDb(data, upserts), fakeBucket(puts)), {
      now: NOW,
      generate: async () => {
        generateCalls += 1;
        return 'never';
      },
    });

    expect(generateCalls).toBe(0);
    expect(puts).toHaveLength(0);
    expect(upserts).toHaveLength(0);
  });

  it('missing as_of: skips without calling generate or writing to R2', async () => {
    const data = happyPathData();
    data.asOf = null;
    const upserts: UpsertRow[] = [];
    const puts: PutCall[] = [];
    let generateCalls = 0;

    await generateWeeklyDigest(baseEnv(fakeWeeklyDb(data, upserts), fakeBucket(puts)), {
      now: NOW,
      generate: async () => {
        generateCalls += 1;
        return 'never';
      },
    });

    expect(generateCalls).toBe(0);
    expect(puts).toHaveLength(0);
  });

  it('SECURITY: zero contracts — no LLM call and no R2 put', async () => {
    const data = happyPathData();
    data.counts = { contracts: 0, contracts_with_amount: 0, tenders: 0 };
    data.totalsByWeek[TARGET.iso] = 0;
    data.largest = null;
    data.topContracts = [];
    data.sectors = [];
    data.authorities = [];
    data.singleBid = { single_bid: null, sample: 0 };
    const upserts: UpsertRow[] = [];
    const puts: PutCall[] = [];
    let generateCalls = 0;

    await generateWeeklyDigest(baseEnv(fakeWeeklyDb(data, upserts), fakeBucket(puts)), {
      now: NOW,
      generate: async () => {
        generateCalls += 1;
        return 'never';
      },
    });

    expect(generateCalls).toBe(0);
    expect(puts).toHaveLength(0);
    expect(upserts).toHaveLength(0);
  });

  it('sanity gate: negative total blocks publish', async () => {
    const data = happyPathData();
    data.totalsByWeek[TARGET.iso] = -1;
    const upserts: UpsertRow[] = [];
    const puts: PutCall[] = [];
    let generateCalls = 0;

    await generateWeeklyDigest(baseEnv(fakeWeeklyDb(data, upserts), fakeBucket(puts)), {
      now: NOW,
      generate: async () => {
        generateCalls += 1;
        return 'ok';
      },
    });

    expect(generateCalls).toBe(0);
    expect(puts).toHaveLength(0);
  });

  it('sanity gate: largest contract exceeding the weekly total blocks publish', async () => {
    const data = happyPathData();
    if (!data.largest) throw new Error('fixture missing largest');
    data.largest.amount_eur = data.totalsByWeek[TARGET.iso]! + 1;
    const upserts: UpsertRow[] = [];
    const puts: PutCall[] = [];

    await generateWeeklyDigest(baseEnv(fakeWeeklyDb(data, upserts), fakeBucket(puts)), {
      now: NOW,
      generate: async () => 'ok',
    });

    expect(puts).toHaveLength(0);
  });

  it('valid path: persists a StoredReport at weeks/{iso}.json with bound numbers', async () => {
    const data = happyPathData();
    const upserts: UpsertRow[] = [];
    const puts: PutCall[] = [];

    await generateWeeklyDigest(baseEnv(fakeWeeklyDb(data, upserts), fakeBucket(puts)), {
      now: NOW,
      generate: mockGenerate(
        'Изминалата седмица бе разнообразна за обществените поръчки в страната.',
      ),
    });

    expect(puts).toHaveLength(1);
    expect(puts[0]!.key).toBe(`weeks/${TARGET.iso}.json`);
    // Listing-facing R2 customMetadata: the /weeks archive index reads these without a per-week fetch.
    // The object is NOT written `immutable` — it's overwritten in place on a §10.4 re-issue, so no
    // immutable object cacheControl (the serve path sends its own headers).
    const putOpts = puts[0]!.opts as {
      httpMetadata?: { cacheControl?: string };
      customMetadata?: Record<string, string>;
    };
    expect(putOpts.httpMetadata?.cacheControl).toBeUndefined();
    expect(putOpts.customMetadata).toMatchObject({
      totalEur: String(data.totalsByWeek[TARGET.iso]),
      monday: TARGET.mondayIso,
      sunday: TARGET.sundayIso,
    });
    const stored = JSON.parse(puts[0]!.body);
    expect(stored.schemaVersion).toBe(1);
    expect(stored.id).toBe(TARGET.iso);
    // Title reads „Седмичен обзор — <range>": the user-facing name is „обзор" (not „дайджест"), and it
    // carries the human-readable Mon–Sun range, not the raw ISO week id.
    expect(stored.report.title).toContain('Седмичен обзор — ');
    expect(stored.report.title).not.toContain('дайджест');
    expect(stored.report.title).toContain(`${date(TARGET.mondayIso)} – ${date(TARGET.sundayIso)}`);
    expect(stored.report.title).not.toContain(TARGET.iso);
    // Stored question carries the same „обзор" wording.
    expect(stored.provenance.question).toContain('Седмичен обзор');
    const totalsBlock = stored.report.blocks.find((b: { type: string }) => b.type === 'totals');
    expect(totalsBlock).toBeTruthy();
    expect(totalsBlock.items[0].value).toBe(data.totalsByWeek[TARGET.iso]);
    // §3.4: the daily ghost-bar chart is emitted with both series bound from the daily queries.
    const weekbars = stored.report.blocks.find((b: { type: string }) => b.type === 'weekbars');
    expect(weekbars).toBeTruthy();
    expect(weekbars.current).toHaveLength(7);
    expect(weekbars.previous).toHaveLength(7);
    expect(weekbars.current.some((d: { value: number }) => d.value === 12_000)).toBe(true);
    // Sector bar labels the human-readable sector NAME, not the raw 2-digit CPV code: fixture division
    // '45' → curated „Строителство".
    const barBlock = stored.report.blocks.find((b: { type: string }) => b.type === 'bar');
    expect(barBlock).toBeTruthy();
    expect(barBlock.points[0].label).toBe('Строителство');
    expect(barBlock.points[0].label).not.toBe('45');
    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.isoWeek).toBe(TARGET.iso);
    expect(upserts[0]!.status).toBe('ok');
    expect(upserts[0]!.totalEur).toBe(data.totalsByWeek[TARGET.iso]);
  });

  it('targetIso overrides `now`, generating for the explicit week (on-demand trigger path)', async () => {
    const data = happyPathData();
    const upserts: UpsertRow[] = [];
    const puts: PutCall[] = [];

    // `now` is an unrelated week; `targetIso` forces TARGET.iso, so the artifact + upsert are for
    // TARGET rather than priorIsoWeek(now). The settled-week gate still reads TARGET's Sunday vs asOf.
    await generateWeeklyDigest(baseEnv(fakeWeeklyDb(data, upserts), fakeBucket(puts)), {
      now: new Date('2030-06-03T07:00:00Z'),
      targetIso: TARGET.iso,
      generate: mockGenerate(
        'Изминалата седмица бе разнообразна за обществените поръчки в страната.',
      ),
    });

    expect(puts).toHaveLength(1);
    expect(puts[0]!.key).toBe(`weeks/${TARGET.iso}.json`);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.isoWeek).toBe(TARGET.iso);
  });

  // precompute.sql's COUNT/SUM CONSISTENCY rule: a (count, sum) rendered as one KPI set must cover ONE
  // row set. The totals strip puts "Договори" right next to "Обща стойност", so it must bind the
  // clean-amount count (10) — binding the raw volume (12) would let a reader divide the two and get a
  // wrong average contract value.
  it('totals: "Договори" binds the clean-amount count, not the raw activity volume', async () => {
    const data = happyPathData();
    const upserts: UpsertRow[] = [];
    const puts: PutCall[] = [];

    await generateWeeklyDigest(baseEnv(fakeWeeklyDb(data, upserts), fakeBucket(puts)), {
      now: NOW,
      generate: mockGenerate('Кратко резюме на седмицата.'),
    });

    const totals = JSON.parse(puts[0]!.body).report.blocks.find(
      (b: { type: string }) => b.type === 'totals',
    );
    const contractsItem = totals.items.find((i: { label: string }) => i.label === 'Договори');
    expect(contractsItem.value).toBe(data.counts.contracts_with_amount); // 10
    expect(contractsItem.value).not.toBe(data.counts.contracts); // not the 12-row volume
  });

  // v3 narrative: the call is fed QUALITATIVE week signals (direction, sector concentration, largest-
  // contract weight, competition, authority spread, peak day) and asked for a ≥5-paragraph „Какво се
  // случи" analysis — no numbers (those stay server-bound in the tables/charts). This asserts the signals
  // and the analytical task reach the model prompt.
  it('narrative prompt: drives a ≥5-paragraph „Какво се случи" analysis from qualitative signals', async () => {
    const data = happyPathData();
    const upserts: UpsertRow[] = [];
    const puts: PutCall[] = [];
    let narrativePrompt = '';
    let narrativeSystem = '';

    await generateWeeklyDigest(baseEnv(fakeWeeklyDb(data, upserts), fakeBucket(puts)), {
      now: NOW,
      generate: async ({ system, prompt }: { system: string; prompt: string }) => {
        if (system.includes('verification critic')) {
          const ids = [...prompt.matchAll(/^(C\d+):/gm)].map((m) => m[1]);
          return JSON.stringify({ verdicts: ids.map((id) => ({ id, verdict: 'supported' })) });
        }
        narrativePrompt = prompt;
        narrativeSystem = system;
        return 'Изминалата седмица бе разнообразна за обществените поръчки в страната.';
      },
    });

    // Delta 100_000 vs prior 80_000 → the week-over-week move is fed qualitatively (verb, no number).
    expect(narrativePrompt).toContain('нарасна');
    // The leading CPV division reaches the model (it names it via the dictionary in the system prompt).
    expect(narrativePrompt).toContain('Водещи CPV раздели');
    // The task itself: a ≥5-paragraph analysis, explicitly without numbers.
    expect(narrativePrompt).toContain('най-малко 5 абзаца');
    // The system prompt drives the analytical „Какво се случи" and still bans numbers in prose.
    expect(narrativeSystem).toContain('НАЙ-МАЛКО 5 абзаца');
    expect(narrativeSystem).toContain('Какво се случи');
  });

  // Regenerate-on-strip safety net: a verifier strip of one draft must NOT condemn the week to AI-free
  // on the spot — the narrative runs at temp 0.3 (varies), so a regenerated draft gets a fresh pass.
  // Here the first draft's narrative (C1) is stripped, the retry is supported and survives.
  it('regenerate-on-strip: a stripped first draft is retried and a surviving draft wins', async () => {
    const data = happyPathData();
    const upserts: UpsertRow[] = [];
    const puts: PutCall[] = [];
    let narrativeCalls = 0;
    let verifyCalls = 0;

    await generateWeeklyDigest(baseEnv(fakeWeeklyDb(data, upserts), fakeBucket(puts)), {
      now: NOW,
      generate: async ({ system, prompt }: { system: string; prompt: string }) => {
        if (system.includes('verification critic')) {
          verifyCalls += 1;
          const ids = [...prompt.matchAll(/^(C\d+):/gm)].map((m) => m[1]);
          // First verification strips the narrative claim (C1); every later one supports all claims.
          return JSON.stringify({
            verdicts: ids.map((id) => ({
              id,
              verdict: verifyCalls === 1 && id === 'C1' ? 'unsupported' : 'supported',
            })),
          });
        }
        narrativeCalls += 1;
        return narrativeCalls === 1 ? 'Първо резюме на седмицата.' : 'Второ резюме на седмицата.';
      },
    });

    // One strip → one regeneration; the second draft survives, so exactly two of each call.
    expect(narrativeCalls).toBe(2);
    expect(verifyCalls).toBe(2);
    expect(puts).toHaveLength(1);
    const stored = JSON.parse(puts[0]!.body);
    const textBlocks = stored.report.blocks.filter((b: { type: string }) => b.type === 'text');
    expect(textBlocks).toHaveLength(1);
    expect(textBlocks[0].md).toBe('Второ резюме на седмицата.'); // the surviving retry, not the stripped first draft
    expect(stored.provenance.model).not.toBe('none (ai-free fallback)');
    expect(upserts[0]!.status).toBe('ok');
  });

  // A verifier that strips EVERY claim leaves an artifact with no surviving model prose — content
  // identical in kind to the AI-free fallback. It must be labelled as such, or the archive index
  // advertises a model-authored digest whose model text is gone.
  it('verifier strips the whole narrative: artifact is labelled AI-free, not "ok"', async () => {
    const data = happyPathData();
    const upserts: UpsertRow[] = [];
    const puts: PutCall[] = [];

    await generateWeeklyDigest(baseEnv(fakeWeeklyDb(data, upserts), fakeBucket(puts)), {
      now: NOW,
      // Verifier returns no verdicts at all -> parseVerdicts fails closed -> every claim stripped.
      generate: async ({ system }: { system: string; prompt: string }) =>
        system.includes('verification critic')
          ? JSON.stringify({ verdicts: [] })
          : 'Изминалата седмица бе разнообразна за обществените поръчки в страната.',
    });

    expect(puts).toHaveLength(1);
    const stored = JSON.parse(puts[0]!.body);
    expect(stored.report.blocks.some((b: { type: string }) => b.type === 'text')).toBe(false);
    expect(stored.provenance.model).toBe('none (ai-free fallback)');
    expect(upserts[0]!.status).toBe('fallback');
  });

  // The verifier runs under a hard timeout (VERIFIER_TIMEOUT_MS); a hung gateway call aborts and THROWS.
  // verifyReport must fail-CLOSED on that throw — strip the unverified prose — never publish it because
  // the judge never answered. Same observable outcome as an empty-verdicts strip, reached via a throw.
  it('verifier throwing (e.g. timeout abort) fails closed: prose stripped, labelled AI-free', async () => {
    const data = happyPathData();
    const upserts: UpsertRow[] = [];
    const puts: PutCall[] = [];

    await generateWeeklyDigest(baseEnv(fakeWeeklyDb(data, upserts), fakeBucket(puts)), {
      now: NOW,
      // Narrative generates fine; the verifier call rejects with an AbortError (what AbortSignal.timeout
      // throws when the budget elapses) on EVERY attempt.
      generate: async ({ system }: { system: string; prompt: string }) => {
        if (system.includes('verification critic')) {
          throw new DOMException('The operation was aborted', 'AbortError');
        }
        return 'Изминалата седмица бе разнообразна за обществените поръчки в страната.';
      },
    });

    expect(puts).toHaveLength(1);
    const stored = JSON.parse(puts[0]!.body);
    expect(stored.report.blocks.some((b: { type: string }) => b.type === 'text')).toBe(false);
    expect(stored.provenance.model).toBe('none (ai-free fallback)');
    expect(upserts[0]!.status).toBe('fallback');
  });

  it('reissue: preserves the original createdAt, stamps refreshedAt, and is „коригирано" (§10.4)', async () => {
    const data = happyPathData();
    data.existingDigestRow = true;
    const upserts: UpsertRow[] = [];
    const puts: PutCall[] = [];
    // Seed a prior artifact with an ORIGINAL publish time so the re-issue can read + preserve it.
    const ORIGINAL_CREATED = '2026-06-01T07:00:00.000Z';
    puts.push({
      key: `weeks/${TARGET.iso}.json`,
      body: JSON.stringify({ createdAt: ORIGINAL_CREATED }),
      opts: undefined,
    });

    await generateWeeklyDigest(baseEnv(fakeWeeklyDb(data, upserts), fakeBucket(puts)), {
      now: NOW,
      generate: mockGenerate('Кратко резюме на седмицата.'),
    });

    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.status).toBe('коригирано');
    // The newest put is the re-issued artifact: original publish time kept, re-issue time recorded.
    const reissued = JSON.parse(puts.at(-1)!.body);
    expect(reissued.createdAt).toBe(ORIGINAL_CREATED);
    expect(reissued.refreshedAt).toBe(NOW.toISOString());
  });

  it('reissue: a prior-artifact READ FAILURE degrades to a first-publish, never aborts the cron', async () => {
    const data = happyPathData();
    data.existingDigestRow = true;
    const upserts: UpsertRow[] = [];
    const puts: PutCall[] = [];
    // Bucket whose get() THROWS (R2 outage) — the reissue path must catch it and fall back to createdAt=now.
    const throwingBucket = {
      put: async (key: string, body: string, opts?: unknown) => {
        puts.push({ key, body, opts });
        return null as unknown as R2Object;
      },
      get: async () => {
        throw new Error('R2 unavailable');
      },
    } as unknown as R2Bucket;

    await generateWeeklyDigest(baseEnv(fakeWeeklyDb(data, upserts), throwingBucket), {
      now: NOW,
      generate: mockGenerate('Кратко резюме на седмицата.'),
    });

    // The run completed (artifact written), the read failure did NOT throw out of the cron.
    expect(puts).toHaveLength(1);
    const stored = JSON.parse(puts[0]!.body);
    expect(stored.createdAt).toBe(NOW.toISOString()); // fell back to now (no prior read)
    expect(upserts[0]!.status).toBe('коригирано'); // still a re-issue per the D1 row
  });

  it('first publish carries no refreshedAt (createdAt = now)', async () => {
    const data = happyPathData(); // no existing row → first publish
    const upserts: UpsertRow[] = [];
    const puts: PutCall[] = [];

    await generateWeeklyDigest(baseEnv(fakeWeeklyDb(data, upserts), fakeBucket(puts)), {
      now: NOW,
      generate: mockGenerate('Кратко резюме на седмицата.'),
    });

    const stored = JSON.parse(puts.at(-1)!.body);
    expect(stored.createdAt).toBe(NOW.toISOString());
    expect(stored.refreshedAt).toBeUndefined();
  });

  it('narrative invalid after every regen attempt: AI-free fallback is persisted, no unbound prose numbers', async () => {
    const data = happyPathData();
    const upserts: UpsertRow[] = [];
    const puts: PutCall[] = [];
    let narrativeCalls = 0;

    await generateWeeklyDigest(baseEnv(fakeWeeklyDb(data, upserts), fakeBucket(puts)), {
      now: NOW,
      generate: async ({ system }: { system: string; prompt: string }) => {
        if (system.includes('verification critic')) {
          return JSON.stringify({ verdicts: [{ id: 'C0', verdict: 'supported' }] });
        }
        narrativeCalls += 1;
        // Always violates guardrail E2 (material number in prose) — every attempt must be rejected.
        return `Разходите достигнаха 5000000 лв. през седмицата.`;
      },
    });

    // Exactly MAX_NARRATIVE_ATTEMPTS narrative calls, never more.
    expect(narrativeCalls).toBe(2);
    expect(puts).toHaveLength(1);
    const stored = JSON.parse(puts[0]!.body);
    // No text block survived — the AI-free fallback carries only the deterministic data blocks plus
    // the fixed methodology callout.
    expect(stored.report.blocks.some((b: { type: string }) => b.type === 'text')).toBe(false);
    expect(stored.report.blocks.at(-1).title).toBe('Как е изчислено');
    expect(stored.provenance.model).toBe('none (ai-free fallback)');
    expect(upserts[0]!.status).toBe('fallback');

    // Re-scan every prose surface (title + callout) for a material number — the fallback report must
    // contain none (mirrors report-schema.ts's own gate, applied here as an end-to-end assertion).
    const proseNumberPattern =
      /\d{5,}|млн|млрд|хил\.?|%|\d[\d.,\s]{0,40}(?:€|лв\.?|eur|евро|лева)/iu;
    expect(proseNumberPattern.test(stored.report.title)).toBe(false);
    for (const block of stored.report.blocks) {
      if (block.type === 'text' || block.type === 'callout') {
        expect(proseNumberPattern.test(block.md ?? '')).toBe(false);
        if (block.title) expect(proseNumberPattern.test(block.title)).toBe(false);
      }
    }
  });

  it('narrative call throwing every attempt: falls back the same as a rejected narrative', async () => {
    const data = happyPathData();
    const upserts: UpsertRow[] = [];
    const puts: PutCall[] = [];

    await generateWeeklyDigest(baseEnv(fakeWeeklyDb(data, upserts), fakeBucket(puts)), {
      now: NOW,
      generate: async ({ system }: { system: string; prompt: string }) => {
        if (system.includes('verification critic')) {
          return JSON.stringify({ verdicts: [{ id: 'C0', verdict: 'supported' }] });
        }
        throw new Error('gateway timeout');
      },
    });

    expect(puts).toHaveLength(1);
    const stored = JSON.parse(puts[0]!.body);
    expect(stored.report.blocks.some((b: { type: string }) => b.type === 'text')).toBe(false);
  });

  it('narrative trimming to empty every attempt: logs a distinct event and falls back (not silent)', async () => {
    const data = happyPathData();
    const upserts: UpsertRow[] = [];
    const puts: PutCall[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await generateWeeklyDigest(baseEnv(fakeWeeklyDb(data, upserts), fakeBucket(puts)), {
        now: NOW,
        generate: async ({ system }: { system: string; prompt: string }) => {
          if (system.includes('verification critic')) {
            return JSON.stringify({ verdicts: [{ id: 'C0', verdict: 'supported' }] });
          }
          return '   \n  '; // whitespace-only — trims to empty, must not be silently indistinguishable
        },
      });

      const events = logSpy.mock.calls
        .map((c) => {
          try {
            return JSON.parse(String(c[0])).event as string;
          } catch {
            return '';
          }
        })
        .filter(Boolean);
      // The empty-after-trim branch fires its own event (once per attempt), never the throw/reject ones.
      expect(events.filter((e) => e === 'etl_digest_narrative_empty')).toHaveLength(2);
      expect(events).not.toContain('etl_digest_narrative_call_failed');
      expect(events).not.toContain('etl_digest_narrative_rejected');
    } finally {
      logSpy.mockRestore();
    }

    // Still fails safe: AI-free fallback persisted, no model prose.
    expect(puts).toHaveLength(1);
    const stored = JSON.parse(puts[0]!.body);
    expect(stored.report.blocks.some((b: { type: string }) => b.type === 'text')).toBe(false);
    expect(stored.provenance.model).toBe('none (ai-free fallback)');
  });
});
