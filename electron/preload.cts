import { contextBridge, ipcRenderer } from "electron";
import type {
  AdblockStats,
  ApprovalRequest,
  AppSettings,
  PaneMessage,
  AppState,
  ChatStreamEvent,
  ChatStreamRequest,
  FetchModelsResponse,
  GenerateTitleResponse,
  PersistedData,
  ProviderConfig,
  TerminalEvent
} from "../shared/types.js";
import type { SystemInfo } from "../shared/environment.js";
import type { DashStatus, FileReadResult, FileSaveResult, PermissionStatus, UpdateState } from "../shared/types.js";

interface BrowserRpcRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

const api = {
  store: {
    load: (): Promise<PersistedData> => ipcRenderer.invoke("store:load"),
    saveState: (state: AppState): Promise<void> => ipcRenderer.invoke("store:save-state", state),
    saveProviders: (providers: ProviderConfig[]): Promise<void> =>
      ipcRenderer.invoke("store:save-providers", providers)
  },
  chat: {
    start: (req: ChatStreamRequest) => ipcRenderer.send("chat:start", req),
    cancel: (requestId: string) => ipcRenderer.send("chat:cancel", requestId),
    onEvent: (cb: (evt: ChatStreamEvent) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, evt: ChatStreamEvent) => cb(evt);
      ipcRenderer.on("chat:event", listener);
      return () => ipcRenderer.removeListener("chat:event", listener);
    }
  },
  provider: {
    fetchModels: (cfg: ProviderConfig): Promise<FetchModelsResponse> => ipcRenderer.invoke("provider:fetch-models", cfg),
    generateTitle: (args: { providerId: string; model: string; transcript: string }): Promise<GenerateTitleResponse> =>
      ipcRenderer.invoke("chat:generate-title", args)
  },
  browser: {
    partition: (): Promise<string> => ipcRenderer.invoke("browser:partition"),
    allowScripts: (host: string): Promise<boolean> => ipcRenderer.invoke("browser:allow-scripts", host),
    stats: (): Promise<AdblockStats> => ipcRenderer.invoke("browser:stats"),
    /**
     * The main process drives the <webview> through here: it sends a command,
     * the renderer runs it against the live webview and replies by id.
     */
    onRpcRequest: (handler: (req: BrowserRpcRequest) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, req: BrowserRpcRequest) => handler(req);
      ipcRenderer.on("browser:rpc-request", listener);
      return () => ipcRenderer.removeListener("browser:rpc-request", listener);
    },
    respond: (payload: { id: string; ok: boolean; result?: unknown; error?: string }) =>
      ipcRenderer.send("browser:rpc-response", payload),
    /** Tell main the RPC handler is live; commands sent before this are lost. */
    signalReady: () => ipcRenderer.send("browser:renderer-ready"),
    setVisible: (visible: boolean) => ipcRenderer.send("browser:visible", visible)
  },
  files: {
    read: (path: string): Promise<FileReadResult> => ipcRenderer.invoke("files:read", path),
    save: (path: string, content: string): Promise<FileSaveResult> =>
      ipcRenderer.invoke("files:save", { path, content })
  },
  notify: {
    send: (title: string, body: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("notify:send", { title, body })
  },
  dash: {
    status: (): Promise<DashStatus> => ipcRenderer.invoke("dash:status"),
    start: (port: number): Promise<DashStatus & { ok: boolean; error?: string }> =>
      ipcRenderer.invoke("dash:start", port),
    stop: (): Promise<DashStatus> => ipcRenderer.invoke("dash:stop"),
    onRequest: (cb: (payload: { id: string; request: unknown }) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, p: { id: string; request: unknown }) => cb(p);
      ipcRenderer.on("dash:request", listener);
      return () => ipcRenderer.removeListener("dash:request", listener);
    },
    reply: (id: string, payload: unknown) => ipcRenderer.send(`dash:reply:${id}`, payload)
  },
  windows: {
    popOut: (pane: string): Promise<boolean> => ipcRenderer.invoke("windows:pop-out", pane),
    dock: (pane: string): Promise<boolean> => ipcRenderer.invoke("windows:dock", pane),
    popped: (): Promise<string[]> => ipcRenderer.invoke("windows:popped"),
    toMain: (message: unknown): Promise<boolean> => ipcRenderer.invoke("windows:to-main", message),
    onMessage: (cb: (m: PaneMessage) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, m: PaneMessage) => cb(m);
      ipcRenderer.on("windows:message", listener);
      return () => ipcRenderer.removeListener("windows:message", listener);
    },
    onPopped: (cb: (panes: string[]) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, panes: string[]) => cb(panes);
      ipcRenderer.on("windows:popped", listener);
      return () => ipcRenderer.removeListener("windows:popped", listener);
    }
  },
  settings: {
    get: (): Promise<AppSettings | null> => ipcRenderer.invoke("settings:get"),
    patch: (patch: Partial<AppSettings>): Promise<AppSettings | null> =>
      ipcRenderer.invoke("settings:patch", patch),
    onChanged: (cb: (s: AppSettings) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, s: AppSettings) => cb(s);
      ipcRenderer.on("settings:changed", listener);
      return () => ipcRenderer.removeListener("settings:changed", listener);
    }
  },
  update: {
    state: (): Promise<UpdateState> => ipcRenderer.invoke("update:state"),
    check: (): Promise<UpdateState> => ipcRenderer.invoke("update:check"),
    install: (): Promise<{ ok: boolean }> => ipcRenderer.invoke("update:install"),
    setEnabled: (on: boolean): Promise<UpdateState> => ipcRenderer.invoke("update:set-enabled", on),
    setChannel: (channel: string): Promise<UpdateState> => ipcRenderer.invoke("update:set-channel", channel),
    onState: (cb: (s: UpdateState) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, s: UpdateState) => cb(s);
      ipcRenderer.on("update:state", listener);
      return () => ipcRenderer.removeListener("update:state", listener);
    }
  },
  permissions: {
    status: (): Promise<PermissionStatus> => ipcRenderer.invoke("permissions:status"),
    open: (which: string): Promise<{ ok: boolean }> => ipcRenderer.invoke("permissions:open", which)
  },
  desktop: {
    kill: (): Promise<{ ok: true }> => ipcRenderer.invoke("desktop:kill"),
    arm: (): Promise<{ ok: true }> => ipcRenderer.invoke("desktop:arm")
  },
  system: {
    info: (): Promise<SystemInfo> => ipcRenderer.invoke("system:info")
  },
  terminal: {
    cwd: (): Promise<string> => ipcRenderer.invoke("terminal:cwd"),
    run: (command: string): Promise<{ code: number | null }> => ipcRenderer.invoke("terminal:run", command),
    kill: () => ipcRenderer.send("terminal:kill"),
    onEvent: (cb: (evt: TerminalEvent) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, evt: TerminalEvent) => cb(evt);
      ipcRenderer.on("terminal:event", listener);
      return () => ipcRenderer.removeListener("terminal:event", listener);
    }
  },
  approvals: {
    onRequest: (cb: (req: ApprovalRequest) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, req: ApprovalRequest) => cb(req);
      ipcRenderer.on("approval:request", listener);
      return () => ipcRenderer.removeListener("approval:request", listener);
    },
    respond: (payload: { id: string; approved: boolean; remember?: boolean; kind?: ApprovalRequest["kind"] }) =>
      ipcRenderer.send("approval:response", payload)
  }
};

export type AtlaBridge = typeof api;

contextBridge.exposeInMainWorld("atla", api);
