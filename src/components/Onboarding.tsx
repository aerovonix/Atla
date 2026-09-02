import { useEffect, useMemo, useState } from "react";
import { useStore } from "../state/store";
import { AtlaMark } from "./AtlaMark";
import { CheckIcon, ChevronDownIcon } from "./icons";
import { PROVIDER_LABELS, type ProviderKind, type ThemeSetting } from "../../shared/types";
import { COPY, PROVIDER_GUIDES, guideFor, providerReady } from "../../shared/onboarding";
import type { PermissionStatus } from "../../shared/types";

/**
 * First run.
 *
 * Every step is skippable and nothing here is a decision the user can't take
 * back in Settings — which is said out loud, because the fastest way to make
 * someone abandon a setup flow is to imply they're committing to something.
 */

function Choice({
  selected,
  onClick,
  title,
  subtitle
}: {
  selected: boolean;
  onClick: () => void;
  title: string;
  subtitle: string;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full text-left px-3.5 py-3 rounded-xl border transition-colors flex items-start gap-3"
      style={{
        borderColor: selected ? "var(--accent-border)" : "var(--border)",
        background: selected ? "var(--accent-soft)" : "transparent"
      }}
    >
      <span
        className="w-4 h-4 rounded-full border shrink-0 mt-0.5 flex items-center justify-center"
        style={{
          borderColor: selected ? "var(--accent)" : "var(--border)",
          background: selected ? "var(--accent)" : "transparent",
          color: "var(--accent-fg)"
        }}
      >
        {selected && <CheckIcon width={10} height={10} />}
      </span>
      <span className="min-w-0">
        <span className="block text-[14px] font-medium">{title}</span>
        <span className="block text-[12px] text-secondary mt-0.5">{subtitle}</span>
      </span>
    </button>
  );
}

/**
 * macOS gates three things Atla uses, and all three fail in ways that don't
 * name themselves — a blocked LAN request reads as a routing error, a blocked
 * screenshot as a broken tool, blocked input as nothing happening at all.
 * Better to surface them once, here, than to let each one be discovered as a
 * separate mystery later.
 */
function MacPermissions({ status, onRecheck }: { status: PermissionStatus; onRecheck: () => void }) {
  const rows: { key: string; label: string; why: string; granted: boolean | null }[] = [
    {
      key: "localnetwork",
      label: "Local Network",
      why: "Reaching a model on your own network, like Ollama. Atla asks for this the first time it tries.",
      // macOS exposes no way to read this one, so it isn't claimed either way.
      granted: null
    },
    {
      key: "screen",
      label: "Screen Recording",
      why: "Taking screenshots, so the model can see what's on screen.",
      granted: status.screen
    },
    {
      key: "accessibility",
      label: "Accessibility",
      why: "Clicking and typing in other apps.",
      granted: status.accessibility
    }
  ];

  return (
    <div className="space-y-3">
      {rows.map((r) => (
        <div key={r.key} className="rounded-xl border border-border p-3.5 flex items-start gap-3">
          <span
            className="w-2 h-2 rounded-full shrink-0 mt-2"
            style={{
              background:
                r.granted === true ? "var(--diff-add)" : r.granted === false ? "var(--accent)" : "var(--muted)"
            }}
          />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium">
              {r.label}
              {r.granted === true && <span className="text-secondary font-normal"> · granted</span>}
              {r.granted === false && <span className="text-secondary font-normal"> · not yet</span>}
              {r.granted === null && <span className="text-secondary font-normal"> · asked when needed</span>}
            </div>
            <p className="text-[12px] text-secondary mt-1 leading-relaxed">{r.why}</p>
          </div>
          {r.granted !== true && (
            <button
              onClick={() => void window.atla?.permissions?.open(r.key)}
              className="shrink-0 text-[12px] px-2.5 py-1 rounded-full border border-border text-secondary hover:bg-hover transition-colors"
            >
              Open
            </button>
          )}
        </div>
      ))}
      <div className="flex items-center gap-3">
        <button
          onClick={onRecheck}
          className="text-[12px] px-3 py-1.5 rounded-full border border-border text-secondary hover:bg-hover transition-colors"
        >
          Check again
        </button>
        <p className="text-[11px] text-secondary flex-1">
          Granting Screen Recording or Accessibility needs Atla restarted before it takes effect.
        </p>
      </div>
    </div>
  );
}

