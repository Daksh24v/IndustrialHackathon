/** Drag with one finger, pinch with two: the drawing follows the fingers (a cheap transform), and when they
 * let go the scene redraws itself sharp at the new place and size (onCommit). A tap that doesn't move calls
 * onTap with the finger's position on the page ("I'm here"). On the web the mouse wheel (and a trackpad pinch)
 * zooms about the cursor; a click is a tap. */
import { type RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Animated, PanResponder } from 'react-native';

export interface Move {
  k: number; // zoom about the screen centre
  tx: number; // then shift, in pixels
  ty: number;
}

const MIN_ZOOM = 0.4;
const MAX_ZOOM = 6;
const TAP_SLOP_PX = 6;
const WHEEL_ZOOM = 0.0015; // per pixel of wheel travel
const LINE_PX = 16; // wheels that count in lines

/** One move, then another: what both do together. */
export function compose(first: Move, then: Move): Move {
  return { k: first.k * then.k, tx: then.k * first.tx + then.tx, ty: then.k * first.ty + then.ty };
}

/** A wheel turn as a move: zoom in for a wheel pushed away (deltaY < 0), keeping the point under the cursor
 * (x, y in the view) where it is. */
export function wheelMove(deltaY: number, deltaMode: number, [x, y]: [number, number], width: number,
                          height: number): Move {
  const pixels = deltaMode === 1 ? deltaY * LINE_PX : deltaMode === 2 ? deltaY * height : deltaY;
  const k = Math.exp(-Math.max(-300, Math.min(300, pixels)) * WHEEL_ZOOM);
  return { k, tx: (1 - k) * (x - width / 2), ty: (1 - k) * (y - height / 2) };
}

export function useMapGestures(
  width: number,
  height: number,
  onCommit: (move: Move) => void,
  onTap?: (page: [number, number]) => void,
  frame?: RefObject<unknown>,
) {
  const translate = useRef(new Animated.ValueXY()).current;
  const zoom = useRef(new Animated.Value(1)).current;
  const commit = useRef(onCommit);
  commit.current = onCommit;
  const tap = useRef(onTap);
  useLayoutEffect(() => {
    tap.current = onTap;
  }, [onTap]);
  const size = useRef({ width, height });
  size.current = { width, height };
  const [settled, setSettled] = useState(0);

  const responder = useMemo(() => {
    const move = { k: 1, tx: 0, ty: 0 };
    let last: { x: number; y: number } | null = null;
    let pinch: { d: number; mx: number; my: number; k: number; tx: number; ty: number } | null = null;
    let pressed: { x: number; y: number; moved: boolean } | null = null;
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
      onStartShouldSetPanResponder: () => tap.current !== undefined,
      onMoveShouldSetPanResponder: (event, g) =>
        event.nativeEvent.touches.length > 1 || Math.abs(g.dx) + Math.abs(g.dy) > 4,
      onPanResponderGrant: (event) => {
        pressed = { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY, moved: false };
      },
      onPanResponderMove: (event, g) => {
        const touches = event.nativeEvent.touches;
        if (pressed && (touches.length > 1 || Math.abs(g.dx) + Math.abs(g.dy) > TAP_SLOP_PX)) pressed.moved = true;
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
      onPanResponderRelease: () => {
        if (pressed && !pressed.moved) tap.current?.([pressed.x, pressed.y]);
        pressed = null;
        finish();
      },
      onPanResponderTerminate: () => {
        pressed = null;
        finish();
      },
    });
  }, [translate, zoom]);

  // The mouse wheel (web): zoom about the cursor, one redraw per animation frame however fast it turns.
  useEffect(() => {
    const node = frame?.current as HTMLElement | null | undefined;
    if (!node || typeof node.addEventListener !== 'function') return;
    let pending: Move | null = null;
    let request: number | null = null;
    const flush = () => {
      request = null;
      if (pending) commit.current(pending);
      pending = null;
    };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault(); // zoom the map, not the page
      const box = node.getBoundingClientRect();
      const { width: w, height: h } = size.current;
      const step = wheelMove(event.deltaY, event.deltaMode, [event.clientX - box.left, event.clientY - box.top], w, h);
      pending = pending ? compose(pending, step) : step;
      if (request === null) request = requestAnimationFrame(flush);
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      node.removeEventListener('wheel', onWheel);
      if (request !== null) cancelAnimationFrame(request);
    };
  }, [frame]);

  // The redrawn scene is on screen now: drop the temporary transform in the same frame.
  useLayoutEffect(() => {
    translate.setValue({ x: 0, y: 0 });
    zoom.setValue(1);
  }, [settled, translate, zoom]);

  return {
    panHandlers: responder.panHandlers,
    style: { transform: [{ translateX: translate.x }, { translateY: translate.y }, { scale: zoom }],
             cursor: onTap ? ('pointer' as const) : undefined }, // a click says "I'm here"
  };
}

/** A point on screen after a move (zoom about the centre, then shift). */
export function moved(move: Move, width: number, height: number, [x, y]: [number, number]): [number, number] {
  return [width / 2 + move.k * (x - width / 2) + move.tx, height / 2 + move.k * (y - height / 2) + move.ty];
}
