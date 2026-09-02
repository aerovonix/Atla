import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatAttachment, ChatMessage } from "../../shared/types";
import { CheckIcon, CopyIcon, DownloadIcon, FileIcon } from "./icons";

function formatBytes(n: number): string {
  if (n === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  return `${(n / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      // ignore
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const download = () => {
    const blob = new Blob([code], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const ext = lang && lang !== "txt" ? lang : "txt";
    const a = document.createElement("a");
    a.href = url;
    a.download = `snippet.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="my-3 rounded-xl overflow-hidden border border-codeBorder bg-codeBg">
      <div className="flex items-center justify-between px-3 py-2 border-b border-codeBorder">
        <span className="font-mono text-xs lowercase text-secondary">{lang || "txt"}</span>
        <div className="flex items-center gap-1">
          <button onClick={copy} className="flex items-center gap-1.5 text-xs px-2 py-1 rounded-lg text-secondary hover:bg-hover transition-colors">
            {copied ? <CheckIcon width={12} height={12} /> : <CopyIcon width={12} height={12} />}
            {copied ? "Copied" : "Copy"}
          </button>
          <button onClick={download} className="flex items-center gap-1.5 text-xs px-2 py-1 rounded-lg text-secondary hover:bg-hover transition-colors">
            <DownloadIcon width={12} height={12} />
            Save
          </button>
        </div>
      </div>
      <pre className="p-3 overflow-x-auto text-[13px] font-mono leading-5 whitespace-pre-wrap break-words text-text">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function AttachmentList({ attachments }: { attachments: ChatAttachment[] }) {
  return (
    <div className="flex flex-wrap gap-2 mt-2">
      {attachments.map((a, i) => {
        if (a.type.startsWith("image/") && a.dataUrl) {
          return (
            <img
              key={i}
              src={a.dataUrl}
              alt={a.name}
              className="max-w-[220px] max-h-[220px] object-cover rounded-xl border border-border"
            />
          );
        }
        return (
          <div key={i} className="flex items-center gap-3 rounded-xl px-3 py-2.5 min-w-[200px] max-w-[280px] border border-border bg-input">
            <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 bg-hover text-secondary">
              <FileIcon width={16} height={16} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium truncate leading-tight">{a.name}</div>
              <div className="text-xs text-secondary truncate">
                {a.type || "file"} • {formatBytes(a.size)}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function MessageContent({ content, streaming }: { content: string; streaming?: boolean }) {
  return (
    <div className={`markdown text-[15px] leading-6 break-words${streaming ? " streaming-caret" : ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code(props) {
            const { className, children, ...rest } = props as { className?: string; children?: React.ReactNode };
            const match = /language-(\w+)/.exec(className || "");
            const inline = !match && !String(children).includes("\n");
            if (inline) {
              return (
                <code className={className} {...rest}>
                  {children}
                </code>
              );
            }
            return <CodeBlock lang={match?.[1] ?? "txt"} code={String(children).replace(/\n$/, "")} />;
          },
          a(props) {
            return <a {...props} target="_blank" rel="noopener noreferrer" />;
          }
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

export function UserMessage({ message }: { message: ChatMessage }) {
  return (
    <div className="flex justify-end">
      <div className="flex flex-col items-end max-w-[85%] sm:max-w-[75%]">
        <div className="rounded-[24px] px-4 py-3 text-[15px] leading-6 whitespace-pre-wrap break-words bg-userBubble text-text">
          {message.content}
        </div>
        {message.attachments && message.attachments.length > 0 && <AttachmentList attachments={message.attachments} />}
      </div>
    </div>
  );
}

export { AttachmentList };
