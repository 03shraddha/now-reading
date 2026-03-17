import { useState, useEffect, useRef } from "react";

/**
 * Like useTypewriter but drives TWO phrase lists from a single shared timer.
 * Both animations type, pause, and delete in perfect sync — just different words.
 * The longer phrase in each pair determines when the pause begins; the shorter
 * one finishes early and waits. Phrase lists must be the same length.
 */
export function useSyncedTypewriters(
  phrases1: string[],
  phrases2: string[],
  {
    typeSpeed   = 45,
    deleteSpeed = 22,
    pauseAfter  = 1800,
    pauseBefore = 400,
  } = {}
): [string, string] {
  const [display1, setDisplay1] = useState("");
  const [display2, setDisplay2] = useState("");
  const phraseIdx = useRef(0);
  const charIdx   = useRef(0);
  const deleting  = useRef(false);

  useEffect(() => {
    const len = Math.min(phrases1.length, phrases2.length);
    if (len === 0) return;

    let timeout: ReturnType<typeof setTimeout>;

    function tick() {
      const idx = phraseIdx.current % len;
      const p1  = phrases1[idx];
      const p2  = phrases2[idx];
      // Drive charIdx up to the longer phrase; shorter one clips at its own length
      const maxLen = Math.max(p1.length, p2.length);

      if (!deleting.current) {
        charIdx.current += 1;
        setDisplay1(p1.slice(0, Math.min(charIdx.current, p1.length)));
        setDisplay2(p2.slice(0, Math.min(charIdx.current, p2.length)));

        if (charIdx.current >= maxLen) {
          deleting.current = true;
          timeout = setTimeout(tick, pauseAfter);
          return;
        }
        timeout = setTimeout(tick, typeSpeed);
      } else {
        charIdx.current -= 1;
        setDisplay1(p1.slice(0, Math.min(charIdx.current, p1.length)));
        setDisplay2(p2.slice(0, Math.min(charIdx.current, p2.length)));

        if (charIdx.current <= 0) {
          deleting.current = false;
          phraseIdx.current = (phraseIdx.current + 1) % len;
          timeout = setTimeout(tick, pauseBefore);
          return;
        }
        timeout = setTimeout(tick, deleteSpeed);
      }
    }

    timeout = setTimeout(tick, pauseBefore);
    return () => clearTimeout(timeout);
  }, [phrases1, phrases2, typeSpeed, deleteSpeed, pauseAfter, pauseBefore]);

  return [display1, display2];
}

/**
 * Cycles through `phrases`, typing each character one by one,
 * pausing, then deleting before moving to the next phrase.
 */
export function useTypewriter(
  phrases: string[],
  {
    typeSpeed   = 45,   // ms per character typed
    deleteSpeed = 22,   // ms per character deleted
    pauseAfter  = 1800, // ms to hold the completed phrase
    pauseBefore = 400,  // ms to wait before typing next phrase
  } = {}
): string {
  const [display, setDisplay] = useState("");
  const phraseIdx = useRef(0);
  const charIdx   = useRef(0);
  const deleting  = useRef(false);

  useEffect(() => {
    if (phrases.length === 0) return;

    let timeout: ReturnType<typeof setTimeout>;

    function tick() {
      const current = phrases[phraseIdx.current];

      if (!deleting.current) {
        // Typing forward
        charIdx.current += 1;
        setDisplay(current.slice(0, charIdx.current));

        if (charIdx.current === current.length) {
          // Finished typing — pause then start deleting
          deleting.current = true;
          timeout = setTimeout(tick, pauseAfter);
          return;
        }
        timeout = setTimeout(tick, typeSpeed);
      } else {
        // Deleting
        charIdx.current -= 1;
        setDisplay(current.slice(0, charIdx.current));

        if (charIdx.current === 0) {
          // Finished deleting — move to next phrase
          deleting.current = false;
          phraseIdx.current = (phraseIdx.current + 1) % phrases.length;
          timeout = setTimeout(tick, pauseBefore);
          return;
        }
        timeout = setTimeout(tick, deleteSpeed);
      }
    }

    timeout = setTimeout(tick, pauseBefore);
    return () => clearTimeout(timeout);
  }, [phrases, typeSpeed, deleteSpeed, pauseAfter, pauseBefore]);

  return display;
}
