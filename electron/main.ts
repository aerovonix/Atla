import { readFileSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, ipcMain, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAll, saveState, saveProviders, saveStartupFlags, migrateFromNova } from "./store.js";
import { streamChat, generateTitle } from "./providers.js";
import { fetchModels } from "./modelList.js";
import { adblocker } from "./adblock.js";
import { initSettings, registerSettingsIpc, withOwnedSettings } from "./sharedSettings.js";
import { closeAllPopouts, registerWindowIpc } from "./windows.js";
import { initBrowserBridge } from "./browserBridge.js";
import { initTerminal, registerTerminalIpc } from "./terminal.js";
import { registerFileIpc } from "./files.js";
import { reviewAndRevise } from "./critic.js";
import { describeError } from "../shared/errors.js";
import { registerDesktopIpc, registerPermissionIpc } from "./desktop.js";
import { initWebDash, registerWebDashIpc } from "./webdash.js";
import { initNotify, registerNotifyIpc } from "./notify.js";
import { initUpdater, registerUpdaterIpc } from "./updater.js";
import { initApprovals, registerApprovalIpc, clearApprovals } from "./approvals.js";
import type { AppState, ChatStreamRequest, FetchModelsResponse, ProviderConfig } from "../shared/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = process.env.NOVA_DEV === "1" || process.env.ATLA_DEV === "1";

export const BROWSER_PARTITION = "persist:atla-browser";

/**
 * GPU compositing is on by default and Chromium already picks sensibly, so
 * this exists only as an escape hatch: a broken or blacklisted driver can make
 * the whole window render slower than software would. It has to be read before
 * the app is ready — Chromium fixes its GPU decision at startup and ignores
 * the switch afterwards.
 */
function applyGpuPreference() {
  try {
    // Deliberately NOT the main state file. That holds the whole conversation
    // history — 9 MB and growing — and reading it here cost 101 ms of startup
    // before the window could even be created, to fetch one boolean. This
    // sidecar carries only what must be known before the app is ready.
    const raw = readFileSync(join(app.getPath("userData"), "atla-startup.json"), "utf8");
    if (JSON.parse(raw)?.hardwareAcceleration === false) {
      app.disableHardwareAcceleration();
    }
  } catch {
    // Absent on first run, or unreadable. Acceleration on is the right default.
  }
}
applyGpuPreference();

const activeStreams = new Map<string, AbortController>();
let providersCache: ProviderConfig[] = [];

let mainWindow: BrowserWindow | null = null;

