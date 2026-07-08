import type { VoiceInput } from './useVoiceInput';
import { useElapsedSeconds } from './useElapsedSeconds';

interface AssistantComposerMicProps {
  voice: VoiceInput;
}

/** Elapsed recording seconds → a short `0:SS` clock (capped at the 60s recording limit). */
const formatElapsedTime = (seconds: number): string =>
  `0:${String(Math.min(seconds, 60)).padStart(2, '0')}`;

const MIC_ICON = (
  <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">
    <path
      fill="currentColor"
      d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2Z"
    />
  </svg>
);
const STOP_ICON = (
  <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">
    <rect x="4" y="4" width="16" height="16" rx="2.5" fill="currentColor" />
  </svg>
);
const VISUALIZER_BARS = Array.from({ length: 13 }, (_, i) => i);

/**
 * The mic toggle: aria-pressed / name / icon change with state, with an aria-hidden pure-CSS equalizer
 * while recording. The composer owns the status live-region; this stays just the inline control.
 */
export const AssistantComposerMic = ({ voice }: AssistantComposerMicProps) => {
  const { state, startedAt, start, stop } = voice;
  const seconds = useElapsedSeconds(startedAt); // local tick — re-renders only the mic, not the composer
  const recording = state.status === 'recording';
  const busy = state.status === 'requesting' || state.status === 'transcribing';

  return (
    <div className="assistant-composer__mic-group">
      <button
        type="button"
        className="assistant-composer__mic"
        aria-label={recording ? 'Спри записа' : 'Гласово въвеждане'}
        aria-pressed={recording}
        disabled={busy}
        onClick={() => (recording ? stop() : start())}
      >
        {recording ? STOP_ICON : MIC_ICON}
      </button>
      {recording ? (
        <span className="assistant-composer__mic-timer" aria-hidden="true">
          {formatElapsedTime(seconds)}
        </span>
      ) : null}
      {recording ? (
        <span className="assistant-composer__mic-viz" aria-hidden="true">
          {VISUALIZER_BARS.map((index) => (
            <span key={index} className="assistant-composer__mic-bar" />
          ))}
        </span>
      ) : null}
    </div>
  );
};
