import { useState, useEffect, useRef } from "react";

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
