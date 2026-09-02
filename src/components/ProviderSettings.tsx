import { useState } from "react";
import { useStore } from "../state/store";
import { PROVIDER_LABELS } from "../../shared/types";
import type { ProviderConfig, ProviderKind } from "../../shared/types";
import { CheckIcon, KeyIcon, PlusIcon, TrashIcon } from "./icons";

const KINDS: ProviderKind[] = ["anthropic", "openai", "google", "openrouter", "ollama", "openai-compatible"];

const NEEDS_KEY: Record<ProviderKind, boolean> = {
  anthropic: true,
  openai: true,
  google: true,
  openrouter: true,
  ollama: false,
  "openai-compatible": false
};

const NEEDS_BASE_URL: Record<ProviderKind, boolean> = {
  anthropic: false,
  openai: false,
  google: false,
  openrouter: false,
  ollama: true,
  "openai-compatible": true
};

function canDetect(p: ProviderConfig): boolean {
  if (NEEDS_KEY[p.kind] && !p.apiKey?.trim()) return false;
  if (NEEDS_BASE_URL[p.kind] && !p.baseUrl?.trim()) return false;
  return true;
}

function Spinner() {
  return <div className="w-3.5 h-3.5 border-2 rounded-full animate-spin border-border" style={{ borderTopColor: "var(--text)" }} />;
}

