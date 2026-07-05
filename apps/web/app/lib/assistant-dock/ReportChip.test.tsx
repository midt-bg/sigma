import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRoutesStub } from 'react-router';
import { ReportChip } from './ReportChip';

afterEach(() => {
  cleanup();
});

const renderChip = (props: { title: string; leadStat: string | null; href?: string }) => {
  const Stub = createRoutesStub([{ path: '/', Component: () => <ReportChip {...props} /> }]);
  render(<Stub />);
};

describe('ReportChip', () => {
  it('shows the report title', () => {
    renderChip({
      title: 'Най-големи възложители',
      leadStat: 'Похарчено: 2,6 млн €',
      href: '/reports/r_1',
    });

    expect(screen.getByText('Най-големи възложители')).toBeInTheDocument();
  });

  it('shows the lead stat', () => {
    renderChip({ title: 'X', leadStat: 'Похарчено: 2,6 млн €', href: '/reports/r_1' });

    expect(screen.getByText('Похарчено: 2,6 млн €')).toBeInTheDocument();
  });

  it('omits the lead stat when there is none', () => {
    renderChip({ title: 'X', leadStat: null, href: '/reports/r_1' });

    expect(screen.queryByText(/Похарчено/)).not.toBeInTheDocument();
  });

  it('links „Отвори" to the report URL', () => {
    renderChip({ title: 'X', leadStat: null, href: '/reports/r_abc' });

    expect(screen.getByRole('link', { name: 'Отвори' })).toHaveAttribute('href', '/reports/r_abc');
  });

  it('omits „Отвори" when there is no report URL', () => {
    renderChip({ title: 'X', leadStat: null });

    expect(screen.queryByRole('link', { name: 'Отвори' })).not.toBeInTheDocument();
  });

  it('calls onOpen when „Отвори" is clicked', () => {
    const onOpen = vi.fn();
    const Stub = createRoutesStub([
      {
        path: '/',
        Component: () => (
          <ReportChip title="X" leadStat={null} href="/reports/r_1" onOpen={onOpen} />
        ),
      },
    ]);
    render(<Stub />);

    fireEvent.click(screen.getByRole('link', { name: 'Отвори' }));

    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
