/** A button with a soft glow that follows the mouse inside it: the glow grows in on hover, sits under the cursor
 * as it moves and shrinks away when it leaves; the text takes the hover colour. Web only (a plain <button>); the
 * colours come in as props, the shape and size from the className (finni.css). */
import { type ButtonHTMLAttributes, type MouseEvent, useRef, useState } from 'react';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  glowColor?: string;
  backgroundColor?: string;
  textColor?: string;
  hoverTextColor?: string;
}

export function HoverGlowButton({
  children, className = '', glowColor = '#ff7a00', backgroundColor = '#0b0f14', textColor = '#ffffff',
  hoverTextColor = '#ffb36b', onMouseMove, onMouseEnter, onMouseLeave, style, ...rest
}: Props) {
  const button = useRef<HTMLButtonElement>(null);
  const [glow, setGlow] = useState({ x: 0, y: 0 });
  const [hovered, setHovered] = useState(false);
  const follow = (event: MouseEvent<HTMLButtonElement>) => {
    const box = button.current?.getBoundingClientRect();
    if (box) setGlow({ x: event.clientX - box.left, y: event.clientY - box.top });
  };

  return (
    <button
      ref={button}
      type="button"
      {...rest}
      className={`fi-glow ${className}`}
      data-hovered={hovered || undefined}
      style={{ ...style, backgroundColor, color: hovered ? hoverTextColor : textColor }}
      onMouseMove={(event) => {
        follow(event);
        onMouseMove?.(event);
      }}
      onMouseEnter={(event) => {
        follow(event);
        setHovered(true);
        onMouseEnter?.(event);
      }}
      onMouseLeave={(event) => {
        setHovered(false);
        onMouseLeave?.(event);
      }}
    >
      <span className="fi-glow-light" aria-hidden="true"
            style={{ left: glow.x, top: glow.y, background: `radial-gradient(circle, ${glowColor} 10%, transparent 70%)` }} />
      <span className="fi-glow-text">{children}</span>
    </button>
  );
}
