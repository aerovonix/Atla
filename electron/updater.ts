import { app, ipcMain, type BrowserWindow } from "electron";
import electronUpdater from "electron-updater";
import type { UpdateState } from "../shared/types.js";
import { acceptsVersion, type UpdateChannel } from "../shared/channels.js";

/**
 * Update checking and downloading, against the project's GitHub releases.
 *
 * Deliberately never installs on its own. Atla can be mid-generation, holding
 * an unsaved canvas buffer, or running a command — restarting under someone
 * is not a decision an updater gets to make. It downloads quietly and then
 * waits to be told.
 *
 * The platform reality is uneven and worth stating rather than discovering:
 * Windows updates fine unsigned, but macOS requires a valid signature — an
 * unsigned build throws "Could not get code signature for running
 * application". So on macOS this reports that updates are unavailable instead
 * of failing repeatedly at the user.
 */

const { autoUpdater } = electronUpdater;

/** Long enough that it isn't chatty, short enough to matter within a session. */
const CHECK_INTERVAL_MS = 6 * 60 * 60_000;

/**
 * How long a download may make no progress before it is declared stuck. Long
 * enough that a slow connection is never mistaken for a hang.
 */
const STALL_TIMEOUT_MS = 90_000;

let targetWindow: BrowserWindow | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let enabled = true;

let state: UpdateState = {
  status: "idle",
  currentVersion: app.getVersion(),
  supported: true
};

function push(patch: Partial<UpdateState>) {
  state = { ...state, ...patch };
  if (targetWindow && !targetWindow.isDestroyed()) {
    targetWindow.webContents.send("update:state", state);
  }
}

/**
 * Whether auto-update can work at all here. A dev run has no update feed, and
 * an unsigned macOS build is rejected by Squirrel.Mac before any download.
 */
function supportCheck(): { supported: boolean; reason?: string } {
  if (!app.isPackaged) {
    return { supported: false, reason: "Updates only apply to an installed build." };
  }
  if (process.platform === "darwin" && !app.isInApplicationsFolder?.()) {
    return { supported: false, reason: "Move Atla to your Applications folder to receive updates." };
  }
  return { supported: true };
}

/**
 * Points the updater at a release tier.
 *
 * Note what is *not* set here: `autoUpdater.channel`. Pinning it would make a
 * beta user request `beta.yml` from a stable release, which the GitHub
 * provider never generates — see shared/channels.ts for why that 404s
 * forever. Letting the provider resolve each tag's own channel file and
 * filtering by tier afterwards is the combination that actually works.
 */
export function applyChannel(channel: UpdateChannel) {
  autoUpdater.allowPrerelease = channel !== "stable";
  autoUpdater.isUpdateSupported = (info) => acceptsVersion(channel, info.version);
}

export function initUpdater(win: BrowserWindow, autoUpdateEnabled: boolean) {
  targetWindow = win;
  enabled = autoUpdateEnabled;

  // Downloading is fine unattended; installing is not. This is the line
  // between the two.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;

  const support = supportCheck();
  state = { ...state, supported: support.supported, message: support.reason };

  /**
   * A download that stops making progress looks exactly like a slow one, and
   * says nothing either way. This was not hypothetical: a missing .blockmap on
   * the release made electron-updater sit at 0% indefinitely with no error,
   * and the UI reported "Downloading 0%" forever because that was all it knew.
   */
  const stall = {
    timer: null as ReturnType<typeof setTimeout> | null,
    clear() {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
    },
    arm() {
      this.clear();
      this.timer = setTimeout(() => {
        if (state.status !== "downloading") return;
        push({
          status: "idle",
          percent: undefined,
          message:
            "The download stopped making progress and was given up on. Try again, or download the new version from the releases page."
        });
      }, STALL_TIMEOUT_MS);
    }
  };

  autoUpdater.on("checking-for-update", () => push({ status: "checking", message: undefined }));
  autoUpdater.on("update-available", (info) => {
    push({ status: "downloading", availableVersion: info.version, percent: 0, message: undefined });
    stall.arm();
  });
  autoUpdater.on("update-not-available", () => push({ status: "idle", availableVersion: undefined }));
  autoUpdater.on("download-progress", (p) => {
    // Progress is the only proof it is alive, so it is what resets the clock.
    stall.arm();
    push({ status: "downloading", percent: Math.round(p.percent) });
  });
  autoUpdater.on("update-downloaded", (info) => {
    stall.clear();
    push({ status: "ready", availableVersion: info.version, percent: 100 });
  });
  autoUpdater.on("error", (err) => {
    stall.clear();
    const text = err?.message ?? String(err);
    // macOS says this when the app isn't signed. It's a permanent condition,
    // not a transient failure, so stop rather than retry every six hours.
    const unsigned = /code signature|not signed|SQRL/i.test(text);
    push({
      status: "idle",
      supported: !unsigned && state.supported,
      message: unsigned
        ? "This build isn't code-signed, so macOS won't let it update itself. Download a new version manually."
        : text
    });
  });

  if (enabled && support.supported) {
    // Not on the first tick: startup is busy enough without a network call
    // competing with the window painting.
    setTimeout(() => void check(), 8000);
    timer = setInterval(() => void check(), CHECK_INTERVAL_MS);
  }
}

export async function check(): Promise<UpdateState> {
  if (!enabled || !state.supported) return state;
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    push({ status: "idle", message: err instanceof Error ? err.message : String(err) });
  }
  return state;
}

export function setEnabled(next: boolean) {
  enabled = next;
  if (!next) {
    if (timer) clearInterval(timer);
    timer = null;
    push({ status: "idle", availableVersion: undefined, percent: undefined });
    return;
  }
  if (!timer && state.supported) {
    timer = setInterval(() => void check(), CHECK_INTERVAL_MS);
    void check();
  }
}

export function registerUpdaterIpc() {
  ipcMain.handle("update:state", () => state);
  ipcMain.handle("update:check", () => check());
  ipcMain.handle("update:install", () => {
    if (state.status !== "ready") return { ok: false as const };
    // isSilent false so the installer's own progress is visible; the app is
    // quitting either way, so there's nothing to preserve past this point.
    autoUpdater.quitAndInstall(false, true);
    return { ok: true as const };
  });
  ipcMain.handle("update:set-enabled", (_e, next: boolean) => {
    setEnabled(Boolean(next));
    return state;
  });
  ipcMain.handle("update:set-channel", (_e, channel: UpdateChannel) => {
    applyChannel(channel);
    return state;
  });
}
