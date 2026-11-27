import { sqlLiteral } from './ship-related-persons.mjs';

export const LEGACY_OCDS_IDS_TABLE = 'ocds_legacy_contract_ids';

// An unmigrated slot has the original IDs in contracts. Once migrated, the
// reservations outlive their served rows, including rows superseded by EOP.
export function readLegacyOcdsContractIds(read) {
  const [schema] = read(
    `SELECT
       EXISTS(SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = '${LEGACY_OCDS_IDS_TABLE}') AS migrated,
       EXISTS(SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'contracts') AS contracts`,
  );
  if (![0, 1].includes(schema?.migrated) || ![0, 1].includes(schema?.contracts))
    throw new Error('Missing OCDS legacy ID schema');
  if (!schema.migrated && !schema.contracts) return [];
  const source = schema.migrated ? LEGACY_OCDS_IDS_TABLE : 'contracts';
  const scope = schema.migrated ? '1' : "id GLOB 'c:o:*'";
  const count = read(`SELECT COUNT(*) AS n FROM ${source} WHERE ${scope}`)[0]?.n;
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('Missing OCDS legacy ID count');

  const rows = [];
  const pageSize = 250;
  while (rows.length < count) {
    const after = rows.at(-1)?.id ?? '';
    const page = read(
      `SELECT id, document_number FROM ${source}
       WHERE ${scope} AND id > ${sqlLiteral(after)} ORDER BY id LIMIT ${pageSize}`,
    );
    if (
      page.length !== Math.min(pageSize, count - rows.length) ||
      page.some((row) => typeof row.id !== 'string' || row.id === after)
    )
      throw new Error('Incomplete OCDS legacy ID page');
    rows.push(...page);
  }
  return rows;
}
