import { useEffect, useState } from "react";
import type { ApprovalRequest } from "../../shared/types";
import { TerminalIcon, FileIcon, DesktopIcon } from "./icons";

/** Colour-coded unified diff. Read-only, so it can stay this simple. */
function DiffView({ diff }: { diff: string }) {
  return (
    <pre className="rounded-xl border border-codeBorder bg-codeBg text-[12px] font-mono leading-5 max-h-64 overflow-auto">
      {diff.split("\n").map((line, i) => {
        const kind = line[0];
        const style =
          kind === "+"
            ? { background: "rgba(46, 160, 67, 0.15)", color: "var(--diff-add)" }
            : kind === "-"
              ? { background: "rgba(248, 81, 73, 0.15)", color: "var(--diff-del)" }
              : kind === "@"
                ? { color: "var(--muted)" }
                : undefined;
        return (
          <div key={i} className="px-3 whitespace-pre-wrap break-words" style={style}>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}

/**
 * The gate in front of anything the model can't take back.
 *
 * Deliberately blocking and deliberately explicit: a command is shown verbatim
 * and a file change is shown as a diff, because approving a write means
 * approving the change, not the filename. Dismissing without choosing counts
 * as a refusal. Requests queue rather than stack, so two of them can't be
 * approved by one click.
 */
export function ApprovalModal() {
  const [queue, setQueue] = useState<ApprovalRequest[]>([]);
  const current = queue[0];

  const answer = (approved: boolean, remember = false) => {
    if (!current) return;
    window.atla?.approvals?.respond({ id: current.id, approved, remember, kind: current.kind });
    setQueue((q) => q.slice(1));
  };

  // Guarded: this component sits at the root, so a bridge that's missing this
  // channel would otherwise take the whole window down with it.
  useEffect(() => window.atla?.approvals?.onRequest((req) => setQueue((q) => [...q, req])), []);

  useEffect(() => {
    if (!current) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") answer(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  if (!current) return null;

  const isWrite = current.kind === "write";
  const isDesktop = current.kind === "desktop";

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={() => answer(false)} />
      <div
        className={`relative w-full ${isWrite ? "max-w-[640px]" : "max-w-[520px]"} rounded-2xl border border-border bg-bg shadow-2xl overflow-hidden`}
      >
        <div className="flex items-center gap-2.5 px-5 pt-5 pb-3">
          <span
            className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
            style={{ background: "var(--accent-soft)", color: "var(--accent)" }}
          >
            {isDesktop ? (
              <DesktopIcon width={16} height={16} />
            ) : isWrite ? (
              <FileIcon width={16} height={16} />
            ) : (
              <TerminalIcon width={16} height={16} />
            )}
          </span>
          <div className="min-w-0">
            <div className="font-semibold leading-tight">{current.title}</div>
            <div className="text-[11px] text-secondary leading-tight mt-0.5">
              {isDesktop
                ? "Atla wants to act outside its own window."
                : isWrite
                  ? "Atla wants to change a file on your disk."
                  : "Atla wants to run this on your machine."}
            </div>
          </div>
        </div>

        <div className="px-5">
          {isWrite ? (
            <>
              <div className="text-[12px] font-mono truncate mb-1.5" title={current.detail}>
                {current.detail}
              </div>
              {current.diff ? <DiffView diff={current.diff} /> : null}
            </>
          ) : (
            <pre className="rounded-xl border border-codeBorder bg-codeBg px-3 py-2.5 text-[12px] font-mono leading-5 whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
              {current.detail}
            </pre>
          )}
          {current.context && !isWrite && (
            <div className="mt-1.5 text-[11px] text-secondary font-mono truncate" title={current.context}>
              in {current.context}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 px-5 py-4 mt-1">
          {/* Deliberately absent for desktop actions. A session grant would
              wave through exactly the irreversible clicks the confirmation
              exists to catch, and "delete" on screen three is not covered by
              a yes given on screen one. */}
          {!isDesktop && (
            <button
              onClick={() => answer(true, true)}
              className="text-[12px] px-3 py-2 rounded-full text-secondary hover:bg-hover transition-colors"
              title={
                isWrite
                  ? "Stop asking about file changes until Atla restarts"
                  : "Stop asking about commands until Atla restarts"
              }
            >
              Allow {isWrite ? "edits" : "commands"} this session
            </button>
          )}
          <div className="flex-1" />
          <button onClick={() => answer(false)} className="bevel bevel-sm px-4 py-2 rounded-full text-sm font-medium">
            Deny
          </button>
          <button
            onClick={() => answer(true)}
            autoFocus
            className="bevel bevel-on px-4 py-2 rounded-full text-sm font-medium"
          >
            {isDesktop ? "Do it" : isWrite ? "Apply" : "Run once"}
          </button>
        </div>
      </div>
    </div>
  );
}
