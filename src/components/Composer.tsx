import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { ChatAttachment } from "../../shared/types";
import { NATIVE_WEB_SEARCH, PROVIDER_LABELS, SUPPORTS_TOOL_CALLS } from "../../shared/types";
import { TOOL_CATALOG, splitMentions } from "../../shared/toolCatalog";
import { useStore } from "../state/store";
import {
  CloseIcon,
  FileIcon,
  GlobeIcon,
  ImageIcon,
  PlusIcon,
  SearchGlobeIcon,
  SendIcon,
  TerminalIcon,
  FilesIcon,
  StopIcon,
  ToolIcon
} from "./icons";

export interface ComposerDraft {
  text: string;
  attachments: ChatAttachment[];
}

function formatBytes(n: number): string {
  if (n === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  return `${(n / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

/**
 * Find an in-progress @mention immediately before the caret. It only fires on
 * a token that starts a word, so "you@example.com" is left alone.
 */
function activeMention(text: string, caret: number): { start: number; query: string } | null {
  const upto = text.slice(0, caret);
  const at = upto.lastIndexOf("@");
  if (at === -1) return null;
  const before = at === 0 ? "" : upto[at - 1];
  if (before && !/\s/.test(before)) return null;
  const typed = upto.slice(at + 1);
  if (!/^\[?[a-z0-9_]*$/i.test(typed)) return null;
  return { start: at, query: typed.replace(/^\[/, "").toLowerCase() };
}

/** The plus menu: attachments, plus the on-demand tool switches. */
function PlusMenu({
  conversationId,
  onPickFile,
  onPickImage,
  onClose
}: {
  conversationId: string;
  onPickFile: () => void;
  onPickImage: () => void;
  onClose: () => void;
}) {
  const conv = useStore((s) => s.conversations.find((c) => c.id === conversationId));
  const settings = useStore((s) => s.settings);
  const providers = useStore((s) => s.providers);
  const setConversationFlag = useStore((s) => s.setConversationFlag);

  const provider = providers.find((p) => p.id === conv?.providerId) ?? providers[0];
  const webSearch = conv?.webSearch ?? settings.webSearchEnabled;
  const browserTools = conv?.browserTools ?? settings.browserToolsEnabled;
  const terminalTool = conv?.terminalTool ?? settings.terminalToolEnabled;
  const fileTools = conv?.fileTools ?? settings.fileToolsEnabled;

  const canTools = provider ? SUPPORTS_TOOL_CALLS[provider.kind] : false;
  const canSearch = provider ? NATIVE_WEB_SEARCH[provider.kind] || canTools : false;
  // Browser control includes searching, so Web reads as on whenever it is.
  const searchImplied = browserTools && canTools;
  const providerName = provider ? PROVIDER_LABELS[provider.kind] : "This provider";

  const Row = ({
    icon,
    label,
    hint,
    onClick,
    on,
    disabled
  }: {
    icon: React.ReactNode;
    label: string;
    hint: string;
    onClick: () => void;
    on?: boolean;
    disabled?: boolean;
  }) => (
    <button
      onClick={onClick}
      disabled={disabled}
      className="w-full flex items-start gap-3 px-3 py-2 rounded-lg text-left hover:bg-hover disabled:opacity-50 disabled:cursor-not-allowed"
    >
      <span className="mt-0.5 shrink-0 text-secondary">{icon}</span>
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-medium leading-tight">{label}</span>
        <span className="block text-[11px] text-secondary leading-snug mt-0.5">{hint}</span>
      </span>
      {on !== undefined && (
        <span
          className="mt-1 shrink-0 w-8 h-[18px] rounded-full transition-colors relative"
          style={{ backgroundColor: on ? "var(--accent)" : "var(--border)" }}
        >
          <span
            className="absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white transition-all"
            style={{ left: on ? "16px" : "2px" }}
          />
        </span>
      )}
    </button>
  );

  return (
    <>
      <div className="fixed inset-0 z-30" onClick={onClose} />
      <div className="absolute left-0 bottom-12 w-[300px] rounded-xl border border-border bg-bg shadow-2xl z-40 py-1.5">
        <Row
          icon={<FileIcon width={16} height={16} />}
          label="Upload a file"
          hint="Text, code, CSV, JSON — inlined into your message"
          onClick={() => {
            onPickFile();
            onClose();
          }}
        />
        <Row
          icon={<ImageIcon width={16} height={16} />}
          label="Upload a photo"
          hint="Sent to the model as an image"
          onClick={() => {
            onPickImage();
            onClose();
          }}
        />

        <div className="h-px my-1.5 bg-border" />
        <div className="px-3 pb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-secondary">
          <ToolIcon width={11} height={11} /> Tools
        </div>
        <div className="px-3 pb-1.5 text-[11px] text-secondary leading-snug">
          Available on demand — the model reaches for them when they help. Type{" "}
          <span className="font-mono text-text">@</span> in a message to force one.
        </div>
        <Row
          icon={<SearchGlobeIcon width={16} height={16} />}
          label="Web search"
          hint={
            !canSearch
              ? `${providerName} can't search here`
              : searchImplied
                ? "Included with browser control"
                : provider && NATIVE_WEB_SEARCH[provider.kind]
                  ? "The provider's own search API"
                  : "Searches in Atla's built-in browser"
          }
          on={webSearch || searchImplied}
          disabled={!canSearch || searchImplied}
          onClick={() => setConversationFlag(conversationId, "webSearch", !webSearch)}
        />
        <Row
          icon={<TerminalIcon width={16} height={16} />}
          label="Terminal"
          hint={
            canTools
              ? settings.commandApproval
                ? "Run shell commands — you approve each one"
                : "Run shell commands without asking (approval is off)"
              : `${providerName} doesn't support tool calls`
          }
          on={terminalTool}
          disabled={!canTools}
          onClick={() => setConversationFlag(conversationId, "terminalTool", !terminalTool)}
        />
        <Row
          icon={<FilesIcon width={16} height={16} />}
          label="Files"
          hint={
            canTools
              ? settings.fileWriteApproval
                ? "Read and edit files — you approve each change"
                : "Read and edit files without asking (approval is off)"
              : `${providerName} doesn't support tool calls`
          }
          on={fileTools}
          disabled={!canTools}
          onClick={() => setConversationFlag(conversationId, "fileTools", !fileTools)}
        />
        <Row
          icon={<GlobeIcon width={16} height={16} />}
          label="Browser control"
          hint={
            canTools
              ? "Open, read, and click pages in the built-in browser"
              : `${providerName} doesn't support tool calls`
          }
          on={browserTools}
          disabled={!canTools}
          onClick={() => setConversationFlag(conversationId, "browserTools", !browserTools)}
        />
      </div>
    </>
  );
}

