// @vitest-environment jsdom
// The in-table search is a real GET form, enhanced with a debounced live submit. Pinned here is what a reader
// feels: a settled word filters the list without piling up history while Enter adds an entry, a lone letter
// earns a hint instead of a request, a word typed through an input method is sent whole, and the box follows
// the address when navigation happens elsewhere — but never under the reader's cursor. The strip below it
// says when the list is loading.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider, useSearchParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ListControls } from './ListControls';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let router: ReturnType<typeof createMemoryRouter>;
beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  router.dispose();
  vi.useRealTimers();
});

function List() {
  const [sp] = useSearchParams();
  return (
    <ListControls
      count="Намерени 3 договора"
      base={sp}
      sorts={[
        { value: 'date-desc', label: 'нови' },
        { value: 'value-desc', label: 'стойност ↓' },
      ]}
      activeSort={sp.get('sort') ?? 'date-desc'}
      searchLabel="Търсене сред договорите"
    />
  );
}

async function render(url: string, loader?: () => Promise<null>) {
  router = createMemoryRouter([{ id: 'list', path: '/contracts', Component: List, loader }], {
    initialEntries: [url],
    hydrationData: { loaderData: { list: null } },
  });
  await act(async () => root.render(<RouterProvider router={router} />));
  return container.querySelector<HTMLInputElement>('input[type="search"]')!;
}

const params = () => new URLSearchParams(router.state.location.search);
const type = (input: HTMLInputElement, text: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
/** Let the debounce run out (300 ms). */
const settle = () =>
  act(async () => {
    vi.advanceTimersByTime(300);
  });
const compose = (input: HTMLInputElement, phase: 'start' | 'end', data = '') =>
  act(async () => {
    input.dispatchEvent(new CompositionEvent(`composition${phase}`, { bubbles: true, data }));
  });

describe('ListControls — the in-table search', () => {
  it('filters once typing settles, replacing the history entry, keeping the filters and restarting the pages', async () => {
    const input = await render('/contracts?year=2024&sort=value-desc&page=3&cursor=abc');
    expect(container.querySelector('form[role="search"]')!.getAttribute('aria-label')).toBe(
      'Търсене сред договорите',
    );
    input.focus();
    type(input, 'мост');
    await act(async () => {
      vi.advanceTimersByTime(299);
    });
    expect(params().has('q')).toBe(false);
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect([...params()]).toEqual([
      ['q', 'мост'],
      ['year', '2024'],
      ['sort', 'value-desc'],
    ]);
    expect(router.state.historyAction).toBe('REPLACE');
    expect(input.value).toBe('мост');
  });

  it('adds a history entry when the reader submits, and does not send the word again', async () => {
    const input = await render('/contracts?sort=value-desc');
    type(input, 'път');
    await act(async () => {
      input.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(params().get('q')).toBe('път');
    expect(router.state.historyAction).toBe('PUSH');
    const { key } = router.state.location;
    await settle();
    expect(router.state.location.key).toBe(key);
  });

  it('answers a lone letter or bare punctuation with a hint, not a request', async () => {
    const input = await render('/contracts');
    const hint = () => container.querySelector('[role="status"]')?.textContent ?? null;
    type(input, 'а');
    expect(hint()).toBe('Въведете поне 2 знака; пунктуацията се пренебрегва');
    await settle();
    expect(router.state.location.search).toBe('');
    type(input, '„—"');
    expect(hint()).toBe('Въведете поне 2 знака; пунктуацията се пренебрегва');
    type(input, '   ');
    expect(hint()).toBeNull();
    type(input, 'ал');
    expect(hint()).toBeNull();
  });

  it('sends a word typed through an input method whole, the moment it is committed', async () => {
    const input = await render('/contracts');
    input.focus();
    await compose(input, 'start');
    type(input, 'мо');
    await settle();
    expect(router.state.location.search).toBe(''); // never „мо" for „мост"
    type(input, 'мост');
    await compose(input, 'end', 'мост');
    expect(params().get('q')).toBe('мост');
    expect(router.state.historyAction).toBe('REPLACE');
    const { key } = router.state.location;
    await settle();
    expect(router.state.location.key).toBe(key); // the settled debounce does not send it twice
  });

  it('is not left muted by a composition that lost focus before it ended', async () => {
    const input = await render('/contracts');
    input.focus();
    await compose(input, 'start');
    act(() => input.blur());
    type(input, 'път');
    await settle();
    expect(params().get('q')).toBe('път');
  });

  it('follows the address when navigation happens elsewhere, but not while the reader is in the box', async () => {
    const input = await render('/contracts?q=мост');
    expect(input.value).toBe('мост');

    await act(async () => router.navigate('/contracts?q=път'));
    expect(input.value).toBe('път');
    await settle();
    expect(params().get('q')).toBe('път'); // adopting the address does not echo a submit

    input.focus();
    await act(async () => router.navigate('/contracts?q=река'));
    expect(input.value).toBe('път');
    act(() => input.blur());
    expect(input.value).toBe('река');

    act(() => input.focus());
    act(() => input.blur());
    expect(input.value).toBe('река');
    expect(params().get('q')).toBe('река');
  });
});

describe('ListControls — the result strip', () => {
  it('says the list is loading until the new rows arrive, then marks the chosen sort', async () => {
    let release = () => {};
    const loader = vi.fn(
      () =>
        new Promise<null>((resolve) => {
          release = () => resolve(null);
        }),
    );
    await render('/contracts?year=2024&page=2', loader);
    const strip = container.querySelector('.list-controls')!;
    const status = strip.querySelector('[aria-live="polite"]')!;
    expect(strip.hasAttribute('aria-busy')).toBe(false);
    expect(status.textContent).toBe('Намерени 3 договора');
    const sorts = () =>
      [...strip.querySelectorAll('a')].map((a) => [
        a.textContent,
        a.getAttribute('href'),
        a.getAttribute('aria-current'),
      ]);
    expect(sorts()).toEqual([
      ['нови', '/contracts?year=2024&sort=date-desc', 'true'],
      ['стойност ↓', '/contracts?year=2024&sort=value-desc', null],
    ]);

    await act(async () => {
      strip.querySelectorAll('a')[1]!.click();
    });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(strip.getAttribute('aria-busy')).toBe('true');
    expect(status.textContent).toBe('Намерени 3 договора · Зарежда…');

    await act(async () => release());
    expect(strip.hasAttribute('aria-busy')).toBe(false);
    expect(status.textContent).toBe('Намерени 3 договора');
    expect(sorts().map(([label, , current]) => [label, current])).toEqual([
      ['нови', null],
      ['стойност ↓', 'true'],
    ]);
    expect(strip.querySelector('a[aria-current] strong')!.textContent).toBe('стойност ↓');
  });
});
