// Purely presentational — no consumer wires the native Fullscreen API to this button yet, so no
// `useFullscreen` hook lives here either (a prior version did, but with zero call sites — dead
// code). A future caller supplies `active`/`onToggle` however fits its own fullscreen strategy;
// no webkit-prefix fallback is needed until that caller and its target browser matrix exist.
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
