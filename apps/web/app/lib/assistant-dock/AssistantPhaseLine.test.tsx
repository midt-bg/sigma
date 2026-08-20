import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { AssistantPhaseLine } from './AssistantPhaseLine';

afterEach(() => {
  cleanup();
});

describe('AssistantPhaseLine', () => {
  it('renders the thinking label', () => {
    render(<AssistantPhaseLine phase="thinking" />);
    expect(screen.getByText('Обмислям…')).toBeInTheDocument();
  });

  it('renders the querying label', () => {
    render(<AssistantPhaseLine phase="querying" />);
    expect(screen.getByText('Търся в данните…')).toBeInTheDocument();
  });

  it('renders the composing label', () => {
    render(<AssistantPhaseLine phase="composing" />);
    expect(screen.getByText('Съставям справка…')).toBeInTheDocument();
  });

  it('renders nothing when idle', () => {
    const { container } = render(<AssistantPhaseLine phase={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
