import type { Ref } from 'react';

interface AssistantLauncherProps {
  /** Expand the dock (shown only while collapsed). */
  onOpen: () => void;
  /** Forwarded so the dock can return focus here when it collapses (React 19 ref-as-prop). */
  ref?: Ref<HTMLButtonElement>;
}

/** The edge tab / button shown when the dock is collapsed; clicking it expands the dock. */
export const AssistantLauncher = ({ onOpen, ref }: AssistantLauncherProps) => (
  <button ref={ref} type="button" className="assistant-launcher" onClick={onOpen}>
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2Z"
      />
    </svg>
    <span className="assistant-launcher__label">Асистент</span>
  </button>
);
