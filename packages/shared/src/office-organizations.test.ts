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

  it('gives SQL that ties the organization to the category, through the given person ids', () => {
    const sql = officeOrganizationSql('?1', 'r.eik');
    expect(sql).toContain(`r.eik='${ORG!.eik}'`);
    expect(sql).toContain(`office_d.person_id IN (?1)`);
    expect(sql).toContain(`instr(office_d.category,'${ORG!.categoryIncludes}')>0`);
  });
});
