// Close (×) glyph for the dock header — an svg, not a text "×", so it centers geometrically.
export const CloseIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
    <path
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      d="M6 6 18 18M18 6 6 18"
    />
  </svg>
);
