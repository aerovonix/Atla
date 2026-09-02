import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTerminalStore } from "../state/terminalStore";
import { CloseIcon, StopIcon, TrashIcon } from "./icons";

/** Shorten a long path for the prompt line: …\Documents\Nova LM UI */
function shortCwd(cwd: string): string {
  if (!cwd) return "";
  const parts = cwd.split(/[/\\]/).filter(Boolean);
  if (parts.length <= 2) return cwd;
  const sep = cwd.includes("\\") ? "\\" : "/";
  return `…${sep}${parts.slice(-2).join(sep)}`;
}

export function TerminalPanel() {
  const { open, setOpen, cwd, running, blocks, history, setCwd, pushHistory, clear, apply } = useTerminalStore();
  const [input, setInput] = useState("");
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Subscribe once, even while the panel is closed, so a command started
  // elsewhere still lands in the log.
  useEffect(() => {
    const unsub = window.atla.terminal.onEvent(apply);
    void window.atla.terminal.cwd().then(setCwd);
    return unsub;
  }, [apply, setCwd]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [blocks, open]);

  if (!open) return null;

  const submit = () => {
    const command = input.trim();
    if (!command || running) return;
    if (command === "clear" || command === "cls") {
      clear();
      setInput("");
      return;
    }
    pushHistory(command);
    setHistoryIndex(null);
    setInput("");
    void window.atla.terminal.run(command);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
      return;
    }
    // Up/down walk back through what's been run, like a real shell.
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (history.length === 0) return;
      const next = historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(next);
      setInput(history[next]);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (historyIndex === null) return;
      const next = historyIndex + 1;
      if (next >= history.length) {
        setHistoryIndex(null);
        setInput("");
      } else {
        setHistoryIndex(next);
        setInput(history[next]);
      }
      return;
    }
    if (e.key === "c" && e.ctrlKey && running) {
      e.preventDefault();
      window.atla.terminal.kill();
    }
  };

  return (
    <div className="h-[280px] shrink-0 flex flex-col border-t border-border bg-bg">
      <div className="h-9 shrink-0 flex items-center gap-2 px-3 border-b border-borderLight">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-secondary">Terminal</span>
        <span className="font-mono text-[11px] text-secondary truncate" title={cwd}>
          {shortCwd(cwd)}
        </span>
        <div className="flex-1" />
        {running && (
          <button
            onClick={() => window.atla.terminal.kill()}
            className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-md text-secondary hover:bg-hover transition-colors"
            title="Stop the running command (Ctrl+C)"
          >
            <StopIcon width={10} height={10} /> Stop
          </button>
        )}
        <button
          onClick={clear}
          className="w-7 h-7 rounded-md flex items-center justify-center text-secondary hover:bg-hover transition-colors"
          title="Clear"
        >
          <TrashIcon width={13} height={13} />
        </button>
        <button
          onClick={() => setOpen(false)}
          className="w-7 h-7 rounded-md flex items-center justify-center text-secondary hover:bg-hover transition-colors"
          title="Close terminal"
        >
          <CloseIcon width={13} height={13} />
        </button>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-2 font-mono text-[12px] leading-5">
        {blocks.length === 0 && (
          <div className="text-secondary">
            Runs one command at a time and keeps the working directory between them. Interactive programs won't work
            here — there's no TTY.
          </div>
        )}
        {blocks.map((b) => (
          <div key={b.id} className="mb-2">
            <div className="flex items-baseline gap-2">
              <span style={{ color: "var(--accent)" }}>❯</span>
              <span className="break-all">{b.command}</span>
              {b.code !== undefined && b.code !== 0 && b.code !== null && (
                <span className="text-[11px] shrink-0" style={{ color: "#ef4444" }}>
                  exit {b.code}
                </span>
              )}
            </div>
            {b.chunks.length > 0 && (
              <pre className="whitespace-pre-wrap break-words mt-0.5">
                {b.chunks.map((c, i) => (
                  <span key={i} style={c.err ? { color: "#ef4444" } : undefined}>
                    {c.text}
                  </span>
                ))}
              </pre>
            )}
          </div>
        ))}
      </div>

      <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-t border-borderLight font-mono text-[12px]">
        <span style={{ color: "var(--accent)" }}>❯</span>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={running}
          placeholder={running ? "Running… Ctrl+C to stop" : "Type a command"}
          className="bare flex-1 bg-transparent outline-none disabled:opacity-50"
          spellCheck={false}
          autoComplete="off"
        />
      </div>
    </div>
  );
}
