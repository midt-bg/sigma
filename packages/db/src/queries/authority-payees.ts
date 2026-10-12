// The bidders one authority paid, from the live contracts: the set both the /conflicts?authority= list
// (related-people-list.ts) and the institution profile's figure that links to it (getAuthorityConflictSummary)
// filter on, so the two cannot disagree. Read ONCE: as a correlated EXISTS inside the list's `links` this ran
// per candidate link and D1 answered „exceeded its CPU time limit and was reset" for any authority of real
// size — the filter the institution profile links to was dead above roughly two thousand contracts.
export const PAID_BY_AUTHORITY = `paid AS MATERIALIZED (
  SELECT DISTINCT b.eik_normalized eik FROM contracts c
  JOIN tenders t ON t.id=c.tender_id JOIN bidders b ON b.id=c.bidder_id
  WHERE ?1 IS NOT NULL AND t.authority_id=?1
)`;
