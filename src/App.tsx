import { useCallback, useEffect, useState } from "react";
import { useStore } from "./state/store";
import { Sidebar } from "./components/Sidebar";
import { ChatView } from "./components/ChatView";
import { SettingsModal } from "./components/SettingsModal";
import { BrowserPanel } from "./components/BrowserPanel";
import { TerminalPanel } from "./components/TerminalPanel";
import { ApprovalModal } from "./components/ApprovalModal";
import { CanvasPanel } from "./components/CanvasPanel";
import { Onboarding } from "./components/Onboarding";
import { attachDashBridge } from "./state/dashBridge";
import { AtlaMark } from "./components/AtlaMark";
import type { ComposerDraft } from "./components/Composer";
import { resolveTheme } from "../shared/types";

/** Inert handler for the split pane, which has no draft or page of its own. */
const noop = () => {};

export default function App() {
  const hydrated = useStore((s) => s.hydrated);
  const hydrationError = useStore((s) => s.hydrationError);
  const hydrate = useStore((s) => s.hydrate);
  const activeConversationId = useStore((s) => s.activeConversationId);
  const theme = useStore((s) => s.settings.theme);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pendingPage, setPendingPage] = useState<{ url: string; title: string; text: string } | null>(null);
  const [pendingDraft, setPendingDraft] = useState<ComposerDraft | null>(null);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  // Always attached, even with the dash stopped: main only ever sends a
  // request while the server is up, and attaching lazily would race a phone
  // that paired before this effect ran.
  useEffect(() => attachDashBridge(), []);

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

  const settings = useStore((s) => s.settings);
  const splitConversationId = useStore((s) => s.splitConversationId);
  const closeSplit = useStore((s) => s.closeSplit);

  const consumePendingPage = useCallback(() => setPendingPage(null), []);
  const consumePendingDraft = useCallback(() => setPendingDraft(null), []);

  if (hydrationError) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-bg text-text p-8">
        <div className="max-w-md text-center space-y-3">
          <div className="w-12 h-12 rounded-2xl flex items-center justify-center bg-input border border-border mx-auto">
            <AtlaMark size={26} />
          </div>
          <h1 className="font-semibold text-lg">Atla couldn't start</h1>
          <p className="text-sm text-secondary">{hydrationError}</p>
          <button onClick={() => void hydrate()} className="mt-2 px-4 py-2 rounded-full text-sm font-medium bg-text text-bg">
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!hydrated) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-bg text-text">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 rounded-2xl flex items-center justify-center bg-input border border-border">
            <AtlaMark size={26} />
          </div>
          <div className="w-6 h-6 border-2 rounded-full animate-spin border-border" style={{ borderTopColor: "var(--accent)" }} />
        </div>
      </div>
    );
  }

  // Before anything else: a first run has no provider, so every other surface
  // would just be a wall of empty state.
  if (!settings.onboarded) return <Onboarding onDone={() => undefined} />;

  return (
    <div className="h-screen w-screen flex overflow-hidden bg-bg text-text">
      <Sidebar onOpenSettings={() => setSettingsOpen(true)} />
      {/* Chat and browser sit side by side; the terminal spans beneath both. */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex-1 flex min-h-0">
          {activeConversationId && (
            <ChatView
              conversationId={activeConversationId}
              onOpenSettings={() => setSettingsOpen(true)}
              pendingPage={pendingPage}
              onConsumePendingPage={consumePendingPage}
              pendingDraft={pendingDraft}
              onConsumePendingDraft={consumePendingDraft}
              onRestoreDraft={setPendingDraft}
            />
          )}
          {splitConversationId && splitConversationId !== activeConversationId && (
            // A second, independent chat beside the first. Given inert
            // handlers on purpose: "send page to chat" and draft restoration
            // belong to whichever pane the user is actually driving, and two
            // panes competing for one pending draft would drop it.
            <div className="flex-1 flex min-w-0 border-l border-border">
              <ChatView
                conversationId={splitConversationId}
                onOpenSettings={() => setSettingsOpen(true)}
                pendingPage={null}
                onConsumePendingPage={noop}
                pendingDraft={null}
                onConsumePendingDraft={noop}
                onRestoreDraft={noop}
                onClose={closeSplit}
              />
            </div>
          )}
          {/* The canvas sits between chat and browser: it's a working surface
              for the conversation, not a separate destination like the browser. */}
          <CanvasPanel />
          {/* Stays mounted so the model can drive it even while the panel is hidden. */}
          <BrowserPanel onSendPageToChat={setPendingPage} />
        </div>
        <TerminalPanel />
      </div>
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      {/* Sits above everything: a permission prompt must never be missable. */}
      <ApprovalModal />
    </div>
  );
}
