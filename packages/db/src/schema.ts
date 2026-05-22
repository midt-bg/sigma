// Row types mirroring migrations/0000_init.sql. Keep in sync with the SQL.

export interface AuthorityRow {
  id: string;
  name: string;
  bulstat: string | null;
  region: string | null;
  created_at: string;
}

export interface TenderRow {
  id: string;
  source_id: string;
  title: string;
  authority_id: string;
  cpv_code: string | null;
  estimated_value: number | null;
  currency: string;
  procedure_type: string;
  status: string;
  published_at: string | null;
  deadline_at: string | null;
  created_at: string;
}

export interface LotRow {
  id: string;
  tender_id: string;
  title: string;
  cpv_code: string | null;
  estimated_value: number | null;
  created_at: string;
}

export interface BidderRow {
  id: string;
  name: string;
  bulstat: string | null; // raw ЕИК as it appears in the register
  eik_normalized: string | null; // digits-only ЕИК when recoverable, else null
  eik_valid: number; // 1 if eik_normalized is a valid 9/13-digit ЕИК
  is_consortium: number; // 1 if a joint venture (multi-ЕИК field or ДЗЗД/ОБЕДИНЕНИЕ/КОНСОРЦИУМ name)
  kind: 'company' | 'consortium';
  created_at: string;
}

// Members of a consortium bidder (migrations/0002_consortia.sql). Populated from
// the ЕИК field when it lists several ids; the rest needs the Търговски регистър.
export interface BidderMemberRow {
  consortium_id: string;
  member_eik: string;
  member_id: string | null;
  share_pct: number | null;
  source: 'in_field' | 'bulstat' | 'tr' | 'name_match';
}

// Result shape of the `contract_participants` view: contracts exploded to the
// participating companies. allocated_amount conserves each contract's value across
// its participants, so it is always safe to SUM at any grouping.
export interface ContractParticipantRow {
  contract_id: string;
  tender_id: string;
  participant_eik: string | null;
  role: 'member' | 'sole' | 'consortium_unresolved';
  allocated_amount: number;
  member_count: number;
  is_estimated_split: number; // 1 = equal split among members (estimate), 0 = exact
}

export interface BidRow {
  id: string;
  tender_id: string;
  lot_id: string | null;
  bidder_id: string;
  amount: number;
  currency: string;
  is_winner: number;
  submitted_at: string | null;
  created_at: string;
}

export interface ContractRow {
  id: string;
  tender_id: string;
  bidder_id: string;
  amount: number;
  currency: string;
  signed_at: string | null;
  created_at: string;
}

export interface RiskScoreRow {
  tender_id: string;
  score: number;
  band: string;
  signals: string;
  computed_at: string;
}

// Result shape of the `price_benchmark` view (migrations/0001_raw_aop.sql):
// contract-value distribution per CPV + kind, derived from the register.
export interface PriceBenchmarkRow {
  cpv_code: string;
  contract_kind: string | null;
  n: number;
  avg_value: number;
  min_value: number;
  max_value: number;
  median_value: number;
}

// Lossless staging for the АОП register workbooks (data/*.xlsx); see
// migrations/0001_raw_aop.sql. Loaded by scripts/load-aop.mjs, normalised into
// the domain tables above by scripts/normalize-aop.sql.
export interface RawAopContractRow {
  id: number;
  dataset: 'храни' | 'строителство';
  tender_internal_id: string | null;
  parent_tender_id: string | null;
  lot_number: string | null;
  unp: string | null;
  subject: string | null;
  authority_name: string | null;
  procedure_type: string | null;
  contract_kind: string | null;
  cpv_code: string | null;
  estimated_value_eur: number | null;
  eu_funded: number | null;
  published_ojeu: number | null;
  bids_received: number | null;
  submission_deadline: string | null;
  annex: string | null;
  contract_number: string | null;
  contract_subject: string | null;
  contract_start_date: string | null;
  contract_end_date: string | null;
  signing_value_eur: number | null;
  current_value_eur: number | null;
  contractor_name: string | null;
  contractor_eik: string | null;
}
