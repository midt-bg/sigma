import { describe, expect, it } from 'vitest';
import {
  OFFICE_ORGANIZATIONS,
  officeInstitution,
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

// Presentation only: the stored „Месторабота" stays as filed, and the caller shows it beside the organization.
describe('the institution a declaration is shown under', () => {
  const person = [CATEGORY, 'Ежегодни декларации', 'Кметове и общински съветници'];

  it('is the organization for a filing in its category, whatever the „Месторабота" says', () => {
    for (const institution of ['ПУ „Тестов"', 'ТЕСТ ГРУП ЕООД', 'пенсионер', null])
      expect(officeInstitution({ category: CATEGORY, institution }, person)).toEqual({
        name: ORG!.name,
        basis: 'category',
      });
  });

  it('is the organization for a copy in a folder of declaration types whose „Месторабота" names it', () => {
    for (const institution of [
      'БЧК',
      'НС на БЧК',
      'Сдружение Български ЧЕРВЕН КРЪСТ',
      'Бъларски Червенн кръст',
    ])
      for (const category of [
        'Ежегодни декларации',
        'Встъпителни и финални декларации',
        'Встъпителни, финални и втори финални декларации',
        '',
      ])
        expect(
          officeInstitution({ category, institution }, person),
          `${category}: ${institution}`,
        ).toEqual({
          name: ORG!.name,
          basis: 'workplace',
        });
  });

  it('leaves the person’s other offices as filed', () => {
    // The same person's annual filing for another office, in the folder of declaration types.
    expect(
      officeInstitution({ category: 'Ежегодни декларации', institution: 'Община Тест' }, person),
    ).toBeNull();
    // A filing in another office's category, even when its „Месторабота" names the organization.
    expect(
      officeInstitution({ category: 'Кметове и общински съветници', institution: 'БЧК' }, person),
    ).toBeNull();
    // A filing that gives no category or no workplace, among categories that may be missing.
    expect(officeInstitution({ institution: 'БЧК' }, [null, undefined, CATEGORY])).toEqual({
      name: ORG!.name,
      basis: 'workplace',
    });
    expect(officeInstitution({ category: 'Ежегодни декларации' }, person)).toBeNull();
    // Somebody who does not file in the organization's category.
    expect(
      officeInstitution({ category: 'Ежегодни декларации', institution: 'БЧК' }, [
        'Ежегодни декларации',
      ]),
    ).toBeNull();
  });
});
