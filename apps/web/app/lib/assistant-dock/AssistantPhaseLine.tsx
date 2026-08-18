import type { AssistantPhase } from '../assistant-contract/stream';

// The wire carries only the opaque phase key; the user-facing Bulgarian labels live here, client-side.
const PHASE_LABEL: Record<AssistantPhase, string> = {
  thinking: 'Обмислям…',
  querying: 'Търся в данните…',
  composing: 'Съставям справка…',
};

/**
 * The ephemeral one-line turn status. Rendered inside the transcript's aria-live log so a screen
 * reader announces each change; renders nothing when idle or on an unrecognized key.
 */
export const AssistantPhaseLine = ({ phase }: { phase: AssistantPhase | null }) => {
  const label = phase === null ? undefined : PHASE_LABEL[phase];
  if (label === undefined) return null;
  return <p className="assistant-transcript__phase">{label}</p>;
};
