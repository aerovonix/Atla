// Shared between the Electron main process and the renderer (React) code.

import type { DesktopPolicy, DesktopScope } from "./desktopPolicy.js";

export type ProviderKind =
  | "anthropic"
  | "openai"
  | "google"
  | "openrouter"
  | "ollama"
  | "openai-compatible";

export interface ProviderConfig {
  id: string;
  kind: ProviderKind;
  /** User-facing label, e.g. "My OpenRouter key" */
  label: string;
  apiKey?: string;
  /** Override base URL. Required for ollama/openai-compatible, optional override for others. */
  baseUrl?: string;
  /** Default model id to use for this provider. */
  defaultModel?: string;
  /** Model ids, normally auto-detected from the provider's API. */
  models: string[];
  createdAt: number;
}

export interface ChatAttachment {
  name: string;
  type: string;
  size: number;
  /** data: URL for images. */
  dataUrl?: string;
  /** Decoded text content for text-ish files (md, json, csv, source code…). */
  text?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  attachments?: ChatAttachment[];
  /** which provider/model produced this assistant message */
  providerId?: string;
  model?: string;
  error?: boolean;
  /** The user stopped this mid-generation; the text below is a partial answer. */
  interrupted?: boolean;
  /** A reviewer is reading this reply right now. */
  reviewing?: boolean;
  /** What the reviewer asked for, when a revision happened. */
  critique?: string;
  /** The reply as first written, kept so the revision can be compared to it. */
  original?: string;
  liked?: boolean;
  disliked?: boolean;
  /** Tool activity (browser/web search) that ran while producing this message. */
  toolEvents?: ToolEvent[];
}

export interface ToolEvent {
  name: string;
  summary: string;
  ok: boolean;
  /**
   * How many characters of `content` had streamed when this tool ran, so the
   * UI can drop the card back where it happened instead of piling every card
   * above the message.
   */
  at?: number;
  /** Arguments the model passed, pretty-printed for the details view. */
  args?: string;
  /** What the tool handed back, clipped for the details view. */
  detail?: string;
  /** Page the tool landed on, when there was one. Enables "Open in browser". */
  url?: string;
  /** Absolute path a file tool touched. Drives the "edited N files" chips. */
  path?: string;
  /** True when this tool changed the file at `path`, rather than just read it. */
  wrote?: boolean;
  /** Unified diff of a write, so the change can be reopened after the fact. */
  diff?: string;
  /** Base64 PNG a tool produced, e.g. a desktop screenshot. */
  image?: string;
}

/** A message typed while the model was busy, waiting its turn. */
export interface QueuedMessage {
  id: string;
  text: string;
  attachments: ChatAttachment[];
}

export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  updatedAt: number;
  projectId: string | null;
  providerId?: string;
  model?: string;
  /** Set once the model has named this chat, so it isn't renamed every turn. */
  autoTitled?: boolean;
  /** Per-conversation override; falls back to settings.webSearchEnabled. */
  webSearch?: boolean;
  /** Per-conversation override; falls back to settings.browserToolsEnabled. */
  browserTools?: boolean;
  /** Per-conversation override; falls back to settings.terminalToolEnabled. */
  terminalTool?: boolean;
  /** Per-conversation override; falls back to settings.fileToolsEnabled. */
  fileTools?: boolean;
  /**
   * Where this chat was split off from, when it was. The parent keeps no list
   * of its children — deriving that from this field means deleting a parent
   * can't leave a dangling pointer behind, only an orphan that still works.
   */
  branchedFrom?: BranchOrigin;
}

export interface BranchOrigin {
  conversationId: string;
  /** The message the branch was taken at; it and everything before it carried over. */
  messageId: string;
  /** The parent's title when the split happened, so an orphan can still say where it came from. */
  title: string;
  at: number;
}

export interface Project {
  id: string;
  name: string;
  color: string;
}

/**
 * v1: web search and browser control became available by default.
 * v2: the file tools shipped, available by default with writes gated.
 * v3: onboarding arrived; anyone already installed has finished it.
 */
export const SETTINGS_VERSION = 3;

/** "dark" is the mid-grey ground; "midnight" is the true black one. */
export type ThemeSetting = "light" | "dark" | "midnight" | "system";

/** The class the renderer puts on <html>. "system" resolves to one of these. */
export type ResolvedTheme = "light" | "dark" | "midnight";

/**
 * Which palette actually applies. Kept here rather than inline in the
 * component so the self-test can pin it: getting "system" wrong means the
 * app silently ignores the OS setting, which is easy to miss by eye.
 */
export function resolveTheme(theme: ThemeSetting, prefersDark: boolean): ResolvedTheme {
  if (theme === "system") return prefersDark ? "dark" : "light";
  return theme;
}
export type DensitySetting = "comfortable" | "compact";
export type SendKeySetting = "enter" | "mod-enter";

