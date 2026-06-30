// Detail pages — scoped to a single entity, so a GROUP BY here is cheap (indexed on bidder_id /
// authority_id / tender_id). Each assembles a rich DTO: headline facts, breakdowns (Откъде печели /
// Топ изпълнители, Как купува/печели, Какво купува), the value timeline + lots, and cross-links.

import type {
  AuthorityDetail,
  AuthorityShare,
  BidDistribution,
  CompanyDetail,
  CompanyShare,
  ConsortiumParticipant,
  ContractDetail,
  ContractLotRow,
  ContractParty,
  ContractRecord,
  ContractValueTimeline,
  OwnershipKind,
  ProcedureSlice,
  SectorSpend,
} from '@sigma/api-contract';
import { CPV_SECTORS, PROCEDURE_GROUPS, procedureGroup } from '@sigma/config';
import { cleanName, entityName, parseConsortiumMembers } from '@sigma/shared';
import { listContracts } from './contracts';
import { authoritySlug, companySlug, contractSlug } from './identity';
import { typeLabel } from './rows';
import { sectorRef } from './sectors';

const PEG = 1.95583;

/** Native value -> EUR (peg for BGN, identity for EUR, FX rate for foreign currencies). */
function eurFromNative(
  v: number | null,
  currency: string | null,
  fxRate: number | null = null,
): number | null {
  if (v == null) return null;
  const c = currency || 'BGN';
  if (c === 'EUR') return v;
  if (c === 'BGN') return v / PEG;
  return fxRate == null ? null : v * fxRate;
}

interface ProcRow {
  procedure_type: string;
  n: number;
  eur: number;
}

/** Fold scoped per-procedure_type counts into the 7 config groups → StackedBar slices. */
function toProcedureMix(rows: ProcRow[]): ProcedureSlice[] {
  const total = rows.reduce((s, r) => s + (r.eur ?? 0), 0);
  const byGroup = new Map<string, { contracts: number; valueEur: number }>();
  for (const r of rows) {
    const g = procedureGroup(r.procedure_type).key;
    const cur = byGroup.get(g) ?? { contracts: 0, valueEur: 0 };
    cur.contracts += r.n;
    cur.valueEur += r.eur ?? 0;
    byGroup.set(g, cur);
  }
  const out: ProcedureSlice[] = [];
  for (const g of PROCEDURE_GROUPS) {
    const agg = byGroup.get(g.key);
    if (!agg || agg.valueEur <= 0) continue;
    out.push({
      key: g.key,
      label: g.label,
      color: g.color,
      competitive: g.competitive,
      contracts: agg.contracts,
      valueEur: agg.valueEur,
      sharePct: total > 0 ? agg.valueEur / total : 0,
    });
  }
  return out;
}

// ── Company ───────────────────────────────────────────────────────────────────────────────────

interface CompanyTotalsFull {
  bidder_id: string;
  name: string;
  kind: 'company' | 'consortium';
  ownership_kind: OwnershipKind | null;
  eik: string | null;
  eik_valid: number;
  settlement: string | null;
  won_eur: number;
  contracts: number;
  authorities: number;
  primary_sector: string | null;
  eu_eur: number;
  first_date: string | null;
  last_date: string | null;
}

