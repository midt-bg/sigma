import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AssistantComposerMic } from './AssistantComposerMic';
import type { VoiceInput, VoiceState } from './useVoiceInput';

afterEach(() => cleanup());

const fakeVoice = (state: VoiceState, over: Partial<VoiceInput> = {}): VoiceInput => ({
  state,
  startedAt: null,
  endingSoon: false,
  start: vi.fn(),
  stop: vi.fn(),
  ...over,
});

describe('AssistantComposerMic', () => {
  it('idle: an enabled toggle labelled "Гласово въвеждане", aria-pressed=false; click starts', async () => {
    const start = vi.fn();
    render(<AssistantComposerMic voice={fakeVoice({ status: 'idle' }, { start })} />);

    const button = screen.getByRole('button', { name: 'Гласово въвеждане' });
    expect(button).toBeEnabled();
    expect(button).toHaveAttribute('aria-pressed', 'false');

    await userEvent.click(button);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('recording: labelled "Спри записа", aria-pressed=true; click stops', async () => {
    const stop = vi.fn();
    render(
      <AssistantComposerMic
        voice={fakeVoice({ status: 'recording' }, { stop, startedAt: 1000 })}
      />,
    );

    const button = screen.getByRole('button', { name: 'Спри записа' });
    expect(button).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(button);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('disables the toggle while transcribing (a transient state)', () => {
    render(<AssistantComposerMic voice={fakeVoice({ status: 'transcribing' })} />);

    expect(screen.getByRole('button', { name: 'Гласово въвеждане' })).toBeDisabled();
  });
});
