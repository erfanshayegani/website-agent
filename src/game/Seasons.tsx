import { useEffect, useState } from "react";

/* The same "Seasons" photos as erfanshayegani.github.io (images/seasons/ in the
   website repo): they cross-fade in the top bar and, blurred, behind the page. */
const BASE = "https://erfanshayegani.github.io/images/seasons/";
const PHOTOS = [
  "2023-09", "2023-10", "2023-11", "2023-12", "2024-02",
  "2024-03", "2025-01", "2025-10", "2026-05", "2026-11",
];
const INTERVAL_MS = 6000;

/** Index of the photo currently showing; advances every 6s (unless reduced motion). */
export function useSeasonIndex() {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const id = window.setInterval(() => setIndex((i) => (i + 1) % PHOTOS.length), INTERVAL_MS);
    return () => window.clearInterval(id);
  }, []);
  return index;
}

/** Stacked photo layers; only the active one (and the next, preloaded) get an image. */
export function SeasonLayers({ index, className }: { index: number; className: string }) {
  const next = (index + 1) % PHOTOS.length;
  const [loaded, setLoaded] = useState<Set<number>>(() => new Set([0, 1]));
  useEffect(() => {
    setLoaded((s) => (s.has(index) && s.has(next) ? s : new Set([...s, index, next])));
  }, [index, next]);
  return (
    <div className={className} aria-hidden>
      {PHOTOS.map((name, k) => (
        <div
          key={name}
          className={`${className}__photo${k === index ? " is-active" : ""}`}
          style={loaded.has(k) ? { backgroundImage: `url(${BASE}${name}.jpg)` } : undefined}
        />
      ))}
    </div>
  );
}
