import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

/**
 * One terminal view, bound to one session in the main process.
 *
 * The session outlives this component deliberately. Switching tabs unmounts
 * the view, and a shell that died every time you looked at a different tab
 * would be useless — so this attaches to an existing session and replays its
 * scrollback rather than starting anything.
 */
export function PtyTerminal({ sessionId, visible }: { sessionId: string; visible: boolean }) {
  const host = useRef<HTMLDivElement | null>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!host.current) return;

    const t = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 12,
      cursorBlink: true,
      // Transparent so the pane's own theme shows through; xterm paints its
      // own background otherwise and the terminal looks pasted on.
      theme: { background: "#00000000" },
      allowTransparency: true,
      scrollback: 5000
    });
    const f = new FitAddon();
    t.loadAddon(f);
    t.open(host.current);
    term.current = t;
    fit.current = f;

    // Replay what the session has already printed, so a reattached view shows
    // history instead of a blank pane.
    void window.atla?.pty?.scrollback(sessionId).then((text) => {
      if (text) t.write(text);
    });

    const offData = window.atla?.pty?.onData(({ id, data }) => {
      if (id === sessionId) t.write(data);
    });
    const offExit = window.atla?.pty?.onExit(({ id, code }) => {
      if (id === sessionId) t.write(`\r\n\x1b[90m[process exited with code ${code}]\x1b[0m\r\n`);
    });

    const typed = t.onData((data) => {
      void window.atla?.pty?.write(sessionId, data);
    });

    const sync = () => {
      // A hidden pane measures zero, and fit() throws on that.
      if (!host.current?.offsetParent && host.current?.offsetHeight === 0) return;
      try {
        f.fit();
        void window.atla?.pty?.resize(sessionId, t.cols, t.rows);
      } catch {
        /* not laid out yet */
      }
    };
    sync();

    // The pane resizes with the window, and with the splitter once that lands.
    const ro = new ResizeObserver(sync);
    ro.observe(host.current);

    return () => {
      ro.disconnect();
      typed.dispose();
      offData?.();
      offExit?.();
      t.dispose();
      term.current = null;
    };
  }, [sessionId]);

  useEffect(() => {
    if (!visible) return;
    // Becoming visible is the moment a zero-sized pane finally has a size.
    const id = requestAnimationFrame(() => {
      try {
        fit.current?.fit();
        if (term.current) void window.atla?.pty?.resize(sessionId, term.current.cols, term.current.rows);
        term.current?.focus();
      } catch {
        /* still not laid out */
      }
    });
    return () => cancelAnimationFrame(id);
  }, [visible, sessionId]);

  return <div ref={host} className="h-full w-full" style={{ display: visible ? "block" : "none" }} />;
}
