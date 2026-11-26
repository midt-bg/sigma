import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const migrations = resolve(dirname(fileURLToPath(import.meta.url)), '../migrations');

/**
 * The base served schema, in the order a database receives it: 0000_init.sql as it was first applied, then
 * 0008 for annex source links, 0025 for objects later edited into 0000 (docs/deploy.md, „Схемата“),
 * 0029 for valuation evidence, and 0030 for OCDS signing eligibility.
 * For SQL tests without the person and registry layers.
 */
export const BASE_SCHEMA = [
  '0000_init.sql',
  '0008_amendment_provenance.sql',
  '0025_joint_procurement_and_ordering_unit.sql',
  '0029_contract_value_evidence.sql',
  '0030_ocds_signing_evidence.sql',
].map((file) => resolve(migrations, file));
