/** FINNI's dotted sphere as a canvas: 40 px in the search bar, 140 px while you talk to it. */
import { useEffect, useRef } from 'react';

import { createSphere, type Sphere, type SphereMode } from '../orb/sphere';

const reduced = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export function OrbMark({ size, mode, className, testID }: { size: number; mode: SphereMode; className?: string; testID?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const sphere = useRef<Sphere | null>(null);
  useEffect(() => {
    if (!canvas.current) return;
    sphere.current = createSphere(canvas.current, size, reduced);
    return () => sphere.current?.destroy();
  }, [size]);
  useEffect(() => sphere.current?.setMode(mode), [mode]);
  return <canvas ref={canvas} className={className} style={{ width: size, height: size }} data-testid={testID}
                 data-mode={mode} aria-hidden="true" />;
}
