/**
 * Reasoning effort, across six providers that each spell it differently.
 *
 * Every current reasoning model exposes the same underlying dial — how long to
 * think before answering — but nobody agrees on the parameter. Anthropic wants
 * a token budget, OpenAI wants a word, Google wants a budget on 2.5 and a word
 * on 3, Ollama wants a boolean (except where it wants a word). This module is
 * the single place that knows which, so the adapters stay readable and the UI
 * can ask one question: how hard should this model think?
 *
 * The other job here is knowing when *not* to ask. Sending `think: true` to an
 * Ollama model that can't think is a hard error, not a no-op, so a wrong guess
 * breaks the turn. `reasoningOptions` returns null for a model that can't, and
 * the composer hides the control rather than offering a setting that fails.
 *
 * Name matching alone is not good enough for that, which is why the Ollama
 * path prefers the server's own capability list: a live runtime here reports
 * `granite3.2:8b` as completion-only while its name matches every reasoning
 * heuristic going, and a locally-named merge reports thinking while matching
 * none of them.
 */

import type { ProviderKind } from "./types.js";

export type ReasoningEffort = "off" | "low" | "medium" | "high";

export interface EffortOption {
  value: ReasoningEffort;
  label: string;
  /** Shown under the label. Says what actually happens, not what it's called. */
  hint: string;
}

const OFF: EffortOption = { value: "off", label: "Off", hint: "Answer straight away" };
const LOW: EffortOption = { value: "low", label: "Low", hint: "A brief pass before answering" };
const MEDIUM: EffortOption = { value: "medium", label: "Medium", hint: "Balanced — the usual choice" };
const HIGH: EffortOption = { value: "high", label: "High", hint: "Think hard; slower and pricier" };

/**
 * Model families that reason.
 *
 * Deliberately matched on family rather than exact id: providers ship dated
 * snapshots (`claude-sonnet-4-5-20250929`) and OpenRouter prefixes an author
 * (`anthropic/claude-sonnet-4.5`), so pinning exact ids would go stale within
 * a release. A missed match costs a hidden button; a false match on Ollama
 * costs a failed turn, which is why that one prefers the live capability list.
 */
const FAMILIES: RegExp[] = [
  /(^|\/)o[1-9](-|$)/, // OpenAI o1, o3, o4-mini
  /gpt-5/,
  /claude-3[-.]7/,
  /claude-(?:opus|sonnet|haiku|fable)-(?:[4-9]|\d{2})/,
  /gemini-(?:2[-.]5|[3-9])/,
  /deepseek-(?:r1|reasoner|v3[-.][1-9])/,
  /qwq/,
  /qwen-?3/,
  /gpt-oss/,
  /magistral/,
  /grok-(?:3-mini|[4-9])/,
  /(?:^|[^a-z])(?:glm-4[-.][5-9]|minimax-m\d|kimi-k\d)/,
  /phi-?4-reasoning/,
  /exaone-deep/,
  /smallthinker/,
  // Not granite3.2, which looks like a reasoner and isn't: its local build
  // reports capabilities ["completion", "tools"] and rejects `think`. Verified
  // against a live Ollama rather than assumed from the release notes.
  /:thinking$/,
  /-thinking(?:-|$)/
];

function looksLikeReasoner(model: string): boolean {
  const id = (model ?? "").toLowerCase();
  return FAMILIES.some((re) => re.test(id));
}

/** Gemini 2.5 Pro thinks on every request; the budget can be raised, not removed. */
function googleCanDisable(model: string): boolean {
  return !/gemini-2[-.]5-pro/i.test(model ?? "");
}

/**
 * What to offer for this model, or null if it can't reason.
 *
 * `capabilities` is Ollama's own answer from /api/show. When present it is
 * believed over the name heuristic in both directions — a local fine-tune can
 * be called anything, and the server is the only thing that actually knows.
 */
