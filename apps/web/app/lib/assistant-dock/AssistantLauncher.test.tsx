import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AssistantLauncher } from './AssistantLauncher';

afterEach(() => {
  cleanup();
});

describe('AssistantLauncher', () => {
  it('renders a labelled launcher', () => {
    render(<AssistantLauncher onOpen={() => {}} />);

    expect(screen.getByRole('button', { name: 'Асистент' })).toBeInTheDocument();
  });

  it('opens the dock when clicked', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<AssistantLauncher onOpen={onOpen} />);

    await user.click(screen.getByRole('button', { name: 'Асистент' }));

    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