export interface AppSettings {
  /**
   * Bumped when a default changes in a way existing installs should pick up.
   * Saved settings always win over DEFAULT_SETTINGS, so without this marker a
   * changed default only ever reaches brand-new users.
   */
  settingsVersion: number;
  theme: ThemeSetting;
  profileName: string;
  customInstructions: string;

  /** Global default model used for every new conversation. */
  defaultProviderId?: string;
  defaultModel?: string;

  // Generation
  temperature: number;
  maxTokens: number;
  /** Replaces Atla's built-in persona entirely when non-empty. */
  systemPromptOverride: string;

  // Capabilities
  webSearchEnabled: boolean;
  browserToolsEnabled: boolean;
  /** Let the model run shell commands in the terminal pane. */
  terminalToolEnabled: boolean;
  /** Ask before each command the model wants to run. */
  commandApproval: boolean;
  /** Let the model read, write, and edit files on disk. */
  fileToolsEnabled: boolean;
  /** Ask before each write or edit. Reads are never gated. */
  fileWriteApproval: boolean;
  /** First run is done. Set by finishing or skipping onboarding. */
  onboarded: boolean;
  /**
   * Local day (YYYY-MM-DD) the weekday greeting was last shown, so it lands
   * once rather than on every new chat opened before the first message.
   */
  lastWeekdayGreetingOn: string;
  /** Let the model see and control the desktop outside Atla. */
  desktopEnabled: boolean;
  /** "allowlist" limits it to named apps; "unrestricted" is anywhere. */
  desktopScope: DesktopScope;
  /** Window-title substrings the model may act in, one per line in the UI. */
  desktopAllowlist: string[];
  /** Confirm every desktop action, not only the ones that look irreversible. */
  desktopConfirmEvery: boolean;
  /** Notify when a reply finishes while the window isn't focused. */
  notifyOnFinish: boolean;
  /** Check for and download new versions in the background. */
  autoUpdate: boolean;
  /** Have a second model review each answer and let the first revise it. */
  criticEnabled: boolean;
  /** Reviewer provider. Empty means the answering model reviews its own work. */
  criticProviderId: string;
  criticModel: string;
  /** How many review-and-revise rounds at most. */
  criticRounds: number;
  /** Answers shorter than this are sent as-is; reviewing "yes" wastes a call. */
  criticMinChars: number;
  maxToolIterations: number;

  // Interface
  density: DensitySetting;
  fontSize: number;
  sendKey: SendKeySetting;
  autoTitle: boolean;
  showModelInMessages: boolean;

  // Browser
  adblockEnabled: boolean;
  browserHomepage: string;
  searchEngineUrl: string;
  customBlocklist: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  settingsVersion: SETTINGS_VERSION,
  theme: "dark",
  profileName: "You",
  customInstructions: "",

  temperature: 1,
  maxTokens: 4096,
  systemPromptOverride: "",

  // Available by default — these grant the model permission to use a tool, not
  // an instruction to use it every turn. It decides per message.
  webSearchEnabled: true,
  browserToolsEnabled: true,
  terminalToolEnabled: true,
  // Running a shell command is the one tool whose effects can't be taken back,
  // so the gate stays on unless the user deliberately removes it.
  commandApproval: true,
  fileToolsEnabled: true,
  // Overwriting a file is as irreversible as running a command, so it gets the
  // same treatment. Reads stay ungated — nothing on disk changes.
  fileWriteApproval: true,
  // Off by default: every answer costs at least one extra model call, and on a
  // metered provider that is the user's money.
  // Existing installs are migrated to true at v3 — someone already using Atla
  // has by definition finished setting it up.
  onboarded: false,
  lastWeekdayGreetingOn: "",
  // On, but it only ever fires when the window is in the background, so it
  // can't interrupt someone who is already watching the answer arrive.
  notifyOnFinish: true,
  autoUpdate: true,
  // Off by default and empty by default. This is the one capability that can
  // reach outside Atla entirely, so it starts switched off, and switching it
  // on still grants nothing until the user names an app.
  desktopEnabled: false,
  desktopScope: "allowlist",
  desktopAllowlist: [],
  desktopConfirmEvery: false,
  criticEnabled: false,
  criticProviderId: "",
  criticModel: "",
  criticRounds: 1,
  criticMinChars: 280,
  // Research and multi-step desktop work blow through a small budget in
  // seconds, and hitting the ceiling mid-task is worse than the tokens.
  maxToolIterations: 40,

  density: "comfortable",
  fontSize: 15,
  sendKey: "enter",
  autoTitle: true,
  showModelInMessages: true,

  adblockEnabled: true,
  browserHomepage: "https://duckduckgo.com",
  searchEngineUrl: "https://duckduckgo.com/?q=%s",
  customBlocklist: ""
};

export interface AppState {
  conversations: Conversation[];
  projects: Project[];
  settings: AppSettings;
}

export interface PersistedData {
  state: AppState;
  providers: ProviderConfig[];
}

// IPC contracts

