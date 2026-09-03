import type {
  AdblockStats,
  ApprovalRequest,
  AppState,
  ChatStreamEvent,
  ChatStreamRequest,
  FetchModelsResponse,
  GenerateTitleResponse,
  PersistedData,
  ProviderConfig,
  TerminalEvent,
  FileReadResult,
  FileSaveResult,
  DashStatus,
  PermissionStatus,
  UpdateState, PaneKind, PaneMessage } from "../shared/types";
import type { DashRequest } from "../shared/dashProtocol";
import type { SystemInfo } from "../shared/environment";

export interface BrowserRpcRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export interface AtlaBridge {
  store: {
    load: () => Promise<PersistedData>;
    saveState: (state: AppState) => Promise<void>;
    saveProviders: (providers: ProviderConfig[]) => Promise<void>;
  };
  chat: {
    start: (req: ChatStreamRequest) => void;
    cancel: (requestId: string) => void;
    onEvent: (cb: (evt: ChatStreamEvent) => void) => () => void;
  };
  provider: {
    fetchModels: (cfg: ProviderConfig) => Promise<FetchModelsResponse>;
    generateTitle: (args: { providerId: string; model: string; transcript: string }) => Promise<GenerateTitleResponse>;
  };
  browser: {
    partition: () => Promise<string>;
    allowScripts: (host: string) => Promise<boolean>;
    scriptsBlocked: (host: string) => Promise<number>;
    stats: () => Promise<AdblockStats>;
    onRpcRequest: (handler: (req: BrowserRpcRequest) => void) => () => void;
    respond: (payload: { id: string; ok: boolean; result?: unknown; error?: string }) => void;
    signalReady: () => void;
    setVisible: (visible: boolean) => void;
  };
  terminal: {
    cwd: () => Promise<string>;
    run: (command: string) => Promise<{ code: number | null }>;
    kill: () => void;
    onEvent: (cb: (evt: TerminalEvent) => void) => () => void;
  };
  files: {
    read: (path: string) => Promise<FileReadResult>;
    save: (path: string, content: string) => Promise<FileSaveResult>;
  };
  notify: {
    send: (title: string, body: string) => Promise<{ ok: boolean }>;
  };
  dash: {
    status: () => Promise<DashStatus>;
    start: (port: number) => Promise<DashStatus & { ok: boolean; error?: string }>;
    stop: () => Promise<DashStatus>;
    onRequest: (cb: (payload: { id: string; request: DashRequest }) => void) => () => void;
    reply: (id: string, payload: unknown) => void;
  };
  windows: {
    popOut: (pane: PaneKind) => Promise<boolean>;
    dock: (pane: PaneKind) => Promise<boolean>;
    popped: () => Promise<PaneKind[]>;
    toMain: (message: PaneMessage) => Promise<boolean>;
    onMessage: (cb: (m: PaneMessage) => void) => () => void;
    onPopped: (cb: (panes: PaneKind[]) => void) => () => void;
  };
  settings: {
    get: () => Promise<AppSettings | null>;
    patch: (patch: Partial<AppSettings>) => Promise<AppSettings | null>;
    onChanged: (cb: (s: AppSettings) => void) => () => void;
  };
  update: {
    state: () => Promise<UpdateState>;
    check: () => Promise<UpdateState>;
    install: () => Promise<{ ok: boolean }>;
    setEnabled: (on: boolean) => Promise<UpdateState>;
    setChannel: (channel: string) => Promise<UpdateState>;
    onState: (cb: (s: UpdateState) => void) => () => void;
  };
  permissions: {
    status: () => Promise<PermissionStatus>;
    open: (which: string) => Promise<{ ok: boolean }>;
  };
  desktop: {
    kill: () => Promise<{ ok: true }>;
    arm: () => Promise<{ ok: true }>;
  };
  system: {
    info: () => Promise<SystemInfo>;
  };
  approvals: {
    onRequest: (cb: (req: ApprovalRequest) => void) => () => void;
    respond: (payload: { id: string; approved: boolean; remember?: boolean; kind?: ApprovalRequest["kind"] }) => void;
  };
}

declare global {
  interface Window {
    atla: AtlaBridge;
  }

  namespace JSX {
    interface IntrinsicElements {
      /** Electron's <webview> tag — not a standard DOM element. */
      webview: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string;
        partition?: string;
        webpreferences?: string;
        allowpopups?: string;
        useragent?: string;
      };
    }
  }
}
