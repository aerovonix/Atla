/**
 * New-chat greeting quips.
 *
 * GREETING_QUIPS is plain JSON-serializable data — lift it wholesale if you
 * want it somewhere else. Every quip that takes a name puts `{name}` at the
 * end, after a comma, so `resolve()` can drop it cleanly when there's no name
 * to use ("Coffee in hand, {name}?" -> "Coffee in hand?").
 */

export type TimeBlock = "lateNight" | "morning" | "afternoon" | "evening";
export type Weekday = "sunday" | "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday";

export const GREETING_QUIPS = {
  /** First session of the day. Beats the time-of-day pool when it applies. */
  weekdayFirstSession: {
    monday: ["Fresh week, {name}", "Monday, from the top", "Clean slate, {name}", "New week on the board"],
    tuesday: ["Tuesday momentum, {name}", "Tuesday, in motion", "Found the groove, {name}", "Rolling already"],
    wednesday: ["Midweek spark, {name}", "Halfway there, {name}", "Wednesday, dead center", "Top of the hill"],
    thursday: ["Almost Friday, {name}", "Thursday, nearly there", "One more sleep, {name}", "Thursday coasting"],
    friday: ["Friday energy, {name}", "Made it, {name}", "Friday, finally", "Last lap, {name}"],
    saturday: ["Easy Saturday, {name}", "Saturday, no rush", "Weekend mode, {name}", "Nowhere to be"],
    sunday: ["Quiet Sunday, {name}", "Slow Sunday, {name}", "Sunday, no agenda", "Unhurried today"]
  },

  /** lateNight 00:00–04:59 · morning 05:00–11:59 · afternoon 12:00–16:59 · evening 17:00–23:59 */
  timeOfDay: {
    lateNight: ["Quiet hours", "Late spark, {name}", "Still up, {name}?", "Night shift", "Small hours"],
    morning: ["Coffee in hand, {name}?", "Early start", "Morning, {name}", "Fresh page", "First light"],
    afternoon: ["Midday breather", "What's brewing, {name}?", "Afternoon stretch", "Post-lunch pace", "Halfway through, {name}"],
    evening: ["Evening wind-down", "Unpack the day, {name}", "Lights low", "Evening, {name}", "Winding down"]
  },

  /** Timeless — fine at any hour, used as the fallback pool. */
  anytime: [
    "Pull up a chair",
    "Ready when you are, {name}",
    "Room for an idea",
    "What's on your mind, {name}?",
    "Blank page, no pressure",
    "Start anywhere"
  ]
} as const;

const WEEKDAYS: Weekday[] = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export function timeBlockFor(date: Date = new Date()): TimeBlock {
  const h = date.getHours();
  if (h < 5) return "lateNight";
  if (h < 12) return "morning";
  if (h < 17) return "afternoon";
  return "evening";
}

export function weekdayFor(date: Date = new Date()): Weekday {
  return WEEKDAYS[date.getDay()];
}

/**
 * Substitute the name, or strip the placeholder if there isn't one worth using.
 * A blank name, or a placeholder like "You", counts as no name.
 */
export function resolve(template: string, name?: string): string {
  const trimmed = (name ?? "").trim();
  const usable = trimmed && !/^(you|me|user)$/i.test(trimmed) ? trimmed : "";
  if (usable) return template.replace(/\{name\}/g, usable);
  // "Coffee in hand, {name}?" -> "Coffee in hand?"   "Late spark, {name}" -> "Late spark"
  return template.replace(/,?\s*\{name\}/g, "").replace(/\s+([?!.])/g, "$1").trim();
}

export interface GreetingOptions {
  name?: string;
  date?: Date;
  /** True on the day's first chat, which unlocks the weekday pool. */
  firstSessionToday?: boolean;
  /** Don't repeat this exact resolved line — pass the last one shown. */
  avoid?: string;
  /** Injectable for tests. */
  random?: () => number;
}

/** Pick one greeting, already name-resolved and ready to render. */
export function pickGreeting(opts: GreetingOptions = {}): string {
  const { name, date = new Date(), firstSessionToday = false, avoid, random = Math.random } = opts;

  const pool: string[] = firstSessionToday
    ? [...GREETING_QUIPS.weekdayFirstSession[weekdayFor(date)]]
    : [...GREETING_QUIPS.timeOfDay[timeBlockFor(date)], ...GREETING_QUIPS.anytime];

  const resolved = pool.map((t) => resolve(t, name));
  const fresh = resolved.filter((t) => t !== avoid);
  const choices = fresh.length > 0 ? fresh : resolved;
  return choices[Math.floor(random() * choices.length) % choices.length];
}

/**
 * Local calendar day as YYYY-MM-DD.
 *
 * Deliberately not an ISO timestamp: "today" is what the wall clock says, and
 * toISOString() would roll the day over at UTC midnight — showing the Monday
 * greeting on Sunday evening for anyone west of Greenwich.
 */
export function localDayKey(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Whether the weekday line gets used, given what's already happened today.
 *
 * Two conditions, and both matter. Having talked to Atla today rules it out —
 * the line is a greeting, not an interjection. But so does having already
 * shown it: deriving "first session" from message timestamps alone meant every
 * new chat opened before sending anything got its own weekday greeting, which
 * is the opposite of a once-a-day moment.
 */
export function shouldUseWeekday(opts: {
  today: string;
  lastShown: string;
  hadConversationToday: boolean;
}): boolean {
  if (opts.hadConversationToday) return false;
  return opts.lastShown !== opts.today;
}
