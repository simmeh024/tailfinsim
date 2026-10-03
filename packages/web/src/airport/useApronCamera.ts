import { useCallback, useEffect, useRef, useState } from 'react';

import type { PointerEvent as ReactPointerEvent, RefObject } from 'react';

/**
 * Pan and zoom inside the airport schematic (M7-07, §H.2).
 *
 * §H.2's camera grammar is the world map's — *"drag, pinch/scroll zoom"* — and
 * its zoom is *"continuous through four bands: world → region → terminal area →
 * airport map"*. This is the last band. Zooming **in** is ordinary; zooming
 * **out** past the widest view is the way back up the bands, so it hands the
 * player back to the world map through `onExit` rather than stopping at a wall.
 *
 * ## The overscroll, and why it exists
 *
 * Zoom 1 is the whole airport fitted to the frame. Below it the picture keeps
 * shrinking — it visibly backs away — until {@link EXIT_ZOOM}, where the hand-off
 * fires. A hard stop at 1 would make the hand-off a single wheel notch from a
 * normal fit, which turns every slightly-too-eager scroll into leaving the
 * airport; a short run of shrinking first is the continuous part of
 * *continuous*, and it tells the player what is about to happen.
 *
 * The camera is SVG `viewBox` arithmetic in the layout's own units, so it is the
 * same whatever projection the world map is in — App. H.2 again: *"the airport
 * view is always a stylised 2D schematic regardless of projection"*.
 */

/** Where the hand-off to the world map fires. */
export const EXIT_ZOOM = 0.72;
export const MAX_ZOOM = 8;
/** One wheel notch (deltaY 100) zooms by about this much. */
const WHEEL_SENSITIVITY = 0.0018;
/** A pointer that moves less than this between down and up was a click, not a drag. */
const DRAG_THRESHOLD_PX = 4;

export interface CameraState {
  zoom: number;
  /** The centre of the view, in layout units. */
  cx: number;
  cy: number;
}

export interface ApronCamera {
  viewBox: string;
  zoom: number;
  /** Multiply the zoom about the view's centre; a result below {@link EXIT_ZOOM} exits. */
  zoomBy: (factor: number) => void;
  /** Back to the whole airport. */
  fit: () => void;
  /** True between a drag's start and the click it would otherwise produce. */
  wasDrag: () => boolean;
  pointerHandlers: {
    onPointerDown: (event: ReactPointerEvent<SVGSVGElement>) => void;
    onPointerMove: (event: ReactPointerEvent<SVGSVGElement>) => void;
    onPointerUp: (event: ReactPointerEvent<SVGSVGElement>) => void;
    onPointerCancel: (event: ReactPointerEvent<SVGSVGElement>) => void;
  };
}

/** The view box for a camera over a `width` × `height` layout. */
export function viewBoxFor(camera: CameraState, width: number, height: number): string {
  const w = width / camera.zoom;
  const h = height / camera.zoom;
  return `${String(camera.cx - w / 2)} ${String(camera.cy - h / 2)} ${String(w)} ${String(h)}`;
}

/**
 * The next camera after zooming by `factor` about `anchor` (layout units).
 *
 * At or below zoom 1 the airport is re-centred — the widest view is the whole
 * airport, centred — and above it the point under the cursor stays put, which is
 * what makes a wheel zoom feel like reaching for something rather than like the
 * picture sliding away.
 */
export function zoomCamera(
  camera: CameraState,
  factor: number,
  anchor: { x: number; y: number },
  width: number,
  height: number,
): CameraState {
  const zoom = Math.min(MAX_ZOOM, camera.zoom * factor);
  if (zoom <= 1) return { zoom, cx: width / 2, cy: height / 2 };
  const scale = camera.zoom / zoom;
  return clampCenter(
    {
      zoom,
      cx: anchor.x + (camera.cx - anchor.x) * scale,
      cy: anchor.y + (camera.cy - anchor.y) * scale,
    },
    width,
    height,
  );
}

/** Keep the centre over the airport, so a drag cannot lose it off the frame. */
function clampCenter(camera: CameraState, width: number, height: number): CameraState {
  return {
    zoom: camera.zoom,
    cx: Math.min(width, Math.max(0, camera.cx)),
    cy: Math.min(height, Math.max(0, camera.cy)),
  };
}

