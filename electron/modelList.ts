import type { ProviderConfig } from "../shared/types.js";

async function assertOk(res: Response) {
  if (!res.ok) {
    let detail = "";
    try {
      detail = await res.text();
    } catch {
      // ignore
    }
    throw new Error(`HTTP ${res.status} ${res.statusText}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
  }
}

// Non-chat model families that clutter the OpenAI-style /models listing.
const OPENAI_EXCLUDE = /embedding|whisper|tts|dall-e|moderation|davinci|babbage|^ada|^curie|image|audio|realtime|transcribe/i;

async function listOpenAIStyle(baseUrl: string, apiKey?: string, extraHeaders?: Record<string, string>): Promise<string[]> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
    headers: {
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      ...extraHeaders
    }
  });
  await assertOk(res);
  const json = (await res.json()) as { data?: { id?: string; name?: string }[]; models?: { id?: string; name?: string }[] };
  const list = json.data ?? json.models ?? [];
  return list.map((m) => m.id ?? m.name).filter((x): x is string => Boolean(x));
}

async function listAnthropic(cfg: ProviderConfig): Promise<string[]> {
  const baseUrl = cfg.baseUrl?.trim() || "https://api.anthropic.com";
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/v1/models?limit=1000`, {
    headers: {
      "x-api-key": cfg.apiKey ?? "",
      "anthropic-version": "2023-06-01"
    }
  });
  await assertOk(res);
  const json = (await res.json()) as { data?: { id?: string }[] };
  const list = json.data ?? [];
  return list.map((m) => m.id).filter((x): x is string => Boolean(x));
}

async function listGoogle(cfg: ProviderConfig): Promise<string[]> {
  const baseUrl = cfg.baseUrl?.trim() || "https://generativelanguage.googleapis.com";
  const res = await fetch(
    `${baseUrl.replace(/\/+$/, "")}/v1beta/models?pageSize=200&key=${encodeURIComponent(cfg.apiKey ?? "")}`
  );
  await assertOk(res);
  const json = (await res.json()) as { models?: { name?: string; supportedGenerationMethods?: string[] }[] };
  const list = json.models ?? [];
  return list
    .filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.some((x) => x.includes("generateContent")))
    .map((m) => m.name?.replace(/^models\//, ""))
    .filter((x): x is string => Boolean(x));
}

async function listOllama(cfg: ProviderConfig): Promise<string[]> {
  const baseUrl = cfg.baseUrl?.trim() || "http://localhost:11434";
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/tags`);
  await assertOk(res);
  const json = (await res.json()) as { models?: { name?: string }[] };
  const list = json.models ?? [];
  return list.map((m) => m.name).filter((x): x is string => Boolean(x));
}

export async function fetchModels(cfg: ProviderConfig): Promise<string[]> {
  switch (cfg.kind) {
    case "anthropic":
      return (await listAnthropic(cfg)).sort();
    case "google":
      return (await listGoogle(cfg)).sort();
    case "ollama":
      return (await listOllama(cfg)).sort();
    case "openai":
      return (await listOpenAIStyle(cfg.baseUrl?.trim() || "https://api.openai.com/v1", cfg.apiKey))
        .filter((id) => !OPENAI_EXCLUDE.test(id))
        .sort();
    case "openrouter":
      return (await listOpenAIStyle(cfg.baseUrl?.trim() || "https://openrouter.ai/api/v1", cfg.apiKey)).sort();
    case "openai-compatible":
      if (!cfg.baseUrl?.trim()) throw new Error("Set a base URL first.");
      return (await listOpenAIStyle(cfg.baseUrl, cfg.apiKey)).sort();
    default:
      throw new Error(`Unknown provider kind: ${cfg.kind}`);
  }
}
