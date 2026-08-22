import type { MapViewState } from '@deck.gl/core';

export function clampViewState(viewState: MapViewState): MapViewState {
  return {
    ...viewState,
    longitude: ((viewState.longitude + 540) % 360) - 180,
    latitude: Math.min(85, Math.max(-85, viewState.latitude)),
    zoom: Math.min(12, Math.max(-0.5, viewState.zoom)),
    pitch: 0,
    bearing: 0,
  };
}

export function focusViewState(
  viewState: MapViewState,
  coordinate: readonly [number, number],
): MapViewState {
  return clampViewState({
    ...viewState,
    longitude: coordinate[0],
    latitude: coordinate[1],
    zoom: viewState.zoom + 1,
  });
}
