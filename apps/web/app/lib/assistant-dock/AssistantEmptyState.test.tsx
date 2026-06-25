import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AssistantEmptyState } from './AssistantEmptyState';

afterEach(() => {
  cleanup();
});

describe('AssistantEmptyState', () => {
  it('offers example prompts', () => {
    render(<AssistantEmptyState onPick={() => {}} />);

    expect(
      screen.getByRole('button', {
        name: 'Кои са най-големите възложители по похарчени средства?',
      }),
    ).toBeInTheDocument();
  });

  it('calls onPick with the chosen prompt', async () => {
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
});
