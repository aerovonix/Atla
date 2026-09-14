import { useEffect, useState } from "react";
import { reasoningOptions, type ReasoningEffort } from "../../shared/reasoning";
import { useStore } from "../state/store";
import { useLocalModels } from "../state/localModelStore";
import { BrainIcon, CheckIcon } from "./icons";

/** The short form on the button face. "Off" is spelled out; the rest are initials. */
const SHORT: Record<ReasoningEffort, string> = {
  off: "Off",
  low: "Low",
  medium: "Med",
  high: "High"
};

/**
 * How hard the model should think, for models that can.
 *
 * Hidden entirely when the current model doesn't reason — an effort control on
 * a model that ignores it is worse than no control, because it implies the
 * setting did something. On Ollama the verdict comes from the server's own
 * capability list rather than the model name, since a local model can be
 * called anything and guessing wrong there fails the request outright.
 */
export function ReasoningControl({ conversationId }: { conversationId: string }) {
  const providers = useStore((s) => s.providers);
  const conv = useStore((s) => s.conversations.find((c) => c.id === conversationId));
  const fallback = useStore((s) => s.settings.reasoningEffort);
  const setReasoningEffort = useStore((s) => s.setReasoningEffort);
  const [open, setOpen] = useState(false);

  const provider = providers.find((p) => p.id === conv?.providerId) ?? providers[0];
  const model = conv?.model || provider?.defaultModel || provider?.models[0] || "";

  const ensureCapabilities = useLocalModels((s) => s.ensureCapabilities);
  const caps = useLocalModels((s) => (provider ? s.capabilities[`${provider.id} :: ${model}`] : undefined));

  // Only Ollama has a capability endpoint; asking anyone else is a wasted
  // round trip that always answers null.
  useEffect(() => {
    if (provider?.kind === "ollama" && model) ensureCapabilities(provider, model);
  }, [provider, model, ensureCapabilities]);

  const options = provider ? reasoningOptions(provider.kind, model, caps) : null;
  if (!options) return null;

  const current = conv?.reasoningEffort ?? fallback;
  const active = options.find((o) => o.value === current) ?? options[0];

  return (
    <div className="relative shrink-0">
      <button
        onClick={() => setOpen((o) => !o)}
        className={`bevel bevel-sm h-9 px-2.5 rounded-full flex items-center gap-1.5 ${
          open || current !== "off" ? "bevel-on" : ""
        }`}
        title={`Reasoning effort: ${active.label}`}
      >
        <BrainIcon width={16} height={16} />
        <span className="text-[11px] font-medium leading-none">{SHORT[active.value]}</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 bottom-12 w-[248px] rounded-xl border border-border bg-bg shadow-2xl z-40 py-1.5">
            <div className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-secondary">
              Reasoning effort
            </div>
            <div className="px-3 pb-1.5 text-[11px] text-secondary leading-snug">
              How long {model || "this model"} thinks before it starts answering.
            </div>
            {options.map((opt) => (
              <button
                key={opt.value}
                onClick={() => {
                  setReasoningEffort(conversationId, opt.value);
                  setOpen(false);
                }}
                className="w-full flex items-start gap-2.5 px-3 py-2 rounded-lg text-left hover:bg-hover"
              >
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-medium leading-tight">{opt.label}</span>
                  <span className="block text-[11px] text-secondary leading-snug mt-0.5">{opt.hint}</span>
                </span>
                {opt.value === current && (
                  <CheckIcon width={14} height={14} className="mt-1 shrink-0" style={{ color: "var(--accent)" }} />
                )}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
