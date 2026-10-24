/** Drag with one finger (or the mouse), pinch with two: the drawing follows the fingers (a cheap transform), and
 * when they let go the scene redraws itself sharp at the new place and size (onCommit). In a browser the
 * mouse wheel or a trackpad pinch zooms about the pointer. */
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Animated, PanResponder, Platform } from 'react-native';

export interface Move {
  k: number; // zoom about the screen centre
  tx: number; // then shift, in pixels
  ty: number;
}

const MIN_ZOOM = 0.4;
const MAX_ZOOM = 6;
const WHEEL_ZOOM = 0.0025; // per pixel of wheel movement

/** The move for zooming by k while the point (x, y) on screen stays where it is. */
export function zoomAt(k: number, x: number, y: number, width: number, height: number): Move {
  return { k, tx: (1 - k) * (x - width / 2), ty: (1 - k) * (y - height / 2) };
}

export function useMapGestures(width: number, height: number, onCommit: (move: Move) => void) {
  const translate = useRef(new Animated.ValueXY()).current;
  const zoom = useRef(new Animated.Value(1)).current;
  const commit = useRef(onCommit);
  commit.current = onCommit;
  const size = useRef({ width, height });
  size.current = { width, height };
  const [settled, setSettled] = useState(0);

  const responder = useMemo(() => {
    const move = { k: 1, tx: 0, ty: 0 };
    let last: { x: number; y: number } | null = null;
    let pinch: { d: number; mx: number; my: number; k: number; tx: number; ty: number } | null = null;
    const finish = () => {
      if (move.k !== 1 || move.tx !== 0 || move.ty !== 0) {
        commit.current({ ...move });
        setSettled((n) => n + 1);
      }
      move.k = 1;
      move.tx = 0;
      move.ty = 0;
      last = null;
      pinch = null;
    };
    return PanResponder.create({
      onMoveShouldSetPanResponder: (event, g) =>
        event.nativeEvent.touches.length > 1 || Math.abs(g.dx) + Math.abs(g.dy) > 4,
      onPanResponderMove: (event) => {
        const touches = event.nativeEvent.touches;
        const cx = size.current.width / 2;
        const cy = size.current.height / 2;
        if (touches.length >= 2) {
          const [a, b] = touches;
          const d = Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY) || 1;
          const mx = (a.pageX + b.pageX) / 2;
          const my = (a.pageY + b.pageY) / 2;
          if (!pinch) pinch = { d, mx, my, k: move.k, tx: move.tx, ty: move.ty };
          move.k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, (pinch.k * d) / pinch.d));
          // keep the point under the fingers under the fingers
          move.tx = mx - cx - (move.k * (pinch.mx - cx - pinch.tx)) / pinch.k;
          move.ty = my - cy - (move.k * (pinch.my - cy - pinch.ty)) / pinch.k;
          last = null;
        } else if (touches.length === 1) {
          const { pageX: x, pageY: y } = touches[0];
          if (last) {
            move.tx += x - last.x;
            move.ty += y - last.y;
          }
          last = { x, y };
          pinch = null;
        }
        translate.setValue({ x: move.tx, y: move.ty });
        zoom.setValue(move.k);
      },
      onPanResponderRelease: finish,
      onPanResponderTerminate: finish,
    });
  }, [translate, zoom]);

  // The redrawn scene is on screen now: drop the temporary transform in the same frame.
  useLayoutEffect(() => {
    translate.setValue({ x: 0, y: 0 });
    zoom.setValue(1);
  }, [settled, translate, zoom]);

  // Browser: the wheel (and a trackpad pinch, which arrives as a wheel with ctrlKey) zooms about the pointer.
  const wheelCleanup = useRef<(() => void) | null>(null);
  const ref = useCallback((node: unknown) => {
    wheelCleanup.current?.();
    wheelCleanup.current = null;
    const element = node as HTMLElement | null;
    if (Platform.OS !== 'web' || !element || typeof element.addEventListener !== 'function') return;
    let pending = 0;
    let frame: number | null = null;
    let at = { x: 0, y: 0 };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const box = element.getBoundingClientRect();
      at = { x: event.clientX - box.left, y: event.clientY - box.top };
      pending += event.deltaY * (event.ctrlKey ? 4 : 1);
      if (frame === null) {
        frame = requestAnimationFrame(() => {
          const k = Math.min(1.6, Math.max(1 / 1.6, Math.exp(-pending * WHEEL_ZOOM)));
          pending = 0;
          frame = null;
          commit.current(zoomAt(k, at.x, at.y, size.current.width, size.current.height));
        });
      }
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    wheelCleanup.current = () => element.removeEventListener('wheel', onWheel);
  }, []);

  return {
    ref,
    panHandlers: responder.panHandlers,
    style: { transform: [{ translateX: translate.x }, { translateY: translate.y }, { scale: zoom }] },
  };
}

/** A point on screen after a move (zoom about the centre, then shift). */
export function moved(move: Move, width: number, height: number, [x, y]: [number, number]): [number, number] {
  return [width / 2 + move.k * (x - width / 2) + move.tx, height / 2 + move.k * (y - height / 2) + move.ty];
}
