import { streamChat } from "./providers.js";
import { CRITIC_SYSTEM, critiqueRequest, parseVerdict, revisionRequest, worthReviewing } from "../shared/critic.js";
import type { ChatStreamRequest, CriticRequest, ProviderConfig } from "../shared/types.js";

/**
 * Lifts the environment block off the answering model's system prompt so the
 * reviewer shares its notion of "now". Everything up to the first blank line
 * after the date is that block; if the shape ever changes this yields nothing
 * rather than smuggling the whole persona across.
 */
function environmentPreamble(system: string): string {
  const start = system.indexOf("Current date and time:");
  if (start === -1) return "";
  const end = system.indexOf("\n\n", start);
  const block = end === -1 ? system.slice(start) : system.slice(start, end);
  return `${block}\n\nYou are reviewing an answer produced in that environment. The assistant could search the web, read files, and run commands; you cannot. Do not treat a fact you can't verify as wrong, and never correct a date or a "latest version" from memory — the environment above is authoritative.\n\n`;
}

/**
 * Review-and-revise, run after the answer has finished streaming.
 *
 * The original answer is already on screen by the time this starts, which is
 * the point: if the review fails, times out, or the user cancels, they keep a
 * complete answer rather than losing the turn. Every failure path here returns
 * the text unchanged.
 */

/** A review shouldn't cost more wall-clock than the answer it's checking. */
const REVIEW_TIMEOUT_MS = 45_000;

export interface CriticHandlers {
  onReviewing: (round: number) => void;
  onRevising: (critique: string, round: number) => void;
  onChunk: (delta: string) => void;
}

/** Strips the tools off a request: neither reviewing nor revising should act. */
function quietRequest(base: ChatStreamRequest, over: Partial<ChatStreamRequest>): ChatStreamRequest {
  return {
    ...base,
    ...over,
    webSearch: false,
    browserTools: false,
    terminalTool: false,
    fileTools: false,
    forcedTools: [],
    maxToolIterations: 0,
    critic: undefined
  };
}

async function askOnce(
  cfg: ProviderConfig,
  req: ChatStreamRequest,
  signal: AbortSignal
): Promise<string> {
  // The reviewer's own output is never streamed to the transcript; the user
  // sees it as a finished note, not as a second answer being typed at them.
  let out = "";
  await streamChat(cfg, req, { onChunk: (d) => (out += d), onToolEvent: () => {} }, signal);
  return out;
}

export async function reviewAndRevise(
  answerCfg: ProviderConfig,
  reviewerCfg: ProviderConfig,
  base: ChatStreamRequest,
  critic: CriticRequest,
  handlers: CriticHandlers,
  signal: AbortSignal,
  firstAnswer: string
): Promise<{ text: string; critique?: string }> {
  let answer = firstAnswer;
  let lastCritique: string | undefined;

  for (let round = 1; round <= Math.max(1, critic.rounds); round++) {
    if (signal.aborted) break;
    // A short answer is almost always a direct one; reviewing "yes, that's
    // right" spends a call to be told it's fine.
    if (!worthReviewing(answer, critic.minChars)) break;

    handlers.onReviewing(round);

    // Its own timeout, and its own controller, so a hung reviewer can't strand
    // an answer the user already has.
    const roundController = new AbortController();
    const timer = setTimeout(() => roundController.abort(), REVIEW_TIMEOUT_MS);
    const onOuterAbort = () => roundController.abort();
    signal.addEventListener("abort", onOuterAbort);

    let verdictText: string;
    try {
      verdictText = await askOnce(
        reviewerCfg,
        quietRequest(base, {
          providerId: reviewerCfg.id,
          model: critic.model,
          // The reviewer was flying blind: no tools and no clock, so it
          // "corrected" a correct date back to its own training cutoff. It
          // still gets no tools — a reviewer that browses is a second agent —
          // but it must know what day it is and what the answer could see.
          system: `${environmentPreamble(base.system)}${CRITIC_SYSTEM}`,
          messages: [{ role: "user", content: critiqueRequest(critic.prompt, answer) }],
          // Low temperature: a reviewer that is being creative is inventing
          // problems, which is the failure mode this whole design guards.
          temperature: 0,
          maxTokens: 700
        }),
        roundController.signal
      );
    } catch {
      // A failed review is not a failed answer. Keep what we have.
      break;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onOuterAbort);
    }

    if (signal.aborted) break;
    const verdict = parseVerdict(verdictText);
    if (verdict.approved) break;

    handlers.onRevising(verdict.notes, round);
    lastCritique = verdict.notes;

    let revised = "";
    try {
      const revisionReq = quietRequest(base, {
        messages: [
          ...base.messages,
          { role: "assistant", content: answer },
          { role: "user", content: revisionRequest(verdict.notes) }
        ]
      });
      await streamChat(
        answerCfg,
        revisionReq,
        {
          onChunk: (d) => {
            revised += d;
            handlers.onChunk(d);
          },
          onToolEvent: () => {}
        },
        signal
      );
    } catch {
      // Half a revision is worse than none, and the renderer has already
      // cleared the body for it — hand back what streamed if there is any,
      // otherwise the original.
      return { text: revised.trim() ? revised : answer, critique: lastCritique };
    }

    if (!revised.trim()) return { text: answer, critique: lastCritique };
    answer = revised;
  }

  return { text: answer, critique: lastCritique };
}
