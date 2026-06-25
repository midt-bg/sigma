import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { UIMessage } from 'ai';
import { AssistantMessage } from './AssistantMessage';

afterEach(() => {
  cleanup();
});

const message = (role: 'user' | 'assistant', ...texts: string[]): UIMessage =>
  ({ id: 'm1', role, parts: texts.map((text) => ({ type: 'text', text })) }) as UIMessage;

describe('AssistantMessage', () => {
  it('renders the concatenated text of a message', () => {
    render(<AssistantMessage message={message('assistant', 'Извличам ', 'данните…')} />);

    expect(screen.getByText('Извличам данните…')).toBeInTheDocument();
  });

  it('tags the message with its role', () => {
    render(<AssistantMessage message={message('user', 'Здравейте')} />);

    expect(screen.getByText('Здравейте').closest('[data-role]')).toHaveAttribute(
      'data-role',
      'user',
    );
  });

  it('renders nothing for a message with no text parts', () => {
    const { container } = render(
      <AssistantMessage message={{ id: 'm2', role: 'assistant', parts: [] } as UIMessage} />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
