// Master launch gate (#83): the assistant is dark unless ASSISTANT_ENABLED is explicitly truthy. Shared by
// the chat route (which rejects the paid POST when off) and the root loader (which hides the dock launcher)
// so a dark deploy shows no assistant at all — not a launcher that errors on click. Opt-in by design: an
// unset / absent var reads as OFF (fail dark), the safe default for a not-yet-launched paid feature.
export function assistantEnabled(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'on';
}
