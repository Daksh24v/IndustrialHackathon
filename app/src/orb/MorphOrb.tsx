/** The Finni home screen (web): a dotted orb rests in the middle of a black screen, the "Ask Finni…" pill sits
 * at the bottom. On send the pill shrinks into a ball, flies up into the orb, the orb thinks (rotating labels)
 * until the answer is there, turns green, condenses and unfolds into the answer card (with the agent's
 * options as chips when it asks back). Timelines and the sphere live in motion.ts; this file plays them with
 * one DOM write pass per frame. Built from the MorphOrb design, extended with the resting orb, answer chips,
 * the microphone and the measured card height. */
import React, { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";

import type { MicState } from "../useVoice";
import {
  ABORT, abortable, ASSEMBLE, bez, BALL_SMALL, CANVAS, CARD_H, cardW, clamp01, COLORS, CONDENSE, DS, DU, DX, DY, DZ, E,
  FADE, fmt, G_STEPS, A_STEPS, homeDy, INIT, launchTracks, N, ORB_D, ORB_R, pillW, R_CONDENSE, R_GREEN_OUT,
  R_IN, R_OUT, R_RESOLVE, rCardIn, RESOLVE, sampleAt, sleep, T, TAU, unfoldTracks,
  type Geo, type Sample, type Track,
} from "./motion";
import "./orb.css";

/* ───────────────────────────── copy ───────────────────────────── */
const COPY = {
  placeholder: "Ask Finni…",
  labels: ["Thinking", "Searching the building", "Finding the way", "Composing"],
  done: "Done",
  answerTitle: "Finni",
  answerBody: "Sorry, I couldn't answer that. Try again?",
  reset: "New question",
  send: "Send",
};
const REST_ALPHA = 0.9; // the resting orb, before anyone asks

type Phase = "idle" | "launch" | "assemble" | "think" | "resolve" | "condense" | "unfold" | "answered" | "reset";

export interface OrbAnswer {
  text: string;
  options?: { label: string; description?: string }[];
}

export interface OrbHandle {
  /** Ask as if typed and sent (voice uses this); after an answer it starts a new round. */
  ask(text: string): void;
}

export interface MorphOrbProps {
  onSubmit: (text: string) => Promise<OrbAnswer>;
  onAnswered?: (answer: OrbAnswer) => void;
  minThinkMs?: number;
  speed?: number;
  mic?: MicState;
  onMic?: () => void;
  onOpenMap?: () => void; // shows a "Map" button when there's a route to go back to
  notice?: string; // something went wrong (e.g. the server can't be reached)
  handleRef?: React.Ref<OrbHandle>;
}

const MIC_HINT: Record<MicState, string> = {
  off: "",
  listening: "Listening… pause when you're done",
  thinking: "",
  speaking: "Speaking… tap the mic to interrupt",
};

/* ───────────────────────────── dotted orb ───────────────────────────── */
interface OrbParams {
  k: number; alpha: number; spin: number; rot: number; sweep: number; pop: number;
  vortex: number; gain: number; floor: number; rad: number; prog: number;
}
const ORB_KEYS = ["k", "alpha", "spin", "sweep", "pop", "vortex", "gain", "floor", "rad"] as const;

function createOrb(canvas: HTMLCanvasElement, getSpeed: () => number, isReduced: () => boolean) {
  const P: OrbParams = { k: 0, alpha: 0, spin: 0, rot: 0, sweep: 0, pop: 1, vortex: 0, gain: 1, floor: 0, rad: 0, prog: 0 };
  const ctx = canvas.getContext("2d");
  const lit = new Float32Array(N);
  const SX = new Float32Array(N), SY = new Float32Array(N), SR = new Float32Array(N), SD = new Float32Array(N);
  const SC = new Int16Array(N);
  const pw = [1, 0, 0, 0];
  let time = 0, raf = 0, last = 0, dead = false;

  const reset = () => {
    P.k = 0; P.alpha = 0; P.spin = 0; P.rot = 0; P.sweep = 0; P.pop = 1; P.vortex = 0; P.gain = 1; P.floor = 0; P.rad = 0; P.prog = 0;
    lit.fill(0);
    pw[0] = 1; pw[1] = 0; pw[2] = 0; pw[3] = 0;
    time = isReduced() ? 1.2 : 0;
  };
  reset();

  if (!ctx) return { P, ensure() {}, reset, destroy() {} };

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(CANVAS * dpr);
  canvas.height = Math.round(CANVAS * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const S = 0.6, CP = Math.cos(0.35), SP = Math.sin(0.35), C0 = CANVAS / 2;

  const draw = (dt: number) => {
    ctx.clearRect(0, 0, CANVAS, CANVAS);
    time += dt;
    P.rot += P.spin * dt;
    const yaw = P.rot + P.vortex, cyw = Math.cos(yaw), syw = Math.sin(yaw);
    const stepW = dt / 0.35;
    for (let q = 0; q < 4; q++) {
      const d = (q === P.prog ? 1 : 0) - pw[q];
      pw[q] += Math.abs(d) <= stepW ? d : d > 0 ? stepW : -stepW;
    }
    const decay = Math.exp(-dt / 0.5);
    const h0 = (time * 300) % N, h3 = (time * 480) % N;
    const a1 = time * 0.8, b1 = Math.sin(time * 0.5) * 0.9;
    const f1x = Math.cos(b1) * Math.cos(a1), f1y = Math.sin(b1), f1z = Math.cos(b1) * Math.sin(a1);
    const a2 = time * 0.55 + 2.1, b2 = Math.cos(time * 0.42) * 0.9;
    const f2x = Math.cos(b2) * Math.cos(a2), f2y = Math.sin(b2), f2z = Math.cos(b2) * Math.sin(a2);
    const lat = Math.sin(time * 2.2);
    const swirlK = P.vortex * 1.5;

    for (let n = 0; n < N; n++) {
      const dx = DX[n], dy = DY[n], dz = DZ[n], u = DU[n];

      /* light programs: dots are lit in turn */
      let pulse = 0;
      if (pw[0] > 0.001) {
        let dd = Math.abs(n - h0); if (dd > N - dd) dd = N - dd;
        const v = Math.max(0, 1 - dd / 16);
        pulse = Math.max(pulse, v * v * pw[0]);
      }
      if (pw[1] > 0.001) {
        const v1 = Math.max(0, (dx * f1x + dy * f1y + dz * f1z - 0.72) / 0.28);
        const v2 = Math.max(0, (dx * f2x + dy * f2y + dz * f2z - 0.72) / 0.28);
        const v = Math.max(v1, v2);
        pulse = Math.max(pulse, v * v * pw[1]);
      }
      if (pw[2] > 0.001) {
        const e = dy - lat;
        const v = Math.max(0, 1 - (e * e) / 0.02);
        pulse = Math.max(pulse, v * v * pw[2]);
      }
      if (pw[3] > 0.001) {
        let dd = Math.abs(n - h3); if (dd > N - dd) dd = N - dd;
        const v = Math.max(0, 1 - dd / 22);
        pulse = Math.max(pulse, v * v * pw[3]);
      }
      const l = Math.max(lit[n] * decay, pulse * P.gain);
      lit[n] = l;

      /* per-dot appearance: top dots first, bottom collapse first */
      const ki = clamp01(P.k * (1 + S) - S * u);
      if (ki <= 0.001) { SC[n] = -1; continue; }
      const eo = E.out(ki), kk = eo * P.pop;

      const x1 = dx * cyw + dz * syw, z1 = -dx * syw + dz * cyw;
      const y2 = dy * CP - z1 * SP, z2 = dy * SP + z1 * CP;
      const f = 2.8 / (2.8 - z2), depth = (z2 + 1) / 2;
      let ox = x1 * ORB_R * kk * f, oy = -y2 * ORB_R * kk * f;
      if (swirlK > 0.001) {
        const sw = (1 - ki) * swirlK, cc = Math.cos(sw), ss = Math.sin(sw);
        const tx = ox * cc - oy * ss;
        oy = ox * ss + oy * cc;
        ox = tx;
      }

      const g = clamp01((P.sweep * 1.4 - u) / 0.4);
      let a = 0.22 + 0.035 * Math.sin(DS[n] + time * 1.6) * (1 - g) + 0.36 * depth * depth + 0.75 * l * (1 - g) + g * (0.55 + 0.4 * depth) + 2 * g * (1 - g);
      a = Math.max(a, P.floor * (0.7 + 0.3 * depth));
      if (a > 1) a = 1;
      a *= eo * P.alpha;

      SX[n] = C0 + ox;
      SY[n] = C0 + oy;
      SD[n] = depth;
      SR[n] = (1.15 * (0.45 + 0.75 * depth) * f + 0.9 * l + g * 0.25) * (1 + P.rad) * (0.4 + 0.6 * eo);
      const ai = Math.round(a * A_STEPS), gi = Math.round(g * G_STEPS);
      SC[n] = ai <= 0 ? -1 : gi * (A_STEPS + 1) + ai;
    }

    /* two passes: back half first, then front half */
    for (let pass = 0; pass < 2; pass++) {
      for (let n = 0; n < N; n++) {
        const c = SC[n];
        if (c < 0) continue;
        if ((SD[n] >= 0.5) !== (pass === 1)) continue;
        ctx.fillStyle = COLORS[c];
        ctx.beginPath();
        ctx.arc(SX[n], SY[n], SR[n], 0, TAU);
        ctx.fill();
      }
    }
  };

  const frame = (now: number) => {
    raf = 0;
    if (dead) return;
    const dt = isReduced() ? 0 : Math.max(0, Math.min(0.05, (now - last) / 1000)) * getSpeed();
    last = now;
    draw(dt);
    if (P.alpha > 0.002) raf = requestAnimationFrame(frame);
    else ctx.clearRect(0, 0, CANVAS, CANVAS);
  };

  const ensure = () => {
    if (raf || dead || P.alpha <= 0.002) return;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  };

  const destroy = () => {
    dead = true;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };

  return { P, ensure, reset, destroy };
}

/* ───────────────────────────── runtime ───────────────────────────── */
interface UI {
  setPhase(p: Phase): void;
  swapLabel(name: string): void;
  resetLabel(): void;
  setAnswer(a: OrbAnswer | null): void;
  clearInput(): void;
  live(s: string): void;
  lock(on: boolean): void;
  idleReady(): void;
  focusAnswer(): void;
  answered(a: OrbAnswer): void;
}
interface Env {
  root: HTMLElement; mover: HTMLElement; actor: HTMLElement; form: HTMLElement; ghosts: HTMLElement[];
  canvas: HTMLCanvasElement; restCanvas: HTMLCanvasElement; pulse: HTMLElement; status: HTMLElement;
  getBody: () => HTMLElement | null;
  measureCard: () => number;
  ui: UI; getSpeed: () => number; isReduced: () => boolean;
}
interface RunCfg { onSubmit: (text: string) => Promise<OrbAnswer>; minThink: number }
interface Runtime {
  start(text: string, cfg: RunCfg): boolean;
  escape(): void;
  reset(): void;
  hard(): void;
  home(): void;
  busy(): boolean;
  destroy(): void;
}

const frames = (count: number) =>
  new Promise<void>((res) => {
    const next = (left: number) => (left <= 0 ? res() : requestAnimationFrame(() => next(left - 1)));
    next(count);
  });

function createRuntime(env: Env): Runtime {
  const { actor, mover, root, status, pulse, ghosts, form } = env;
  const life = new AbortController();
  const geo: Geo = { pw: pillW(), cw: cardW(), ch: CARD_H, H: homeDy(), dir: -1 };
  const orb = createOrb(env.canvas, env.getSpeed, env.isReduced);
  const rest = createOrb(env.restCanvas, env.getSpeed, env.isReduced);
  rest.P.k = 1; rest.P.spin = 0.35; rest.P.gain = 0.7;
  const vals: Record<string, number> = {};
  const dirty = new Set<string>();
  const CH: Record<string, (v: number) => void> = {};

  let current: AbortController | null = null;
  let idleCtl: AbortController | null = null;
  let busy = false, idling = false, epoch = 0;
  let curX = 0, curY = 0, curD = BALL_SMALL, trailVis = 0, ghostsShown = false;
  let wStagger = 45, wDur = 320;
  const hist: Sample[] = [];
  const tmp: Sample = { t: 0, x: 0, y: 0, d: 0 };

  const child = () => {
    const ac = new AbortController();
    if (life.signal.aborted) ac.abort();
    else life.signal.addEventListener("abort", () => ac.abort(), { once: true });
    return ac;
  };
  const snapshot = () => {
    geo.pw = pillW(); geo.cw = cardW(); geo.H = homeDy();
    actor.style.setProperty("--cw", geo.cw + "px");
  };

  /* ── flight path + comet trail ── */
  const renderTrail = () => {
    if (trailVis <= 0.001) {
      if (ghostsShown) { ghosts.forEach((g) => (g.style.opacity = "0")); ghostsShown = false; }
      return;
    }
    ghostsShown = true;
    const now = performance.now();
    for (let i = 0; i < ghosts.length; i++) {
      sampleAt(hist, now - (i + 1) * 45, tmp);
      const k = (tmp.d * (1 - 0.08 * (i + 1))) / 100;
      const g = ghosts[i];
      g.style.transform = `translate3d(${(tmp.x - curX).toFixed(2)}px,${(tmp.y - curY).toFixed(2)}px,0) translate(-50%,-50%) scale(${k.toFixed(3)})`;
      g.style.opacity = (0.28 * Math.pow(1 - i / 6, 1.5) * trailVis).toFixed(3);
    }
  };

  const applyPath = () => {
    const u = vals.u ?? 0, H = geo.H;
    curX = bez(u, 0, geo.dir * 0.3 * H, 0);
    curY = bez(u, H, 0.6 * H, 0) + (vals.yOff ?? 0);
    mover.style.transform = `translate3d(${curX.toFixed(2)}px,${curY.toFixed(2)}px,0)`;
    const now = performance.now();
    hist.push({ t: now, x: curX, y: curY, d: curD });
    while (hist.length > 2 && hist[0].t < now - 500) hist.shift();
    renderTrail();
  };

  /* ── answer words ── */
  const applyWords = (v: number) => {
    const body = env.getBody();
    if (!body) return;
    const nodes = body.querySelectorAll<HTMLElement>(".mo-w");
    const total = (nodes.length - 1) * wStagger + wDur;
    const time = v * total;
    const reduced = env.isReduced();
    nodes.forEach((el, i) => {
      const p = E.out(clamp01((time - i * wStagger) / wDur));
      el.style.opacity = fmt(p);
      el.style.transform = p >= 0.999 || reduced ? "none" : `translateY(${fmt((1 - p) * 4)}px)`;
      el.style.filter = p >= 0.999 || reduced ? "none" : `blur(${fmt((1 - p) * 4)}px)`;
    });
  };

  /* ── channels ── */
  ["oGlow", "oHalo", "oPill", "oBall", "oGreen", "oCard", "oRing", "oInput", "oAur", "gs", "cs", "hOp", "dotS", "bloom"].forEach((n) => {
    CH[n] = (v) => actor.style.setProperty("--" + n, fmt(v));
  });
  ["w", "h", "r"].forEach((n) => {
    CH[n] = (v) => {
      actor.style.setProperty("--" + n, fmt(v) + "px");
      if (n === "w") curD = v;
    };
  });
  CH.inScale = (v) => {
    actor.style.setProperty("--inScale", fmt(v));
    form.style.filter = v >= 0.999 ? "none" : `blur(${fmt((1 - v) * 15)}px)`;
  };
  CH.sOp = (v) => status.style.setProperty("--sOp", fmt(v));
  CH.sTy = (v) => status.style.setProperty("--sTy", fmt(v));
  CH.cHalo = (v) => root.style.setProperty("--oCenter", fmt(v));
  CH.u = () => applyPath();
  CH.yOff = () => applyPath();
  CH.trail = (v) => { trailVis = v; renderTrail(); };
  CH.pulse = (v) => {
    if (v < 0) { pulse.style.opacity = "0"; return; }
    pulse.style.opacity = fmt(0.5 * (1 - v));
    pulse.style.transform = `scale(${fmt(1 + v)})`;
  };
  CH.wp = applyWords;
  CH.rest = (v) => {
    rest.P.alpha = REST_ALPHA * v;
    root.style.setProperty("--oRest", fmt(v));
    rest.ensure();
  };
  ORB_KEYS.forEach((name) => {
    CH["orb." + name] = (v) => {
      orb.P[name] = v;
      if (name === "alpha") orb.ensure();
    };
  });

  const set = (ch: string, v: number) => { vals[ch] = v; dirty.add(ch); };
  const flush = () => { dirty.forEach((ch) => CH[ch]?.(vals[ch])); dirty.clear(); };
  const setNow = (ch: string, v: number) => { vals[ch] = v; CH[ch]?.(v); };
  const resetChannels = () => {
    setNow("w", geo.pw);
    for (const ch of Object.keys(INIT)) setNow(ch, INIT[ch]);
  };

  /* ── timeline engine ── */
  const play = (tracks: Track[], sig: AbortSignal) =>
    new Promise<void>((res) => {
      if (sig.aborted) return res();
      const end = tracks.reduce((m, k) => Math.max(m, k.t1), 0);
      const done = new Set<Track>();
      let raf = 0, t = 0, last = performance.now();
      const onAbort = () => { cancelAnimationFrame(raf); res(); };
      const finish = () => { sig.removeEventListener("abort", onAbort); res(); };
      const step = (now: number) => {
        const dt = Math.max(0, Math.min(100, now - last));
        last = now;
        t += dt * env.getSpeed();
        for (const k of tracks) {
          if (done.has(k) || t < k.t0) continue;
          const p = Math.min(1, (t - k.t0) / Math.max(1, k.t1 - k.t0));
          set(k.ch, k.from + (k.to - k.from) * (k.ease ?? E.io)(p));
          if (p === 1) done.add(k);
        }
        flush(); // one DOM write pass per frame
        if (t >= end) finish(); else raf = requestAnimationFrame(step);
      };
      sig.addEventListener("abort", onAbort, { once: true });
      raf = requestAnimationFrame(step);
    });

  /* ── thinking labels ── */
  const labelLoop = async (sig: AbortSignal, ctl: { stop: boolean }) => {
    let i = 0;
    for (;;) {
      await sleep(1150 / env.getSpeed(), sig);
      if (sig.aborted || ctl.stop) return;
      i = (i + 1) % COPY.labels.length;
      orb.P.prog = i % 4;
      env.ui.swapLabel(COPY.labels[i]);
    }
  };

  /* ── the card's height: what the answer (and its chips) needs ── */
  const fitCard = async () => {
    await frames(2); // React has rendered the answer
    geo.ch = Math.round(Math.min(window.innerHeight * 0.62, Math.max(CARD_H, env.measureCard())));
  };

  /* ── orchestrator ── */
  const run = async (text: string, sig: AbortSignal, cfg: RunCfg) => {
    const reduced = env.isReduced();
    const go = async (tracks: Track[]) => {
      await play(tracks, sig);
      if (sig.aborted) throw ABORT;
    };
    try {
      env.ui.setPhase("launch");
      hist.length = 0;
      if (!reduced) {
        await go(launchTracks(geo));
        setNow("r", ORB_D / 2);
        env.ui.setPhase("assemble");
        await go(ASSEMBLE);
      } else {
        await go(R_OUT);
        setNow("u", 1); setNow("w", ORB_D); setNow("h", ORB_D); setNow("r", ORB_D / 2);
        setNow("sTy", 0); setNow("orb.k", 1); setNow("orb.spin", 0);
        env.ui.setPhase("assemble");
        await go(R_IN);
      }

      /* think — until the answer settled AND the minimum time elapsed */
      env.ui.setPhase("think");
      env.ui.live(COPY.labels[0]);
      const ctl = { stop: false };
      void labelLoop(sig, ctl);
      const t0 = performance.now();
      const fallback: OrbAnswer = { text: COPY.answerBody };
      const pending = Promise.resolve()
        .then(() => cfg.onSubmit(text))
        .then((a) => (a && typeof a.text === "string" && (a.text.trim() || a.options?.length) ? a : fallback), () => fallback);
      const got = await abortable(pending, sig);
      if (sig.aborted) throw ABORT;
      const answer = got ?? fallback;
      await sleep(cfg.minThink / env.getSpeed() - (performance.now() - t0), sig);
      ctl.stop = true;
      if (sig.aborted) throw ABORT;

      const words = answer.text.split(/\s+/).filter(Boolean);
      const n = Math.max(1, words.length);

      if (!reduced) {
        env.ui.setPhase("resolve");
        env.ui.swapLabel(COPY.done);
        await go(RESOLVE);

        env.ui.setPhase("condense");
        env.ui.setAnswer(answer);
        await Promise.all([go(CONDENSE), fitCard()]);

        env.ui.setPhase("unfold");
        wDur = 320;
        wStagger = n > 1 ? Math.min(45, 280 / (n - 1)) : 0;
        await go(unfoldTracks(geo, (n - 1) * wStagger + wDur));
      } else {
        env.ui.setPhase("resolve");
        env.ui.swapLabel(COPY.done);
        await go(R_RESOLVE);
        await sleep(350 / env.getSpeed(), sig);
        if (sig.aborted) throw ABORT;

        env.ui.setPhase("condense");
        setNow("gs", 1);
        env.ui.setAnswer(answer);
        await Promise.all([go(R_CONDENSE), fitCard()]);

        env.ui.setPhase("unfold");
        wDur = 250;
        wStagger = 0;
        await go(R_GREEN_OUT);
        setNow("w", geo.cw); setNow("h", geo.ch); setNow("r", 20); setNow("dotS", 1);
        await go(rCardIn(wDur));
      }

      env.ui.setPhase("answered");
      env.ui.live("Answer ready: " + answer.text);
      env.ui.focusAnswer();
      env.ui.answered(answer);
    } catch (e) {
      if (e === ABORT) return;
      hard();
    }
  };

  /* ── return to the idle pill ── */
  const toIdle = async (kind: "reset" | "esc") => {
    if (idling) return;
    idling = true;
    const my = ++epoch;
    const ac = child();
    idleCtl = ac;
    const sig = ac.signal;
    const outMs = kind === "reset" ? 240 : 200;
    const inMs = kind === "reset" ? 420 : 200;
    env.ui.setPhase("reset");

    const out: Track[] = [T("cHalo", vals.cHalo ?? 0, 0, 0, outMs, E.out)];
    for (const ch of FADE) {
      const v = vals[ch] ?? 0;
      if (v > 0.001) out.push(T(ch, v, 0, 0, outMs, E.out));
    }
    if (kind === "reset") out.push(T("cs", 1, 0.98, 0, outMs, E.out));
    await play(out, sig);
    if (sig.aborted || my !== epoch) return;

    setNow("pulse", -1);
    env.ui.setAnswer(null);
    env.ui.resetLabel();
    env.ui.clearInput();
    orb.reset();
    hist.length = 0;
    snapshot();
    resetChannels();
    const pillCh = ["oPill", "oInput", "oGlow", "oAur", "oRing", "rest"];
    pillCh.forEach((ch) => setNow(ch, 0));
    setNow("yOff", kind === "reset" ? 8 : 0);
    const inn: Track[] = pillCh.map((ch) => T(ch, 0, 1, 0, ch === "rest" ? inMs * 2 : inMs, E.out));
    if (kind === "reset") inn.push(T("yOff", 8, 0, 0, inMs, E.out));
    await play(inn, sig);
    if (sig.aborted || my !== epoch) return;

    resetChannels();
    current = null; idleCtl = null; busy = false; idling = false;
    env.ui.lock(false);
    env.ui.setPhase("idle");
    env.ui.idleReady();
  };

  function hard() {
    epoch++;
    current?.abort(); current = null;
    idleCtl?.abort(); idleCtl = null;
    orb.reset();
    hist.length = 0;
    env.ui.setAnswer(null);
    env.ui.resetLabel();
    snapshot();
    resetChannels();
    setNow("pulse", -1);
    busy = false; idling = false;
    env.ui.lock(false);
    env.ui.setPhase("idle");
    env.ui.idleReady();
  }

  snapshot();
  resetChannels();

  return {
    start(text, cfg) {
      if (busy) return false;
      busy = true;
      snapshot(); // once per question, never read layout in frames
      geo.dir = -geo.dir;
      orb.reset();
      setNow("u", 0);
      const ac = child();
      current = ac;
      env.ui.lock(true);
      void run(text, ac.signal, cfg);
      return true;
    },
    escape() {
      if (!busy || idling) return;
      current?.abort();
      void toIdle("esc");
    },
    reset() {
      if (!busy || idling) return;
      void toIdle("reset");
    },
    hard,
    home() {
      if (busy) return;
      snapshot();
      setNow("w", geo.pw);
      setNow("u", 0);
    },
    busy: () => busy,
    destroy() {
      life.abort();
      orb.destroy();
      rest.destroy();
    },
  };
}

/* ───────────────────────────── component ───────────────────────────── */
const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

export default function MorphOrb(props: MorphOrbProps) {
  const [phase, setPhaseState] = useState<Phase>("idle");
  const [value, setValue] = useState("");
  const [lbl, setLbl] = useState<{ cur: string; prev: string | null; n: number }>({ cur: COPY.labels[0], prev: null, n: 0 });
  const [answer, setAnswer] = useState<OrbAnswer | null>(null);
  const [dbgSpeed, setDbgSpeed] = useState(1);
  const [debug] = useState(() => typeof window !== "undefined" && /[?&]debug(?:[=&]|$)/.test(window.location.search));

  const rootRef = useRef<HTMLDivElement>(null);
  const moverRef = useRef<HTMLDivElement>(null);
  const actorRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const restRef = useRef<HTMLCanvasElement>(null);
  const pulseRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  const answerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLParagraphElement>(null);
  const liveRef = useRef<HTMLDivElement>(null);
  const ghostRefs = useRef<(HTMLSpanElement | null)[]>([]);

  const propsRef = useRef(props);
  propsRef.current = props;
  const speedRef = useRef(1);
  speedRef.current = Math.max(0.05, (props.speed ?? 1) * dbgSpeed);
  const phaseRef = useRef<Phase>("idle");
  const reducedRef = useRef(false);
  const rtRef = useRef<Runtime | null>(null);
  const lastTextRef = useRef("");
  const nextRef = useRef<string | null>(null); // asked while an answer is showing: goes after the reset
  const timers = useRef<{ typing?: number; shake?: number; flash?: number }>({});

  const makeCfg = (): RunCfg => ({
    onSubmit: (text) => propsRef.current.onSubmit(text),
    minThink: propsRef.current.minThinkMs ?? 1600,
  });

  const launch = (text: string) => {
    const rt = rtRef.current;
    if (!rt || rt.busy()) return;
    lastTextRef.current = text;
    setValue(text);
    rt.start(text, makeCfg());
  };

  const ask = (text: string) => {
    const clean = text.trim();
    if (!clean) return;
    if (phaseRef.current === "idle") launch(clean);
    else if (phaseRef.current === "answered") {
      nextRef.current = clean;
      rtRef.current?.reset();
    }
  };

  useImperativeHandle(props.handleRef, () => ({ ask }), []);

  useIsoLayoutEffect(() => {
    const root = rootRef.current, mover = moverRef.current, actor = actorRef.current, canvas = canvasRef.current;
    const restCanvas = restRef.current, pulse = pulseRef.current, status = statusRef.current, form = formRef.current;
    const ghosts = ghostRefs.current.filter((g): g is HTMLSpanElement => !!g);
    if (!root || !mover || !actor || !canvas || !restCanvas || !pulse || !status || !form) return;

    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    reducedRef.current = mq.matches;
    const onMq = (e: MediaQueryListEvent) => { reducedRef.current = e.matches; };
    mq.addEventListener("change", onMq);

    const rt = createRuntime({
      root, mover, actor, form, ghosts, canvas, restCanvas, pulse, status,
      getBody: () => bodyRef.current,
      measureCard: () => innerRef.current?.offsetHeight ?? CARD_H,
      getSpeed: () => speedRef.current,
      isReduced: () => reducedRef.current,
      ui: {
        setPhase: (p) => { phaseRef.current = p; setPhaseState(p); },
        swapLabel: (name) => setLbl((l) => (l.cur === name ? l : { cur: name, prev: l.cur, n: l.n + 1 })),
        resetLabel: () => setLbl((l) => ({ cur: COPY.labels[0], prev: null, n: l.n + 1 })),
        setAnswer: (a) => setAnswer(a),
        clearInput: () => setValue(""),
        live: (s) => { if (liveRef.current) liveRef.current.textContent = s; },
        lock: (on) => { form.toggleAttribute("inert", on); },
        idleReady: () => {
          const next = nextRef.current;
          nextRef.current = null;
          if (next) launch(next);
          else inputRef.current?.focus({ preventScroll: true });
        },
        focusAnswer: () => { answerRef.current?.focus({ preventScroll: true }); },
        answered: (a) => propsRef.current.onAnswered?.(a),
      },
    });
    rtRef.current = rt;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && phaseRef.current !== "idle" && phaseRef.current !== "reset") {
        e.preventDefault();
        rt.escape();
      }
    };
    const onResize = () => {
      if (phaseRef.current === "idle" && !rt.busy()) rt.home();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    inputRef.current?.focus({ preventScroll: true });

    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
      mq.removeEventListener("change", onMq);
      window.clearTimeout(timers.current.typing);
      window.clearTimeout(timers.current.shake);
      window.clearTimeout(timers.current.flash);
      rt.destroy();
      rtRef.current = null;
    };
  }, []);

  const shake = () => {
    const a = actorRef.current;
    if (!a) return;
    a.removeAttribute("data-shake");
    void a.offsetWidth;
    a.setAttribute("data-shake", "");
    a.setAttribute("data-flash", "");
    window.clearTimeout(timers.current.shake);
    window.clearTimeout(timers.current.flash);
    timers.current.shake = window.setTimeout(() => a.removeAttribute("data-shake"), 260);
    timers.current.flash = window.setTimeout(() => a.removeAttribute("data-flash"), 200);
  };

  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setValue(e.target.value);
    const a = actorRef.current;
    if (!a) return;
    a.setAttribute("data-typing", "");
    window.clearTimeout(timers.current.typing);
    timers.current.typing = window.setTimeout(() => a.removeAttribute("data-typing"), 300);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && (e.shiftKey || e.nativeEvent.isComposing)) e.preventDefault();
  };

  const onFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const rt = rtRef.current;
    if (!rt || rt.busy() || phaseRef.current !== "idle") return;
    const text = value.trim();
    if (!text) { shake(); return; }
    launch(text);
  };

  const onReset = () => {
    if (phaseRef.current === "answered") rtRef.current?.reset();
  };

  const replay = () => {
    const rt = rtRef.current;
    if (!rt) return;
    const text = lastTextRef.current || "Where's the coffee machine?";
    rt.hard();
    window.requestAnimationFrame(() => launch(text));
  };

  const ready = value.trim().length > 0;
  const words = (answer?.text ?? "").split(/\s+/).filter(Boolean);
  const mic = props.mic ?? "off";

  const labelInner = (name: string) =>
    name === COPY.done ? (
      <span className="mo-lab-done">{name}</span>
    ) : (
      <>
        <span className="mo-lab-t">{name}</span>
        <span className="mo-dots" aria-hidden="true"><i /><i /><i /></span>
      </>
    );

  return (
    <div className="mo-root" data-phase={phase} ref={rootRef} data-testid="orb-home">
      <div className="mo-bg" aria-hidden="true" />
      <div className="mo-halo" aria-hidden="true" />
      <canvas className="mo-rest" ref={restRef} aria-hidden="true" data-testid="resting-orb" />

      <div className="mo-logo" aria-label="Finni">
        <svg viewBox="0 0 32 32" aria-hidden="true">
          <path d="M16 30c-1-3-9-10-9-17a9 9 0 0 1 18 0c0 7-8 14-9 17z" fill="#FF7A00" />
          <circle cx="16" cy="13" r="3.6" fill="#FFFFFF" />
        </svg>
        <span>finni</span>
      </div>
      {props.onOpenMap && (
        <button type="button" className="mo-map-btn" data-testid="open-map" onClick={props.onOpenMap}>Map</button>
      )}

      <div className="mo-mover" ref={moverRef}>
        {Array.from({ length: 6 }).map((_, i) => (
          <span key={i} className="mo-trail" aria-hidden="true" ref={(el) => { ghostRefs.current[i] = el; }} />
        ))}

        <div className="mo-actor" ref={actorRef}>
          <div className="mo-underglow" aria-hidden="true" />
          <div className="mo-halo-green" aria-hidden="true" />
          <div className="mo-surface" aria-hidden="true">
            <div className="mo-aurora"><i /><i /><i /><i /></div>
          </div>
          <div className="mo-ball" aria-hidden="true" />
          <div className="mo-green" aria-hidden="true" />
          <div className="mo-card" aria-hidden="true" />
          <div className="mo-ring" aria-hidden="true" />

          <form className="mo-input" ref={formRef} onSubmit={onFormSubmit} autoComplete="off">
            <svg className="mo-spark" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M10 3.5l1.7 4.8 4.8 1.7-4.8 1.7L10 16.5l-1.7-4.8L3.5 10l4.8-1.7L10 3.5z" />
              <path d="M18 14.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8z" />
            </svg>
            <input
              ref={inputRef}
              className="mo-field"
              type="text"
              value={value}
              maxLength={200}
              placeholder={COPY.placeholder}
              aria-label="Ask Finni"
              data-testid="orb-input"
              spellCheck={false}
              onChange={onChange}
              onKeyDown={onKeyDown}
            />
            {props.onMic && (
              <button type="button" className="mo-mic" aria-label={mic === "off" ? "Speak to Finni" : "Stop"}
                      data-on={mic !== "off" ? "" : undefined} data-testid="orb-mic" onClick={props.onMic}>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <rect x="8.5" y="2.5" width="7" height="12" rx="3.5" fill="currentColor" />
                  <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3.5M8.5 21.5h7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </button>
            )}
            <button type="submit" className="mo-send" aria-label={COPY.send} data-ready={ready ? "" : undefined} data-testid="orb-send">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 19V5" />
                <path d="M5.5 11.5L12 5l6.5 6.5" />
              </svg>
            </button>
          </form>

          <canvas className="mo-orb" ref={canvasRef} aria-hidden="true" />
          <div className="mo-pulse" ref={pulseRef} aria-hidden="true" />

          <div className="mo-answer" ref={answerRef} tabIndex={-1} role="group" aria-label={COPY.answerTitle} data-testid="orb-answer">
            <div className="mo-a-inner" ref={innerRef}>
              <div className="mo-a-head">
                <i className="mo-a-dot" aria-hidden="true" />
                <span>{COPY.answerTitle}</span>
              </div>
              <p className="mo-a-body" ref={bodyRef}>
                {words.map((w, i) => (
                  <React.Fragment key={i}>
                    <span className="mo-w">{w}</span>{" "}
                  </React.Fragment>
                ))}
              </p>
              {!!answer?.options?.length && (
                <div className="mo-chips">
                  {answer.options.map((option) => (
                    <button key={option.label} type="button" className="mo-chip" data-testid={`orb-chip-${option.label}`}
                            onClick={() => ask(option.label)}>
                      <span>{option.label}</span>
                      {!!option.description && <small>{option.description}</small>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="mo-status" ref={statusRef} aria-hidden="true" data-testid="orb-status">
        {lbl.prev !== null && (
          <span key={"p" + lbl.n} className="mo-lab mo-out">{labelInner(lbl.prev)}</span>
        )}
        <span key={"c" + lbl.n} className="mo-lab mo-in">{labelInner(lbl.cur)}</span>
      </div>

      {props.notice && <div className="mo-notice" role="alert" data-testid="error">{props.notice}</div>}
      {MIC_HINT[mic] && <div className="mo-hint" data-testid="orb-mic-hint">{MIC_HINT[mic]}</div>}
      <button type="button" className="mo-reset" onClick={onReset} data-testid="orb-reset">{COPY.reset}</button>

      <div className="mo-live" ref={liveRef} role="status" aria-live="polite" />

      {debug && (
        <div className="mo-debug">
          <span className="mo-chip-dbg">{phase}</span>
          <label>
            <span>{dbgSpeed.toFixed(2)}×</span>
            <input
              type="range"
              min={0.25}
              max={2}
              step={0.05}
              value={dbgSpeed}
              aria-label="Speed"
              onChange={(e) => setDbgSpeed(parseFloat(e.target.value))}
            />
          </label>
          <button type="button" onClick={replay}>Replay</button>
        </div>
      )}
    </div>
  );
}
