/**
 * Markdown to plain text, for places that can't render it.
 *
 * A notification body is the main one: a toast showing `**Done** — see \`x.ts\``
 * reads as noise, and the OS won't format it for us. Deliberately lossy and
 * one-way — this is for display, never for round-tripping.
 *
 * Pure so the self-test can pin it without a notification actually firing.
 */

export function stripMarkdown(input: string): string {
  let s = input ?? "";

  // Fenced code goes entirely: a toast has no room for it, and the fence
  // markers are worse than nothing.
  s = s.replace(/```[\s\S]*?```/g, " ");
  s = s.replace(/~~~[\s\S]*?~~~/g, " ");

  // Images before links, since an image is a link with a leading !.
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  // Reference-style and bare autolinks.
  s = s.replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1");
  s = s.replace(/<(https?:\/\/[^>]+)>/g, "$1");

  s = s.replace(/`([^`]*)`/g, "$1");

  // Emphasis. Bold before italic so ** doesn't leave a stray *.
  s = s.replace(/(\*\*|__)(.*?)\1/g, "$2");
  s = s.replace(/(\*|_)(?=\S)(.*?\S)\1/g, "$2");
  s = s.replace(/~~(.*?)~~/g, "$1");

  // Block markers at the start of a line.
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  s = s.replace(/^\s{0,3}>\s?/gm, "");
  s = s.replace(/^\s{0,3}[-*+]\s+/gm, "");
  s = s.replace(/^\s{0,3}\d+[.)]\s+/gm, "");
  // A horizontal rule carries no text at all.
  s = s.replace(/^\s{0,3}([-*_])\s*(\1\s*){2,}$/gm, " ");

  // Tables: keep the cells, drop the pipes and the separator row.
  s = s.replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, " ");
  s = s.replace(/\s*\|\s*/g, " ");

  // Everything collapses to a single line — a toast doesn't honour newlines
  // reliably, and a body full of blank lines just eats the character budget.
  return s.replace(/\s+/g, " ").trim();
}

/** Trims to a length without cutting mid-word, adding an ellipsis if it cut. */
export function clampText(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
