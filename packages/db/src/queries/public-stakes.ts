// The public stake in a company, as far as the sources establish it: the standing owners the Trade Register
// records (a sole owner holds all of it; a partner holds his part of the partners' recorded capital), the
// Agency's list of public enterprises, and the stakes their public owners report in joint-stock companies whose
// shareholders the register does not record (DOCUMENTED_PUBLIC_STAKES). A share no source gives stays unknown —
// never 0, never 100. A stake held through another public company is indirect and is never added to a direct one.
import { DOCUMENTED_PUBLIC_STAKES, publicStakeSql } from '@sigma/shared';

export type PublicOwnerKind = 'state' | 'municipal' | 'bnb' | 'mixed';
export interface PublicStakeOwner {
  name: string;
  kind: PublicOwnerKind;
  /** Per cent of the company; null when no source gives it. */
  pct: number | null;
}
export interface PublicStake {
  /** On the Agency's list of public enterprises. */
  listed: 'state' | 'municipal' | 'mixed' | null;
  /** Public by its owners as the register records them (public_owned_eik). */
  derived: 'state' | 'municipal' | null;
  direct: PublicStakeOwner[];
  /** Through a public company, named. */
  indirect: PublicStakeOwner[];
}

const BNB = /народна\s+банка/iu;
const MUNICIPALITY = /^(?:столична\s+)?община(?!\p{L})/iu;
const STATE = /министерств|министър(?!\p{L})|(?:^|\s)държава(?:та)?(?!\p{L})/iu;
const amount = (share: string | null) => {
  const n = Number(
    String(share ?? '')
      .replace(/\s/g, '')
      .replace(',', '.'),
  );
  return share != null && String(share).trim() !== '' && Number.isFinite(n) ? n : null;
};

interface OwnerRow {
  eik: string;
  role: 'sole_owner' | 'partner';
  subject_kind: 'person' | 'entity';
  owner: string;
  name: string;
  share: string | null;
  owner_public: 'state' | 'municipal' | null;
  owner_listed: 'state' | 'municipal' | 'mixed' | null;
  owner_body: string | null;
  owner_is_body: number;
}

/** The public stake of each of the companies, for those any source establishes one in. */
export async function getPublicStakes(
  db: D1Database,
  eiks: string[],
): Promise<Record<string, PublicStake>> {
  const ids = [...new Set(eiks)];
  if (!ids.length) return {};
  const json = JSON.stringify(ids);
  const [owners, companies] = await Promise.all([
    db
      .prepare(
        `SELECT r.eik, r.role, r.subject_kind, r.subject_id owner, r.subject_name name, r.share,
          (SELECT p.ownership_kind FROM public_owned_eik p WHERE p.eik = r.subject_id) owner_public,
          (SELECT s.ownership_kind FROM state_owned_eik s WHERE s.eik = r.subject_id) owner_listed,
          -- A contracting authority with no partida of a trade company is a public body.
          (SELECT a.type_group FROM authorities a WHERE a.id = 'auth:' || r.subject_id) owner_body,
          EXISTS (SELECT 1 FROM authorities a WHERE a.id = 'auth:' || r.subject_id)
            AND NOT EXISTS (SELECT 1 FROM registry_deeds d WHERE d.eik = r.subject_id AND d.outcome = 'ok')
            owner_is_body
        FROM registry_roles r
        WHERE r.eik IN (SELECT value FROM json_each(?1))
          AND r.role IN ('sole_owner', 'partner') AND r.removed_on IS NULL AND r.uncertain_after IS NULL
        ORDER BY r.eik, r.subject_name`,
      )
      .bind(json)
      .all<OwnerRow>(),
    db
      .prepare(
        `SELECT value eik,
          (SELECT s.ownership_kind FROM state_owned_eik s WHERE s.eik = value) listed,
          (SELECT p.ownership_kind FROM public_owned_eik p WHERE p.eik = value) derived
        FROM json_each(?1)`,
      )
      .bind(json)
      .all<{ eik: string; listed: PublicStake['listed']; derived: PublicStake['derived'] }>(),
  ]);
  const out: Record<string, PublicStake> = {};
  for (const c of companies.results) {
    const rows = owners.results.filter((o) => o.eik === c.eik);
    const partners = rows.filter((o) => o.role === 'partner');
    const capital = partners.map((o) => amount(o.share));
    // A partner's part is known only when every partner's is.
    const total = capital.every((a) => a !== null)
      ? capital.reduce<number>((s, a) => s + a!, 0)
      : null;
    const pctOf = (o: OwnerRow) => {
      if (o.role === 'sole_owner') return 100;
      const a = amount(o.share);
      return total && a !== null ? Math.round((a / total) * 10000) / 100 : null;
    };
    const direct: PublicStakeOwner[] = [];
    const indirect: PublicStakeOwner[] = [];
    for (const o of rows) {
      if (o.subject_kind !== 'entity') continue;
      const pct = pctOf(o);
      if (BNB.test(o.name)) direct.push({ name: o.name, kind: 'bnb', pct });
      else if (o.owner_is_body || MUNICIPALITY.test(o.name) || STATE.test(o.name))
        direct.push({
          name: o.name,
          kind: o.owner_body === 'община' || MUNICIPALITY.test(o.name) ? 'municipal' : 'state',
          pct,
        });
      else if (o.owner_public || o.owner_listed)
        indirect.push({ name: o.name, kind: o.owner_public ?? o.owner_listed!, pct });
    }
    for (const s of DOCUMENTED_PUBLIC_STAKES.filter((s) => s.eik === c.eik))
      (s.via ? indirect : direct).push({ name: s.owner, kind: s.kind, pct: s.pct });
    if (direct.length || indirect.length || c.listed || c.derived)
      out[c.eik] = { listed: c.listed, derived: c.derived, direct, indirect };
  }
  return out;
}

/**
 * Of the given companies, those with an established public stake, however small (publicStakeSql). A seat in one
 * is a held position: its contracts are not the person's (ADR-0047 §2). Empty where the ownership tables are not
 * there, as in a database built from the declarations alone.
 */
export async function publicStakeEiks(db: D1Database, eiks: string[]): Promise<Set<string>> {
  const ids = [...new Set(eiks)];
  if (!ids.length) return new Set();
  try {
    const rows = await db
      .prepare(`SELECT value eik FROM json_each(?1) WHERE ${publicStakeSql('value')}`)
      .bind(JSON.stringify(ids))
      .all<{ eik: string }>();
    return new Set(rows.results.map((r) => r.eik));
  } catch (e) {
    if (/no such (table|column)/i.test(String(e))) return new Set();
    throw e;
  }
}
