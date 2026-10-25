/** Optional: the venue in Google's photorealistic 3D, flown round once behind the FINNI title. Only with
 * EXPO_PUBLIC_GOOGLE_MAPS_KEY (a key with the Maps JavaScript API and the Map Tiles API on, see the README).
 * Google's 3D models can be shown live like this but not downloaded, so the routes stay on our own building.
 * Not drawn in 5 s (wrong key, no WebGL): onFail, and the intro falls back to our building. */
import { useEffect, useRef } from "react";

/** Munich Urban Colab (UnternehmerTUM), Freddie-Mercury-Str. 5, 80636 München. EXPO_PUBLIC_INTRO_PLACE="lat,lng"
 * points it somewhere else (check the pin in Google Maps: right-click → the coordinates). */
export const VENUE = placeFrom(process.env.EXPO_PUBLIC_INTRO_PLACE) ?? { lat: 48.15685, lng: 11.55179 };
const LOAD_MS = 5000; // photorealistic tiles take a few seconds on venue Wi-Fi
const ORBIT_MS = 9000; // one round; the intro leaves before it ends

export const googleKey = (): string | undefined => process.env.EXPO_PUBLIC_GOOGLE_MAPS_KEY || undefined;

export function placeFrom(text: string | undefined): { lat: number; lng: number } | null {
  const [lat, lng] = (text ?? "").split(",").map((part) => Number(part.trim()));
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && text
    ? { lat, lng }
    : null;
}

type Maps3d = { Map3DElement: new (options: Record<string, unknown>) => HTMLElement & {
  flyCameraAround?: (options: Record<string, unknown>) => void;
} };
type GoogleMaps = { maps: { importLibrary: (name: string) => Promise<unknown> } };

let loading: Promise<Maps3d> | null = null;
function loadMaps3d(key: string): Promise<Maps3d> {
  loading ??= new Promise<GoogleMaps>((resolve, reject) => {
    const ready = "__finniMapsReady";
    (window as unknown as Record<string, unknown>)[ready] = () => resolve((window as unknown as { google: GoogleMaps }).google);
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=beta&libraries=maps3d&callback=${ready}`;
    script.async = true;
    script.onerror = () => reject(new Error("Google Maps did not load"));
    document.head.appendChild(script);
  }).then((google) => google.maps.importLibrary("maps3d") as Promise<Maps3d>);
  loading.catch(() => { loading = null; }); // a later visit may try again
  return loading;
}

export function GoogleIntro({ onReady, onFail }: { onReady: () => void; onFail: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const key = googleKey();
    if (!key || !box.current) return onFail();
    let over = false;
    const fail = () => { if (!over) { over = true; onFail(); } };
    const timer = window.setTimeout(fail, LOAD_MS);
    // a wrong or unrestricted-elsewhere key loads fine and only then fails: drop the grey error map too
    (window as unknown as { gm_authFailure?: () => void }).gm_authFailure = () => onFail();
    loadMaps3d(key)
      .then(({ Map3DElement }) => {
        if (over || !box.current) return;
        const camera = { center: { ...VENUE, altitude: 30 }, range: 420, tilt: 62, heading: 0 };
        const map = new Map3DElement({ ...camera, mode: "SATELLITE", defaultUIHidden: true });
        map.style.width = "100%";
        map.style.height = "100%";
        // shown only once the city is drawn: a bad key never gets steady and falls back after LOAD_MS
        map.addEventListener("gmp-steadychange", (event) => {
          if (over || !(event as Event & { isSteady?: boolean }).isSteady) return;
          over = true;
          window.clearTimeout(timer);
          map.flyCameraAround?.({ camera, durationMillis: ORBIT_MS, repeatCount: 1 });
          onReady();
        });
        map.addEventListener("gmp-error", fail);
        box.current.appendChild(map);
      })
      .catch(fail);
    return () => {
      over = true;
      window.clearTimeout(timer);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- once
  return <div ref={box} className="mo-intro-google" data-testid="intro-google" />;
}
