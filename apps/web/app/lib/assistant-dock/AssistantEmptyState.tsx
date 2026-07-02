/** A starter chip: a rich display `label`, and the server-authored question `send` POSTed on click. */
export type StarterPrompt = { label: string; send: string };

interface AssistantEmptyStateProps {
  /** Chips to offer; defaults to the static fallbacks when the loader gives nothing. */
  prompts?: StarterPrompt[];
  /** The visitor picked a chip — send its server-authored question (`send`), not the display label. */
  onPick: (send: string) => void;
}

// Illustrative starters grounded in the data the assistant can query (authorities, companies, flows),
// used when the dynamic loader has nothing. The first is the spec's verbatim example (§1). Here label
// and send are identical: these are already server-authored, name-free questions.
const FALLBACK_PROMPTS: StarterPrompt[] = [
  {
    label: 'Покажи най-рисковите поръчки в строителството за 2023',
    send: 'Покажи най-рисковите поръчки в строителството за 2023',
  },
  {
    label: 'Кои са най-големите възложители по похарчени средства?',
    send: 'Кои са най-големите възложители по похарчени средства?',
  },
  {
    label: 'Кои фирми са спечелили най-много от обществени поръчки?',
    send: 'Кои фирми са спечелили най-много от обществени поръчки?',
  },
  {
    label: 'Покажи най-големите парични потоци възложител - фирма',
    send: 'Покажи най-големите парични потоци възложител - фирма',
  },
];

/** Welcome state shown inside the dock when the transcript is empty: greeting + example prompts. */
export const AssistantEmptyState = ({
  prompts = FALLBACK_PROMPTS,
  onPick,
}: AssistantEmptyStateProps) => (
  <div className="assistant-empty">
    <p className="assistant-empty__greeting">
      Здравейте! Питайте за обществените поръчки - възложители, фирми, договори и парични потоци.
      Опитайте например:
    </p>
    <ul className="assistant-empty__prompts">
      {prompts.map((p) => (
        <li key={p.label}>
          <button type="button" className="assistant-empty__prompt" onClick={() => onPick(p.send)}>
            {p.label}
          </button>
        </li>
      ))}
    </ul>
  </div>
);

export { FALLBACK_PROMPTS };
