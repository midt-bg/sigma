// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { CopyCitationButton } from './CopyCitationButton';

const originalClipboard = navigator.clipboard;
const originalExecCommand = document.execCommand;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  Object.assign(navigator, { clipboard: originalClipboard });
  Object.assign(document, { execCommand: originalExecCommand });
});

describe('CopyCitationButton', () => {
  it('shows the copied state after a successful Clipboard API write', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<CopyCitationButton textToCopy="hello" />);
    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('hello'));
    await screen.findByText('Копирано!');
    expect(screen.getByRole('button').className).toContain('is-copied');
  });

  it('falls back to execCommand when navigator.clipboard is unavailable', async () => {
    Object.assign(navigator, { clipboard: undefined });
    const execCommand = vi.fn().mockReturnValue(true);
    Object.assign(document, { execCommand });

    render(<CopyCitationButton textToCopy="hello" />);
    fireEvent.click(screen.getByRole('button'));

    await screen.findByText('Копирано!');
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(screen.getByRole('button').className).toContain('is-copied');
  });

  it('shows the failed state when both the Clipboard API and execCommand fail', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.assign(navigator, { clipboard: { writeText } });
    const execCommand = vi.fn().mockReturnValue(false);
    Object.assign(document, { execCommand });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    render(<CopyCitationButton textToCopy="hello" />);
    fireEvent.click(screen.getByRole('button'));

    await screen.findByText('Неуспешно копиране');
    expect(screen.getByRole('button').className).not.toContain('is-copied');
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe('Копирането не бе успешно');
  });

  it('reports failed when execCommand throws while navigator.clipboard is unavailable', async () => {
    Object.assign(navigator, { clipboard: undefined });
    Object.assign(document, {
      execCommand: vi.fn(() => {
        throw new Error('unsupported');
      }),
    });

    render(<CopyCitationButton textToCopy="hello" />);
    fireEvent.click(screen.getByRole('button'));

    await screen.findByText('Неуспешно копиране');
  });

  it('clears the pending reset timeout on unmount', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout');

    const { unmount } = render(<CopyCitationButton textToCopy="hello" />);
    fireEvent.click(screen.getByRole('button'));
    await screen.findByText('Копирано!');

    clearTimeoutSpy.mockClear();
    unmount();

    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  it('does not update state after unmount when the clipboard write resolves late', async () => {
    let resolveWrite: () => void = () => {};
    const writeText = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve;
        }),
    );
    Object.assign(navigator, { clipboard: { writeText } });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { unmount } = render(<CopyCitationButton textToCopy="hello" />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(writeText).toHaveBeenCalled());

    unmount();
    resolveWrite();
    await Promise.resolve();

    expect(errorSpy).not.toHaveBeenCalled();
  });
});
