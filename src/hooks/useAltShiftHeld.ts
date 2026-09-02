import { useEffect, useState } from "react";

/**
 * True while Alt and Shift are both held down.
 *
 * `altKey` is Option on macOS, so the same check covers both platforms with
 * no branching — the key names differ but the modifier flag does not.
 *
 * The awkward part is not detecting the press, it is noticing the release.
 * A keyup only arrives if the window still has focus, so alt-tabbing away
 * mid-hold would leave this stuck on forever and the menu permanently
 * un-secret. Blur and visibility changes therefore clear it too: anything
 * that means "we can no longer see the keyboard" counts as released.
 */
export function useAltShiftHeld(): boolean {
  const [held, setHeld] = useState(false);

  useEffect(() => {
    // Both keydown and keyup carry the full modifier state, so one handler
    // covers pressing and releasing either key in either order.
    const sync = (e: KeyboardEvent) => setHeld(e.altKey && e.shiftKey);
    const clear = () => setHeld(false);

    window.addEventListener("keydown", sync);
    window.addEventListener("keyup", sync);
    window.addEventListener("blur", clear);
    document.addEventListener("visibilitychange", clear);
    return () => {
      window.removeEventListener("keydown", sync);
      window.removeEventListener("keyup", sync);
      window.removeEventListener("blur", clear);
      document.removeEventListener("visibilitychange", clear);
    };
  }, []);

  return held;
}
