import { useEffect, useRef, useState } from "react";
import { BoltIcon } from "./icons";
import { useStore } from "../state/store";
import type { SpeedTier } from "../../shared/types";

const TIERS: { value: SpeedTier; label: string; hint: string }[] = [
  { value: "normal", label: "Normal", hint: "The whole page, minus trackers." },
  { value: "fast", label: "Fast", hint: "Drops webfonts, video and embeds. Images stay." },
  { value: "lightning", label: "Lightning", hint: "Text and layout only. Images go too." }
];

/**
 * Picks how much of a page to load, next to the button that opens the page.
 *
 * Shown only while the browser panel is open, because that is the only time
 * the choice has any effect: with the panel hidden nobody is looking, so the
 * loader drops to lightning regardless of what is selected here. A control
 * that silently does nothing is worse than one that isn't there.
 */
export function SpeedControl() {
  const settings = useStore((s) => s.settings);
  const update = useStore((s) => s.updateSettings);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = TIERS.find((t) => t.value === settings.browserSpeed) ?? TIERS[0];

  return (
    <div ref={wrap} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-8 h-8 rounded-lg flex items-center justify-center transition-colors hover:bg-hover"
        style={{ color: settings.browserSpeed === "normal" ? "var(--secondary)" : "var(--accent)" }}
        title={`Page loading: ${current.label} — ${current.hint}`}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <BoltIcon width={16} height={16} />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1 z-50 w-60 p-1 rounded-xl border border-border shadow-lg secret-reveal"
          style={{ background: "var(--surface)" }}
        >
          {TIERS.map((t) => {
            const active = t.value === settings.browserSpeed;
            return (
              <button
                key={t.value}
                role="menuitemradio"
                aria-checked={active}
                onClick={() => {
                  update({ browserSpeed: t.value });
                  setOpen(false);
                }}
                className="w-full text-left px-2.5 py-2 rounded-lg transition-colors hover:bg-hover"
                style={{ color: active ? "var(--accent)" : "var(--text)" }}
              >
                <div className="text-[13px] font-medium">{t.label}</div>
                <div className="text-[11px] text-secondary leading-snug">{t.hint}</div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
