export const declarationRowId = (id: string) => `declaration-${encodeURIComponent(id)}`;

const highlights = new WeakMap<HTMLElement, number>();

export function revealProfileTarget(id: string) {
  const target = document.getElementById(id);
  if (!target) return;
  target.scrollIntoView({ block: 'start' });
  target.tabIndex = -1;
  target.focus({ preventScroll: true });
  window.clearTimeout(highlights.get(target));
  target.classList.remove('profile-target');
  void target.offsetWidth;
  target.classList.add('profile-target');
  highlights.set(
    target,
    window.setTimeout(() => {
      target.classList.remove('profile-target');
      highlights.delete(target);
    }, 2200),
  );
}
