import { BrowserWindow, ipcMain, type WebContents } from "electron";
import type { AppSettings } from "../shared/types.js";
import { adblocker } from "./adblock.js";
import { applyChannel, setEnabled as setUpdatesEnabled } from "./updater.js";

/**
 * Settings, owned by the main process.
 *
 * Every other piece of state still lives in the renderer, and this one moved
 * because it is the only state more than one window needs. Once a pane can be
 * popped into its own window, two renderers hold their own copy of "block
 * trackers" and nothing keeps them equal; the window that happens to save last
 * wins, and the other silently reverts. Ownership has to sit somewhere both
 * windows can see, which is here.
 *
 * Two consequences worth stating, because they are the point:
 *
 * 1. The side effects live here now. Turning off tracker blocking reaches the
 *    adblocker directly rather than via whichever renderer happened to make
 *    the change, so it applies identically no matter which window asked.
 * 2. This copy wins when state is written to disk. A renderer's mirror can go
 *    briefly stale; it must never be able to persist that staleness over the
 *    real thing.
 */
let settings: AppSettings | null = null;

export function initSettings(initial: AppSettings) {
  settings = { ...initial };
  applyEffects(settings);
}

export function getSettings(): AppSettings | null {
  return settings;
}

/**
 * Overwrites a state object's settings with the owned copy.
 *
 * Renderers still persist the rest of the app state, and their settings
 * mirror rides along in that payload. Without this, a window that had not yet
 * received the latest change would write its stale copy over the real one.
 */
export function withOwnedSettings<T extends { settings: AppSettings }>(state: T): T {
  return settings ? { ...state, settings } : state;
}

function applyEffects(next: AppSettings) {
  adblocker.setEnabled(next.blockTrackers ?? next.adblockEnabled);
  adblocker.setStripParams(next.stripTrackingParams !== false);
  adblocker.setLeanWhenHidden(next.leanWhenHidden !== false);
  adblocker.setSpeed(next.browserSpeed ?? "normal");
  adblocker.setCustomRules(next.customBlocklist);
  setUpdatesEnabled(Boolean(next.autoUpdate));
  applyChannel(next.updateChannel ?? "stable");
}

/**
 * Applies a change and tells every window except the one that made it.
 *
 * The originator is skipped because it already applied the change locally the
 * moment it was made. Echoing it back would be harmless but would make every
 * toggle wait for a round trip before it looked like it had done anything.
 */
export function patchSettings(patch: Partial<AppSettings>, origin?: WebContents) {
  if (!settings) return;
  settings = { ...settings, ...patch };
  applyEffects(settings);
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents === origin) continue;
    win.webContents.send("settings:changed", settings);
  }
}

export function registerSettingsIpc() {
  ipcMain.handle("settings:get", () => settings);
  ipcMain.handle("settings:patch", (e, patch: Partial<AppSettings>) => {
    patchSettings(patch ?? {}, e.sender);
    return settings;
  });
}
