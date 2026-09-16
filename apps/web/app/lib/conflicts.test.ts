import { describe, expect, it } from 'vitest';
import type { ConflictContract, ConflictLink } from '@sigma/api-contract';
import {
  companyProfileHref,
  conflictListFilters,
  contractHref,
  declaredStakeNoun,
  filterConflictRows,
  groupByPerson,
  groupDeclaredInstitutions,
  institutionOptions,
  officialHref,
  officialRole,
  sortConflictRows,
  type ConflictPersonRow,
} from './conflicts';

function link(over: Partial<ConflictLink> = {}): ConflictLink {
  return {
    linkKey: 'person:a|111',
    officialSlug: 'c2VydA',
    official: 'Иван Минев',
    institution: 'Община Русе',
    company: 'ТЕСТ ГРУП ХОЛД АД',
    eik: '111',
    relation: 'owns',
    contemporaneous: true,
    ownInstitution: false,
    firstDeclaredYear: '2019',
    lastDeclaredYear: '2023',
    contractCount: 35,
    contractValueEur: 88_000_000,
    contemporaneousContractCount: 20,
    contemporaneousValueEur: 40_000_000,
    firstContractYear: '2021',
    lastContractYear: '2024',
    sourceUrl: 'https://register.cacbg.bg/2024/x.xml',
    // #279: a link only reaches the DTO when its identity rests on a Trade Register fact.
    evidenceKind: 'document',
    registryRole: 'owner',
    registryEntryNumber: '20110502101007',
    registryEntryDate: '2011-05-02',
    registryLookupDate: '2026-08-05',
    position: null,
    sourceYear: null,
    ...over,
  };
}

function contract(over: Partial<ConflictContract> = {}): ConflictContract {
  return {
    contractSlug: 'e:abc123',
    signedAt: '2021-05-01',
    authority: 'Община Пловдив',
    authorityId: 'a:plovdiv',
    authorityTotalEur: 10_000_000,
    contractKind: 'Услуги',
    procedureType: 'открита процедура',
    subject: 'Ремонт на общински път',
    contractNumber: 'Д-1',
    amountEur: 1_000_000,
    temporal: 'contemporaneous',
    ...over,
  };
}

describe('href builders', () => {
  it('point at the conflict + company routes', () => {
    expect(officialHref('c2VydA')).toBe('/persons/c2VydA');
    expect(companyProfileHref('111')).toBe('/companies/111');
  });
});

describe('contract list helpers', () => {
  it('contractHref points at the contract detail page', () => {
    expect(contractHref(contract({ contractSlug: 'e:abc123' }))).toBe('/contracts/e:abc123');
  });
});

