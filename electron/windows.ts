import { BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

// This file is ESM, where __dirname does not exist. Without this the preload
// path throws at window creation and the pop-out never opens.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Panes that can live in a window of their own. */
export type PaneKind = "browser" | "terminal" | "canvas";

const PANE_TITLES: Record<PaneKind, string> = {
  browser: "Atla — Browser",
  terminal: "Atla — Terminal",
  canvas: "Atla — Canvas"
};

const popped = new Map<PaneKind, BrowserWindow>();

/**
 * Pop-outs load the same renderer bundle with `?pane=` set, rather than a
 * separate entry point. One bundle means a pane cannot drift between its
 * docked and undocked form, which is the failure this would otherwise invite:
 * two copies of the browser panel, fixed in one place and not the other.
 */
function rendererTarget(pane: PaneKind, isDev: boolean): { url?: string; file?: string; query: string } {
  const query = `pane=${pane}`;
  return isDev
    ? { url: `http://localhost:5173/?${query}`, query }
    : { file: path.join(__dirname, "../../dist/index.html"), query };
}

export function poppedPanes(): PaneKind[] {
  return [...popped.keys()];
}

function announce() {
  const list = poppedPanes();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("windows:popped", list);
  }
}

export async function popOutPane(pane: PaneKind, isDev: boolean, parent: BrowserWindow | null) {
  const existing = popped.get(pane);
  if (existing && !existing.isDestroyed()) {
    // Asking twice means "show me the one I already have", not "make another".
    existing.focus();
    return;
  }

  const win = new BrowserWindow({
    width: pane === "browser" ? 1100 : 900,
    height: 780,
    minWidth: 480,
    minHeight: 360,
    backgroundColor: "#151412",
    autoHideMenuBar: true,
    title: PANE_TITLES[pane],
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true
    }
  });

  popped.set(pane, win);
  win.on("closed", () => {
    popped.delete(pane);
    announce();
  });

  const target = rendererTarget(pane, isDev);
  if (target.url) await win.loadURL(target.url);
  else await win.loadFile(target.file!, { search: target.query });

  announce();
  void parent;
}

/**
 * Closes every pop-out.
 *
 * Called when the main window goes away: the main window is the app, so a
 * popped pane outliving it would leave Atla running with no way back to a
 * conversation. Destroy rather than close, because a `close` handler that
 * re-announces during teardown would fire against a window list that is
 * already being dismantled.
 */
export function closeAllPopouts() {
  for (const win of popped.values()) {
    if (!win.isDestroyed()) win.destroy();
  }
  popped.clear();
}

export function registerWindowIpc(isDev: boolean, getMain: () => BrowserWindow | null) {
  ipcMain.handle("windows:pop-out", async (_e, pane: PaneKind) => {
    if (pane !== "browser" && pane !== "terminal" && pane !== "canvas") return false;
    await popOutPane(pane, isDev, getMain());
    return true;
  });
  ipcMain.handle("windows:popped", () => poppedPanes());
  ipcMain.handle("windows:dock", (_e, pane: PaneKind) => {
    const win = popped.get(pane);
    if (win && !win.isDestroyed()) win.close();
    return true;
  });
}
