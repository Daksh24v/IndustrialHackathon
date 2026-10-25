/** Light / dark: a round button with the sun (in the dark) or the moon (in the light). The new look opens from the
 * middle of the screen (a View Transition with a clip-path reveal), where the browser has them; otherwise it just
 * switches. Adapted from the AnimatedThemeToggleButton design, without Tailwind, framer-motion or lucide. */
import type { ThemeName } from '../theme';

export type ThemeTransition = 'horizontal' | 'vertical';

const REVEAL: Record<ThemeTransition, string[]> = {
  horizontal: ['inset(50% 0 50% 0)', 'inset(0 0 0 0)'],
  vertical: ['inset(0 50% 0 50%)', 'inset(0 0 0 0)'],
};

type ViewTransitionDocument = Document & { startViewTransition?: (update: () => void) => { ready: Promise<void> } };

/** Run the switch inside a view transition (when there is one), then open the new look from the middle. */
export function switchWithTransition(update: () => void, type: ThemeTransition = 'horizontal'): void {
  const doc = document as ViewTransitionDocument;
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (!doc.startViewTransition || reduced) {
    update();
    return;
  }
  doc.startViewTransition(update).ready
    .then(() => document.documentElement.animate(
      { clipPath: REVEAL[type] },
      { duration: 700, easing: 'ease-in-out', pseudoElement: '::view-transition-new(root)' },
    ))
    .catch(() => {});
}

export function ThemeToggle({ theme, onToggle }: { theme: ThemeName; onToggle: () => void }) {
  const dark = theme === 'dark';
  return (
    <button type="button" className="fi-theme" onClick={onToggle} data-testid="theme-toggle" data-theme={theme}
            aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'} title={dark ? 'Light mode' : 'Dark mode'}>
      {dark ? (
        <svg key="sun" className="fi-theme-icon sun" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
        </svg>
      ) : (
        <svg key="moon" className="fi-theme-icon moon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
        </svg>
      )}
    </button>
  );
}
