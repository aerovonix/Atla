import { useEffect } from "react";
import { useStore } from "../state/store";
import { resolveTheme } from "../../shared/types";

/**
 * Keeps the document's theme classes in step with the setting.
 *
 * Shared by the main window and every pop-out. A popped pane is a separate
 * document with its own <html>, so it has to apply the theme itself — and if
 * each window did that with its own copy of this logic, a fix to one would
 * quietly leave the others behind.
 */
export function useAppliedTheme() {
  const theme = useStore((s) => s.settings.theme);

  useEffect(() => {
    const apply = () => {
      const resolved = resolveTheme(theme, window.matchMedia("(prefers-color-scheme: dark)").matches);
      const root = document.documentElement;
      // Both classes are toggled every time rather than only the winner, so
      // switching between the two dark themes can't leave the old one on.
      root.classList.toggle("dark", resolved === "dark");
      root.classList.toggle("midnight", resolved === "midnight");
    };
    apply();
    if (theme === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      mq.addEventListener("change", apply);
      return () => mq.removeEventListener("change", apply);
    }
  }, [theme]);
}