export async function getCompany(db: D1Database, bidderId: string): Promise<CompanyDetail | null> {
  const row = await db
    .prepare(`SELECT * FROM company_totals WHERE bidder_id = ?`)
    .bind(bidderId)
    .first<CompanyTotalsFull>();
  if (!row) return null;

  const [bidderMeta, extra, topAuth, procRows, bidsRow, suspectRow, top, recent] =
    await Promise.all([
      db
        .prepare(
          `SELECT b.legal_form, n.nuts3_name AS region FROM bidders b
         LEFT JOIN nuts_regions n ON n.nuts3 = b.nuts WHERE b.id = ?`,
        )
        .bind(bidderId)
        .first<{ legal_form: string | null; region: string | null }>(),
      db
        .prepare(
          `SELECT SUM(CASE WHEN substr(t.cpv_code,1,2) = ? THEN c.amount_eur ELSE 0 END) AS primary_eur,
                AVG(c.bids_received) AS avg_bids
         FROM contracts c JOIN tenders t ON t.id = c.tender_id
         WHERE c.bidder_id = ? AND c.amount_eur IS NOT NULL`,
        )
        .bind(row.primary_sector ?? '', bidderId)
        .first<{ primary_eur: number | null; avg_bids: number | null }>(),
      db
        .prepare(
          `SELECT t.authority_id, a.name, SUM(c.amount_eur) AS paid, COUNT(*) AS n
         FROM contracts c JOIN tenders t ON t.id = c.tender_id JOIN authorities a ON a.id = t.authority_id
         WHERE c.bidder_id = ? AND c.amount_eur IS NOT NULL
         GROUP BY t.authority_id ORDER BY paid DESC LIMIT 6`,
        )
        .bind(bidderId)
        .all<{ authority_id: string; name: string; paid: number; n: number }>(),
      db
        .prepare(
          `SELECT t.procedure_type, COUNT(*) AS n, SUM(c.amount_eur) AS eur
         FROM contracts c JOIN tenders t ON t.id = c.tender_id
         WHERE c.bidder_id = ? AND c.amount_eur IS NOT NULL GROUP BY t.procedure_type`,
        )
        .bind(bidderId)
        .all<ProcRow>(),
      db
        .prepare(
          `SELECT SUM(CASE WHEN bids_received = 1 THEN 1 ELSE 0 END) AS one,
                SUM(CASE WHEN bids_received = 2 THEN 1 ELSE 0 END) AS two,
                SUM(CASE WHEN bids_received = 3 THEN 1 ELSE 0 END) AS three,
                SUM(CASE WHEN bids_received >= 4 THEN 1 ELSE 0 END) AS four_plus,
                SUM(CASE WHEN bids_received IS NULL THEN 1 ELSE 0 END) AS unknown
         FROM contracts WHERE bidder_id = ? AND amount_eur IS NOT NULL`,
        )
        .bind(bidderId)
        .first<{ one: number; two: number; three: number; four_plus: number; unknown: number }>(),
      db
        .prepare(`SELECT COUNT(*) AS n FROM contracts WHERE bidder_id = ? AND amount_eur IS NULL`)
        .bind(bidderId)
        .first<{ n: number }>(),
      listContracts(db, { bidder: companySlug(bidderId), sort: 'value-desc', pageSize: 7 }),
      listContracts(db, { bidder: companySlug(bidderId), sort: 'date-desc', pageSize: 7 }),
    ]);

  const topAuthorities: AuthorityShare[] = topAuth.results.map((a) => ({
    slug: authoritySlug(a.authority_id),
    name: cleanName(a.name),
    paidEur: a.paid,
    contracts: a.n,
    sharePct: row.won_eur > 0 ? a.paid / row.won_eur : 0,
  }));
  const bids: BidDistribution = {
    one: bidsRow?.one ?? 0,
    two: bidsRow?.two ?? 0,
    three: bidsRow?.three ?? 0,
    fourPlus: bidsRow?.four_plus ?? 0,
    unknown: bidsRow?.unknown ?? 0,
  };
  // Surface what we can about consortium membership without TR resolution. Every participant gets
  // eik/resolvedSlug = null in v1; the renderer flags each row as „ЕИК неустановен" so the gap is
  // explicit. For plain companies + single-name consortia the parser returns null and we emit an
  // empty array, which the renderer reads as „hide the section".
  const membership = row.kind === 'consortium' ? parseConsortiumMembers(row.name) : null;
  const participants: ConsortiumParticipant[] =
    membership?.kind === 'list'
      ? membership.members.map((name) => ({ name, eik: null, resolvedSlug: null }))
      : [];
  const membershipNote = membership?.kind === 'prose' ? membership.raw : null;
  const hasEik = row.eik_valid === 1 && Boolean(row.eik);

  return {
    slug: companySlug(bidderId),
    name: cleanName(row.name),
    displayName: entityName(cleanName(row.name), row.kind),
    kind: row.kind,
    isConsortium: row.kind === 'consortium',
    eik: row.eik,
    eikValid: row.eik_valid === 1,
    hasEik,
    ownershipKind: row.ownership_kind,
    settlement: row.settlement,
    region: bidderMeta?.region ?? null,
    legalForm: bidderMeta?.legal_form ?? null,
    wonEur: row.won_eur,
    contracts: row.contracts,
    authorities: row.authorities,
    sector: sectorRef(row.primary_sector),
    sectorSharePct:
      row.won_eur > 0 && extra?.primary_eur != null ? extra.primary_eur / row.won_eur : null,
    euSharePct: row.won_eur > 0 ? row.eu_eur / row.won_eur : 0,
    avgBids: extra?.avg_bids != null ? Math.round(extra.avg_bids * 10) / 10 : null,
    periodFirst: row.first_date,
    periodLast: row.last_date,
    suspect: suspectRow?.n ?? 0,
    topAuthorities,
    moreAuthorities: Math.max(0, row.authorities - topAuthorities.length),
    procedureMix: toProcedureMix(procRows.results),
    bids,
    topContracts: top.items,
    recentContracts: recent.items,
    participants,
    membershipNote,
  };
}

