import { ipcMain, type BrowserWindow } from "electron";
import type { ApprovalRequest } from "../shared/types.js";

/**
 * Permission prompts for tools whose effects can't be taken back.
 *
 * Main asks, the renderer shows the prompt, the user answers. Anything that
 * goes wrong on the way — no window, a closed window, a cancelled stream, a
 * prompt left unanswered — resolves to *denied*, so the failure direction is
 * always "didn't run".
 */

const APPROVAL_TIMEOUT_MS = 5 * 60_000;

let targetWindow: BrowserWindow | null = null;
let seq = 0;
const pending = new Map<string, (approved: boolean) => void>();

/**
 * Set by "Allow for this session", per kind. Never persisted — a restart
 * clears it. Scoped rather than global on purpose: letting the model run
 * commands unattended is a different decision from letting it rewrite files,
 * and one click must not stand in for both.
 */
const sessionGrants = new Set<ApprovalRequest["kind"]>();

export function initApprovals(win: BrowserWindow) {
  targetWindow = win;
  clearApprovals();
  win.on("closed", clearApprovals);
}

export function registerApprovalIpc() {
  ipcMain.on(
    "approval:response",
    (_e, payload: { id: string; approved: boolean; remember?: boolean; kind?: ApprovalRequest["kind"] }) => {
      const resolve = pending.get(payload.id);
      if (!resolve) return;
      pending.delete(payload.id);
      // Desktop actions can never be granted for a session, whatever the
      // renderer sends: each one is confirmed on its own or not at all.
      if (payload.approved && payload.remember && payload.kind && payload.kind !== "desktop") {
        sessionGrants.add(payload.kind);
      }
      resolve(Boolean(payload.approved));
    }
  );
}

/** Deny everything still waiting — used when a stream is cancelled. */
export function clearApprovals() {
  for (const resolve of pending.values()) resolve(false);
  pending.clear();
}

/** Forget every "for this session" grant. */
export function revokeSessionGrant() {
  sessionGrants.clear();
}

export function hasSessionGrant(kind: ApprovalRequest["kind"]): boolean {
  return sessionGrants.has(kind);
}

export function requestApproval(req: Omit<ApprovalRequest, "id">): Promise<boolean> {
  if (sessionGrants.has(req.kind)) return Promise.resolve(true);
  if (!targetWindow || targetWindow.isDestroyed()) return Promise.resolve(false);

  const id = `approval-${++seq}`;
  const payload: ApprovalRequest = { id, ...req };

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (approved: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pending.delete(id);
      resolve(approved);
    };
    const timer = setTimeout(() => finish(false), APPROVAL_TIMEOUT_MS);
    pending.set(id, finish);
    targetWindow!.webContents.send("approval:request", payload);
  });
}
