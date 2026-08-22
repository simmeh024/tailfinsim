import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ThemeProvider } from '../theme/ThemeProvider';

import { focusViewState } from './camera';
import { WORLD_PROJECTION_STORAGE_KEY } from './projection';
import { WorldRenderer } from './WorldRenderer';

import type { MapViewState, Layer } from '@deck.gl/core';

interface CapturedDeckProps {
  _onMetrics: (metrics: { fps: number; framesRedrawn: number }) => void;
  layers: (Layer | false)[];
  onError: () => void;
  onViewStateChange: (change: { viewState: MapViewState }) => void;
  views: unknown;
  viewState: MapViewState;
}

const deckCapture = vi.hoisted(() => ({ props: undefined as CapturedDeckProps | undefined }));

vi.mock('@deck.gl/react', () => ({
  default: (props: CapturedDeckProps) => {
    deckCapture.props = props;
    return null;
  },
}));

function renderRenderer(): void {
  render(
    <ThemeProvider>
      <WorldRenderer routes={[{ id: 'date-line', source: [170, 35], target: [-170, 40] }]} />
    </ThemeProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  deckCapture.props = undefined;
});

describe('WorldRenderer', () => {
  it('restores the device projection preference and exposes the shared camera grammar', () => {
    localStorage.setItem(WORLD_PROJECTION_STORAGE_KEY, 'flat');
    renderRenderer();

    expect(screen.getByLabelText('Interactive world renderer')).toHaveAttribute(
      'data-projection',
      'flat',
    );
    expect(screen.getByRole('button', { name: 'Flat' })).toHaveAttribute('aria-pressed', 'true');

    const view = deckCapture.props?.views as {
      props?: { controller?: Record<string, unknown> };
    };
    expect(view.props?.controller).toMatchObject({
      dragPan: true,
      doubleClickZoom: false,
      scrollZoom: true,
      touchZoom: true,
    });
  });

  it('focuses and zooms the same controlled camera for either projection', () => {
    expect(
      focusViewState({ longitude: 8, latitude: 24, zoom: 0.35, pitch: 0, bearing: 0 }, [130, -34]),
    ).toMatchObject({ longitude: 130, latitude: -34, zoom: 1.35, pitch: 0, bearing: 0 });
  });

  it('preserves focus and layer toggles while switching projection', () => {
    localStorage.setItem(WORLD_PROJECTION_STORAGE_KEY, 'globe');
    renderRenderer();

    act(() => {
      deckCapture.props?.onViewStateChange({
        viewState: {
          longitude: 75,
          latitude: 20,
          zoom: 2,
          pitch: 0,
          bearing: 0,
        },
      });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Day/night' }));
    fireEvent.click(screen.getByRole('button', { name: 'Flat' }));

    expect(localStorage.getItem(WORLD_PROJECTION_STORAGE_KEY)).toBe('flat');
    expect(screen.getByLabelText('Interactive world renderer')).toHaveAttribute(
      'data-projection',
      'flat',
    );
    expect(screen.getByRole('button', { name: 'Day/night' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(deckCapture.props?.viewState).toMatchObject({
      longitude: 75,
      latitude: 20,
      zoom: 2,
    });
    expect(
      deckCapture.props?.layers.some((layer) => layer && layer.id === 'world-terminator'),
    ).toBe(false);
  });

  it('reduces detail and offers the flat view after sustained active low fps', () => {
    localStorage.setItem(WORLD_PROJECTION_STORAGE_KEY, 'globe');
    renderRenderer();

    act(() => {
      for (let sample = 0; sample < 4; sample += 1) {
        deckCapture.props?._onMetrics({ fps: 40, framesRedrawn: 60 });
      }
    });

    expect(screen.getByRole('status')).toHaveTextContent('Reduced detail is active');
    expect(screen.getByLabelText('Interactive world renderer')).toHaveAttribute(
      'data-quality',
      'reduced',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Switch to flat' }));
    expect(screen.getByLabelText('Interactive world renderer')).toHaveAttribute(
      'data-projection',
      'flat',
    );
  });

  it('keeps the shell usable when deck.gl reports a renderer failure', () => {
    renderRenderer();
    act(() => deckCapture.props?.onError());
    expect(screen.getByRole('alert')).toHaveTextContent('The rest of Tailfin remains available');
  });
});
