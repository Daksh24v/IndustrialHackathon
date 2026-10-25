/** The map buttons as a dock: the ones near the mouse swell, the rest stay small, like the macOS dock (here in a
 * column, so it follows the mouse up and down). Each button group grows towards the map (out of its right edge)
 * and the column spreads round the mouse so nothing overlaps, keeping what is under the mouse where it is. */
import { type RefObject, useEffect } from 'react';

const REACH_PX = 120; // how far from the mouse a button still swells
const MAX_SCALE = 1.35; // the one right under the mouse

export interface DockItem {
  top: number; // in the column, without any swelling
  height: number;
}

/** How much each item swells with the mouse this far down the column, and how far it moves up or down so the
 * column spreads round the mouse instead of overlapping. */
export function dockLayout(items: DockItem[], mouseY: number): { scale: number; dy: number }[] {
  const scales = items.map(({ top, height }) => {
    const distance = Math.abs(mouseY - (top + height / 2));
    const near = Math.max(0, 1 - distance / REACH_PX);
    return 1 + (MAX_SCALE - 1) * near * near * (3 - 2 * near); // smoothstep: a soft bump
  });
  const extra = items.map(({ height }, i) => height * (scales[i] - 1));
  // the growth above the mouse pushes up, the rest pushes down: what is under the mouse stays put
  const above = items.reduce((sum, { top, height }, i) =>
    sum + extra[i] * Math.min(1, Math.max(0, (mouseY - top) / height)), 0);
  let before = 0;
  return items.map((_, i) => {
    const dy = before + extra[i] / 2 - above;
    before += extra[i];
    return { scale: scales[i], dy };
  });
}

/** Swell the column's items (its direct children) as the mouse moves over it; back to normal when it leaves. */
export function useDock(column: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const node = column.current;
    if (!node || typeof window === 'undefined' || !window.matchMedia?.('(hover: hover)').matches) return;
    let frame: number | null = null;
    let y = 0;
    const items = () => Array.from(node.children) as HTMLElement[];
    const apply = () => {
      frame = null;
      const children = items();
      const layout = dockLayout(children.map((el) => ({ top: el.offsetTop, height: el.offsetHeight })), y);
      children.forEach((el, i) => {
        el.style.transform = `translateY(${layout[i].dy.toFixed(1)}px) scale(${layout[i].scale.toFixed(3)})`;
      });
    };
    const move = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse' || event.buttons) return; // not while dragging the compass
      y = event.clientY - node.getBoundingClientRect().top;
      if (frame === null) frame = requestAnimationFrame(apply);
    };
    const leave = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      items().forEach((el) => (el.style.transform = ''));
    };
    node.addEventListener('pointermove', move);
    node.addEventListener('pointerleave', leave);
    return () => {
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerleave', leave);
      leave();
    };
  }, [column]);
}
