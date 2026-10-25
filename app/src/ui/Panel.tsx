/** FINNI's answers beside the map: what it said, what it asks back (options to tap), and for a route what it
 * understood (from → to), how far, and the steps to follow with "Start". A column under the search card on
 * laptops; a bottom sheet with three heights on phones (drag the handle). */
import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react';

import type { MapView, Question } from '../api';
import { type Message, plain } from '../components/ChatCard';
import { bare, type Step, type Summary } from '../steps';
import { StepIcon } from './icons';

export type Snap = 'peek' | 'half' | 'full';
const PEEK_PX = 300;
export const sheetHeight = (snap: Snap, viewport: number) =>
  snap === 'peek' ? Math.min(PEEK_PX, viewport * 0.4) : snap === 'half' ? Math.round(viewport * 0.52) : viewport - 96;

interface Props {
  wide: boolean;
  messages: Message[];
  question: Question | null;
  map: MapView | null;
  steps: Step[];
  summary: Summary | null;
  busy: boolean;
  error: string | null;
  note: string | null;
  activeStep: number | null;
  onOption: (label: string) => void;
  onClose: () => void;
  onStepHover: (index: number | null) => void;
  onStepPick: (index: number) => void;
  onStart: () => void;
  snap: Snap;
  onSnap: (snap: Snap) => void;
}

export function Panel(props: Props) {
  const { wide, messages, question, map, steps, summary, busy, error, note, activeStep } = props;
  const [earlier, setEarlier] = useState(false);
  const lastSaid = [...messages].reverse().find((message) => message.from === 'guide');
  const lastAsked = [...messages].reverse().find((message) => message.from === 'you');
  const answered = lastSaid && messages.indexOf(lastSaid) > messages.indexOf(lastAsked!);
  const route = map?.route && summary ? map : null;

  const body = (
    <div className="fi-panel-body" data-testid="panel-body">
      <div className="fi-head">
        <i className="fi-dot" aria-hidden="true" />
        FINNI
        <button type="button" className="fi-close" aria-label="Close" data-testid="panel-close" onClick={props.onClose}>×</button>
      </div>
      {lastAsked && !answered && busy && (
        <>
          <p className="fi-note">“{lastAsked.text}”</p>
          <div className="fi-thinking" aria-label="FINNI is looking"><i /><i /></div>
        </>
      )}
      {error && <p className="fi-error" role="alert" data-testid="error">{error}</p>}
      {answered && <p className="fi-say" data-testid="answer">{plain(lastSaid.text)}</p>}
      {note && <p className="fi-note">{note}</p>}
      {question && !busy && (
        <div className="fi-options" data-testid="question">
          <p className="fi-ask">{question.question}</p>
          {question.options.map((option) => (
            <button key={option.label} type="button" className="fi-option" data-testid={`option-${option.label}`}
                    onClick={() => props.onOption(option.label)}>
              {option.label}
              {option.description && <small>{option.description}</small>}
            </button>
          ))}
        </div>
      )}
      {route && summary && !busy && (
        <div className="fi-route" data-testid="route-card">
          <div className="fi-understood" aria-label="Your route">
            <i className="a" />
            <span><small>From</small> <b data-testid="route-from">{route.you_are_here ? bare(route.you_are_here.label) : 'where you are'}</b></span>
            <i className="line" /><span />
            <i className="b" />
            <span><small>To</small> <b data-testid="route-to">{route.target ? bare(route.target.label) : 'there'}</b></span>
          </div>
          <div className="fi-sum">
            <strong data-testid="route-length">{summary.length_m} m</strong>
            <span>about {summary.minutes} min{summary.floors ? ` · ${summary.floors} floor${summary.floors > 1 ? 's' : ''} ${summary.up ? 'up' : 'down'}` : ''}</span>
            {summary.stepFree && <span className="fi-tag">step-free</span>}
          </div>
          <button type="button" className="fi-start" data-testid="start" onClick={props.onStart}>Start</button>
          <ol className="fi-steps" data-testid="steps">
            {steps.map((step, index) => (
              <li key={index}>
                <button type="button" className="fi-step" data-testid={`step-${index}`}
                        data-active={activeStep === index ? '' : undefined}
                        onMouseEnter={() => props.onStepHover(index)} onMouseLeave={() => props.onStepHover(null)}
                        onFocus={() => props.onStepHover(index)} onBlur={() => props.onStepHover(null)}
                        onClick={() => props.onStepPick(index)}>
                  <span className="ic"><StepIcon kind={step.kind} action={step.action} /></span>
                  <span><b>{step.action}</b>{step.near && <small>{step.near}</small>}</span>
                  <span className="m">{step.walk_m ? `${step.walk_m} m` : ''}</span>
                </button>
              </li>
            ))}
          </ol>
        </div>
      )}
      {messages.length > 2 && (
        <button type="button" className="fi-earlier" data-testid="earlier" onClick={() => setEarlier((open) => !open)}>
          {earlier ? 'Hide the conversation' : 'Show the conversation'}
        </button>
      )}
      {earlier && (
        <div className="fi-history" data-testid="history">
          {messages.map((message, i) => (
            <p key={i} className={message.from === 'you' ? 'you' : 'finni'}>{plain(message.text)}</p>
          ))}
        </div>
      )}
    </div>
  );

  if (wide) return <section className="fi-panel" aria-label="FINNI's answer" data-testid="panel">{body}</section>;
  return <Sheet snap={props.snap} onSnap={props.onSnap}>{body}</Sheet>;
}

/** The phone's bottom sheet: drag the handle (or tap it) between peek, half and full. */
function Sheet({ snap, onSnap, children }: { snap: Snap; onSnap: (snap: Snap) => void; children: React.ReactNode }) {
  const [drag, setDrag] = useState<number | null>(null);
  const start = useRef<{ y: number; h: number; moved: boolean } | null>(null);
  const viewport = typeof window !== 'undefined' ? window.innerHeight : 800;
  const height = drag ?? sheetHeight(snap, viewport);
  useEffect(() => setDrag(null), [snap]);

  const down = (event: ReactPointerEvent<HTMLButtonElement>) => {
    start.current = { y: event.clientY, h: height, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!start.current) return;
    const dy = event.clientY - start.current.y;
    if (Math.abs(dy) > 4) start.current.moved = true;
    setDrag(Math.max(120, Math.min(viewport - 96, start.current.h - dy)));
  };
  const up = () => {
    const began = start.current;
    start.current = null;
    if (!began) return;
    if (!began.moved) { // a tap cycles the heights
      onSnap(snap === 'peek' ? 'half' : snap === 'half' ? 'full' : 'peek');
      return;
    }
    const now = drag ?? height;
    const order: Snap[] = ['peek', 'half', 'full'];
    const nearest = order.reduce((best, s) =>
      Math.abs(sheetHeight(s, viewport) - now) < Math.abs(sheetHeight(best, viewport) - now) ? s : best, 'peek' as Snap);
    setDrag(null);
    onSnap(nearest);
  };

  return (
    <section className="fi fi-panel fi-sheet" aria-label="FINNI's answer" data-testid="panel" data-snap={snap}
             style={{ height, transition: drag !== null ? 'none' : undefined }}>
      <button type="button" className="fi-grab" aria-label="Resize" data-testid="sheet-handle"
              onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
      {children}
    </section>
  );
}
