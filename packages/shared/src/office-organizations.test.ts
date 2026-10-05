import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  OFFICE_ORGANIZATIONS,
  officeOrganizationEik,
  officeOrganizationSql,
} from './office-organizations';

const [ORG] = OFFICE_ORGANIZATIONS;
const CATEGORY = `Членовете на ръководните и на контролните ${ORG!.categoryIncludes}`;

describe('the organizations whose bodies are an office', () => {
  it('names the organization of its own category, and nothing for any other', () => {
    expect(officeOrganizationEik(CATEGORY)).toBe(ORG!.eik);
    expect(officeOrganizationEik('Кметове и общински съветници')).toBeNull();
    expect(officeOrganizationEik(null)).toBeNull();
  });

  it('holds in SQL only for a person who files in the category, and only for that organization', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE declarations(person_id, category);
      INSERT INTO declarations VALUES ('member', '${CATEGORY}'), ('councillor', 'Кметове и общински съветници');`);
    const holds = (person: string, eik: string) =>
      (
        db.prepare(`SELECT ${officeOrganizationSql('?1', '?2')} ok`).get(person, eik) as {
          ok: number;
        }
      ).ok;
    expect(holds('member', ORG!.eik)).toBe(1);
    expect(holds('member', '123456789')).toBe(0);
    expect(holds('councillor', ORG!.eik)).toBe(0);
    db.close();
  });
});
