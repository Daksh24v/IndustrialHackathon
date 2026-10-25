/** "Start": one step at a time, like a map app's navigation. The banner says what to do next and how far; Next
 * moves on (and changes floor at stairs and lifts), Back goes back, × or Escape stops. */
import { useEffect } from 'react';

import type { Step } from '../steps';
import { StepIcon } from './icons';

interface Props {
  steps: Step[];
  index: number;
  left: number;
  right: number;
  onNext: () => void;
  onBack: () => void;
  onStop: () => void;
}

export function WalkBanner({ steps, index, left, right, onNext, onBack, onStop }: Props) {
  const step = steps[index];
  const last = index >= steps.length - 1;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement)?.tagName === 'INPUT') return;
      if (event.key === 'Escape') onStop();
      if (event.key === 'ArrowRight' && !last) onNext();
      if (event.key === 'ArrowLeft' && index > 0) onBack();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, last, onNext, onBack, onStop]);
  if (!step) return null;
  const lead = step.kind === 'arrive' ? (step.walk_m ? `In ${step.walk_m} m` : 'Here') : step.walk_m ? `In ${step.walk_m} m` : 'Now';
  return (
    <div className="fi fi-walk" style={{ left, right }} role="status" aria-live="polite" data-testid="walk">
      <span className="ic"><StepIcon kind={step.kind} action={step.action} /></span>
      <div>
        <small>{lead} · step {index + 1} of {steps.length}</small>
        <b data-testid="walk-step">{step.kind === 'arrive' && last ? `${step.action.replace('Arrive at', "You've arrived at")}` : step.action}</b>
        {step.near && <span className="near">{step.near}</span>}
      </div>
      <nav>
        <button type="button" aria-label="Back" data-testid="walk-back" disabled={index === 0} onClick={onBack}>‹</button>
        {last ? (
          <button type="button" className="next" data-testid="walk-done" onClick={onStop}>Done</button>
        ) : (
          <button type="button" className="next" data-testid="walk-next" onClick={onNext}>Next ›</button>
        )}
        <button type="button" aria-label="Stop" data-testid="walk-stop" onClick={onStop}>×</button>
      </nav>
    </div>
  );
}
