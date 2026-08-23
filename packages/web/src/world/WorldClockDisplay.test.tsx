import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { WorldClockDisplay } from './WorldClockDisplay';

/**
 * The world clock chip (App. H.4).
 *
 * The one thing worth holding here is that it reads the **world's** time in UTC.
 * A local-time render would put two players on different in-game dates in the
 * same world, and would disagree with the terminator drawn underneath it, which
 * is computed in UTC.
 */
describe('the world clock', () => {
  it('shows the world time in UTC, not the reader s timezone', () => {
    // 21:30 UTC, which is a different date in half the world's timezones.
    render(<WorldClockDisplay inGameTime={new Date('2024-10-20T21:30:00Z')} speedMultiplier={2} />);

    expect(screen.getByText('21:30')).toBeInTheDocument();
    expect(screen.getByText('20 Oct 2024')).toBeInTheDocument();
    // The machine-readable value is the same instant, for anything that parses it.
    expect(screen.getByText('21:30').closest('time')).toHaveAttribute(
      'dateTime',
      '2024-10-20T21:30:00.000Z',
    );
  });

  it('shows the speed, because the clock looks broken without it', () => {
    render(<WorldClockDisplay inGameTime={new Date('2024-10-20T09:05:00Z')} speedMultiplier={2} />);
    expect(screen.getByText('2×')).toBeInTheDocument();
  });

  it('does not render a trailing zero on a fractional speed', () => {
    render(
      <WorldClockDisplay inGameTime={new Date('2024-10-20T09:05:00Z')} speedMultiplier={1.5} />,
    );
    expect(screen.getByText('1.5×')).toBeInTheDocument();
  });

  it('renders nothing at all before the first sync', () => {
    // The World page draws before a player founds an airline, and a placeholder
    // clock would be a worse answer to "what time is it here?" than no clock.
    const { container } = render(<WorldClockDisplay inGameTime={null} speedMultiplier={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
