import { useState, useCallback, useEffect, useRef } from 'react';

function copyWithExecCommand(text: string): boolean {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.setAttribute('aria-hidden', 'true');
  textarea.tabIndex = -1;
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(textarea);
  return ok;
}

export function CopyCitationButton({ textToCopy }: { textToCopy: string }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timeoutRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const resetAfterDelay = useCallback(() => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
    }
    timeoutRef.current = window.setTimeout(() => setStatus('idle'), 2000);
  }, []);

  const handleCopy = useCallback(() => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard
        .writeText(textToCopy)
        .then(() => {
          if (!mountedRef.current) return;
          setStatus('copied');
          resetAfterDelay();
        })
        .catch((err) => {
          console.error('Failed to copy text:', err);
          if (!mountedRef.current) return;
          // execCommand('copy') here runs after an awaited promise rejection, so in some
          // browsers the original click's user-gesture context may already be gone by this
          // point, which can make execCommand return false even though a synchronous-first
          // attempt would have succeeded. We still degrade correctly to the 'failed' UI state
          // in that case, and writeText (tried first, above) is the modern/preferred path that
          // succeeds in the overwhelming majority of real browsers — so this ordering is kept
          // rather than reversing the priority to chase a rarer edge case.
          setStatus(copyWithExecCommand(textToCopy) ? 'copied' : 'failed');
          resetAfterDelay();
        });
      return;
    }
    setStatus(copyWithExecCommand(textToCopy) ? 'copied' : 'failed');
    resetAfterDelay();
  }, [textToCopy, resetAfterDelay]);

  const copied = status === 'copied';
  const failed = status === 'failed';

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={`copy-btn ${copied ? 'is-copied' : ''}`}
      aria-label={
        failed ? 'Копирането не бе успешно' : copied ? 'Копирано!' : 'Копирай данните като цитат'
      }
      title={failed ? 'Копирането не бе успешно — опитайте отново' : 'Копирай основните факти'}
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
      <span className="copy-btn-text" aria-live="polite">
        {copied ? 'Копирано!' : failed ? 'Неуспешно копиране' : 'Копирай'}
      </span>
    </button>
  );
}
