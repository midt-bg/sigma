import { useEffect, useState } from 'react';

// Local per-second tick for a recording timer, driven by a start timestamp. Kept out of the shared voice
// hook so the tick re-renders only the component that shows it, not the whole composer.
export function useElapsedSeconds(startedAt: number | null): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (startedAt === null) {
      setSeconds(0);
      return;
    }
    const update = () => setSeconds(Math.floor((Date.now() - startedAt) / 1000));
    update();
    const id = setInterval(update, 500);
    return () => clearInterval(id);
  }, [startedAt]);
  return seconds;
}
