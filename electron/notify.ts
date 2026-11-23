import path from "node:path";
import { BrowserWindow, Notification, app, ipcMain, nativeImage } from "electron";
import { clampText, stripMarkdown } from "../shared/plaintext.js";

/**
 * Desktop notifications for finished replies.
 *
 * Only fires when the window isn't focused. A notification for something the
 * user is already watching happen is pure noise, and it's the fastest way to
 * get someone to switch notifications off entirely.
 */

/**
 * Resolved on demand rather than stored.
 *
 * The window does not exist yet when this is wired up, and it is set back to
 * null when it closes — so a reference captured at startup is null forever and
 * a reference captured later goes stale. Either way the focus check below
 * silently degrades into "always notify", which is the failure this had:
 * every finished reply raised a toast, including ones the user was watching
 * arrive.
 */
let getWindow: () => BrowserWindow | null = () => null;
let icon: Electron.NativeImage | null = null;

/** The window notifications check focus against, or null if there isn't one. */
export function notifyTarget(): BrowserWindow | null {
  const win = getWindow();
  return win && !win.isDestroyed() ? win : null;
}

/**
 * Whether a finished reply should raise a toast.
 *
 * Split out because the interesting case is the one that is easy to get wrong
 * by accident: `focused` unknown. A missing window must mean "notify" only
 * when there is genuinely no window — not when we merely failed to find one.
 */
export function shouldNotify(opts: { supported: boolean; focused: boolean }): boolean {
  if (!opts.supported) return false;
  return !opts.focused;
}

export function initNotify(resolve: () => BrowserWindow | null) {
  getWindow = resolve;

  // Windows reads the toast's app name and icon from the AppUserModelID, and
  // Electron's default is "<something>.electron.app" — which is what shows up
  // in the toast if this isn't set. It has to match the installer's appId so
  // it resolves to the shortcut NSIS created.
  if (process.platform === "win32") app.setAppUserModelId("com.aerovonix.atla");

  // Passed explicitly as well: in a dev run there is no installed shortcut for
  // the AUMID to resolve against, so without this the toast has no icon.
  // Packaged: copied to resources/ by electron-builder's extraResources.
  // Dev: read straight out of the repo.
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, "icon.png")
    : path.join(app.getAppPath(), "build", "icon.png");
  const img = nativeImage.createFromPath(iconPath);
  icon = img.isEmpty() ? null : img;
}

export function registerNotifyIpc() {
  ipcMain.handle("notify:send", (_e, args: { title: string; body: string }) => {
    // Focus is checked here rather than in the renderer because the renderer
    // can't tell a focused window from a visible one behind another app.
    const win = notifyTarget();
    if (!shouldNotify({ supported: Notification.isSupported(), focused: Boolean(win?.isFocused()) })) {
      return { ok: false as const, reason: Notification.isSupported() ? "focused" : "unsupported" };
    }

    // The OS won't render markdown, so asterisks and backticks arrive as
    // literal punctuation. Stripped rather than passed through.
    const body = clampText(stripMarkdown(String(args?.body ?? "")), 220);
    const title = clampText(stripMarkdown(String(args?.title ?? "Atla")), 60) || "Atla";

    const n = new Notification({
      title,
      body,
      ...(icon ? { icon } : {}),
      silent: false
    });
    // Clicking it should take you to the thing it's telling you about.
    n.on("click", () => {
      const target = notifyTarget();
      if (target) {
        if (target.isMinimized()) target.restore();
        target.focus();
      }
    });
    n.show();
    return { ok: true as const };
  });
}
