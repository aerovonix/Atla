/**
 * The web dash's wire format and pairing rules.
 *
 * Pure, so the self-test can cover the auth logic without opening a socket —
 * which matters more here than anywhere else in the app, because this is the
 * one component that listens on a network.
 *
 * The transport is deliberately kept behind these types: today it's a plain
 * HTTP server on the LAN, and a tunnel later should only have to satisfy the
 * same shapes.
 */

/**
 * Every pair of glyphs people actually confuse when reading a code off one
 * screen and typing it into another is excluded: 0/O, 1/I/L, 8/B, 5/S, 2/Z,
 * and U (which reads as V in some faces). A misread is indistinguishable from
 * a wrong guess, and enough of them lock the user out of their own dash.
 */
const CODE_ALPHABET = "34679ACDEFGHJKMNPQRTVWXY";
export const CODE_LENGTH = 8;

/**
 * A pairing code with ~36 bits of entropy (24^8). That is not enough on its
 * own — it is enough given the lockout below, which is what actually makes
 * guessing impractical.
 */
export function generatePairingCode(random: (n: number) => number[] = defaultRandom): string {
  const n = CODE_ALPHABET.length;
  // 256 isn't a multiple of 24, so a plain modulo would make the first few
  // letters measurably more likely. Rejection sampling keeps it uniform.
  const limit = Math.floor(256 / n) * n;
  const out: string[] = [];
  while (out.length < CODE_LENGTH) {
    for (const b of random(CODE_LENGTH)) {
      if (b >= limit) continue;
      out.push(CODE_ALPHABET[b % n]);
      if (out.length === CODE_LENGTH) break;
    }
  }
  return out.join("");
}

function defaultRandom(n: number): number[] {
  // Node and the browser both have this; the fallback is never reached in the
  // app and exists so the pure module can't throw in a bare test runner.
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.getRandomValues) return Array.from(c.getRandomValues(new Uint8Array(n)));
  return Array.from({ length: n }, () => Math.floor(Math.random() * 256));
}

/** Formats for display: XXXX-XXXX reads back over a phone far better. */
export function formatCode(code: string): string {
  return code.length === CODE_LENGTH ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

/** Accepts what a person actually types: lowercase, spaces, the dash. */
export function normalizeCode(input: string): string {
  return (input ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Constant-time-ish comparison. JS strings can't be compared in true constant
 * time, but this avoids the early return that makes `===` leak a prefix length
 * to anything measuring response time.
 */
export function codesMatch(a: string, b: string): boolean {
  const x = normalizeCode(a);
  const y = normalizeCode(b);
  // Two empties are not a match. The server already refuses to compare against
  // an unset code, but this is the function whose job it is to say no, and it
  // should not depend on every caller remembering to check first.
  if (!x || !y) return false;
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

export interface PairingState {
  failures: number;
  /** Epoch ms until which pairing is refused outright. */
  lockedUntil: number;
}

export const MAX_FAILURES = 5;
export const LOCKOUT_MS = 5 * 60_000;

/**
 * Lockout after a handful of wrong codes. Without this, 39 bits of entropy is
 * irrelevant: an attacker on the same network just tries codes until one works.
 */
export function checkLockout(state: PairingState, now: number): { locked: boolean; retryInMs: number } {
  if (state.lockedUntil > now) return { locked: true, retryInMs: state.lockedUntil - now };
  return { locked: false, retryInMs: 0 };
}

export function registerFailure(state: PairingState, now: number): PairingState {
  const failures = state.failures + 1;
  if (failures >= MAX_FAILURES) return { failures: 0, lockedUntil: now + LOCKOUT_MS };
  return { failures, lockedUntil: state.lockedUntil };
}

export function registerSuccess(): PairingState {
  return { failures: 0, lockedUntil: 0 };
}

/** What the dash can ask for. Deliberately small — this is a remote, not a client. */
export type DashRequest =
  | { type: "list" }
  | { type: "open"; conversationId: string }
  | { type: "send"; conversationId: string; text: string }
  | { type: "stop"; conversationId: string };

export interface DashConversation {
  id: string;
  title: string;
  updatedAt: number;
  messageCount: number;
}

export interface DashMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
}
