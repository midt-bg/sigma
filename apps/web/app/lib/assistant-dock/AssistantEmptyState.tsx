interface AssistantEmptyStateProps {
  /** The visitor picked an example prompt — send it. */
  onPick: (prompt: string) => void;
}

// Illustrative starters grounded in the data the assistant can query (authorities, companies, flows).
// The first is the spec's verbatim example (§1).
const PROMPTS = [
  'Покажи най-рисковите поръчки в строителството за 2023',
  'Кои са най-големите възложители по похарчени средства?',
  'Кои фирми са спечелили най-много от обществени поръчки?',
  'Покажи най-големите парични потоци възложител → фирма',
];

/** Welcome state shown inside the dock when the transcript is empty: greeting + example prompts. */
export const AssistantEmptyState = ({ onPick }: AssistantEmptyStateProps) => (
  <div className="assistant-empty">
    <p className="assistant-empty__greeting">
      Здравейте! Питайте за обществените поръчки - възложители, фирми, договори и парични потоци.
      Опитайте например:
    </p>
    <ul className="assistant-empty__prompts">
      {PROMPTS.map((prompt) => (
        <li key={prompt}>
          <button type="button" className="assistant-empty__prompt" onClick={() => onPick(prompt)}>
            {prompt}
          </button>
        </li>
      ))}
    </ul>
  </div>
);
