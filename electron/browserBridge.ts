import { ipcMain, type BrowserWindow } from "electron";
import type { BrowserPageInfo } from "../shared/types.js";

/**
 * The browser panel is a <webview> living in the renderer, so the main process
 * can't touch it directly. This is a small request/response RPC: main asks the
 * renderer to act on the webview, the renderer replies on a correlated channel.
 */

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, Pending>();
let seq = 0;
let targetWindow: BrowserWindow | null = null;

/**
 * Electron IPC doesn't queue for listeners that aren't attached yet, so a
 * command sent before the panel mounts is silently dropped and only surfaces
 * as a timeout much later. The renderer signals once its RPC handler is live,
 * and every command waits for that first.
 */
let rendererReady = false;
let readyResolve: (() => void) | null = null;
let readyPromise: Promise<void> = new Promise((r) => (readyResolve = r));

ipcMain.on("browser:renderer-ready", () => {
  rendererReady = true;
  readyResolve?.();
});

export function initBrowserBridge(win: BrowserWindow) {
  targetWindow = win;
  // A fresh renderer (new window, reload) has to announce itself again.
  rendererReady = false;
  readyPromise = new Promise((r) => (readyResolve = r));
  win.webContents.on("did-start-navigation", (_e, _url, _isInPlace, isMainFrame) => {
    if (!isMainFrame) return;
    rendererReady = false;
    readyPromise = new Promise((r) => (readyResolve = r));
  });
}

function waitForRenderer(timeoutMs: number): Promise<void> {
  if (rendererReady) return Promise.resolve();
  return Promise.race([
    readyPromise,
    new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error("The browser panel didn't come up in time.")), timeoutMs)
    )
  ]);
}

ipcMain.on("browser:rpc-response", (_e, payload: { id: string; ok: boolean; result?: unknown; error?: string }) => {
  const entry = pending.get(payload.id);
  if (!entry) return;
  pending.delete(payload.id);
  clearTimeout(entry.timer);
  if (payload.ok) entry.resolve(payload.result);
  else entry.reject(new Error(payload.error ?? "Browser command failed"));
});

async function call<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = 45000): Promise<T> {
  if (!targetWindow || targetWindow.isDestroyed()) {
    throw new Error("The app window isn't available.");
  }
  await waitForRenderer(30000);
  if (!targetWindow || targetWindow.isDestroyed()) {
    throw new Error("The app window isn't available.");
  }
  const id = `brpc_${++seq}`;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Browser command "${method}" timed out.`));
    }, timeoutMs);
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    targetWindow!.webContents.send("browser:rpc-request", { id, method, params });
  });
}

export const browserControl = {
  navigate: (url: string) => call<BrowserPageInfo>("navigate", { url }),
  readPage: () => call<BrowserPageInfo>("readPage"),
  click: (text: string) => call<BrowserPageInfo>("click", { text }),
  findLinks: (query: string) => call<{ links: { text: string; href: string }[] }>("findLinks", { query }),
  goBack: () => call<BrowserPageInfo>("goBack"),
  currentUrl: () => call<{ url: string }>("currentUrl"),
  openTab: (url: string) => call<{ id: string }>("openTab", { url }),
  listTabs: () => call<{ tabs: { id: string; url: string; active: boolean }[] }>("listTabs"),
  switchTab: (id: string) => call<{ id: string; url: string }>("switchTab", { id }),
  closeTab: (id: string) => call<{ closed: string }>("closeTab", { id })
};
