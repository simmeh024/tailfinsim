import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { nextRefreshAt, rosterDayIndex } from './csuite-rotation';
import { MarketCountdown, REFRESH_WARNING_MS } from './MarketCountdown';

/**
 * The refresh clock, on its own.
 *
 * It is a component rather than a `useState` on the page for two reasons, and
 * both are behaviour rather than tidiness: a tick must not re-render the
 * twenty-four candidate cards behind it, and the turnover must reach the page as
 * a single event it can act on rather than as a value that has already changed.
 */

const FIXED_NOW = Date.UTC(2026, 7, 28, 9, 0, 0);

function at(instant: number): void {
  vi.spyOn(Date, 'now').mockReturnValue(instant);
}

describe('the market countdown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    at(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('counts down without telling the page anything', () => {
    const onBoundary = vi.fn();
    render(<MarketCountdown marketSize={4} onBoundary={onBoundary} />);
    const timer = screen.getByRole('timer');
    const first = timer.textContent;

    at(FIXED_NOW + 1000);
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(timer.textContent).not.toBe(first);
    expect(onBoundary).not.toHaveBeenCalled();
  });

  it('warns before the turnover instead of springing it', () => {
    const onBoundary = vi.fn();
    render(<MarketCountdown marketSize={4} onBoundary={onBoundary} />);
    expect(screen.getByRole('timer').dataset.closing).toBe('false');
    expect(screen.getByText(/A fresh shortlist of 4 candidates/)).toBeInTheDocument();

    at(nextRefreshAt(FIXED_NOW) - REFRESH_WARNING_MS + 1000);
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(screen.getByRole('timer').dataset.closing).toBe('true');
    expect(screen.getByText(/about to be replaced/)).toBeInTheDocument();
  });

  it('reports the turnover once, with the window that has opened', () => {
    const onBoundary = vi.fn();
    render(<MarketCountdown marketSize={4} onBoundary={onBoundary} />);

    const after = nextRefreshAt(FIXED_NOW) + 1000;
    at(after);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onBoundary).toHaveBeenCalledTimes(1);
    expect(onBoundary).toHaveBeenCalledWith(rosterDayIndex(after));

    // Every tick after it is still inside the same window, so it stays quiet.
    at(after + 1000);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onBoundary).toHaveBeenCalledTimes(1);
  });

  it('never fires on mount — the page already knows which window it opened in', () => {
    const onBoundary = vi.fn();
    render(<MarketCountdown marketSize={4} onBoundary={onBoundary} />);
    expect(onBoundary).not.toHaveBeenCalled();
  });
});