async function createWindow() {
  // Set before the first window: Windows binds the toast identity early, and
  // a later call doesn't always re-associate an already-shown app.
  if (process.platform === "win32") app.setAppUserModelId("com.aerovonix.atla");

  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 760,
    minHeight: 520,
    // Painted before the renderer loads, so it has to match the default theme
    // or the window flashes a colour the app never uses. This is the dark
    // ground; a Midnight user sees one frame of #151412 rather than one frame
    // of white, which is the right way round to be wrong.
    backgroundColor: "#151412",
    autoHideMenuBar: true,
    title: "Atla",
    // Packaged builds get the icon from the exe; this is for `npm run dev`.
    ...(isDev ? { icon: path.join(__dirname, "../../build/icon.png") } : {}),
    webPreferences: {
      // preload.cjs is compiled from preload.cts specifically so it's real
      // CommonJS: Electron's preload loader always uses require(), and
      // package.json has "type": "module", so a plain .js preload here would
      // throw ERR_REQUIRE_ESM and silently break window.atla.
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Required for the built-in browser panel.
      webviewTag: true
    }
  });

  // The main window is the app. A popped pane outliving it would leave Atla
  // running with no way back to a conversation.
  mainWindow.on("close", () => closeAllPopouts());

  mainWindow.webContents.on("preload-error", (_event, preloadPath, error) => {
    console.error(`[preload] failed to load ${preloadPath}:`, error);
  });
  if (process.env.ATLA_TRACE === "1") {
    mainWindow.webContents.on("console-message", (_e, level, message) => console.log(`[renderer:${level}]`, message));
  }

  // Keep the embedded browser inside the panel; send real "open in new window"
  // requests to the user's actual browser instead of spawning chrome-less popups.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  initBrowserBridge(mainWindow);
  initTerminal(mainWindow);
  initApprovals(mainWindow);

  if (isDev) {
    await mainWindow.loadURL("http://localhost:5173");
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    await mainWindow.loadFile(path.join(__dirname, "../../dist/index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  await migrateFromNova();
  const all = await loadAll();
  providersCache = all.providers;

  // Takes ownership of settings and applies every side effect they imply,
  // so the adblocker and updater are configured before any window exists.
  initSettings(all.state.settings);
  registerSettingsIpc();
  registerWindowIpc(isDev, () => mainWindow);
  adblocker.attach(BROWSER_PARTITION);

  ipcMain.handle("store:load", async () => loadAll());

  ipcMain.handle("store:save-state", async (_e, state: AppState) => {
    // A renderer's settings mirror can be a beat behind; the owned copy wins
    // so a stale window cannot persist its staleness over the real thing.
    const owned = withOwnedSettings(state);
    await saveState(owned);
    // Written alongside, so the next launch can read the GPU decision without
    // touching the (large) state file.
    await saveStartupFlags(owned.settings);
  });

  ipcMain.handle("store:save-providers", async (_e, providers: ProviderConfig[]) => {
    providersCache = providers;
    await saveProviders(providers);
  });

  ipcMain.handle("provider:fetch-models", async (_e, cfg: ProviderConfig): Promise<FetchModelsResponse> => {
    try {
      const models = await fetchModels(cfg);
      return { ok: true, models };
    } catch (err) {
      return { ok: false, error: describeError(err) };
    }
  });

  ipcMain.handle(
    "chat:generate-title",
    async (_e, args: { providerId: string; model: string; transcript: string }): Promise<{ ok: boolean; title?: string; error?: string }> => {
      const cfg = providersCache.find((p) => p.id === args.providerId);
      if (!cfg) return { ok: false, error: "Provider not found." };
      const controller = new AbortController();
      // Naming a chat should never hold anything up.
      const timer = setTimeout(() => controller.abort(), 20000);
      try {
        const title = await generateTitle(cfg, args.model, args.transcript, controller.signal);
        return title ? { ok: true, title } : { ok: false, error: "Empty title." };
      } catch (err) {
        return { ok: false, error: describeError(err) };
      } finally {
        clearTimeout(timer);
      }
    }
  );

  registerTerminalIpc();
  registerFileIpc();
  registerDesktopIpc();
  registerPermissionIpc();
  registerUpdaterIpc();
  registerWebDashIpc();
  registerNotifyIpc();
  initWebDash(mainWindow!);
  initNotify(mainWindow!);
  // Starts enabled; the renderer syncs the user's real setting once the store
  // is hydrated. Main doesn't read settings itself, and a first check is
  // eight seconds out, so there's time for that to land first.
  initUpdater(mainWindow!, true);
  registerApprovalIpc();

  ipcMain.handle("browser:stats", () => adblocker.stats);
  // Drives the fast path: hidden panel means nobody sees the page, so
  // images, fonts and video are never fetched.
  ipcMain.on("browser:visible", (_e, visible: boolean) => adblocker.setPanelVisible(Boolean(visible)));
  ipcMain.handle("browser:partition", () => BROWSER_PARTITION);
  // Rescues a page that lightning rendered blank. Scoped to one host and to
  // this run only -- see AdBlocker.allowScripts.
  ipcMain.handle("browser:allow-scripts", (_e, host: string) => {
    adblocker.allowScripts(String(host ?? ""));
    return true;
  });

  ipcMain.on("chat:start", async (event, req: ChatStreamRequest) => {
    const sender = event.sender;
    const controller = new AbortController();
    activeStreams.set(req.requestId, controller);

    const send = (payload: Record<string, unknown>) => {
      if (!sender.isDestroyed()) sender.send("chat:event", payload);
    };

    const cfg = providersCache.find((p) => p.id === req.providerId);
    if (!cfg) {
      send({ type: "error", requestId: req.requestId, message: "Provider not found." });
      activeStreams.delete(req.requestId);
      return;
    }

    try {
      const fullText = await streamChat(
        cfg,
        req,
        {
          onChunk: (delta) => send({ type: "chunk", requestId: req.requestId, delta }),
          onToolEvent: (evt) => send({ type: "tool", requestId: req.requestId, event: evt })
        },
        controller.signal
      );
      let finalText = fullText;
      let critique: string | undefined;

      // The review runs only on a clean finish. Reviewing an answer the user
      // just cancelled would restart work they stopped, and reviewing a
      // half-streamed one reviews something that was never finished.
      if (req.critic && !controller.signal.aborted && fullText.trim()) {
        const reviewerCfg = providersCache.find((p) => p.id === req.critic!.providerId) ?? cfg;
        const outcome = await reviewAndRevise(
          cfg,
          reviewerCfg,
          req,
          req.critic,
          {
            onReviewing: (round) => send({ type: "reviewing", requestId: req.requestId, round }),
            onRevising: (notes, round) =>
              send({ type: "revising", requestId: req.requestId, critique: notes, round }),
            onChunk: (delta) => send({ type: "chunk", requestId: req.requestId, delta })
          },
          controller.signal,
          fullText
        );
        finalText = outcome.text;
        critique = outcome.critique;
      }

      // An abort between tool iterations returns normally rather than throwing,
      // so the flag has to be read here too or those stops look like clean ends.
      send({
        type: "done",
        requestId: req.requestId,
        fullText: finalText,
        aborted: controller.signal.aborted,
        critique
      });
    } catch (err) {
      if (controller.signal.aborted) {
        // The user hit stop. Whatever streamed already is still on screen and
        // stays in the transcript — the renderer marks it interrupted.
        send({ type: "done", requestId: req.requestId, fullText: "", aborted: true });
      } else {
        const message = describeError(err);
        send({ type: "error", requestId: req.requestId, message });
      }
    } finally {
      activeStreams.delete(req.requestId);
    }
  });

  ipcMain.on("chat:cancel", (_e, requestId: string) => {
    activeStreams.get(requestId)?.abort();
    // An abort can't interrupt an await on a pending approval, so anything
    // still waiting has to be denied or the tool loop hangs forever.
    clearApprovals();
  });

  await createWindow();

  if (process.env.ATLA_SELFTEST === "1") {
    const { runSelfTest } = await import("./selftest.js");
    await runSelfTest();
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
