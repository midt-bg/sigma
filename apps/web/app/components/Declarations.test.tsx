// @vitest-environment jsdom
// The table of a person's source documents. The reporting year, the document's own dates, the office and the
// interests declared in it are separate facts: each keeps its own cell, a missing one says so instead of being
// filled in, and a note that two documents disagree links to the other document on the same page.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createRoutesStub } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersonDeclaration } from '@sigma/api-contract';
import { Declarations, declarationTypeLabel, declaredInterestLabel } from './Declarations';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(node: React.ReactNode) {
  const Stub = createRoutesStub([{ path: '/', Component: () => node }]);
  act(() => {
    root.render(<Stub initialEntries={['/']} />);
  });
  return container;
}

type Interest = NonNullable<PersonDeclaration['interests']>[number];

const interest = (over: Partial<Interest> = {}): Interest => ({
  company: 'АЛФА ООД',
  eik: '111111111',
  kind: 'shares',
  timing: 'annual',
  scope: 'self',
  ...over,
});

const declaration = (over: Partial<PersonDeclaration> = {}): PersonDeclaration => ({
  id: 'd1',
  year: '2023',
  template: 'interests',
  type: 'Annual',
  declaredOn: '2024-05-10',
  submittedOn: '2024-05-12',
  institution: 'Община Тестово',
  position: 'Кмет',
  url: 'https://register.cacbg.bg/2024/d1.xml',
  companyEiks: ['111111111'],
  ...over,
});

const cell = (row: Element, label: string) => row.querySelector(`td[data-label="${label}"]`)!;

describe('declarationTypeLabel', () => {
  it('names the kind of declaration and its part, and falls back to the part alone', () => {
    expect(declarationTypeLabel({ type: 'Annualy', template: 'assets' })).toBe(
      'Годишна · част I · имущество',
    );
    expect(declarationTypeLabel({ type: 'Vacate', template: 'interests' })).toBe(
      'Финална · част II · интереси',
    );
    expect(declarationTypeLabel({ type: 'Change', template: 'legacy' })).toBe(
      'За промяна · декларация',
    );
    expect(declarationTypeLabel({ type: null, template: 'interests' })).toBe('част II · интереси');
    expect(declarationTypeLabel({ type: 'Unexpected', template: 'legacy' })).toBe('декларация');
  });
});

describe('declaredInterestLabel', () => {
  it('names each kind of declared interest', () => {
    expect(declaredInterestLabel(interest({ kind: 'management', timing: 'current' }))).toBe(
      'управление',
    );
    expect(declaredInterestLabel(interest({ kind: 'sole_trader' }))).toBe('едноличен търговец');
    expect(declaredInterestLabel(interest({ kind: 'securities' }))).toBe('ценни книжа');
    expect(declaredInterestLabel(interest({ kind: 'shares', scope: 'unknown' }))).toBe(
      'дялово участие',
    );
    expect(declaredInterestLabel(interest({ kind: 'participation', scope: 'unknown' }))).toBe(
      'участие',
    );
    expect(declaredInterestLabel(interest())).toBe('собствен дял');
  });

  it('says first that an interest is a past one, a transferred one or a relative’s', () => {
    expect(declaredInterestLabel(interest({ kind: 'management', timing: 'prior' }))).toBe(
      'предходно управление',
    );
    expect(declaredInterestLabel(interest({ timing: 'disposed' }))).toBe('прехвърлен дял');
    expect(declaredInterestLabel(interest({ scope: 'family' }))).toBe('дял на свързано лице');
  });

  it('flags an interest whose period the document does not establish', () => {
    expect(declaredInterestLabel(interest({ kind: 'management', timing: 'unknown' }))).toBe(
      'управление · неустановен период',
    );
  });
});

