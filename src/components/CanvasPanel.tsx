import { useEffect, useMemo, useRef, useState } from "react";
import { PopOutButton } from "./PopOutButton";
import { isDirty, useCanvasStore, type CanvasTab } from "../state/canvasStore";
import { CloseIcon, FileIcon } from "./icons";

const baseName = (p: string) => p.split(/[\\/]/).pop() || p;

/**
 * A line-numbered editor over a plain textarea.
 *
 * Deliberately not a full editor component: syntax highlighting would mean a
 * mirrored overlay under a transparent textarea, and every metric has to match
 * exactly or the caret drifts from the glyphs it sits under. The gutter is the
 * one part that can be a sibling, because it never has to align horizontally —
 * only the line height has to agree.
 */
function Editor({ tab }: { tab: CanvasTab }) {
  const edit = useCanvasStore((s) => s.edit);
  const gutterRef = useRef<HTMLDivElement>(null);
  const lineCount = useMemo(() => tab.text.split("\n").length, [tab.text]);

  return (
    <div className="flex-1 min-h-0 flex overflow-hidden">
      <div
        ref={gutterRef}
        aria-hidden
        className="shrink-0 overflow-hidden text-right select-none py-3 pl-3 pr-2 text-[12px] font-mono leading-5 text-muted border-r border-border bg-sidebar"
      >
        {Array.from({ length: lineCount }, (_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
      </div>
      <textarea
        value={tab.text}
        onChange={(e) => edit(tab.path, e.target.value)}
        onScroll={(e) => {
          if (gutterRef.current) gutterRef.current.scrollTop = e.currentTarget.scrollTop;
        }}
        spellCheck={false}
        className="bare flex-1 min-w-0 block resize-none bg-transparent outline-none py-3 px-3 text-[12px] font-mono leading-5 overflow-auto"
      />
    </div>
  );
}

/** The model's diff for this file, shown alongside rather than over the text. */
function DiffPane({ diff }: { diff: string }) {
  return (
    <div className="w-[46%] shrink-0 border-l border-border overflow-auto bg-codeBg">
      <div className="sticky top-0 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-secondary bg-sidebar border-b border-border">
        Atla's changes
      </div>
      <pre className="text-[12px] font-mono leading-5">
        {diff.split("\n").map((line, i) => {
          const k = line[0];
          const style =
            k === "+"
              ? { background: "rgba(46, 160, 67, 0.15)", color: "var(--diff-add)" }
              : k === "-"
                ? { background: "rgba(248, 81, 73, 0.15)", color: "var(--diff-del)" }
                : k === "@"
                  ? { color: "var(--muted)" }
                  : undefined;
          return (
            <div key={i} className="px-3 whitespace-pre-wrap break-words" style={style}>
              {line || " "}
            </div>
          );
        })}
      </pre>
    </div>
  );
}

export function CanvasPanel() {
  const { open, tabs, activePath, select, closeTab, save, revert, reload, close } = useCanvasStore();
  const [showDiff, setShowDiff] = useState(true);
  const tab = tabs.find((t) => t.path === activePath);

  // Ctrl/Cmd+S saves the focused tab, which is the one thing people will try
  // without being told.
  useEffect(() => {
    if (!open || !tab) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save(tab.path);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, tab, save]);

  if (!open || tabs.length === 0) return null;

  const dirty = tab ? isDirty(tab) : false;

  return (
    <div className="w-[46%] min-w-[380px] max-w-[900px] shrink-0 border-l border-border flex flex-col min-h-0 bg-bg">
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border overflow-x-auto">
        <span className="shrink-0 text-secondary px-1">
          <FileIcon width={13} height={13} />
        </span>
        {tabs.map((t) => (
          <button
            key={t.path}
            onClick={() => select(t.path)}
            title={t.path}
            className={`group shrink-0 flex items-center gap-1.5 pl-2.5 pr-1.5 py-1 rounded-lg text-[12px] transition-colors ${
              t.path === activePath ? "bg-hover" : "hover:bg-hover text-secondary"
            }`}
          >
            <span className="truncate max-w-[160px]">{baseName(t.path)}</span>
            {isDirty(t) && <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: "var(--accent)" }} />}
            <span
              role="button"
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation();
                closeTab(t.path);
              }}
              className="opacity-0 group-hover:opacity-100 rounded p-0.5 hover:bg-border transition-opacity"
            >
              <CloseIcon width={10} height={10} />
            </span>
          </button>
        ))}
        <div className="flex-1" />
        <PopOutButton pane="canvas" />
        <button
          onClick={close}
          title="Hide the canvas"
          className="shrink-0 p-1.5 rounded-lg text-secondary hover:bg-hover transition-colors"
        >
          <CloseIcon width={13} height={13} />
        </button>
      </div>

      {tab && (
        <>
          <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border text-[11px]">
            <span className="font-mono text-secondary truncate flex-1 min-w-0" title={tab.path}>
              {tab.path}
            </span>
            {tab.diff && (
              <button
                onClick={() => setShowDiff((v) => !v)}
                className="shrink-0 px-2 py-0.5 rounded-md text-secondary hover:bg-hover transition-colors"
              >
                {showDiff ? "Hide changes" : "Show changes"}
              </button>
            )}
            <button
              onClick={() => void reload(tab.path)}
              className="shrink-0 px-2 py-0.5 rounded-md text-secondary hover:bg-hover transition-colors"
              title="Reload from disk, discarding unsaved edits"
            >
              Reload
            </button>
            <button
              onClick={() => revert(tab.path)}
              disabled={!dirty}
              className="shrink-0 px-2 py-0.5 rounded-md text-secondary hover:bg-hover transition-colors disabled:opacity-40"
            >
              Revert
            </button>
            <button
              onClick={() => void save(tab.path)}
              disabled={!dirty}
              className="bevel bevel-sm shrink-0 px-2.5 py-1 rounded-full text-[11px] font-medium disabled:opacity-50"
            >
              {dirty ? "Save" : "Saved"}
            </button>
          </div>

          {tab.error && (
            <div
              className="px-3 py-2 text-[11px] border-b"
              style={{ background: "rgba(239,68,68,0.08)", borderColor: "rgba(239,68,68,0.3)", color: "#ef4444" }}
            >
              {tab.error}
            </div>
          )}

          {tab.loading ? (
            <div className="flex-1 flex items-center justify-center text-[12px] text-secondary">Opening…</div>
          ) : (
            <div className="flex-1 min-h-0 flex">
              <Editor tab={tab} />
              {tab.diff && showDiff && <DiffPane diff={tab.diff} />}
            </div>
          )}
        </>
      )}
    </div>
  );
}