export function useApronCamera(
  svgRef: RefObject<SVGSVGElement | null>,
  width: number,
  height: number,
  onExit: () => void,
): ApronCamera {
  const [camera, setCamera] = useState<CameraState>({ zoom: 1, cx: width / 2, cy: height / 2 });
  const cameraRef = useRef(camera);
  cameraRef.current = camera;
  const exited = useRef(false);
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

  // A different airport, or the same one re-laid out bigger: start from the fit.
  useEffect(() => {
    setCamera({ zoom: 1, cx: width / 2, cy: height / 2 });
  }, [width, height]);

  /** Layout units per screen pixel, for the `meet` aspect the SVG uses. */
  const unitsPerPixel = useCallback((): number => {
    const rect = svgRef.current?.getBoundingClientRect();
    const c = cameraRef.current;
    if (rect === undefined || rect.width === 0 || rect.height === 0) return 1 / c.zoom;
    return Math.max(width / c.zoom / rect.width, height / c.zoom / rect.height);
  }, [svgRef, width, height]);

  /** A screen point in layout units; the view's centre when the frame has no size (tests). */
  const toLayout = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } => {
      const rect = svgRef.current?.getBoundingClientRect();
      const c = cameraRef.current;
      if (rect === undefined || rect.width === 0 || rect.height === 0) return { x: c.cx, y: c.cy };
      const units = unitsPerPixel();
      return {
        x: c.cx + (clientX - (rect.left + rect.width / 2)) * units,
        y: c.cy + (clientY - (rect.top + rect.height / 2)) * units,
      };
    },
    [svgRef, unitsPerPixel],
  );

  const applyZoom = useCallback(
    (factor: number, anchor: { x: number; y: number }) => {
      const current = cameraRef.current;
      const next = current.zoom * factor;
      if (next < EXIT_ZOOM) {
        // Once: a wheel that keeps spinning after the hand-off must not call it again.
        if (!exited.current) {
          exited.current = true;
          onExitRef.current();
        }
        return;
      }
      const updated = zoomCamera(current, factor, anchor, width, height);
      cameraRef.current = updated;
      setCamera(updated);
    },
    [width, height],
  );

  /*
   * The wheel, attached natively and non-passive.
   *
   * React registers `wheel` as a passive listener, so `preventDefault` in an
   * `onWheel` prop is ignored and the page behind the map scrolls while the map
   * zooms. A listener of our own is the only way to keep the gesture to the map.
   */
  useEffect(() => {
    const svg = svgRef.current;
    if (svg === null) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const delta = event.deltaMode === 1 ? event.deltaY * 33 : event.deltaY;
      applyZoom(Math.exp(-delta * WHEEL_SENSITIVITY), toLayout(event.clientX, event.clientY));
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [svgRef, applyZoom, toLayout]);

  /* Drag to pan, two fingers to pinch. */
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const travelled = useRef(0);
  const dragged = useRef(false);

  const onPointerDown = useCallback((event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 1) {
      travelled.current = 0;
      dragged.current = false;
    }
    const target = event.currentTarget;
    if (typeof target.setPointerCapture === 'function') {
      try {
        target.setPointerCapture(event.pointerId);
      } catch {
        // A pointer the browser has already released; panning still works without capture.
      }
    }
  }, []);

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      const previous = pointers.current.get(event.pointerId);
      if (previous === undefined) return;
      const point = { x: event.clientX, y: event.clientY };

      if (pointers.current.size >= 2) {
        // Pinch: the change in distance between the two fingers is the zoom.
        const [a, b] = [...pointers.current.entries()];
        if (a === undefined || b === undefined) return;
        const other = a[0] === event.pointerId ? b[1] : a[1];
        const before = Math.hypot(previous.x - other.x, previous.y - other.y);
        const after = Math.hypot(point.x - other.x, point.y - other.y);
        pointers.current.set(event.pointerId, point);
        dragged.current = true;
        if (before > 0 && after > 0) {
          applyZoom(after / before, toLayout((point.x + other.x) / 2, (point.y + other.y) / 2));
        }
        return;
      }

      const dx = point.x - previous.x;
      const dy = point.y - previous.y;
      pointers.current.set(event.pointerId, point);
      travelled.current += Math.hypot(dx, dy);
      if (travelled.current < DRAG_THRESHOLD_PX) return;
      dragged.current = true;
      const units = unitsPerPixel();
      const current = cameraRef.current;
      const next = clampCenter(
        { zoom: current.zoom, cx: current.cx - dx * units, cy: current.cy - dy * units },
        width,
        height,
      );
      cameraRef.current = next;
      setCamera(next);
    },
    [applyZoom, toLayout, unitsPerPixel, width, height],
  );

  const onPointerEnd = useCallback((event: ReactPointerEvent<SVGSVGElement>) => {
    pointers.current.delete(event.pointerId);
  }, []);

  const zoomBy = useCallback(
    (factor: number) => {
      const c = cameraRef.current;
      applyZoom(factor, { x: c.cx, y: c.cy });
    },
    [applyZoom],
  );

  const fit = useCallback(() => {
    const next = { zoom: 1, cx: width / 2, cy: height / 2 };
    cameraRef.current = next;
    setCamera(next);
  }, [width, height]);

  const wasDrag = useCallback(() => dragged.current, []);

  return {
    viewBox: viewBoxFor(camera, width, height),
    zoom: camera.zoom,
    zoomBy,
    fit,
    wasDrag,
    pointerHandlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: onPointerEnd,
      onPointerCancel: onPointerEnd,
    },
  };
}