describe('groupByPerson', () => {
  it('combines institutions only through proven registry identity and uses the union of their windows', () => {
    const first = link({
      officialSlug: 'a',
      registryPersonId: 'registry-person',
      contemporaneousValueEur: 60,
      personCompanyValueEur: 120,
      laterDeclarationYear: '2025',
    });
    const second = link({
      officialSlug: 'b',
      registryPersonId: 'registry-person',
      contemporaneousValueEur: 80,
      personCompanyValueEur: 120,
    });
    const grouped = groupByPerson([first, second]);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].contemporaneousValueEur).toBe(120);
    expect(grouped[0].contractCount).toBe(first.contractCount);
    // Identical names are insufficient evidence of one human.
    expect(groupByPerson([first, { ...second, registryPersonId: null }])).toHaveLength(2);
  });
  // Collapses per-relationship links into one row per PERSON for the /conflicts leaderboard (#287). The DB
  // returns links NEXUS-sorted, but the helper must be correct for ANY input order — it computes the
  // strongest link explicitly and sorts rows itself.

  it('collapses N links for one person into a single row, naming the person once', () => {
    // Same officialSlug, three DISTINCT winners → one row (not three cards). The person appears once.
    const rows = groupByPerson([
      link({ linkKey: 'p:a|1', officialSlug: 'a', official: 'Иван Минев', eik: '1' }),
      link({ linkKey: 'p:a|2', officialSlug: 'a', official: 'Иван Минев', eik: '2' }),
      link({ linkKey: 'p:a|3', officialSlug: 'a', official: 'Иван Минев', eik: '3' }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].officialSlug).toBe('a');
    expect(rows[0].official).toBe('Иван Минев');
    expect(rows[0].companyCount).toBe(3);
  });

  it('ranks by the STRONGEST single link, so a strong+weak person outranks a medium-only person', () => {
    // Person A: one STRONG link (own-institution) + one WEAK link (nothing). Person B: one MEDIUM link
    // (has a contemporaneous window, but not own-institution). By strongest-link NEXUS_ORDER, A > B.
    // A naive per-link or flag-OR sort that let A's weak link drag it down would sink A below B — this
    // must go red if the sort becomes per-link rather than strongest-link.
    const rows = groupByPerson([
      // B first in input so a stable/pre-sorted assumption can't accidentally pass the test.
      link({
        linkKey: 'p:b|9',
        officialSlug: 'b',
        official: 'Бета',
        eik: '9',
        ownInstitution: false,
        contemporaneousContractCount: 4,
        contemporaneousValueEur: 3_000_000,
      }),
      link({
        linkKey: 'p:a|weak',
        officialSlug: 'a',
        official: 'Алфа',
        eik: '7',
        ownInstitution: false,
        contemporaneousContractCount: 0,
        contemporaneousValueEur: null,
      }),
      link({
        linkKey: 'p:a|strong',
        officialSlug: 'a',
        official: 'Алфа',
        eik: '8',
        ownInstitution: true,
        contemporaneousContractCount: 1,
        contemporaneousValueEur: 100,
      }),
    ]);
    expect(rows.map((r) => r.officialSlug)).toEqual(['a', 'b']);
    // A's strongest link is own-institution → its rank flag is set; the weak second link does not sink it.
    expect(rows[0].ownInstitution).toBe(true);
  });

  it('does not let two weak links out-rank one strong link (rank ≠ OR-ed flags)', () => {
    // Person C has TWO links: one own-institution (no window), one in-window (no own-institution) — so BOTH
    // row flags are true by OR, yet NEITHER single link carries both. Person D has ONE link that carries both.
    // Correct rank compares the strongest SINGLE link: D's [own+window] dominates either of C's by the FLAG
    // hierarchy (own-institution first, then any-window), independent of €. The buggy rank (from OR-ed row
    // flags) would tie C and D on flags [1,1] and fall to the row's summed window € — so C's window € is set
    // ABOVE D's on purpose: under the bug C would sort FIRST (wrong), so asserting ['d','c'] catches it. The
    // earlier fixture used C-window 1M < D 9M, where the € tiebreak ordered D first under BOTH schemes and the
    // mutation survived (niki #312 HIGH 3).
    const rows = groupByPerson([
      link({
        linkKey: 'p:c|own',
        officialSlug: 'c',
        official: 'Цета',
        eik: '1',
        ownInstitution: true,
        contemporaneousContractCount: 0,
        contemporaneousValueEur: null,
      }),
      link({
        linkKey: 'p:c|window',
        officialSlug: 'c',
        official: 'Цета',
        eik: '2',
        ownInstitution: false,
        contemporaneousContractCount: 5,
        contemporaneousValueEur: 20_000_000, // deliberately ABOVE D's window € — the discriminating value
      }),
      link({
        linkKey: 'p:d|both',
        officialSlug: 'd',
        official: 'Делта',
        eik: '3',
        ownInstitution: true,
        contemporaneousContractCount: 9,
        contemporaneousValueEur: 9_000_000,
      }),
    ]);
    // Strongest-single-link rank → D leads despite C's larger summed window €; an OR-flag rank would put C
    // first. The person-level window € proves the tiebreak did NOT decide the order.
    expect(rows.map((r) => r.officialSlug)).toEqual(['d', 'c']);
    expect(rows[0].contemporaneousValueEur).toBe(9_000_000); // D
    expect(rows[1].contemporaneousValueEur).toBe(20_000_000); // C — larger €, yet ranked second
  });

  it('dedupes public funds per ЕИК: a duplicate-ЕИК link does not double the sum', () => {
    // Two links on the SAME winner (same ЕИК) for one person — total € is company-level (constant within a
    // ЕИК) so it counts once; the window € is a per-link subset so the MAX is taken. Plus a second distinct
    // winner to prove distinct ЕИК DO add.
    const rows = groupByPerson([
      link({
        linkKey: 'p:a|111self',
        officialSlug: 'a',
        eik: '111',
        contractValueEur: 88_000_000,
        contemporaneousValueEur: 40_000_000,
      }),
      link({
        linkKey: 'p:a|111fam',
        officialSlug: 'a',
        eik: '111',
        contractValueEur: 88_000_000,
        contemporaneousValueEur: 25_000_000,
      }),
      link({
        linkKey: 'p:a|222',
        officialSlug: 'a',
        eik: '222',
        contractValueEur: 10_000_000,
        contemporaneousValueEur: 5_000_000,
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].contractValueEur).toBe(98_000_000); // 88M once + 10M — NOT 88 + 88 + 10
    expect(rows[0].contemporaneousValueEur).toBe(45_000_000); // max(40M, 25M) for ЕИК 111 + 5M
    expect(rows[0].companyCount).toBe(2); // two distinct winners, despite three links
  });

  it('companyCount counts distinct ЕИК (3 → count); soleCompany carries the name when it is 1', () => {
    const three = groupByPerson([
      link({ linkKey: 'p:a|1', officialSlug: 'a', eik: '1' }),
      link({ linkKey: 'p:a|2', officialSlug: 'a', eik: '2' }),
      link({ linkKey: 'p:a|3', officialSlug: 'a', eik: '3' }),
    ]);
    expect(three[0].companyCount).toBe(3);
    expect(three[0].soleCompany).toBeNull(); // >1 winner → no single name to carry

    const one = groupByPerson([
      link({
        linkKey: 'p:a|9',
        officialSlug: 'a',
        eik: '999',
        company: 'ТЕСТ ГРУП ХОЛД АД',
      }),
    ]);
    expect(one[0].companyCount).toBe(1);
    expect(one[0].soleCompany).toEqual({ company: 'ТЕСТ ГРУП ХОЛД АД', eik: '999' });
  });

  it('sets a признак flag sourced only from a SECOND link', () => {
    // The strongest (first) link carries neither flag; a weaker second link carries both. The OR-ed row
    // flags must still be true — a flag on any link surfaces on the row, even one that is not the strongest.
    const rows = groupByPerson([
      link({
        linkKey: 'p:a|lead',
        officialSlug: 'a',
        eik: '1',
        ownInstitution: false,
        contemporaneousContractCount: 0,
      }),
      link({
        linkKey: 'p:a|second',
        officialSlug: 'a',
        eik: '2',
        ownInstitution: true,
        contemporaneousContractCount: 3,
      }),
    ]);
    expect(rows[0].ownInstitution).toBe(true);
    expect(rows[0].hasContemporaneous).toBe(true);
  });

  it('sums contractCount null-guarded — a null/0-contract link never yields NaN', () => {
    const rows = groupByPerson([
      link({ linkKey: 'p:a|1', officialSlug: 'a', eik: '1', contractCount: 5 }),
      // TS types contractCount as number, but a malformed row could arrive null; the guard must hold.
      link({
        linkKey: 'p:a|2',
        officialSlug: 'a',
        eik: '2',
        contractCount: null as unknown as number,
      }),
      link({ linkKey: 'p:a|3', officialSlug: 'a', eik: '3', contractCount: 0 }),
    ]);
    expect(rows[0].contractCount).toBe(5);
    expect(Number.isNaN(rows[0].contractCount)).toBe(false);
  });

  it('dedupes contractCount per ЕИК too — a duplicate-ЕИК link never doubles the count (guardian symmetry)', () => {
    // contract_count is a company-level winner total (constant within a ЕИК), so two links on the SAME ЕИК must
    // count it ONCE — mirroring the money dedup, not a raw link sum (niki #312 MEDIUM 7). Plus a second winner
    // to prove distinct ЕИК DO add.
    const rows = groupByPerson([
      link({ linkKey: 'p:a|111a', officialSlug: 'a', eik: '111', contractCount: 35 }),
      link({ linkKey: 'p:a|111b', officialSlug: 'a', eik: '111', contractCount: 35 }),
      link({ linkKey: 'p:a|222', officialSlug: 'a', eik: '222', contractCount: 4 }),
    ]);
    expect(rows[0].contractCount).toBe(39); // 35 once + 4 — NOT 35 + 35 + 4
  });

  it('is empty for empty input', () => {
    expect(groupByPerson([])).toEqual([]);
  });

  it('keeps namesakes apart: same name, different institution → two rows (group key is person id, not name)', () => {
    // The group key is officialSlug (= personSlug(person_id) = key(name)|key(institution), ADR-0026), NOT the
    // display name — institution is the namesake disambiguator (api-contract). A mutation grouping by `official`
    // would collapse these two distinct office-holders into one row (merging their winners and money under one
    // name). Guard it explicitly: same name, different slug/institution ⇒ two rows (niki #312 MEDIUM 7c).
    const rows = groupByPerson([
      link({
        linkKey: 'p:ivanov-sofia|1',
        officialSlug: 'ivanov-sofia',
        official: 'Иван Иванов',
        institution: 'Община София',
        eik: '111',
      }),
      link({
        linkKey: 'p:ivanov-varna|2',
        officialSlug: 'ivanov-varna',
        official: 'Иван Иванов',
        institution: 'Община Варна',
        eik: '222',
      }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.officialSlug).sort()).toEqual(['ivanov-sofia', 'ivanov-varna']);
    expect(rows.map((r) => r.institution).sort()).toEqual(['Община Варна', 'Община София']);
  });

  it('carries a family link into the row without exposing any relative identity', () => {
    // A family stake (relation 'related', ADR-0032) folds into the person's counts and money exactly like a
    // self stake — but the row must expose ONLY the official, never the свързано лице. Assert the row shape
    // carries no relative-identity field and the values include the family link's contribution.
    const rows = groupByPerson([
      link({
        linkKey: 'p:a|self',
        officialSlug: 'a',
        official: 'Иван Минев',
        eik: '111',
        relation: 'owns',
        contractCount: 4,
        contractValueEur: 10_000_000,
      }),
      link({
        linkKey: 'p:a|family',
        officialSlug: 'a',
        official: 'Иван Минев',
        eik: '222',
        relation: 'related',
        contractCount: 2,
        contractValueEur: 3_000_000,
      }),
    ]);
    expect(rows).toHaveLength(1);
    // The family link contributed: 2 winners, both contract counts and both € summed.
    expect(rows[0].companyCount).toBe(2);
    expect(rows[0].contractCount).toBe(6);
    expect(rows[0].contractValueEur).toBe(13_000_000);
    // Anonymity: the row shape has ONLY the official's own identity — no relation/relative field of any kind.
    // `stakeKind` is an identity-free enum ('self'|'family'|'mixed'), never a relative name or relationship type.
    expect(rows[0].official).toBe('Иван Минев');
    expect(rows[0].stakeKind).toBe('mixed'); // one own + one family link
    expect(Object.keys(rows[0]).sort()).toEqual(
      [
        'companyCount',
        'companies',
        'contemporaneousValueEur',
        'contractCount',
        'contractValueEur',
        'hasContemporaneous',
        'declaredInstitutions',
        'personIdentity',
        'institution',
        'official',
        'officialSlug',
        'ownInstitution',
        'position',
        'soleCompany',
        'stakeKind',
      ].sort(),
    );
  });

  it('stakeKind: family only when EVERY link is a relative stake; null money stays null (not 0)', () => {
    // family-only person → 'family'; and with no summable € on any winner the row money is NULL, so the cell
    // renders „—" like the per-link card, not a fabricated „0" (niki #312 MEDIUM 1 + MEDIUM 3).
    const family = groupByPerson([
      link({
        linkKey: 'p:f|1',
        officialSlug: 'f',
        relation: 'related',
        eik: '1',
        contractValueEur: null,
        contemporaneousValueEur: null,
        contemporaneousContractCount: 0,
      }),
    ]);
    expect(family[0].stakeKind).toBe('family');
    expect(family[0].contractValueEur).toBeNull();
    expect(family[0].contemporaneousValueEur).toBeNull();

    // self-only person → 'self'
    const self = groupByPerson([link({ linkKey: 'p:s|1', officialSlug: 's', relation: 'owns' })]);
    expect(self[0].stakeKind).toBe('self');
  });

  it('preserves the window-null case instead of fabricating a zero amount', () => {
    const rows = groupByPerson([
      link({
        linkKey: 'p:a|1',
        officialSlug: 'a',
        eik: '1',
        contemporaneousContractCount: 3,
        contemporaneousValueEur: null,
        contractValueEur: 88_000_000,
      }),
    ]);
    expect(rows[0].hasContemporaneous).toBe(true);
    expect(rows[0].contemporaneousValueEur).toBeNull();
    expect(rows[0].contractValueEur).toBe(88_000_000);
  });
});

describe('declaredStakeNoun — page prose must not out-claim the cards', () => {
  const self = { relation: 'owns' };
  const family = { relation: 'related' };

  it('says „собствен дял" only when every link really is the official\'s own', () => {
    expect(declaredStakeNoun([self])).toBe('собствен дял');
    expect(declaredStakeNoun([self, { relation: 'partner' }])).toBe('собствен дял');
    expect(declaredStakeNoun([])).toBe('собствен дял'); // no links → nothing to qualify
  });

  it('says „дял на свързано лице" on a family-only page', () => {
    // Asserting an OWN stake above cards that read „свързано лице" is a false claim about a named
    // individual — the second source of truth this function exists to remove.
    expect(declaredStakeNoun([family])).toBe('дял на свързано лице');
    expect(declaredStakeNoun([family, family])).toBe('дял на свързано лице');
  });

  it('falls back to the neutral wording on a MIXED page, the only phrasing true of every card', () => {
    // Either single-sided noun would be false about half the cards on the page.
    const mixed = 'деклариран дял — собствен или на свързано лице';
    expect(declaredStakeNoun([self, family])).toBe(mixed);
    expect(declaredStakeNoun([family, self])).toBe(mixed); // order must not decide the claim
  });
});

describe('officialRole', () => {
  it('says who the official is — position and institution, in that order', () => {
    expect(officialRole({ position: 'Кмет', institution: 'Община Ямбол' })).toBe(
      'Кмет · Община Ямбол',
    );
  });

  it('keeps whichever one is on record, and says nothing when neither is', () => {
    expect(officialRole({ position: null, institution: 'Община Ямбол' })).toBe('Община Ямбол');
    expect(officialRole({ position: ' Кмет ', institution: '' })).toBe('Кмет');
    expect(officialRole({ position: null, institution: null })).toBeNull();
  });
});

describe('/conflicts list filters', () => {
  it('keeps each declared institution searchable and filterable without inventing continuous years', () => {
    const offices = [
      { institution: 'Община Русе', position: 'Съветник', year: '2019' },
      { institution: 'ОБЩИНА РУСЕ', position: 'Съветник', year: '2021' },
      { institution: 'Народно събрание', position: 'Народен представител', year: '2025' },
    ];
    const institutions = groupDeclaredInstitutions(offices);
    expect(institutions).toHaveLength(2);
    expect(institutions.find((i) => i.institution === 'Община Русе')?.years).toEqual([
      '2019',
      '2021',
    ]);
    const rows = groupByPerson([link({ declaredOffices: offices })]);
    expect(
      filterConflictRows(rows, conflictListFilters(new URLSearchParams('institution=Община Русе'))),
    ).toHaveLength(1);
    expect(
      filterConflictRows(rows, conflictListFilters(new URLSearchParams('q=Народен представител'))),
    ).toHaveLength(1);
    expect(
      institutionOptions(rows, [])
        .map((i) => i.value)
        .sort(),
    ).toEqual(['НАРОДНО СЪБРАНИЕ', 'ОБЩИНА РУСЕ']);
  });
  const row = (over: Partial<ConflictPersonRow>): ConflictPersonRow => ({
    official: 'Иван Минев',
    officialSlug: 'a',
    institution: 'Община Русе',
    position: 'Кмет',
    companyCount: 1,
    soleCompany: null,
    contractCount: 1,
    contractValueEur: 100,
    contemporaneousValueEur: null,
    stakeKind: 'self',
    ownInstitution: false,
    hasContemporaneous: false,
    ...over,
  });
  const sp = (qs: string) => new URLSearchParams(qs);

  it('reads the state from the URL and drops what it does not know', () => {
    expect(
      conflictListFilters(
        sp('stake=family&signal=own&signal=bogus&institution=Община Русе&sort=total&q= Иван '),
      ),
    ).toEqual({
      stake: 'family',
      signals: ['own'],
      institutions: ['ОБЩИНА РУСЕ'],
      sort: 'total',
      q: 'Иван',
    });
    expect(conflictListFilters(sp('stake=x&sort=y'))).toEqual({
      stake: null,
      signals: [],
      institutions: [],
      sort: 'period',
      q: null,
    });
  });

  it('lets a person with both kinds of stake answer both stake filters', () => {
    const rows = [
      row({ officialSlug: 's' }),
      row({ officialSlug: 'f', stakeKind: 'family' }),
      row({ officialSlug: 'm', stakeKind: 'mixed' }),
    ];
    const slugs = (qs: string) =>
      filterConflictRows(rows, conflictListFilters(sp(qs))).map((r) => r.officialSlug);
    expect(slugs('stake=self')).toEqual(['s', 'm']);
    expect(slugs('stake=family')).toEqual(['f', 'm']);
    expect(slugs('')).toEqual(['s', 'f', 'm']);
  });

  it('requires every chosen signal', () => {
    const rows = [
      row({ officialSlug: 'o', ownInstitution: true }),
      row({ officialSlug: 'w', hasContemporaneous: true }),
      row({ officialSlug: 'b', ownInstitution: true, hasContemporaneous: true }),
    ];
    const slugs = (qs: string) =>
      filterConflictRows(rows, conflictListFilters(sp(qs))).map((r) => r.officialSlug);
    expect(slugs('signal=own')).toEqual(['o', 'b']);
    expect(slugs('signal=own&signal=window')).toEqual(['b']);
  });

  it('filters by the official’s institution whatever its spelling, and searches name, position and institution', () => {
    const rows = [
      row({ officialSlug: 'r', institution: 'ОБЩИНА РУСЕ' }),
      row({
        officialSlug: 'v',
        official: 'Петя Колева',
        institution: 'Община Варна',
        position: 'Общински съветник',
      }),
    ];
    const slugs = (qs: string) =>
      filterConflictRows(rows, conflictListFilters(sp(qs))).map((r) => r.officialSlug);
    expect(slugs('institution=Община Русе')).toEqual(['r']);
    expect(slugs('q=петя')).toEqual(['v']);
    expect(slugs('q=съветник')).toEqual(['v']);
    expect(slugs('q=варна')).toEqual(['v']);
  });

  it('sorts independently by period value, total value, or contract count', () => {
    const rows = [
      row({ officialSlug: 'a', contractValueEur: 900, contractCount: 9 }),
      row({
        officialSlug: 'b',
        contractValueEur: 5_000,
        contractCount: 1,
        hasContemporaneous: true,
        contemporaneousValueEur: 100,
      }),
      row({
        officialSlug: 'c',
        contractValueEur: 900,
        contractCount: 2,
        hasContemporaneous: true,
        contemporaneousValueEur: 300,
      }),
      row({ officialSlug: 'd', contractValueEur: 500, contractCount: 10 }),
    ];
    expect(sortConflictRows(rows, 'period').map((r) => r.officialSlug)).toEqual([
      'c',
      'b',
      'a',
      'd',
    ]);
    expect(sortConflictRows(rows, 'total').map((r) => r.officialSlug)).toEqual([
      'b',
      'a',
      'c',
      'd',
    ]);
    expect(sortConflictRows(rows, 'contracts').map((r) => r.officialSlug)).toEqual([
      'd',
      'a',
      'c',
      'b',
    ]);
  });

  it('offers the institutions by how many officials each carries, under the most common spelling, keeping a selected one', () => {
    const rows = [
      row({ officialSlug: '1', institution: 'Община Русе' }),
      row({ officialSlug: '2', institution: 'Община Русе' }),
      row({ officialSlug: '3', institution: 'ОБЩИНА РУСЕ' }),
      row({ officialSlug: '4', institution: 'Община Варна' }),
      row({ officialSlug: '5', institution: null }),
    ];
    expect(institutionOptions(rows, [])).toEqual([
      { value: 'ОБЩИНА РУСЕ', label: 'Община Русе', count: 3 },
      { value: 'ОБЩИНА ВАРНА', label: 'Община Варна', count: 1 },
    ]);
    expect(institutionOptions(rows, ['ОБЩИНА ВАРНА'], 1).map((o) => o.value)).toEqual([
      'ОБЩИНА РУСЕ',
      'ОБЩИНА ВАРНА',
    ]);
  });
});

it('sorts period values and keeps unknown amounts last', () => {
  const rows = groupByPerson([
    link({ officialSlug: 'a' }),
    link({ officialSlug: 'b' }),
    link({ officialSlug: 'c' }),
  ]);
  Object.assign(rows.find((r) => r.officialSlug === 'a')!, {
    contemporaneousValueEur: null,
    hasContemporaneous: true,
  });
  Object.assign(rows.find((r) => r.officialSlug === 'b')!, {
    contemporaneousValueEur: 0,
    hasContemporaneous: true,
  });
  Object.assign(rows.find((r) => r.officialSlug === 'c')!, {
    contemporaneousValueEur: 100,
    hasContemporaneous: true,
  });
  expect(conflictListFilters(new URLSearchParams('sort=period-contracts')).sort).toBe('period');
  expect(sortConflictRows(rows, 'period').map((r) => r.officialSlug)).toEqual(['c', 'b', 'a']);
});

it('reads the registry-role stake filter and keeps registry rows out of the own/family counts', () => {
  expect(conflictListFilters(new URLSearchParams('stake=registry')).stake).toBe('registry');
  const registry = {
    ...groupByPerson([link()])[0]!,
    stakeKind: 'registry' as const,
    officialSlug: 'reg',
  };
  const own = groupByPerson([link()])[0]!;
  const f = (stake: 'self' | 'family' | 'registry' | null) =>
    filterConflictRows([own, registry], {
      ...conflictListFilters(new URLSearchParams()),
      stake,
    }).map((r) => r.officialSlug);
  expect(f('registry')).toEqual(['reg']);
  expect(f('self')).toEqual([own.officialSlug]);
  expect(f(null)).toEqual([own.officialSlug, 'reg']);
});
