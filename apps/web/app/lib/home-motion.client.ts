// Home load + scroll timeline (anime.js v4). Client-only, imported dynamically after paint.
//
// TWO RULES THIS MODULE MUST NOT BREAK:
//
// 1. Nothing is hidden by CSS. Every element is fully visible in the server-rendered HTML; this
//    module sets the "from" state itself, immediately before animating. A blocked chunk, a failed
//    import or JS switched off therefore degrades to "no animation" — never to a blank page. That
//    is why there is no `.is-preanimation` class or opacity:0 in home.css.
//
// 2. Count-ups end on the SERVER-RENDERED string. Intermediate frames are formatted with
//    Intl.NumberFormat('bg-BG'), but the final value restores the element's original textContent,
//    so the number the reader is left with is byte-identical to the SSR output — no risk of the
//    animation inventing a differently-rounded figure on a transparency surface.
//
// Everything bails out under `prefers-reduced-motion: reduce`.

import { animate, createTimeline, stagger, utils } from 'animejs';

const EASE = 'cubicBezier(.22,1,.36,1)';

const nf = new Map<number, Intl.NumberFormat>();
function fmt(value: number, decimals: number): string {
  let f = nf.get(decimals);
  if (!f) {
    f = new Intl.NumberFormat('bg-BG', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
    nf.set(decimals, f);
  }
  return f.format(value);
}

const all = (sel: string): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>(sel));

/** Animate one element's number from 0 to `data-count`, restoring its SSR text at the end. */
function countUp(el: HTMLElement): void {
  const target = Number(el.dataset.count);
  if (!Number.isFinite(target)) return;
  const decimals = Number(el.dataset.dec ?? 0) || 0;
  const final = el.textContent ?? '';
  const state = { v: 0 };
  animate(state, {
    v: target,
    duration: 1700,
    ease: 'outExpo',
    onUpdate: () => {
      el.textContent = fmt(state.v, decimals);
    },
    // Restore the exact server-rendered string — see rule 2 above.
    onComplete: () => {
      el.textContent = final;
    },
  });
}

/**
 * Run the home timeline. Returns a cleanup that stops any in-flight animation and restores every
 * touched element, so a client-side navigation away mid-animation cannot leave the DOM mid-state.
 */
export function runHomeMotion(): () => void {
  if (typeof window === 'undefined') return () => {};
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return () => {};

  const touched = '[data-a],[data-a] *';

  // ── load timeline — the dossier draws itself in ────────────────────────────
  const rule = all('[data-a="rule"]');
  const words = all('[data-a="word"]');
  const under = all('[data-a="under"]');
  const lede = all('[data-a="lede"]');
  const search = all('[data-a="search"]');
  const corners = all('[data-a="search"] .corner');
  const figs = all('[data-a="fig"]');

  // "from" states, set here rather than in CSS (rule 1).
  utils.set(rule, { scaleX: 0, transformOrigin: 'left' });
  utils.set(words, { opacity: 0, translateY: 30 });
  utils.set(under, { scaleX: 0, transformOrigin: 'left' });
  utils.set([...lede, ...search], { opacity: 0, translateY: 14 });
  utils.set(corners, { scale: 0 });
  utils.set(figs, { opacity: 0, translateY: 16 });

  const tl = createTimeline({ defaults: { ease: EASE } });
  tl.add(rule, { scaleX: [0, 1], duration: 800 }, 0)
    .add(words, { opacity: [0, 1], translateY: [30, 0], duration: 650, delay: stagger(80) }, 150)
    .add(lede, { opacity: [0, 1], translateY: [14, 0], duration: 550 }, 700)
    .add(under, { scaleX: [0, 1], duration: 500, ease: 'outExpo' }, 950)
    .add(search, { opacity: [0, 1], translateY: [14, 0], duration: 550 }, 850)
    .add(corners, { scale: [0, 1], duration: 420, delay: stagger(70) }, 1050)
    .add(figs, { opacity: [0, 1], translateY: [16, 0], duration: 620, delay: stagger(110) }, 1000);

  // ── scroll-triggered ───────────────────────────────────────────────────────
  // Triggering uses a native IntersectionObserver rather than anime's onScroll. That is
  // deliberate: `autoplay: onScroll(...)` requires the element to be hidden UP FRONT and revealed
  // by the observer, so if the observer never fires the content stays invisible forever — which is
  // exactly what happened in review (the 88px share figure and the lens cards rendered blank).
  // Here the "from" state is applied inside `onEnter`, one frame before the animation runs, so an
  // observer that never fires simply leaves the fully-visible SSR markup alone. Rule 1, enforced.
  const observers: IntersectionObserver[] = [];
  function whenVisible(el: Element, run: () => void): void {
    if (typeof IntersectionObserver === 'undefined') return; // no observer → leave it visible
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          io.unobserve(e.target);
          run();
        }
      },
      { rootMargin: '0px 0px -60px 0px' },
    );
    io.observe(el);
    observers.push(io);
  }

  for (const el of all('[data-count]')) whenVisible(el, () => countUp(el));

  // Ranked-bar fills grow from 0 to the width the server already set inline.
  for (const list of all('.ranked-bars')) {
    const fills = Array.from(list.querySelectorAll<HTMLElement>('.rb-fill'));
    if (fills.length === 0) continue;
    whenVisible(list, () => {
      const widths = fills.map((f) => f.style.width);
      utils.set(fills, { width: '0%' });
      fills.forEach((fill, i) => {
        animate(fill, { width: widths[i] ?? '0%', duration: 1100, ease: EASE, delay: i * 90 });
      });
    });
  }

  // The red share figure stamps in; the share bar's red segment sweeps out.
  for (const el of all('[data-a="riskpct"]')) {
    whenVisible(el, () => {
      utils.set(el, { opacity: 0, scale: 1.5 });
      animate(el, { opacity: [0, 1], scale: [1.5, 1], duration: 800, ease: 'outExpo' });
    });
  }
  for (const bar of all('[data-a="share"]')) {
    const fill = bar.querySelector<HTMLElement>('.share-fill');
    if (!fill) continue;
    whenVisible(bar, () => {
      const w = fill.style.width;
      utils.set(fill, { width: '0%' });
      animate(fill, { width: w, duration: 1100, ease: EASE });
    });
  }

  // Row groups fade up; indicator tags pop.
  for (const group of all('.standout, .lenses')) {
    const rows = Array.from(group.children) as HTMLElement[];
    if (rows.length === 0) continue;
    whenVisible(group, () => {
      utils.set(rows, { opacity: 0, translateY: 14 });
      animate(rows, {
        opacity: [0, 1],
        translateY: [14, 0],
        duration: 600,
        ease: EASE,
        delay: stagger(90),
      });
    });
  }
  for (const list of all('.standout')) {
    const tags = Array.from(list.querySelectorAll<HTMLElement>('.tag'));
    if (tags.length === 0) continue;
    whenVisible(list, () => {
      utils.set(tags, { scale: 0.6 });
      animate(tags, { scale: [0.6, 1], duration: 500, ease: 'outBack', delay: stagger(70) });
    });
  }

  return () => {
    tl.pause();
    for (const io of observers) io.disconnect();
    // Drop every inline style this module applied so a re-render starts clean.
    utils.remove(touched);
    for (const el of all(touched)) el.removeAttribute('style');
  };
}