describe('Declarations', () => {
  it('says so when there is no document', () => {
    expect(render(<Declarations declarations={[]} />).textContent).toBe(
      'Няма налични документи в заредения набор.',
    );
    expect(container.querySelector('table')).toBeNull();
  });

  it('links a document to its source and keeps its year, dates, office and interests apart', () => {
    const c = render(
      <Declarations
        declarations={[
          declaration({
            interests: [
              interest(),
              interest({ company: 'БЕТА ЕООД', eik: null, kind: 'management', timing: 'current' }),
            ],
          }),
        ]}
      />,
    );
    expect(c.querySelector('.declarations')!.className).toBe('declarations');
    const row = c.querySelector('tbody tr')!;
    // The row is an in-page target, so a note elsewhere on the profile can bring it into view.
    expect(row.id).toBe('declaration-d1');
    expect(row.getAttribute('tabindex')).toBe('-1');

    const source = cell(row, 'Декларация').querySelector('a')!;
    expect(source.getAttribute('href')).toBe('https://register.cacbg.bg/2024/d1.xml');
    expect(source.getAttribute('target')).toBe('_blank');
    expect(source.textContent).toBe('Година 2023 ↗');
    expect(cell(row, 'Декларация').textContent).toContain('Годишна · част II · интереси');
    expect(cell(row, 'Подадена на').textContent).toBe('12.05.2024');
    expect(cell(row, 'Дата на документа').textContent).toBe('10.05.2024');
    const office = cell(row, 'Институция и длъжност');
    expect(office.firstChild!.textContent).toBe('Община Тестово');
    expect(office.querySelector('.small')!.textContent).toBe('Кмет');

    const interests = [...cell(row, 'Дружества и декларирани роли').querySelectorAll('li')];
    expect(interests.map((li) => li.firstChild!.textContent)).toEqual(['АЛФА ООД', 'БЕТА ЕООД']);
    // Only an entity resolved to an ЕИК has a page to link to.
    expect(interests[0]!.querySelector('a')!.getAttribute('href')).toBe('/companies/111111111');
    expect(interests[1]!.querySelector('a')).toBeNull();
    expect(interests.map((li) => li.querySelector('.chip')!.textContent)).toEqual([
      'собствен дял',
      'управление',
    ]);
  });

  it('shows what a document lacks instead of filling it in', () => {
    const c = render(
      <Declarations
        declarations={[
          declaration({
            year: null,
            url: 'http://register.example/d1.xml',
            submittedOn: null,
            declaredOn: null,
            institution: null,
            position: null,
            interests: [],
          }),
        ]}
      />,
    );
    const row = c.querySelector('tbody tr')!;
    const source = cell(row, 'Декларация').querySelector('a')!;
    expect(source.hasAttribute('href')).toBe(false); // only an https source is linked
    expect(source.textContent).toBe('Отвори декларацията ↗');
    expect(cell(row, 'Подадена на').textContent).toBe('Няма данни');
    expect(cell(row, 'Дата на документа').textContent).toBe('Няма данни');
    expect(cell(row, 'Институция и длъжност').textContent).toBe('Неустановена институция');
    expect(cell(row, 'Дружества и декларирани роли').textContent).toBe(
      'Няма участия в показаните дружества',
    );
  });

  it('notes an entry or exit declaration whose year differs from its document date', () => {
    const note = 'Посочената година се различава от датата на документа.';
    const c = render(
      <Declarations
        declarations={[
          declaration({ id: 'entry', type: 'Assume', year: '2023', declaredOn: '2024-01-05' }),
          declaration({ id: 'exit', type: 'Final', year: '2024', declaredOn: '2024-11-30' }),
          declaration({ id: 'annual', type: 'Annual', year: '2023', declaredOn: '2024-05-10' }),
        ]}
      />,
    );
    const notes = [...c.querySelectorAll('tbody tr')].map((r) =>
      cell(r, 'Декларация').textContent!.includes(note),
    );
    expect(notes).toEqual([true, false, false]);
  });

  it('points a discrepancy to the other documents and brings them into view in place', () => {
    const c = render(
      <Declarations
        declarations={[
          declaration({
            discrepancies: [
              {
                eik: '111111111',
                company: 'АЛФА ООД',
                year: '2023',
                scope: 'family',
                listed: false,
                otherDeclarationIds: ['d2', 'd3'],
              },
              {
                eik: '222222222',
                company: 'ГАМА АД',
                year: '2023',
                scope: 'self',
                listed: true,
                otherDeclarationIds: ['d2'],
              },
            ],
          }),
          declaration({ id: 'd2', year: '2022' }),
          declaration({ id: 'd3', year: '2021' }),
        ]}
      />,
    );
    const [family, own] = [...c.querySelectorAll('.declaration-discrepancy')];
    expect(family!.textContent).toBe(
      'Разминаване за 2023 г. АЛФА ООД: дял на свързано лице не е посочен тук, но присъства в друга годишна декларация. Сравни документа · Сравни документа 2',
    );
    expect(family!.querySelector('a[href="/companies/111111111"]')).not.toBeNull();
    expect(own!.textContent).toContain(
      'ГАМА АД: собствен дял е посочен тук, но липсва в друга годишна декларация.',
    );

    const jumps = [...family!.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')];
    expect(jumps.map((a) => a.getAttribute('href'))).toEqual([
      '#declaration-d2',
      '#declaration-d3',
    ]);
    const target = c.querySelector<HTMLElement>('#declaration-d3')!;
    target.scrollIntoView = vi.fn();
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    act(() => {
      jumps[1]!.dispatchEvent(click);
    });
    expect(click.defaultPrevented).toBe(true); // the profile scrolls itself; the URL keeps no hash
    expect(target.scrollIntoView).toHaveBeenCalledWith({ block: 'start' });
    expect(document.activeElement).toBe(target);
    expect(target.classList.contains('profile-target')).toBe(true);
  });

  it('drops the row anchors in the compact list another block embeds', () => {
    // The same document can back several blocks of one page; anchors there would repeat an id.
    const c = render(<Declarations declarations={[declaration()]} compact />);
    expect(c.querySelector('.declarations')!.className).toBe('declarations compact');
    const row = c.querySelector('tbody tr')!;
    expect(row.hasAttribute('id')).toBe(false);
    expect(row.hasAttribute('tabindex')).toBe(false);
  });
});