export function reasoningOptions(
  kind: ProviderKind,
  model: string,
  capabilities?: readonly string[] | null
): EffortOption[] | null {
  const id = (model ?? "").toLowerCase();
  if (!id) return null;

  if (kind === "ollama" && capabilities) {
    if (!capabilities.includes("thinking")) return null;
    // gpt-oss is the one local family that takes a level rather than a switch.
    return /gpt-oss/.test(id) ? [OFF, LOW, MEDIUM, HIGH] : [OFF, HIGH];
  }

  if (!looksLikeReasoner(id)) return null;

  switch (kind) {
    case "anthropic":
      return [OFF, LOW, MEDIUM, HIGH];
    case "openai":
      // o-series always reasons; the floor is "as little as it can manage".
      // gpt-5 has a real minimal setting, so "Off" is honest there and the
      // hint says what "Off" means on the others.
      return /gpt-5/.test(id)
        ? [{ ...OFF, hint: "Minimal reasoning" }, LOW, MEDIUM, HIGH]
        : [{ ...OFF, label: "Lowest", hint: "This model always reasons" }, LOW, MEDIUM, HIGH];
    case "google":
      return googleCanDisable(id)
        ? [OFF, LOW, MEDIUM, HIGH]
        : [{ ...OFF, label: "Lowest", hint: "2.5 Pro always thinks" }, LOW, MEDIUM, HIGH];
    case "ollama":
      return /gpt-oss/.test(id) ? [OFF, LOW, MEDIUM, HIGH] : [OFF, HIGH];
    case "openrouter":
    case "openai-compatible":
      return [OFF, LOW, MEDIUM, HIGH];
    default:
      return null;
  }
}

const EFFORT_RANK: Readonly<Record<ReasoningEffort, number>> = { off: 0, low: 1, medium: 2, high: 3 };

/**
 * The offered option closest to what was asked for.
 *
 * Not every model offers all four. A local model whose thinking is a plain
 * on/off switch offers only [Off, High], and the stored preference is whatever
 * the user last picked globally — "Medium", say, which is on that list nowhere.
 *
 * Without this the control renders the first option as a fallback and reads
 * "Off" while the adapter, which collapses medium to "on" anyway, sends
 * thinking enabled. A switch that says off while the thing is on is worse than
 * no switch: it is a lie about what the next message will do. Snapping to the
 * nearest rank makes the label and the wire agree, and ties go upward, since
 * a model asked to think a medium amount should think rather than not.
 */
export function nearestEffort(options: readonly EffortOption[], effort: ReasoningEffort): ReasoningEffort {
  if (options.length === 0) return "off";
  if (options.some((o) => o.value === effort)) return effort;
  const want = EFFORT_RANK[effort] ?? 0;
  let best = options[0];
  for (const option of options) {
    const gap = Math.abs(EFFORT_RANK[option.value] - want);
    const bestGap = Math.abs(EFFORT_RANK[best.value] - want);
    if (gap < bestGap || (gap === bestGap && EFFORT_RANK[option.value] > EFFORT_RANK[best.value])) {
      best = option;
    }
  }
  return best.value;
}

/** Anthropic and Google want a number of tokens rather than a word. */
const BUDGET: Record<Exclude<ReasoningEffort, "off">, number> = {
  low: 2048,
  medium: 8192,
  high: 24576
};

/**
 * Anthropic's budget, plus the max_tokens that budget needs.
 *
 * The API requires max_tokens to exceed budget_tokens, and the budget floor is
 * 1024. Clamping the budget down to fit a small max_tokens would quietly turn
 * "High" into "barely" — so the ceiling moves instead, leaving room for both
 * the thinking and an answer after it.
 */
export function anthropicThinking(
  effort: ReasoningEffort,
  maxTokens: number
): { budget: number; maxTokens: number } | null {
  if (effort === "off") return null;
  const budget = BUDGET[effort];
  return { budget, maxTokens: Math.max(maxTokens, budget + 4096) };
}

/** Gemini 2.5 takes a budget; 0 disables it where the model allows that. */
export function googleThinkingBudget(effort: ReasoningEffort, model: string): number {
  if (effort === "off") return googleCanDisable(model) ? 0 : 128;
  // Flash tops out below the shared high-water mark, and an over-budget
  // request is rejected outright rather than clamped server-side.
  const ceiling = /gemini-2[-.]5-pro/i.test(model) ? 32768 : 24576;
  return Math.min(BUDGET[effort], ceiling);
}

/** Gemini 3 swapped the budget for two named levels. */
export function isGemini3(model: string): boolean {
  return /gemini-[3-9]/i.test(model ?? "");
}

export function geminiThinkingLevel(effort: ReasoningEffort): "low" | "high" {
  return effort === "off" || effort === "low" ? "low" : "high";
}

/** OpenAI's word. gpt-5 accepts "minimal"; the o-series floor is "low". */
export function openAIEffort(effort: ReasoningEffort, model: string): string | null {
  if (effort === "off") return /gpt-5/i.test(model ?? "") ? "minimal" : "low";
  return effort;
}

/**
 * Ollama's `think`. Boolean for most, a level for gpt-oss.
 *
 * Returns undefined rather than false when the user hasn't asked for anything,
 * so a model that can't think never sees the field at all.
 */
export function ollamaThink(effort: ReasoningEffort, model: string): boolean | string | undefined {
  if (/gpt-oss/i.test(model ?? "")) return effort === "off" ? "low" : effort;
  return effort === "off" ? false : true;
}
