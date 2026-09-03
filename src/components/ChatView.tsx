import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../state/store";
import { useBrowserStore } from "../state/browserStore";
import { useTerminalStore } from "../state/terminalStore";
import { useCanvasStore } from "../state/canvasStore";
import { Composer, type ComposerDraft } from "./Composer";
import { MessageContent, StreamingContent, AttachmentList } from "./MessageBubble";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  BranchIcon,
  ChevronDownIcon,
  ClockIcon,
  CloseIcon,
  CopyIcon,
  DesktopIcon,
  ExternalIcon,
  SearchGlobeIcon,
  FileIcon,
  GlobeIcon,
  MoreIcon,
  PlayIcon,
  RegenerateIcon,
  RewindIcon,
  ReviewIcon,
  SplitIcon,
  TerminalIcon,
  TrashIcon,
  ThumbDownIcon,
  ThumbUpIcon,
  ToolIcon
} from "./icons";
import { SpeedControl } from "./SpeedControl";
import { AtlaMark } from "./AtlaMark";
import { PROVIDER_LABELS } from "../../shared/types";
import type { ChatAttachment, ChatMessage, ToolEvent } from "../../shared/types";
import {
  describeGroup,
  describeToolEvent,
  groupSegments,
  splitByToolEvents,
  splitMentions,
  splitThinking,
  type ToolGroup
} from "../../shared/toolCatalog";
import { localDayKey, pickGreeting, shouldUseWeekday } from "../../shared/greetings";
import { branchTree } from "../../shared/branching";