export function Onboarding({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const providers = useStore((s) => s.providers);
  const addProvider = useStore((s) => s.addProvider);
  const updateProvider = useStore((s) => s.updateProvider);
  const removeProvider = useStore((s) => s.removeProvider);
  const fetchModels = useStore((s) => s.fetchModelsForProvider);

  const [kind, setKind] = useState<ProviderKind | null>(null);
  const [providerId, setProviderId] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [name, setName] = useState(settings.profileName === "You" ? "" : settings.profileName);
  const [checking, setChecking] = useState(false);
  const [perms, setPerms] = useState<PermissionStatus | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);

  const readPerms = () => void window.atla?.permissions?.status().then(setPerms);
  useEffect(() => readPerms(), []);
  // Only macOS gates anything, so the step simply doesn't exist elsewhere.
  const needsPerms = perms?.platform === "darwin";

  // Built as a list rather than fixed indices: a conditional step would
  // otherwise shift every number after it and silently mis-route the buttons.
  const steps: ("welcome" | "provider" | "permissions" | "preferences")[] = [
    "welcome",
    "provider",
    ...(needsPerms ? (["permissions"] as const) : []),
    "preferences"
  ];
  const current = steps[Math.min(step, steps.length - 1)];

  const guide = kind ? guideFor(kind) : undefined;
  const ready = kind ? providerReady(kind, apiKey, baseUrl) : false;

  // A provider row is created as soon as a kind is picked, so the existing
  // settings code owns the record and this flow only fills it in.
  useEffect(() => {
    if (!kind) return;
    if (providerId) {
      updateProvider(providerId, { kind });
      return;
    }
    const id = addProvider(kind);
    setProviderId(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  const models = useMemo(() => providers.find((p) => p.id === providerId)?.models ?? [], [providers, providerId]);

  const connect = async () => {
    if (!providerId || !kind) return;
    setChecking(true);
    setCheckError(null);
    updateProvider(providerId, {
      apiKey: apiKey.trim() || undefined,
      baseUrl: baseUrl.trim() || undefined
    });
    try {
      await fetchModels(providerId);
      // Fetching the model list is the honest test: a key that can't list
      // models can't chat either, and it fails here instead of on first send.
      const after = useStore.getState().providers.find((p) => p.id === providerId);
      if (!after?.models?.length) {
        setCheckError("Connected, but no models came back. Check the key or endpoint.");
      } else {
        setStep((v) => v + 1);
      }
    } catch (err) {
      setCheckError(err instanceof Error ? err.message : "Couldn't reach that provider.");
    } finally {
      setChecking(false);
    }
  };

  const finish = () => {
    updateSettings({
      profileName: name.trim() || "You",
      onboarded: true
    });
    onDone();
  };

  const skip = () => {
    // A half-filled provider row would show up in Settings looking broken.
    if (providerId && !ready) removeProvider(providerId);
    updateSettings({ onboarded: true });
    onDone();
  };

  return (
    <div className="h-screen w-screen flex items-center justify-center bg-bg text-text p-6 overflow-y-auto">
      <div className="w-full max-w-[560px]">
        <div className="flex flex-col items-center text-center">
          <AtlaMark size={72} className="mb-6" />
          <h1 className="text-[32px] leading-[1.15] font-bold tracking-tight">
            {current === "welcome"
              ? COPY.welcome.title
              : current === "provider"
                ? COPY.provider.title
                : current === "permissions"
                  ? "A few macOS permissions"
                  : COPY.preferences.title}
          </h1>
          <p className="mt-3 text-[14px] text-secondary max-w-[440px]">
            {current === "welcome"
              ? COPY.welcome.body
              : current === "provider"
                ? COPY.provider.body
                : current === "permissions"
                  ? "macOS asks before an app can see your screen, control other apps, or reach your local network. You can grant these now or later — Atla will say which one is missing if it needs it."
                  : COPY.preferences.body}
          </p>
        </div>

        <div className="mt-8 space-y-2.5">
          {current === "provider" && !kind && (
            <>
              {PROVIDER_GUIDES.map((g) => (
                <Choice
                  key={g.kind}
                  selected={false}
                  onClick={() => setKind(g.kind)}
                  title={PROVIDER_LABELS[g.kind]}
                  subtitle={g.blurb}
                />
              ))}
            </>
          )}

          {current === "provider" && kind && (
            <div className="space-y-3">
              <button
                onClick={() => {
                  setKind(null);
                  setCheckError(null);
                }}
                className="text-[12px] text-secondary hover:text-text transition-colors inline-flex items-center gap-1"
              >
                <ChevronDownIcon open={false} width={11} height={11} />
                Pick a different provider
              </button>
              <div className="rounded-xl border border-border p-4 space-y-3">
                <div className="text-[14px] font-medium">{PROVIDER_LABELS[kind]}</div>
                {!guide?.local && kind !== "openai-compatible" && (
                  <label className="block">
                    <span className="block text-[12px] text-secondary mb-1.5">API key</span>
                    <input
                      type="password"
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      placeholder={guide?.keyHint ?? "Your key"}
                      autoFocus
                      className="w-full px-3 py-2 rounded-xl border border-border bg-input text-sm outline-none"
                    />
                    {guide?.keyUrl && (
                      <span className="block text-[11px] text-secondary mt-1.5">
                        Get one at {guide.keyUrl} — it's stored on this machine only.
                      </span>
                    )}
                  </label>
                )}
                {(guide?.local || kind === "openai-compatible") && (
                  <label className="block">
                    <span className="block text-[12px] text-secondary mb-1.5">
                      {guide?.local ? "Server address" : "Endpoint URL"}
                    </span>
                    <input
                      value={baseUrl}
                      onChange={(e) => setBaseUrl(e.target.value)}
                      placeholder={guide?.local ? "http://localhost:11434" : "https://your-endpoint/v1"}
                      autoFocus
                      className="w-full px-3 py-2 rounded-xl border border-border bg-input text-sm outline-none"
                    />
                    <span className="block text-[11px] text-secondary mt-1.5">{guide?.keyHint}</span>
                  </label>
                )}
                {kind === "openai-compatible" && (
                  <label className="block">
                    <span className="block text-[12px] text-secondary mb-1.5">API key (if it needs one)</span>
                    <input
                      type="password"
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      className="w-full px-3 py-2 rounded-xl border border-border bg-input text-sm outline-none"
                    />
                  </label>
                )}
                {checkError && (
                  <div className="text-[12px] rounded-lg px-3 py-2" style={{ background: "rgba(239,68,68,0.1)", color: "#ef4444" }}>
                    {checkError}
                  </div>
                )}
                {models.length > 0 && (
                  <div className="text-[12px] text-secondary">
                    Found {models.length} model{models.length === 1 ? "" : "s"}.
                  </div>
                )}
              </div>
            </div>
          )}

          {current === "permissions" && perms && <MacPermissions status={perms} onRecheck={readPerms} />}

          {current === "preferences" && (
            <div className="space-y-4">
              <label className="block">
                <span className="block text-[12px] text-secondary mb-1.5">What should it call you?</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Optional"
                  autoFocus
                  className="w-full px-3 py-2 rounded-xl border border-border bg-input text-sm outline-none"
                />
              </label>
              <div>
                <span className="block text-[12px] text-secondary mb-1.5">Theme</span>
                <div className="grid grid-cols-3 gap-2">
                  {(["light", "dark", "midnight"] as ThemeSetting[]).map((t) => (
                    <button
                      key={t}
                      onClick={() => updateSettings({ theme: t })}
                      className="px-3 py-2 rounded-xl border text-[13px] capitalize transition-colors"
                      style={{
                        borderColor: settings.theme === t ? "var(--accent-border)" : "var(--border)",
                        background: settings.theme === t ? "var(--accent-soft)" : "transparent"
                      }}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>
              <div className="rounded-xl border border-border p-3.5">
                <div className="text-[13px] font-medium">Tools are on by default</div>
                <p className="text-[12px] text-secondary mt-1 leading-relaxed">
                  Atla can search the web, drive a browser, run shell commands, and edit files — but only when the
                  model decides a message needs it. Commands and file changes ask you first, showing exactly what
                  they'd do. You can turn any of it off in Settings.
                </p>
              </div>
            </div>
          )}
        </div>

        <div className="mt-8 flex items-center gap-3">
          <button onClick={skip} className="text-[12px] text-secondary hover:text-text transition-colors">
            {current === "preferences" ? "Skip" : "Skip setup"}
          </button>
          <div className="flex-1" />
          {step > 0 && current !== "welcome" && (
            <button
              onClick={() => setStep((v) => v - 1)}
              className="bevel bevel-sm px-4 py-2 rounded-full text-sm font-medium"
            >
              Back
            </button>
          )}
          {current === "welcome" && (
            <button onClick={() => setStep(1)} className="bevel bevel-on px-5 py-2 rounded-full text-sm font-medium">
              Get started
            </button>
          )}
          {current === "provider" && (
            <button
              onClick={() => void connect()}
              disabled={!ready || checking}
              className="bevel bevel-on px-5 py-2 rounded-full text-sm font-medium disabled:opacity-50"
            >
              {checking ? "Connecting…" : "Connect"}
            </button>
          )}
          {current === "permissions" && (
            <button
              onClick={() => setStep((v) => v + 1)}
              className="bevel bevel-on px-5 py-2 rounded-full text-sm font-medium"
            >
              Continue
            </button>
          )}
          {current === "preferences" && (
            <button onClick={finish} className="bevel bevel-on px-5 py-2 rounded-full text-sm font-medium">
              Done
            </button>
          )}
        </div>

        <div className="mt-6 flex items-center justify-center gap-1.5">
          {steps.map((_, i) => (
            <span
              key={i}
              className="h-1 rounded-full transition-all"
              style={{
                width: i === step ? 18 : 6,
                background: i === step ? "var(--accent)" : "var(--border)"
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
