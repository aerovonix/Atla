/**
 * The critic revision loop.
 *
 * A second model reads the answer and either approves it or says what's wrong;
 * the first model then revises. The whole difficulty is the approval case: a
 * model asked to critique will almost always find something, because finding
 * nothing feels like failing the task. So the prompt makes approval the
 * explicit, named, one-word action, and the parser treats anything ambiguous
 * as approval rather than inventing a revision round out of hedging.
 *
 * Pure so the self-test can pin the parsing without spending tokens.
 */

export const APPROVAL_TOKEN = "LGTM";

export const CRITIC_SYSTEM = [
  "You are reviewing another assistant's reply before the user sees it. You are not answering the question yourself.",
  "",
  `If the reply is good enough to send, respond with exactly ${APPROVAL_TOKEN} and nothing else. This is the normal outcome — most replies are fine, and saying so is doing the job properly, not skipping it.`,
  "",
  "Only raise something if it would actually change what the user does:",
  "- a factual error, a wrong claim, or a broken code path",
  "- a direct question in the prompt that went unanswered",
  "- advice that would lose data, break something, or cost money unexpectedly",
  "- a missing caveat the user would want before acting",
  "",
  "Do NOT raise: wording, tone, structure, length, formatting, or things you would merely have phrased differently. Do not ask for hedging, disclaimers, or padding. Do not suggest adding sections nobody asked for.",
  "",
  `If you do have something, list it as brief numbered points and nothing else — no preamble, no praise, no restating the reply. If you are unsure whether something is worth raising, it is not: answer ${APPROVAL_TOKEN}.`
].join("\n");

export function critiqueRequest(prompt: string, answer: string): string {
  return [
    "The user asked:",
    "",
    prompt,
    "",
    "The assistant replied:",
    "",
    answer,
    "",
    `Review it. Reply ${APPROVAL_TOKEN} if it should be sent as-is.`
  ].join("\n");
}

export function revisionRequest(notes: string): string {
  return [
    "A reviewer raised these points about your reply:",
    "",
    notes,
    "",
    "Rewrite your reply, fixing what's genuinely wrong. Keep everything that was already right — this is a revision, not a fresh answer, and it should not get longer just because it was reviewed. Do not mention the review, the reviewer, or that anything was revised. Reply with the corrected answer only."
  ].join("\n");
}

export interface Verdict {
  approved: boolean;
  /** What to hand back for revision. Empty when approved. */
  notes: string;
}

/**
 * Reads the critic's reply. Biased towards approval on purpose: a false
 * approval costs nothing (the original answer ships, which was already the
 * baseline), while a false rejection spends a whole extra round trip and
 * usually makes the answer worse by padding it.
 */
export function parseVerdict(raw: string): Verdict {
  const text = (raw ?? "").trim();
  if (!text) return { approved: true, notes: "" };

  // Strip anything that isn't the verdict: code fences, quotes, bold.
  const cleaned = text
    .replace(/^```[a-z]*\s*/i, "")
    .replace(/\s*```$/, "")
    .replace(/[*_`"']/g, "")
    .trim();

  // The token alone, or the token leading a sentence like "LGTM - looks good".
  const head = cleaned.split(/\r?\n/)[0].trim();
  if (new RegExp(`^${APPROVAL_TOKEN}\\b`, "i").test(head)) return { approved: true, notes: "" };

  // Common ways a model approves without using the token.
  if (/^(no (changes?|issues?|notes?|problems?)|nothing (to add|here)|looks good|all good|fine as[- ]is)\b/i.test(head)) {
    return { approved: true, notes: "" };
  }

  // A critique with no actual content is an approval that lost its nerve.
  if (cleaned.length < 12) return { approved: true, notes: "" };

  return { approved: false, notes: text };
}

/** Nothing worth reviewing: an error, a refusal stub, or a one-liner. */
export function worthReviewing(answer: string, minChars: number): boolean {
  const text = (answer ?? "").trim();
  return text.length >= minChars;
}
