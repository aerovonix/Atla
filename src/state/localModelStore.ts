import { create } from "zustand";
import type { LocalModel, ProviderConfig } from "../../shared/types";

/**
 * What is installed on a local runtime, and what is warm right now.
 *
 * Kept out of the main store on purpose: none of this is persisted, none of it
 * survives a restart meaningfully, and it changes on a timer while the model
 * picker is open. Mixing it into the store that owns conversations would mean
 * every poll re-rendering the transcript.
 */

/** Providers and models are both free-form strings, so the pair needs a separator. */
function key(providerId: string, model: string): string {
  return `${providerId} :: ${model}`;
}

interface LocalModelStore {
  /** Installed models per provider id. Absent until first fetched. */
  models: Record<string, LocalModel[]>;
  /** Last error per provider id — usually "the runtime isn't running". */
  errors: Record<string, string | null>;
  /** Provider ids with a list request in flight. */
  refreshing: Record<string, boolean>;
  /** Models being loaded or unloaded right now, by provider-and-model. */
  busy: Record<string, "load" | "unload">;
  /**
   * Ollama's own capability list per model, cached.
   *
   * `null` is a real answer meaning "the server didn't say", which is
   * different from the key being absent ("not asked yet"). Only the second
   * one is worth another round trip.
   */
  capabilities: Record<string, string[] | null>;

  refresh: (cfg: ProviderConfig) => Promise<void>;
  load: (cfg: ProviderConfig, model: string, keepAliveMinutes: number) => Promise<void>;
  unload: (cfg: ProviderConfig, model: string) => Promise<void>;
  cancel: (providerId: string, model: string) => void;
  /** Fetch capabilities once per model; a no-op after the first answer. */
  ensureCapabilities: (cfg: ProviderConfig, model: string) => void;
  /** What the runtime said, or undefined if it has never been asked. */
  capabilitiesFor: (providerId: string, model: string) => string[] | null | undefined;
}

export const useLocalModels = create<LocalModelStore>((set, get) => ({
  models: {},
  errors: {},
  refreshing: {},
  busy: {},
  capabilities: {},

  refresh: async (cfg) => {
    if (get().refreshing[cfg.id]) return;
    set((s) => ({ refreshing: { ...s.refreshing, [cfg.id]: true } }));
    try {
      const res = await window.atla.models.list(cfg);
      if (res.ok) {
        // The listing already carries each model's capabilities on any recent
        // runtime, so one call answers for every model at once. Caching them
        // here means the composer rarely needs the per-model round trip.
        const learned: Record<string, string[]> = {};
        for (const m of res.models) {
          if (m.capabilities) learned[key(cfg.id, m.name)] = m.capabilities;
        }
        set((s) => ({
          models: { ...s.models, [cfg.id]: res.models },
          errors: { ...s.errors, [cfg.id]: null },
          capabilities: { ...s.capabilities, ...learned }
        }));
      } else {
        set((s) => ({ errors: { ...s.errors, [cfg.id]: res.error } }));
      }
    } catch (err) {
      set((s) => ({ errors: { ...s.errors, [cfg.id]: String(err) } }));
    } finally {
      set((s) => ({ refreshing: { ...s.refreshing, [cfg.id]: false } }));
    }
  },

  load: async (cfg, model, keepAliveMinutes) => {
    const k = key(cfg.id, model);
    if (get().busy[k]) return;
    set((s) => ({ busy: { ...s.busy, [k]: "load" } }));
    try {
      const res = await window.atla.models.load(cfg, model, keepAliveMinutes);
      if (!res.ok && res.error !== "Cancelled.") {
        set((s) => ({ errors: { ...s.errors, [cfg.id]: res.error ?? "Load failed." } }));
      }
    } finally {
      set((s) => {
        const { [k]: _drop, ...rest } = s.busy;
        return { busy: rest };
      });
      // The row has to re-read residency either way: a cancelled load may
      // still have completed server-side, and a failed one may not have.
      await get().refresh(cfg);
    }
  },

  unload: async (cfg, model) => {
    const k = key(cfg.id, model);
    if (get().busy[k]) return;
    set((s) => ({ busy: { ...s.busy, [k]: "unload" } }));
    try {
      const res = await window.atla.models.unload(cfg, model);
      if (!res.ok) set((s) => ({ errors: { ...s.errors, [cfg.id]: res.error ?? "Unload failed." } }));
    } finally {
      set((s) => {
        const { [k]: _drop, ...rest } = s.busy;
        return { busy: rest };
      });
      await get().refresh(cfg);
    }
  },

  cancel: (providerId, model) => {
    void window.atla.models.cancelLoad(providerId, model);
  },

  ensureCapabilities: (cfg, model) => {
    const k = key(cfg.id, model);
    if (get().capabilities[k]) return;

    // Claim the key before awaiting, so a component that renders twice in a
    // frame doesn't fire two identical requests. Until a real answer lands
    // this reads as null, which callers treat as "no better information than
    // the name" — the same as an older runtime that never answers.
    const claimed = k in get().capabilities;
    if (!claimed) set((s) => ({ capabilities: { ...s.capabilities, [k]: null } }));

    void (async () => {
      // One listing answers for every model, so prefer it over a per-model
      // call. It also populates every other model the composer might ask
      // about next.
      if (!get().models[cfg.id]) await get().refresh(cfg);
      if (get().capabilities[k]) return;

      // An older runtime doesn't put capabilities in the listing. /api/show
      // is the same answer at one round trip per model, so it stays as the
      // fallback rather than the first choice.
      try {
        const caps = await window.atla.models.capabilities(cfg, model);
        if (caps) set((s) => ({ capabilities: { ...s.capabilities, [k]: caps } }));
      } catch {
        // No answer leaves the null in place, and the name heuristic stands.
      }
    })();
  },

  capabilitiesFor: (providerId, model) => get().capabilities[key(providerId, model)]
}));

export { key as localModelKey };