export interface ChatStreamRequest {
  requestId: string;
  providerId: string;
  model: string;
  system: string;
  messages: { role: "user" | "assistant"; content: string; imageDataUrls?: string[] }[];
  temperature: number;
  maxTokens: number;
  /** Ask the provider (or the built-in browser) to search the web. */
  webSearch: boolean;
  /** Let the model drive the built-in browser via tool calls. */
  browserTools: boolean;
  /** Let the model run shell commands. */
  terminalTool: boolean;
  /** Ask the user before each command runs. */
  approveCommands: boolean;
  /** Let the model read and change files on disk. */
  fileTools: boolean;
  /** Ask the user before each write or edit lands. */
  approveWrites: boolean;
  /** When set, the answer is reviewed and possibly revised before it settles. */
  critic?: CriticRequest;
  /** Desktop control, off unless the user turned it on for this message. */
  desktop?: DesktopPolicy;
  maxToolIterations: number;
  /** Template with %s, used by the browser-backed web_search tool. */
  searchEngineUrl: string;
  /**
   * Tools the user named with @[tool] for this turn only. These are made
   * available even if their capability toggle is off, and the model is pushed
   * to actually call them before answering.
   */
  forcedTools: string[];
}

export interface CriticRequest {
  providerId: string;
  model: string;
  rounds: number;
  minChars: number;
  /** The prompt being answered, so the reviewer can tell if it was addressed. */
  prompt: string;
}

export type ChatStreamEvent =
  | { type: "chunk"; requestId: string; delta: string }
  | { type: "tool"; requestId: string; event: ToolEvent }
  | { type: "reviewing"; requestId: string; round: number }
  /**
   * The reviewer asked for changes. The renderer moves what has streamed so
   * far into `original` and clears the body for the revision that follows.
   */
  | { type: "revising"; requestId: string; critique: string; round: number }
  | { type: "done"; requestId: string; fullText: string; aborted?: boolean; critique?: string }
  | { type: "error"; requestId: string; message: string };

export interface GenerateTitleResponse {
  ok: boolean;
  title?: string;
  error?: string;
}

export interface FetchModelsResponse {
  ok: boolean;
  models?: string[];
  error?: string;
}

export const PROVIDER_LABELS: Record<ProviderKind, string> = {
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI",
  google: "Google (Gemini)",
  openrouter: "OpenRouter",
  ollama: "Ollama (local)",
  "openai-compatible": "OpenAI-compatible"
};

/**
 * Providers with a first-party, server-side web search tool. Everything else
 * falls back to Atla's built-in browser to search, so web search works on any
 * provider — including local Ollama models.
 */
export const NATIVE_WEB_SEARCH: Record<ProviderKind, boolean> = {
  anthropic: true,
  openai: false,
  google: true,
  openrouter: true,
  ollama: false,
  "openai-compatible": false
};

/** Provider kinds whose API supports the function/tool-calling loop. */
export const SUPPORTS_TOOL_CALLS: Record<ProviderKind, boolean> = {
  anthropic: true,
  openai: true,
  google: true,
  openrouter: true,
  ollama: true,
  "openai-compatible": true
};

// Browser IPC

export interface BrowserPageInfo {
  url: string;
  title: string;
  text: string;
}

export interface AdblockStats {
  blocked: number;
}

// Terminal IPC

/** A permission prompt raised by a tool, awaiting the user's answer. */
export interface ApprovalRequest {
  id: string;
  kind: "command" | "write" | "desktop";
  title: string;
  /** The thing being approved, shown verbatim — e.g. the command line. */
  detail: string;
  /** Extra context line, e.g. the working directory. */
  context?: string;
  /**
   * Unified diff for a write. Approving a file change means approving the
   * change, so the modal shows the lines rather than just the filename.
   */
  diff?: string;
}

export interface TerminalEvent {
  type: "start" | "out" | "err" | "exit" | "cwd";
  /** Chunk of output, for out/err. */
  data?: string;
  /** Exit status, for exit. */
  code?: number | null;
  /** Working directory, for cwd/start. */
  cwd?: string;
  /** Echoed back on start so the UI can label the block. */
  command?: string;
}

/** Result of the canvas reading a file. Errors come back as data, not throws. */
export type FileReadResult =
  | { ok: true; path: string; text: string; truncated: boolean }
  | { ok: false; error: string };

export type FileSaveResult = { ok: true; path: string } | { ok: false; error: string };

/** What the settings panel shows about the web dash. */
export interface DashStatus {
  running: boolean;
  port: number;
  /** Empty while stopped. Regenerated on every start. */
  code: string;
  addresses: string[];
  sessions: number;
}

/** What the OS currently permits. Non-macOS reports everything granted. */
export interface PermissionStatus {
  platform: string;
  screen: boolean;
  accessibility: boolean;
}

/** Where the updater has got to. Installing is always the user's call. */
export interface UpdateState {
  status: "idle" | "checking" | "downloading" | "ready";
  currentVersion: string;
  availableVersion?: string;
  /** Download progress, 0-100. */
  percent?: number;
  /** False on a dev run, or a macOS build that can't update itself. */
  supported: boolean;
  /** Why it can't update, or what went wrong. */
  message?: string;
}
