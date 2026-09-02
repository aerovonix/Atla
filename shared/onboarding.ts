/**
 * First-run copy and provider guidance.
 *
 * Kept as data next to the greeting quips because it's the same voice: warm,
 * short, never breathless. The onboarding is the first thing anyone reads, so
 * it sets the register for everything after it.
 */

import type { ProviderKind } from "./types.js";

export const ONBOARDING_STEPS = ["welcome", "provider", "preferences", "done"] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export const COPY = {
  welcome: {
    title: "Hello, welcome to Atla",
    body: "Atla is a chat client that runs on your own model keys. Nothing is sent anywhere but the provider you choose. Let's get you set up — it takes about a minute."
  },
  provider: {
    title: "Bring a model",
    body: "Pick where your model comes from. You can add more later, and switch per chat."
  },
  preferences: {
    title: "A couple of preferences",
    body: "All of these are changeable later in Settings. Nothing here is permanent."
  },
  done: {
    title: "You're set",
    body: "That's everything. Ask it something."
  }
} as const;

export interface ProviderGuide {
  kind: ProviderKind;
  /** One line on who this is for. */
  blurb: string;
  /** Where to get a key, shown as plain text — the app never opens it for you. */
  keyUrl?: string;
  keyHint?: string;
  /** No key needed; it's a local server. */
  local?: boolean;
}

export const PROVIDER_GUIDES: ProviderGuide[] = [
  {
    kind: "anthropic",
    blurb: "Claude. Strong at long documents, code, and careful reasoning.",
    keyUrl: "console.anthropic.com/settings/keys",
    keyHint: "Starts with sk-ant-"
  },
  {
    kind: "openai",
    blurb: "GPT models, plus the widest ecosystem support.",
    keyUrl: "platform.openai.com/api-keys",
    keyHint: "Starts with sk-"
  },
  {
    kind: "google",
    blurb: "Gemini. Generous free tier and a very large context window.",
    keyUrl: "aistudio.google.com/apikey",
    keyHint: "From Google AI Studio"
  },
  {
    kind: "openrouter",
    blurb: "One key, most models. Good if you want to try several.",
    keyUrl: "openrouter.ai/keys",
    keyHint: "Starts with sk-or-"
  },
  {
    kind: "ollama",
    blurb: "Models running on this machine. Private, free, no key.",
    local: true,
    keyHint: "Needs Ollama running at localhost:11434"
  },
  {
    kind: "openai-compatible",
    blurb: "LM Studio, vLLM, Groq, Together — anything speaking the OpenAI API.",
    keyHint: "You'll need the endpoint URL"
  }
];

export function guideFor(kind: ProviderKind): ProviderGuide | undefined {
  return PROVIDER_GUIDES.find((g) => g.kind === kind);
}

/**
 * Whether a provider is ready to talk to. Ollama and compatible endpoints need
 * a URL rather than a key, which is why this isn't just "is there a key".
 */
export function providerReady(kind: ProviderKind, apiKey: string, baseUrl: string): boolean {
  const guide = guideFor(kind);
  if (guide?.local) return true;
  if (kind === "openai-compatible") return baseUrl.trim().length > 0;
  return apiKey.trim().length > 0;
}
