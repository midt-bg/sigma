import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const migrations = resolve(dirname(fileURLToPath(import.meta.url)), '../migrations');

/**
 * The base served schema, in the order a database receives it: 0000_init.sql as it was first applied, then
 * 0025, which carries the objects later edited into 0000 (docs/deploy.md, „Схемата“). For SQL tests that
 * build the served tables without the person and registry layers.
 */
export const BASE_SCHEMA = ['0000_init.sql', '0025_joint_procurement_and_ordering_unit.sql'].map(
  (file) => resolve(migrations, file),
);
