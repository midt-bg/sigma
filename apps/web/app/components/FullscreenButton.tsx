import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Toggle the native Fullscreen API on a container ref. SSR-safe: the listener and the
 * `document` reads only run in the browser effect. `requestFullscreen` is feature-detected,
 * so the button no-ops gracefully where the API is unavailable.
 */
export function useFullscreen<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement === ref.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggle = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    if (document.fullscreenElement) {
      document.exitFullscreen?.();
    } else {
      el.requestFullscreen?.().catch((err) =>
        console.debug('[fullscreen] requestFullscreen failed', err),
      );
    }
  }, []);

  return { ref, isFullscreen, toggle };
}

export function FullscreenButton({ active, onToggle }: { active: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className="fs-btn"
      onClick={onToggle}
      aria-pressed={active}
      aria-label={active ? 'Изход от цял екран' : 'Разгледай графиката на цял екран'}
      title={active ? 'Изход от цял екран' : 'На цял екран'}
    >
      <svg
        aria-hidden="true"
        width="13"
        height="13"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {active ? (
          <>
            <path d="M6 2v4H2" />
            <path d="M10 2v4h4" />
            <path d="M6 14v-4H2" />
            <path d="M10 14v-4h4" />
          </>
        ) : (
          <>
            <path d="M2 6V2h4" />
            <path d="M14 6V2h-4" />
            <path d="M2 10v4h4" />
            <path d="M14 10v4h-4" />
          </>
        )}
      </svg>
      <span>{active ? 'Изход' : 'Цял екран'}</span>
    </button>
  );
}
