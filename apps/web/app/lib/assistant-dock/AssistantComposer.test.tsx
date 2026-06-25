import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AssistantComposer } from './AssistantComposer';

afterEach(() => {
  cleanup();
});

const noop = () => {};

describe('AssistantComposer', () => {
  it('sends the trimmed text on Enter and clears the field', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<AssistantComposer onSend={onSend} onStop={noop} busy={false} />);
    const input = screen.getByLabelText('Съобщение до асистента');

    await user.type(input, '  здравей  {Enter}');

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('здравей');
    expect(input).toHaveValue('');
  });

  it('inserts a newline on Shift+Enter without sending', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<AssistantComposer onSend={onSend} onStop={noop} busy={false} />);
    const input = screen.getByLabelText('Съобщение до асистента');

    await user.type(input, 'ред1{Shift>}{Enter}{/Shift}ред2');

    expect(onSend).not.toHaveBeenCalled();
    expect(input).toHaveValue('ред1\nред2');
  });

  it('disables send when the field is empty', () => {
    render(<AssistantComposer onSend={noop} onStop={noop} busy={false} />);

    expect(screen.getByRole('button', { name: 'Изпрати' })).toBeDisabled();
  });

  it('disables the input while busy', () => {
    render(<AssistantComposer onSend={noop} onStop={noop} busy={true} />);

    expect(screen.getByLabelText('Съобщение до асистента')).toBeDisabled();
  });

  it('shows the Stop button while busy', () => {
    render(<AssistantComposer onSend={noop} onStop={noop} busy={true} />);

    expect(screen.getByRole('button', { name: 'Спри' })).toBeInTheDocument();
  });

  it('hides the Send button while busy', () => {
    render(<AssistantComposer onSend={noop} onStop={noop} busy={true} />);

    expect(screen.queryByRole('button', { name: 'Изпрати' })).not.toBeInTheDocument();
  });

  it('calls onStop when Stop is clicked', async () => {
    const user = userEvent.setup();
    const onStop = vi.fn();
    render(<AssistantComposer onSend={noop} onStop={onStop} busy={true} />);

    await user.click(screen.getByRole('button', { name: 'Спри' }));

    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('renders the mic as a disabled placeholder', () => {
    render(<AssistantComposer onSend={noop} onStop={noop} busy={false} />);

    expect(screen.getByRole('button', { name: 'Гласово въвеждане (скоро)' })).toBeDisabled();
  });
});
