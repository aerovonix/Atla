/**
 * The environment block prepended to every system prompt.
 *
 * Without this a model answers date and time questions from its training data
 * and is completely confident about it — a Mistral build will insist it is
 * still 2024. It has no clock of its own, so if we don't tell it, it guesses.
 * Pure and parameterised so the self-test can pin the wording and the
 * formatting without waiting for a particular day to come around.
 */

export interface SystemInfo {
  /** "win32" | "darwin" | "linux" */
  platform: string;
  /** Human-readable OS name and version, e.g. "Windows 11 (10.0.26100)". */
  osVersion: string;
  arch: string;
  /** The shell run_command actually invokes. */
  shell: string;
  homeDir: string;
}

const OS_LABELS: Record<string, string> = {
  win32: "Windows",
  darwin: "macOS",
  linux: "Linux"
};

export function osLabel(platform: string): string {
  return OS_LABELS[platform] ?? platform;
}

/** "-05:00" / "+00:00" — what a person would recognise as a UTC offset. */
export function utcOffset(date: Date): string {
  // getTimezoneOffset is minutes *behind* UTC, so the sign is inverted.
  const total = -date.getTimezoneOffset();
  const sign = total < 0 ? "-" : "+";
  const abs = Math.abs(total);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}

export function formatNow(date: Date, timeZone: string): string {
  const day = date.toLocaleDateString("en-US", { weekday: "long" });
  const ymd = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const hm = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const zone = timeZone ? `${timeZone}, ` : "";
  return `${day}, ${ymd}, ${hm} (${zone}UTC${utcOffset(date)})`;
}

export function buildEnvironmentPrompt(opts: {
  now: Date;
  timeZone: string;
  info?: SystemInfo | null;
  cwd?: string;
}): string {
  const lines = [`Current date and time: ${formatNow(opts.now, opts.timeZone)}.`];
  if (opts.info) {
    lines.push(`Operating system: ${opts.info.osVersion} (${opts.info.platform}, ${opts.info.arch}).`);
    lines.push(`Shell: ${opts.info.shell}.`);
  }
  if (opts.cwd) lines.push(`Working directory: ${opts.cwd}.`);
  // Stated outright because the failure mode is confident, not hesitant: a
  // model that thinks it is still at its cutoff will not think to doubt itself.
  lines.push(
    "This is the real current environment. It overrides anything your training data suggests about the date — do not answer date, time, or 'latest version' questions from memory, and don't tell the user what year you think it is based on your training."
  );
  return lines.join("\n");
}
