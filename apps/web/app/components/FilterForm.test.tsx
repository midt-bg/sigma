// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoutesStub, Link, useLocation, useSearchParams } from 'react-router';
import { FilterForm, FundingSelect } from './FilterForm';

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

function Page() {
  const [sp] = useSearchParams();
  const { search } = useLocation();
  const sector = sp.get('sector') ?? '';
  return (
    <>
      <output>{search}</output>
      <Link to="/viz?sector=45">preset</Link>
      <FilterForm label="Филтри" values={{ sector, funding: sp.get('funding') ?? '' }}>
        <label>
          Сектор:
          <select name="sector" defaultValue={sector}>
            <option value="">Всички сектори</option>
            <option value="45">Строителство</option>
            <option value="33">Медицина</option>
          </select>
        </label>
        <FundingSelect value={sp.get('funding') ?? ''} />
      </FilterForm>
    </>
  );
}

async function render(url = '/viz') {
  const Stub = createRoutesStub([{ path: '/viz', Component: Page }]);
  await act(async () => {
    root.render(<Stub initialEntries={[url]} />);
  });
}

const select = () => container.querySelector<HTMLSelectElement>('select[name="sector"]')!;
const search = () => container.querySelector('output')!.textContent;

async function key(el: HTMLElement, k: string) {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  });
}
async function choose(el: HTMLSelectElement, value: string) {
  await act(async () => {
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('FilterForm', () => {
  it('applies a mouse pick at once', async () => {
    await render();
    await act(async () => {
      select().dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    await choose(select(), '45');
    expect(search()).toContain('sector=45');
  });

  it('lets arrow keys move the choice without applying it until Enter', async () => {
    await render();
    await key(select(), 'ArrowDown');
    await choose(select(), '45');
    await key(select(), 'ArrowDown');
    await choose(select(), '33');
    expect(search()).toBe('');
    await key(select(), 'Enter');
    expect(search()).toContain('sector=33');
  });

  it('applies a keyed choice when focus leaves the select', async () => {
    await render();
    await key(select(), 'ArrowDown');
    await choose(select(), '45');
    expect(search()).toBe('');
    await act(async () => {
      select().dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(search()).toContain('sector=45');
  });

  it('follows the URL after an in-page link instead of keeping the last pick', async () => {
    await render('/viz?sector=33');
    expect(select().value).toBe('33');
    await act(async () => {
      container.querySelector('a')!.click();
    });
    expect(search()).toBe('?sector=45');
    expect(select().value).toBe('45');
  });

  it('uses one wording for the funding filter', async () => {
    await render();
    const options = [...container.querySelectorAll('select[name="funding"] option')];
    expect(options.map((o) => o.textContent)).toEqual([
      'Всички',
      'Само с финансиране от ЕС',
      'Само без финансиране от ЕС',
    ]);
  });
});