// ── Authority ─────────────────────────────────────────────────────────────────────────────────

interface AuthorityTotalsFull {
  authority_id: string;
  name: string;
  type_group: string | null;
  settlement: string | null;
  region: string | null;
  spent_eur: number;
  contracts: number;
  suppliers: number;
  avg_eur: number;
  primary_sector: string | null;
  eu_eur: number;
  first_date: string | null;
  last_date: string | null;
}

export async function getAuthority(
  db: D1Database,
  authorityId: string,
): Promise<AuthorityDetail | null> {
  const row = await db
    .prepare(`SELECT * FROM authority_totals WHERE authority_id = ?`)
    .bind(authorityId)
    .first<AuthorityTotalsFull>();
  if (!row) return null;

  const [topComp, sectorRows, procRows, bidsRow, suspectRow, recent, top] = await Promise.all([
    db
      .prepare(
        `SELECT c.bidder_id, b.name, b.kind, SUM(c.amount_eur) AS won, COUNT(*) AS n
         FROM contracts c JOIN tenders t ON t.id = c.tender_id JOIN bidders b ON b.id = c.bidder_id
         WHERE t.authority_id = ? AND c.amount_eur IS NOT NULL
         GROUP BY c.bidder_id ORDER BY won DESC LIMIT 7`,
      )
      .bind(authorityId)
      .all<{
        bidder_id: string;
        name: string;
        kind: 'company' | 'consortium';
        won: number;
        n: number;
      }>(),
    db
      .prepare(
        `SELECT substr(t.cpv_code,1,2) AS division, SUM(c.amount_eur) AS eur
         FROM contracts c JOIN tenders t ON t.id = c.tender_id
         WHERE t.authority_id = ? AND c.amount_eur IS NOT NULL AND COALESCE(t.cpv_code,'') <> ''
         GROUP BY division ORDER BY eur DESC`,
      )
      .bind(authorityId)
      .all<{ division: string; eur: number }>(),
    db
      .prepare(
        `SELECT t.procedure_type, COUNT(*) AS n, SUM(c.amount_eur) AS eur
         FROM contracts c JOIN tenders t ON t.id = c.tender_id
         WHERE t.authority_id = ? AND c.amount_eur IS NOT NULL GROUP BY t.procedure_type`,
      )
      .bind(authorityId)
      .all<ProcRow>(),
    db
      .prepare(
        `SELECT AVG(c.bids_received) AS avg_bids FROM contracts c JOIN tenders t ON t.id = c.tender_id
         WHERE t.authority_id = ? AND c.amount_eur IS NOT NULL`,
      )
      .bind(authorityId)
      .first<{ avg_bids: number | null }>(),
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM contracts c JOIN tenders t ON t.id = c.tender_id
         WHERE t.authority_id = ? AND c.amount_eur IS NULL`,
      )
      .bind(authorityId)
      .first<{ n: number }>(),
    listContracts(db, { authority: authoritySlug(authorityId), sort: 'date-desc', pageSize: 6 }),
    listContracts(db, { authority: authoritySlug(authorityId), sort: 'value-desc', pageSize: 6 }),
  ]);

  const topContractors: CompanyShare[] = topComp.results.map((c) => ({
    slug: companySlug(c.bidder_id),
    name: cleanName(c.name),
    displayName: entityName(cleanName(c.name), c.kind),
    kind: c.kind,
    wonEur: c.won,
    contracts: c.n,
    sharePct: row.spent_eur > 0 ? c.won / row.spent_eur : 0,
  }));

  // Sectors: top 6 + a rolled-up „… още CPV категории" tail.
  const allSectors = sectorRows.results
    .map((s) => {
      const ref = sectorRef(s.division);
      return ref ? { ...ref, valueEur: s.eur } : null;
    })
    .filter(
      (x): x is { code: string; label: string; short: string; valueEur: number } => x !== null,
    );
  const top6 = allSectors.slice(0, 6);
  const tailEur = allSectors.slice(6).reduce((sum, s) => sum + s.valueEur, 0);
  const sectors: SectorSpend[] = top6.map((s) => ({
    code: s.code,
    label: s.label,
    short: s.short,
    valueEur: s.valueEur,
    sharePct: row.spent_eur > 0 ? s.valueEur / row.spent_eur : 0,
  }));
  const sectorsOther: SectorSpend | null =
    tailEur > 0
      ? {
          code: '',
          label: '… още CPV категории',
          short: '… още CPV категории',
          valueEur: tailEur,
          sharePct: row.spent_eur > 0 ? tailEur / row.spent_eur : 0,
        }
      : null;

  return {
    slug: authoritySlug(authorityId),
    name: cleanName(row.name),
    eik: authoritySlug(authorityId),
    typeGroup: row.type_group,
    typeLabel: typeLabel(row.type_group),
    settlement: row.settlement,
    region: row.region,
    spentEur: row.spent_eur,
    contracts: row.contracts,
    suppliers: row.suppliers,
    avgEur: row.avg_eur,
    euSharePct: row.spent_eur > 0 ? row.eu_eur / row.spent_eur : 0,
    avgBids: bidsRow?.avg_bids != null ? Math.round(bidsRow.avg_bids * 10) / 10 : null,
    periodFirst: row.first_date,
    periodLast: row.last_date,
    suspect: suspectRow?.n ?? 0,
    topContractors,
    moreContractors: Math.max(0, row.suppliers - topContractors.length),
    sectors,
    sectorsOther,
    procedureMix: toProcedureMix(procRows.results),
    recentContracts: recent.items,
    topContracts: top.items,
  };
}

// ── Contract ──────────────────────────────────────────────────────────────────────────────────

interface ContractDetailRow {
  id: string;
  tender_id: string;
  contract_subject: string | null;
  contract_number: string | null;
  document_number: string | null;
  lot_id: string | null;
  signed_at: string | null;
  published_at: string | null;
  contract_kind: string | null;
  eu_funded: number | null;
  eu_programme: string | null;
  duration_days: number | null;
  amount_eur: number | null;
  signing_value: number | null;
  current_value: number | null;
  fx_rate: number | null;
  signing_value_eur: number | null;
  current_value_eur: number | null;
  value_flag: string;
  date_flag: string;
  bids_received: number | null;
  bids_rejected: number | null;
  bids_sme: number | null;
  bids_non_eea: number | null;
  subcontractor_eik: string | null;
  subcontractor_name: string | null;
  subcontract_value: number | null;
  contract_currency: string;
  // tender
  title: string;
  unp: string;
  procedure_type: string;
  cpv_code: string | null;
  cpv_description: string | null;
  num_lots: number | null;
  tender_awards: number;
  eop_tender_id: string | null;
  estimated_value: number | null;
  tender_currency: string;
  tender_fx_rate: number | null;
  start_date: string | null;
  end_date: string | null;
  // authority
  authority_id: string;
  authority_name: string;
  authority_type_group: string | null;
  authority_settlement: string | null;
  // bidder
  bidder_id: string;
  bidder_name: string;
  bidder_kind: 'company' | 'consortium';
  bidder_eik: string | null;
  bidder_settlement: string | null;
  bidder_legal_form: string | null;
}

export async function getContract(
  db: D1Database,
  contractId: string,
): Promise<(ContractRecord & { bidder_legal_form: string | null }) | null> {
  const r = await db
    .prepare(
      `SELECT c.id, c.tender_id, c.contract_subject, c.contract_number, c.document_number, c.lot_id,
              c.signed_at, c.published_at, c.contract_kind, c.eu_funded, c.eu_programme, c.duration_days,
              c.amount_eur, c.signing_value, c.current_value, c.fx_rate,
              c.signing_value_eur, c.current_value_eur, c.value_flag, c.date_flag,
              c.bids_received, c.bids_rejected, c.bids_sme, c.bids_non_eea,
              c.subcontractor_eik, c.subcontractor_name, c.subcontract_value, c.currency AS contract_currency,
              t.title, t.source_id AS unp, t.procedure_type, t.cpv_code, t.cpv_description, t.num_lots,
              t.eop_tender_id,
              t.estimated_value, t.currency AS tender_currency, t.start_date, t.end_date,
              (SELECT f.eur_per_unit FROM fx_rates f WHERE f.base_currency = t.currency AND f.rate_date = c.signed_at) AS tender_fx_rate,
              t.authority_id, a.name AS authority_name, a.type_group AS authority_type_group,
              a.settlement AS authority_settlement,
              c.bidder_id, b.name AS bidder_name, b.kind AS bidder_kind, b.eik_normalized AS bidder_eik,
              b.settlement AS bidder_settlement, b.legal_form AS bidder_legal_form,
              (SELECT COUNT(*) FROM contracts c2 WHERE c2.tender_id = c.tender_id) AS tender_awards
       FROM contracts c
       JOIN tenders t ON t.id = c.tender_id
       JOIN authorities a ON a.id = t.authority_id
       JOIN bidders b ON b.id = c.bidder_id
       WHERE c.id = ?`,
    )
    .bind(contractId)
    .first<ContractDetailRow>();
  if (!r) return null;

  const [authTotals, compTotals, lotRows] = await Promise.all([
    db
      .prepare(`SELECT spent_eur, contracts FROM authority_totals WHERE authority_id = ?`)
      .bind(r.authority_id)
      .first<{ spent_eur: number; contracts: number }>(),
    db
      .prepare(`SELECT won_eur, contracts, primary_sector FROM company_totals WHERE bidder_id = ?`)
      .bind(r.bidder_id)
      .first<{ won_eur: number; contracts: number; primary_sector: string | null }>(),
    db
      .prepare(
        `SELECT l.id AS lot_id, l.title, l.estimated_value, l.value_currency AS estimated_currency, l.cpv_code,
                c2.id AS contract_id, c2.signing_value_eur,
                (SELECT f.eur_per_unit FROM fx_rates f WHERE f.base_currency = COALESCE(l.value_currency, ?) AND f.rate_date = c2.signed_at) AS estimated_fx_rate,
                b2.name AS bidder_name, b2.kind AS bidder_kind, c2.bidder_id
         FROM lots l
         LEFT JOIN contracts c2 ON c2.lot_id = l.id
         LEFT JOIN bidders b2 ON b2.id = c2.bidder_id
         WHERE l.tender_id = ? ORDER BY l.id`,
      )
      .bind(r.tender_currency, r.tender_id)
      .all<{
        lot_id: string;
        title: string;
        estimated_value: number | null;
        estimated_currency: string | null;
        cpv_code: string | null;
        contract_id: string | null;
        signing_value_eur: number | null;
        estimated_fx_rate: number | null;
        bidder_name: string | null;
        bidder_kind: 'company' | 'consortium' | null;
        bidder_id: string | null;
      }>(),
  ]);

  // value_low values ARE populated (counted in sums) but stay labelled, so include them here so the
  // „стойност с непотвърдена достоверност" note still renders on the tiny/zero-value contracts.
  const suspect =
    r.value_flag === 'value_suspect' ||
    r.value_flag === 'annex_suspect' ||
    r.value_flag === 'review' ||
    r.value_flag === 'value_low';
  const dateSuspect = r.date_flag === 'signed_after_publication';
  const signingEur =
    r.signing_value_eur ?? eurFromNative(r.signing_value, r.contract_currency, r.fx_rate);
  const currentRaw =
    r.current_value_eur ?? eurFromNative(r.current_value, r.contract_currency, r.fx_rate);
  const procedureEstimatedEur = eurFromNative(
    r.estimated_value,
    r.tender_currency,
    r.tender_fx_rate,
  );

  // Lots — only when the prepiska actually has lot rows.
  let lots = null as ContractDetail['lots'];
  let currentLotEstimatedEur = null as number | null;
  if (lotRows.results.length > 0) {
    const seen = new Set<string>();
    const rows: ContractLotRow[] = [];
    let estimatedTotal = 0;
    let signedTotal = 0;
    for (const l of lotRows.results) {
      if (seen.has(l.lot_id)) continue; // a lot may match >1 contract row; keep the first
      seen.add(l.lot_id);
      const est = eurFromNative(
        l.estimated_value,
        l.estimated_currency ?? r.tender_currency,
        l.estimated_fx_rate,
      );
      if (l.lot_id === r.lot_id) currentLotEstimatedEur = est;
      if (est != null) estimatedTotal += est;
      if (l.signing_value_eur != null) signedTotal += l.signing_value_eur;
      rows.push({
        lotLabel: l.lot_id.split(':').pop() ?? l.lot_id,
        subject: l.title,
        contractId: l.contract_id ? contractSlug(l.contract_id) : null,
        contractorSlug: l.bidder_id ? companySlug(l.bidder_id) : null,
        contractorName: l.bidder_name
          ? entityName(cleanName(l.bidder_name), l.bidder_kind ?? 'company')
          : null,
        estimatedEur: est,
        signingEur: l.signing_value_eur,
        isCurrent: l.lot_id === r.lot_id,
      });
    }
    // Lot labels are numeric strings ("1".."103"). The SQL `ORDER BY l.id` collates the full lot id
    // as text, so they come back lexically (1, 10, 100, 2…). Re-sort the assembled rows with a
    // numeric-aware comparator so the table reads 1, 2, 3 … 10 … 100 (falls back to lexical for any
    // non-numeric label).
    rows.sort((a, b) => a.lotLabel.localeCompare(b.lotLabel, 'bg', { numeric: true }));
    lots = {
      unp: r.unp,
      numLots: r.num_lots,
      rows,
      estimatedTotalEur: estimatedTotal || null,
      signedTotalEur: signedTotal || null,
    };
  }

  const value: ContractValueTimeline = {
    estimatedEur: currentLotEstimatedEur ?? procedureEstimatedEur,
    procedureEstimatedEur,
    signingEur,
    currentEur: currentRaw ?? signingEur,
    deltaPct:
      !suspect && currentRaw != null && signingEur != null && signingEur !== 0
        ? (currentRaw - signingEur) / signingEur
        : null,
    suspect,
  };

  const authority: ContractParty = {
    slug: authoritySlug(r.authority_id),
    name: cleanName(r.authority_name),
    displayName: cleanName(r.authority_name),
    typeLabel: typeLabel(r.authority_type_group),
    settlement: r.authority_settlement,
    eik: authoritySlug(r.authority_id),
    sector: null,
    totalContracts: authTotals?.contracts ?? 0,
    totalEur: authTotals?.spent_eur ?? 0,
  };
  const bidder: ContractParty = {
    slug: companySlug(r.bidder_id),
    name: cleanName(r.bidder_name),
    displayName: entityName(cleanName(r.bidder_name), r.bidder_kind),
    kind: r.bidder_kind,
    typeLabel: null,
    settlement: r.bidder_settlement,
    eik: r.bidder_eik,
    sector: sectorRef(compTotals?.primary_sector ?? null),
    totalContracts: compTotals?.contracts ?? 0,
    totalEur: compTotals?.won_eur ?? 0,
  };

  // Declared subcontractor ("Подизпълнител" in the АОП feed) — sparse (~0.8% of contracts). Value is
  // in the contract's native currency; normalise to EUR (fixed BGN peg) to match the rest of the UI.
  const subcontractor =
    r.subcontractor_name && r.subcontractor_name.trim()
      ? {
          name: cleanName(r.subcontractor_name),
          eik: r.subcontractor_eik,
          valueEur:
            r.subcontract_value == null
              ? null
              : r.contract_currency === 'EUR'
                ? r.subcontract_value
                : r.subcontract_value / 1.95583,
        }
      : null;

  // Framework call-off detection (query-time, works on current data). When the parent procedure has
  // more awarded contracts than lots, the extra awards are call-offs against one framework / DSP
  // procedure rather than one-contract-per-lot — so the procedure-level estimate is the whole
  // framework ceiling, not this single award. `frameworkAwards` carries the award count when so, else null.
  const frameworkAwards = r.tender_awards > Math.max(r.num_lots ?? 0, 1) ? r.tender_awards : null;

  const detail: ContractDetail = {
    id: contractSlug(r.id),
    subject: r.contract_subject?.trim() || r.title,
    unp: r.unp,
    contractNumber: r.contract_number,
    documentNumber: r.document_number,
    eopTenderId: r.eop_tender_id,
    lotLabel: r.lot_id ? (r.lot_id.split(':').pop() ?? null) : null,
    signedAt: r.signed_at,
    publishedAt: r.published_at,
    dateSuspect,
    startDate: r.start_date,
    endDate: r.end_date,
    contractKind: r.contract_kind,
    cpvCode: r.cpv_code,
    cpvDescription: r.cpv_description,
    sector: sectorRef(r.cpv_code ? r.cpv_code.slice(0, 2) : null),
    procedureLabel: r.procedure_type === 'неизвестна' ? 'Неизвестна' : r.procedure_type,
    bidsReceived: r.bids_received,
    bidsRejected: r.bids_rejected,
    bidsSme: r.bids_sme,
    bidsNonEea: r.bids_non_eea,
    euFunded: r.eu_funded == null ? null : r.eu_funded === 1,
    euProgramme: r.eu_programme,
    durationDays: r.duration_days,
    value,
    frameworkAwards,
    authority,
    bidder,
    lots,
    subcontractor,
  };

  return {
    ...detail,
    sourceNames: { authority: r.authority_name, bidder: r.bidder_name },
    bidder_legal_form: r.bidder_legal_form,
  };
}
