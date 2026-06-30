import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AssistantEmptyState } from './AssistantEmptyState';

afterEach(() => {
  cleanup();
});

describe('AssistantEmptyState', () => {
  it('offers the fallback prompt labels when given no prompts', () => {
    render(<AssistantEmptyState onPick={() => {}} />);

    expect(
      screen.getByRole('button', {
        name: 'Кои са най-големите възложители по похарчени средства?',
      }),
    ).toBeInTheDocument();
  });

  it('calls onPick with the fallback prompt send value', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<AssistantEmptyState onPick={onPick} />);

    await user.click(
      screen.getByRole('button', {
        name: 'Кои фирми са спечелили най-много от обществени поръчки?',
      }),
    );

    expect(onPick).toHaveBeenCalledWith('Кои фирми са спечелили най-много от обществени поръчки?');
  });

  it('renders the rich label but sends the server-authored question on click', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(
      <AssistantEmptyState
        prompts={[
          {
            label: 'Сектор с най-много средства: Строителство — 1 млн. €',
            send: 'Кои изпълнители?',
          },
        ]}
        onPick={onPick}
      />,
    );

    await user.click(
      screen.getByRole('button', {
        name: 'Сектор с най-много средства: Строителство — 1 млн. €',
      }),
    );

    expect(onPick).toHaveBeenCalledWith('Кои изпълнители?');
  });
});
