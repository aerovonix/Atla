/**
 * What the model is allowed to touch on the desktop.
 *
 * Two modes, per the design: an **allowlist** of apps (the default), and
 * **unrestricted**, which the user has to turn on deliberately. Everything
 * here is pure so the self-test can pin the matching — a bug in this file is
 * the difference between "can click in my editor" and "can click anywhere",
 * and that is not something to verify by eye.
 *
 * The direction of failure is fixed: anything unrecognised is denied.
 */

export type DesktopScope = "allowlist" | "unrestricted";

export interface DesktopPolicy {
  enabled: boolean;
  scope: DesktopScope;
  /** Case-insensitive substrings matched against the window title. */
  allowlist: string[];
  /** Ask before every action, not just the irreversible ones. */
  confirmEvery: boolean;
}

export interface DesktopWindow {
  id: string;
  title: string;
}

export type DesktopAction =
  | { kind: "screenshot" }
  | { kind: "list" }
  | { kind: "move"; x: number; y: number }
  | { kind: "click"; x: number; y: number; button: "left" | "right"; double?: boolean }
  | { kind: "type"; text: string }
  | { kind: "key"; key: string };

export interface Decision {
  allowed: boolean;
  /** Needs an explicit yes from the user before it runs. */
  confirm: boolean;
  reason: string;
}

/** Reading the screen is not the same as acting on it. */
export function isObservation(action: DesktopAction): boolean {
  return action.kind === "screenshot" || action.kind === "list";
}

/**
 * Titles that read as a step you can't walk back. Deliberately broad and
 * matched loosely: a false positive costs one extra confirmation, a false
 * negative costs the user something they can't undo.
 */
const IRREVERSIBLE = [
  "delete",
  "remove",
  "erase",
  "permanently",
  "uninstall",
  "format",
  "wipe",
  "purge",
  "discard",
  "reset",
  "revoke",
  "deactivate",
  "close account",
  "buy",
  "purchase",
  "checkout",
  "place order",
  "pay",
  "subscribe",
  "confirm",
  "send",
  "publish",
  "post",
  "submit",
  "transfer",
  "withdraw",
  "sign out",
  "log out",
  "empty trash",
  "move to trash",
  "overwrite",
  "replace",
  "don't save",
  "do not save"
];

/**
 * Whether an action lands somewhere that looks irreversible. `nearbyText` is
 * whatever the model says it's clicking — a button label, a menu item.
 */
export function looksIrreversible(action: DesktopAction, nearbyText = ""): boolean {
  if (isObservation(action) || action.kind === "move") return false;
  const haystack = nearbyText.toLowerCase();
  if (action.kind === "key") {
    // Enter on an unknown dialog commits whatever it is.
    return /^(enter|return)$/i.test(action.key) && haystack.length === 0;
  }
  return IRREVERSIBLE.some((w) => haystack.includes(w));
}

/** Case-insensitive substring match; an empty pattern never matches anything. */
export function titleAllowed(title: string, allowlist: string[]): boolean {
  const t = (title ?? "").toLowerCase();
  if (!t) return false;
  return allowlist.some((raw) => {
    const p = (raw ?? "").trim().toLowerCase();
    return p.length > 0 && t.includes(p);
  });
}

/**
 * The whole gate in one function.
 *
 * `focusedTitle` is the window that would actually receive the action. An
 * unknown title is a denial rather than a prompt: if we cannot tell what we
 * are about to click on, asking the user to approve it is asking them to
 * approve something neither of us can name.
 */
export function decide(policy: DesktopPolicy, action: DesktopAction, focusedTitle: string, nearbyText = ""): Decision {
  if (!policy.enabled) {
    return { allowed: false, confirm: false, reason: "Desktop control is off." };
  }

  // Listing windows is how the user's own allowlist gets built, so it can't
  // itself require an allowlisted window.
  if (action.kind === "list") {
    return { allowed: true, confirm: false, reason: "Listing windows." };
  }

  if (policy.scope === "allowlist") {
    if (!focusedTitle.trim()) {
      return { allowed: false, confirm: false, reason: "Couldn't identify the focused window." };
    }
    if (!titleAllowed(focusedTitle, policy.allowlist)) {
      return {
        allowed: false,
        confirm: false,
        reason: `"${focusedTitle}" isn't in the allowed apps. Add it in Settings to let Atla act there.`
      };
    }
  }

  if (isObservation(action)) {
    return { allowed: true, confirm: policy.confirmEvery, reason: "Reading the screen." };
  }

  if (looksIrreversible(action, nearbyText)) {
    return { allowed: true, confirm: true, reason: "This looks like it can't be undone." };
  }

  return { allowed: true, confirm: policy.confirmEvery, reason: "Allowed." };
}

/** One-line description of an action, for the approval prompt. */
export function describeAction(action: DesktopAction, focusedTitle: string): string {
  const where = focusedTitle ? ` in ${focusedTitle}` : "";
  switch (action.kind) {
    case "list":
      return "List the open windows";
    case "screenshot":
      return `Take a screenshot${where}`;
    case "move":
      return `Move the pointer to ${action.x}, ${action.y}${where}`;
    case "click":
      return `${action.double ? "Double-click" : action.button === "right" ? "Right-click"  : "Click"} at ${action.x}, ${action.y}${where}`;
    case "type":
      return `Type ${JSON.stringify(action.text.length > 60 ? `${action.text.slice(0, 60)}…` : action.text)}${where}`;
    case "key":
      return `Press ${action.key}${where}`;
  }
}