export function Composer({
  conversationId,
  disabled,
  streaming,
  pendingPage,
  onConsumePendingPage,
  pendingDraft,
  onConsumePendingDraft,
  onSend,
  onStop
}: {
  conversationId: string;
  disabled: boolean;
  streaming: boolean;
  pendingPage?: { url: string; title: string; text: string } | null;
  onConsumePendingPage?: () => void;
  pendingDraft?: ComposerDraft | null;
  onConsumePendingDraft?: () => void;
  onSend: (text: string, attachments: ChatAttachment[]) => void;
  onStop: () => void;
}) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const sendKey = useStore((s) => s.settings.sendKey);
  const fontSize = useStore((s) => s.settings.fontSize);

  const runs = useMemo(() => splitMentions(text), [text]);

  const matches = useMemo(() => {
    if (!mention) return [];
    return TOOL_CATALOG.filter(
      (t) => t.name.includes(mention.query) || t.label.toLowerCase().includes(mention.query)
    ).slice(0, 6);
  }, [mention]);

  const autosize = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };

  // A page handed over from the built-in browser arrives as a text attachment.
  useEffect(() => {
    if (!pendingPage) return;
    const body = `${pendingPage.title}\n${pendingPage.url}\n\n${pendingPage.text}`;
    setAttachments((prev) => [
      ...prev,
      {
        name: pendingPage.title ? `${pendingPage.title.slice(0, 60)}.txt` : "page.txt",
        type: "text/plain",
        size: body.length,
        text: body
      }
    ]);
    onConsumePendingPage?.();
    textareaRef.current?.focus();
  }, [pendingPage, onConsumePendingPage]);

  // A rewind, or a queued message pulled back out, hands its draft back here.
  useEffect(() => {
    if (pendingDraft == null) return;
    setText(pendingDraft.text);
    setAttachments(pendingDraft.attachments);
    onConsumePendingDraft?.();
    const el = textareaRef.current;
    if (el) {
      el.focus();
      requestAnimationFrame(() => {
        el.style.height = "auto";
        el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
        el.setSelectionRange(el.value.length, el.value.length);
      });
    }
  }, [pendingDraft, onConsumePendingDraft]);

  const addFiles = (files: FileList) => {
    Array.from(files).forEach((file) => {
      const att: ChatAttachment = { name: file.name, type: file.type || "application/octet-stream", size: file.size };
      setAttachments((prev) => [...prev, att]);

      const isImage = file.type.startsWith("image/");
      const isText =
        file.type.startsWith("text/") ||
        /^application\/(json|xml|javascript|x-yaml|toml)$/.test(file.type) ||
        /\.(txt|md|markdown|json|jsonl|csv|tsv|js|ts|tsx|jsx|py|rb|go|rs|java|c|h|cpp|cs|php|sh|sql|html|css|scss|xml|yaml|yml|toml|ini|cfg|log|env)$/i.test(
          file.name
        );

      if (!isImage && !isText) return; // binary: keep the metadata, skip the body
      if (isText && file.size > 500_000) return;

      const reader = new FileReader();
      reader.onload = (e) => {
        const result = e.target?.result as string;
        setAttachments((prev) =>
          prev.map((a) =>
            a.name === att.name && a.size === att.size
              ? // Images ride along as data URLs; text is inlined into the prompt.
                isImage
                ? { ...a, dataUrl: result }
                : { ...a, text: result }
              : a
          )
        );
      };
      if (isImage) reader.readAsDataURL(file);
      else reader.readAsText(file);
    });
  };

  const removeAttachment = (name: string, size: number) => {
    setAttachments((prev) => prev.filter((a) => !(a.name === name && a.size === size)));
  };

  const applyMention = (name: string) => {
    if (!mention) return;
    const el = textareaRef.current;
    const caret = el?.selectionStart ?? text.length;
    const next = `${text.slice(0, mention.start)}@${name} ${text.slice(caret)}`;
    const pos = mention.start + name.length + 2;
    setText(next);
    setMention(null);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(pos, pos);
      autosize();
    });
  };

  const submit = () => {
    if (disabled) return;
    if (!text.trim() && attachments.length === 0) return;
    // While the model is busy this lands in the queue instead — the store decides.
    onSend(text, attachments);
    setText("");
    setAttachments([]);
    setMention(null);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && matches.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIndex((i) => (i + 1) % matches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIndex((i) => (i - 1 + matches.length) % matches.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        applyMention(matches[Math.min(mentionIndex, matches.length - 1)].name);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMention(null);
        return;
      }
    }
    if (e.key !== "Enter") return;
    const withMod = e.ctrlKey || e.metaKey;
    if (sendKey === "mod-enter" ? withMod : !e.shiftKey && !withMod) {
      e.preventDefault();
      submit();
    }
  };

  const hasContent = Boolean(text.trim()) || attachments.length > 0;

  return (
    <div className="w-full max-w-[760px] mx-auto px-3 sm:px-0 pb-4 pt-2">
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-3">
          {attachments.map((a) => (
            <div
              key={`${a.name}-${a.size}`}
              className="relative flex items-center gap-2 rounded-2xl px-3 py-2 pr-8 border border-border bg-input"
            >
              {a.type.startsWith("image/") && a.dataUrl ? (
                <img src={a.dataUrl} alt={a.name} className="w-10 h-10 rounded-xl object-cover shrink-0" />
              ) : (
                <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 bg-bg text-secondary">
                  <FileIcon width={16} height={16} />
                </div>
              )}
              <div className="flex flex-col min-w-0">
                <span className="text-xs font-medium truncate max-w-[140px] leading-tight">{a.name}</span>
                <span className="text-[11px] leading-none text-secondary">{formatBytes(a.size)}</span>
              </div>
              <button
                onClick={() => removeAttachment(a.name, a.size)}
                className="absolute -top-1.5 -right-1.5 w-6 h-6 rounded-full flex items-center justify-center border border-border bg-bg shadow-sm"
              >
                <CloseIcon width={12} height={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="composer-shell relative flex items-end gap-2 rounded-[28px] px-3 py-2 border border-border bg-input shadow-sm transition-shadow">
        <input
          ref={fileInput}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <input
          ref={imageInput}
          type="file"
          multiple
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = "";
          }}
        />

        <div className="relative shrink-0">
          <button
            onClick={() => setMenuOpen((o) => !o)}
            className={`bevel bevel-sm w-9 h-9 rounded-full flex items-center justify-center ${menuOpen ? "bevel-on" : ""}`}
            title="Attachments and tools"
          >
            <PlusIcon width={18} height={18} />
          </button>
          {menuOpen && (
            <PlusMenu
              conversationId={conversationId}
              onPickFile={() => fileInput.current?.click()}
              onPickImage={() => imageInput.current?.click()}
              onClose={() => setMenuOpen(false)}
            />
          )}
        </div>

        {mention && matches.length > 0 && (
          <div className="absolute left-3 right-3 bottom-[calc(100%+8px)] rounded-xl border border-border bg-bg shadow-2xl z-40 py-1 overflow-hidden">
            <div className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-secondary">
              Force a tool for this message
            </div>
            {matches.map((t, i) => (
              <button
                key={t.name}
                onMouseEnter={() => setMentionIndex(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => applyMention(t.name)}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-left"
                style={{ backgroundColor: i === mentionIndex ? "var(--hover)" : "transparent" }}
              >
                <ToolIcon width={13} height={13} className="shrink-0 text-secondary" />
                <span className="flex-1 min-w-0">
                  <span className="block text-sm leading-tight">{t.label}</span>
                  <span className="block text-[11px] text-secondary truncate">{t.description}</span>
                </span>
                <span className="font-mono text-[11px] text-secondary shrink-0">{t.name}</span>
              </button>
            ))}
          </div>
        )}

        {/* A mirrored layer paints the @mention token; the textarea sits on top
            with transparent glyphs. Only engaged once a mention is actually
            present, and it sets colour but never spacing — any metric change
            here would drift the caret away from the text it's under. */}
        <div className="relative flex-1 min-w-0">
          {runs.some((r) => r.mention) && (
            <div
              ref={overlayRef}
              aria-hidden
              className="absolute inset-0 pointer-events-none overflow-hidden whitespace-pre-wrap break-words py-2 leading-5"
              style={{ fontSize }}
            >
              {runs.map((run, i) =>
                run.mention ? (
                  <span
                    key={i}
                    style={{ color: "var(--accent)", backgroundColor: "var(--accent-soft)", borderRadius: 3 }}
                  >
                    {run.text}
                  </span>
                ) : (
                  <span key={i}>{run.text}</span>
                )
              )}
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setMention(activeMention(e.target.value, e.target.selectionStart ?? e.target.value.length));
              setMentionIndex(0);
              autosize();
            }}
            onKeyDown={onKeyDown}
            onScroll={(e) => {
              if (overlayRef.current) overlayRef.current.scrollTop = e.currentTarget.scrollTop;
            }}
            onBlur={() => setTimeout(() => setMention(null), 120)}
            placeholder={
              disabled
                ? "Add a provider in Settings to start chatting…"
                : streaming
                  ? "Type to queue the next message…"
                  : "Message Atla…"
            }
            disabled={disabled}
            rows={1}
            className="bare relative block w-full bg-transparent outline-none resize-none py-2 leading-5 max-h-[200px] min-h-[36px] disabled:opacity-50"
            style={{
              fontSize,
              ...(runs.some((r) => r.mention)
                ? { color: "transparent", caretColor: "var(--text)" }
                : {})
            }}
          />
        </div>

        {/* While streaming, Stop keeps its place and a queue button appears
            beside it only when there's something to queue — so stopping never
            gets blocked by a half-typed follow-up. */}
        {streaming && hasContent && (
          <button
            onClick={submit}
            className="bevel bevel-sm w-9 h-9 rounded-full flex items-center justify-center shrink-0"
            title="Queue this message"
          >
            <SendIcon width={16} height={16} />
          </button>
        )}
        {streaming ? (
          <button
            onClick={onStop}
            className="bevel bevel-sm bevel-on w-9 h-9 rounded-full flex items-center justify-center shrink-0"
            title="Stop generating"
          >
            <StopIcon width={14} height={14} />
          </button>
        ) : (
          <button
            onClick={submit}
            disabled={disabled || !hasContent}
            // Latch the rim light once there's something to send, so the primary
            // action still reads as primary among all-bevel controls.
            className={`bevel w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${
              !disabled && hasContent ? "bevel-on" : ""
            }`}
            title="Send"
          >
            <SendIcon width={16} height={16} />
          </button>
        )}
      </div>
      <div className="text-center mt-2">
        <span className="text-[11px] text-secondary">
          Atla can make mistakes. Verify important info.
          {sendKey === "mod-enter" ? " · Ctrl/⌘+Enter to send" : ""}
        </span>
      </div>
    </div>
  );
}