function ModelPicker({ conversationId }: { conversationId: string }) {
  const providers = useStore((s) => s.providers);
  const conv = useStore((s) => s.conversations.find((c) => c.id === conversationId));
  const setConversationModel = useStore((s) => s.setConversationModel);
  const [open, setOpen] = useState(false);

  const activeProvider = providers.find((p) => p.id === conv?.providerId) ?? providers[0];
  const activeModel = conv?.model || activeProvider?.defaultModel || activeProvider?.models[0];

  if (providers.length === 0) return <span className="text-xs text-secondary">No providers configured</span>;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-border bg-input text-sm font-medium hover:bg-hover transition-colors"
      >
        <span className="truncate max-w-[240px]">
          {activeProvider?.label || "Provider"} · {activeModel || "no model"}
        </span>
        <ChevronDownIcon open={open} width={12} height={12} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-10 w-80 max-h-96 overflow-y-auto rounded-xl border border-border bg-bg shadow-2xl z-40 py-1">
            {providers.map((p) => (
              <div key={p.id} className="px-2 py-1">
                <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-secondary">
                  {p.label || PROVIDER_LABELS[p.kind]}
                </div>
                {p.models.length === 0 && (
                  <div className="px-2 py-1.5 text-xs text-secondary">No models — auto-detect in Settings</div>
                )}
                {p.models.map((m) => (
                  <button
                    key={m}
                    onClick={() => {
                      setConversationModel(conversationId, p.id, m);
                      setOpen(false);
                    }}
                    className="w-full text-left px-2 py-1.5 rounded-lg text-sm flex items-center justify-between hover:bg-hover"
                  >
                    <span className="truncate">{m}</span>
                    {activeProvider?.id === p.id && activeModel === m && (
                      <CheckIcon width={14} height={14} style={{ color: "var(--accent)" }} />
                    )}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function MessageMenu({
  conversationId,
  message,
  onRestoreDraft
}: {
  conversationId: string;
  message: ChatMessage;
  onRestoreDraft: (draft: ComposerDraft) => void;
}) {
  const [open, setOpen] = useState(false);
  const rewindTo = useStore((s) => s.rewindTo);
  const branchFrom = useStore((s) => s.branchFrom);
  const deleteMessage = useStore((s) => s.deleteMessage);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="bevel bevel-sm w-7 h-7 rounded-full flex items-center justify-center"
        title="More"
      >
        <MoreIcon width={13} height={13} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute left-0 bottom-9 w-56 rounded-xl border border-border bg-bg shadow-2xl z-40 py-1">
            <button
              onClick={() => {
                const restored = rewindTo(conversationId, message.id);
                if (restored !== null) onRestoreDraft({ text: restored, attachments: [] });
                setOpen(false);
              }}
              className="w-full text-left px-3 py-2 text-sm hover:bg-hover flex items-start gap-2"
            >
              <RewindIcon width={14} height={14} className="mt-0.5 shrink-0" />
              <span>
                Rewind to here
                <span className="block text-[11px] text-secondary">
                  {message.role === "assistant"
                    ? "Undo this turn and put the prompt back"
                    : "Remove this and everything after"}
                </span>
              </span>
            </button>
            <button
              onClick={() => {
                branchFrom(conversationId, message.id);
                setOpen(false);
              }}
              className="w-full text-left px-3 py-2 text-sm hover:bg-hover flex items-start gap-2"
            >
              <BranchIcon width={14} height={14} className="mt-0.5 shrink-0" />
              <span>
                Branch from here
                <span className="block text-[11px] text-secondary">
                  Copy the chat up to this point and carry on separately
                </span>
              </span>
            </button>
            <div className="h-px my-1 bg-border" />
            <button
              onClick={() => {
                deleteMessage(conversationId, message.id);
                setOpen(false);
              }}
              className="w-full text-left px-3 py-2 text-sm text-red-500 flex items-center gap-2"
            >
              <TrashIcon width={14} height={14} />
              Delete message
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * One tool call, drawn inline where it happened in the answer.
 */
/**
 * The tree this chat belongs to. Only rendered when there is more than one
 * node — a "branches" list showing a single chat is just noise.
 */
function BranchesMenu({ conversationId }: { conversationId: string }) {
  const [open, setOpen] = useState(false);
  const conversations = useStore((s) => s.conversations);
  const select = useStore((s) => s.selectConversation);
  const openSplit = useStore((s) => s.openSplit);
  const tree = useMemo(() => branchTree(conversations, conversationId), [conversations, conversationId]);

  if (tree.length === 0) return null;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="h-8 px-2 rounded-lg flex items-center gap-1.5 transition-colors hover:bg-hover text-[12px]"
        style={{ color: open ? "var(--accent)" : "var(--secondary)" }}
        title="Branches in this chat"
      >
        <BranchIcon width={15} height={15} />
        {tree.length}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-9 w-72 rounded-xl border border-border bg-bg shadow-2xl z-40 py-1 max-h-[60vh] overflow-y-auto">
            <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-secondary">
              Branches in this chat
            </div>
            {tree.map((node) => (
              <div
                key={node.id}
                className={`group flex items-center gap-1 pr-1 ${node.id === conversationId ? "bg-hover" : ""}`}
              >
                <button
                  onClick={() => {
                    select(node.id);
                    setOpen(false);
                  }}
                  className="flex-1 min-w-0 text-left px-3 py-2 text-sm hover:bg-hover"
                  style={{ paddingLeft: `${12 + node.depth * 14}px` }}
                >
                  <span className="block truncate">{node.title}</span>
                  <span className="block text-[11px] text-secondary">
                    {node.depth === 0 ? "root" : `split off · ${node.messageCount} messages`}
                  </span>
                </button>
                {node.id !== conversationId && (
                  <button
                    onClick={() => {
                      openSplit(node.id);
                      setOpen(false);
                    }}
                    title="Open beside this one"
                    className="shrink-0 opacity-0 group-hover:opacity-100 p-1.5 rounded-md text-secondary hover:bg-hover transition-opacity"
                  >
                    <SplitIcon width={13} height={13} />
                  </button>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** Colour-coded unified diff, shared by tool cards and the edited-files list. */
function DiffBlock({ diff }: { diff: string }) {
  return (
    <pre className="text-[12px] font-mono leading-5 max-h-60 overflow-auto rounded-lg border border-codeBorder bg-codeBg">
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
          <div key={i} className="px-2.5 whitespace-pre-wrap break-words" style={style}>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}

/**
 * One line under a reply summarising everything it changed on disk. The tool
 * cards already show each write in place; this exists so a long turn with
 * edits scattered through it still ends with an answerable "what did it touch".
 */
function EditedFiles({ events }: { events: ToolEvent[] }) {
  const [open, setOpen] = useState(false);
  const openInCanvas = useCanvasStore((s) => s.openFile);
  // Same file edited twice is one file, but the last diff is the one that stuck.
  const byPath = new Map<string, ToolEvent>();
  for (const e of events) if (e.wrote && e.path) byPath.set(e.path, e);
  const edits = [...byPath.values()];
  if (edits.length === 0) return null;

  return (
    <div className="mt-2">
      <button
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 text-[12px] px-2 py-1 rounded-full border border-border text-secondary hover:bg-hover transition-colors"
      >
        <FileIcon width={11} height={11} />
        Edited {edits.length} file{edits.length === 1 ? "" : "s"}
        <ChevronDownIcon open={open} width={10} height={10} />
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {edits.map((e) => (
            <div key={e.path} className="rounded-xl border border-border overflow-hidden">
              <div className="flex items-center gap-2 px-3 py-1.5 bg-input">
                <span className="flex-1 min-w-0 text-[12px] font-mono truncate" title={e.path}>
                  {e.path}
                </span>
                <button
                  onClick={() => void openInCanvas(e.path as string, e.diff)}
                  className="shrink-0 text-[11px] px-2 py-0.5 rounded-md text-secondary hover:bg-hover transition-colors"
                  title="Open this file in the canvas"
                >
                  Show more
                </button>
              </div>
              {e.diff ? <DiffBlock diff={e.diff} /> : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const GROUP_ICON: Record<ToolGroup, (p: { width: number; height: number }) => JSX.Element> = {
  web: (p) => <SearchGlobeIcon {...p} />,
  browser: (p) => <GlobeIcon {...p} />,
  terminal: (p) => <TerminalIcon {...p} />,
  files: (p) => <FileIcon {...p} />,
  desktop: (p) => <DesktopIcon {...p} />,
  other: (p) => <ToolIcon {...p} />
};

/**
 * A run of tool calls, shown as one line until it's opened.
 *
 * A single call renders as its own card, because "Used the browser 1 time"
 * says less than "Navigated to example.com" and costs the same space. It's
 * only worth collapsing once there are several.
 */
function ToolRunCard({ group, events }: { group: ToolGroup; events: ToolEvent[] }) {
  const [open, setOpen] = useState(false);
  const failures = events.filter((e) => !e.ok).length;

  if (events.length === 1) return <ToolCard event={events[0]} />;

  return (
    <div className="my-2 rounded-xl border border-border overflow-hidden" style={{ background: "var(--input)" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-3 py-2 text-[13px] hover:bg-hover transition-colors"
      >
        <span className="shrink-0" style={{ color: failures ? "#ef4444" : "var(--secondary)" }}>
          {GROUP_ICON[group]({ width: 13, height: 13 })}
        </span>
        <span className="flex-1 min-w-0 truncate text-left font-medium">
          {describeGroup(group, events.length, failures)}
        </span>
        <ChevronDownIcon open={open} width={11} height={11} />
      </button>
      {open && (
        <div className="border-t border-border px-2 py-1">
          {events.map((e, i) => (
            <ToolCard key={i} event={e} />
          ))}
        </div>
      )}
    </div>
  );
}

function ToolCard({ event }: { event: ToolEvent }) {
  const [open, setOpen] = useState(false);
  const requestNavigate = useBrowserStore((s) => s.requestNavigate);
  const openInCanvas = useCanvasStore((s) => s.openFile);
  const hasDetail = Boolean(event.detail || event.args);

  return (
    <div
      className="my-2 rounded-xl border overflow-hidden"
      style={
        event.ok
          ? { borderColor: "var(--border)", background: "var(--input)" }
          : { borderColor: "rgba(239,68,68,0.4)", background: "rgba(239,68,68,0.06)" }
      }
    >
      <div className="flex items-center gap-2 px-3 py-2 text-[13px]">
        <span className="shrink-0" style={{ color: event.ok ? "var(--secondary)" : "#ef4444" }}>
          <ToolIcon width={13} height={13} />
        </span>
        <span className="flex-1 min-w-0 truncate font-medium">{describeToolEvent(event)}</span>
        {event.path && !event.url && (
          <>
            <span className="w-px h-3.5 shrink-0 bg-border" />
            <button
              onClick={() => void openInCanvas(event.path as string, event.diff)}
              className="shrink-0 flex items-center gap-1 text-[12px] px-1.5 py-0.5 rounded-md text-secondary hover:bg-hover transition-colors"
              title="Open this file in the canvas"
            >
              <FileIcon width={11} height={11} />
              Open
            </button>
          </>
        )}
        {event.url && (
          <>
            <span className="w-px h-3.5 shrink-0 bg-border" />
            <button
              onClick={() => requestNavigate(event.url as string)}
              className="shrink-0 flex items-center gap-1 text-[12px] px-1.5 py-0.5 rounded-md text-secondary hover:bg-hover transition-colors"
              title="Open this page in the built-in browser"
            >
              <ExternalIcon width={11} height={11} />
              Open
            </button>
          </>
        )}
        {hasDetail && (
          <>
            <span className="w-px h-3.5 shrink-0 bg-border" />
            <button
              onClick={() => setOpen((o) => !o)}
              className="shrink-0 flex items-center gap-1 text-[12px] px-1.5 py-0.5 rounded-md text-secondary hover:bg-hover transition-colors"
            >
              {open ? "Hide details" : "View details"}
              <ChevronDownIcon open={open} width={10} height={10} />
            </button>
          </>
        )}
      </div>
      {open && hasDetail && (
        <div className="border-t border-border px-3 py-2.5 space-y-2.5">
          {event.args && (
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-secondary mb-1">Arguments</div>
              <pre className="text-[12px] font-mono leading-5 whitespace-pre-wrap break-words text-secondary max-h-40 overflow-y-auto">
                {event.args}
              </pre>
            </div>
          )}
          {event.diff ? (
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-secondary mb-1">Changes</div>
              <DiffBlock diff={event.diff} />
            </div>
          ) : null}
          {event.detail && !event.diff && (
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-secondary mb-1">
                {event.ok ? "Result" : "Error"}
              </div>
              <pre className="text-[12px] font-mono leading-5 whitespace-pre-wrap break-words text-secondary max-h-60 overflow-y-auto">
                {event.detail}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * What a reviewer asked for, and what the reply said before it. Collapsed by
 * default: the revised answer is the answer, and the review is working notes
 * the user can look at if they want to know why it changed.
 */
function RevisionBlock({ message }: { message: ChatMessage }) {
  const [open, setOpen] = useState(false);
  if (!message.critique) return null;

  return (
    <div className="mt-2">
      <button
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 text-[12px] px-2 py-1 rounded-full border border-border text-secondary hover:bg-hover transition-colors"
      >
        <ReviewIcon width={11} height={11} />
        Revised after review
        <ChevronDownIcon open={open} width={10} height={10} />
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          <div className="rounded-xl border border-border overflow-hidden">
            <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-secondary bg-input">
              The reviewer asked for
            </div>
            <div className="px-3 py-2">
              <MessageContent content={message.critique} streaming={false} />
            </div>
          </div>
          {message.original && (
            <div className="rounded-xl border border-border overflow-hidden">
              <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-secondary bg-input">
                Before the revision
              </div>
              <div className="px-3 py-2 max-h-60 overflow-y-auto opacity-70">
                <MessageContent content={message.original} streaming={false} />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The greeting, typed out a character at a time.
 *
 * Done in JS rather than with a CSS steps() reveal because the greeting is set
 * in PT Serif — a proportional face, so a width-based reveal would uncover
 * fractions of letters and drift out of step with the caret. Reserving the
 * final text with an invisible copy keeps the line from reflowing as it fills,
 * which matters because it is centred.
 */
function TypedGreeting({ text }: { text: string }) {
  const [shown, setShown] = useState(0);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    setShown(0);
    if (reduced || !text) return;
    let i = 0;
    let typer = 0;
    // Held back until the mark has nearly landed: starting both at once makes
    // them compete, and the line reads better as a reply to the logo arriving.
    const start = window.setTimeout(() => {
      typer = window.setInterval(() => {
        i += 1;
        setShown(i);
        if (i >= text.length) window.clearInterval(typer);
      }, 38);
    }, 520);
    return () => {
      window.clearTimeout(start);
      window.clearInterval(typer);
    };
  }, [text, reduced]);

  if (reduced) return <>{text}</>;

  const done = shown >= text.length;
  return (
    <span className="relative inline-block">
      {/* Reserves the full width so the centred line doesn't shuffle. */}
      <span aria-hidden className="invisible">
        {text}
      </span>
      <span className="absolute inset-0 flex items-center justify-center whitespace-pre">
        {text.slice(0, shown)}
        <span className={`greet-caret${done ? " greet-caret-idle" : ""}`} aria-hidden />
      </span>
    </span>
  );
}

/** Honours the OS setting, and keeps honouring it if it changes mid-session. */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

/** The body of an assistant turn: text and tool cards, in the order they happened. */
function AssistantBody({ message, streaming }: { message: ChatMessage; streaming: boolean }) {
  const { thinking, answer, thinkingOpen } = useMemo(() => splitThinking(message.content), [message.content]);

  // Tool offsets were recorded against the raw content, so pulling the
  // reasoning out shifts them. Reasoning models put their <think> block at the
  // very start, before any tool call, so subtracting what was removed lands
  // the cards in the right place; splitByToolEvents clamps anything that
  // doesn't, so a model that interleaves them misplaces a card rather than
  // breaking.
  const shift = message.content.length - answer.length;
  const events = useMemo(
    () => (message.toolEvents ?? []).map((e) => (e.at === undefined ? e : { ...e, at: Math.max(0, e.at - shift) })),
    [message.toolEvents, shift]
  );
  const segments = useMemo(() => groupSegments(splitByToolEvents(answer, events)), [answer, events]);

  // The caret belongs on the last run of text, not on a trailing tool card.
  let lastText = -1;
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i].kind === "text") {
      lastText = i;
      break;
    }
  }
  const endsOnTool = segments.length > 0 && segments[segments.length - 1].kind === "tools";

  return (
    <>
      {(thinking || (streaming && thinkingOpen)) && (
        <ThinkingBlock text={thinking} active={streaming && thinkingOpen} />
      )}
      {segments.map((seg, i) =>
        seg.kind === "tools" ? (
          <ToolRunCard key={`tools-${seg.key}`} group={seg.group} events={seg.events} />
        ) : (
          streaming && i === lastText ? (
            <StreamingContent key={`text-${i}`} content={seg.text} />
          ) : (
            <MessageContent key={`text-${i}`} content={seg.text} />
          )
        )
      )}
      {/* Nothing to show yet, or the last thing was a tool call — either way
          the model is still working, so keep the indicator alive. */}
      {streaming && !thinkingOpen && (segments.length === 0 || endsOnTool) && <TypingDots />}
      {message.reviewing && (
        <div className="flex items-center gap-2 pt-1.5 text-[12px] text-secondary">
          <ThinkingDots />
          Reviewing the answer&hellip;
        </div>
      )}
      {!streaming && <RevisionBlock message={message} />}
      {!streaming && <EditedFiles events={events} />}
    </>
  );
}

function ThinkingDots() {
  return (
    <span className="think" role="status" aria-label="Working">
      <span className="think-spin">
        <i />
        <i />
        <i />
        <i />
      </span>
    </span>
  );
}

function TypingDots() {
  return (
    <div className="flex items-center pt-1.5">
      <ThinkingDots />
    </div>
  );
}

/**
 * Reasoning models put their scratch work in <think> tags. It's worth keeping
 * — it's often where the actual reasoning is — but it isn't the answer, so it
 * gets its own block, collapsed by default.
 */
function ThinkingBlock({ text, active }: { text: string; active: boolean }) {
  const [open, setOpen] = useState(false);
  if (!text && !active) return null;

  return (
    <div className="my-2 rounded-xl border border-border bg-input overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-3 py-2 text-[13px] text-left hover:bg-hover transition-colors"
      >
        {active ? <ThinkingDots /> : <ToolIcon width={13} height={13} className="text-secondary shrink-0" />}
        <span className="font-medium">{active ? "Thinking…" : "Thought it through"}</span>
        <div className="flex-1" />
        {text && (
          <span className="flex items-center gap-1 text-[12px] text-secondary">
            {open ? "Hide" : "View details"}
            <ChevronDownIcon open={open} width={10} height={10} />
          </span>
        )}
      </button>
      {open && text && (
        <div className="border-t border-border px-3 py-2.5">
          <pre className="text-[12px] leading-5 whitespace-pre-wrap break-words text-secondary max-h-72 overflow-y-auto">
            {text}
          </pre>
        </div>
      )}
    </div>
  );
}

/** Messages typed while the model was busy, waiting their turn. */
function QueueStrip({
  conversationId,
  streaming,
  onEdit
}: {
  conversationId: string;
  streaming: boolean;
  onEdit: (draft: ComposerDraft) => void;
}) {
  const items = useStore((s) => s.queue[conversationId] ?? []);
  const removeQueued = useStore((s) => s.removeQueued);
  const moveQueued = useStore((s) => s.moveQueued);
  const editQueued = useStore((s) => s.editQueued);
  const sendNextQueued = useStore((s) => s.sendNextQueued);

  if (items.length === 0) return null;

  return (
    <div className="w-full max-w-[760px] mx-auto px-3 sm:px-0 pt-2">
      <div className="flex items-center gap-2 px-1 pb-1.5">
        <ClockIcon width={12} height={12} className="text-secondary" />
        <span className="text-[11px] font-medium text-secondary">
          {items.length} queued{streaming ? " · sends when this finishes" : " · paused"}
        </span>
        <div className="flex-1" />
        {!streaming && (
          <button
            onClick={() => sendNextQueued(conversationId)}
            className="bevel bevel-sm flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full"
            title="Send the next queued message now"
          >
            <PlayIcon width={9} height={9} /> Send next
          </button>
        )}
      </div>
      {/* Capped so a long queue can't push the conversation off screen. */}
      <div className="space-y-1 max-h-[132px] overflow-y-auto">
        {items.map((q, i) => (
          <div key={q.id} className="flex items-center gap-2 rounded-xl px-2.5 py-1.5 border border-border bg-input">
            <span className="text-[11px] font-mono text-secondary w-4 shrink-0">{i + 1}</span>
            <button
              onClick={() => {
                const item = editQueued(conversationId, q.id);
                if (item) onEdit({ text: item.text, attachments: item.attachments });
              }}
              className="flex-1 min-w-0 text-left text-[13px] truncate hover:underline"
              title="Edit this message"
            >
              {q.text.trim() || `${q.attachments.length} attachment${q.attachments.length === 1 ? "" : "s"}`}
            </button>
            {q.attachments.length > 0 && q.text.trim() && (
              <span className="text-[11px] text-secondary shrink-0">+{q.attachments.length}</span>
            )}
            {items.length > 1 && (
              <>
                <button
                  onClick={() => moveQueued(conversationId, q.id, -1)}
                  disabled={i === 0}
                  className="w-6 h-6 rounded-md flex items-center justify-center text-secondary hover:bg-hover disabled:opacity-30 shrink-0"
                  title="Move up"
                >
                  <ArrowUpIcon width={12} height={12} />
                </button>
                <button
                  onClick={() => moveQueued(conversationId, q.id, 1)}
                  disabled={i === items.length - 1}
                  className="w-6 h-6 rounded-md flex items-center justify-center text-secondary hover:bg-hover disabled:opacity-30 shrink-0"
                  title="Move down"
                >
                  <ArrowDownIcon width={12} height={12} />
                </button>
              </>
            )}
            <button
              onClick={() => removeQueued(conversationId, q.id)}
              className="w-6 h-6 rounded-md flex items-center justify-center text-secondary hover:bg-hover shrink-0"
              title="Remove from queue"
            >
              <CloseIcon width={12} height={12} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ChatView({
  conversationId,
  onOpenSettings,
  pendingPage,
  onConsumePendingPage,
  pendingDraft,
  onConsumePendingDraft,
  onRestoreDraft,
  onClose
}: {
  conversationId: string;
  onOpenSettings: () => void;
  /** Present only in the split pane, where the view can be dismissed. */
  onClose?: () => void;
  pendingPage: { url: string; title: string; text: string } | null;
  onConsumePendingPage: () => void;
  pendingDraft: ComposerDraft | null;
  onConsumePendingDraft: () => void;
  onRestoreDraft: (draft: ComposerDraft) => void;
}) {
  const conv = useStore((s) => s.conversations.find((c) => c.id === conversationId));
  const providers = useStore((s) => s.providers);
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const sendMessage = useStore((s) => s.sendMessage);
  const stopStreaming = useStore((s) => s.stopStreaming);
  const regenerate = useStore((s) => s.regenerate);
  const continueMessage = useStore((s) => s.continueMessage);
  const toggleFeedback = useStore((s) => s.toggleFeedback);
  const streaming = useStore((s) => Object.values(s.streaming).some((v) => v.conversationId === conversationId));
  const toggleBrowser = useBrowserStore((s) => s.toggle);
  const browserOpen = useBrowserStore((s) => s.open);
  const toggleTerminal = useTerminalStore((s) => s.toggle);
  // The canvas button only exists once something is open in it — an empty
  // pane isn't a destination, so a toggle for it would be a dead control.
  const canvasOpen = useCanvasStore((s) => s.open);
  const canvasTabs = useCanvasStore((s) => s.tabs.length);
  const setCanvasOpen = useCanvasStore((s) => s.setOpen);
  const toggleCanvas = () => setCanvasOpen(!canvasOpen);
  const terminalOpen = useTerminalStore((s) => s.open);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const lastMessage = conv?.messages[conv.messages.length - 1];
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [conv?.messages.length, lastMessage?.content]);

  const hasProviders = providers.length > 0;
  const conversations = useStore((s) => s.conversations);

  // The weekday line is for the day's first chat, so it stays a small moment
  // rather than something you read every time you open a tab.
  // Decided once per empty chat and then frozen. It can't be a useMemo any
  // more: choosing the weekday line also *consumes* it for the day, and a memo
  // that writes settings would re-run, flip its own input, and visibly swap the
  // greeting out from under the reader.
  const [greeting, setGreeting] = useState("");
  const decidedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!conv || conv.messages.length > 0) {
      // Not an empty chat, so nothing is being greeted. Left undecided rather
      // than skipped-and-marked: opening an old conversation must not burn
      // today's weekday line on a screen that never shows it.
      decidedFor.current = null;
      return;
    }
    if (decidedFor.current === conversationId) return;
    decidedFor.current = conversationId;

    const today = localDayKey();
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const hadConversationToday = conversations.some((c) =>
      c.messages.some((m) => m.timestamp >= startOfDay.getTime())
    );
    const weekday = shouldUseWeekday({
      today,
      lastShown: settings.lastWeekdayGreetingOn,
      hadConversationToday
    });

    setGreeting(pickGreeting({ name: settings.profileName, firstSessionToday: weekday }));
    if (weekday) updateSettings({ lastWeekdayGreetingOn: today });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, conv?.messages.length]);

  if (!conv) return null;

  const copyMessage = async (id: string, content: string) => {
    try {
      await navigator.clipboard.writeText(content);
    } catch {
      /* ignore */
    }
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  const gap = settings.density === "compact" ? "space-y-3" : "space-y-6";

  return (
    <div className="flex-1 flex flex-col min-w-0 h-full bg-bg">
      <div className="h-[52px] flex items-center gap-2 px-4 shrink-0 border-b border-borderLight">
        <ModelPicker conversationId={conversationId} />
        <div className="flex-1" />
        <BranchesMenu conversationId={conversationId} />
        {onClose && (
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg flex items-center justify-center transition-colors hover:bg-hover text-secondary"
            title="Close this pane"
          >
            <CloseIcon width={15} height={15} />
          </button>
        )}
        {canvasTabs > 0 && (
          <button
            onClick={toggleCanvas}
            className="w-8 h-8 rounded-lg flex items-center justify-center transition-colors hover:bg-hover"
            style={{ color: canvasOpen ? "var(--accent)" : "var(--secondary)" }}
            title="Toggle the canvas"
          >
            <FileIcon width={16} height={16} />
          </button>
        )}
        <button
          onClick={toggleTerminal}
          className="w-8 h-8 rounded-lg flex items-center justify-center transition-colors hover:bg-hover"
          style={{ color: terminalOpen ? "var(--accent)" : "var(--secondary)" }}
          title="Toggle terminal"
        >
          <TerminalIcon width={16} height={16} />
        </button>
        <button
          onClick={toggleBrowser}
          className="w-8 h-8 rounded-lg flex items-center justify-center transition-colors hover:bg-hover"
          style={{ color: browserOpen ? "var(--accent)" : "var(--secondary)" }}
          title="Toggle built-in browser"
        >
          <GlobeIcon width={16} height={16} />
        </button>
        {browserOpen && <SpeedControl />}
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto overflow-x-hidden">
        {conv.messages.length === 0 ? (
          <div key={conv.id} className="h-full flex flex-col items-center justify-center text-center px-6 pb-10">
            <AtlaMark size={104} className="mb-8 greet-mark" />
            <h1 className="text-[40px] leading-[1.15] font-bold tracking-tight">
              <TypedGreeting text={greeting} />
            </h1>
            {!hasProviders && (
              <button onClick={onOpenSettings} className="mt-6 text-sm px-4 py-2 rounded-full bg-text text-bg font-medium">
                Add a provider to get started
              </button>
            )}
          </div>
        ) : (
          <div className="w-full max-w-[760px] mx-auto px-4 py-6" style={{ fontSize: settings.fontSize }}>
            <div className={gap}>
              {conv.messages.map((m) => {
                if (m.role === "user") {
                  return (
                    <div key={m.id} className="group flex justify-end items-start gap-2">
                      <div className="opacity-0 group-hover:opacity-100 transition-opacity mt-1">
                        <MessageMenu conversationId={conversationId} message={m} onRestoreDraft={onRestoreDraft} />
                      </div>
                      <div className="flex flex-col items-end max-w-[85%] sm:max-w-[75%]">
                        <div className="rounded-[24px] px-4 py-3 leading-6 whitespace-pre-wrap break-words bg-userBubble text-text">
                          {splitMentions(m.content).map((run, i) =>
                            run.mention ? (
                              <strong key={i} className="font-bold" style={{ color: "var(--accent)" }}>
                                {run.text}
                              </strong>
                            ) : (
                              <span key={i}>{run.text}</span>
                            )
                          )}
                        </div>
                        {m.attachments && m.attachments.length > 0 && (
                          <AttachmentList attachments={m.attachments as ChatAttachment[]} />
                        )}
                      </div>
                    </div>
                  );
                }
                const isStreamingThis = streaming && m.id === conv.messages[conv.messages.length - 1]?.id;
                return (
                  <div key={m.id} className="flex gap-3 w-full">
                    <div className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 mt-0.5 bg-input border border-border">
                      <AtlaMark size={17} />
                    </div>
                    <div className="flex-1 min-w-0 pt-0.5">
                      <AssistantBody message={m} streaming={isStreamingThis} />

                      {!isStreamingThis && m.interrupted && (
                        <div className="flex items-center gap-2 mt-2.5">
                          <span className="text-[11px] px-2 py-1 rounded-full border border-border bg-input text-secondary">
                            Stopped
                          </span>
                          <button
                            onClick={() => continueMessage(conversationId, m.id)}
                            className="bevel bevel-sm flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full"
                            title="Pick up where it left off"
                          >
                            <PlayIcon width={9} height={9} /> Continue
                          </button>
                        </div>
                      )}

                      {!isStreamingThis && m.content && (
                        <div className="flex items-center gap-1 mt-3">
                          <button
                            onClick={() => copyMessage(m.id, m.content)}
                            className="bevel bevel-sm w-7 h-7 rounded-full flex items-center justify-center"
                            title="Copy"
                          >
                            {copiedId === m.id ? <CheckIcon width={13} height={13} /> : <CopyIcon width={13} height={13} />}
                          </button>
                          <button
                            onClick={() => toggleFeedback(conversationId, m.id, "like")}
                            className={`bevel bevel-sm w-7 h-7 rounded-full flex items-center justify-center ${m.liked ? "bevel-on" : ""}`}
                            title="Good response"
                          >
                            <ThumbUpIcon active={m.liked} width={13} height={13} />
                          </button>
                          <button
                            onClick={() => toggleFeedback(conversationId, m.id, "dislike")}
                            className={`bevel bevel-sm w-7 h-7 rounded-full flex items-center justify-center ${m.disliked ? "bevel-on" : ""}`}
                            title="Bad response"
                          >
                            <ThumbDownIcon active={m.disliked} width={13} height={13} />
                          </button>
                          <button
                            onClick={() => regenerate(conversationId)}
                            className="bevel bevel-sm w-7 h-7 rounded-full flex items-center justify-center"
                            title="Regenerate"
                          >
                            <RegenerateIcon width={13} height={13} />
                          </button>
                          <MessageMenu conversationId={conversationId} message={m} onRestoreDraft={onRestoreDraft} />
                          {settings.showModelInMessages && m.model && (
                            <span className="text-[11px] text-secondary ml-1">{m.model}</span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <QueueStrip conversationId={conversationId} streaming={streaming} onEdit={onRestoreDraft} />

      <Composer
        conversationId={conversationId}
        disabled={!hasProviders}
        streaming={streaming}
        pendingPage={pendingPage}
        onConsumePendingPage={onConsumePendingPage}
        pendingDraft={pendingDraft}
        onConsumePendingDraft={onConsumePendingDraft}
        onSend={(text, attachments) => sendMessage(conversationId, text, attachments)}
        onStop={() => stopStreaming(conversationId)}
      />
    </div>
  );
}
