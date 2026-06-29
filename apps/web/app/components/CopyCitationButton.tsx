import { useState, useCallback, useEffect, useRef } from 'react';

export function CopyCitationButton({ textToCopy }: { textToCopy: string }) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const handleCopy = useCallback(() => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard
        .writeText(textToCopy)
        .then(() => {
          setCopied(true);
          if (timeoutRef.current !== null) {
            window.clearTimeout(timeoutRef.current);
          }
          timeoutRef.current = window.setTimeout(() => setCopied(false), 2000);
        })
        .catch((err) => {
          console.error('Failed to copy text:', err);
        });
    }
  }, [textToCopy]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={`save-btn ${copied ? 'is-saved' : ''}`}
      aria-label="Копирай данните като цитат"
      title="Копирай основните факти"
    >
      {copied ? (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
      ) : (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
        </svg>
      )}
      <span className="save-btn-text" aria-live="polite">
        {copied ? 'Копирано!' : 'Копирай'}
      </span>
    </button>
  );
}
