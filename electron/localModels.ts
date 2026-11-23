/**
 * Starting and stopping models on a local runtime.
 *
 * A large model on Ollama takes anywhere from seconds to several minutes to
 * come off disk, and nothing about a chat request says that is what is
 * happening — the request simply sits there, indistinguishable from a model
 * that has wedged. The cure is not a faster load, it is a visible one: let the
 * load be started deliberately, with a spinner attached to it, before a
 * message depends on it.
 *
 * Unloading matters for the same reason in reverse. A resident 70B model holds
 * its weights whether or not anybody is talking to it, and on one GPU that is
 * the difference between the next model loading and the next model swapping.
 *
 * Scoped to Ollama, which is the only runtime here with a documented API for
 * residency. LM Studio has one too but has changed it across versions, and
 * guessing wrong would mean an "Unload" button that silently does nothing.
 */

import type { LocalModel, ProviderConfig } from "../shared/types.js";

/** Runtimes with a residency API. Everything else reports nothing to manage. */
export function supportsModelManagement(cfg: ProviderConfig): boolean {
  return cfg.kind === "ollama";
}

function base(cfg: ProviderConfig): string {
  return (cfg.baseUrl?.trim() || "http://localhost:11434").replace(/\/+$/, "");
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 300);
    } catch {
      // The body is a nicety; the status is the finding.
    }
    throw new Error(`HTTP ${res.status} ${res.statusText}${detail ? `: ${detail}` : ""}`);
  }
  return (await res.json()) as T;
}

interface TagEntry {
  name?: string;
  model?: string;
  size?: number;
  /**
   * Present since Ollama 0.6 and authoritative — it is the server's own
   * answer, not a guess from the name. Worth reading here rather than per
   * model through /api/show, which is the same answer at one round trip each.
   */
  capabilities?: string[];
  details?: { parameter_size?: string; quantization_level?: string };
}

interface PsEntry {
  name?: string;
  model?: string;
  size?: number;
  size_vram?: number;
  expires_at?: string;
}

/**
 * Everything installed, annotated with what is resident.
 *
 * /api/tags and /api/ps are separate calls and neither is a superset: tags
 * knows what exists, ps knows what is warm. They're fetched together so the
 * two halves of a row can't disagree by a refresh interval.
 */
export async function listModels(cfg: ProviderConfig, signal?: AbortSignal): Promise<LocalModel[]> {
  const url = base(cfg);
  const [tags, ps] = await Promise.all([
    fetch(`${url}/api/tags`, { signal }).then((r) => json<{ models?: TagEntry[] }>(r)),
    // A runtime too old for /api/ps still lists its models; it just can't say
    // which are warm. Losing the dot is better than losing the list.
    fetch(`${url}/api/ps`, { signal })
      .then((r) => json<{ models?: PsEntry[] }>(r))
      .catch(() => ({ models: [] as PsEntry[] }))
  ]);

  const running = new Map<string, PsEntry>();
  for (const r of ps.models ?? []) {
    const key = r.name ?? r.model;
    if (key) running.set(key, r);
  }

  return (tags.models ?? [])
    .map((m) => {
      const name = m.name ?? m.model ?? "";
      const live = running.get(name);
      return {
        name,
        size: m.size ?? 0,
        parameterSize: m.details?.parameter_size,
        quantization: m.details?.quantization_level,
        loaded: Boolean(live),
        vram: live?.size_vram,
        expiresAt: live?.expires_at,
        capabilities: Array.isArray(m.capabilities) ? m.capabilities : undefined,
        // A model served from Ollama's cloud has no weights on this machine,
        // so it reports zero bytes and there is nothing here to start or stop.
        remote: (m.size ?? 0) === 0 || /[:-]cloud$/.test(name)
      } satisfies LocalModel;
    })
    .filter((m) => m.name)
    .sort((a, b) => (a.loaded === b.loaded ? a.name.localeCompare(b.name) : a.loaded ? -1 : 1));
}

/**
 * What the runtime says this model can do.
 *
 * Worth a round trip because the alternative is guessing from the name, and
 * the cost of guessing "thinking" wrong is a rejected request rather than a
 * missing feature. Ollama added `capabilities` to /api/show in 0.6; an older
 * server returns the field absent, which reads here as "don't know" and leaves
 * the caller on its name heuristic.
 */
export async function modelCapabilities(
  cfg: ProviderConfig,
  model: string,
  signal?: AbortSignal
): Promise<string[] | null> {
  const res = await fetch(`${base(cfg)}/api/show`, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model })
  });
  const body = await json<{ capabilities?: string[] }>(res);
  return Array.isArray(body.capabilities) ? body.capabilities : null;
}

/**
 * Bring a model into memory and leave it there.
 *
 * An empty prompt is Ollama's documented way to load without generating, and
 * the response only arrives once the weights are in — which is the whole
 * point. This can take minutes on a large model, so it has no timeout of its
 * own; cancelling is the caller's to offer, via the signal.
 */
export async function loadModel(
  cfg: ProviderConfig,
  model: string,
  keepAliveMinutes: number,
  signal?: AbortSignal
): Promise<void> {
  const res = await fetch(`${base(cfg)}/api/generate`, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, prompt: "", stream: false, keep_alive: `${keepAliveMinutes}m` })
  });
  await json<unknown>(res);
}

/** Evict a model now. `keep_alive: 0` is the documented way to say so. */
export async function unloadModel(cfg: ProviderConfig, model: string, signal?: AbortSignal): Promise<void> {
  const res = await fetch(`${base(cfg)}/api/generate`, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, prompt: "", stream: false, keep_alive: 0 })
  });
  await json<unknown>(res);
}
