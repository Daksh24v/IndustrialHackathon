/** The opening (web, once per visit): "FINNI" big and orange, with "find it" under it, over the turning building, then it shrinks into the
 * search bar while the floor stack is already there. A click, a tap or a key skips it; reduced motion only fades. With
 * EXPO_PUBLIC_GOOGLE_MAPS_KEY set, the backdrop is a live Google 3D fly-around of the venue (GoogleIntro);
 * without it, or if Google doesn't load in time, our own building shows through. */
import { useEffect, useState } from "react";

import { GoogleIntro, googleKey } from "./GoogleIntro";

const SEEN_KEY = "finni-intro-seen";
const SHOW_MS = 1700; // the words alone
const LEAVE_MS = 800; // shrinking into the search bar
const GOOGLE_SHOW_MS = 5200; // longer when there is a city to fly round

/** Once per visit, never in a test run (?intro=0) and never when it was skipped before in this tab. */
export function wantIntro(search: string, seen: string | null): boolean {
  if (/[?&]intro=0\b/.test(search)) return false;
  if (/[?&]intro=1\b/.test(search)) return true;
  return seen !== "1";
}

export default function Intro({ onDone }: { onDone?: () => void }) {
  const [stage, setStage] = useState<"show" | "leave" | "gone">(() => {
    try {
      return wantIntro(window.location.search, window.sessionStorage.getItem(SEEN_KEY)) ? "show" : "gone";
    } catch {
      return "show"; // storage blocked: show it, it's short
    }
  });
  const [google, setGoogle] = useState<"off" | "loading" | "on">(googleKey() ? "loading" : "off");

  useEffect(() => {
    if (stage === "gone") {
      onDone?.();
      return;
    }
    try { window.sessionStorage.setItem(SEEN_KEY, "1"); } catch { /* fine */ }
    const leave = () => setStage((now) => (now === "show" ? "leave" : now));
    const hold = google === "off" ? SHOW_MS : GOOGLE_SHOW_MS;
    const timer = stage === "show" ? window.setTimeout(leave, hold) : window.setTimeout(() => setStage("gone"), LEAVE_MS);
    const skip = () => leave();
    window.addEventListener("pointerdown", skip);
    window.addEventListener("keydown", skip);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pointerdown", skip);
      window.removeEventListener("keydown", skip);
    };
  }, [stage, google, onDone]);

  if (stage === "gone") return null;
  return (
    <div className="mo-intro" data-stage={stage} data-google={google} data-testid="intro" aria-live="polite">
      {google !== "off" && (
        <GoogleIntro onReady={() => setGoogle("on")} onFail={() => setGoogle("off")} />
      )}
      <div className="mo-intro-veil" />
      <div className="mo-intro-words">
        <span className="mo-intro-name">FINNI</span>
        <span className="mo-intro-tag">find it</span>
      </div>
    </div>
  );
}
