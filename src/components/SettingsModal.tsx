import { useEffect, useState } from "react";
import { useStore } from "../state/store";
import { CloseIcon } from "./icons";
import { ProviderSettings } from "./ProviderSettings";
import { PROVIDER_LABELS } from "../../shared/types";
import type { AppSettings, DashStatus } from "../../shared/types";
import { formatCode } from "../../shared/dashProtocol";

type Tab = "providers" | "general" | "generation" | "browser" | "data";

const TABS: { id: Tab; label: string }[] = [
  { id: "providers", label: "Providers" },
  { id: "general", label: "General" },
  { id: "generation", label: "Model" },
  { id: "browser", label: "Browser" },
  { id: "data", label: "Data" }
];

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-sm font-medium mb-1 block">{label}</label>
      {hint && <p className="text-xs text-secondary mb-2">{hint}</p>}
      {children}
    </div>
  );
}

function Slider({
  value,
  min,
  max,
  step,
  onChange,
  format
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
}) {
  return (
    <div className="flex items-center gap-3">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="flex-1 accent-current"
      />
      <span className="text-xs font-mono w-16 text-right text-secondary">{format ? format(value) : value}</span>
    </div>
  );
}

function SegmentedControl<T extends string>({
  options,
  value,
  onChange
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className="px-3 py-2.5 rounded-xl border text-sm font-medium transition-colors"
          style={{
            backgroundColor: value === o.value ? "var(--text)" : "var(--input)",
            color: value === o.value ? "var(--bg)" : "var(--text)",
            borderColor: value === o.value ? "var(--text)" : "var(--border)"
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Switch({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <button onClick={() => onChange(!checked)} className="w-full flex items-center gap-3 text-left py-2">
      <span
        className="w-9 h-5 rounded-full shrink-0 relative transition-colors"
        style={{ backgroundColor: checked ? "var(--text)" : "var(--border)" }}
      >
        <span
          className="absolute top-0.5 w-4 h-4 rounded-full transition-all"
          style={{ backgroundColor: "var(--bg)", left: checked ? 18 : 2 }}
        />
      </span>
      <span className="flex-1 min-w-0">
        <span className="text-sm font-medium block">{label}</span>
        {hint && <span className="text-xs text-secondary block">{hint}</span>}
      </span>
    </button>
  );
}

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const settings = useStore((s) => s.settings);
  const providers = useStore((s) => s.providers);
  const conversations = useStore((s) => s.conversations);
  const projects = useStore((s) => s.projects);
  const updateSettings = useStore((s) => s.updateSettings);
  const clearAllData = useStore((s) => s.clearAllData);
  const [tab, setTab] = useState<Tab>("providers");
  const [confirmClear, setConfirmClear] = useState(false);

  const set = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => updateSettings({ [key]: value } as Partial<AppSettings>);

  const defaultProvider = providers.find((p) => p.id === settings.defaultProviderId);

  const exportData = async () => {
    const payload = JSON.stringify({ conversations, projects, settings }, null, 2);
    try {
      await navigator.clipboard.writeText(payload);
    } catch {
      /* ignore */
    }
    const blob = new Blob([payload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `atla-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative w-full max-w-[680px] max-h-[85vh] rounded-[24px] flex flex-col overflow-hidden border border-border bg-bg shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <h2 className="font-semibold text-[18px]">Settings</h2>
          <button onClick={onClose} className="w-8 h-8 rounded-full flex items-center justify-center bg-input">
            <CloseIcon width={16} height={16} />
          </button>
        </div>

        <div className="px-5 pt-3 shrink-0">
          <div className="flex p-1 rounded-full border border-border bg-input">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className="flex-1 py-2 rounded-full text-sm font-semibold transition-colors"
                style={{
                  backgroundColor: tab === t.id ? "var(--text)" : "transparent",
                  color: tab === t.id ? "var(--bg)" : "var(--secondary)"
                }}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-6">
          {tab === "providers" && <ProviderSettings />}

          {tab === "general" && (
            <>
              <Field label="Your name">
                <input
                  value={settings.profileName}
                  onChange={(e) => set("profileName", e.target.value.slice(0, 24))}
                  placeholder="Your name"
                  className="w-full px-3 py-2.5 rounded-xl border border-border outline-none text-sm bg-input"
                />
              </Field>

              <Field label="Custom instructions" hint="Appended to Atla's system prompt for every conversation.">
                <textarea
                  value={settings.customInstructions}
                  onChange={(e) => set("customInstructions", e.target.value)}
                  rows={4}
                  placeholder="e.g. Be concise. I'm a backend engineer, skip basic explanations…"
                  className="w-full px-3 py-3 rounded-xl border border-border outline-none text-sm resize-none bg-input"
                />
              </Field>

              <Field label="Theme">
                <SegmentedControl
                  value={settings.theme}
                  onChange={(v) => set("theme", v)}
                  options={[
                    { value: "light", label: "Light" },
                    { value: "dark", label: "Dark" },
                    { value: "midnight", label: "Midnight" },
                    { value: "system", label: "System" }
                  ]}
                />
              </Field>

              <Field label="Message density">
                <SegmentedControl
                  value={settings.density}
                  onChange={(v) => set("density", v)}
                  options={[
                    { value: "comfortable", label: "Comfortable" },
                    { value: "compact", label: "Compact" }
                  ]}
                />
              </Field>

              <Field label="Font size">
                <Slider
                  value={settings.fontSize}
                  min={12}
                  max={20}
                  step={1}
                  onChange={(v) => set("fontSize", v)}
                  format={(v) => `${v}px`}
                />
              </Field>

              <Field label="Send message with">
                <SegmentedControl
                  value={settings.sendKey}
                  onChange={(v) => set("sendKey", v)}
                  options={[
                    { value: "enter", label: "Enter" },
                    { value: "mod-enter", label: "Ctrl/⌘ + Enter" }
                  ]}
                />
              </Field>

              <div className="border-t border-border pt-2">
                <Switch
                  checked={settings.autoTitle}
                  onChange={(v) => set("autoTitle", v)}
                  label="Auto-name new chats"
                  hint="Use the first message as the conversation title."
                />
                <Switch
                  checked={settings.showModelInMessages}
                  onChange={(v) => set("showModelInMessages", v)}
                  label="Show model name on replies"
                />
              </div>
            </>
          )}

          {tab === "generation" && (
            <>
              <Field label="Default model" hint="Used for every new conversation. You can still switch per chat.">
                {providers.length === 0 ? (
                  <div className="text-sm text-secondary rounded-xl border border-dashed border-border p-3 text-center">
                    Add a provider first.
                  </div>
                ) : (
                  <div className="space-y-2">
                    <select
                      value={settings.defaultProviderId ?? ""}
                      onChange={(e) => {
                        const id = e.target.value || undefined;
                        const p = providers.find((x) => x.id === id);
                        updateSettings({ defaultProviderId: id, defaultModel: p?.defaultModel || p?.models[0] });
                      }}
                      className="w-full px-3 py-2.5 rounded-xl border border-border outline-none text-sm bg-input"
                    >
                      <option value="">First available provider</option>
                      {providers.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label || PROVIDER_LABELS[p.kind]}
                        </option>
                      ))}
                    </select>
                    {defaultProvider && (
                      <select
                        value={settings.defaultModel ?? ""}
                        onChange={(e) => set("defaultModel", e.target.value)}
                        className="w-full px-3 py-2.5 rounded-xl border border-border outline-none text-sm bg-input font-mono"
                      >
                        {defaultProvider.models.length === 0 && <option value="">No models detected</option>}
                        {defaultProvider.models.map((m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                )}
              </Field>

              <Field label="Temperature" hint="Lower is more focused and repeatable; higher is more varied.">
                <Slider
                  value={settings.temperature}
                  min={0}
                  max={2}
                  step={0.1}
                  onChange={(v) => set("temperature", v)}
                  format={(v) => v.toFixed(1)}
                />
              </Field>

              <Field label="Max response tokens" hint="Upper bound on reply length. Very high values cost more.">
                <Slider
                  value={settings.maxTokens}
                  min={256}
                  max={32768}
                  step={256}
                  onChange={(v) => set("maxTokens", v)}
                />
              </Field>

              <Field
                label="System prompt override"
                hint="Leave blank to keep Atla's built-in persona. Filling this in replaces it entirely."
              >
                <textarea
                  value={settings.systemPromptOverride}
                  onChange={(e) => set("systemPromptOverride", e.target.value)}
                  rows={4}
                  placeholder="You are a…"
                  className="w-full px-3 py-3 rounded-xl border border-border outline-none text-sm resize-none bg-input font-mono"
                />
              </Field>

              <div className="border-t border-border pt-3">
                <div className="text-[11px] text-secondary leading-snug mb-2">
                  These make a tool <em>available</em>; the model decides when it's worth using. Per-chat overrides
                  live in the composer's + menu, and typing <span className="font-mono text-text">@</span> in a
                  message forces a specific tool for that turn.
                </div>
                <Switch
                  checked={settings.webSearchEnabled}
                  onChange={(v) => set("webSearchEnabled", v)}
                  label="Offer web search"
                  hint="Native search on Claude / Gemini / OpenRouter; via the built-in browser elsewhere."
                />
                <Switch
                  checked={settings.browserToolsEnabled}
                  onChange={(v) => set("browserToolsEnabled", v)}
                  label="Offer browser control"
                  hint="Let the model open, read, and click pages in the built-in browser."
                />
                <Switch
                  checked={settings.terminalToolEnabled}
                  onChange={(v) => set("terminalToolEnabled", v)}
                  label="Offer the terminal"
                  hint="Let the model run shell commands on this machine, in the terminal pane."
                />
                <Switch
                  checked={settings.commandApproval}
                  onChange={(v) => set("commandApproval", v)}
                  label="Approve every command"
                  hint="Ask before each command runs. Turning this off lets the model run commands on your machine without asking — running a command is the one thing here that can't be undone."
                />
                <Switch
                  checked={settings.fileToolsEnabled}
                  onChange={(v) => set("fileToolsEnabled", v)}
                  label="Offer file access"
                  hint="Let the model read, create, and edit files anywhere on this machine."
                />
                <Switch
                  checked={settings.fileWriteApproval}
                  onChange={(v) => set("fileWriteApproval", v)}
                  label="Approve every file change"
                  hint="Show the diff and ask before each write. Turning this off lets the model overwrite files without asking. Reading is never gated either way."
                />
              </div>

              <div className="h-px my-4 bg-border" />

              <WebDashPanel />

              <div className="h-px my-4 bg-border" />

              <div className="space-y-3">
                <Switch
                  checked={settings.notifyOnFinish}
                  onChange={(v) => set("notifyOnFinish", v)}
                  label="Notify when a reply finishes"
                  hint="A desktop notification when Atla finishes, but only while its window is in the background — you won't get one for a reply you're watching arrive."
                />
                <Switch
                  checked={settings.desktopEnabled}
                  onChange={(v) => set("desktopEnabled", v)}
                  label="Let Atla use the desktop"
                  hint="The model can see the screen and click and type in other apps. This reaches outside Atla entirely — it stays off until you turn it on, and grants nothing until you name an app below."
                />
                {settings.desktopEnabled && (
                  <>
                    <Field
                      label="Where it may act"
                      hint="Allowed apps is the safe default. Anywhere lets it act in any window, including your bank, your password manager, and anything else you have open."
                    >
                      <SegmentedControl
                        value={settings.desktopScope}
                        onChange={(v) => set("desktopScope", v)}
                        options={[
                          { value: "allowlist", label: "Allowed apps" },
                          { value: "unrestricted", label: "Anywhere" }
                        ]}
                      />
                    </Field>
                    {settings.desktopScope === "allowlist" && (
                      <Field
                        label="Allowed apps"
                        hint="One per line. Matched against the window title, so a fragment is enough — 'Figma', 'Visual Studio Code'. Empty means nothing is allowed."
                      >
                        <textarea
                          rows={4}
                          value={settings.desktopAllowlist.join("\n")}
                          onChange={(e) =>
                            set(
                              "desktopAllowlist",
                              e.target.value.split("\n").map((l) => l.trim()).filter(Boolean)
                            )
                          }
                          placeholder={"Figma\nVisual Studio Code"}
                          className="w-full px-3 py-2.5 rounded-xl border border-border outline-none text-sm resize-none bg-input font-mono"
                        />
                      </Field>
                    )}
                    <Switch
                      checked={settings.desktopConfirmEvery}
                      onChange={(v) => set("desktopConfirmEvery", v)}
                      label="Confirm every desktop action"
                      hint="Off, only clicks that look irreversible are confirmed — delete, send, buy, and so on. On, you approve every single click and keystroke."
                    />
                    <button
                      onClick={() => {
                        set("desktopEnabled", false);
                        void window.atla?.desktop?.kill();
                      }}
                      className="w-full px-3 py-2.5 rounded-xl border text-sm font-medium transition-colors"
                      style={{ borderColor: "rgba(239,68,68,0.4)", color: "#ef4444", background: "rgba(239,68,68,0.06)" }}
                    >
                      Stop desktop control now
                    </button>
                  </>
                )}
              </div>

              <div className="h-px my-4 bg-border" />

              <div className="space-y-3">
                <Switch
                  checked={settings.criticEnabled}
                  onChange={(v) => set("criticEnabled", v)}
                  label="Review answers before showing them"
                  hint="A second model reads each reply and, if something is actually wrong, the first model revises it. This costs at least one extra model call per message."
                />
                {settings.criticEnabled && (
                  <>
                    <Field
                      label="Reviewer"
                      hint="Leave on the answering model to have it check its own work — still useful, and free of a second API key."
                    >
                      <select
                        value={settings.criticProviderId ? `${settings.criticProviderId}::${settings.criticModel}` : ""}
                        onChange={(e) => {
                          const [providerId, model] = e.target.value.split("::");
                          set("criticProviderId", providerId ?? "");
                          set("criticModel", model ?? "");
                        }}
                        className="w-full px-3 py-2 rounded-xl border border-border bg-input text-sm outline-none"
                      >
                        <option value="">Same model that answered</option>
                        {providers.flatMap((p) =>
                          (p.models ?? []).map((m) => (
                            <option key={`${p.id}::${m}`} value={`${p.id}::${m}`}>
                              {p.label} · {m}
                            </option>
                          ))
                        )}
                      </select>
                    </Field>
                    <Field
                      label="Review rounds"
                      hint="How many times at most it may review and revise. One catches real errors; more mostly adds cost."
                    >
                      <Slider
                        value={settings.criticRounds}
                        min={1}
                        max={3}
                        step={1}
                        onChange={(v) => set("criticRounds", v)}
                      />
                    </Field>
                    <Field
                      label="Skip answers shorter than"
                      hint="Short replies are usually direct ones. Reviewing them spends a call to be told they're fine."
                    >
                      <Slider
                        value={settings.criticMinChars}
                        min={0}
                        max={1000}
                        step={20}
                        onChange={(v) => set("criticMinChars", v)}
                      />
                    </Field>
                  </>
                )}
              </div>

              <Field
                label="Max tool steps per reply"
                hint="How many times the model may call a tool before it must answer. Deep research and desktop work need room; this is a ceiling, not a target."
              >
                <Slider value={settings.maxToolIterations} min={1} max={200} step={1} onChange={(v) => set("maxToolIterations", v)} />
              </Field>
            </>
          )}

          {tab === "browser" && (
            <>
              <Switch
                checked={settings.adblockEnabled}
                onChange={(v) => set("adblockEnabled", v)}
                label="Block ads and trackers"
                hint="Filters ad, analytics, and tracker requests in the built-in browser."
              />

              <Field label="Homepage">
                <input
                  value={settings.browserHomepage}
                  onChange={(e) => set("browserHomepage", e.target.value)}
                  placeholder="https://duckduckgo.com"
                  className="w-full px-3 py-2.5 rounded-xl border border-border outline-none text-sm bg-input font-mono"
                />
              </Field>

              <Field label="Search engine" hint="Use %s where the query goes.">
                <input
                  value={settings.searchEngineUrl}
                  onChange={(e) => set("searchEngineUrl", e.target.value)}
                  placeholder="https://duckduckgo.com/?q=%s"
                  className="w-full px-3 py-2.5 rounded-xl border border-border outline-none text-sm bg-input font-mono"
                />
              </Field>

              <Field
                label="Extra blocking rules"
                hint="One per line. Plain domains (ads.example.com), Adblock syntax (||tracker.net^), or URL fragments (/adserver/)."
              >
                <textarea
                  value={settings.customBlocklist}
                  onChange={(e) => set("customBlocklist", e.target.value)}
                  rows={5}
                  placeholder={"||ads.example.com^\ntracker.example.net\n/sponsored/"}
                  className="w-full px-3 py-3 rounded-xl border border-border outline-none text-xs resize-none bg-input font-mono"
                />
              </Field>
            </>
          )}

          {tab === "data" && (
            <>
              <div className="rounded-xl border border-border bg-input p-4 text-sm space-y-1">
                <div className="flex justify-between">
                  <span className="text-secondary">Conversations</span>
                  <span className="font-mono">{conversations.length}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-secondary">Projects</span>
                  <span className="font-mono">{projects.length}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-secondary">Providers</span>
                  <span className="font-mono">{providers.length}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-secondary">Messages</span>
                  <span className="font-mono">{conversations.reduce((n, c) => n + c.messages.length, 0)}</span>
                </div>
              </div>

              <button
                onClick={exportData}
                className="w-full px-4 py-3 rounded-xl border border-border bg-input text-sm font-medium hover:bg-hover transition-colors"
              >
                Export conversations (.json)
              </button>

              <div className="border-t border-border pt-4">
                <p className="text-xs text-secondary mb-2">
                  Clearing wipes conversations, projects, and settings from this machine. API keys stay until you remove
                  each provider.
                </p>
                <button
                  onClick={() => {
                    if (confirmClear) {
                      clearAllData();
                      setConfirmClear(false);
                    } else {
                      setConfirmClear(true);
                      setTimeout(() => setConfirmClear(false), 4000);
                    }
                  }}
                  className="w-full px-4 py-3 rounded-xl text-sm font-medium text-white"
                  style={{ backgroundColor: "#ef4444" }}
                >
                  {confirmClear ? "Click again to confirm — this can't be undone" : "Clear all data"}
                </button>
              </div>

              <div className="text-xs text-center text-secondary pt-2 border-t border-border">
                Atla · by Aerovonix · bring your own model
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The web dash controls.
 *
 * Status is read from main rather than mirrored in settings, because the
 * server either is or isn't listening and a stored flag can disagree with
 * reality after a crash or a port conflict.
 */
function WebDashPanel() {
  const [status, setStatus] = useState<DashStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [port, setPort] = useState(7717);

  useEffect(() => {
    void window.atla?.dash?.status().then(setStatus);
  }, []);

  const start = async () => {
    setBusy(true);
    setError(null);
    const r = await window.atla?.dash?.start(port);
    if (r && !r.ok) setError(r.error ?? "Couldn't start.");
    if (r) setStatus(r);
    setBusy(false);
  };

  const stop = async () => {
    setBusy(true);
    setStatus((await window.atla?.dash?.stop()) ?? null);
    setBusy(false);
  };

  const running = status?.running ?? false;

  return (
    <div className="space-y-3">
      <div>
        <div className="text-sm font-medium">Web dash</div>
        <p className="text-[12px] text-secondary mt-1 leading-relaxed">
          Opens a small web page on your local network so a phone or another computer can read your chats and send
          messages. It needs a pairing code, which changes every time you start it.
        </p>
      </div>

      <div
        className="rounded-xl border p-3 text-[12px] leading-relaxed"
        style={{ borderColor: "rgba(242,114,41,0.35)", background: "var(--accent-soft)" }}
      >
        This is unencrypted HTTP on your local network — anything else on that network can see the traffic. Use it on
        a network you trust, and stop it when you're done.
      </div>

      {!running && (
        <Field label="Port" hint="Change this only if something else is already using it.">
          <input
            type="number"
            value={port}
            onChange={(e) => setPort(Number(e.target.value) || 7717)}
            className="w-full px-3 py-2 rounded-xl border border-border bg-input text-sm outline-none"
          />
        </Field>
      )}

      {running && status && (
        <div className="rounded-xl border border-border p-3.5 space-y-2.5">
          <div>
            <div className="text-[11px] text-secondary">Pairing code</div>
            <div className="text-[26px] font-mono tracking-[0.15em] mt-0.5">{formatCode(status.code)}</div>
          </div>
          <div>
            <div className="text-[11px] text-secondary">Open on the other device</div>
            {status.addresses.length === 0 ? (
              <div className="text-[13px] text-secondary mt-0.5">No network address found.</div>
            ) : (
              status.addresses.map((a: string) => (
                <div key={a} className="text-[13px] font-mono mt-0.5">
                  http://{a}:{status.port}
                </div>
              ))
            )}
          </div>
          <div className="text-[11px] text-secondary">
            {status.sessions === 0
              ? "No devices paired yet."
              : `${status.sessions} device${status.sessions === 1 ? "" : "s"} paired.`}
          </div>
        </div>
      )}

      {error && (
        <div className="text-[12px] rounded-lg px-3 py-2" style={{ background: "rgba(239,68,68,0.1)", color: "#ef4444" }}>
          {error}
        </div>
      )}

      <button
        onClick={() => void (running ? stop() : start())}
        disabled={busy}
        className={`bevel ${running ? "" : "bevel-on"} px-4 py-2 rounded-full text-sm font-medium disabled:opacity-50`}
      >
        {busy ? "…" : running ? "Stop the dash" : "Start the dash"}
      </button>
    </div>
  );
}