function ModelsSection({ p }: { p: ProviderConfig }) {
  const updateProvider = useStore((s) => s.updateProvider);
  const fetchModelsForProvider = useStore((s) => s.fetchModelsForProvider);
  const status = useStore((s) => s.modelFetchStatus[p.id]);
  const [modelDraft, setModelDraft] = useState("");

  const detectable = canDetect(p);

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="text-xs text-secondary">Models</label>
        <button
          onClick={() => void fetchModelsForProvider(p.id)}
          disabled={!detectable || status?.loading}
          className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border border-border text-secondary hover:text-text disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {status?.loading ? <Spinner /> : null}
          {status?.loading ? "Detecting…" : p.models.length > 0 ? "Refresh from API" : "Auto-detect models"}
        </button>
      </div>

      {!detectable && (
        <div className="text-[11px] text-secondary mb-2">
          {NEEDS_KEY[p.kind] ? "Add an API key" : "Set a base URL"} to auto-detect available models.
        </div>
      )}
      {status?.error && <div className="text-[11px] text-red-500 mb-2">Couldn't fetch models: {status.error}</div>}
      {status && !status.loading && !status.error && status.fetchedAt && (
        <div className="text-[11px] text-secondary mb-2">
          {p.models.length} model{p.models.length === 1 ? "" : "s"} detected · {new Date(status.fetchedAt).toLocaleTimeString()}
        </div>
      )}

      {p.models.length === 0 && !status?.loading && (
        <div className="text-xs text-secondary mb-2">No models yet — detect from the API or add one manually below.</div>
      )}

      <div className="flex flex-wrap gap-1.5 mb-2">
        {p.models.map((m) => (
          <span
            key={m}
            onClick={() => updateProvider(p.id, { defaultModel: m })}
            className="group inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full border cursor-pointer"
            style={{
              borderColor: p.defaultModel === m ? "var(--text)" : "var(--border)",
              backgroundColor: p.defaultModel === m ? "var(--text)" : "var(--bg)",
              color: p.defaultModel === m ? "var(--bg)" : "var(--text)"
            }}
          >
            {p.defaultModel === m && <CheckIcon width={10} height={10} />}
            {m}
            <button
              onClick={(e) => {
                e.stopPropagation();
                const models = p.models.filter((x) => x !== m);
                updateProvider(p.id, {
                  models,
                  defaultModel: p.defaultModel === m ? models[0] : p.defaultModel
                });
              }}
              className="opacity-60 hover:opacity-100"
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <input
        value={modelDraft}
        onChange={(e) => setModelDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            const v = modelDraft.trim();
            if (v && !p.models.includes(v)) {
              updateProvider(p.id, { models: [...p.models, v], defaultModel: p.defaultModel || v });
            }
            setModelDraft("");
          }
        }}
        placeholder="Or add a model id manually and press Enter"
        className="w-full px-3 py-1.5 rounded-lg border border-border bg-bg outline-none text-xs font-mono"
      />
      <div className="text-[11px] text-secondary mt-1">Click a chip to set it as this provider's default model.</div>
    </div>
  );
}

export function ProviderSettings() {
  const providers = useStore((s) => s.providers);
  const addProvider = useStore((s) => s.addProvider);
  const updateProvider = useStore((s) => s.updateProvider);
  const removeProvider = useStore((s) => s.removeProvider);
  const fetchModelsForProvider = useStore((s) => s.fetchModelsForProvider);

  const [addOpen, setAddOpen] = useState(false);

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <label className="text-sm font-medium">Providers &amp; models</label>
        <div className="relative">
          <button
            onClick={() => setAddOpen((o) => !o)}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full font-medium bg-text text-bg"
          >
            <PlusIcon width={12} height={12} /> Add provider
          </button>
          {addOpen && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setAddOpen(false)} />
              <div className="absolute right-0 top-9 w-56 rounded-xl border border-border bg-bg shadow-2xl z-40 py-1">
                {KINDS.map((k) => (
                  <button
                    key={k}
                    onClick={() => {
                      addProvider(k);
                      setAddOpen(false);
                    }}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-hover"
                  >
                    {PROVIDER_LABELS[k]}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
      <p className="text-xs text-secondary mb-3">
        Keys are encrypted on disk with your OS keychain and only ever leave the app to reach the provider you configured. Models are pulled
        live from each provider's API — nothing is hardcoded, so the list is only as current as your account's access.
      </p>

      {providers.length === 0 && (
        <div className="rounded-xl border border-dashed border-border p-4 text-sm text-secondary text-center">
          No providers yet. Add Claude, OpenAI, Gemini, OpenRouter, Ollama, or any OpenAI-compatible endpoint to start chatting.
        </div>
      )}

      <div className="space-y-3">
        {providers.map((p) => (
          <div key={p.id} className="rounded-2xl border border-border bg-input p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 min-w-0">
                <span className="w-7 h-7 rounded-lg flex items-center justify-center bg-bg border border-border text-secondary shrink-0">
                  <KeyIcon width={13} height={13} />
                </span>
                <input
                  value={p.label}
                  onChange={(e) => updateProvider(p.id, { label: e.target.value })}
                  placeholder={PROVIDER_LABELS[p.kind]}
                  className="text-sm font-semibold bg-transparent outline-none min-w-0 flex-1"
                />
              </div>
              <button onClick={() => removeProvider(p.id)} className="w-7 h-7 rounded-full flex items-center justify-center text-secondary hover:text-red-500">
                <TrashIcon width={14} height={14} />
              </button>
            </div>
            <div className="text-[11px] uppercase tracking-wide text-secondary">{PROVIDER_LABELS[p.kind]}</div>

            {NEEDS_KEY[p.kind] && (
              <div>
                <label className="text-xs text-secondary block mb-1">API key</label>
                <input
                  type="password"
                  value={p.apiKey ?? ""}
                  onChange={(e) => updateProvider(p.id, { apiKey: e.target.value })}
                  onBlur={() => {
                    if (p.apiKey?.trim() && p.models.length === 0) void fetchModelsForProvider(p.id);
                  }}
                  placeholder="sk-…"
                  className="w-full px-3 py-2 rounded-lg border border-border bg-bg outline-none text-sm font-mono"
                />
              </div>
            )}

            {NEEDS_BASE_URL[p.kind] && (
              <div>
                <label className="text-xs text-secondary block mb-1">
                  {p.kind === "ollama" ? "Ollama server URL" : "Base URL"}
                </label>
                <input
                  value={p.baseUrl ?? ""}
                  onChange={(e) => updateProvider(p.id, { baseUrl: e.target.value })}
                  onBlur={() => {
                    if (p.baseUrl?.trim() && p.models.length === 0) void fetchModelsForProvider(p.id);
                  }}
                  placeholder={p.kind === "ollama" ? "http://localhost:11434" : "https://your-endpoint/v1"}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-bg outline-none text-sm font-mono"
                />
              </div>
            )}

            {!NEEDS_BASE_URL[p.kind] && (
              <details className="text-xs">
                <summary className="cursor-pointer text-secondary select-none">Advanced: override base URL</summary>
                <input
                  value={p.baseUrl ?? ""}
                  onChange={(e) => updateProvider(p.id, { baseUrl: e.target.value || undefined })}
                  placeholder="Leave blank for the default endpoint"
                  className="w-full mt-2 px-3 py-2 rounded-lg border border-border bg-bg outline-none text-sm font-mono"
                />
              </details>
            )}

            <ModelsSection p={p} />
          </div>
        ))}
      </div>
    </div>
  );
}
